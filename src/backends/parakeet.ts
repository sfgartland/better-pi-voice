/**
 * Local backend: Parakeet via transcribe-cpp.
 *
 * The honest limitation: Parakeet cannot be vocabulary-biased. transcribe-cpp's
 * `StreamOptions` carries no prompt field, and `initialPrompt` exists only in
 * `WhisperRunOptions` — the whisper family is a run-slot (batch) extension, not
 * a stream-slot one. So this backend reports `biasing: "none"` and the
 * controller applies the conservative correction pass instead.
 *
 * What it does share with the cloud path is the architecture: real streaming,
 * `commitPolicy: "stable_prefix"` so committed text is genuinely append-only,
 * and the same interim/final event shape.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Clock, systemClock, type TimerHandle } from "../clock.ts";
import { float32ToS16le, s16leToFloat32 } from "../formats.ts";
import type { FinalizeOutcome, StartOptions, VoiceBackend, VoiceEvent, VoiceStream } from "../types.ts";

type StreamText = { full: string; committed: string; tentative: string };
type StreamUpdate = {
	resultChanged: boolean;
	isFinal: boolean;
	revision: number;
	committedChanged: boolean;
	tentativeChanged: boolean;
};
/**
 * Two different objects, which is easy to confuse:
 *  - `stream.text` is the live `StreamText` (committed / tentative).
 *  - `stream.snapshot` is the whole `Transcript` (text, words, tokens, timings).
 */
type CppTranscript = { text?: string };
type CppStream = {
	feed(pcm: Float32Array): Promise<StreamUpdate>;
	finalize(): Promise<unknown>;
	reset(): void;
	readonly text: StreamText;
	readonly snapshot: CppTranscript;
};
type CppSession = { stream(options: Record<string, unknown>): Promise<CppStream>; dispose(): void };
type CppModel = {
	readonly capabilities: { supportsStreaming: boolean; languages: string[]; nativeSampleRate: number };
	createSession(): CppSession;
	transcribe(pcm: Float32Array, options?: Record<string, unknown>): Promise<{ text: string }>;
	dispose(): void;
};

/**
 * Deliberately not a string literal: transcribe-cpp is an optional dependency,
 * so it may genuinely be absent and must not become a compile-time requirement.
 */
const TRANSCRIBE_CPP = "transcribe-cpp";

let transcribeModule: Promise<unknown> | undefined;

/**
 * Load transcribe-cpp, which is not necessarily next to this file.
 *
 * It usually lives in pi's own package directory (`~/.pi/agent/npm/node_modules`)
 * as a dependency of another extension, so a plain import fails when this
 * extension is loaded from a local path. Try ordinary resolution first, then walk
 * the places pi actually puts things and read the package's own entry point.
 */
async function loadTranscribeCpp(): Promise<unknown> {
	if (transcribeModule) return transcribeModule;

	const roots = [
		join(getAgentDir(), "npm", "node_modules"),
		join(getAgentDir(), "node_modules"),
		join(process.cwd(), "node_modules"),
	];

	const loading = (async () => {
		try {
			return await import(TRANSCRIBE_CPP);
		} catch {
			// Fall through to explicit locations.
		}

		for (const root of roots) {
			const entry = await resolvePackageEntry(join(root, TRANSCRIBE_CPP));
			if (!entry) continue;
			try {
				return await import(pathToFileURL(entry).href);
			} catch {
				// Try the next location.
			}
		}

		throw new Error(`could not load ${TRANSCRIBE_CPP} from ${roots.join(", ")}`);
	})();

	// A failed load must not be cached as a permanent verdict on this process.
	loading.catch(() => {
		transcribeModule = undefined;
	});
	transcribeModule = loading;
	return loading;
}

/** Read a package's declared entry point, falling back to the conventional path. */
async function resolvePackageEntry(packageDir: string): Promise<string | undefined> {
	const conventional = join(packageDir, "dist", "index.js");
	try {
		const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
			main?: unknown;
			module?: unknown;
			exports?: unknown;
		};
		const candidates: unknown[] = [];
		const root = manifest.exports;
		if (typeof root === "string") candidates.push(root);
		else if (root && typeof root === "object") {
			const dot = (root as Record<string, unknown>)["."];
			if (typeof dot === "string") candidates.push(dot);
			else if (dot && typeof dot === "object") {
				const conditions = dot as Record<string, unknown>;
				candidates.push(conditions.import, conditions.default, conditions.require);
			}
		}
		candidates.push(manifest.module, manifest.main, "dist/index.js");

		for (const candidate of candidates) {
			if (typeof candidate !== "string") continue;
			const resolved = join(packageDir, candidate);
			if (existsSync(resolved)) return resolved;
		}
	} catch {
		// No manifest, or unreadable: the conventional path is still worth a try.
	}
	return existsSync(conventional) ? conventional : undefined;
}

/** Weight for how many consecutive stable revisions a prefix needs before committing. */
const STABLE_PREFIX_AGREEMENT = 3;

/**
 * Where the Parakeet GGUF lives. Explicit setting first, then pi-voice's own
 * configuration (so an existing install keeps working), then nothing.
 */
export async function resolveParakeetModelPath(explicit: string | null): Promise<string | undefined> {
	if (explicit && existsSync(explicit)) return explicit;

	try {
		const raw = JSON.parse(await readFile(join(getAgentDir(), "pi-voice.json"), "utf8")) as {
			model?: { path?: unknown };
		};
		const path = raw.model?.path;
		if (typeof path === "string" && existsSync(path)) return path;
	} catch {
		// pi-voice is not installed or has no settings; that is fine.
	}

	return undefined;
}

/** Loaded models are held for this long after the last session ends. */
export const DEFAULT_IDLE_UNLOAD_MS = 15 * 60_000;
/** How often to check whether the machine has become busy while idle. */
export const DEFAULT_LOAD_CHECK_MS = 60_000;
/** One-minute load average per CPU at which the model is handed back early. */
export const DEFAULT_LOAD_SHED_RATIO = 0.8;

/** One-minute load average per CPU. Zero on platforms that do not report it. */
export function defaultSystemLoad(): number {
	try {
		const cores = cpus().length || 1;
		return (loadavg()[0] ?? 0) / cores;
	} catch {
		return 0;
	}
}

export type ParakeetBackendOptions = {
	modelPath: string | null;
	language?: string | undefined;
	/**
	 * Keep the model in memory this long after the last session, because loading
	 * it is slow enough that unloading immediately would be felt on the next
	 * recording. Zero unloads as soon as a session ends.
	 */
	idleUnloadMs?: number | undefined;
	/** Hand the memory back early once load per CPU reaches this. */
	loadShedRatio?: number | undefined;
	/** How often to re-check system load during the idle window. */
	loadCheckMs?: number | undefined;
	clock?: Clock | undefined;
	/** Injectable for tests. */
	systemLoad?: (() => number) | undefined;
	/** Injectable for tests, so residency can be exercised without a GGUF. */
	loadModel?: ((path: string) => Promise<CppModel>) | undefined;
};

async function defaultLoadModel(path: string): Promise<CppModel> {
	const { TranscribeModel } = (await loadTranscribeCpp()) as unknown as {
		TranscribeModel: { load(path: string): Promise<CppModel> };
	};
	return TranscribeModel.load(path);
}

class ParakeetStream implements VoiceStream {
	private committed = "";
	private closed = false;
	private finalizeStarted = false;
	private failure: string | undefined;
	private pending = Promise.resolve();

	constructor(
		private readonly stream: CppStream,
		private readonly session: CppSession,
		private readonly emit: (event: VoiceEvent) => void,
		private readonly onReleased: () => void = () => {},
	) {}

	feed(pcm: Buffer): void | Promise<void> {
		if (this.closed) return;
		// Convert first: the Float32Array we own is the buffer transcribe-cpp
		// borrows, so no additional copy is needed.
		const samples = s16leToFloat32(pcm);
		// Serialise: transcribe-cpp requires feeds to be scheduled one at a time.
		this.pending = this.pending
			.then(async () => {
				if (this.closed) return;
				const update = await this.stream.feed(samples);
				this.publish(update);
			})
			.catch((error: unknown) => {
				// Surface the cause once rather than silently producing nothing. The
				// usual culprit is the native build failing to initialise a backend.
				this.reportFailure(error);
			});
		return this.pending;
	}

	async finalize(): Promise<FinalizeOutcome> {
		if (this.finalizeStarted) return "already_closed";
		this.finalizeStarted = true;
		try {
			await this.pending;
			if (this.failure) return "closed_early";
			await this.stream.finalize();

			const live = this.liveText();
			this.commitDifference(live.committed);

			// Prefer whatever is still uncommitted, using the full transcript as the
			// authority and the tentative tail as the last resort.
			const full = (this.stream.snapshot?.text?.trim() || live.full.trim() || "").trim();
			const remaining = full.startsWith(this.committed) ? full.slice(this.committed.length).trim() : "";
			if (remaining) this.emit({ type: "final", text: remaining });
			else {
				const tail = live.tentative.trim();
				if (tail && !this.committed.endsWith(tail)) this.emit({ type: "final", text: tail });
			}
			return "complete";
		} catch (error) {
			this.reportFailure(error);
			return "closed_early";
		} finally {
			this.release();
		}
	}

	private reportFailure(error: unknown): void {
		if (this.failure || this.closed) return;
		const message = error instanceof Error ? error.message : String(error);
		this.failure = message;
		this.emit({ type: "error", message: `Local transcription failed: ${message}`, code: "local_failed" });
	}

	close(): void {
		this.release();
	}

	isConnected(): boolean {
		return !this.closed;
	}

	private publish(update: StreamUpdate): void {
		if (this.closed) return;
		const live = this.liveText();
		if (update.committedChanged) this.commitDifference(live.committed);
		if (update.tentativeChanged && live.tentative.trim()) {
			this.emit({ type: "interim", text: live.tentative });
		}
	}

	/** `stream.text` should always be present, but a missing field must not crash a session. */
	private liveText(): StreamText {
		const live = this.stream.text;
		return {
			full: live?.full ?? "",
			committed: live?.committed ?? "",
			tentative: live?.tentative ?? "",
		};
	}

	/** Emit only the newly-stable suffix, so finals stay append-only. */
	private commitDifference(committed: string): void {
		if (!committed.startsWith(this.committed)) {
			// A revision rewrote history. Treat the committed text as authoritative
			// and emit nothing further rather than corrupting what was appended.
			this.committed = committed;
			return;
		}
		const delta = committed.slice(this.committed.length).trim();
		this.committed = committed;
		if (delta) this.emit({ type: "final", text: delta });
	}

	private release(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.stream.reset();
		} catch {
			// ignore
		}
		this.session.dispose();
		this.onReleased();
	}
}

export class ParakeetBackend implements VoiceBackend {
	readonly id = "parakeet";
	readonly capabilities = { streaming: true, biasing: "none" as const, languages: [] };
	readonly model = "parakeet";

	private resolution: Promise<string | undefined> | undefined;
	private model_: CppModel | undefined;
	private idleTimer: TimerHandle | undefined;
	private loadTimer: TimerHandle | undefined;
	private readonly clock: Clock;
	private readonly idleUnloadMs: number;
	private readonly loadShedRatio: number;
	private readonly loadCheckMs: number;

	constructor(private readonly options: ParakeetBackendOptions) {
		this.clock = options.clock ?? systemClock;
		this.idleUnloadMs = options.idleUnloadMs ?? DEFAULT_IDLE_UNLOAD_MS;
		this.loadShedRatio = options.loadShedRatio ?? DEFAULT_LOAD_SHED_RATIO;
		this.loadCheckMs = options.loadCheckMs ?? DEFAULT_LOAD_CHECK_MS;
	}

	/** Whether the model is currently resident. Exposed for tests and diagnostics. */
	get modelLoaded(): boolean {
		return this.model_ !== undefined;
	}

	/**
	 * Drop the model and free its memory. Called on the idle timer, when the
	 * machine is busy, and on shutdown.
	 */
	unload(): void {
		this.cancelIdleTimers();
		const model = this.model_;
		this.model_ = undefined;
		try {
			model?.dispose();
		} catch {
			// Disposing a model that is already gone is not worth reporting.
		}
	}

	async dispose(): Promise<void> {
		this.unload();
	}

	private cancelIdleTimers(): void {
		if (this.idleTimer) {
			this.clock.clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
		if (this.loadTimer) {
			this.clock.clearTimeout(this.loadTimer);
			this.loadTimer = undefined;
		}
	}

	/** A session has ended: hold the model briefly, then let it go. */
	private scheduleIdleUnload(): void {
		this.cancelIdleTimers();
		if (!this.model_) return;
		if (this.idleUnloadMs <= 0) {
			this.unload();
			return;
		}
		this.idleTimer = this.clock.setTimeout(() => this.unload(), this.idleUnloadMs);
		this.loadTimer = this.clock.setTimeout(() => this.checkSystemLoad(), this.loadCheckMs);
	}

	/** Give the memory back early rather than waiting out the whole idle window. */
	private checkSystemLoad(): void {
		this.loadTimer = undefined;
		if (!this.model_) return;
		if (this.currentLoad() >= this.loadShedRatio) {
			this.unload();
			return;
		}
		this.loadTimer = this.clock.setTimeout(() => this.checkSystemLoad(), this.loadCheckMs);
	}

	private currentLoad(): number {
		try {
			return this.options.systemLoad?.() ?? defaultSystemLoad();
		} catch {
			return 0;
		}
	}

	private loadModel(path: string): Promise<CppModel> {
		return this.options.loadModel?.(path) ?? defaultLoadModel(path);
	}

	private resolvePath(): Promise<string | undefined> {
		this.resolution ??= resolveParakeetModelPath(this.options.modelPath);
		return this.resolution;
	}

	async checkAvailability(): Promise<{ available: boolean; reason?: string }> {
		const path = await this.resolvePath();
		if (!path) {
			return {
				available: false,
				reason:
					"No Parakeet model found. Set parakeet.modelPath in better-pi-voice.json, or configure a model in pi-voice first.",
			};
		}
		try {
			await loadTranscribeCpp();
		} catch {
			return {
				available: false,
				reason:
					"The transcribe-cpp package is not installed, so the local backend is unavailable. Use the Deepgram backend instead.",
			};
		}
		return { available: true };
	}

	async start(options: StartOptions, emit: (event: VoiceEvent) => void): Promise<VoiceStream | undefined> {
		const path = await this.resolvePath();
		if (!path) return undefined;

		// A session is starting, so a pending unload must not fire underneath it.
		this.cancelIdleTimers();

		let model: CppModel;
		try {
			if (!this.model_) {
				this.model_ = await this.loadModel(path);
			}
			model = this.model_;
		} catch (error) {
			emit({
				type: "error",
				message: `Could not load the Parakeet model: ${String(error)}`,
				code: "model_load_failed",
			});
			return undefined;
		}

		if (!model.capabilities.supportsStreaming) {
			emit({
				type: "error",
				message: "The configured Parakeet build does not support streaming transcription.",
				code: "no_streaming",
			});
			return undefined;
		}

		try {
			const session = model.createSession();
			const stream = await session.stream({
				timestamps: "none",
				language: options.language || this.options.language || "en",
				// Stable-prefix committing is exactly the append-only discipline the
				// controller wants, and transcribe-cpp exposes it directly.
				commitPolicy: "stable_prefix" as const,
				stablePrefixAgreementN: STABLE_PREFIX_AGREEMENT,
			});
			return new ParakeetStream(stream, session, emit, () => this.scheduleIdleUnload());
		} catch (error) {
			emit({
				type: "error",
				message: `Could not start the local transcriber: ${String(error)}`,
				code: "stream_start_failed",
			});
			return undefined;
		}
	}
}

/** Exported for the smoke script: convert a raw PCM file for a batch transcribe. */
export function pcmToFloat32(pcm: Buffer): Float32Array {
	return s16leToFloat32(pcm);
}

/** Exported for round-trip use in tests. */
export function float32ToPcm(samples: Float32Array): Buffer {
	return float32ToS16le(samples);
}
