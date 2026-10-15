import type { Capture, CaptureStartResult } from "../capture.ts";

/** A microphone the test drives by hand. */
export class FakeCapture implements Capture {
	availability: { available: boolean; reason?: string } = { available: true };
	/** Override the result of the next `start()`. */
	startResult: CaptureStartResult | undefined;
	startCount = 0;
	stopCount = 0;

	private onData: ((chunk: Buffer) => void) | undefined;
	private onEnd: (() => void) | undefined;

	async checkAvailability(): Promise<{ available: boolean; reason?: string }> {
		return this.availability;
	}

	async start(onData: (chunk: Buffer) => void, onEnd: () => void): Promise<CaptureStartResult> {
		this.startCount++;
		this.onData = onData;
		this.onEnd = onEnd;
		if (this.startResult) return this.startResult;
		return { ok: true, session: { stop: () => this.stopCount++ } };
	}

	/** Push audio as the microphone would. */
	emit(chunk: Buffer): void {
		this.onData?.(chunk);
	}

	/** The recorder process died. */
	end(): void {
		this.onEnd?.();
	}

	get isStarted(): boolean {
		return this.onData !== undefined;
	}
}

/** s16le PCM at a constant amplitude, for driving the level meter. */
export function pcmOf(amplitude: number, bytes: number): Buffer {
	const buf = Buffer.alloc(bytes);
	for (let i = 0; i + 1 < bytes; i += 2) buf.writeInt16LE(amplitude, i);
	return buf;
}
