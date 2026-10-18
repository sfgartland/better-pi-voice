/**
 * Where a batch recording should be cut, behind one interface.
 *
 * The default detector is the RMS heuristic the batch stream has always used:
 * it infers the noise floor and speech level from the recording's own chunk
 * levels and treats anything in the lowest part of that range as a pause. It
 * needs no extra model, but it is fragile in exactly the cases VAD exists for —
 * steady background noise, music, or a room where speech and noise overlap.
 * `createVadPauseDetector` (Silero) replaces it when a VAD model is available.
 */

import { levelFromS16le, s16leToFloat32 } from "../formats.ts";
import { cutCandidates, planCuts, speechSegments } from "./vad.ts";

export interface PauseDetector {
	/** Feed the same PCM the batch stream receives. */
	push(pcm: Buffer): void;
	/** Cut offsets in bytes available so far, best first. */
	cuts(capturedBytes: number): number[];
	/** Release anything held (a VAD session), when the stream ends. */
	dispose?(): void;
}

export type PauseDetectorOptions = {
	chunkSeconds: number;
	/** Do not cut before this fraction of the target length. */
	minChunkFraction: number;
	/** A pinned level, or "auto" to derive one per recording. */
	silenceLevel: number | "auto";
	bytesPerSecond: number;
};

/** Below this much variation there is no pause to find, so nothing is cut. */
const MIN_DYNAMIC_RANGE = 0.1;
/** Where in the noise-to-speech range a boundary stops counting as speech. */
const PAUSE_RANGE_FRACTION = 0.3;

/**
 * The RMS heuristic, moved out of `ParakeetBatchStream` unchanged.
 *
 * `cuts(capturedBytes)` looks at only the most recent `capturedBytes` worth of
 * pushed audio, because callers cut a prefix off their buffer between calls and
 * the detector must score the same window the caller now holds.
 */
export function createLevelPauseDetector(options: PauseDetectorOptions): PauseDetector {
	const levels: number[] = [];
	const lengths: number[] = [];

	/** Slice a window of `capturedBytes` off the end of the history. */
	const window = (capturedBytes: number): { levels: number[]; lengths: number[] } => {
		let total = 0;
		for (const length of lengths) total += length;
		const start = Math.max(0, total - capturedBytes);
		let accumulated = 0;
		let index = 0;
		while (index < lengths.length && accumulated < start) {
			accumulated += lengths[index]!;
			index++;
		}
		return { levels: levels.slice(index), lengths: lengths.slice(index) };
	};

	const thresholdFor = (windowLevels: readonly number[]): number | undefined => {
		if (typeof options.silenceLevel === "number") return options.silenceLevel;
		if (windowLevels.length < 8) return undefined;
		const sorted = [...windowLevels].sort((a, b) => a - b);
		// The second-smallest level, not a low percentile: pauses are brief, so a
		// 10th percentile often IS speech. Two silent chunks in forty still yields a
		// zero floor, whereas the percentile reported 1.00 and found no pause at
		// all. Taking the second rather than the smallest ignores one stray click.
		const noise = sorted[1]!;
		const speech = sorted[Math.floor(0.75 * (sorted.length - 1))]!;
		const range = speech - noise;
		if (range < MIN_DYNAMIC_RANGE) return undefined;
		return noise + PAUSE_RANGE_FRACTION * range;
	};

	return {
		push(pcm: Buffer): void {
			levels.push(levelFromS16le(pcm));
			lengths.push(pcm.length);
		},

		cuts(capturedBytes: number): number[] {
			const minKeep = options.chunkSeconds * options.bytesPerSecond * options.minChunkFraction;
			if (capturedBytes < minKeep) return [];
			const windowed = window(capturedBytes);
			const threshold = thresholdFor(windowed.levels);
			if (threshold === undefined) return [];

			let cumulative = 0;
			for (let i = 0; i < windowed.lengths.length; i++) {
				cumulative += windowed.lengths[i]!;
				if (cumulative < minKeep) continue;
				if (windowed.levels[i]! <= threshold) return [cumulative];
			}
			return [];
		},
	};
}

/** The slice of transcribe-cpp's `VadSession` this needs. */
export type VadSessionLike = {
	streamFeed(pcm: Float32Array): Promise<{ probs: number[] }>;
	dispose?(): void;
};

export type VadPauseDetectorOptions = {
	frameSamples: number;
	chunkSeconds: number;
	minChunkFraction: number;
	bytesPerSecond: number;
	sampleRate?: number;
	bytesPerSample?: number;
};

/**
 * Silero-VAD cut planning.
 *
 * Frames are scored asynchronously, so probabilities arrive a frame or two
 * behind the audio. `cuts()` therefore only considers what has actually been
 * scored: it maps the caller's current window onto the scored frames, runs the
 * segmentation/planning port over them, and returns the first planned cut. A
 * frame that fails to score counts as silence, so a broken VAD degrades to
 * "cut at the quiet part" rather than stalling.
 */
export function createVadPauseDetector(session: VadSessionLike, options: VadPauseDetectorOptions): PauseDetector {
	const { frameSamples, chunkSeconds, minChunkFraction, bytesPerSecond } = options;
	const sampleRate = options.sampleRate ?? 16_000;
	const bytesPerSample = options.bytesPerSample ?? 2;
	const frameBytes = frameSamples * bytesPerSample;

	const probs: number[] = [];
	let pending = Buffer.alloc(0);
	let totalBytes = 0;
	let chain: Promise<void> = Promise.resolve();

	return {
		push(pcm: Buffer): void {
			if (pcm.length === 0) return;
			totalBytes += pcm.length;
			pending = Buffer.concat([pending, pcm]);
			while (pending.length >= frameBytes) {
				const frame = pending.subarray(0, frameBytes);
				pending = pending.subarray(frameBytes);
				const samples = s16leToFloat32(Buffer.from(frame));
				chain = chain
					.then(async () => {
						const result = await session.streamFeed(samples);
						for (const prob of result.probs) probs.push(prob);
					})
					.catch(() => {
						// A scoring failure must not stall cutting.
						probs.push(0);
					});
			}
		},

		cuts(capturedBytes: number): number[] {
			const bufferStartBytes = Math.max(0, totalBytes - capturedBytes);
			const frameStart = Math.floor(bufferStartBytes / frameBytes);
			if (probs.length <= frameStart) return [];

			const windowProbs = probs.slice(frameStart);
			const scoredRelativeBytes = probs.length * frameBytes - bufferStartBytes;
			if (scoredRelativeBytes <= 0) return [];

			const segments = speechSegments(windowProbs, frameSamples, { sampleRate });
			// No speech in the window means there is nothing to cut around; a steady
			// quiet buffer must not produce a "cut" just because it is quiet.
			if (segments.length === 0) return [];

			const shift = frameStart * frameBytes - bufferStartBytes;
			const candidates = cutCandidates(segments, frameSamples, bytesPerSample, windowProbs.length * frameSamples).map(
				(offset) => offset + shift,
			);
			return planCuts({
				candidates,
				startBytes: 0,
				capturedBytes: scoredRelativeBytes,
				targetSeconds: chunkSeconds,
				minSeconds: chunkSeconds * minChunkFraction,
				maxSeconds: chunkSeconds * 2,
				bytesPerSecond,
			});
		},

		dispose(): void {
			session.dispose?.();
		},
	};
}
