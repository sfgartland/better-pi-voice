import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../testing/fake-clock.ts";
import { DEFAULT_IDLE_UNLOAD_MS, DEFAULT_LOAD_SHED_RATIO, defaultSystemLoad, ParakeetBackend } from "./parakeet.ts";

const modelFile = join(tmpdir(), `better-pi-voice-test-${String(process.pid)}.gguf`);
writeFileSync(modelFile, "not a real model");
afterAll(() => rmSync(modelFile, { force: true }));

/** A stand-in for a loaded GGUF, so residency is testable without one. */
function fakeModel() {
	let disposed = false;
	const text = { full: "", committed: "", tentative: "" };
	const model = {
		capabilities: { supportsStreaming: true, languages: ["en"], nativeSampleRate: 16_000 },
		createSession: () => ({
			stream: async () => ({
				feed: async () => ({ committedChanged: false, tentativeChanged: false }),
				finalize: async () => undefined,
				reset: () => {},
				get text() {
					return text;
				},
				get snapshot() {
					return { text: "" };
				},
			}),
			dispose: () => {},
		}),
		transcribe: async () => ({ text: "" }),
		dispose: () => {
			disposed = true;
		},
	};
	return { model, wasDisposed: () => disposed };
}

function makeBackend(options: { load?: number; idleUnloadMs?: number; loadCheckMs?: number } = {}) {
	const clock = new FakeClock();
	const fake = fakeModel();
	let loads = 0;
	let load = options.load ?? 0;
	const backend = new ParakeetBackend({
		modelPath: modelFile,
		clock,
		idleUnloadMs: options.idleUnloadMs ?? DEFAULT_IDLE_UNLOAD_MS,
		loadCheckMs: options.loadCheckMs ?? 60_000,
		loadShedRatio: DEFAULT_LOAD_SHED_RATIO,
		systemLoad: () => load,
		loadModel: async () => {
			loads++;
			return fake.model as never;
		},
	});
	return { backend, clock, fake, loads: () => loads, setLoad: (value: number) => (load = value) };
}

/** One complete recording: start, then release. */
async function record(backend: ParakeetBackend): Promise<void> {
	const stream = await backend.start({ language: "en", keyterms: [], signal: new AbortController().signal }, () => {});
	if (!stream) throw new Error("backend did not start");
	stream.close();
}

describe("model residency", () => {
	test("keeps the model loaded after a recording, then releases it", async () => {
		const { backend, clock, fake } = makeBackend({ idleUnloadMs: 15 * 60_000 });

		await record(backend);
		expect(backend.modelLoaded).toBe(true);
		expect(fake.wasDisposed()).toBe(false);

		// Still resident just before the window closes.
		clock.advance(14 * 60_000);
		expect(backend.modelLoaded).toBe(true);

		clock.advance(60_000);
		expect(backend.modelLoaded).toBe(false);
		expect(fake.wasDisposed()).toBe(true);
	});

	test("reuses the model across recordings instead of reloading it", async () => {
		const { backend, loads } = makeBackend();

		await record(backend);
		await record(backend);
		await record(backend);

		expect(loads()).toBe(1);
	});

	test("a new recording cancels a pending unload", async () => {
		const { backend, clock, fake } = makeBackend({ idleUnloadMs: 60_000 });

		await record(backend);
		clock.advance(50_000);
		await record(backend);
		// The first window would have expired here; the second must not.
		clock.advance(20_000);

		expect(backend.modelLoaded).toBe(true);
		expect(fake.wasDisposed()).toBe(false);
	});

	test("hands the memory back early when the machine gets busy", async () => {
		const { backend, clock, setLoad, fake } = makeBackend({
			idleUnloadMs: 15 * 60_000,
			loadCheckMs: 60_000,
		});
		await record(backend);
		expect(backend.modelLoaded).toBe(true);

		// Quiet at the first check, so it stays.
		clock.advance(60_000);
		expect(backend.modelLoaded).toBe(true);

		setLoad(DEFAULT_LOAD_SHED_RATIO + 1);
		clock.advance(60_000);
		expect(backend.modelLoaded).toBe(false);
		expect(fake.wasDisposed()).toBe(true);
	});

	test("an idle-unload window of zero releases the model immediately", async () => {
		const { backend, fake } = makeBackend({ idleUnloadMs: 0 });

		await record(backend);

		expect(backend.modelLoaded).toBe(false);
		expect(fake.wasDisposed()).toBe(true);
	});

	test("dispose releases the model and any pending timers", async () => {
		const { backend, clock, fake } = makeBackend();
		await record(backend);

		await backend.dispose();
		expect(backend.modelLoaded).toBe(false);
		expect(fake.wasDisposed()).toBe(true);

		// Nothing left armed that could fire against a disposed backend.
		expect(clock.pending).toBe(0);
	});

	test("does not unload a model that was never loaded", async () => {
		const { backend, clock } = makeBackend();
		clock.advance(60 * 60_000);
		expect(backend.modelLoaded).toBe(false);
	});
});

describe("defaultSystemLoad", () => {
	test("is a finite, non-negative number", () => {
		const load = defaultSystemLoad();
		expect(Number.isFinite(load)).toBe(true);
		expect(load).toBeGreaterThanOrEqual(0);
	});
});
