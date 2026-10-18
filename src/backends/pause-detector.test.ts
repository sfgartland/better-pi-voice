import { describe, expect, test } from "bun:test";
import { pcmOf } from "../testing/fake-capture.ts";
import { createLevelPauseDetector, createVadPauseDetector } from "./pause-detector.ts";

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

describe("createVadPauseDetector", () => {
	const frameSamples = 512;
	const frameBytes = frameSamples * 2;
	const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

	/** A fake VAD: each streamFeed consumes the next frames and returns their probs. */
	function fakeVad(pattern: number[]) {
		let index = 0;
		const session = {
			streamFeed: async (pcm: Float32Array) => {
				const count = Math.max(1, Math.floor(pcm.length / frameSamples));
				const slice = pattern.slice(index, index + count);
				index += count;
				return { probs: slice.length > 0 ? slice : [0] };
			},
			dispose: () => {},
		};
		return { session };
	}

	test("cuts where the VAD says speech has ended, not where it is merely quiet", async () => {
		const pattern = [...Array(16).fill(0.01), ...Array(20).fill(0.99), ...Array(16).fill(0.01)];
		const { session } = fakeVad(pattern);
		const detector = createVadPauseDetector(session, {
			frameSamples,
			chunkSeconds: 1,
			minChunkFraction: 0.7,
			bytesPerSecond: 32_000,
		});
		for (const prob of pattern) detector.push(pcmOf(prob >= 0.5 ? 900 : 0, frameBytes));
		await settle();

		const cuts = detector.cuts(pattern.length * frameBytes);
		expect(cuts.length).toBeGreaterThan(0);
		expect(cuts[0]).toBeGreaterThan(16 * frameBytes); // after the leading silence
		expect(cuts[0]).toBeLessThanOrEqual(pattern.length * frameBytes);
	});

	test("does not cut a buffer the VAD scores as silent, even with loud audio in it", async () => {
		const { session } = fakeVad(Array(60).fill(0.01));
		const detector = createVadPauseDetector(session, {
			frameSamples,
			chunkSeconds: 1,
			minChunkFraction: 0.7,
			bytesPerSecond: 32_000,
		});
		for (let i = 0; i < 30; i++) detector.push(pcmOf(900, frameBytes));
		for (let i = 0; i < 30; i++) detector.push(pcmOf(0, frameBytes));
		await settle();

		expect(detector.cuts(60 * frameBytes)).toEqual([]);
	});
});
