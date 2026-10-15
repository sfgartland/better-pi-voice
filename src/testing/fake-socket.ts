import type { MinimalSocket, SocketCloseEvent } from "../backends/deepgram.ts";

/** A WebSocket the test drives by hand. */
export class FakeSocket implements MinimalSocket {
	readyState = 0; // CONNECTING
	readonly sent: Array<string | ArrayBufferView> = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onclose: ((event: SocketCloseEvent) => void) | null = null;

	constructor(
		readonly url: string,
		readonly apiKey: string,
	) {}

	send(data: string | ArrayBufferView): void {
		this.sent.push(data);
	}

	close(code?: number, reason?: string): void {
		this.readyState = 3;
		this.onclose?.({ code: code ?? 1000, reason });
	}

	// --- test controls ---

	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}

	emit(payload: unknown): void {
		this.onmessage?.({ data: JSON.stringify(payload) });
	}

	/** A transcript frame, in Deepgram's shape. */
	results(transcript: string, isFinal: boolean): void {
		this.emit({ type: "Results", is_final: isFinal, channel: { alternatives: [{ transcript }] } });
	}

	fail(): void {
		this.onerror?.({});
	}

	remoteClose(code = 1006, reason = ""): void {
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}

	get textSent(): string[] {
		return this.sent.filter((item): item is string => typeof item === "string");
	}

	get jsonSent(): unknown[] {
		return this.textSent.map((item) => JSON.parse(item) as unknown);
	}

	get binaryBytes(): number {
		return this.sent
			.filter((item): item is ArrayBufferView => typeof item !== "string")
			.reduce((total, item) => total + item.byteLength, 0);
	}
}

/** A socket factory that records every socket it hands out. */
export class FakeSocketFactory {
	readonly sockets: FakeSocket[] = [];

	create = (url: string, apiKey: string): FakeSocket => {
		const socket = new FakeSocket(url, apiKey);
		this.sockets.push(socket);
		return socket;
	};

	get last(): FakeSocket {
		const socket = this.sockets.at(-1);
		if (!socket) throw new Error("no socket was created");
		return socket;
	}
}
