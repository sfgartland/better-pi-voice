/**
 * Audio plumbing: PCM conversion, level metering, and frame coalescing.
 *
 * Internal capture contract: a stream of Buffers of PCM s16le, 16 kHz, mono.
 * Everything else converts at the edges.
 */

export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2;
/** One second of 16 kHz mono s16le — the reference implementation's frame cap. */
export const COALESCE_BYTES = 32_000;
/** Rolling window length for the level widget (reference parity). */
export const LEVEL_WINDOW = 16;
/** A level above this counts as "the microphone heard something". */
export const AUDIO_SIGNAL_THRESHOLD = 0.01;

/**
 * Perceptual-ish level for a chunk of s16le.
 *
 * Mirrors the reference: RMS over 16-bit samples, normalised against 2000,
 * then square-rooted to push quiet speech up the visual range. Returns 0..1.
 */
export function levelFromS16le(buf: Buffer): number {
	const samples = buf.length >> 1;
	if (samples === 0) return 0;
	let sum = 0;
	for (let i = 0; i < buf.length - 1; i += 2) {
		// Read as signed 16-bit little-endian.
		const sample = ((buf[i]! | (buf[i + 1]! << 8)) << 16) >> 16;
		sum += sample * sample;
	}
	const rms = Math.sqrt(sum / samples);
	return Math.sqrt(Math.min(rms / 2000, 1));
}

/** s16le → Float32 in [-1, 1). The Float32Array is a fresh copy the caller owns. */
export function s16leToFloat32(buf: Buffer): Float32Array {
	const out = new Float32Array(buf.length >> 1);
	for (let i = 0, o = 0; i < buf.length - 1; i += 2, o++) {
		out[o] = (((buf[i]! | (buf[i + 1]! << 8)) << 16) >> 16) / 32768;
	}
	return out;
}

/** Float32 in [-1, 1] → s16le. Clamps rather than wrapping. */
export function float32ToS16le(samples: Float32Array): Buffer {
	const out = Buffer.allocUnsafe(samples.length * BYTES_PER_SAMPLE);
	for (let i = 0; i < samples.length; i++) {
		const clamped = Math.max(-1, Math.min(1, samples[i]!));
		out.writeInt16LE(Math.round(clamped * 32767), i * BYTES_PER_SAMPLE);
	}
	return out;
}

/**
 * Linear-interpolation resampler. Only used when the capture device refuses to
 * give us 16 kHz — ALSA normally resamples for us. Adequate for speech; not a
 * polyphase filter, and deliberately so.
 */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
	if (fromRate === toRate || input.length === 0) return input;
	const ratio = fromRate / toRate;
	const length = Math.floor(input.length / ratio);
	const out = new Float32Array(length);
	for (let i = 0; i < length; i++) {
		const pos = i * ratio;
		const left = Math.floor(pos);
		const right = Math.min(left + 1, input.length - 1);
		const frac = pos - left;
		out[i] = input[left]! * (1 - frac) + input[right]! * frac;
	}
	return out;
}

/**
 * Accumulates arbitrary-sized PCM chunks and emits frames of at most
 * `COALESCE_BYTES`, so a chatty capture device does not produce one WebSocket
 * frame per read.
 */
export class FrameCoalescer {
	private pending: Buffer[] = [];
	private pendingBytes = 0;

	constructor(private readonly maxBytes: number = COALESCE_BYTES) {}

	push(chunk: Buffer): Buffer[] {
		const out: Buffer[] = [];
		let rest: Buffer | undefined = chunk;
		while (rest && rest.length > 0) {
			const space = this.maxBytes - this.pendingBytes;
			if (rest.length < space) {
				this.pending.push(rest);
				this.pendingBytes += rest.length;
				rest = undefined;
			} else {
				// Fill and emit immediately: holding a full frame until the next
				// read would add latency for no benefit.
				this.pending.push(rest.subarray(0, space));
				this.pendingBytes += space;
				rest = rest.subarray(space);
				out.push(this.take());
			}
		}
		return out;
	}

	/** Emit whatever is buffered, even if it is short. Used at finalize. */
	flush(): Buffer | undefined {
		if (this.pendingBytes === 0) return undefined;
		return this.take();
	}

	get bufferedBytes(): number {
		return this.pendingBytes;
	}

	private take(): Buffer {
		const joined = this.pending.length === 1 ? this.pending[0]! : Buffer.concat(this.pending);
		this.pending = [];
		this.pendingBytes = 0;
		return joined;
	}
}

/** Fixed-length ring of recent levels, oldest first, for the level widget. */
export class LevelRing {
	private readonly values: number[] = [];

	constructor(private readonly size: number = LEVEL_WINDOW) {}

	push(level: number): void {
		this.values.push(level);
		if (this.values.length > this.size) this.values.splice(0, this.values.length - this.size);
	}

	snapshot(): number[] {
		return [...this.values];
	}

	clear(): void {
		this.values.length = 0;
	}
}

/**
 * Retains the audio of one session in memory.
 *
 * Two jobs: hand the stream whatever has not been sent yet (audio that arrived
 * while the connection was still opening), and keep the whole session so a
 * silently dropped connection can be replayed. Never touches disk.
 */
export class AudioRecorder {
	private chunks: Buffer[] = [];
	private bytes = 0;
	/** Bytes handed to the stream so far, counted from the start of `chunks`. */
	private sent = 0;
	private droppedUnsent = false;

	constructor(private readonly maxBytes: number) {}

	append(chunk: Buffer): void {
		if (chunk.length === 0) return;
		this.chunks.push(chunk);
		this.bytes += chunk.length;
		while (this.bytes > this.maxBytes && this.chunks.length > 1) {
			const dropped = this.chunks.shift()!;
			this.bytes -= dropped.length;
			if (this.sent > 0) this.sent = Math.max(0, this.sent - dropped.length);
			else this.droppedUnsent = true;
		}
	}

	/** True once audio was discarded, which makes a faithful replay impossible. */
	get truncated(): boolean {
		return this.droppedUnsent;
	}

	get byteLength(): number {
		return this.bytes;
	}

	/** Everything not yet handed to the stream. */
	unsent(): Buffer | undefined {
		const offset = this.sent;
		if (offset >= this.bytes) return undefined;
		let skip = offset;
		const parts: Buffer[] = [];
		for (const chunk of this.chunks) {
			if (skip >= chunk.length) {
				skip -= chunk.length;
				continue;
			}
			parts.push(skip > 0 ? chunk.subarray(skip) : chunk);
			skip = 0;
		}
		if (parts.length === 0) return undefined;
		return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
	}

	markAllSent(): void {
		this.sent = this.bytes;
	}

	/** The complete retained session, for replay. */
	all(): Buffer | undefined {
		if (this.bytes === 0) return undefined;
		return this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
	}

	clear(): void {
		this.chunks = [];
		this.bytes = 0;
		this.sent = 0;
		this.droppedUnsent = false;
	}
}
