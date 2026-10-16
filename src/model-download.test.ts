import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { isolateAgentDir } from "../test-support/fake-pi.ts";

const { root } = isolateAgentDir("better-pi-voice-download");
const { downloadModel, modelsDir } = await import("./model-download.ts");

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
