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

export class VoiceController {
	private state: VoiceState = "idle";
	/** Bumped on every session boundary; stale async work compares against it. */
	private generation = 0;
	/** The recording currently being captured or processed, if any. */
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

	/** Hold mode: key press. Tap mode: toggles. */
	press(): void {
		if (this.state === "paused") return;

		if (this.deps.mode === "tap") {
			if (this.state === "idle") void this.begin();
			else if (this.state === "recording") this.finish(this.active);
			return;
		}

		if (this.state === "idle") {
			void this.begin();
			const session = this.active;
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
			return;
		}

		if (this.state === "recording") this.onHoldProgress(this.active);
	}

	/** Hold mode: repeated key events from auto-repeat. */
	repeat(): void {
		if (this.deps.mode !== "hold" || this.state !== "recording") return;
		this.onHoldProgress(this.active);
	}

	/** Hold mode: key release, where the terminal reports it. */
	release(): void {
		if (this.deps.mode !== "hold" || this.state !== "recording") return;
		this.armRelease(this.active);
	}

	/** Discard the session without submitting anything. */
	cancel(): void {
		if (this.state === "idle") {
			// A begin() may be in flight without having changed the state yet, so idle
			// does not mean there is nothing to cancel: invalidate it.
			this.generation++;
			if (this.active) this.endSession(this.active);
			return;
		}
		this.debug("cancelled");
		this.generation++;
		if (this.active) this.endSession(this.active);
		this.setState("idle");
	}

	dispose(): void {
		if (this.active) this.endSession(this.active);
		this.generation++;
		this.setState("idle");
	}

	// --- session lifecycle -------------------------------------------------

	private async begin(): Promise<void> {
		const generation = ++this.generation;
		const session = new VoiceSession({
			seq: 0,
			maxBufferedAudioMs: this.timings.maxBufferedAudioMs,
			clock: this.clock,
		});
		this.active = session;
		this.resetSession(session);

		const availability = await this.deps.capture.checkAvailability();
		if (generation !== this.generation) return;
		if (!availability.available) {
			this.fail(session, availability.reason ?? "Audio recording is not available.", "capture_unavailable");
			return;
		}

		this.setState("arming");
		session.phase = "arming";
		const started = await this.deps.capture.start(
			(chunk) => this.onData(chunk, session, generation),
			() => this.onCaptureEnded(session, generation),
		);
		if (generation !== this.generation) {
			if (started.ok) started.session.stop();
			return;
		}
		if (!started.ok) {
			this.fail(session, started.reason, "capture_failed", { recordFailure: true });
			return;
		}

		session.captureSession = started.session;
		session.startedAt = this.clock.now();
		this.setState("recording");
		session.phase = "recording";
		this.arm(session, "max", this.timings.maxSessionMs, () => {
			this.debug("session hit the maximum duration");
			this.finish(session);
		});
		this.armSilenceTimer(session);

		const stream = await this.openStream(session, generation);
		if (generation !== this.generation) return;
		if (!stream) {
			// Ask the backend why, so a local setup says "no model" rather than
			// "could not connect".
			const availability = await this.deps.backend
				.checkAvailability()
				.catch(() => ({ available: true, reason: undefined as string | undefined }));
			if (generation !== this.generation) return;
			this.fail(session, availability.reason ?? "Could not connect to the voice service.", "connect_failed", {
				recordFailure: true,
			});
			return;
		}
		this.flushUnsentAudio(session, generation);
	}

	private async openStream(session: VoiceSession, generation: number): Promise<VoiceStream | undefined> {
		let set: KeytermSet = { bias: [], correct: [], truncated: false };
		try {
			set = await this.deps.keyterms();
		} catch (error) {
			this.debug(`keyterm mining failed: ${String(error)}`);
		}
		if (generation !== this.generation) return undefined;
		session.correctionTerms = set.correct;

		const stream = await this.deps.backend.start(
			{ language: this.deps.language, keyterms: set.bias, signal: new AbortController().signal },
			(event) => this.onEvent(event, session, generation),
		);
		if (!stream) return undefined;
		session.stream = stream;
		// Never clear a flag set by an earlier connection in this session.
		session.streamWasConnected ||= stream.isConnected();
		return stream;
	}

	private finish(session: VoiceSession | undefined): void {
		if (!session || this.state !== "recording") return;
		session.clearTimers();
		session.captureSession?.stop();
		session.captureSession = undefined;
		this.setState("processing");
		session.phase = "processing";
		const generation = this.generation;
		void this.process(session, generation);
	}

	private async process(session: VoiceSession, generation: number): Promise<void> {
		// Flush the coalescer tail so the final words are not stranded in a
		// partial frame.
		this.flushTail(session, generation);

		const outcome = await this.finalizeStream(session);
		if (generation !== this.generation) return;

		// The stream died without confirming what it had. We still hold the audio,
		// so replay it once on a fresh connection rather than losing the utterance.
		if (!session.transcript.trim() && this.isUnconfirmed(outcome) && this.canReplay(session)) {
			this.debug(`stream unconfirmed (${outcome}); replaying buffered audio`);
			session.replayed = true;
			if (await this.replayBuffer(session, generation)) {
				if (generation !== this.generation) return;
				this.emitTranscript(session);
				this.finishSession(session);
				return;
			}
			if (generation !== this.generation) return;
		}

		// No endpoint ever arrived, so the last thing we heard exists only as an
		// interim. A slightly provisional word beats a silently dropped sentence.
		this.promoteInterim(session);
		this.emitTranscript(session);
		await this.reportEmpty(session);
		this.finishSession(session);
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
	private async replayBuffer(session: VoiceSession, generation: number): Promise<boolean> {
		const audio = session.audio.all();
		if (!audio) return false;
		try {
			session.stream?.close();
		} catch {
			// Closing a dead socket is allowed to fail.
		}
		session.stream = undefined;

		const stream = await this.openStream(session, generation);
		if (generation !== this.generation || !stream) return false;

		session.transcript = "";
		session.pendingInterim = "";
		session.sawTranscript = false;
		this.feedBuffer(session, stream, audio);
		session.audio.markAllSent();
		this.flushTail(session, generation);

		const outcome = await this.finalizeStream(session);
		if (generation !== this.generation) return false;
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

	private finishSession(session: VoiceSession): void {
		try {
			session.stream?.close();
		} catch {
			// ignore
		}
		session.stream = undefined;
		session.audio.clear();
		if (this.active === session) this.active = undefined;
		this.setState(this.failureTimes.length >= this.timings.breakerThreshold ? "paused" : "idle");
	}

	private endSession(session: VoiceSession): void {
		session.release();
		session.audio.clear();
		session.coalescer.flush();
		if (this.active === session) this.active = undefined;
	}

	private resetSession(session: VoiceSession): void {
		session.transcript = "";
		session.pendingInterim = "";
		session.correctionTerms = [];
		session.hadAudioSignal = false;
		session.sawTranscript = false;
		session.streamWasConnected = false;
		session.retried = false;
		session.replayed = false;
		session.levels.clear();
		session.audio.clear();
		session.coalescer.flush();
	}

	// --- audio -------------------------------------------------------------

	private onData(chunk: Buffer, session: VoiceSession, generation: number): void {
		if (generation !== this.generation) return;
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

	private flushUnsentAudio(session: VoiceSession, generation: number): void {
		const stream = session.stream;
		if (!stream || generation !== this.generation) return;
		const unsent = session.audio.unsent();
		if (!unsent) return;
		// Everything captured before the backend was ready is already complete
		// audio, not a frame in progress, so send it now rather than holding it
		// for the next live chunk to top up the coalescer.
		this.feedBuffer(session, stream, unsent);
		session.audio.markAllSent();
	}

	private flushTail(session: VoiceSession, generation: number): void {
		const stream = session.stream;
		if (!stream || generation !== this.generation) return;
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

	private onCaptureEnded(session: VoiceSession, generation: number): void {
		if (generation !== this.generation) return;
		if (session.phase !== "recording") return;
		if (!session.hadAudioSignal) this.recordFailure();
		this.debug("capture ended on its own");
		this.finish(session);
	}

	// --- backend events ----------------------------------------------------

	private onEvent(event: VoiceEvent, session: VoiceSession, generation: number): void {
		if (generation !== this.generation) return;
		// Any transcript means the socket was genuinely connected; the replay path
		// needs to know that even after the connection later drops.
		if (event.type === "interim" || event.type === "final") session.streamWasConnected = true;

		switch (event.type) {
			case "interim": {
				if (session.phase !== "recording" && session.phase !== "arming") return;
				session.pendingInterim = event.text;
				this.deps.hooks?.onInterim?.(this.composeInterim(session, event.text));
				this.armSilenceTimer(session);
				return;
			}
			case "final": {
				const text = event.text.trim();
				session.pendingInterim = "";
				if (!text) return;
				session.sawTranscript = true;
				session.transcript = session.transcript ? `${session.transcript} ${text}` : text;
				this.deps.hooks?.onInterim?.(session.transcript);
				this.armSilenceTimer(session);
				return;
			}
			case "error": {
				this.onStreamError(event, session, generation);
				return;
			}
		}
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

	private onStreamError(
		event: { message: string; fatal?: boolean; code?: string },
		session: VoiceSession,
		generation: number,
	): void {
		this.debug(`stream error: ${event.message}`);
		if (session.phase !== "recording") return;

		// An error before the first transcript is worth one silent retry, because
		// it is usually a transient connect or upgrade failure.
		if (!session.sawTranscript && !session.retried) {
			session.retried = true;
			this.debug("early stream error; retrying once");
			this.arm(session, "retry", this.timings.earlyRetryDelayMs, () => {
				if (generation !== this.generation || session.phase !== "recording") return;
				void this.retryStream(session, generation);
			});
			return;
		}

		this.recordFailure();
		// Whatever was already transcribed is real speech. Salvage it rather than
		// throwing away a whole utterance because the socket died at the end.
		this.promoteInterim(session);
		if (session.transcript.trim()) {
			this.debug("salvaging partial transcript before reporting the error");
			this.emitTranscript(session);
		}
		this.fail(session, event.message, event.code ?? "stream_error");
	}

	private async retryStream(session: VoiceSession, generation: number): Promise<void> {
		try {
			session.stream?.close();
		} catch {
			// ignore
		}
		session.stream = undefined;
		const stream = await this.openStream(session, generation);
		if (generation !== this.generation) return;
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

	private emitTranscript(session: VoiceSession): void {
		let text = session.transcript.trim();
		if (!text) return;

		if (this.deps.backend.capabilities.biasing === "none" && this.deps.correction !== "off") {
			const result = correctTranscript(text, session.correctionTerms, this.deps.correction);
			for (const change of result.changes) {
				this.debug(`correction: ${change.from} -> ${change.to}`);
			}
			text = result.text;
		}

		if (session.sawTranscript) this.clearFailures();
		this.deps.hooks?.onFinal?.(text);
	}

	/**
	 * Nothing was transcribed. Say why, specifically: "no audio" and "no
	 * network" and "you said nothing" need different fixes.
	 */
	private async reportEmpty(session: VoiceSession): Promise<void> {
		if (session.transcript.trim().length > 0) return;
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
		// Invalidate in-flight async work with this generation, now that the
		// session is over.
		this.generation++;
		this.endSession(session);
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

	private setState(state: VoiceState): void {
		if (this.state === state) return;
		this.state = state;
		this.deps.hooks?.onState?.(state);
	}

	private debug(message: string): void {
		this.deps.hooks?.onDebug?.(message);
	}
}
