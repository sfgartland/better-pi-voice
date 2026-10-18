/**
 * The session state machine, and the reason this extension exists.
 *
 * The reference implementation's quality comes less from the model than from
 * what it does when things go wrong: it retries once before the first
 * transcript, replays the buffered audio when a stream silently drops, salvages
 * a partial transcript when the socket dies mid-flight, promotes an
 * unreported interim to a final, and trips a breaker so a broken microphone
 * fails loudly instead of silently. Those rules are reproduced here.
 *
 * Everything time-dependent goes through an injected clock so the whole thing
 * is testable without sleeping.
 */

import type { Capture } from "./capture.ts";
import { type Clock, systemClock } from "./clock.ts";
import { correctTranscript, type CorrectionMode } from "./keyterms/correct.ts";
import type { KeytermSet } from "./keyterms/index.ts";
import { VoiceSession, type SessionTimer } from "./session.ts";
import type { FinalizeOutcome, VoiceBackend, VoiceEvent, VoiceStream } from "./types.ts";

export type VoiceState = "idle" | "arming" | "recording" | "processing" | "queued" | "paused";

export type ControllerTimings = {
	/** Hold mode: if no auto-repeat arrives in this window, arm the release timer. */
	holdRepeatFallbackMs: number;
	/** Hold mode: finish this long after the last repeat or key release. */
	releaseDebounceMs: number;
	/** Tap mode: finish after this much silence. */
	tapSilenceMs: number;
	/** Hard cap on one session, in both modes, so a stuck key cannot hold the mic open. */
	maxSessionMs: number;
	/** Delay before the single early retry. */
	earlyRetryDelayMs: number;
	breakerWindowMs: number;
	breakerThreshold: number;
	/** How much audio to retain for a possible replay. */
	maxBufferedAudioMs: number;
	/** Recordings that may be queued for transcription before a new press is refused. */
	maxQueuedJobs: number;
	/** Total retained queued audio before a new press is refused. */
	maxQueuedAudioBytes: number;
	/** A job that has not settled in this long is abandoned so the queue advances. */
	jobReapMs: number;
	/** How long `dispose()` waits for in-flight jobs before abandoning them. */
	disposeGraceMs: number;
};

export const DEFAULT_TIMINGS: ControllerTimings = {
	holdRepeatFallbackMs: 600,
	releaseDebounceMs: 200,
	tapSilenceMs: 15_000,
	maxSessionMs: 120_000,
	earlyRetryDelayMs: 250,
	breakerWindowMs: 10_000,
	breakerThreshold: 3,
	maxBufferedAudioMs: 120_000,
	maxQueuedJobs: 4,
	maxQueuedAudioBytes: 8 * 1024 * 1024,
	jobReapMs: 30_000,
	disposeGraceMs: 5_000,
};

export type ControllerHooks = {
	onState?(state: VoiceState): void;
	/** Live text, including the accumulated final text, tagged with its recording. */
	onInterim?(text: string, seq: number): void;
	/** Committed text for one recording, once, tagged with its recording. */
	onFinal?(text: string, seq: number): void;
	onLevel?(levels: number[]): void;
	onError?(message: string, code: string): void;
	/** A non-error message for the user, such as a refused recording. */
	onNotice?(message: string, level: "info" | "warning" | "error"): void;
	/** Every recording started so far has been emitted. */
	onQueueDrained?(): void;
	onDebug?(message: string): void;
};

export type ControllerDeps = {
	backend: VoiceBackend;
	capture: Capture;
	mode: "hold" | "tap";
	language: string;
	correction: CorrectionMode;
	keyterms: () => Promise<KeytermSet>;
	clock?: Clock | undefined;
	timings?: Partial<ControllerTimings> | undefined;
	hooks?: ControllerHooks | undefined;
};

/**
 * Controller invariants (keep these true):
 *
 * 1. `seq` is assigned from a monotonically increasing `nextSeq` in `begin()`;
 *    one recording = one seq; seqs are contiguous.
 * 2. `active` is at most one session. `jobs` holds finished-recording sessions
 *    that have not stored a result, ordered by `seq` ascending.
 * 3. Every job eventually stores a result, including `""` (`finished.set`),
 *    even on error, timeout or an empty transcript.
 * 4. `finished` only holds seqs `>= nextToEmit`; `emitReady()` loops
 *    `while (finished.has(nextToEmit))`, emits non-empty text via
 *    `onFinal(text, seq)` and increments. Because seqs are contiguous and every
 *    job stores, the loop always terminates and never deadlocks.
 * 5. `queueDepth = jobs.length + finished.size` (recordings started, not yet
 *    emitted).
 * 6. Derived state: `active` -> `active.phase`; else paused (breaker open) ->
 *    `"paused"`; else `queueDepth === 0` -> `"idle"`; `=== 1` -> `"processing"`;
 *    `>= 2` -> `"queued"`.
 * 7. `press()` is allowed from `idle`, `processing` and `queued` (any state with
 *    no active session); while an active session exists it keeps today's
 *    hold/tap semantics for that session.
 */
export class VoiceController {
	private state: VoiceState = "idle";
	/** Guard for the async gap in `begin()`, so two presses open one capture. */
	private starting = false;
	/** Set once `dispose()` has drained; nothing may start or emit afterwards. */
	private disposed = false;
	private nextSeq = 0;
	private nextToEmit = 0;
	/** Finished recordings, oldest first, whose result is not stored yet. */
	private readonly jobs: VoiceSession[] = [];
	/** Results waiting for their turn to be emitted, by seq. */
	private readonly finished = new Map<number, string>();
	private readonly inflight = new Set<Promise<void>>();
	private active: VoiceSession | undefined;
	private readonly timings: ControllerTimings;
	private readonly clock: Clock;
	private failureTimes: number[] = [];
	private failureHint: string | undefined;

	constructor(private readonly deps: ControllerDeps) {
		this.clock = deps.clock ?? systemClock;
		this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
	}

	get currentState(): VoiceState {
		return this.state;
	}

	/** Recordings started but not yet emitted. */
	get queueDepth(): number {
		return this.jobs.length + this.finished.size;
	}

	/** Hold mode: key press. Tap mode: toggles. */
	press(): void {
		if (this.disposed || this.currentState === "paused") return;

		if (this.deps.mode === "tap") {
			if (this.active) {
				if (this.active.phase === "recording") this.finish(this.active);
				return;
			}
			if (this.starting) return;
			if (!this.canAccept()) {
				this.notifyQueueFull();
				return;
			}
			void this.begin();
			return;
		}

		// Hold mode: an existing session keeps today's hold semantics.
		if (this.active) {
			if (this.active.phase === "recording") this.onHoldProgress(this.active);
			return;
		}
		if (this.starting) return;
		if (!this.canAccept()) {
			// Refuse before arming the hold fallback: a refused press must leave no
			// timer behind that could later finish somebody else's session.
			this.notifyQueueFull();
			return;
		}
		void this.begin();
		// `begin()` sets `this.active` synchronously; the cast defeats the
		// control-flow narrowing from the `if (this.active)` above.
		const session = this.active as VoiceSession | undefined;
		if (!session) return;
		this.arm(session, "fallback", this.timings.holdRepeatFallbackMs, () => {
			// Some terminals never send auto-repeat for a held key. Without a
			// release signal the mic would stay open, so fall back to the
			// release timer.
			if (session.phase === "recording") {
				this.debug("hold: no auto-repeat seen, arming release timer");
				this.armRelease(session);
			}
		});
	}

	/** Whether another recording may be queued right now. */
	private canAccept(): boolean {
		return (
			this.jobs.length < this.timings.maxQueuedJobs && this.queuedAudioBytes() < this.timings.maxQueuedAudioBytes
		);
	}

	private queuedAudioBytes(): number {
		let total = 0;
		for (const job of this.jobs) total += job.audio.byteLength;
		return total;
	}

	private queueFullMessage(): string {
		return `Voice queue is full (${String(this.queueDepth)} recordings waiting). Wait for transcription to catch up.`;
	}

	private notifyQueueFull(): void {
		this.deps.hooks?.onNotice?.(this.queueFullMessage(), "warning");
	}

	/** Hold mode: repeated key events from auto-repeat. */
	repeat(): void {
		const session = this.active;
		if (this.deps.mode !== "hold" || !session || session.phase !== "recording") return;
		this.onHoldProgress(session);
	}

	/** Hold mode: key release, where the terminal reports it. */
	release(): void {
		const session = this.active;
		if (this.deps.mode !== "hold" || !session || session.phase !== "recording") return;
		this.armRelease(session);
	}

	/** Discard the session without submitting anything. */
	cancel(): void {
		const session = this.active;
		if (!session) return;
		this.debug("cancelled");
		this.endSession(session);
		// The seq was consumed, so it must still resolve ("") or `nextToEmit`
		// would wait forever for a recording that will never emit.
		this.store(session, "");
		this.refreshState();
	}

	/**
	 * Stop making noise and settle every outstanding recording. The contract:
	 * (1) stop the active capture; (2) wait up to `disposeGraceMs` for in-flight
	 * jobs; (3) store `""` for anything still unsettled, then emit whatever did
	 * arrive; (4) leave the breaker closed so the state is `idle`, never
	 * `paused`; (5) never emit again once this resolves.
	 */
	async dispose(): Promise<void> {
		this.disposed = true;
		const active = this.active;
		if (active && active.phase === "recording") this.finish(active);
		if (this.active) {
			// Still arming: no recording to finalize, so abandon it and resolve its
			// seq immediately.
			this.endSession(this.active);
			this.store(this.active, "");
		}

		if (this.inflight.size > 0) {
			await Promise.race([Promise.allSettled([...this.inflight]), this.disposeGraceTimer()]);
		}

		for (const job of [...this.jobs]) {
			this.endSession(job);
			this.store(job, this.finalText(job));
		}

		// Shutdown is not a failure: close the breaker so the derived state is
		// `idle`, not `paused`.
		this.failureTimes = [];
		this.failureHint = undefined;
		this.emitReady();
		this.refreshState();
	}

	private disposeGraceTimer(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.clock.setTimeout(() => resolve(), this.timings.disposeGraceMs);
		});
	}

	// --- session lifecycle -------------------------------------------------

	private async begin(): Promise<void> {
		if (this.disposed || this.starting) return;
		// A new recording is starting: any queued batch tail should start decoding
		// now rather than waiting for more audio that may never come.
		for (const job of this.jobs) {
			try {
				job.stream?.cut?.();
			} catch {
				// A closed stream is allowed to refuse.
			}
		}
		this.starting = true;
		const session = new VoiceSession({
			seq: this.nextSeq++,
			maxBufferedAudioMs: this.timings.maxBufferedAudioMs,
			clock: this.clock,
		});
		this.active = session;
		try {
			const availability = await this.deps.capture.checkAvailability();
			if (session.abandoned) return;
			if (!availability.available) {
				this.fail(session, availability.reason ?? "Audio recording is not available.", "capture_unavailable");
				return;
			}

			session.phase = "arming";
			this.refreshState();
			const started = await this.deps.capture.start(
				(chunk) => this.onData(chunk, session),
				() => this.onCaptureEnded(session),
			);
			if (session.abandoned) {
				if (started.ok) started.session.stop();
				return;
			}
			if (!started.ok) {
				this.fail(session, started.reason, "capture_failed", { recordFailure: true });
				return;
			}

			session.captureSession = started.session;
			session.startedAt = this.clock.now();
			session.phase = "recording";
			this.refreshState();
			this.arm(session, "max", this.timings.maxSessionMs, () => {
				this.debug("session hit the maximum duration");
				this.finish(session);
			});
			this.armSilenceTimer(session);

			const stream = await this.openStream(session);
			if (session.abandoned) return;
			if (!stream) {
				// Ask the backend why, so a local setup says "no model" rather than
				// "could not connect".
				const availability = await this.deps.backend
					.checkAvailability()
					.catch(() => ({ available: true, reason: undefined as string | undefined }));
				if (session.abandoned) return;
				this.fail(session, availability.reason ?? "Could not connect to the voice service.", "connect_failed", {
					recordFailure: true,
				});
				return;
			}
			this.flushUnsentAudio(session);
		} finally {
			this.starting = false;
		}
	}

	private async openStream(session: VoiceSession): Promise<VoiceStream | undefined> {
		let set: KeytermSet = { bias: [], correct: [], truncated: false };
		try {
			set = await this.deps.keyterms();
		} catch (error) {
			this.debug(`keyterm mining failed: ${String(error)}`);
		}
		if (session.abandoned) return undefined;
		session.correctionTerms = set.correct;

		const stream = await this.deps.backend.start(
			{ language: this.deps.language, keyterms: set.bias, signal: new AbortController().signal },
			(event) => this.onEvent(event, session),
		);
		if (!stream) return undefined;
		session.stream = stream;
		// Never clear a flag set by an earlier connection in this session.
		session.streamWasConnected ||= stream.isConnected();
		return stream;
	}

	private finish(session: VoiceSession | undefined): void {
		if (!session || session.phase !== "recording") return;
		session.clearTimers();
		session.captureSession?.stop();
		session.captureSession = undefined;
		session.phase = "processing";
		this.jobs.push(session);
		if (this.active === session) this.active = undefined;
		this.refreshState();
		this.track(this.processJob(session));
	}

	private track(promise: Promise<void>): void {
		this.inflight.add(promise);
		void promise.finally(() => {
			this.inflight.delete(promise);
		});
	}

	private async processJob(session: VoiceSession): Promise<void> {
		// A job that never settles (a hung backend) must not stall the queue
		// forever, so it is reaped after `jobReapMs` and stores whatever it has.
		this.armReap(session);
		try {
			await this.process(session);
		} catch (error) {
			this.debug(`job failed: ${String(error)}`);
		} finally {
			try {
				session.stream?.close();
			} catch {
				// Already closed is fine.
			}
			session.stream = undefined;
			this.store(session, this.finalText(session));
		}
	}

	private armReap(session: VoiceSession): void {
		this.arm(session, "reap", this.timings.jobReapMs, () => {
			if (session.stored) return;
			this.debug(`job reaped after ${this.timings.jobReapMs}ms`);
			try {
				session.stream?.close();
			} catch {
				// Already closed is fine.
			}
			session.stream = undefined;
			this.store(session, this.finalText(session));
		});
	}

	private async process(session: VoiceSession): Promise<void> {
		// Flush the coalescer tail so the final words are not stranded in a
		// partial frame.
		this.flushTail(session);

		const outcome = await this.finalizeStream(session);
		if (session.abandoned) return;

		// The stream died without confirming what it had. We still hold the audio,
		// so replay it once on a fresh connection rather than losing the utterance.
		if (!session.transcript.trim() && this.isUnconfirmed(outcome) && this.canReplay(session)) {
			this.debug(`stream unconfirmed (${outcome}); replaying buffered audio`);
			session.replayed = true;
			if (await this.replayBuffer(session)) {
				if (session.abandoned) return;
				return;
			}
			if (session.abandoned) return;
		}

		// No endpoint ever arrived, so the last thing we heard exists only as an
		// interim. A slightly provisional word beats a silently dropped sentence.
		this.promoteInterim(session);
		await this.reportEmpty(session);
	}

	private async finalizeStream(session: VoiceSession): Promise<FinalizeOutcome> {
		const stream = session.stream;
		if (!stream) return "already_closed";
		this.noteConnected(session);
		try {
			return await stream.finalize();
		} catch (error) {
			this.debug(`finalize failed: ${String(error)}`);
			return "timeout";
		} finally {
			// The socket may have finished connecting while finalize was waiting; that
			// still counts for the replay decision.
			this.noteConnected(session);
		}
	}

	/**
	 * Re-feed the retained audio into a brand-new stream. The old stream is
	 * closed first so its finalize cannot race this one.
	 */
	private async replayBuffer(session: VoiceSession): Promise<boolean> {
		const audio = session.audio.all();
		if (!audio) return false;
		try {
			session.stream?.close();
		} catch {
			// Closing a dead socket is allowed to fail.
		}
		session.stream = undefined;

		const stream = await this.openStream(session);
		if (session.abandoned || !stream) return false;

		session.transcript = "";
		session.pendingInterim = "";
		session.sawTranscript = false;
		this.feedBuffer(session, stream, audio);
		session.audio.markAllSent();
		this.flushTail(session);

		const outcome = await this.finalizeStream(session);
		if (session.abandoned) return false;
		this.debug(`replay finished with ${outcome}`);
		return session.transcript.trim().length > 0;
	}

	/** Record that the stream reached OPEN at least once, for replay decisions. */
	private noteConnected(session: VoiceSession): void {
		if (!session.streamWasConnected && session.stream?.isConnected()) session.streamWasConnected = true;
	}

	private isUnconfirmed(outcome: FinalizeOutcome): boolean {
		return outcome === "timeout" || outcome === "closed_early";
	}

	private canReplay(session: VoiceSession): boolean {
		return (
			!session.replayed &&
			session.hadAudioSignal &&
			session.streamWasConnected &&
			session.audio.byteLength > 0 &&
			!session.audio.truncated
		);
	}

	/** Store a recording's result (possibly empty) and emit everything now in order. */
	private store(session: VoiceSession, text: string): void {
		if (session.stored) return;
		session.stored = true;
		session.abandoned = true;
		this.clearTimer(session, "reap");
		const index = this.jobs.indexOf(session);
		if (index >= 0) this.jobs.splice(index, 1);
		this.finished.set(session.seq, text);
		session.audio.clear();
		this.emitReady();
		// The last recording has been emitted: the runtime uses this to submit once
		// per drained queue. Never during shutdown, which is not a "drain".
		if (!this.disposed && this.queueDepth === 0) this.deps.hooks?.onQueueDrained?.();
		this.refreshState();
	}

	/** Emit contiguous results in recording-start order; `""` advances without emitting. */
	private emitReady(): void {
		while (this.finished.has(this.nextToEmit)) {
			const text = this.finished.get(this.nextToEmit) ?? "";
			this.finished.delete(this.nextToEmit);
			if (text) this.deps.hooks?.onFinal?.(text, this.nextToEmit);
			this.nextToEmit++;
		}
	}

	/** Correct and trim a recording's transcript, ready to store. */
	private finalText(session: VoiceSession): string {
		let text = session.transcript.trim();
		if (!text) return "";
		if (this.deps.backend.capabilities.biasing === "none" && this.deps.correction !== "off") {
			const result = correctTranscript(text, session.correctionTerms, this.deps.correction);
			for (const change of result.changes) {
				this.debug(`correction: ${change.from} -> ${change.to}`);
			}
			text = result.text;
		}
		if (session.sawTranscript) this.clearFailures();
		return text;
	}

	private endSession(session: VoiceSession): void {
		session.abandoned = true;
		session.release();
		session.audio.clear();
		session.coalescer.flush();
		if (this.active === session) this.active = undefined;
	}

	// --- audio -------------------------------------------------------------

	private onData(chunk: Buffer, session: VoiceSession): void {
		if (session.abandoned) return;
		this.noteConnected(session);

		const stream = session.stream;
		if (!stream) {
			// Audio that arrives before the backend is ready is retained whole (for
			// the later flush/replay) rather than coalesced, so it is not sent
			// twice when the stream finally opens.
			session.record(chunk);
			this.deps.hooks?.onLevel?.(session.levels.snapshot());
			return;
		}

		const frames = session.pushChunk(chunk);
		this.deps.hooks?.onLevel?.(session.levels.snapshot());
		for (const frame of frames) this.feed(stream, frame);
	}

	private flushUnsentAudio(session: VoiceSession): void {
		const stream = session.stream;
		if (!stream || session.abandoned) return;
		const unsent = session.audio.unsent();
		if (!unsent) return;
		// Everything captured before the backend was ready is already complete
		// audio, not a frame in progress, so send it now rather than holding it
		// for the next live chunk to top up the coalescer.
		this.feedBuffer(session, stream, unsent);
		session.audio.markAllSent();
	}

	private flushTail(session: VoiceSession): void {
		const stream = session.stream;
		if (!stream || session.abandoned) return;
		const tail = session.flushTail();
		if (tail) this.feed(stream, tail);
	}

	private feedBuffer(session: VoiceSession, stream: VoiceStream, buffer: Buffer): void {
		// A whole-buffer send (replay, retry) is a complete body of audio, not a
		// live stream mid-utterance, so `pushBuffer` flushes the partial tail too.
		for (const frame of session.pushBuffer(buffer)) this.feed(stream, frame);
	}

	private feedPending = 0;

	private feed(stream: VoiceStream, frame: Buffer): void {
		try {
			const result = stream.feed(frame);
			if (result && typeof (result as Promise<void>).catch === "function") {
				this.feedPending++;
				if (this.feedPending > 4) {
					this.debug(`feed backlog is ${String(this.feedPending)} frames; transcription is falling behind`);
				}
				void (result as Promise<void>)
					.catch((error: unknown) => {
						this.debug(`feed rejected: ${String(error)}`);
					})
					.finally(() => {
						this.feedPending--;
					});
			}
		} catch (error) {
			// The stream may have closed between the check and the write. Dropping
			// one frame is better than tearing the session down.
			this.debug(`feed threw: ${String(error)}`);
		}
	}

	private onCaptureEnded(session: VoiceSession): void {
		if (session.abandoned || session.phase !== "recording") return;
		if (!session.hadAudioSignal) this.recordFailure();
		this.debug("capture ended on its own");
		this.finish(session);
	}

	// --- backend events ----------------------------------------------------

	private onEvent(event: VoiceEvent, session: VoiceSession): void {
		if (session.abandoned) return;
		// Any transcript means the socket was genuinely connected; the replay path
		// needs to know that even after the connection later drops.
		if (event.type === "interim" || event.type === "final") session.streamWasConnected = true;

			switch (event.type) {
			case "interim": {
				if (session.phase !== "recording" && session.phase !== "arming") return;
				session.pendingInterim = event.text;
				if (this.interimVisible(session)) {
					this.deps.hooks?.onInterim?.(this.composeInterim(session, event.text), session.seq);
				}
				this.armSilenceTimer(session);
				return;
			}
			case "final": {
				const text = event.text.trim();
				session.pendingInterim = "";
				if (!text) return;
				session.sawTranscript = true;
				session.transcript = session.transcript ? `${session.transcript} ${text}` : text;
				if (this.interimVisible(session)) {
					this.deps.hooks?.onInterim?.(session.transcript, session.seq);
				}
				this.armSilenceTimer(session);
				return;
			}
			case "error": {
				this.onStreamError(event, session);
				return;
			}
		}
	}

	/**
	 * Interim text is only shown for the live recording and only when nothing
	 * else is still transcribing: a queue of older text must not be overwritten
	 * by a newer recording's tentative words.
	 */
	private interimVisible(session: VoiceSession): boolean {
		return this.queueDepth === 0 && this.active === session;
	}

	/** Interim text is rendered after whatever has already been committed. */
	private composeInterim(session: VoiceSession, text: string): string {
		return session.transcript ? `${session.transcript} ${text}` : text;
	}

	/**
	 * Commit an interim that never got a final, because the connection ended
	 * before the server confirmed the utterance.
	 */
	private promoteInterim(session: VoiceSession): void {
		const text = session.pendingInterim.trim();
		session.pendingInterim = "";
		if (!text) return;
		this.debug("promoting unreported interim to final");
		session.transcript = session.transcript ? `${session.transcript} ${text}` : text;
	}

	private onStreamError(event: { message: string; fatal?: boolean; code?: string }, session: VoiceSession): void {
		this.debug(`stream error: ${event.message}`);
		if (session.abandoned || session.phase !== "recording") return;

		// An error before the first transcript is worth one silent retry, because
		// it is usually a transient connect or upgrade failure.
		if (!session.sawTranscript && !session.retried) {
			session.retried = true;
			this.debug("early stream error; retrying once");
			this.arm(session, "retry", this.timings.earlyRetryDelayMs, () => {
				if (session.abandoned || session.phase !== "recording") return;
				void this.retryStream(session);
			});
			return;
		}

		this.recordFailure();
		// Whatever was already transcribed is real speech. Salvage it rather than
		// throwing away a whole utterance because the socket died at the end.
		this.promoteInterim(session);
		if (session.transcript.trim()) {
			this.debug("salvaging partial transcript before reporting the error");
			this.store(session, this.finalText(session));
		}
		this.fail(session, event.message, event.code ?? "stream_error");
	}

	private async retryStream(session: VoiceSession): Promise<void> {
		try {
			session.stream?.close();
		} catch {
			// ignore
		}
		session.stream = undefined;
		const stream = await this.openStream(session);
		if (session.abandoned) return;
		if (!stream) {
			this.fail(session, "Could not reconnect to the voice service.", "connect_failed", { recordFailure: true });
			return;
		}
		// A fresh stream has received nothing, so it needs the whole session. The
		// coalescer may still hold an un-flushed tail that `audio.all()` already
		// includes, so drop it first rather than sending that tail twice, out of order.
		session.coalescer.flush();
		const audio = session.audio.all();
		if (audio) this.feedBuffer(session, stream, audio);
		session.audio.markAllSent();
	}

	// --- output ------------------------------------------------------------

	/**
	 * Nothing was transcribed. Say why, specifically: "no audio" and "no
	 * network" and "you said nothing" need different fixes.
	 */
	private async reportEmpty(session: VoiceSession): Promise<void> {
		if (session.abandoned || session.transcript.trim().length > 0) return;
		if (this.clock.now() - session.startedAt < 2000) return;

		if (!session.hadAudioSignal) {
			this.deps.hooks?.onError?.(
				"No audio detected from the microphone. Check that the right input device is selected and that pi has microphone access.",
				"no_audio_signal",
			);
			return;
		}
		if (!session.streamWasConnected) {
			const why = await this.explainConnectionFailure();
			if (session.abandoned || this.disposed) return;
			this.deps.hooks?.onError?.(
				`Voice connection failed.${why ? ` ${why}.` : " Check your network and try again."}`,
				"connection_failed",
			);
			return;
		}
		this.deps.hooks?.onError?.("No speech detected.", "no_speech");
	}

	/**
	 * Ask the backend what went wrong. Reported instead of a bare "check your
	 * network", which is unactionable when the real cause is a rejected key.
	 */
	private async explainConnectionFailure(): Promise<string> {
		const probe = this.deps.backend.probe;
		if (!probe) return "";
		try {
			const detail = (await probe()).trim();
			if (!detail) return "";
			this.debug(`probe: ${detail}`);
			return detail.replace(/\.$/, "");
		} catch {
			return "";
		}
	}

	// --- failures and breaker ---------------------------------------------

	private fail(
		session: VoiceSession,
		message: string,
		code: string,
		options: { recordFailure?: boolean } = {},
	): void {
		if (options.recordFailure) this.recordFailure();
		this.endSession(session);
		// A failed recording still consumed its seq; store "" so later recordings
		// can still be emitted in recording order.
		this.store(session, "");
		this.deps.hooks?.onError?.(message, code);
		this.refreshState();
	}

	private recordFailure(hint?: string): void {
		const now = this.clock.now();
		this.failureTimes = this.failureTimes.filter((at) => now - at <= this.timings.breakerWindowMs);
		this.failureTimes.push(now);
		if (hint) this.failureHint = hint;

		if (this.failureTimes.length >= this.timings.breakerThreshold) {
			this.debug(`circuit breaker open (${this.failureTimes.length} failures in ${this.timings.breakerWindowMs}ms)`);
		}
	}

	private clearFailures(): void {
		this.failureTimes = [];
		this.failureHint = undefined;
	}

	get breakerHint(): string | undefined {
		return this.failureHint;
	}

	// --- derived state -----------------------------------------------------

	private deriveState(): VoiceState {
		if (this.active) return this.active.phase;
		if (this.failureTimes.length >= this.timings.breakerThreshold) return "paused";
		const depth = this.queueDepth;
		if (depth === 0) return "idle";
		if (depth === 1) return "processing";
		return "queued";
	}

	private refreshState(): void {
		const next = this.deriveState();
		if (this.state === next) return;
		this.state = next;
		this.deps.hooks?.onState?.(next);
	}

	// --- timers ------------------------------------------------------------

	private armSilenceTimer(session: VoiceSession): void {
		if (this.deps.mode !== "tap") return;
		this.arm(session, "silence", this.timings.tapSilenceMs, () => {
			if (session.phase === "recording") this.finish(session);
		});
	}

	private armRelease(session: VoiceSession | undefined): void {
		if (!session) return;
		this.arm(session, "release", this.timings.releaseDebounceMs, () => {
			if (session.phase === "recording") this.finish(session);
		});
	}

	/** Auto-repeat observed: cancel the fallback and re-arm the release debounce. */
	private onHoldProgress(session: VoiceSession | undefined): void {
		if (!session) return;
		this.clearTimer(session, "fallback");
		this.armRelease(session);
	}

	private arm(session: VoiceSession, name: SessionTimer, ms: number, callback: () => void): void {
		this.clearTimer(session, name);
		session.timers[name] = this.clock.setTimeout(() => {
			session.timers[name] = undefined;
			callback();
		}, ms);
	}

	private clearTimer(session: VoiceSession, name: SessionTimer): void {
		const handle = session.timers[name];
		if (!handle) return;
		this.clock.clearTimeout(handle);
		session.timers[name] = undefined;
	}

	private debug(message: string): void {
		this.deps.hooks?.onDebug?.(message);
	}
}
