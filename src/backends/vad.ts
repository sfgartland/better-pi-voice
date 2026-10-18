/**
 * Silero-VAD segmentation and cut planning, as pure functions.
 *
 * Ported from `@earendil-works/pi-voice` 0.2.0 (`src/vad.ts`, `src/chunking.ts`,
 * MIT), which reimplements Silero's `get_speech_timestamps` over per-frame speech
 * probabilities and — with the greedy `planCuts` — decides where to cut a live
 * recording at a real pause. The smoothing idea (`cjpais/Handy`'s `SmoothedVad`,
 * MIT) is deliberately out of scope here: these functions take the probabilities
 * and return sample/byte offsets.
 *
 * The one place this matters: the RMS heuristic in `pause-detector.ts` can only
 * tell "loud" from "quiet". A VAD tells "speech" from "not speech", which is what
 * the cut decision actually depends on in a room with music, a fan, or a phone
 * on speaker.
 */

export type SpeechSegment = { startSample: number; endSample: number };

export type SpeechSegmentOptions = {
	sampleRate?: number;
	threshold?: number;
	negThreshold?: number;
	minSpeechMs?: number;
	minSilenceMs?: number;
	speechPadMs?: number;
};

/** Silero's `get_speech_timestamps` defaults. */
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_MIN_SPEECH_MS = 250;
const DEFAULT_MIN_SILENCE_MS = 100;
const DEFAULT_SPEECH_PAD_MS = 30;

/**
 * Turn per-frame speech probabilities into speech segments, in samples.
 *
 * Faithful to Silero's hysteresis: a frame at or above `threshold` starts
 * speech, and it only ends once silence has lasted `minSilenceMs`, so a brief
 * dropout inside a word does not split the segment. Segments shorter than
 * `minSpeechMs` are dropped, and every segment is padded by `speechPadMs`.
 */
export function speechSegments(
	probs: readonly number[],
	frameSamples: number,
	options: SpeechSegmentOptions = {},
): SpeechSegment[] {
	const sampleRate = options.sampleRate ?? 16_000;
	const threshold = options.threshold ?? DEFAULT_THRESHOLD;
	const negThreshold = options.negThreshold ?? Math.max(threshold - 0.15, 0.01);
	const minSpeechSamples = ((options.minSpeechMs ?? DEFAULT_MIN_SPEECH_MS) * sampleRate) / 1000;
	const minSilenceSamples = ((options.minSilenceMs ?? DEFAULT_MIN_SILENCE_MS) * sampleRate) / 1000;
	const padSamples = ((options.speechPadMs ?? DEFAULT_SPEECH_PAD_MS) * sampleRate) / 1000;
	const totalSamples = probs.length * frameSamples;

	const speech: Array<{ start: number; end: number }> = [];
	let triggered = false;
	let currentStart = 0;
	let tempEnd = 0;

	for (let i = 0; i < probs.length; i++) {
		const prob = probs[i] ?? 0;
		if (prob >= threshold) {
			if (!triggered) {
				triggered = true;
				currentStart = i * frameSamples;
			}
			continue;
		}
		if (!triggered || prob >= negThreshold) continue;
		if (tempEnd === 0) tempEnd = i * frameSamples;
		if (i * frameSamples - tempEnd < minSilenceSamples) continue;
		if (tempEnd - currentStart > minSpeechSamples) speech.push({ start: currentStart, end: tempEnd });
		tempEnd = 0;
		triggered = false;
	}

	if (triggered && totalSamples - currentStart > minSpeechSamples) {
		speech.push({ start: currentStart, end: totalSamples });
	}

	return speech.map((segment, index) => {
		let start = segment.start;
		let end = segment.end;
		if (index === 0) start = Math.max(0, start - padSamples);
		const next = speech[index + 1];
		if (next) {
			const gap = next.start - end;
			if (gap < 2 * padSamples) {
				end += Math.floor(gap / 2);
				next.start = Math.max(0, next.start - Math.floor(gap / 2));
			} else {
				end = Math.min(totalSamples, end + padSamples);
				next.start = Math.max(0, next.start - padSamples);
			}
		} else {
			end = Math.min(totalSamples, end + padSamples);
		}
		return { startSample: start, endSample: end };
	});
}

/**
 * Byte offsets of the mid-point of each silence gap, longest gap first.
 *
 * Gaps before the first segment and after the last count: silence at either end
 * is as good a place to cut as silence between two words.
 */
export function cutCandidates(
	segments: readonly SpeechSegment[],
	frameSamples: number,
	bytesPerSample: number,
	totalSamples: number,
): number[] {
	const gaps: Array<{ start: number; end: number }> = [];
	let cursor = 0;
	for (const segment of segments) {
		if (segment.startSample > cursor) gaps.push({ start: cursor, end: segment.startSample });
		cursor = Math.max(cursor, segment.endSample);
	}
	if (totalSamples > cursor) gaps.push({ start: cursor, end: totalSamples });

	return gaps
		.map((gap) => {
			// Snap to a frame boundary: cutting a fraction of a frame into a
			// segment is how a word loses its first phoneme.
			const midSamples = Math.floor((gap.start + gap.end) / 2 / frameSamples) * frameSamples;
			return { offset: midSamples * bytesPerSample, length: gap.end - gap.start };
		})
		.sort((a, b) => b.length - a.length || a.offset - b.offset)
		.map((entry) => entry.offset);
}

/**
 * Greedy one-cut-per-pause plan.
 *
 * Picks the pause nearest `targetSeconds` when there is one at least
 * `minSeconds` in, and otherwise hard-cuts at `maxSeconds` so continuous speech
 * still makes progress. Returns at most the next cut.
 */
export function planCuts(options: {
	candidates: number[];
	startBytes: number;
	capturedBytes: number;
	targetSeconds: number;
	minSeconds: number;
	maxSeconds: number;
	bytesPerSecond: number;
}): number[] {
	const { candidates, startBytes, capturedBytes, targetSeconds, minSeconds, maxSeconds, bytesPerSecond } = options;
	const minBytes = startBytes + minSeconds * bytesPerSecond;
	const maxBytes = Math.min(startBytes + maxSeconds * bytesPerSecond, capturedBytes);
	const targetBytes = startBytes + targetSeconds * bytesPerSecond;

	const nearest = candidates
		.filter((candidate) => candidate >= minBytes && candidate <= maxBytes)
		.sort((a, b) => Math.abs(a - targetBytes) - Math.abs(b - targetBytes));
	if (nearest.length > 0) return [nearest[0]!];

	const hardCut = startBytes + maxSeconds * bytesPerSecond;
	if (capturedBytes >= hardCut) return [hardCut];
	return [];
}
