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

import type { Capture, CaptureSession } from "./capture.ts";
import { type Clock, systemClock, type TimerHandle } from "./clock.ts";
import { AUDIO_SIGNAL_THRESHOLD, AudioRecorder, FrameCoalescer, LevelRing, levelFromS16le } from "./formats.ts";
import { type CorrectionMode, correctTranscript } from "./keyterms/correct.ts";
import type { KeytermSet } from "./keyterms/index.ts";
import type { FinalizeOutcome, VoiceBackend, VoiceEvent, VoiceStream } from "./types.ts";

export type VoiceState = "idle" | "arming" | "recording" | "processing" | "paused";

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
};

/** 16 kHz mono s16le = 32 bytes per millisecond. */
const BYTES_PER_MS = 32;

export type ControllerHooks = {
	onState?(state: VoiceState): void;
	/** Live text, including the accumulated final text. */
	onInterim?(text: string): void;
	/** Committed text for this session, once. */
	onFinal?(text: string): void;
	onLevel?(levels: number[]): void;
	onError?(message: string, code: string): void;
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

type TimerName = "retry" | "fallback" | "release" | "silence" | "max";

export class VoiceController {
	private state: VoiceState = "idle";
	/** Bumped on every session boundary; stale async work compares against it. */
	private generation = 0;
	private stream: VoiceStream | undefined;
	private captureSession: CaptureSession | undefined;
	private readonly coalescer = new FrameCoalescer();
	private readonly levels = new LevelRing();
	private readonly audio: AudioRecorder;
	private readonly timings: ControllerTimings;
	private readonly clock: Clock;
	private readonly timers: Partial<Record<TimerName, TimerHandle>> = {};

	private transcript = "";
	/** Latest interim that no final has superseded yet. */
	private pendingInterim = "";
	/** Vocabulary the correction pass may repair toward (no seed jargon). */
	private correctionTerms: string[] = [];
	private hadAudioSignal = false;
	private sawTranscript = false;
	private streamWasConnected = false;
	private retried = false;
	private replayed = false;
	private failureTimes: number[] = [];
	private failureHint: string | undefined;
	private sessionStartedAt = 0;

	constructor(private readonly deps: ControllerDeps) {
		this.clock = deps.clock ?? systemClock;
		this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
		this.audio = new AudioRecorder(this.timings.maxBufferedAudioMs * BYTES_PER_MS);
	}

	get currentState(): VoiceState {
		return this.state;
	}

	/** Hold mode: key press. Tap mode: toggles. */
	press(): void {
		if (this.state === "paused") return;

		if (this.deps.mode === "tap") {
			if (this.state === "idle") void this.begin();
			else if (this.state === "recording") this.finish();
			return;
		}

		if (this.state === "idle") {
			void this.begin();
			this.arm("fallback", this.timings.holdRepeatFallbackMs, () => {
				// Some terminals never send auto-repeat for a held key. Without a
				// release signal the mic would stay open, so fall back to the
				// release timer.
				if (this.state === "recording") {
					this.debug("hold: no auto-repeat seen, arming release timer");
					this.armRelease();
				}
			});
			return;
		}

		if (this.state === "recording") this.onHoldProgress();
	}

	/** Hold mode: repeated key events from auto-repeat. */
	repeat(): void {
		if (this.deps.mode !== "hold" || this.state !== "recording") return;
		this.onHoldProgress();
	}

	/** Hold mode: key release, where the terminal reports it. */
	release(): void {
		if (this.deps.mode !== "hold" || this.state !== "recording") return;
		this.armRelease();
	}

	/** Discard the session without submitting anything. */
	cancel(): void {
		if (this.state === "idle") {
			// A begin() may be in flight without having changed the state yet, so idle
			// does not mean there is nothing to cancel: invalidate it.
			this.generation++;
			return;
		}
		this.debug("cancelled");
		this.generation++;
		this.endSession();
		this.setState("idle");
	}

	dispose(): void {
		this.endSession();
		this.generation++;
		this.setState("idle");
	}

	// --- session lifecycle -------------------------------------------------

	private async begin(): Promise<void> {
		const generation = ++this.generation;
		this.resetSession();

		const availability = await this.deps.capture.checkAvailability();
		if (generation !== this.generation) return;
		if (!availability.available) {
			this.fail(availability.reason ?? "Audio recording is not available.", "capture_unavailable");
			return;
		}

		this.setState("arming");
		const started = await this.deps.capture.start(
			(chunk) => this.onData(chunk, generation),
			() => this.onCaptureEnded(generation),
		);
		if (generation !== this.generation) {
			if (started.ok) started.session.stop();
			return;
		}
		if (!started.ok) {
			this.fail(started.reason, "capture_failed", { recordFailure: true });
			return;
		}

		this.captureSession = started.session;
		this.sessionStartedAt = this.clock.now();
		this.setState("recording");
		this.arm("max", this.timings.maxSessionMs, () => {
			this.debug("session hit the maximum duration");
			this.finish();
		});
		this.armSilenceTimer();

		const stream = await this.openStream(generation);
		if (generation !== this.generation) return;
		if (!stream) {
			// Ask the backend why, so a local setup says "no model" rather than
			// "could not connect".
			const availability = await this.deps.backend
				.checkAvailability()
				.catch(() => ({ available: true, reason: undefined as string | undefined }));
			if (generation !== this.generation) return;
			this.fail(availability.reason ?? "Could not connect to the voice service.", "connect_failed", {
				recordFailure: true,
			});
			return;
		}
		this.flushUnsentAudio(generation);
	}

	private async openStream(generation: number): Promise<VoiceStream | undefined> {
		let set: KeytermSet = { bias: [], correct: [], truncated: false };
		try {
			set = await this.deps.keyterms();
		} catch (error) {
			this.debug(`keyterm mining failed: ${String(error)}`);
		}
		if (generation !== this.generation) return undefined;
		this.correctionTerms = set.correct;

		const stream = await this.deps.backend.start(
			{ language: this.deps.language, keyterms: set.bias, signal: new AbortController().signal },
			(event) => this.onEvent(event, generation),
		);
		if (!stream) return undefined;
		this.stream = stream;
		// Never clear a flag set by an earlier connection in this session.
		this.streamWasConnected ||= stream.isConnected();
		return stream;
	}

	private finish(): void {
		if (this.state !== "recording") return;
		this.clearSessionTimers();
		this.captureSession?.stop();
		this.captureSession = undefined;
		this.setState("processing");
		const generation = this.generation;
		void this.process(generation);
	}

	private async process(generation: number): Promise<void> {
		// Flush the coalescer tail so the final words are not stranded in a
		// partial frame.
		this.flushTail(generation);

		const outcome = await this.finalizeStream();
		if (generation !== this.generation) return;

		// The stream died without confirming what it had. We still hold the audio,
		// so replay it once on a fresh connection rather than losing the utterance.
		if (!this.transcript.trim() && this.isUnconfirmed(outcome) && this.canReplay()) {
			this.debug(`stream unconfirmed (${outcome}); replaying buffered audio`);
			this.replayed = true;
			if (await this.replayBuffer(generation)) {
				if (generation !== this.generation) return;
				this.emitTranscript();
				this.finishSession();
				return;
			}
			if (generation !== this.generation) return;
		}

		// No endpoint ever arrived, so the last thing we heard exists only as an
		// interim. A slightly provisional word beats a silently dropped sentence.
		this.promoteInterim();
		this.emitTranscript();
		await this.reportEmpty();
		this.finishSession();
	}

	private async finalizeStream(): Promise<FinalizeOutcome> {
		const stream = this.stream;
		if (!stream) return "already_closed";
		this.noteConnected();
		try {
			return await stream.finalize();
		} catch (error) {
			this.debug(`finalize failed: ${String(error)}`);
			return "timeout";
		} finally {
			// The socket may have finished connecting while finalize was waiting; that
			// still counts for the replay decision.
			this.noteConnected();
		}
	}

	/**
	 * Re-feed the retained audio into a brand-new stream. The old stream is
	 * closed first so its finalize cannot race this one.
	 */
	private async replayBuffer(generation: number): Promise<boolean> {
		const audio = this.audio.all();
		if (!audio) return false;
		try {
			this.stream?.close();
		} catch {
			// Closing a dead socket is allowed to fail.
		}
		this.stream = undefined;

		const stream = await this.openStream(generation);
		if (generation !== this.generation || !stream) return false;

		this.transcript = "";
		this.pendingInterim = "";
		this.sawTranscript = false;
		this.feedBuffer(stream, audio);
		this.audio.markAllSent();
		this.flushTail(generation);

		const outcome = await this.finalizeStream();
		if (generation !== this.generation) return false;
		this.debug(`replay finished with ${outcome}`);
		return this.transcript.trim().length > 0;
	}

	/** Record that the stream reached OPEN at least once, for replay decisions. */
	private noteConnected(): void {
		if (!this.streamWasConnected && this.stream?.isConnected()) this.streamWasConnected = true;
	}

	private isUnconfirmed(outcome: FinalizeOutcome): boolean {
		return outcome === "timeout" || outcome === "closed_early";
	}

	private canReplay(): boolean {
		return (
			!this.replayed &&
			this.hadAudioSignal &&
			this.streamWasConnected &&
			this.audio.byteLength > 0 &&
			!this.audio.truncated
		);
	}

	private finishSession(): void {
		this.stream?.close();
		this.stream = undefined;
		this.audio.clear();
		this.setState(this.failureTimes.length >= this.timings.breakerThreshold ? "paused" : "idle");
	}

	private endSession(): void {
		this.clearSessionTimers();
		this.captureSession?.stop();
		this.captureSession = undefined;
		try {
			this.stream?.close();
		} catch {
			// ignore
		}
		this.stream = undefined;
		this.audio.clear();
		this.coalescer.flush();
	}

	private resetSession(): void {
		this.transcript = "";
		this.pendingInterim = "";
		this.correctionTerms = [];
		this.hadAudioSignal = false;
		this.sawTranscript = false;
		this.streamWasConnected = false;
		this.retried = false;
		this.replayed = false;
		this.levels.clear();
		this.audio.clear();
		this.coalescer.flush();
	}

	// --- audio -------------------------------------------------------------

	private onData(chunk: Buffer, generation: number): void {
		if (generation !== this.generation) return;
		this.noteConnected();

		const level = levelFromS16le(chunk);
		if (level > AUDIO_SIGNAL_THRESHOLD) this.hadAudioSignal = true;
		this.levels.push(level);
		this.deps.hooks?.onLevel?.(this.levels.snapshot());

		this.audio.append(chunk);

		const stream = this.stream;
		if (!stream) return;
		for (const frame of this.coalescer.push(chunk)) this.feed(stream, frame);
	}

	private flushUnsentAudio(generation: number): void {
		const stream = this.stream;
		if (!stream || generation !== this.generation) return;
		const unsent = this.audio.unsent();
		if (!unsent) return;
		// Everything captured before the backend was ready is already complete
		// audio, not a frame in progress, so send it now rather than holding it
		// for the next live chunk to top up the coalescer.
		this.feedBuffer(stream, unsent);
		this.audio.markAllSent();
	}

	private flushTail(generation: number): void {
		const stream = this.stream;
		if (!stream || generation !== this.generation) return;
		const tail = this.coalescer.flush();
		if (tail) this.feed(stream, tail);
	}

	private feedBuffer(stream: VoiceStream, buffer: Buffer): void {
		for (const frame of this.coalescer.push(buffer)) this.feed(stream, frame);
		// A whole-buffer send (replay, retry) is a complete body of audio, not a
		// live stream mid-utterance, so do not leave a partial frame waiting for
		// audio that may never come.
		const tail = this.coalescer.flush();
		if (tail) this.feed(stream, tail);
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

	private onCaptureEnded(generation: number): void {
		if (generation !== this.generation) return;
		if (this.state !== "recording") return;
		if (!this.hadAudioSignal) this.recordFailure();
		this.debug("capture ended on its own");
		this.finish();
	}

	// --- backend events ----------------------------------------------------

	private onEvent(event: VoiceEvent, generation: number): void {
		if (generation !== this.generation) return;
		// Any transcript means the socket was genuinely connected; the replay path
		// needs to know that even after the connection later drops.
		if (event.type === "interim" || event.type === "final") this.streamWasConnected = true;

		switch (event.type) {
			case "interim": {
				if (this.state !== "recording" && this.state !== "arming") return;
				this.pendingInterim = event.text;
				this.deps.hooks?.onInterim?.(this.composeInterim(event.text));
				this.armSilenceTimer();
				return;
			}
			case "final": {
				const text = event.text.trim();
				this.pendingInterim = "";
				if (!text) return;
				this.sawTranscript = true;
				this.transcript = this.transcript ? `${this.transcript} ${text}` : text;
				this.deps.hooks?.onInterim?.(this.transcript);
				this.armSilenceTimer();
				return;
			}
			case "error": {
				this.onStreamError(event, generation);
				return;
			}
		}
	}

	/** Interim text is rendered after whatever has already been committed. */
	private composeInterim(text: string): string {
		return this.transcript ? `${this.transcript} ${text}` : text;
	}

	/**
	 * Commit an interim that never got a final, because the connection ended
	 * before the server confirmed the utterance.
	 */
	private promoteInterim(): void {
		const text = this.pendingInterim.trim();
		this.pendingInterim = "";
		if (!text) return;
		this.debug("promoting unreported interim to final");
		this.transcript = this.transcript ? `${this.transcript} ${text}` : text;
	}

	private onStreamError(event: { message: string; fatal?: boolean; code?: string }, generation: number): void {
		this.debug(`stream error: ${event.message}`);
		if (this.state !== "recording") return;

		// An error before the first transcript is worth one silent retry, because
		// it is usually a transient connect or upgrade failure.
		if (!this.sawTranscript && !this.retried) {
			this.retried = true;
			this.debug("early stream error; retrying once");
			this.arm("retry", this.timings.earlyRetryDelayMs, () => {
				if (generation !== this.generation || this.state !== "recording") return;
				void this.retryStream(generation);
			});
			return;
		}

		this.recordFailure();
		// Whatever was already transcribed is real speech. Salvage it rather than
		// throwing away a whole utterance because the socket died at the end.
		this.promoteInterim();
		if (this.transcript.trim()) {
			this.debug("salvaging partial transcript before reporting the error");
			this.emitTranscript();
		}
		this.fail(event.message, event.code ?? "stream_error");
	}

	private async retryStream(generation: number): Promise<void> {
		try {
			this.stream?.close();
		} catch {
			// ignore
		}
		this.stream = undefined;
		const stream = await this.openStream(generation);
		if (generation !== this.generation) return;
		if (!stream) {
			this.fail("Could not reconnect to the voice service.", "connect_failed", { recordFailure: true });
			return;
		}
		// A fresh stream has received nothing, so it needs the whole session. The
		// coalescer may still hold an un-flushed tail that `audio.all()` already
		// includes, so drop it first rather than sending that tail twice, out of order.
		this.coalescer.flush();
		const audio = this.audio.all();
		if (audio) this.feedBuffer(stream, audio);
		this.audio.markAllSent();
	}

	// --- output ------------------------------------------------------------

	private emitTranscript(): void {
		let text = this.transcript.trim();
		if (!text) return;

		if (this.deps.backend.capabilities.biasing === "none" && this.deps.correction !== "off") {
			const result = correctTranscript(text, this.correctionTerms, this.deps.correction);
			for (const change of result.changes) {
				this.debug(`correction: ${change.from} -> ${change.to}`);
			}
			text = result.text;
		}

		if (this.sawTranscript) this.clearFailures();
		this.deps.hooks?.onFinal?.(text);
	}

	/**
	 * Nothing was transcribed. Say why, specifically: "no audio" and "no
	 * network" and "you said nothing" need different fixes.
	 */
	private async reportEmpty(): Promise<void> {
		if (this.transcript.trim().length > 0) return;
		if (this.clock.now() - this.sessionStartedAt < 2000) return;

		if (!this.hadAudioSignal) {
			this.deps.hooks?.onError?.(
				"No audio detected from the microphone. Check that the right input device is selected and that pi has microphone access.",
				"no_audio_signal",
			);
			return;
		}
		if (!this.streamWasConnected) {
			const why = await this.explainConnectionFailure();
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

	private fail(message: string, code: string, options: { recordFailure?: boolean } = {}): void {
		if (options.recordFailure) this.recordFailure();
		// Invalidate in-flight async work with this generation, now that the
		// session is over.
		this.generation++;
		this.endSession();
		this.deps.hooks?.onError?.(message, code);
		this.setState(this.failureTimes.length >= this.timings.breakerThreshold ? "paused" : "idle");
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

	// --- timers ------------------------------------------------------------

	private armSilenceTimer(): void {
		if (this.deps.mode !== "tap") return;
		this.arm("silence", this.timings.tapSilenceMs, () => {
			if (this.state === "recording") this.finish();
		});
	}

	private armRelease(): void {
		this.arm("release", this.timings.releaseDebounceMs, () => {
			if (this.state === "recording") this.finish();
		});
	}

	/** Auto-repeat observed: cancel the fallback and re-arm the release debounce. */
	private onHoldProgress(): void {
		this.clearTimer("fallback");
		this.armRelease();
	}

	private arm(name: TimerName, ms: number, callback: () => void): void {
		this.clearTimer(name);
		this.timers[name] = this.clock.setTimeout(() => {
			this.timers[name] = undefined;
			callback();
		}, ms);
	}

	private clearTimer(name: TimerName): void {
		const handle = this.timers[name];
		if (!handle) return;
		this.clock.clearTimeout(handle);
		this.timers[name] = undefined;
	}

	private clearSessionTimers(): void {
		for (const name of ["retry", "fallback", "release", "silence", "max"] as const) this.clearTimer(name);
	}

	private setState(state: VoiceState): void {
		if (this.state === state) return;
		this.state = state;
		this.deps.hooks?.onState?.(state);
	}

	private debug(message: string): void {
		this.deps.hooks?.onDebug?.(message);
	}
}
