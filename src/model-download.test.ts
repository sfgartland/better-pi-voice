import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateAgentDir } from "../test-support/fake-pi.ts";

const { root } = isolateAgentDir("better-pi-voice-download");
const { downloadModel, modelsDir, MODEL_CATALOG } = await import("./model-download.ts");

afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => rmSync(modelsDir(), { recursive: true, force: true }));

const body = Buffer.from("pretend gguf bytes");
const sha = createHash("sha256").update(body).digest("hex");

function model(overrides: Record<string, unknown> = {}) {
	return {
		id: "test",
		name: "test-model",
		repository: "owner/repo",
		filename: "test-model-Q8_0.gguf",
		size: body.length,
		sha256: sha,
		note: "",
		streaming: false,
		...overrides,
	};
}

function fetchReturning(bytes: Buffer): typeof fetch {
	return (async () =>
		new Response(bytes, {
			status: 200,
			headers: { "content-length": String(bytes.length) },
		})) as unknown as typeof fetch;
}

describe("downloadModel", () => {
	test("streams the file into our cache and reports progress", async () => {
		const progress: number[] = [];

		const path = await downloadModel(model(), {
			fetch: fetchReturning(body),
			onProgress: (downloaded) => progress.push(downloaded),
		});

		expect(existsSync(path)).toBe(true);
		expect(statSync(path).size).toBe(body.length);
		expect(progress.at(-1)).toBe(body.length);
	});

	test("resumes a partial download with a Range request", async () => {
		const half = Math.floor(body.length / 2);
		mkdirSync(modelsDir(), { recursive: true });
		writeFileSync(join(modelsDir(), "test-model-Q8_0.gguf.part"), body.subarray(0, half));
		let rangeHeader: string | null = null;
		const stub = (async (_url: string, init?: RequestInit) => {
			rangeHeader = new Headers(init?.headers).get("range");
			return new Response(body.subarray(half), { status: 206 });
		}) as unknown as typeof fetch;

		const path = await downloadModel(model(), { fetch: stub });

		expect(rangeHeader as string | null).toBe(`bytes=${String(half)}-`);
		expect(readFileSync(path)).toEqual(body);
	});

	test("rejects a checksum mismatch and leaves nothing behind", async () => {
		const bad = model({ filename: "bad-Q8_0.gguf", sha256: "0".repeat(64) });

		await expect(downloadModel(bad, { fetch: fetchReturning(body) })).rejects.toThrow(/checksum/);
		expect(existsSync(join(modelsDir(), bad.filename))).toBe(false);
	});

	test("fails clearly on an HTTP error", async () => {
		const failing = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;

		await expect(downloadModel(model(), { fetch: failing })).rejects.toThrow(/HTTP 404/);
	});
});

describe("model catalog", () => {
	test("the picker never offers the VAD model as an ASR model", () => {
		// Fail-first: the catalog must actually carry a VAD-role Silero entry...
		const vad = MODEL_CATALOG.find((m) => m.id === "silero-vad-v6.2");
		expect(vad).toBeDefined();
		expect(vad?.role).toBe("vad");
		// ...and ASR-role selection must still exclude it.
		expect(MODEL_CATALOG.filter((m) => (m.role ?? "asr") === "asr").some((m) => m.id === "silero-vad-v6.2")).toBe(
			false,
		);
	});
});
