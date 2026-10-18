import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deferred } from "../testing/deferred.ts";
import { pcmOf } from "../testing/fake-capture.ts";
import { FakeClock } from "../testing/fake-clock.ts";
import type { VoiceEvent } from "../types.ts";
import { DEFAULT_IDLE_UNLOAD_MS, DEFAULT_LOAD_SHED_RATIO, defaultSystemLoad, ParakeetBackend } from "./parakeet.ts";

const modelFile = join(tmpdir(), `better-pi-voice-test-${String(process.pid)}.gguf`);
writeFileSync(modelFile, "not a real model");
afterAll(() => rmSync(modelFile, { force: true }));

/** A stand-in for a loaded GGUF, so residency is testable without one. */
function fakeModel() {
	let disposed = false;
	const text = { full: "", committed: "", tentative: "" };
	const model = {
		capabilities: { supportsStreaming: true, languages: ["en"], nativeSampleRate: 16_000 },
		createSession: () => ({
			stream: async () => ({
				feed: async () => ({ committedChanged: false, tentativeChanged: false }),
				finalize: async () => undefined,
				reset: () => {},
				get text() {
					return text;
				},
				get snapshot() {
					return { text: "" };
				},
			}),
			dispose: () => {},
		}),
		transcribe: async () => ({ text: "" }),
		dispose: () => {
			disposed = true;
		},
	};
	return { model, wasDisposed: () => disposed };
}

function makeBackend(options: { load?: number; idleUnloadMs?: number; loadCheckMs?: number } = {}) {
	const clock = new FakeClock();
	const fake = fakeModel();
	let loads = 0;
	let load = options.load ?? 0;
	const backend = new ParakeetBackend({
		modelPath: modelFile,
		vadModelPath: null,
		clock,
		idleUnloadMs: options.idleUnloadMs ?? DEFAULT_IDLE_UNLOAD_MS,
		loadCheckMs: options.loadCheckMs ?? 60_000,
		loadShedRatio: DEFAULT_LOAD_SHED_RATIO,
		systemLoad: () => load,
		loadModel: async () => {
			loads++;
			return fake.model as never;
		},
	});
	return { backend, clock, fake, loads: () => loads, setLoad: (value: number) => (load = value) };
}

/** One complete recording: start, then release. */
async function record(backend: ParakeetBackend): Promise<void> {
	const stream = await backend.start({ language: "en", keyterms: [], signal: new AbortController().signal }, () => {});
	if (!stream) throw new Error("backend did not start");
	stream.close();
}

describe("model residency", () => {
	test("keeps the model loaded after a recording, then releases it", async () => {
		const { backend, clock, fake } = makeBackend({ idleUnloadMs: 15 * 60_000 });

		await record(backend);
		expect(backend.modelLoaded).toBe(true);
		expect(fake.wasDisposed()).toBe(false);

		// Still resident just before the window closes.
		clock.advance(14 * 60_000);
		expect(backend.modelLoaded).toBe(true);

		clock.advance(60_000);
		expect(backend.modelLoaded).toBe(false);
		expect(fake.wasDisposed()).toBe(true);
	});

	test("reuses the model across recordings instead of reloading it", async () => {
		// The residency path. The shipped default is 0; see below.
		const { backend, loads } = makeBackend({ idleUnloadMs: 15 * 60_000 });

		await record(backend);
		await record(backend);
		await record(backend);

		expect(loads()).toBe(1);
	});

	test("releases the model one idle minute after the queue empties", async () => {
		const { backend, clock, fake } = makeBackend(); // now defaults to 60_000
		await record(backend);
		clock.advance(59_000);
		expect(backend.modelLoaded).toBe(true);
		clock.advance(1_000);
		expect(backend.modelLoaded).toBe(false);
		expect(fake.wasDisposed()).toBe(true);
	});

	test("the built-in default holds the model for a minute", () => {
		expect(DEFAULT_IDLE_UNLOAD_MS).toBe(60_000);
	});

	test("a new recording cancels a pending unload", async () => {
		const { backend, clock, fake } = makeBackend({ idleUnloadMs: 60_000 });

		await record(backend);
		clock.advance(50_000);
		await record(backend);
		// The first window would have expired here; the second must not.
		clock.advance(20_000);

		expect(backend.modelLoaded).toBe(true);
		expect(fake.wasDisposed()).toBe(false);
	});

	test("hands the memory back early when the machine gets busy", async () => {
		const { backend, clock, setLoad, fake } = makeBackend({
			idleUnloadMs: 15 * 60_000,
			loadCheckMs: 60_000,
		});
		await record(backend);
		expect(backend.modelLoaded).toBe(true);

		// Quiet at the first check, so it stays.
		clock.advance(60_000);
		expect(backend.modelLoaded).toBe(true);

		setLoad(DEFAULT_LOAD_SHED_RATIO + 1);
		clock.advance(60_000);
		expect(backend.modelLoaded).toBe(false);
		expect(fake.wasDisposed()).toBe(true);
	});

	test("an idle-unload window of zero releases the model immediately", async () => {
		const { backend, fake } = makeBackend({ idleUnloadMs: 0 });

		await record(backend);

		expect(backend.modelLoaded).toBe(false);
		expect(fake.wasDisposed()).toBe(true);
	});

	test("dispose releases the model and any pending timers", async () => {
		const { backend, clock, fake } = makeBackend();
		await record(backend);

		await backend.dispose();
		expect(backend.modelLoaded).toBe(false);
		expect(fake.wasDisposed()).toBe(true);

		// Nothing left armed that could fire against a disposed backend.
		expect(clock.pending).toBe(0);
	});

	test("does not unload a model that was never loaded", async () => {
		const { backend, clock } = makeBackend();
		clock.advance(60 * 60_000);
		expect(backend.modelLoaded).toBe(false);
	});
});

describe("batch mode", () => {
	/** s16le at 16 kHz: 3200 bytes is 100 ms. */
	const HUNDRED_MS = 3200;

	/** A model that records what it was asked to transcribe. */
	function recordingModel(texts: string[] = []) {
		const calls: number[] = [];
		let index = 0;
		let failure: Error | undefined;
		const model = {
			capabilities: { supportsStreaming: false, languages: ["en"], nativeSampleRate: 16_000 },
			createSession: () => {
				throw new Error("batch mode must not open a streaming session");
			},
			transcribe: async (pcm: Float32Array) => {
				if (failure) throw failure;
				calls.push(pcm.length * 2);
				return { text: texts[index++] ?? `piece${String(index)}` };
			},
			dispose: () => {},
		};
		return { model, calls, failWith: (error: Error) => (failure = error) };
	}

	function makeBatchBackend(
		options: { chunkSeconds: number; texts?: string[]; silenceLevel?: number | "auto" } = { chunkSeconds: 15 },
	) {
		const recorder = recordingModel(options.texts);
		const events: VoiceEvent[] = [];
		const backend = new ParakeetBackend({
			modelPath: modelFile,
			vadModelPath: null,
			mode: "batch",
			chunkSeconds: options.chunkSeconds,
			silenceLevel: options.silenceLevel,
			loadModel: async () => recorder.model as never,
			idleUnloadMs: 0,
		});
		return { backend, recorder, events, emit: (event: VoiceEvent) => events.push(event) };
	}

	async function startStream(h: ReturnType<typeof makeBatchBackend>) {
		const stream = await h.backend.start(
			{ language: "en", keyterms: [], signal: new AbortController().signal },
			h.emit,
		);
		if (!stream) throw new Error("batch backend did not start");
		return stream;
	}

	const loud = pcmOf(500, HUNDRED_MS);
	const silent = pcmOf(0, HUNDRED_MS);

	/** One second that contains a real pause in its last third, so a cut is legal. */
	function feedSecondWithPause(stream: { feed(chunk: Buffer): unknown }): void {
		for (let i = 0; i < 7; i++) stream.feed(loud);
		for (let i = 0; i < 3; i++) stream.feed(silent);
	}

	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	test("transcribes short audio in one call, at finalize", async () => {
		const h = makeBatchBackend({ chunkSeconds: 15 });
		const stream = await startStream(h);

		for (let i = 0; i < 20; i++) stream.feed(loud); // 2 s, well under the window
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(h.recorder.calls).toEqual([]);

		expect(await stream.finalize()).toBe("complete");
		expect(h.recorder.calls).toEqual([20 * HUNDRED_MS]);
	});

	test("chunks long audio while still recording, so only the tail is left", async () => {
		const h = makeBatchBackend({ chunkSeconds: 1, texts: ["first", "second", "third"] });
		const stream = await startStream(h);

		feedSecondWithPause(stream);
		await settle();

		// Text arrived before finalize: that is the entire point of chunking.
		expect(h.recorder.calls.length).toBe(1);
		expect(h.events.filter((event) => event.type === "final").length).toBe(1);

		feedSecondWithPause(stream);
		await settle();
		expect(h.recorder.calls.length).toBe(2);

		await stream.finalize();
		expect(h.recorder.calls.length).toBe(3);
	});

	test("cuts at a quiet moment rather than at a fixed offset", async () => {
		// A 1 s window is 32 000 bytes. Loud for 0.7 s, silent for 0.3 s, then loud.
		// A fixed cut at 1.0 s would take 32 000 bytes; the quiet seam at 0.8 s is
		// the better place and is what should be chosen.
		const h = makeBatchBackend({ chunkSeconds: 1 });
		const stream = await startStream(h);

		for (let i = 0; i < 7; i++) stream.feed(loud);
		for (let i = 0; i < 3; i++) stream.feed(silent);
		for (let i = 0; i < 5; i++) stream.feed(loud);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(h.recorder.calls[0]).toBe(8 * HUNDRED_MS);
	});

	test("never cuts inside speech, however quiet the moment looks", async () => {
		// Previously this cut at the quietest boundary, which loses speech: canary
		// returns nothing for a clip that starts mid-utterance. Silence is required.
		const h = makeBatchBackend({ chunkSeconds: 1 });
		const stream = await startStream(h);

		for (let i = 0; i < 6; i++) stream.feed(silent);
		for (let i = 0; i < 10; i++) stream.feed(loud);
		await settle();
		expect(h.recorder.calls).toEqual([]);

		await stream.finalize();
		expect(h.recorder.calls).toEqual([16 * HUNDRED_MS]);
	});

	test("chunkSeconds of 0 transcribes everything once, at the end", async () => {
		const h = makeBatchBackend({ chunkSeconds: 0 });
		const stream = await startStream(h);

		for (let i = 0; i < 50; i++) stream.feed(loud);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(h.recorder.calls).toEqual([]);

		await stream.finalize();
		expect(h.recorder.calls).toEqual([50 * HUNDRED_MS]);
	});

	test("keeps chunk text in order, and emits each piece exactly once", async () => {
		const all = ["one", "two", "three", "four", "five", "six", "seven", "eight"];
		const h = makeBatchBackend({ chunkSeconds: 1, texts: all });
		const stream = await startStream(h);

		for (let i = 0; i < 4; i++) feedSecondWithPause(stream);
		await stream.finalize();

		const texts = h.events.filter((event) => event.type === "final").map((event) => event.text);
		// One emission per transcription, in the order the model produced them.
		expect(texts.length).toBe(h.recorder.calls.length);
		expect(texts).toEqual(all.slice(0, texts.length));
		expect(texts.length).toBeGreaterThan(0);
	});

	test("transcribes unbroken speech in one piece rather than cutting into it", async () => {
		const h = makeBatchBackend({ chunkSeconds: 1 });
		const stream = await startStream(h);

		// No pause anywhere, so there is no safe seam and nothing is cut.
		for (let i = 0; i < 40; i++) stream.feed(loud);
		await settle();
		expect(h.recorder.calls).toEqual([]);

		await stream.finalize();
		expect(h.recorder.calls).toEqual([40 * HUNDRED_MS]);
	});

	test("reports one error and finishes early when transcription fails", async () => {
		const h = makeBatchBackend({ chunkSeconds: 1 });
		h.recorder.failWith(new Error("out of memory"));
		const stream = await startStream(h);

		for (let i = 0; i < 4; i++) feedSecondWithPause(stream);
		expect(await stream.finalize()).toBe("closed_early");

		const errors = h.events.filter((event) => event.type === "error");
		expect(errors.length).toBe(1);
		expect(errors[0]?.message).toContain("out of memory");
	});

	test("derives the pause threshold from the recording's own noise floor", async () => {
		// A noisy room: room tone sits at level 0.30, speech at 1.00, so the
		// adaptive threshold lands near 0.51 and a 0.30 boundary counts as a pause.
		// A fixed threshold would have found nothing here.
		const noise = pcmOf(180, HUNDRED_MS); // level ~0.30
		const h = makeBatchBackend({ chunkSeconds: 1, silenceLevel: "auto" });
		const stream = await startStream(h);

		for (let i = 0; i < 7; i++) stream.feed(loud);
		for (let i = 0; i < 3; i++) stream.feed(noise);
		for (let i = 0; i < 5; i++) stream.feed(loud);
		await settle();

		expect(h.recorder.calls.length).toBe(1);
		expect(h.recorder.calls[0]).toBe(8 * HUNDRED_MS);
	});

	test("will not cut when the level never varies, however loud it is", async () => {
		// Steady music or a fan: there is no pause structure to find, so nothing is
		// cut even though the level is well above zero.
		const steady = pcmOf(180, HUNDRED_MS);
		const h = makeBatchBackend({ chunkSeconds: 1, silenceLevel: "auto" });
		const stream = await startStream(h);

		for (let i = 0; i < 40; i++) stream.feed(steady);
		await settle();
		expect(h.recorder.calls).toEqual([]);

		await stream.finalize();
		expect(h.recorder.calls).toEqual([40 * HUNDRED_MS]);
	});

	test("a pinned threshold overrides the automatic one", async () => {
		const noise = pcmOf(180, HUNDRED_MS); // level ~0.30
		const strict = makeBatchBackend({ chunkSeconds: 1, silenceLevel: 0.05 });
		const strictStream = await startStream(strict);
		for (let i = 0; i < 7; i++) strictStream.feed(loud);
		for (let i = 0; i < 3; i++) strictStream.feed(noise);
		for (let i = 0; i < 5; i++) strictStream.feed(loud);
		await settle();
		// 0.30 is not below a pinned 0.05, so nothing is cut.
		expect(strict.recorder.calls).toEqual([]);

		const loose = makeBatchBackend({ chunkSeconds: 1, silenceLevel: 0.6 });
		const looseStream = await startStream(loose);
		for (let i = 0; i < 7; i++) looseStream.feed(loud);
		for (let i = 0; i < 3; i++) looseStream.feed(noise);
		for (let i = 0; i < 5; i++) looseStream.feed(loud);
		await settle();
		// The window now slides, so the two remaining pause chunks are cut too.
		expect(loose.recorder.calls.length).toBeGreaterThanOrEqual(1);
	});

	test("still cuts when the first pause comes after the target length", async () => {
		// The bug that showed up in live use: the search was anchored to the start
		// of the buffer and capped at the target, so a pause landing after the target
		// meant nothing was ever cut and the whole utterance arrived at the end.
		const h = makeBatchBackend({ chunkSeconds: 1, silenceLevel: "auto" });
		const stream = await startStream(h);

		for (let i = 0; i < 15; i++) stream.feed(loud); // 1.5s, past the 1.0s target
		for (let i = 0; i < 3; i++) stream.feed(silent); // the only pause, at 1.5s
		await settle();

		expect(h.recorder.calls.length).toBe(1);
		expect(h.recorder.calls[0]).toBe(16 * HUNDRED_MS); // cut after the pause
	});

	test("chunk length is a target, not a limit", async () => {
		const h = makeBatchBackend({ chunkSeconds: 1, silenceLevel: "auto" });
		const stream = await startStream(h);

		// 4s of unbroken speech followed by a pause: the chunk grows to the pause.
		for (let i = 0; i < 40; i++) stream.feed(loud);
		for (let i = 0; i < 2; i++) stream.feed(silent);
		await settle();

		// Cut after the first pause chunk, so the chunk is 4.1s rather than 4.0s.
		expect(h.recorder.calls[0]).toBe(41 * HUNDRED_MS);
	});

	test("cut() transcribes the buffered tail immediately", async () => {
		const h = makeBatchBackend({ chunkSeconds: 15 });
		const stream = await startStream(h);

		// One second buffered, well under the 15 s target: only a cut flushes it.
		for (let i = 0; i < 10; i++) stream.feed(loud);
		stream.cut?.();
		await settle();

		expect(h.recorder.calls).toEqual([10 * HUNDRED_MS]);
	});

	test("falls back to the level detector when no VAD model is available", async () => {
		// `vadModelPath: null` (set by makeBatchBackend) means no Silero model, so
		// the RMS heuristic must still find a pause and cut.
		const h = makeBatchBackend({ chunkSeconds: 1, silenceLevel: "auto" });
		const stream = await startStream(h);

		feedSecondWithPause(stream);
		await settle();

		expect(h.recorder.calls.length).toBe(1);
	});

	test("close releases the model, so residency can start its timer", async () => {
		const clock = new FakeClock();
		const recorder = recordingModel();
		const backend = new ParakeetBackend({
			modelPath: modelFile,
			vadModelPath: null,
			mode: "batch",
			clock,
			idleUnloadMs: 60_000,
			loadModel: async () => recorder.model as never,
		});
		const stream = await backend.start(
			{ language: "en", keyterms: [], signal: new AbortController().signal },
			() => {},
		);
		stream?.close();
		// The release is deferred until the batch queue settles.
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(backend.modelLoaded).toBe(true);
		clock.advance(60_000);
		expect(backend.modelLoaded).toBe(false);
	});
});

describe("startup failures", () => {
	const startOptions = { language: "en", keyterms: [], signal: new AbortController().signal };

	function backendWith(
		model: unknown,
		overrides: { idleUnloadMs?: number; clock?: FakeClock; mode?: "batch" | "streaming"; chunkSeconds?: number } = {},
	): { backend: ParakeetBackend; clock: FakeClock } {
		const clock = overrides.clock ?? new FakeClock();
		const backend = new ParakeetBackend({
			modelPath: modelFile,
			vadModelPath: null,
			clock,
			mode: overrides.mode,
			chunkSeconds: overrides.chunkSeconds,
			idleUnloadMs: overrides.idleUnloadMs ?? 0,
			loadModel: async () => model as never,
		});
		return { backend, clock };
	}

	test("disposes the session and releases the model when the stream fails to start", async () => {
		let sessionDisposed = false;
		let modelDisposed = false;
		const { backend } = backendWith(
			{
				capabilities: { supportsStreaming: true, languages: ["en"], nativeSampleRate: 16_000 },
				createSession: () => ({
					stream: async () => {
						throw new Error("no stream");
					},
					dispose: () => {
						sessionDisposed = true;
					},
				}),
				transcribe: async () => ({ text: "" }),
				dispose: () => {
					modelDisposed = true;
				},
			},
			{ mode: "streaming" },
		);
		const events: VoiceEvent[] = [];

		const stream = await backend.start(startOptions, (event) => events.push(event));

		expect(stream).toBeUndefined();
		expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "stream_start_failed" }));
		expect(sessionDisposed).toBe(true);
		expect(modelDisposed).toBe(true);
	});

	test("releases the model when the chosen model cannot stream", async () => {
		let modelDisposed = false;
		const { backend } = backendWith(
			{
				capabilities: { supportsStreaming: false, languages: ["en"], nativeSampleRate: 16_000 },
				createSession: () => {
					throw new Error("batch models have no session");
				},
				transcribe: async () => ({ text: "" }),
				dispose: () => {
					modelDisposed = true;
				},
			},
			{ mode: "streaming" },
		);

		const stream = await backend.start(startOptions, () => {});

		expect(stream).toBeUndefined();
		expect(modelDisposed).toBe(true);
	});

	test("releases the model only after an in-flight transcribe settles", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const clock = new FakeClock();
		const { backend } = backendWith(
			{
				capabilities: { supportsStreaming: false, languages: ["en"], nativeSampleRate: 16_000 },
				createSession: () => {
					throw new Error("batch models have no session");
				},
				transcribe: async () => {
					await gate;
					return { text: "done" };
				},
				dispose: () => {},
			},
			{ mode: "batch", chunkSeconds: 1, idleUnloadMs: 15 * 60_000, clock },
		);
		const stream = await backend.start(startOptions, () => {});
		if (!stream) throw new Error("batch backend did not start");

		// A pause one second in triggers a cut, so a transcribe is now in flight.
		for (let i = 0; i < 7; i++) stream.feed(pcmOf(500, 3200));
		for (let i = 0; i < 3; i++) stream.feed(pcmOf(0, 3200));
		stream.close();

		// Nothing may be scheduled for release while transcribe is still blocked.
		expect(clock.pending).toBe(0);
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(clock.pending).toBeGreaterThan(0);
	});
});

describe("defaultSystemLoad", () => {
	test("is a finite, non-negative number", () => {
		const load = defaultSystemLoad();
		expect(Number.isFinite(load)).toBe(true);
		expect(load).toBeGreaterThanOrEqual(0);
	});
});

describe("session refcounting", () => {
	type ModelHooks = {
		transcribe?: (pcm: Float32Array) => Promise<{ text: string }>;
		onDispose?: () => void;
	};

	function trackingModel(hooks: ModelHooks = {}) {
		let disposedCount = 0;
		const model = {
			capabilities: { supportsStreaming: true, languages: ["en"], nativeSampleRate: 16_000 },
			createSession: () => ({
				stream: async () => ({
					feed: async () => ({ committedChanged: false, tentativeChanged: false }),
					finalize: async () => undefined,
					reset: () => {},
					get text() {
						return { full: "", committed: "", tentative: "" };
					},
					get snapshot() {
						return { text: "" };
					},
				}),
				dispose: () => {},
			}),
			transcribe: hooks.transcribe ?? (async () => ({ text: "" })),
			dispose: () => {
				disposedCount++;
				hooks.onDispose?.();
			},
		};
		return { model, disposed: () => disposedCount };
	}

	function makeRefBackend(hooks: ModelHooks = {}, options: { idleUnloadMs?: number } = {}) {
		const clock = new FakeClock();
		const tracked = trackingModel(hooks);
		const backend = new ParakeetBackend({
			modelPath: modelFile,
			vadModelPath: null,
			mode: "batch",
			chunkSeconds: 1,
			silenceLevel: "auto",
			idleUnloadMs: options.idleUnloadMs ?? 0,
			clock,
			loadModel: async () => tracked.model as never,
		});
		return { backend, clock, ...tracked };
	}

	const opts = () => ({ language: "en", keyterms: [], signal: new AbortController().signal });
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	const loud = pcmOf(500, 3200);
	const silent = pcmOf(0, 3200);
	function feedPause(stream: { feed(chunk: Buffer): unknown }): void {
		for (let i = 0; i < 7; i++) stream.feed(loud);
		for (let i = 0; i < 3; i++) stream.feed(silent);
	}

	test("does not unload while another session is still transcribing", async () => {
		const { backend, disposed } = makeRefBackend({}, { idleUnloadMs: 0 });
		const first = await backend.start(opts(), () => {});
		const second = await backend.start(opts(), () => {});
		expect(first).toBeDefined();
		expect(second).toBeDefined();

		first!.close();
		// One session is still open: the model must stay resident even at idleUnloadMs 0.
		expect(backend.modelLoaded).toBe(true);
		expect(disposed()).toBe(0);

		second!.close();
		expect(backend.modelLoaded).toBe(false);
		expect(disposed()).toBe(1);
	});

	test("dispose during an in-flight transcribe does not free the model", async () => {
		const gate = deferred<void>();
		const { backend, disposed } = makeRefBackend(
			{
				transcribe: async () => {
					await gate.promise;
					return { text: "done" };
				},
			},
			{ idleUnloadMs: 60_000 },
		);
		const stream = await backend.start(opts(), () => {});
		if (!stream) throw new Error("batch backend did not start");

		feedPause(stream);
		await settle();
		expect(backend.modelLoaded).toBe(true);

		await backend.dispose();
		// The transcription is still running, so the model must not be freed yet.
		expect(backend.modelLoaded).toBe(true);
		expect(disposed()).toBe(0);

		stream.close();
		gate.resolve();
		await settle();
		await settle();

		expect(backend.modelLoaded).toBe(false);
		expect(disposed()).toBe(1);
	});

	test("a dispose that races a starting session does not free the model", async () => {
		const { backend, disposed } = makeRefBackend({}, { idleUnloadMs: 60_000 });
		// Load the model first, so there is something a premature unload could free.
		const recording = await backend.start(opts(), () => {});
		if (!recording) throw new Error("batch backend did not start");
		recording.close();
		expect(backend.modelLoaded).toBe(true);

		// `start()` is suspended on its first await while shutdown runs, so the
		// model must be pinned for the whole start window, not just once a stream
		// exists.
		const starting = backend.start(opts(), () => {});
		await backend.dispose();
		await settle();

		expect(backend.modelLoaded).toBe(true);
		expect(disposed()).toBe(0);

		const stream = await starting;
		if (!stream) throw new Error("batch backend did not start");
		stream.close();
		await settle();
		await settle();

		// Once that start is done, the shutdown it raced is still honoured.
		expect(backend.modelLoaded).toBe(false);
		expect(disposed()).toBe(1);
	});

	test("serializes transcribe calls across concurrent batch streams", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const { backend } = makeRefBackend(
			{
				transcribe: async () => {
					inFlight++;
					maxInFlight = Math.max(maxInFlight, inFlight);
					await new Promise((resolve) => setTimeout(resolve, 0));
					inFlight--;
					return { text: "" };
				},
			},
			{ idleUnloadMs: 60_000 },
		);
		const first = await backend.start(opts(), () => {});
		const second = await backend.start(opts(), () => {});
		if (!first || !second) throw new Error("batch backend did not start");

		feedPause(first);
		feedPause(second);
		await settle();
		await settle();

		expect(maxInFlight).toBe(1);
	});
});
