/**
 * The backend contract.
 *
 * This is deliberately NOT modelled on the reference implementation's wire
 * vocabulary (`endpoint`, `no_data_timeout`, `ws_close`). Deepgram has those
 * states; the local backend does not. Backends map their own outcome onto
 * `FinalizeOutcome`, and the controller's recovery rules key off that instead.
 */

export type VoiceCapabilities = {
	/** Can emit interim (tentative) text while the user is still speaking. */
	streaming: boolean;
	/**
	 * "native"  — the keyterms we pass actually change decoding (Deepgram).
	 * "none"    — the backend cannot be biased; the correction pass may help (Parakeet).
	 */
	biasing: "native" | "none";
	/** Advisory list; an empty array means the backend decides the language itself. */
	languages: string[];
};

export type VoiceEvent =
	/** Tentative text. May be superseded by a later interim or a final. */
	| { type: "interim"; text: string }
	/** Committed text. Never retracted; append-only. */
	| { type: "final"; text: string }
	| { type: "error"; message: string; fatal?: boolean; code?: string };

export type StartOptions = {
	language: string;
	/** Already sanitised by `keyterms/sanitize.ts`. */
	keyterms: string[];
	signal: AbortSignal;
};

export type FinalizeOutcome =
	/** Everything fed was accounted for (or nothing was spoken). */
	| "complete"
	/** The session died; audio fed late may never have been decoded. */
	| "closed_early"
	/** No confirmation within the safety window. */
	| "timeout"
	| "already_closed";

export type VoiceStream = {
	/**
	 * Enqueue PCM (s16le, 16 kHz, mono). Must never throw.
	 *
	 * May be async: `transcribe-cpp`'s `Stream.feed()` returns a promise and
	 * borrows the buffer until it resolves, whereas Deepgram just writes to a
	 * socket. The controller calls this fire-and-forget (it does not await each
	 * frame), so on a slow decoder audio can queue ahead of transcription; the
	 * backlog is bounded by the session's in-memory audio cap and the controller
	 * logs when it grows.
	 */
	feed(pcm: Buffer): void | Promise<void>;
	finalize(): Promise<FinalizeOutcome>;
	close(): void;
	isConnected(): boolean;
	/** Optional mid-session keyterm update (Deepgram `Configure`). */
	updateKeyterms?(terms: string[]): void;
};

export type VoiceBackend = {
	readonly id: string;
	readonly capabilities: VoiceCapabilities;
	/** Human-readable model identifier, for status text. */
	readonly model: string;
	checkAvailability(): Promise<{ available: boolean; reason?: string }>;
	/** Resolve to `undefined` when the stream could not be started at all. */
	start(options: StartOptions, emit: (event: VoiceEvent) => void): Promise<VoiceStream | undefined>;
	/**
	 * Optional diagnostic run after a connection failure, so the message can say
	 * *why* it failed instead of telling the user to check their network.
	 * Resolves to a short phrase such as "Deepgram rejected the API key".
	 */
	probe?(): Promise<string>;
	/** Optional: release anything held while idle, such as a loaded local model. */
	dispose?(): void | Promise<void>;
};
