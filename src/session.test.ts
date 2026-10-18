import { describe, expect, test } from "bun:test";
import { VoiceSession } from "./session.ts";
import { pcmOf } from "./testing/fake-capture.ts";

describe("VoiceSession", () => {
	test("starts empty and arming", () => {
		const session = new VoiceSession({ seq: 7, maxBufferedAudioMs: 120_000 });
		expect(session.seq).toBe(7);
		expect(session.phase).toBe("arming");
		expect(session.transcript).toBe("");
		expect(session.stored).toBe(false);
	});

	test("pushChunk records audio and levels, never the stream", () => {
		const session = new VoiceSession({ seq: 0, maxBufferedAudioMs: 120_000 });
		const frames = session.pushChunk(pcmOf(800, 32_000));
		expect(session.audio.byteLength).toBe(32_000);
		expect(session.levels.snapshot().length).toBeGreaterThan(0);
		expect(frames.length).toBeGreaterThan(0);
	});
});
