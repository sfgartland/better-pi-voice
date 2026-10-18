/**
 * One recording's state, separated from the controller.
 *
 * The controller used to keep every per-recording field as an instance field,
 * which made a second recording impossible while the first was still being
 * transcribed. Everything that belongs to a single capture now lives here, so
 * the controller can keep several of these alive at once (the active one plus a
 * queue of finished-but-untranscribed ones).
 */

import type { CaptureSession } from "./capture.ts";
import type { Clock, TimerHandle } from "./clock.ts";
import { AUDIO_SIGNAL_THRESHOLD, AudioRecorder, FrameCoalescer, LevelRing, levelFromS16le } from "./formats.ts";
import type { VoiceStream } from "./types.ts";

export type SessionPhase = "arming" | "recording" | "processing";
export type SessionTimer = "retry" | "fallback" | "release" | "silence" | "max" | "reap";

/** 16 kHz mono s16le = 32 bytes per millisecond. */
const BYTES_PER_MS = 32;

export class VoiceSession {
	readonly seq: number;
	phase: SessionPhase = "arming";
	captureSession: CaptureSession | undefined;
	stream: VoiceStream | undefined;
	readonly audio: AudioRecorder;
	readonly coalescer: FrameCoalescer;
	readonly levels: LevelRing;
	transcript = "";
	pendingInterim = "";
	correctionTerms: string[] = [];
	hadAudioSignal = false;
	sawTranscript = false;
	streamWasConnected = false;
	retried = false;
	replayed = false;
	/** True once this recording's result (possibly "") is in `finished`. */
	stored = false;
	/** Cancelled / disposed: async callbacks for this session must no-op. */
	abandoned = false;
	startedAt: number;
	readonly timers: Partial<Record<SessionTimer, TimerHandle>> = {};

	private readonly clock: Clock | undefined;

	constructor(init: { seq: number; maxBufferedAudioMs: number; clock?: Clock | undefined }) {
		this.seq = init.seq;
		this.audio = new AudioRecorder(init.maxBufferedAudioMs * BYTES_PER_MS);
		this.coalescer = new FrameCoalescer();
		this.levels = new LevelRing();
		this.clock = init.clock;
		this.startedAt = init.clock?.now() ?? 0;
	}

	/** Record level and retained audio without coalescing (used before a stream exists). */
	record(chunk: Buffer): void {
		const level = levelFromS16le(chunk);
		if (level > AUDIO_SIGNAL_THRESHOLD) this.hadAudioSignal = true;
		this.levels.push(level);
		this.audio.append(chunk);
	}

	/** Push a live chunk; returns the coalesced frames to feed. */
	pushChunk(chunk: Buffer): Buffer[] {
		this.record(chunk);
		return this.coalescer.push(chunk);
	}

	/** Push a whole retained buffer (replay/retry); returns frames incl. flushed tail. */
	pushBuffer(buffer: Buffer): Buffer[] {
		const frames = this.coalescer.push(buffer);
		const tail = this.flushTail();
		if (tail) frames.push(tail);
		return frames;
	}

	flushTail(): Buffer | undefined {
		return this.coalescer.flush();
	}

	clearTimers(): void {
		for (const name of ["retry", "fallback", "release", "silence", "max", "reap"] as const) {
			const handle = this.timers[name];
			if (!handle) continue;
			this.clock?.clearTimeout(handle);
			this.timers[name] = undefined;
		}
	}

	/** Stop capture and close the stream; never throws. */
	release(): void {
		this.captureSession?.stop();
		this.captureSession = undefined;
		try {
			this.stream?.close();
		} catch {
			// Closing an already-dead stream is allowed to fail.
		}
		this.stream = undefined;
		this.clearTimers();
	}
}
