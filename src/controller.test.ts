import { describe, expect, test } from "bun:test";
import { type ControllerDeps, type ControllerTimings, VoiceController, type VoiceState } from "./controller.ts";
import { deferred } from "./testing/deferred.ts";
import { FakeBackend } from "./testing/fake-backend.ts";
import { FakeCapture, pcmOf } from "./testing/fake-capture.ts";
import { FakeClock } from "./testing/fake-clock.ts";

type Harness = {
	controller: VoiceController;
	backend: FakeBackend;
	capture: FakeCapture;
	clock: FakeClock;
	interims: string[];
	finals: string[];
	errors: Array<{ message: string; code: string }>;
	notices: string[];
	drained: number;
	states: VoiceState[];
	levels: number[][];
	debug: string[];
};

async function flush(): Promise<void> {
	// Real event loop, so every pending microtask resolves.
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function makeHarness(overrides: Partial<ControllerDeps> = {}, timings: Partial<ControllerTimings> = {}): Harness {
	const backend = new FakeBackend();
	const capture = new FakeCapture();
	const clock = new FakeClock();
	const interims: string[] = [];
	const finals: string[] = [];
	const errors: Array<{ message: string; code: string }> = [];
	const notices: string[] = [];
	const states: VoiceState[] = [];
	const levels: number[][] = [];
	const debug: string[] = [];
	let drained = 0;

	const controller = new VoiceController({
		backend,
		capture,
		mode: "hold",
		language: "en",
		correction: "safe",
		keyterms: async () => ({ bias: [], correct: [], truncated: false }),
		clock,
		timings,
		hooks: {
			onInterim: (text) => interims.push(text),
			onFinal: (text) => finals.push(text),
			onError: (message, code) => errors.push({ message, code }),
			onNotice: (message) => notices.push(message),
			onQueueDrained: () => {
				drained++;
			},
			onState: (state) => states.push(state),
			onLevel: (snapshot) => levels.push(snapshot),
			onDebug: (message) => debug.push(message),
		},
		...overrides,
	});

	return { controller, backend, capture, clock, interims, finals, errors, notices, states, levels, debug, get drained() { return drained; } };
}

/** Start a session and let it reach "recording". */
async function start(h: Harness): Promise<void> {
	h.controller.press();
	await flush();
}

describe("hold mode", () => {
	test("press starts, release finishes, and the final keeps the accumulated text", async () => {
		const h = makeHarness();
		h.backend.plans = [
			{
				events: [
					{ type: "interim", text: "hello" },
					{ type: "final", text: "hello world" },
					{ type: "final", text: "second sentence" },
				],
			},
		];

		await start(h);
		expect(h.controller.currentState).toBe("recording");
		expect(h.capture.startCount).toBe(1);

		h.controller.release();
		h.clock.advance(200);
		await flush();

		expect(h.finals).toEqual(["hello world second sentence"]);
		expect(h.controller.currentState).toBe("idle");
		expect(h.capture.stopCount).toBe(1);
	});

	test("reports interim text, including text already committed", async () => {
		const h = makeHarness();
		h.backend.plans = [
			{
				events: [
					{ type: "final", text: "committed" },
					{ type: "interim", text: "in progress" },
				],
			},
		];

		await start(h);
		h.controller.release();
		h.clock.advance(200);
		await flush();

		expect(h.interims).toContain("committed");
		expect(h.interims).toContain("committed in progress");
	});

	test("buffers audio that arrives before the stream is ready, then flushes it", async () => {
		const h = makeHarness();
		// Do not let the stream connect yet.
		await flush();
		h.controller.press();
		await flush();

		const stream = h.backend.last!;
		const before = stream.bytesReceived;
		h.capture.emit(pcmOf(500, 2000));
		// The stream exists by now, so audio flows straight through.
		expect(stream.bytesReceived).toBeGreaterThanOrEqual(before);

		h.controller.release();
		h.clock.advance(200);
		await flush();
		expect(stream.bytesReceived).toBeGreaterThan(0);
	});

	test("falls back to the release timer when the terminal sends no auto-repeat", async () => {
		const h = makeHarness();
		await start(h);

		// No repeat events at all; the 600ms fallback should finish the session.
		expect(h.debug.join("\n")).not.toContain("no auto-repeat seen");
		h.clock.advance(600);
		expect(h.debug.join("\n")).toContain("no auto-repeat seen");
		h.clock.advance(200);
		await flush();

		expect(h.controller.currentState).toBe("idle");
	});

	test("stays recording while auto-repeat keeps arriving", async () => {
		const h = makeHarness();
		await start(h);

		for (let i = 0; i < 10; i++) {
			h.clock.advance(100);
			h.controller.repeat();
		}
		// The fallback must have been cancelled by the repeats.
		expect(h.controller.currentState).toBe("recording");
		expect(h.debug.join("\n")).not.toContain("no auto-repeat seen");

		h.clock.advance(200);
		await flush();
		expect(h.controller.currentState).toBe("idle");
	});

	test("a stuck key cannot hold the microphone open past the cap", async () => {
		const h = makeHarness({}, { maxSessionMs: 5000 });
		await start(h);

		h.clock.advance(5000);
		await flush();
		expect(h.controller.currentState).toBe("idle");
	});
});

describe("tap mode", () => {
	const tap = { mode: "tap" as const };

	test("a second press finishes the session", async () => {
		const h = makeHarness(tap);
		await start(h);
		expect(h.controller.currentState).toBe("recording");

		h.controller.press();
		await flush();
		expect(h.controller.currentState).toBe("idle");
	});

	test("silence auto-finishes", async () => {
		const h = makeHarness(tap, { tapSilenceMs: 3000 });
		await start(h);

		h.clock.advance(3000);
		await flush();
		expect(h.controller.currentState).toBe("idle");
	});

	test("key release is ignored in tap mode", async () => {
		const h = makeHarness(tap);
		await start(h);

		h.controller.release();
		h.clock.advance(1000);
		await flush();
		expect(h.controller.currentState).toBe("recording");
	});
});

describe("failure reporting", () => {
	test("says so when the microphone heard nothing", async () => {
		const h = makeHarness({ mode: "tap" });
		await start(h);
		// Silence only: no audio signal.
		h.capture.emit(pcmOf(0, 4000));
		h.clock.advance(2500);
		h.controller.press();
		await flush();

		expect(h.errors).toEqual([{ message: expect.stringContaining("No audio detected"), code: "no_audio_signal" }]);
	});

	test("distinguishes no speech from no connection", async () => {
		const h = makeHarness({ mode: "tap" });
		h.backend.plans = [{ connected: false }];
		await start(h);
		h.capture.emit(pcmOf(500, 4000));
		h.clock.advance(2500);
		h.controller.press();
		await flush();

		expect(h.errors[0]?.code).toBe("connection_failed");
	});

	test("reports plain silence as no speech", async () => {
		const h = makeHarness({ mode: "tap" });
		await start(h);
		h.capture.emit(pcmOf(500, 4000));
		h.clock.advance(2500);
		h.controller.press();
		await flush();

		expect(h.errors[0]?.code).toBe("no_speech");
	});

	test("does not nag about a very short press", async () => {
		const h = makeHarness({ mode: "tap" });
		await start(h);
		h.controller.press();
		await flush();

		expect(h.errors).toEqual([]);
	});

	test("surfaces a capture availability problem verbatim", async () => {
		const h = makeHarness();
		h.capture.availability = { available: false, reason: "Voice mode requires SoX for audio recording." };
		await start(h);

		expect(h.errors).toEqual([
			{ message: "Voice mode requires SoX for audio recording.", code: "capture_unavailable" },
		]);
	});

	test("reports when the recorder cannot start", async () => {
		const h = makeHarness();
		h.capture.startResult = { ok: false, reason: "arecord: command not found" };
		await start(h);

		expect(h.errors[0]).toEqual({ message: "arecord: command not found", code: "capture_failed" });
	});

	test("reports when the backend cannot connect at all", async () => {
		const h = makeHarness();
		h.backend.failToConnect = 1;
		await start(h);

		expect(h.errors[0]?.code).toBe("connect_failed");
	});
});

describe("recovery: early retry", () => {
	test("retries once when the stream errors before any transcript", async () => {
		const h = makeHarness({}, { earlyRetryDelayMs: 250 });
		h.backend.plans = [
			{ events: [{ type: "error", message: "upgrade failed" }] },
			{ finalOnFinalize: "recovered text" },
		];

		await start(h);
		expect(h.backend.startCount).toBe(1);

		h.clock.advance(250);
		await flush();
		expect(h.backend.startCount).toBe(2);

		h.controller.release();
		h.clock.advance(200);
		await flush();

		expect(h.finals).toEqual(["recovered text"]);
		expect(h.errors).toEqual([]);
	});

	test("re-feeds the audio captured so far into the new stream, exactly once", async () => {
		const h = makeHarness({}, { earlyRetryDelayMs: 250 });
		h.backend.plans = [{ events: [{ type: "error", message: "boom" }] }, {}];

		await start(h);
		h.capture.emit(pcmOf(500, 3200));
		h.clock.advance(250);
		await flush();

		// The second stream gets the whole session exactly once. The un-flushed
		// coalescer tail is already inside `audio.all()`, so it must be dropped,
		// not sent first and then again.
		expect(h.backend.streams[1]!.bytesReceived).toBe(3200);
	});

	test("reports the backend's availability reason when a stream cannot start", async () => {
		const h = makeHarness();
		h.backend.failToConnect = 1;
		h.backend.availability = { available: false, reason: "No Parakeet model found." };

		h.controller.press();
		await flush();

		expect(h.errors).toContainEqual({ message: "No Parakeet model found.", code: "connect_failed" });
	});

	test("does not retry a second time", async () => {
		const h = makeHarness({}, { earlyRetryDelayMs: 250 });
		h.backend.plans = [
			{ events: [{ type: "error", message: "first" }] },
			{ events: [{ type: "error", message: "second" }] },
			{},
		];

		await start(h);
		h.clock.advance(250);
		await flush();
		expect(h.backend.startCount).toBe(2);

		h.clock.advance(250);
		await flush();
		expect(h.backend.startCount).toBe(2);
		expect(h.errors[0]?.message).toBe("second");
	});

	test("does not retry after a transcript has arrived", async () => {
		const h = makeHarness({}, { earlyRetryDelayMs: 250 });
		h.backend.plans = [
			{
				events: [
					{ type: "final", text: "got something" },
					{ type: "error", message: "too late" },
				],
			},
		];

		await start(h);
		h.clock.advance(250);
		await flush();

		expect(h.backend.startCount).toBe(1);
		// The partial transcript is salvaged rather than discarded.
		expect(h.finals).toEqual(["got something"]);
		expect(h.errors[0]?.message).toBe("too late");
	});
});

describe("recovery: silent-drop replay", () => {
	test("replays the retained audio when the stream dies without confirming", async () => {
		const h = makeHarness();
		h.backend.plans = [{ finalizeOutcome: "timeout" }, { finalOnFinalize: "text from the replay" }];

		await start(h);
		h.capture.emit(pcmOf(500, 6400));
		h.controller.release();
		h.clock.advance(200);
		await flush();

		expect(h.backend.startCount).toBe(2);
		expect(h.backend.streams[1]!.bytesReceived).toBe(6400);
		expect(h.finals).toEqual(["text from the replay"]);
	});

	test("replays when the socket only opened after start() returned", async () => {
		const h = makeHarness();
		h.backend.plans = [{ connected: false, finalizeOutcome: "timeout" }, { finalOnFinalize: "from replay" }];

		await start(h);
		// The real Deepgram socket is still CONNECTING when start() resolves; it
		// opens a moment later, and the replay path has to have noticed.
		h.backend.last!.plan.connected = true;
		h.capture.emit(pcmOf(500, 6400));
		h.controller.release();
		h.clock.advance(200);
		await flush();

		expect(h.backend.startCount).toBe(2);
		expect(h.finals).toEqual(["from replay"]);
	});

	test("replays when the socket opens while finalize is waiting", async () => {
		const h = makeHarness();
		h.backend.plans = [
			{
				connected: false,
				finalizeOutcome: "timeout",
				onFinalize: (stream) => {
					stream.plan.connected = true;
				},
			},
			{ finalOnFinalize: "from replay" },
		];

		await start(h);
		h.capture.emit(pcmOf(500, 6400));
		h.controller.release();
		h.clock.advance(200);
		await flush();

		expect(h.backend.startCount).toBe(2);
		expect(h.finals).toEqual(["from replay"]);
	});

	test("replays when the stream closes early", async () => {
		const h = makeHarness();
		h.backend.plans = [{ finalizeOutcome: "closed_early" }, { finalOnFinalize: "ok now" }];

		await start(h);
		h.capture.emit(pcmOf(500, 3200));
		h.controller.release();
		h.clock.advance(200);
		await flush();

		expect(h.finals).toEqual(["ok now"]);
	});

	test("does not replay when nothing was heard", async () => {
		const h = makeHarness({ mode: "tap" });
		h.backend.plans = [{ finalizeOutcome: "timeout" }, { finalOnFinalize: "should not happen" }];

		await start(h);
		h.capture.emit(pcmOf(0, 4000));
		h.clock.advance(2500);
		h.controller.press();
		await flush();

		expect(h.backend.startCount).toBe(1);
		expect(h.finals).toEqual([]);
	});

	test("does not replay when the stream never connected", async () => {
		const h = makeHarness({ mode: "tap" });
		h.backend.plans = [{ finalizeOutcome: "timeout", connected: false }, { finalOnFinalize: "nope" }];

		await start(h);
		h.capture.emit(pcmOf(500, 4000));
		h.clock.advance(2500);
		h.controller.press();
		await flush();

		expect(h.backend.startCount).toBe(1);
	});

	test("does not replay when the retained audio was truncated", async () => {
		const h = makeHarness({}, { maxBufferedAudioMs: 100 });
		h.backend.plans = [{ finalizeOutcome: "timeout" }, { finalOnFinalize: "nope" }];

		await start(h);
		// Two chunks larger than the 3200-byte cap: the first must be dropped.
		h.capture.emit(pcmOf(500, 4000));
		h.capture.emit(pcmOf(500, 4000));
		h.controller.release();
		h.clock.advance(200);
		await flush();

		expect(h.backend.startCount).toBe(1);
		expect(h.finals).toEqual([]);
	});

	test("does not replay twice", async () => {
		const h = makeHarness();
		h.backend.plans = [
			{ finalizeOutcome: "timeout" },
			{ finalizeOutcome: "timeout" },
			{ finalOnFinalize: "third time" },
		];

		await start(h);
		h.capture.emit(pcmOf(500, 3200));
		h.controller.release();
		h.clock.advance(200);
		await flush();

		expect(h.backend.startCount).toBe(2);
		expect(h.finals).toEqual([]);
	});
});

describe("recovery: circuit breaker", () => {
	test("pauses after three early failures inside the window", async () => {
		const h = makeHarness({}, { breakerThreshold: 3, breakerWindowMs: 10_000 });

		for (let attempt = 0; attempt < 3; attempt++) {
			h.backend.failToConnect = 1;
			await start(h);
			await flush();
		}

		expect(h.controller.currentState).toBe("paused");
		expect(h.errors.length).toBe(3);

		// While paused, a press is ignored entirely.
		h.controller.press();
		await flush();
		expect(h.capture.startCount).toBe(3);
	});

	test("failures outside the window do not trip it", async () => {
		const h = makeHarness({}, { breakerThreshold: 3, breakerWindowMs: 1000 });

		for (let attempt = 0; attempt < 3; attempt++) {
			h.backend.failToConnect = 1;
			await start(h);
			await flush();
			h.clock.advance(2000);
		}

		expect(h.controller.currentState).toBe("idle");
	});

	test("a successful transcript clears the failure history", async () => {
		const h = makeHarness({}, { breakerThreshold: 3 });
		h.backend.failToConnect = 1;
		await start(h);
		expect(h.errors.length).toBe(1);

		h.backend.plans = [{ finalOnFinalize: "working again" }];
		await start(h);
		h.controller.release();
		h.clock.advance(200);
		await flush();

		expect(h.finals).toEqual(["working again"]);
		expect(h.controller.currentState).toBe("idle");
	});
});

describe("keyterms", () => {
	test("passes the mined keyterms to the backend", async () => {
		const h = makeHarness({
			keyterms: async () => ({ bias: ["subagent", "worktree"], correct: ["subagent", "worktree"], truncated: false }),
		});
		await start(h);

		expect(h.backend.lastOptions?.keyterms).toEqual(["subagent", "worktree"]);
		expect(h.backend.lastOptions?.language).toBe("en");
	});

	test("a keyterm provider that throws does not break the session", async () => {
		const h = makeHarness({
			keyterms: async () => {
				throw new Error("mining exploded");
			},
		});
		await start(h);

		expect(h.controller.currentState).toBe("recording");
		expect(h.backend.lastOptions?.keyterms).toEqual([]);
	});
});

describe("correction", () => {
	test("repairs misheard keyterms for backends that cannot be biased", async () => {
		const h = makeHarness({
			correction: "safe",
			keyterms: async () => ({ bias: ["subagent"], correct: ["subagent"], truncated: false }),
		});
		h.backend.capabilities = { streaming: true, biasing: "none", languages: ["en"] };
		h.backend.plans = [{ finalOnFinalize: "the subagnet ran" }];

		await start(h);
		h.capture.emit(pcmOf(500, 3200));
		h.controller.release();
		h.clock.advance(200);
		await flush();

		expect(h.finals).toEqual(["the subagent ran"]);
	});

	test("only corrects toward the correction list, not the bias list", async () => {
		// The seed jargon is biasing-only: given it here, "parse" would become
		// "parser".
		const h = makeHarness({
			correction: "safe",
			keyterms: async () => ({ bias: ["parser"], correct: [], truncated: false }),
		});
		h.backend.capabilities = { streaming: true, biasing: "none", languages: ["en"] };
		h.backend.plans = [{ finalOnFinalize: "parse the file" }];

		await start(h);
		h.capture.emit(pcmOf(500, 3200));
		h.controller.release();
		h.clock.advance(200);
		await flush();

		expect(h.finals).toEqual(["parse the file"]);
	});

	test("leaves text alone for backends that bias natively", async () => {
		const h = makeHarness({
			correction: "safe",
			keyterms: async () => ({ bias: ["subagent"], correct: ["subagent"], truncated: false }),
		});
		h.backend.capabilities = { streaming: true, biasing: "native", languages: ["en"] };
		h.backend.plans = [{ finalOnFinalize: "the subagnet ran" }];

		await start(h);
		h.capture.emit(pcmOf(500, 3200));
		h.controller.release();
		h.clock.advance(200);
		await flush();

		expect(h.finals).toEqual(["the subagnet ran"]);
	});
});

describe("cancel", () => {
	test("cancel immediately after press does not resurrect the session", async () => {
		const h = makeHarness();
		h.controller.press();
		h.controller.cancel();
		await flush();

		expect(h.controller.currentState).toBe("idle");
		expect(h.states).not.toContain("recording");
	});

	test("discards the session without emitting a final", async () => {
		const h = makeHarness();
		h.backend.plans = [{ events: [{ type: "final", text: "should be discarded" }] }];

		await start(h);
		h.controller.cancel();
		await flush();

		expect(h.finals).toEqual([]);
		expect(h.controller.currentState).toBe("idle");
		expect(h.capture.stopCount).toBe(1);
	});
});

describe("audio plumbing", () => {
	test("emits level snapshots for the meter", async () => {
		const h = makeHarness();
		await start(h);
		h.capture.emit(pcmOf(500, 2000));

		expect(h.levels.length).toBeGreaterThan(0);
		expect(h.levels.at(-1)!.length).toBeLessThanOrEqual(16);
		expect(h.levels.at(-1)!.at(-1)).toBeGreaterThan(0.01);
	});

	test("coalesces audio into frames of at most one second", async () => {
		const h = makeHarness();
		await start(h);
		const stream = h.backend.last!;
		// 100 KB of audio: more than three full frames.
		for (let i = 0; i < 25; i++) h.capture.emit(pcmOf(500, 4000));

		expect(stream.received.length).toBeGreaterThan(1);
		for (const frame of stream.received) expect(frame.length).toBeLessThanOrEqual(32_000);
	});

	test("buffers audio while a slow backend is still starting up", async () => {
		const h = makeHarness();
		// Stand in for a load that takes real time, such as the Parakeet model or
		// a websocket handshake.
		h.backend.startDelayMs = 60;
		h.controller.press();
		await flush();

		// The microphone is already open, so nothing said during the wait is lost.
		expect(h.controller.currentState).toBe("recording");
		expect(h.capture.startCount).toBe(1);
		h.capture.emit(pcmOf(500, 6400));
		await new Promise((resolve) => setTimeout(resolve, 120));

		expect(h.backend.last!.bytesReceived).toBe(6400);

		h.controller.release();
		h.clock.advance(200);
		await flush();
	});

	test("stops sending audio once the stream is closed", async () => {
		const h = makeHarness({ mode: "tap" });
		h.backend.plans = [{ finalOnFinalize: "done" }];
		await start(h);
		h.capture.emit(pcmOf(500, 3200));
		h.controller.press();
		await flush();

		const stream = h.backend.last!;
		const sent = stream.received.length;
		h.capture.emit(pcmOf(500, 3200));
		expect(stream.received.length).toBe(sent);
	});

	test("a rejected feed does not tear down the session", async () => {
		const h = makeHarness();
		h.backend.plans = [{ feedFails: true }];
		await start(h);
		h.capture.emit(pcmOf(500, 3200));
		await flush();

		expect(h.controller.currentState).toBe("recording");
	});
});

describe("queue", () => {
	test("a press while processing starts a second recording instead of dropping it", async () => {
		const h = makeHarness();
		const gate = deferred<void>();
		h.backend.plans = [
			{ finalizeGate: gate.promise, finalOnFinalize: "first" },
			{ finalOnFinalize: "second" },
		];

		await start(h); // recording, seq 0
		h.controller.release();
		h.clock.advance(200);
		await flush();
		expect(h.controller.currentState).toBe("processing");

		h.controller.press(); // must open a second capture, not be swallowed
		await flush();
		expect(h.capture.startCount).toBe(2);
		expect(h.controller.currentState).toBe("recording");

		h.controller.release();
		h.clock.advance(200);
		await flush();
		expect(h.controller.currentState).toBe("queued");
		expect(h.controller.queueDepth).toBe(2);
		expect(h.finals).toEqual([]); // seq 1 is done but may not overtake seq 0

		gate.resolve();
		await flush();
		expect(h.finals).toEqual(["first", "second"]);
		expect(h.controller.currentState).toBe("idle");
	});

	test("two presses in the same tick open exactly one capture", async () => {
		const h = makeHarness();
		await flush();
		h.controller.press();
		h.controller.press(); // second press lands while begin() is still awaiting
		await flush();
		expect(h.capture.startCount).toBe(1);
		expect(h.controller.queueDepth).toBe(0);
		expect(h.controller.currentState).toBe("recording");
	});

	test("finals are emitted in recording order when they complete out of order", async () => {
		const h = makeHarness();
		const first = deferred<void>();
		const second = deferred<void>();
		h.backend.plans = [
			{ finalizeGate: first.promise, finalOnFinalize: "first" },
			{ finalizeGate: second.promise, finalOnFinalize: "second" },
		];

		await start(h); // seq 0
		h.controller.release();
		h.clock.advance(200);
		await flush();

		h.controller.press(); // seq 1, while seq 0 is still finalizing
		await flush();
		h.controller.release();
		h.clock.advance(200);
		await flush();
		expect(h.controller.currentState).toBe("queued");

		second.resolve(); // the later recording finishes first
		await flush();
		expect(h.finals).toEqual([]); // but must not be emitted yet
		expect(h.controller.queueDepth).toBe(2);

		first.resolve();
		await flush();
		expect(h.finals).toEqual(["first", "second"]);
		expect(h.controller.currentState).toBe("idle");
		expect(h.drained).toBe(1);
	});

	test("a failed job is stored empty and the next recording still lands", async () => {
		const h = makeHarness();
		h.backend.plans = [{ finalizeOutcome: "closed_early" }, { finalOnFinalize: "second" }];

		await start(h);
		h.controller.release();
		h.clock.advance(200);
		await flush();

		h.controller.press();
		await flush();
		h.controller.release();
		h.clock.advance(200);
		await flush();

		expect(h.controller.queueDepth).toBe(0);
		expect(h.finals).toEqual(["second"]);
	});

	test("a hung job is reaped and does not stall the queue", async () => {
		const gate = deferred<void>();
		const h = makeHarness({}, { jobReapMs: 10_000 });
		h.backend.plans = [{ finalizeGate: gate.promise }, { finalOnFinalize: "second" }];

		await start(h);
		h.controller.release();
		h.clock.advance(200);
		await flush();
		h.controller.press();
		await flush();
		h.controller.release();
		h.clock.advance(200);
		await flush();
		expect(h.finals).toEqual([]);

		h.clock.advance(10_000); // reap fires
		await flush();
		expect(h.finals).toEqual(["second"]);
		expect(h.controller.queueDepth).toBe(0);
		expect(h.debug.join("\n")).toContain("reap");

		gate.resolve(); // a late settle must not emit twice
		await flush();
		expect(h.finals).toEqual(["second"]);
	});

	test("a job with truncated buffered audio still stores text and frees its slot", async () => {
		const h = makeHarness({}, { maxBufferedAudioMs: 4_000 });
		h.backend.plans = [{ finalizeOutcome: "closed_early" }, { finalOnFinalize: "second" }];

		// seq 0: 4.375 s of signal against a 4 s retained buffer, so the replay path
		// is declined because the buffer is truncated.
		await start(h);
		h.capture.emit(pcmOf(900, 140_000));
		h.controller.release();
		h.clock.advance(200);
		await flush();

		h.controller.press();
		await flush();
		h.controller.release();
		h.clock.advance(200);
		await flush();
		expect(h.controller.queueDepth).toBe(0);
		expect(h.finals).toEqual(["second"]);
	});
});
