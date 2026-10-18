import { describe, expect, test } from "bun:test";
import { pcmOf } from "../testing/fake-capture.ts";
import { createLevelPauseDetector } from "./pause-detector.ts";

describe("createLevelPauseDetector", () => {
	test("derives an auto pause threshold from the recording's own levels", () => {
		const detector = createLevelPauseDetector({
			chunkSeconds: 15,
			minChunkFraction: 0.7,
			silenceLevel: "auto",
			bytesPerSecond: 32_000,
		});
		detector.push(pcmOf(0, 32_000)); // quiet
		for (let i = 0; i < 12; i++) detector.push(pcmOf(900, 32_000)); // speech
		detector.push(pcmOf(0, 32_000)); // quiet again

		const cuts = detector.cuts(14 * 32_000);
		expect(cuts).toHaveLength(1); // the quiet chunk at the end is the pause
		expect(cuts[0]).toBeGreaterThanOrEqual(32_000);
	});

	test("returns no cut when the level barely varies", () => {
		const detector = createLevelPauseDetector({
			chunkSeconds: 15,
			minChunkFraction: 0.7,
			silenceLevel: "auto",
			bytesPerSecond: 32_000,
		});
		for (let i = 0; i < 20; i++) detector.push(pcmOf(500, 32_000));
		expect(detector.cuts(20 * 32_000)).toEqual([]);
	});
});
