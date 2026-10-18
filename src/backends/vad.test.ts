import { describe, expect, test } from "bun:test";
import { planCuts, speechSegments } from "./vad.ts";

describe("speechSegments", () => {
	test("finds speech segments with Silero's thresholds", () => {
		// 32 frames of silence, 24 frames of speech (p=0.9), 16 frames of silence.
		const probs = [...Array(32).fill(0.01), ...Array(24).fill(0.9), ...Array(16).fill(0.01)];
		const segments = speechSegments(probs, 512, { sampleRate: 16_000 });
		expect(segments).toHaveLength(1);
		expect(segments[0]!.startSample).toBe(32 * 512 - 480); // 30 ms pad = 480 samples
	});

	test("drops segments shorter than minSpeechMs", () => {
		expect(speechSegments([0.9, 0.9, 0.01], 512, { sampleRate: 16_000 })).toEqual([]);
	});
});

describe("planCuts", () => {
	test("plans a cut at the pause nearest the target", () => {
		const cuts = planCuts({
			candidates: [14 * 16_000 * 2, 31 * 16_000 * 2],
			startBytes: 0,
			capturedBytes: 40 * 16_000 * 2,
			targetSeconds: 30,
			minSeconds: 5,
			maxSeconds: 40,
			bytesPerSecond: 16_000 * 2,
		});
		expect(cuts).toEqual([31 * 16_000 * 2]);
	});

	test("hard-cuts at maxSeconds when there is no pause", () => {
		const cuts = planCuts({
			candidates: [],
			startBytes: 0,
			capturedBytes: 90 * 16_000 * 2,
			targetSeconds: 30,
			minSeconds: 5,
			maxSeconds: 40,
			bytesPerSecond: 16_000 * 2,
		});
		expect(cuts).toEqual([40 * 16_000 * 2]);
	});
});
