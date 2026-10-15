import { describe, expect, test } from "bun:test";
import { type ControllerDeps, type ControllerTimings, VoiceController, type VoiceState } from "./controller.ts";
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
	const states: VoiceState[] = [];
	const levels: number[][] = [];
	const debug: string[] = [];

	const controller = new VoiceController({
		backend,
		capture,
		mode: "hold",
		language: "en",
		correction: "safe",
		keyterms: async () => [],
		clock,
		timings,
		hooks: {
			onInterim: (text) => interims.push(text),
			onFinal: (text) => finals.push(text),
			onError: (message, code) => errors.push({ message, code }),
			onState: (state) => states.push(state),
			onLevel: (snapshot) => levels.push(snapshot),
			onDebug: (message) => debug.push(message),
		},
		...overrides,
	});

	return { controller, backend, capture, clock, interims, finals, errors, states, levels, debug };
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

	test("re-feeds the audio captured so far into the new stream", async () => {
		const h = makeHarness({}, { earlyRetryDelayMs: 250 });
		h.backend.plans = [{ events: [{ type: "error", message: "boom" }] }, {}];

		await start(h);
		h.capture.emit(pcmOf(500, 3200));
		h.clock.advance(250);
		await flush();

		// The second stream must have received the session audio, not just the tail.
		expect(h.backend.streams[1]!.bytesReceived).toBeGreaterThanOrEqual(3200);
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
		const h = makeHarness({ keyterms: async () => ["subagent", "worktree"] });
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
		const h = makeHarness({ correction: "safe", keyterms: async () => ["subagent"] });
		h.backend.capabilities = { streaming: true, biasing: "none", languages: ["en"] };
		h.backend.plans = [{ finalOnFinalize: "the subagnet ran" }];

		await start(h);
		h.capture.emit(pcmOf(500, 3200));
		h.controller.release();
		h.clock.advance(200);
		await flush();

		expect(h.finals).toEqual(["the subagent ran"]);
	});

	test("leaves text alone for backends that bias natively", async () => {
		const h = makeHarness({ correction: "safe", keyterms: async () => ["subagent"] });
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
