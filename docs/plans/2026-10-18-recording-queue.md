# better-pi-voice Non-destructive Recording Queue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make better-pi-voice able to record a new utterance while previous ones are still transcribing, transcribe every recording exactly once, and never silently drop one.

**Architecture:** Extract all per-recording state into a `VoiceSession`. The controller keeps one `active` session, a FIFO `jobs` list, `finished: Map<seq, text>` and `nextToEmit`, so results are always emitted in **recording-start order** even when they complete out of order. `state` becomes derived from (active session, outstanding jobs, breaker). `EditorSink` is made sequence-aware and the runtime submits once per drained queue. The Parakeet backend grows a session refcount and a serialized `model.transcribe` so unloading/disposal can never free the model under a queued job.

**Tech Stack:** TypeScript 7 (`tsc --noEmit`), Bun test runner (`bun test`), Biome (`biome check .`), `@earendil-works/pi-tui` / `pi-coding-agent` extension API, optional `transcribe-cpp@0.4.0` (batch ASR + Silero VAD role).

**Spec:** `/home/severingartland/programing_linux/marginalia-suite/marginalia/docs/backlog.md` section **E** (better-pi-voice: models, transcription logic, non-destructive recording queue). Supplements: `docs/future/2026-10-16-silero-vad-chunking.md`, `docs/reports/2026-10-15-voice-model-benchmarks.md`.

## Decisions already made (do not relitigate)

- **Queue order = recording start.** Assign `seq` at `begin()`; store each result in `finished: Map<seq, text>`; emit only when `seq === nextToEmit`. Deepgram finals and a queued Parakeet tail may land out of order; the map repairs it.
- **When the queue is full, REFUSE the new capture and notify. Never silently drop.** Cap is 4 outstanding jobs **plus** an 8 MiB buffered-audio budget (one full 120 s session is `120_000 ms × 32 B/ms = 3.84 MB`). Channel is a new `onNotice(message, level)` hook, so a refusal is not an error and does not trip the breaker.
- **One `VoiceSession` per recording**, a new derived `"queued"` state, and every job frees its slot on success, error, timeout or empty result (empty results are stored as `""` so `nextToEmit` never deadlocks).
- **`EditorSink` is sequence-aware**; interims are suppressed while any job is pending; `submitOnStop` submits once per drained queue.
- **Parakeet serialization:** all `model.transcribe` calls go through one promise chain, and a session refcount blocks `unload()`/`dispose()` while any stream is alive.
- **Logic defaults:** `idleUnloadMs` becomes `60_000`; `chunkSeconds` settles at `15`; keyterm cap is per backend (Deepgram 100, local 60); Silero VAD is ported behind a `PauseDetector` interface with the RMS heuristic as fallback.

## Global Constraints

- Repo: `/home/severingartland/programing_linux/better-pi-voice`. Exactly two backends exist: `deepgram` and `parakeet`. **No Whisper backend** (whisper-small is only a benchmark row).
- Lifecycle before this change is strictly serial: `idle → arming → recording → processing → idle` (+ `paused`). This plan is the deliberate superset: `idle | arming | recording | processing | queued | paused`.
- Tests and the runner: `bun test` (package script `test`), per-file `bun test src/controller.test.ts`. Static gates: `bun run typecheck` and `bun run lint`. Run `bun run check` before the final commit of the branch.
- `node_modules` is shared and must never be installed into, upgraded or deleted. No dependency changes; `transcribe-cpp` stays an optional dependency (`^0.4.0`).
- All time-dependent code goes through the injected `Clock`; no `setTimeout`/`Date.now()` inside the controller. Tests use `FakeClock`.
- Audio format is fixed: PCM s16le, 16 kHz, mono; `BYTES_PER_MS = 32`; `maxBufferedAudioMs = 120_000`.
- Queue order is by recording start (`seq`), never by completion time. A full queue refuses with a notification.
- Commit after every task. Keep existing tests green; update a test only when the task deliberately changes its contract (noted in the task).

## Review Focus

The spec is a vision document; these input classes are implied but not spelled out, and each gets a test in the owning task:

1. **Two presses before the first capture actually opens** (async gap in `begin()`) — a reasonable person expects one recording, not two mics or a lost press. → Task 2, test "two presses in the same tick open exactly one capture".
2. **A refused press while the key is held** (queue full) — no release/fallback timer may be left armed, and the release must not finish somebody else's session. → Task 5, test "a refused press arms no timers and a later release is ignored".
3. **`submitOnStop` with a multi-recording queue and text the user typed between finals** — exactly one submit, with the user's edits preserved and finals in order. → Task 7, tests "adopts user typing between finals" and "fires onQueueDrained once per drained queue".
4. **`dispose()` / backend switch while a local `transcribe` is in flight** — must not dispose the model under a running transcription, and must return. → Task 10, test "dispose during an in-flight transcribe does not free the model".
5. **A long recording whose retained audio is truncated while other jobs queue** — the queue must still advance and the loss must be visible in the existing truncation/replay logic, not hang. → Task 4, test "a job with truncated buffered audio still stores text and frees its slot".

---

## File Map

**Create**
- `src/session.ts` — `VoiceSession` (per-recording state) and its helpers.
- `src/session.test.ts` — unit tests for `VoiceSession`.
- `src/testing/deferred.ts` — a manually resolved promise, for holding `finalize()`.
- `src/backends/vad.ts` — Silero segmentation + cut planning (pure functions).
- `src/backends/vad.test.ts`
- `src/backends/pause-detector.ts` — `PauseDetector`, `LevelPauseDetector`, `VadPauseDetector`.
- `src/backends/pause-detector.test.ts`

**Modify**
- `src/controller.ts` / `src/controller.test.ts` — the queue and derived state (the core of this plan).
- `src/ui.ts` / `src/ui.test.ts` — sequence-aware `EditorSink`, `statusText` queue depth.
- `src/runtime.ts` / `src/runtime.test.ts` — hook wiring, notices, one submit per drain, awaiting `dispose()`.
- `src/types.ts` — optional `VoiceStream.cut()`.
- `src/backends/parakeet.ts` / `src/backends/parakeet.test.ts` — refcount, transcribe mutex, `cut()`, defaults, VAD detector.
- `src/settings.ts` / `src/settings.test.ts` — `idleUnloadMs`, `chunkSeconds`, per-backend keyterm caps.
- `src/testing/fake-backend.ts` — gateable `finalize()`, `cut()`, counters.
- `src/model-download.ts` / `src/model-download.test.ts` — catalog `role` + Silero VAD entry.
- `src/setup.ts` — skip VAD-role entries in the model picker.
- `README.md` — resident model, chunk length, queue behavior, stale "not implemented yet" line.

---

### Task 1: Extract `VoiceSession` (behaviour-preserving)

**Files:**
- Create: `src/session.ts`, `src/session.test.ts`
- Modify: `src/controller.ts`

**Interfaces:**
- Consumes: `AudioRecorder`, `FrameCoalescer`, `LevelRing` from `src/formats.ts`; `CaptureSession` from `src/capture.ts`; `VoiceStream` from `src/types.ts`; `Clock` from `src/clock.ts`.
- Produces: `VoiceSession` and `SessionTimer` — every later controller task reads/writes these exact fields.

```ts
// src/session.ts
export type SessionPhase = "arming" | "recording" | "processing";
export type SessionTimer = "retry" | "fallback" | "release" | "silence" | "max" | "reap";

export class VoiceSession {
	readonly seq: number;
	phase: SessionPhase = "arming";
	captureSession: CaptureSession | undefined;
	stream: VoiceStream | undefined;
	readonly audio: AudioRecorder;
	readonly coalescer: FrameCoalescer;
	readonly levels: LevelRing;
	transcript: string;
	pendingInterim: string;
	correctionTerms: string[];
	hadAudioSignal: boolean;
	sawTranscript: boolean;
	streamWasConnected: boolean;
	retried: boolean;
	replayed: boolean;
	/** True once this recording's result (possibly "") is in `finished`. */
	stored: boolean;
	/** Cancelled / disposed: async callbacks for this session must no-op. */
	abandoned: boolean;
	startedAt: number;
	readonly timers: Partial<Record<SessionTimer, TimerHandle>>;
	constructor(init: { seq: number; maxBufferedAudioMs: number; clock?: Clock | undefined });
	/** Push a live chunk; returns the coalesced frames to feed. */
	pushChunk(chunk: Buffer): Buffer[];
	/** Push a whole retained buffer (replay/retry); returns frames incl. flushed tail. */
	pushBuffer(buffer: Buffer): Buffer[];
	flushTail(): Buffer | undefined;
	clearTimers(): void;
	/** Stop capture and close the stream; never throws. */
	release(): void;
}
```

- [ ] **Step 1: Write the failing test**

```ts
// src/session.test.ts
import { describe, expect, test } from "bun:test";
import { VoiceSession } from "./session.ts";
import { pcmOf } from "./testing/fake-capture.ts";

describe("VoiceSession", () => {
	test("starts empty and arming", () => {
		const session = new VoiceSession({ seq: 7, maxBufferedAudioMs: 120_000 });
		expect(session.seq).toBe(7);
		expect(session.phase).toBe("arming");
		expect(session.transcript).toBe("");
		expect(session.stored).toBe(false);
	});

	test("pushChunk records audio and levels, never the stream", () => {
		const session = new VoiceSession({ seq: 0, maxBufferedAudioMs: 120_000 });
		const frames = session.pushChunk(pcmOf(800, 32_000));
		expect(session.audio.byteLength).toBe(32_000);
		expect(session.levels.snapshot().length).toBeGreaterThan(0);
		expect(frames.length).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/session.test.ts`
Expected: FAIL — `Cannot find module "./session.ts"`.

- [ ] **Step 3: Implement `src/session.ts`** by moving the per-recording fields out of `VoiceController` and add a `session` parameter to `onData`, `onEvent`, `process`, `replayBuffer`, `finalizeStream`, `flushTail`, `armSilenceTimer`, `armRelease`, `onHoldProgress`, `promoteInterim`, `emitTranscript`, `reportEmpty` in `src/controller.ts` (replace every `this.transcript`/`this.audio`/… with `session.…`). Set `this.active = session` in `begin()`. `pushChunk` = level push + `audio.append` + `coalescer.push`; `pushBuffer` = `coalescer.push` then `flushTail`; `release()` = `captureSession?.stop()`, close `stream`, clear timers, never throw.

- [ ] **Step 4: Run the whole suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS — all 44 existing controller tests plus the new file; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/session.ts src/session.test.ts src/controller.ts
git commit -m "refactor: extract per-recording VoiceSession"
```

---

### Task 2: Queue core — `seq`, `jobs`, `finished`, `nextToEmit`, `"queued"` state, press while processing

**Files:**
- Modify: `src/controller.ts`, `src/controller.test.ts`

**Interfaces:**
- Consumes: `VoiceSession` (Task 1).
- Produces: `VoiceState` gains `"queued"`; `VoiceController` gains `get queueDepth(): number` and `get pendingSeq(): number`; `ControllerHooks` gains `onNotice?` and `onQueueDrained?`; `onFinal?(text: string, seq: number)`.

```ts
export type VoiceState = "idle" | "arming" | "recording" | "processing" | "queued" | "paused";
export type ControllerTimings = {
	/* existing fields unchanged */
	maxQueuedJobs: number;        // default 4
	maxQueuedAudioBytes: number;  // default 8 * 1024 * 1024
	jobReapMs: number;            // default 30_000
	disposeGraceMs: number;       // default 5_000
};
export type ControllerHooks = {
	/* existing hooks; onFinal/onInterim now take a seq */
	onFinal?(text: string, seq: number): void;
	onInterim?(text: string, seq: number): void;
	onNotice?(message: string, level: "info" | "warning" | "error"): void;
	onQueueDrained?(): void;
};
```

**Controller invariants (implementer: put these in a comment and keep them true):**
1. `seq` is assigned from a monotonically increasing `nextSeq` in `begin()`; one recording = one seq; seqs are contiguous.
2. `active` is at most one session. `jobs` holds finished-recording sessions that have not stored a result, ordered by `seq` ascending.
3. Every job eventually stores a result, including `""` (`finished.set(seq, text)`), even on error/timeout/empty.
4. `finished` only holds seqs `>= nextToEmit`; `emitReady()` loops `while (finished.has(nextToEmit))`, emits non-empty text via `onFinal(text, seq)` and increments. Because seqs are contiguous and every job stores, the loop always terminates and never deadlocks.
5. `queueDepth = jobs.length + finished.size` (recordings started, not yet emitted).
6. Derived state: `active` → `active.phase`; else paused (breaker open) → `"paused"`; else `queueDepth === 0` → `"idle"`; `=== 1` → `"processing"`; `>= 2` → `"queued"`.
7. `press()` is allowed from `idle`, `processing` and `queued` (any state with no active session and capacity); while `active` exists it keeps today's hold/tap semantics for that session.

- [ ] **Step 1: Write the failing test**

Add `notices`/`drained` to the `Harness` type and `makeHarness` in `src/controller.test.ts` (hooks: `onNotice: (m) => notices.push(m)`, `onQueueDrained: () => { drained++; }`). Then:

```ts
import { deferred } from "./testing/deferred.ts";

test("a press while processing starts a second recording instead of dropping it", async () => {
	const h = makeHarness();
	const gate = deferred<void>();
	h.backend.plans = [
		{ finalizeGate: gate.promise, finalOnFinalize: "first" },
		{ finalOnFinalize: "second" },
	];

	await start(h);                 // recording, seq 0
	h.controller.release();
	h.clock.advance(200);
	await flush();
	expect(h.controller.currentState).toBe("processing");

	h.controller.press();           // must open a second capture, not be swallowed
	await flush();
	expect(h.capture.startCount).toBe(2);
	expect(h.controller.currentState).toBe("recording");

	h.controller.release();
	h.clock.advance(200);
	await flush();
	expect(h.controller.currentState).toBe("queued");
	expect(h.controller.queueDepth).toBe(2);
	expect(h.finals).toEqual([]);   // seq 1 is done but may not overtake seq 0

	gate.resolve();
	await flush();
	expect(h.finals).toEqual(["first", "second"]);
	expect(h.controller.currentState).toBe("idle");
});

test("two presses in the same tick open exactly one capture", async () => {
	const h = makeHarness();
	await flush();
	h.controller.press();
	h.controller.press();           // second press lands while begin() is still awaiting
	await flush();
	expect(h.capture.startCount).toBe(1);
	expect(h.controller.queueDepth).toBe(0);
	expect(h.controller.currentState).toBe("recording");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/controller.test.ts -t "queue"`
Expected: FAIL — second press is swallowed (state `processing`), or `currentState` is `processing` not `queued`.

- [ ] **Step 3: Implement** the queue fields and `deriveState()`/`refreshState()` in `src/controller.ts`. Replace direct `setState("processing")`/`setState("idle")` calls with `session.phase = …` / `refreshState()`. `finish(session)` stops capture, sets `phase = "processing"`, pushes the session onto `jobs`, starts `processJob(session)` (fire-and-forget, tracked in an `inflight: Set<Promise<void>>`), and calls `refreshState()`. Guard `begin()` with a `starting` flag so a press during the `checkAvailability()`/`start()` awaits does nothing (invariant 7).

- [ ] **Step 4: Run test to verify it passes, then the whole file**

Run: `bun test src/controller.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/controller.ts src/controller.test.ts src/testing/deferred.ts
git commit -m "feat: record-order voice queue with a derived queued state"
```

---

### Task 3: Out-of-order completion emits in recording order

**Files:**
- Modify: `src/testing/fake-backend.ts`, `src/controller.test.ts`

**Interfaces:**
- Produces: `FakeStreamPlan.finalizeGate?: Promise<void>` — `FakeStream.finalize()` awaits it before returning, so a test can finish a later job first.

- [ ] **Step 1: Write the failing test**

```ts
test("finals are emitted in recording order when they complete out of order", async () => {
	const h = makeHarness();
	const first = deferred<void>();
	const second = deferred<void>();
	h.backend.plans = [
		{ finalizeGate: first.promise, finalOnFinalize: "first" },
		{ finalizeGate: second.promise, finalOnFinalize: "second" },
	];

	await start(h);                 // seq 0
	h.controller.release();
	h.clock.advance(200);
	await flush();

	h.controller.press();           // seq 1, while seq 0 is still finalizing
	await flush();
	h.controller.release();
	h.clock.advance(200);
	await flush();
	expect(h.controller.currentState).toBe("queued");

	second.resolve();               // the later recording finishes first
	await flush();
	expect(h.finals).toEqual([]);   // but must not be emitted yet
	expect(h.controller.queueDepth).toBe(2);

	first.resolve();
	await flush();
	expect(h.finals).toEqual(["first", "second"]);
	expect(h.controller.currentState).toBe("idle");
	expect(h.drained).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/controller.test.ts -t "out of order"`
Expected: FAIL — `finalizeGate` is not honoured (`finalize()` resolves immediately) or `finals` is `["second"]`.

- [ ] **Step 3: Implement** the gate in `FakeStream.finalize()` (`if (this.plan.finalizeGate) await this.plan.finalizeGate;` before the existing body). In the controller, the job's result path must be `store(job, text)` (idempotent via `job.stored`): set `finished`, remove from `jobs`, `emitReady()`, then `refreshState()`.

- [ ] **Step 4: Run tests**

Run: `bun test src/controller.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/testing/fake-backend.ts src/controller.test.ts
git commit -m "test: pin recording-order emission for out-of-order completions"
```

---

### Task 4: Failed, empty and hung jobs free their slot

**Files:**
- Modify: `src/controller.ts`, `src/controller.test.ts`

**Interfaces:**
- Consumes: `jobReapMs` (Task 2).
- Produces: no new API; enforces invariant 3 for non-success outcomes.

- [ ] **Step 1: Write the failing tests**

```ts
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

	h.clock.advance(10_000);        // reap fires
	await flush();
	expect(h.finals).toEqual(["second"]);
	expect(h.controller.queueDepth).toBe(0);
	expect(h.debug.join("\n")).toContain("reap");

	gate.resolve();                 // a late settle must not emit twice
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/controller.test.ts -t "reaped"`
Expected: FAIL — the queue never advances (no reap timer) or `queueDepth` stays 2.

- [ ] **Step 3: Implement** the per-job reap timer in `processJob` (arm `reap` for `jobReapMs`; on fire close the stream, `store(job, job.transcript)`, debug `job reaped after <ms>ms`), and make every exit path of `processJob` call `store(job, text)` in a `finally`. `store` is a no-op when `job.stored`. Clear the reap timer in `store`.

- [ ] **Step 4: Run tests**

Run: `bun test src/controller.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/controller.ts src/controller.test.ts
git commit -m "feat: reap hung jobs and always free a queue slot"
```

---

### Task 5: Queue capacity and refusal

**Files:**
- Modify: `src/controller.ts`, `src/controller.test.ts`

**Interfaces:**
- Consumes: `maxQueuedJobs`, `maxQueuedAudioBytes` (Task 2), `onNotice` (Task 2).
- Produces: `canAccept(): boolean` (private) and `queueFullMessage(): string` (private).

- [ ] **Step 1: Write the failing tests**

```ts
test("refuses a new recording when the job cap is reached and says so", async () => {
	const gate = deferred<void>();
	const h = makeHarness({}, { maxQueuedJobs: 2 });
	h.backend.plans = [
		{ finalizeGate: gate.promise },
		{ finalizeGate: gate.promise },
		{ finalOnFinalize: "never" },
	];

	await start(h);
	h.controller.release();
	h.clock.advance(200);
	await flush();
	h.controller.press();            // second recording, allowed
	await flush();
	h.controller.release();
	h.clock.advance(200);
	await flush();
	expect(h.controller.queueDepth).toBe(2);

	h.controller.press();            // third is refused: no new capture
	await flush();
	expect(h.capture.startCount).toBe(2);
	expect(h.controller.currentState).toBe("queued");
	expect(h.notices).toHaveLength(1);
	expect(h.notices[0]).toContain("queue is full");

	gate.resolve();
	await flush();
});

test("refuses a new recording when buffered job audio would exceed the budget", async () => {
	const gate = deferred<void>();
	const h = makeHarness({}, { maxQueuedAudioBytes: 1_000 });
	h.backend.plans = [{ finalizeGate: gate.promise }];

	await start(h);
	h.capture.emit(pcmOf(900, 4_000));   // 4 KB retained > 1 KB budget
	h.controller.release();
	h.clock.advance(200);
	await flush();

	h.controller.press();
	await flush();
	expect(h.capture.startCount).toBe(1);
	expect(h.notices[0]).toContain("queue is full");

	gate.resolve();
	await flush();
});

test("a refused press arms no timers and a later release is ignored", async () => {
	const gate = deferred<void>();
	const h = makeHarness({}, { maxQueuedJobs: 1 });
	h.backend.plans = [{ finalizeGate: gate.promise }];
	await start(h);
	h.controller.release();
	h.clock.advance(200);
	await flush();

	h.clock.advance(10_000);            // let any stray timers fire while idle
	const timersBefore = h.clock.pending;
	h.controller.press();               // refused
	expect(h.clock.pending).toBe(timersBefore);   // no fallback/release timer armed
	h.controller.release();             // must not finish anything
	await flush();
	expect(h.capture.startCount).toBe(1);

	gate.resolve();
	await flush();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/controller.test.ts -t "refuses"`
Expected: FAIL — a third capture starts, or `notices` is empty.

- [ ] **Step 3: Implement** `canAccept()` = `this.jobs.length < timings.maxQueuedJobs && this.queuedAudioBytes() < timings.maxQueuedAudioBytes`, where `queuedAudioBytes()` sums `job.audio.byteLength` over `jobs`. In `press()`, when there is no active session and `!canAccept()`, call `this.deps.hooks?.onNotice?.(queueFullMessage(), "warning")` and return **before** arming the hold fallback. Message: `` `Voice queue is full (${String(this.queueDepth)} recordings waiting). Wait for transcription to catch up.` ``

- [ ] **Step 4: Run tests**

Run: `bun test src/controller.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/controller.ts src/controller.test.ts
git commit -m "feat: refuse a recording when the transcription queue is full"
```

---

### Task 6: Deterministic shutdown drain

**Files:**
- Modify: `src/controller.ts`, `src/runtime.ts`, `src/controller.test.ts`, `src/runtime.test.ts`

**Interfaces:**
- Produces: `VoiceController.dispose(): Promise<void>` (was `void`). Contract: (1) stop the active capture; (2) wait up to `disposeGraceMs` for in-flight jobs; (3) store `""` for anything still unsettled, then `emitReady()` so already-finished text is not lost; (4) leave `currentState === "idle"`, `queueDepth === 0`; (5) no `onFinal`/`onNotice` after the promise resolves.

- [ ] **Step 1: Write the failing test**

```ts
test("dispose stops the microphone, keeps finished text, and returns despite a hung job", async () => {
	const gate = deferred<void>();
	const h = makeHarness({}, { disposeGraceMs: 5_000 });
	h.backend.plans = [
		{ finalizeGate: gate.promise, finalOnFinalize: "first" },
		{ finalOnFinalize: "second" },
	];

	await start(h);
	h.controller.release();
	h.clock.advance(200);
	await flush();
	h.controller.press();               // second recording open while seq 0 hangs
	await flush();
	expect(h.capture.startCount).toBe(2);

	const disposing = h.controller.dispose();
	h.clock.advance(5_000);             // grace expires; the hung job is abandoned
	await disposing;

	expect(h.controller.currentState).toBe("idle");
	expect(h.controller.queueDepth).toBe(0);
	expect(h.capture.stopCount).toBe(2);
	expect(h.finals).toEqual(["second"]); // completed work is not thrown away

	gate.resolve();
	await flush();
	expect(h.finals).toEqual(["second"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/controller.test.ts -t "dispose stops"`
Expected: FAIL — `dispose()` returns `undefined`/not awaitable, or the hung job keeps the queue non-empty.

- [ ] **Step 3: Implement** `async dispose()` per the contract, tracking `inflight` promises and racing them against a `this.clock.setTimeout(disposeGraceMs)` promise. Set `this.disposed = true` first so guards make late `store`/`emitReady`/`refreshState` no-ops. In `src/runtime.ts` change `controller.dispose()` to `await controller.dispose()` and keep `await backend.dispose?.()`. In `src/runtime.test.ts` assert the existing runtime test still awaits cleanly (`await runtime.dispose()` already there).

- [ ] **Step 4: Run tests**

Run: `bun test src/controller.test.ts src/runtime.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/controller.ts src/controller.test.ts src/runtime.ts src/runtime.test.ts
git commit -m "feat: deterministic controller shutdown drain"
```

---

### Task 7: Sequence-aware `EditorSink`, interim suppression, one submit per drain

**Files:**
- Modify: `src/ui.ts`, `src/ui.test.ts`, `src/controller.ts`, `src/controller.test.ts`, `src/runtime.ts`

**Interfaces:**
- Consumes: `onFinal(text, seq)`, `onInterim(text, seq)`, `onQueueDrained` (Task 2).
- Produces: `EditorSink` API: `begin()`, `interim(seq, text)`, `commit(seq, text): string`, `submitText(): string`. Rendering = `prefix + committed finals in seq order + the live interim`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/ui.test.ts — replace the existing EditorSink calls with seq-aware ones
test("renders finals in sequence order even when they commit out of order", () => {
	const editor = { text: "note: " };
	const sink = new EditorSink(editor);
	sink.begin();
	sink.interim(1, "live words");
	sink.commit(0, "first");
	expect(editor.text).toBe("note: first\nlive words");
	sink.commit(1, "final words");
	expect(editor.text).toBe("note: final words");
});

test("adopts user typing between finals instead of overwriting it", () => {
	const editor = { text: "" };
	const sink = new EditorSink(editor);
	sink.begin();
	editor.text = "typed by hand";
	sink.commit(0, "from speech");
	expect(editor.text).toBe("typed by hand\nfrom speech");
	expect(sink.submitText()).toBe("typed by hand\nfrom speech");
});
```

```ts
// src/controller.test.ts
test("suppresses interims while another recording is still transcribing", async () => {
	const gate = deferred<void>();
	const h = makeHarness();
	h.backend.plans = [
		{ finalizeGate: gate.promise },
		{ events: [{ type: "interim", text: "live" }, { type: "final", text: "second" }] },
	];

	await start(h);
	h.controller.release();
	h.clock.advance(200);
	await flush();
	h.controller.press();               // job pending + a live recording
	await flush();
	expect(h.interims).not.toContain("live");

	h.controller.release();
	h.clock.advance(200);
	await flush();
	gate.resolve();
	await flush();
	expect(h.finals).toEqual(["second"]);
});

test("signals a drained queue exactly once", async () => {
	const h = makeHarness();
	await start(h);
	h.controller.release();
	h.clock.advance(200);
	await flush();
	expect(h.drained).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/ui.test.ts src/controller.test.ts -t "EditorSink"`
Expected: FAIL — `sink.interim` does not exist; interims are emitted while a job is pending.

- [ ] **Step 3: Implement** `EditorSink` with a `finals: Map<number, string>` and `live?: { seq: number; text: string }`, preserving `refreshPrefix()`'s user-typing adoption. In the controller, suppress `onInterim` (store `session.pendingInterim` but do not call the hook) whenever `this.jobs.length + this.finished.size > 0`, and never call `onInterim` for a session that is not `active`. Call `onQueueDrained()` from `settle()` only on the transition to `queueDepth === 0` when at least one final was emitted since the previous drain. In `src/runtime.ts`: `onInterim: (text, seq) => editor.interim(seq, text)`, `onFinal: (text, seq) => { editor.commit(seq, text); }`, and `onQueueDrained: () => { if (settings.submitOnStop) pi.sendUserMessage(editor.submitText()); }`.

- [ ] **Step 4: Run tests**

Run: `bun test && bun run typecheck`
Expected: PASS (update the remaining `EditorSink` assertions in `src/ui.test.ts` to pass a seq; their expectations stay).

- [ ] **Step 5: Commit**

```bash
git add src/ui.ts src/ui.test.ts src/controller.ts src/controller.test.ts src/runtime.ts
git commit -m "feat: sequence-aware editor sink and one submit per drain"
```

---

### Task 8: Queue depth in the status line

**Files:**
- Modify: `src/ui.ts`, `src/ui.test.ts`, `src/runtime.ts`

**Interfaces:**
- Consumes: `VoiceController.queueDepth` (Task 2), `VoiceState` with `"queued"`.
- Produces: `statusText(state: VoiceState, label: string, queueDepth = 0): string | undefined`.

- [ ] **Step 1: Write the failing tests**

```ts
test("shows how many recordings are still pending", () => {
	expect(statusText("processing", "deepgram nova-3", 1)).toContain("1 recording");
	expect(statusText("queued", "deepgram nova-3", 3)).toContain("3 recordings");
	expect(statusText("recording", "deepgram nova-3", 2)).toContain("2 queued");
});

test("names the backend and model in every state", () => {
	const label = "deepgram nova-3";
	for (const state of ["idle", "arming", "recording", "processing", "queued", "paused"] as const) {
		expect(statusText(state, label)).toContain(label);
	}
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/ui.test.ts -t "pending"`
Expected: FAIL — `statusText` ignores the third argument; `"queued"` is not in the union.

- [ ] **Step 3: Implement** the third parameter (pluralised `recording`/`recordings`; while `recording`, `N queued` appended when `N > 1`), keeping the existing copy for depth ≤ 1. In `src/runtime.ts` `onState`, pass `controller.queueDepth`.

- [ ] **Step 4: Run tests**

Run: `bun test src/ui.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui.ts src/ui.test.ts src/runtime.ts
git commit -m "feat: show queue depth in the voice status line"
```

---

### Task 9: `VoiceStream.cut()` and cutting on `begin()`

**Files:**
- Modify: `src/types.ts`, `src/backends/parakeet.ts`, `src/testing/fake-backend.ts`, `src/controller.ts`, `src/controller.test.ts`, `src/backends/parakeet.test.ts`

**Interfaces:**
- Produces: `VoiceStream.cut?(): void` — "transcribe whatever is buffered now, without waiting for the chunk target". `ParakeetBatchStream.cut()` takes all buffered audio and enqueues it; a no-op once `finalize()` has started.

- [ ] **Step 1: Write the failing tests**

```ts
// src/controller.test.ts
test("starting a new recording cuts the outstanding batch tail", async () => {
	const gate = deferred<void>();
	const h = makeHarness();
	h.backend.plans = [{ finalizeGate: gate.promise }, {}];

	await start(h);
	h.controller.release();
	h.clock.advance(200);
	await flush();
	expect(h.backend.streams[0]!.cutCount).toBe(0);

	h.controller.press();               // begin() must cut the previous stream now
	await flush();
	expect(h.backend.streams[0]!.cutCount).toBe(1);

	gate.resolve();
	await flush();
});
```

```ts
// src/backends/parakeet.test.ts — a batch stream transcribes its tail on cut()
test("cut() transcribes the buffered tail immediately", async () => {
	// Build a backend with a fake model whose transcribe records the call, start()
	// a batch stream, feed one second of PCM, call stream.cut(), and await a tick.
	// Expect the recorded PCM to be one second (32_000 bytes -> 16_000 samples),
	// without calling finalize().
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/controller.test.ts -t "cuts the outstanding"`
Expected: FAIL — `cutCount` is `undefined`/`0`.

- [ ] **Step 3: Implement** `cut?(): void` on `VoiceStream`; `FakeStream.cut()` increments a public `cutCount`; `ParakeetBatchStream.cut()` = `if (this.finalizeStarted) return; const all = this.takeAll(); if (all) this.enqueue(all);`. In `begin()`, before the first `await`, run `for (const job of this.jobs) { try { job.stream?.cut?.(); } catch { /* a closed stream is allowed to refuse */ } }` (this is also what makes a queued batch tail start decoding without waiting for `chunkSeconds`).

- [ ] **Step 4: Run tests**

Run: `bun test src/controller.test.ts src/backends/parakeet.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/backends/parakeet.ts src/testing/fake-backend.ts src/controller.ts src/controller.test.ts src/backends/parakeet.test.ts
git commit -m "feat: cut batch tails when a new recording starts"
```

---

### Task 10: Parakeet refcount + serialized `transcribe`

**Files:**
- Modify: `src/backends/parakeet.ts`, `src/backends/parakeet.test.ts`

**Interfaces:**
- Produces (private): `activeSessions: number`, `pendingUnload: boolean`, `transcribeChain: Promise<unknown>`, `serializeTranscribe<T>(task: () => Promise<T>): Promise<T>`. `unload()` becomes a no-op that sets `pendingUnload` while `activeSessions > 0`; `scheduleIdleUnload()` defers until the last session releases; `dispose()` does the same but also sets a `disposed` flag.

- [ ] **Step 1: Write the failing tests**

```ts
test("does not unload while another session is still transcribing", async () => {
	const { backend, fake } = makeBackend({ idleUnloadMs: 0 });
	const first = await backend.start(opts(), () => {});
	const second = await backend.start(opts(), () => {});
	expect(first).toBeDefined();
	expect(second).toBeDefined();

	first!.close();
	// One session is still open: the model must stay resident even at idleUnloadMs 0.
	expect(backend.modelLoaded).toBe(true);
	expect(fake.wasDisposed()).toBe(false);

	second!.close();
	expect(backend.modelLoaded).toBe(false);
	expect(fake.wasDisposed()).toBe(true);
});

test("dispose during an in-flight transcribe does not free the model", async () => {
	// fakeModel's transcribe holds a gate promise; start a batch stream, feed PCM,
	// call backend.dispose(), assert modelLoaded is still true while the transcribe
	// is pending, then release the gate and assert the model is disposed exactly once.
});

test("serializes transcribe calls across concurrent batch streams", async () => {
	// fakeModel.transcribe increments an `inFlight` counter and awaits a tick;
	// two batch streams each feed enough PCM to enqueue a chunk; assert maxInFlight === 1.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/backends/parakeet.test.ts -t "in-flight transcribe"`
Expected: FAIL — `unload()` disposes the shared model while the second stream is alive.

- [ ] **Step 3: Implement** the refcount in `start()` (`this.activeSessions++`, wrap `onReleased` so the decrement happens exactly once and `scheduleIdleUnload()` runs only at zero) for **both** batch and streaming paths, and wrap the batch `transcribe` callback in `serializeTranscribe`. `dispose()` waits for `activeSessions === 0` by setting `pendingUnload`/`disposed` and returning; the last `onReleased` performs the unload. Keep the `released` guard in `ParakeetBatchStream` so a session cannot be counted twice.

- [ ] **Step 4: Run tests**

Run: `bun test src/backends/parakeet.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backends/parakeet.ts src/backends/parakeet.test.ts
git commit -m "fix: refcount parakeet sessions and serialize transcribe"
```

---

### Task 11: Raise the resident-model window to 60 s

**Files:**
- Modify: `src/backends/parakeet.ts`, `src/settings.ts`, `src/settings.test.ts`, `src/backends/parakeet.test.ts`, `README.md`

**Interfaces:**
- Produces: `DEFAULT_IDLE_UNLOAD_MS = 60_000`; `DEFAULT_SETTINGS.parakeet.idleUnloadMs = 60_000`.

- [ ] **Step 1: Update the failing assertions**

```ts
// src/backends/parakeet.test.ts
test("the built-in default holds the model for a minute", () => {
	expect(DEFAULT_IDLE_UNLOAD_MS).toBe(60_000);
});

test("releases the model one idle minute after the queue empties", async () => {
	const { backend, clock, fake } = makeBackend();   // now defaults to 60_000
	await record(backend);
	clock.advance(59_000);
	expect(backend.modelLoaded).toBe(true);
	clock.advance(1_000);
	expect(backend.modelLoaded).toBe(false);
	expect(fake.wasDisposed()).toBe(true);
});
```

Remove the old "releases the model after every recording by default" and "keeps nothing resident" expectations.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/backends/parakeet.test.ts -t "minute"`
Expected: FAIL — `DEFAULT_IDLE_UNLOAD_MS` is `0`.

- [ ] **Step 3: Implement** both constant changes and rewrite the `DEFAULT_IDLE_UNLOAD_MS` doc comment (the reload cost measured is ~0.4 s; holding a 135 MB–700 MB model for a minute across queued recordings is now the better trade, and residency is released as soon as the queue empties). Update the README "Keeping the model loaded" section and the settings-sample comments (`"idleUnloadMs": 60000`).

- [ ] **Step 4: Run tests**

Run: `bun test src/backends/parakeet.test.ts src/settings.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backends/parakeet.ts src/settings.ts src/settings.test.ts src/backends/parakeet.test.ts README.md
git commit -m "feat: hold the local model for a minute between recordings"
```

---

### Task 12: Settle `chunkSeconds` at 15

**Files:**
- Modify: `src/settings.ts`, `src/settings.test.ts`, `src/backends/parakeet.ts` (comment), `README.md`

**Interfaces:**
- Produces: `DEFAULT_SETTINGS.parakeet.chunkSeconds = 15`, matching the existing `DEFAULT_CHUNK_SECONDS = 15`.

- [ ] **Step 1: Write the failing test**

```ts
// src/settings.test.ts
test("chunkSeconds and the batch default agree at 15", () => {
	expect(DEFAULT_SETTINGS.parakeet.chunkSeconds).toBe(15);
	expect(DEFAULT_CHUNK_SECONDS).toBe(15);   // imported from ./backends/parakeet.ts
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/settings.test.ts -t "agree at 15"`
Expected: FAIL — expected 15, received 30.

- [ ] **Step 3: Implement** the default change and align the two comments (`src/settings.ts` batch comment, `src/backends/parakeet.ts` `DEFAULT_CHUNK_SECONDS` doc, README `parakeet.chunkSeconds` bullet and JSON sample). Rationale to keep in the comment: a 15 s chunk costs ~4.4 s to decode at the measured 3.38 RTF, halving text latency; chunkSeconds is a *target*, so unbroken speech still grows past it.

- [ ] **Step 4: Run tests**

Run: `bun test src/settings.test.ts src/backends/parakeet.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts src/settings.test.ts src/backends/parakeet.ts README.md
git commit -m "feat: settle chunkSeconds on 15s"
```

---

### Task 13: Backend-specific keyterm caps

**Files:**
- Modify: `src/settings.ts`, `src/settings.test.ts`, `src/runtime.ts`

**Interfaces:**
- Produces: `keyterms.maxTerms: number | null` (default `null` = use the backend cap); `deepgram.maxKeyterms: number` (default 100); `parakeet.maxKeyterms: number` (default 60); `export function resolveMaxTerms(settings: VoiceSettings): number`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/settings.test.ts
test("keyterm cap defaults to the backend's own budget", () => {
	expect(resolveMaxTerms(DEFAULT_SETTINGS)).toBe(100);                       // deepgram
	expect(resolveMaxTerms({ ...DEFAULT_SETTINGS, backend: "parakeet" })).toBe(60);
	expect(
		resolveMaxTerms({ ...DEFAULT_SETTINGS, keyterms: { ...DEFAULT_SETTINGS.keyterms, maxTerms: 12 } }),
	).toBe(12);
});

test("an explicit keyterms.maxTerms is parsed and kept", () => {
	const { settings } = parseSettings({ keyterms: { maxTerms: 7 } });
	expect(settings.keyterms.maxTerms).toBe(7);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/settings.test.ts -t "backend's own budget"`
Expected: FAIL — `resolveMaxTerms` is not exported; `maxTerms` is 60.

- [ ] **Step 3: Implement** the type/default changes and `resolveMaxTerms` in `src/settings.ts`. Add a `pickIntegerOrNull` helper (missing/`null` → `null`; present → the existing integer validation with a warning). Add `deepgram.maxKeyterms` and `parakeet.maxKeyterms` to the parsers. In `src/runtime.ts` replace `maxTerms: settings.keyterms.maxTerms` with `maxTerms: resolveMaxTerms(settings)`.

- [ ] **Step 4: Run tests**

Run: `bun test src/settings.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts src/settings.test.ts src/runtime.ts
git commit -m "feat: split keyterm budget by backend"
```

---

### Task 14: Silero segmentation and cut planning (pure functions)

**Files:**
- Create: `src/backends/vad.ts`, `src/backends/vad.test.ts`

**Interfaces:**
- Produces:

```ts
// src/backends/vad.ts
export type SpeechSegment = { startSample: number; endSample: number };
export type SpeechSegmentOptions = {
	sampleRate?: number; threshold?: number; negThreshold?: number;
	minSpeechMs?: number; minSilenceMs?: number; speechPadMs?: number;
};
/** Silero's get_speech_timestamps: threshold 0.5, 250 ms min speech, 100 ms min silence, 30 ms pad. */
export function speechSegments(probs: readonly number[], frameSamples: number, options?: SpeechSegmentOptions): SpeechSegment[];
/** Byte offsets of the mid-point of each silence gap, longest gap first. */
export function cutCandidates(segments: readonly SpeechSegment[], frameSamples: number, bytesPerSample: number, totalSamples: number): number[];
/** Greedy one-cut-per-pause plan: longest pause near targetSeconds first, never under minSeconds, hard-cut at maxSeconds. */
export function planCuts(options: {
	candidates: number[]; startBytes: number; capturedBytes: number;
	targetSeconds: number; minSeconds: number; maxSeconds: number; bytesPerSecond: number;
}): number[];
```

- [ ] **Step 1: Write the failing tests** (synthetic probabilities, no model):

```ts
test("finds speech segments with Silero's thresholds", () => {
	// 32 frames of silence, 24 frames of speech (p=0.9), 16 frames of silence.
	const probs = [...Array(32).fill(0.01), ...Array(24).fill(0.9), ...Array(16).fill(0.01)];
	const segments = speechSegments(probs, 512, { sampleRate: 16_000 });
	expect(segments).toHaveLength(1);
	expect(segments[0]!.startSample).toBe(32 * 512 - 480);   // 30 ms pad = 480 samples
});

test("drops segments shorter than minSpeechMs", () => {
	expect(speechSegments([0.9, 0.9, 0.01], 512, { sampleRate: 16_000 })).toEqual([]);
});

test("plans a cut at the pause nearest the target", () => {
	const cuts = planCuts({
		candidates: [14 * 16_000 * 2, 31 * 16_000 * 2],
		startBytes: 0, capturedBytes: 40 * 16_000 * 2,
		targetSeconds: 30, minSeconds: 5, maxSeconds: 40, bytesPerSecond: 16_000 * 2,
	});
	expect(cuts).toEqual([31 * 16_000 * 2]);
});

test("hard-cuts at maxSeconds when there is no pause", () => {
	const cuts = planCuts({
		candidates: [], startBytes: 0, capturedBytes: 90 * 16_000 * 2,
		targetSeconds: 30, minSeconds: 5, maxSeconds: 40, bytesPerSecond: 16_000 * 2,
	});
	expect(cuts).toEqual([40 * 16_000 * 2]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/backends/vad.test.ts`
Expected: FAIL — `Cannot find module "./vad.ts"`.

- [ ] **Step 3: Implement** the three functions by porting `@earendil-works/pi-voice`'s `speechSegments`/`cutCandidates`/`planCuts` (MIT; attribute the source and `cjpais/Handy`'s `SmoothedVad` in the header comment, per `docs/future/2026-10-16-silero-vad-chunking.md`). Smoothing is out of scope for the pure functions: they take probabilities and return offsets.

- [ ] **Step 4: Run tests**

Run: `bun test src/backends/vad.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backends/vad.ts src/backends/vad.test.ts
git commit -m "feat: port silero speech segmentation and cut planning"
```

---

### Task 15: `PauseDetector` + `LevelPauseDetector` (behaviour-preserving refactor)

**Files:**
- Create: `src/backends/pause-detector.ts`, `src/backends/pause-detector.test.ts`
- Modify: `src/backends/parakeet.ts`

**Interfaces:**
- Consumes: `levelFromS16le` from `src/formats.ts`.
- Produces:

```ts
// src/backends/pause-detector.ts
export interface PauseDetector {
	/** Feed the same PCM the batch stream receives. */
	push(pcm: Buffer): void;
	/** Cut offsets in bytes available so far, best first. */
	cuts(capturedBytes: number): number[];
}
export type PauseDetectorOptions = {
	chunkSeconds: number;
	minChunkFraction: number;   // 0.7
	silenceLevel: number | "auto";
	bytesPerSecond: number;     // 32_000
};
export function createLevelPauseDetector(options: PauseDetectorOptions): PauseDetector;
```

- [ ] **Step 1: Write the failing tests**

```ts
test("derives an auto pause threshold from the recording's own levels", () => {
	const detector = createLevelPauseDetector({ chunkSeconds: 15, minChunkFraction: 0.7, silenceLevel: "auto", bytesPerSecond: 32_000 });
	detector.push(pcmOf(0, 32_000));        // quiet
	for (let i = 0; i < 12; i++) detector.push(pcmOf(900, 32_000)); // speech
	detector.push(pcmOf(0, 32_000));        // quiet again
	const cuts = detector.cuts(14 * 32_000);
	expect(cuts).toHaveLength(1);           // the quiet chunk at the end is the pause
	expect(cuts[0]).toBeGreaterThanOrEqual(32_000);
});

test("returns no cut when the level barely varies", () => {
	const detector = createLevelPauseDetector({ chunkSeconds: 15, minChunkFraction: 0.7, silenceLevel: "auto", bytesPerSecond: 32_000 });
	for (let i = 0; i < 20; i++) detector.push(pcmOf(500, 32_000));
	expect(detector.cuts(20 * 32_000)).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/backends/pause-detector.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** `LevelPauseDetector` by moving `ParakeetBatchStream`'s level buffer, `pauseThreshold()` and `cutIfReady()` scan into it. Change `ParakeetBatchStream` to hold a `PauseDetector`, call `detector.push(pcm)` in `feed()` and `detector.cuts(this.bytes)` in `cutIfReady()`. All existing `src/backends/parakeet.test.ts` behaviour must stay green (the heuristic moved, not changed).

- [ ] **Step 4: Run tests**

Run: `bun test src/backends/pause-detector.test.ts src/backends/parakeet.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backends/pause-detector.ts src/backends/pause-detector.test.ts src/backends/parakeet.ts
git commit -m "refactor: extract PauseDetector behind the RMS heuristic"
```

---

### Task 16: `VadPauseDetector`, model provisioning and fallback

**Files:**
- Modify: `src/backends/pause-detector.ts`, `src/backends/pause-detector.test.ts`, `src/backends/parakeet.ts`, `src/backends/parakeet.test.ts`, `src/model-download.ts`, `src/model-download.test.ts`, `src/setup.ts`

**Interfaces:**
- Consumes: `VadSession` shape from `transcribe-cpp` (`model.createVadSession({ nThreads: 1 })`, `vadInfo.frameSamples`, `await vad.streamFeed(frame) → { firstFrame, probs }`, `await vad.streamFlush()`), `speechSegments`/`cutCandidates`/`planCuts` (Task 14).
- Produces: `createVadPauseDetector(session, options): PauseDetector`; `CatalogModel.role?: "asr" | "vad"`; `resolveVadModelPath(): Promise<string | undefined>` in `parakeet.ts` (checks the downloaded catalog dir, then pi-voice's bundled model dir); `ParakeetBackendOptions.vadModelPath?: string | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/backends/pause-detector.test.ts
test("Cuts where the VAD says speech has ended, not where it is merely quiet", async () => {
	// A fake VadSession returns probs [0.01 x 16, 0.99 x 20, 0.01 x 16] from streamFeed.
	// Feed matching PCM; expect a cut at the silence gap, and no cut for a steady
	// quiet buffer (all 0.01 probs) even though the RMS heuristic would cut.
});
```

```ts
// src/backends/parakeet.test.ts
test("falls back to the level detector when no VAD model is available", async () => {
	// resolveVadModelPath returns undefined -> the batch stream still cuts on a pause.
});
```

```ts
// src/model-download.test.ts
test("the picker never offers the VAD model as an ASR model", () => {
	expect(MODEL_CATALOG.filter((m) => (m.role ?? "asr") === "asr").some((m) => m.id === "silero-vad-v6.2")).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/backends/pause-detector.test.ts -t "VAD"`
Expected: FAIL — `createVadPauseDetector` missing.

- [ ] **Step 3: Implement** `VadPauseDetector` (buffer PCM, feed 512-sample frames to the session asynchronously, keep returned probs; `cuts()` runs `speechSegments` + `cutCandidates` + `planCuts` over what has been scored, tolerating probs that lag the buffer). Add the Silero entry to `MODEL_CATALOG` (`role: "vad"`, `streaming: false`), make `isDownloaded`/the setup picker ignore `role === "vad"`, and have `ParakeetBackend.start()` prefer `createVadPauseDetector` when the VAD model resolves and `createVadSession` succeeds, otherwise `createLevelPauseDetector`. Release the VAD session on stream release.

- [ ] **Step 4: Run tests**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backends/pause-detector.ts src/backends/pause-detector.test.ts src/backends/parakeet.ts src/backends/parakeet.test.ts src/model-download.ts src/model-download.test.ts src/setup.ts
git commit -m "feat: use silero VAD for batch cuts with heuristic fallback"
```

---

### Task 17: Stale docs and comments

**Files:**
- Modify: `src/backends/parakeet.ts`, `README.md`

**Interfaces:** none (comments and prose only).

- [ ] **Step 1: Update the stale parakeet header** (`src/backends/parakeet.ts`): the current text says transcribe-cpp's `StreamOptions` "carries no prompt field"; 0.4.0 *does* add `vocabulary`/`prompt`, but the shipped `parakeet-tdt_ctc-110m` reports `supports("vocabulary") === false` / `supports("context_prompt") === false`, so the conclusion (`biasing: "none"`, correction pass) stands. Wording from `docs/future/2026-10-16-silero-vad-chunking.md`.

- [ ] **Step 2: Fix the README "not implemented yet" line** (`README.md:256`, "…but it is not implemented yet" about transcribing after release in batch mode) and add a short "Recording queue" subsection: order by recording start, one capture at a time, refusal when full, queue depth in the status line.

- [ ] **Step 3: Verify**

Run: `bun test && bun run check`
Expected: PASS; no references to the removed claims remain.

- [ ] **Step 4: Commit**

```bash
git add src/backends/parakeet.ts README.md
git commit -m "docs: correct stale batch and biasing notes"
```

---

## Self-review

- **Spec coverage:** backlog E TODO list → `VoiceSession` (T1), `"queued"` + press-while-processing (T2), `seq`/`finished`/order (T2–T3), sequence-aware `EditorSink` + interim suppression (T7), parakeet serialize + refcount (T10), slot-freeing + reap (T4), cap + refuse + notify (T5), queue depth + submitOnStop debounce + deterministic dispose (T6–T8), cut on `begin()` (T9), `idleUnloadMs` (T11), `chunkSeconds` (T12), keyterm caps (T13), Silero VAD (T14–T16), stale comments/README (T17). Queue-order and full-queue decisions are recorded at the top.
- **Type consistency:** `VoiceState` gains `"queued"` in T2 and is consumed by `statusText` in T8; `onFinal`/`onInterim` gain `seq` in T2 and are used by the runtime in T7; `dispose()` becomes `Promise<void>` in T6 and is awaited in `runtime.ts`; `resolveMaxTerms` is defined in T13 and used by `runtime.ts`; `VoiceStream.cut()` is defined in T9 and implemented by `FakeStream` and `ParakeetBatchStream` in the same task.
- **Review Focus mapping:** each of the five lines names a task and a test (T2, T5, T7, T10, T4 respectively).
