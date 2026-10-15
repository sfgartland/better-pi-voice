/**
 * Deepgram streaming backend.
 *
 * `wss://api.deepgram.com/v1/listen` with nova-3: passive transcription with
 * server-side endpointing, which is what dictation wants (Flux is built for
 * turn-taking voice agents and would duplicate a decision we make ourselves).
 *
 * Two details that are easy to get wrong and are load-bearing:
 *
 *  1. `keyterm` is a REPEATED query parameter. A comma-joined list is accepted
 *     by the API and silently boosts nothing, so the sanitised terms are
 *     appended one by one.
 *  2. Deepgram closes an idle socket after 10 seconds, so a KeepAlive must be
 *     sent well inside that. Silence during dictation is normal, not an error.
 */

import { type Clock, systemClock, type TimerHandle } from "../clock.ts";
import type { FinalizeOutcome, StartOptions, VoiceBackend, VoiceEvent, VoiceStream } from "../types.ts";

const OPEN = 1;
const CLOSED = 3;
const DEFAULT_BASE_URL = "wss://api.deepgram.com/v1/listen";
const DEFAULT_KEEP_ALIVE_MS = 5000;
const DEFAULT_FINALIZE_SAFETY_MS = 5000;
const DEFAULT_SAMPLE_RATE = 16_000;
/** Deepgram's documented ceiling: 100 keyterms / 500 tokens per request. */
export const DEEPGRAM_MAX_KEYTERMS = 100;
const PRE_OPEN_BUFFER_BYTES = 160_000; // 5 seconds

export type SocketCloseEvent = { code?: number; reason?: string };

/** The slice of the WebSocket API this backend uses. */
export type MinimalSocket = {
	readyState: number;
	send(data: string | ArrayBufferView): void;
	close(code?: number, reason?: string): void;
	onopen: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	onclose: ((event: SocketCloseEvent) => void) | null;
};

export type SocketFactory = (url: string, apiKey: string) => MinimalSocket;

export type DeepgramQuery = {
	model: string;
	language: string;
	sampleRate: number;
	smartFormat: boolean;
	endpointingMs: number;
	utteranceEndMs: number;
	keyterms: readonly string[];
};

export type DeepgramBackendOptions = {
	apiKey: string | undefined;
	model?: string | undefined;
	language?: string | undefined;
	sampleRate?: number | undefined;
	smartFormat?: boolean | undefined;
	endpointingMs?: number | undefined;
	utteranceEndMs?: number | undefined;
	/** Overridable for EU/regional endpoints and for tests. */
	baseUrl?: string | undefined;
	keepAliveMs?: number | undefined;
	finalizeSafetyMs?: number | undefined;
	probeTimeoutMs?: number | undefined;
	clock?: Clock | undefined;
	socketFactory?: SocketFactory | undefined;
	/** Optional trace of the send/receive path, mirroring the reference's [voice_stream] logs. */
	debug?: ((message: string) => void) | undefined;
};

/**
 * Build the listen URL. Exported because the query string is the whole
 * contract with Deepgram and deserves to be asserted directly.
 */
export function buildListenUrl(query: DeepgramQuery, baseUrl: string = DEFAULT_BASE_URL): string {
	const params = new URLSearchParams();
	params.set("model", query.model);
	params.set("language", query.language);
	params.set("encoding", "linear16");
	params.set("sample_rate", String(query.sampleRate));
	params.set("channels", "1");
	params.set("interim_results", "true");
	params.set("endpointing", String(query.endpointingMs));
	params.set("utterance_end_ms", String(query.utteranceEndMs));
	if (query.smartFormat) params.set("smart_format", "true");
	for (const term of query.keyterms.slice(0, DEEPGRAM_MAX_KEYTERMS)) {
		// Repeated parameter, never comma-joined.
		params.append("keyterm", term);
	}
	return `${baseUrl}?${params.toString()}`;
}

/** Extract whatever an error event happens to carry. */
function socketErrorDetail(event: unknown): string | undefined {
	if (!event || typeof event !== "object") return undefined;
	const candidate = event as { message?: unknown; error?: { message?: unknown }; type?: unknown };
	if (typeof candidate.message === "string" && candidate.message.trim()) return candidate.message.trim();
	const nested = candidate.error?.message;
	if (typeof nested === "string" && nested.trim()) return nested.trim();
	if (typeof candidate.type === "string" && candidate.type.trim() && candidate.type !== "error") {
		return candidate.type.trim();
	}
	return undefined;
}

const defaultSocketFactory: SocketFactory = (url, apiKey) => {
	const ctor = WebSocket as unknown as new (url: string, protocols?: string[]) => MinimalSocket;
	// Deepgram's documented subprotocol auth. Verified against the live API:
	// a header-bearing options object hangs in the CONNECTING state under Bun,
	// and headers combined with an empty protocols array is rejected with
	// "Expected 101 status code". The subprotocol form opens cleanly in Bun,
	// Node and browsers alike, and needs no runtime detection.
	return new ctor(url, ["token", apiKey]);
};

type ResultsMessage = {
	type?: string;
	is_final?: boolean;
	speech_final?: boolean;
	channel?: { alternatives?: Array<{ transcript?: string }> };
	description?: string;
	message?: string;
	error_code?: string;
};

class DeepgramStream implements VoiceStream {
	private preOpen: Buffer[] = [];
	private preOpenBytes = 0;
	private keepAlive: TimerHandle | undefined;
	private finalized = false;
	private closed = false;
	private sentBytes = 0;
	private settle: ((outcome: FinalizeOutcome) => void) | undefined;

	constructor(
		private readonly socket: MinimalSocket,
		private readonly emit: (event: VoiceEvent) => void,
		private readonly clock: Clock,
		private readonly keepAliveMs: number,
		private readonly finalizeSafetyMs: number,
		private readonly debug: (message: string) => void = () => {},
	) {
		socket.onopen = () => this.onOpen();
		socket.onmessage = (event) => this.onMessage(event);
		socket.onerror = (event) => this.onError(event);
		socket.onclose = (event) => this.onClose(event);
	}

	feed(pcm: Buffer): void {
		if (this.closed || this.finalized) return;
		if (this.socket.readyState !== OPEN) {
			// The socket may still be connecting. Buffer rather than drop, bounded
			// so a hung connection cannot grow without limit.
			this.preOpen.push(Buffer.from(pcm));
			this.preOpenBytes += pcm.length;
			while (this.preOpenBytes > PRE_OPEN_BUFFER_BYTES && this.preOpen.length > 1) {
				const dropped = this.preOpen.shift()!;
				this.preOpenBytes -= dropped.length;
			}
			return;
		}
		this.send(pcm);
	}

	private send(pcm: Buffer): void {
		try {
			this.socket.send(pcm);
			this.sentBytes += pcm.length;
		} catch (error) {
			this.debug(`send failed after ${String(this.sentBytes)} bytes: ${String(error)}`);
		}
	}

	finalize(): Promise<FinalizeOutcome> {
		if (this.finalized) return Promise.resolve("already_closed");
		this.finalized = true;
		this.stopKeepAlive();

		if (this.socket.readyState === CLOSED || this.socket.readyState === 2 /* CLOSING */) {
			// The connection died before we asked. Audio fed late may never have
			// been decoded, so report it as unconfirmed and let the caller decide.
			return Promise.resolve("closed_early");
		}

		return new Promise<FinalizeOutcome>((resolve) => {
			let settled = false;
			const finish = (outcome: FinalizeOutcome) => {
				if (settled) return;
				settled = true;
				this.clock.clearTimeout(safety);
				this.settle = undefined;
				resolve(outcome);
			};
			const safety = this.clock.setTimeout(() => finish("timeout"), this.finalizeSafetyMs);
			this.settle = finish;
			try {
				this.socket.send(JSON.stringify({ type: "CloseStream" }));
			} catch {
				finish("closed_early");
			}
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.stopKeepAlive();
		try {
			this.socket.close();
		} catch {
			// Closing an already-dead socket is not an error worth reporting.
		}
	}

	isConnected(): boolean {
		return this.socket.readyState === OPEN;
	}

	/** Replace the whole keyterm list without reconnecting. */
	updateKeyterms(terms: string[]): void {
		if (this.closed || this.finalized || this.socket.readyState !== OPEN) return;
		try {
			this.socket.send(JSON.stringify({ type: "Configure", keyterms: terms.slice(0, DEEPGRAM_MAX_KEYTERMS) }));
		} catch {
			// A failed keyterm update must never break a working session.
		}
	}

	private onOpen(): void {
		this.debug(`socket open; flushing ${String(this.preOpenBytes)} buffered bytes`);
		for (const chunk of this.preOpen) this.send(chunk);
		this.preOpen = [];
		this.preOpenBytes = 0;
		this.keepAlive = this.clock.setTimeout(() => this.sendKeepAlive(), this.keepAliveMs);
	}

	private sendKeepAlive(): void {
		if (this.closed || this.finalized || this.socket.readyState !== OPEN) return;
		try {
			this.socket.send(JSON.stringify({ type: "KeepAlive" }));
		} catch {
			return;
		}
		this.keepAlive = this.clock.setTimeout(() => this.sendKeepAlive(), this.keepAliveMs);
	}

	private stopKeepAlive(): void {
		if (!this.keepAlive) return;
		this.clock.clearTimeout(this.keepAlive);
		this.keepAlive = undefined;
	}

	private onMessage(event: { data: unknown }): void {
		let message: ResultsMessage;
		try {
			message = JSON.parse(String(event.data)) as ResultsMessage;
		} catch {
			return;
		}
		this.debug(`recv ${message.type ?? "?"} (${String(this.sentBytes)} bytes sent so far)`);

		switch (message.type) {
			case "Results": {
				const text = message.channel?.alternatives?.[0]?.transcript ?? "";
				if (!text.trim()) return;
				if (message.is_final) {
					this.emit({ type: "final", text });
					return;
				}
				this.emit({ type: "interim", text });
				return;
			}
			case "UtteranceEnd":
				// A silence marker. The final Results for the utterance have already
				// been delivered, so there is nothing to forward.
				return;
			case "Metadata":
				// Sent after CloseStream: everything buffered has been transcribed.
				this.settle?.("complete");
				return;
			case "Error": {
				const description = message.description ?? message.message ?? message.error_code ?? "Deepgram error";
				this.emit({ type: "error", message: description, code: message.error_code ?? "deepgram_error" });
				return;
			}
			default:
				return;
		}
	}

	private onError(event?: unknown): void {
		if (this.finalized) return;
		// Bun, Node and browsers each put something different here, and on a
		// network failure the detail is the entire message.
		const detail = socketErrorDetail(event);
		this.emit({
			type: "error",
			message: detail ? `Voice stream connection error: ${detail}` : "Voice stream connection error.",
			code: "ws_error",
		});
	}

	private onClose(event: SocketCloseEvent): void {
		this.stopKeepAlive();
		if (this.settle) {
			// We asked the server to finish and it hung up instead of confirming.
			this.settle("closed_early");
			return;
		}
		if (this.finalized || this.closed) return;
		const code = event.code ?? 0;
		if (code === 1000 || code === 1005) return;
		this.emit({
			type: "error",
			message: `Voice connection closed unexpectedly (code ${code}).`,
			code: `ws_closed_${code}`,
		});
	}
}

export class DeepgramBackend implements VoiceBackend {
	readonly id = "deepgram";
	readonly capabilities = { streaming: true, biasing: "native" as const, languages: [] };
	readonly model: string;

	private readonly options: DeepgramBackendOptions;
	private readonly clock: Clock;
	private readonly socketFactory: SocketFactory;

	constructor(options: DeepgramBackendOptions) {
		this.options = options;
		this.model = options.model ?? "nova-3";
		this.clock = options.clock ?? systemClock;
		this.socketFactory = options.socketFactory ?? defaultSocketFactory;
	}

	async checkAvailability(): Promise<{ available: boolean; reason?: string }> {
		if (!this.options.apiKey) {
			return {
				available: false,
				reason:
					"Deepgram API key not found. Set it in the environment variable named by deepgram.apiKeyEnv in better-pi-voice.json.",
			};
		}
		return { available: true };
	}

	/** The REST root that matches the configured websocket endpoint. */
	private apiRoot(): string {
		return (this.options.baseUrl ?? DEFAULT_BASE_URL).replace(/^ws/, "http").replace(/\/listen\b.*$/, "");
	}

	/**
	 * Explain a connection failure. A websocket close code alone cannot tell a
	 * bad key apart from a dead network, and those need different fixes.
	 */
	async probe(): Promise<string> {
		const apiKey = this.options.apiKey;
		if (!apiKey) return "no API key is configured";
		try {
			const response = await fetch(`${this.apiRoot()}/projects`, {
				headers: { Authorization: `Token ${apiKey}` },
				signal: AbortSignal.timeout(this.options.probeTimeoutMs ?? 1500),
			});
			if (response.status === 401 || response.status === 403) return "Deepgram rejected the API key";
			if (response.ok) return `Deepgram is reachable (HTTP ${String(response.status)}), so the key is accepted`;
			return `Deepgram returned HTTP ${String(response.status)}`;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return /timeout|abort/i.test(message)
				? "Deepgram did not respond in time"
				: `could not reach Deepgram (${message})`;
		}
	}

	async start(options: StartOptions, emit: (event: VoiceEvent) => void): Promise<VoiceStream | undefined> {
		const apiKey = this.options.apiKey;
		if (!apiKey) return undefined;

		const url = buildListenUrl(
			{
				model: this.model,
				language: options.language || this.options.language || "en",
				sampleRate: this.options.sampleRate ?? DEFAULT_SAMPLE_RATE,
				smartFormat: this.options.smartFormat ?? true,
				endpointingMs: this.options.endpointingMs ?? 300,
				utteranceEndMs: this.options.utteranceEndMs ?? 1000,
				keyterms: options.keyterms,
			},
			this.options.baseUrl ?? DEFAULT_BASE_URL,
		);

		let socket: MinimalSocket;
		try {
			socket = this.socketFactory(url, apiKey);
		} catch (error) {
			emit({ type: "error", message: `Could not open the voice connection: ${String(error)}`, code: "ws_error" });
			return undefined;
		}

		return new DeepgramStream(
			socket,
			emit,
			this.clock,
			this.options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS,
			this.options.finalizeSafetyMs ?? DEFAULT_FINALIZE_SAFETY_MS,
			this.options.debug ?? (() => {}),
		);
	}
}
