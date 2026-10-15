import { describe, expect, test } from "bun:test";
import {
	AUDIO_SIGNAL_THRESHOLD,
	COALESCE_BYTES,
	FrameCoalescer,
	float32ToS16le,
	LEVEL_WINDOW,
	LevelRing,
	levelFromS16le,
	resampleLinear,
	s16leToFloat32,
} from "./formats.ts";

/** Build s16le PCM from amplitudes. */
function pcm(amplitudes: number[]): Buffer {
	const buf = Buffer.allocUnsafe(amplitudes.length * 2);
	amplitudes.forEach((a, i) => {
		buf.writeInt16LE(a, i * 2);
	});
	return buf;
}

describe("levelFromS16le", () => {
	test("silence is zero", () => {
		expect(levelFromS16le(pcm([0, 0, 0, 0]))).toBe(0);
		expect(levelFromS16le(Buffer.alloc(0))).toBe(0);
	});

	test("clamps at 1 for loud input", () => {
		expect(levelFromS16le(pcm([32767, -32768, 32767, -32768]))).toBe(1);
		// 2000 is the normalisation constant, so it already saturates.
		expect(levelFromS16le(pcm([2000, -2000]))).toBe(1);
	});

	test("is sqrt-scaled below saturation", () => {
		// rms 500 -> 500/2000 = 0.25 -> sqrt = 0.5
		expect(levelFromS16le(pcm([500, -500, 500, -500]))).toBeCloseTo(0.5, 6);
	});

	test("negative and positive amplitudes are treated alike", () => {
		expect(levelFromS16le(pcm([-500, -500]))).toBeCloseTo(levelFromS16le(pcm([500, 500])), 6);
	});

	test("a quiet-but-present signal clears the signal threshold", () => {
		// rms 100 -> 0.05 -> sqrt ~ 0.2236, comfortably above 0.01
		expect(levelFromS16le(pcm([100, -100]))).toBeGreaterThan(AUDIO_SIGNAL_THRESHOLD);
		// rms 1 -> 0.0005 -> sqrt ~ 0.022, still above
		expect(levelFromS16le(pcm([1, -1]))).toBeGreaterThan(AUDIO_SIGNAL_THRESHOLD);
	});

	test("only the low byte of a trailing odd-length buffer is ignored", () => {
		// Defensive: a truncated chunk must not throw or read past the end.
		expect(() => levelFromS16le(Buffer.from([0x01]))).not.toThrow();
	});
});

describe("PCM conversion", () => {
	test("s16leToFloat32 round-trips through float32ToS16le", () => {
		const original = pcm([0, 1000, -1000, 32767, -32768, 42]);
		const roundTripped = float32ToS16le(s16leToFloat32(original));
		// -32768/32768 = -1 -> -1*32767 = -32767, so allow one unit of slop.
		for (let i = 0; i < original.length / 2; i++) {
			expect(Math.abs(roundTripped.readInt16LE(i * 2) - original.readInt16LE(i * 2))).toBeLessThanOrEqual(1);
		}
	});

	test("float conversion clamps out-of-range values instead of wrapping", () => {
		expect(float32ToS16le(new Float32Array([2, -2])).readInt16LE(0)).toBe(32767);
		expect(float32ToS16le(new Float32Array([2, -2])).readInt16LE(2)).toBe(-32767);
	});
});

describe("resampleLinear", () => {
	test("48 kHz to 16 kHz produces a third of the samples", () => {
		const input = new Float32Array(4800).fill(0.5);
		expect(resampleLinear(input, 48_000, 16_000).length).toBe(1600);
	});

	test("returns the input untouched when rates match", () => {
		const input = new Float32Array([1, 2, 3]);
		expect(resampleLinear(input, 16_000, 16_000)).toBe(input);
	});

	test("interpolates between samples", () => {
		// 2 samples from 4: positions 0 and 2 -> values 0 and 2
		const out = resampleLinear(new Float32Array([0, 1, 2, 3]), 4, 2);
		expect(Array.from(out)).toEqual([0, 2]);
	});
});

describe("FrameCoalescer", () => {
	test("emits nothing until the cap is reached, then exactly the cap", () => {
		const coalescer = new FrameCoalescer(8);
		expect(coalescer.push(Buffer.alloc(4, 1))).toEqual([]);
		const out = coalescer.push(Buffer.alloc(4, 2));
		expect(out.length).toBe(1);
		expect(out[0]!.length).toBe(8);
		expect(coalescer.bufferedBytes).toBe(0);
	});

	test("splits a chunk larger than the cap into full frames plus a remainder", () => {
		const coalescer = new FrameCoalescer(4);
		const out = coalescer.push(Buffer.alloc(11, 7));
		expect(out.map((b) => b.length)).toEqual([4, 4]);
		expect(coalescer.bufferedBytes).toBe(3);
		expect(coalescer.flush()!.length).toBe(3);
	});

	test("never exceeds the cap across many ragged pushes", () => {
		const coalescer = new FrameCoalescer(COALESCE_BYTES);
		const sizes = [1000, 31_999, 1, 32_000, 64_001];
		for (const size of sizes) {
			for (const frame of coalescer.push(Buffer.alloc(size))) {
				expect(frame.length).toBeLessThanOrEqual(COALESCE_BYTES);
			}
		}
	});

	test("loses no bytes", () => {
		const coalescer = new FrameCoalescer(1000);
		let total = 0;
		for (const size of [1, 999, 1000, 2001, 7]) {
			for (const frame of coalescer.push(Buffer.alloc(size))) total += frame.length;
		}
		total += coalescer.flush()?.length ?? 0;
		expect(total).toBe(1 + 999 + 1000 + 2001 + 7);
	});

	test("flush on an empty coalescer yields undefined", () => {
		expect(new FrameCoalescer().flush()).toBeUndefined();
	});
});

describe("LevelRing", () => {
	test("keeps only the most recent window, oldest first", () => {
		const ring = new LevelRing(3);
		for (const v of [1, 2, 3, 4]) ring.push(v);
		expect(ring.snapshot()).toEqual([2, 3, 4]);
	});

	test("defaults to the reference window size", () => {
		const ring = new LevelRing();
		for (let i = 0; i < LEVEL_WINDOW + 5; i++) ring.push(i);
		expect(ring.snapshot().length).toBe(LEVEL_WINDOW);
	});

	test("clear empties it", () => {
		const ring = new LevelRing(3);
		ring.push(1);
		ring.clear();
		expect(ring.snapshot()).toEqual([]);
	});
});
