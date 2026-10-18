import type { VoiceBackend, VoiceCapabilities, VoiceEvent, VoiceStream } from "../types.ts";

export type FakeStreamPlan = {
	/** Emitted immediately when the stream is created. */
	events?: VoiceEvent[];
	/** What `finalize()` reports. Defaults to "complete". */
	finalizeOutcome?: import("../types.ts").FinalizeOutcome;
	/** Emitted from `finalize()`, simulating a final the server had buffered. */
	finalOnFinalize?: string;
	/** Reported by `isConnected()`. Defaults to true. */
	connected?: boolean;
	/** Make `feed()` return a rejected promise. */
	feedFails?: boolean;
	/** Run when `finalize()` is called, for assertions mid-flight. */
	onFinalize?: (stream: FakeStream) => void;
	/** Hold `finalize()` open until this resolves, so a later job can finish first. */
	finalizeGate?: Promise<void>;
};

export class FakeStream implements VoiceStream {
	readonly received: Buffer[] = [];
	readonly keytermUpdates: string[][] = [];
	feedCount = 0;
	finalizeCount = 0;
	cutCount = 0;
	closed = false;

	constructor(
		private readonly emit: (event: VoiceEvent) => void,
		public plan: FakeStreamPlan = {},
	) {}

	get bytesReceived(): number {
		return this.received.reduce((total, chunk) => total + chunk.length, 0);
	}

	feed(pcm: Buffer): void | Promise<void> {
		if (this.closed) throw new Error("feed() called on a closed stream");
		this.feedCount++;
		this.received.push(Buffer.from(pcm));
		if (this.plan.feedFails) return Promise.reject(new Error("feed failed"));
		return undefined;
	}

	async finalize(): Promise<import("../types.ts").FinalizeOutcome> {
		this.finalizeCount++;
		this.plan.onFinalize?.(this);
		if (this.plan.finalizeGate) await this.plan.finalizeGate;
		if (this.plan.finalOnFinalize) {
			this.emit({ type: "final", text: this.plan.finalOnFinalize });
		}
		return this.plan.finalizeOutcome ?? "complete";
	}

	close(): void {
		this.closed = true;
	}

	cut(): void {
		this.cutCount++;
	}

	isConnected(): boolean {
		return this.plan.connected ?? true;
	}

	updateKeyterms(terms: string[]): void {
		this.keytermUpdates.push([...terms]);
	}
}

/** A backend that does exactly what a test tells it to. */
export class FakeBackend implements VoiceBackend {
	readonly id = "fake";
	readonly model = "fake-model";
	capabilities: VoiceCapabilities = { streaming: true, biasing: "native", languages: ["en"] };

	/** One plan per `start()` call, consumed in order. */
	plans: FakeStreamPlan[] = [];
	streams: FakeStream[] = [];
	startCount = 0;
	lastOptions: import("../types.ts").StartOptions | undefined;
	availability: { available: boolean; reason?: string } = { available: true };
	/** Number of upcoming `start()` calls that return undefined (could not connect). */
	failToConnect = 0;
	/** Simulate a backend that takes a while to become ready (model load, connect). */
	startDelayMs = 0;
	/** Hold `start()` open until this resolves, so shutdown can race the connect. */
	startGate: Promise<void> | undefined;
	/** How often the runtime's shutdown cleanup reached the backend. */
	disposeCount = 0;

	get last(): FakeStream | undefined {
		return this.streams.at(-1);
	}

	async checkAvailability(): Promise<{ available: boolean; reason?: string }> {
		return this.availability;
	}

	async start(
		options: import("../types.ts").StartOptions,
		emit: (event: VoiceEvent) => void,
	): Promise<VoiceStream | undefined> {
		this.startCount++;
		this.lastOptions = options;
		if (this.startDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.startDelayMs));
		if (this.startGate) await this.startGate;
		if (this.failToConnect > 0) {
			this.failToConnect--;
			return undefined;
		}
		const plan = this.plans.shift() ?? {};
		const stream = new FakeStream(emit, plan);
		this.streams.push(stream);
		for (const event of plan.events ?? []) emit(event);
		return stream;
	}

	async dispose(): Promise<void> {
		this.disposeCount++;
	}
}
