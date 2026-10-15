import { describe, expect, test } from "bun:test";
import { FakeClock } from "../testing/fake-clock.ts";
import { FakeSocketFactory } from "../testing/fake-socket.ts";
import type { VoiceEvent } from "../types.ts";
import { buildListenUrl, DeepgramBackend } from "./deepgram.ts";

function makeBackend(factory: FakeSocketFactory, clock: FakeClock, overrides: Record<string, unknown> = {}) {
	return new DeepgramBackend({
		apiKey: "test-key",
		clock,
		socketFactory: factory.create,
		...overrides,
	});
}

function startOptions(keyterms: string[] = []) {
	return { language: "en", keyterms, signal: new AbortController().signal };
}

async function started(overrides: Record<string, unknown> = {}, keyterms: string[] = []) {
	const factory = new FakeSocketFactory();
	const clock = new FakeClock();
	const backend = makeBackend(factory, clock, overrides);
	const events: VoiceEvent[] = [];
	const stream = await backend.start(startOptions(keyterms), (event) => events.push(event));
	if (!stream) throw new Error("backend did not start");
	return { factory, clock, backend, events, stream, socket: factory.last };
}

describe("buildListenUrl", () => {
	const query = {
		model: "nova-3",
		language: "en",
		sampleRate: 16_000,
		smartFormat: true,
		endpointingMs: 300,
		utteranceEndMs: 1000,
		keyterms: [],
	};

	test("sets the audio contract explicitly", () => {
		const url = new URL(buildListenUrl(query));
		expect(url.protocol).toBe("wss:");
		expect(url.pathname).toBe("/v1/listen");
		expect(url.searchParams.get("encoding")).toBe("linear16");
		expect(url.searchParams.get("sample_rate")).toBe("16000");
		expect(url.searchParams.get("channels")).toBe("1");
		expect(url.searchParams.get("model")).toBe("nova-3");
	});

	test("enables interim results and endpointing", () => {
		const url = new URL(buildListenUrl(query));
		expect(url.searchParams.get("interim_results")).toBe("true");
		expect(url.searchParams.get("endpointing")).toBe("300");
		expect(url.searchParams.get("utterance_end_ms")).toBe("1000");
		expect(url.searchParams.get("smart_format")).toBe("true");
	});

	test("omits smart_format when it is off", () => {
		const url = new URL(buildListenUrl({ ...query, smartFormat: false }));
		expect(url.searchParams.has("smart_format")).toBe(false);
	});

	test("repeats keyterm rather than joining with commas", () => {
		// A comma-joined list is accepted by Deepgram and silently boosts nothing.
		const url = new URL(buildListenUrl({ ...query, keyterms: ["subagent", "worktree", "tsconfig"] }));
		expect(url.searchParams.getAll("keyterm")).toEqual(["subagent", "worktree", "tsconfig"]);
		expect(buildListenUrl({ ...query, keyterms: ["a", "b"] })).not.toContain("keyterm=a,b");
	});

	test("encodes a multi-word phrase as one keyterm", () => {
		const url = new URL(buildListenUrl({ ...query, keyterms: ["customer service"] }));
		expect(url.searchParams.getAll("keyterm")).toEqual(["customer service"]);
	});

	test("caps the number of keyterms", () => {
		const many = Array.from({ length: 150 }, (_, i) => `term${i}`);
		const url = new URL(buildListenUrl({ ...query, keyterms: many }));
		expect(url.searchParams.getAll("keyterm").length).toBe(100);
	});

	test("honours a regional base URL", () => {
		expect(buildListenUrl(query, "wss://api.eu.deepgram.com/v1/listen")).toStartWith("wss://api.eu.deepgram.com");
	});
});

describe("DeepgramBackend.start", () => {
	test("reports a missing key rather than failing obscurely", async () => {
		const backend = new DeepgramBackend({ apiKey: undefined });
		const availability = await backend.checkAvailability();
		expect(availability.available).toBe(false);
		expect(availability.reason).toContain("Deepgram API key");
	});

	test("passes the api key to the socket factory", async () => {
		const { socket } = await started();
		expect(socket.apiKey).toBe("test-key");
	});

	test("buffers audio until the socket opens, then flushes in order", async () => {
		const { stream, socket } = await started();

		stream.feed(Buffer.from([1, 1]));
		stream.feed(Buffer.from([2, 2]));
		expect(socket.binaryBytes).toBe(0);

		socket.open();
		expect(socket.binaryBytes).toBe(4);
		expect(socket.sent[0]).toEqual(Buffer.from([1, 1]));
		expect(socket.sent[1]).toEqual(Buffer.from([2, 2]));
	});

	test("sends audio straight through once open", async () => {
		const { stream, socket } = await started();
		socket.open();
		stream.feed(Buffer.from([9, 9, 9, 9]));
		expect(socket.binaryBytes).toBe(4);
	});

	test("reports connected only once the socket is open", async () => {
		const { stream, socket } = await started();
		expect(stream.isConnected()).toBe(false);
		socket.open();
		expect(stream.isConnected()).toBe(true);
	});
});

describe("transcript frames", () => {
	test("distinguishes interims from finals", async () => {
		const { socket, events } = await started();
		socket.open();

		socket.results("hello", false);
		socket.results("hello world", true);

		expect(events).toEqual([
			{ type: "interim", text: "hello" },
			{ type: "final", text: "hello world" },
		]);
	});

	test("ignores empty transcripts and utterance markers", async () => {
		const { socket, events } = await started();
		socket.open();

		socket.results("", false);
		socket.results("   ", true);
		socket.emit({ type: "UtteranceEnd", last_word_end: 2.5 });

		expect(events).toEqual([]);
	});

	test("survives a non-JSON frame", async () => {
		const { socket, events } = await started();
		socket.open();
		expect(() => socket.onmessage?.({ data: "not json" })).not.toThrow();
		expect(events).toEqual([]);
	});

	test("surfaces a server error", async () => {
		const { socket, events } = await started();
		socket.open();
		socket.emit({ type: "Error", description: "bad audio", error_code: "DATA-0001" });

		expect(events).toEqual([{ type: "error", message: "bad audio", code: "DATA-0001" }]);
	});
});

describe("finalize", () => {
	test("sends CloseStream and resolves complete on Metadata", async () => {
		const { stream, socket, clock } = await started();
		socket.open();

		const promise = stream.finalize();
		expect(socket.jsonSent).toContainEqual({ type: "CloseStream" });

		socket.emit({ type: "Metadata" });
		expect(await promise).toBe("complete");
		expect(clock.pending).toBe(0);
	});

	test("times out when the server never confirms", async () => {
		const { stream, socket, clock } = await started({ finalizeSafetyMs: 5000 });
		socket.open();

		const promise = stream.finalize();
		clock.advance(4999);
		let settled = false;
		void promise.then(() => (settled = true));
		await Promise.resolve();
		expect(settled).toBe(false);

		clock.advance(1);
		expect(await promise).toBe("timeout");
	});

	test("reports closed_early when the server hangs up instead of confirming", async () => {
		const { stream, socket } = await started();
		socket.open();

		const promise = stream.finalize();
		socket.remoteClose(1006);
		expect(await promise).toBe("closed_early");
	});

	test("reports closed_early when the socket is already dead, without sending CloseStream", async () => {
		const { stream, socket } = await started();
		socket.open();
		socket.remoteClose(1006);

		const before = socket.sent.length;
		expect(await stream.finalize()).toBe("closed_early");
		expect(socket.sent.length).toBe(before);
	});

	test("is idempotent", async () => {
		const { stream, socket } = await started();
		socket.open();
		const promise = stream.finalize();
		socket.emit({ type: "Metadata" });
		await promise;

		expect(await stream.finalize()).toBe("already_closed");
	});

	test("does not resolve twice when Metadata arrives after a timeout", async () => {
		const { stream, socket, clock } = await started({ finalizeSafetyMs: 1000 });
		socket.open();
		const promise = stream.finalize();
		clock.advance(1000);
		expect(await promise).toBe("timeout");

		socket.emit({ type: "Metadata" });
		expect(await promise).toBe("timeout");
	});

	test("stops sending audio after finalize", async () => {
		const { stream, socket } = await started();
		socket.open();
		void stream.finalize();

		const before = socket.binaryBytes;
		stream.feed(Buffer.from([1, 2, 3, 4]));
		expect(socket.binaryBytes).toBe(before);
	});
});

describe("keepalive", () => {
	test("sends KeepAlive on an interval once open, as a text frame", async () => {
		const { socket, clock } = await started({ keepAliveMs: 5000 });
		socket.open();

		clock.advance(5000);
		clock.advance(5000);
		const keepAlives = socket.jsonSent.filter((item) => JSON.stringify(item) === JSON.stringify({ type: "KeepAlive" }));
		expect(keepAlives.length).toBe(2);
		expect(socket.textSent.every((item) => typeof item === "string")).toBe(true);
	});

	test("does not send KeepAlive before the socket is open", async () => {
		const { socket, clock } = await started({ keepAliveMs: 5000 });
		clock.advance(20_000);
		expect(socket.sent).toEqual([]);
	});

	test("stops the keepalive when the stream closes", async () => {
		const { stream, socket, clock } = await started({ keepAliveMs: 5000 });
		socket.open();
		clock.advance(5000);
		const count = socket.jsonSent.length;

		stream.close();
		clock.advance(50_000);
		expect(socket.jsonSent.length).toBe(count);
	});
});

describe("probe", () => {
	async function withFetch(handler: () => Promise<Response> | Response) {
		const original = globalThis.fetch;
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({
				url: input instanceof Request ? input.url : String(input),
				headers: Object.fromEntries(new Headers(init?.headers).entries()),
			});
			return handler();
		}) as typeof fetch;
		try {
			return { calls, restore: () => (globalThis.fetch = original) };
		} catch (error) {
			globalThis.fetch = original;
			throw error;
		}
	}

	test("checks the REST endpoint derived from the websocket URL, with the key", async () => {
		const stub = await withFetch(() => new Response("[]", { status: 200 }));
		try {
			const backend = new DeepgramBackend({ apiKey: "k-123" });
			expect(await backend.probe()).toContain("reachable");
			expect(stub.calls[0]!.url).toBe("https://api.deepgram.com/v1/projects");
			expect(stub.calls[0]!.headers.authorization).toBe("Token k-123");
		} finally {
			stub.restore();
		}
	});

	test("names a rejected key, which a close code alone cannot tell you", async () => {
		const stub = await withFetch(() => new Response("unauthorized", { status: 401 }));
		try {
			expect(await new DeepgramBackend({ apiKey: "bad" }).probe()).toBe("Deepgram rejected the API key");
		} finally {
			stub.restore();
		}
	});

	test("reports an unreachable network distinctly from a bad key", async () => {
		const stub = await withFetch(() => {
			throw new Error("getaddrinfo ENOTFOUND api.deepgram.com");
		});
		try {
			const result = await new DeepgramBackend({ apiKey: "k" }).probe();
			expect(result).toContain("could not reach Deepgram");
			expect(result).toContain("ENOTFOUND");
		} finally {
			stub.restore();
		}
	});

	test("reports a server side status", async () => {
		const stub = await withFetch(() => new Response("boom", { status: 503 }));
		try {
			expect(await new DeepgramBackend({ apiKey: "k" }).probe()).toBe("Deepgram returned HTTP 503");
		} finally {
			stub.restore();
		}
	});

	test("says so when there is no key to test", async () => {
		expect(await new DeepgramBackend({ apiKey: undefined }).probe()).toBe("no API key is configured");
	});

	test("follows a regional endpoint", async () => {
		const stub = await withFetch(() => new Response("[]", { status: 200 }));
		try {
			const backend = new DeepgramBackend({
				apiKey: "k",
				baseUrl: "wss://api.eu.deepgram.com/v1/listen",
			});
			await backend.probe();
			expect(stub.calls[0]!.url).toBe("https://api.eu.deepgram.com/v1/projects");
		} finally {
			stub.restore();
		}
	});
});

describe("updateKeyterms", () => {
	test("sends a Configure message with the whole replacement list", async () => {
		const { stream, socket } = await started();
		socket.open();

		stream.updateKeyterms!(["subagent", "worktree"]);
		expect(socket.jsonSent).toContainEqual({ type: "Configure", keyterms: ["subagent", "worktree"] });
	});

	test("is ignored before the socket opens", async () => {
		const { stream, socket } = await started();
		stream.updateKeyterms!(["subagent"]);
		expect(socket.sent).toEqual([]);
	});
});

describe("unexpected closes", () => {
	test("reports a non-normal close while recording", async () => {
		const { socket, events } = await started();
		socket.open();
		socket.remoteClose(1006, "going away");

		expect(events).toEqual([
			{ type: "error", message: "Voice connection closed unexpectedly (code 1006).", code: "ws_closed_1006" },
		]);
	});

	test("includes the underlying cause when the error event carries one", async () => {
		const { socket, events } = await started();
		socket.open();
		// This is the only detail available when a network call fails, and a bare
		// "connection error" is unactionable without it.
		socket.onerror?.({ message: "getaddrinfo ENOTFOUND api.deepgram.com" });

		expect(events).toEqual([
			{
				type: "error",
				message: "Voice stream connection error: getaddrinfo ENOTFOUND api.deepgram.com",
				code: "ws_error",
			},
		]);
	});

	test("accepts a nested error message", async () => {
		const { socket, events } = await started();
		socket.open();
		socket.onerror?.({ error: { message: "socket hang up" } });

		expect(events[0]).toMatchObject({ message: "Voice stream connection error: socket hang up" });
	});

	test("treats a normal close as expected", async () => {
		const { socket, events } = await started();
		socket.open();
		socket.remoteClose(1000);

		expect(events).toEqual([]);
	});

	test("reports a socket error", async () => {
		const { socket, events } = await started();
		socket.open();
		socket.fail();

		expect(events).toEqual([{ type: "error", message: "Voice stream connection error.", code: "ws_error" }]);
	});

	test("stays quiet about errors after finalize", async () => {
		const { stream, socket, events } = await started();
		socket.open();
		const promise = stream.finalize();
		socket.emit({ type: "Metadata" });
		await promise;
		socket.fail();
		socket.remoteClose(1006);

		expect(events).toEqual([]);
	});
});
