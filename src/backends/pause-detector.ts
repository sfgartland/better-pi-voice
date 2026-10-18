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

import { levelFromS16le } from "../formats.ts";

export interface PauseDetector {
	/** Feed the same PCM the batch stream receives. */
	push(pcm: Buffer): void;
	/** Cut offsets in bytes available so far, best first. */
	cuts(capturedBytes: number): number[];
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
