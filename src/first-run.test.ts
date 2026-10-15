import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateAgentDir } from "../test-support/fake-pi.ts";

// Must run before the modules below are imported: both resolve pi's agent dir
// and the Hugging Face cache at load/call time.
const { root } = isolateAgentDir("better-pi-voice-first-run");
const HUB = join(process.env.XDG_CACHE_HOME ?? "", "huggingface", "hub");

const { ensureFirstRunSettings, pickBestModel } = await import("./first-run.ts");
const { availableModels } = await import("./backends/parakeet.ts");
const { DEFAULT_SETTINGS, readSettings, settingsPath, writeSettings } = await import("./settings.ts");

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
	rmSync(settingsPath(), { force: true });
	rmSync(HUB, { recursive: true, force: true });
	delete process.env.DEEPGRAM_API_KEY;
	delete process.env.HF_HOME;
});

function addCachedModel(repo: string, file: string): string {
	const dir = join(HUB, `models--test--${repo}`, "snapshots", "abc123");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, file);
	writeFileSync(path, "not a real model");
	return path;
}

describe("availableModels", () => {
	test("finds GGUFs under the Hugging Face cache and ignores everything else", async () => {
		addCachedModel("parakeet-tdt_ctc-110m-gguf", "parakeet-tdt_ctc-110m-Q8_0.gguf");
		addCachedModel("canary-180m-flash-gguf", "canary-180m-flash-Q8_0.gguf");
		// A non-GGUF file in a snapshot must not be offered as a model.
		const dir = join(HUB, "models--test--canary-180m-flash-gguf", "snapshots", "abc123");
		writeFileSync(join(dir, "README.md"), "no");

		const models = await availableModels();

		expect(models.map((model) => model.label)).toEqual(["canary-180m-flash-Q8_0", "parakeet-tdt_ctc-110m-Q8_0"]);
		expect(models[0]!.path).toContain("canary-180m-flash-Q8_0.gguf");
	});

	test("is empty when there is no cache at all", async () => {
		expect(await availableModels()).toEqual([]);
	});

	test("ignores a symlink whose target is missing", async () => {
		const dir = join(HUB, "models--test--parakeet-tdt_ctc-110m-gguf", "snapshots", "abc123");
		mkdirSync(dir, { recursive: true });
		symlinkSync(join(dir, "missing.gguf"), join(dir, "parakeet-tdt_ctc-110m-Q8_0.gguf"));

		expect(await availableModels()).toEqual([]);
	});

	test("HF_HOME wins over XDG_CACHE_HOME", async () => {
		const hfHome = join(root, "hf-home");
		const dir = join(hfHome, "hub", "models--test--canary-180m-flash-gguf", "snapshots", "abc123");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "canary-180m-flash-Q8_0.gguf"), "x");
		// This one is in the XDG cache and must be ignored while HF_HOME is set.
		addCachedModel("parakeet-tdt_ctc-110m-gguf", "parakeet-tdt_ctc-110m-Q8_0.gguf");
		process.env.HF_HOME = hfHome;

		const models = await availableModels();

		expect(models.map((model) => model.label)).toEqual(["canary-180m-flash-Q8_0"]);
	});
});

describe("pickBestModel", () => {
	test("prefers the benchmark winner over the other cached models", () => {
		const models = [
			{ label: "parakeet-unified-en-0.6b-Q8_0", path: "/a" },
			{ label: "canary-180m-flash-Q8_0", path: "/b" },
			{ label: "parakeet-tdt_ctc-110m-Q8_0", path: "/c" },
		];

		expect(pickBestModel(models)?.label).toBe("parakeet-tdt_ctc-110m-Q8_0");
	});

	test("ignores GGUFs that are not speech models", () => {
		const models = [
			{ label: "some-other-model-Q8_0", path: "/x" },
			{ label: "another-model-Q8_0", path: "/y" },
		];

		expect(pickBestModel(models)).toBeUndefined();
	});

	test("falls back to another speech model when the known ones are absent", () => {
		const models = [
			{ label: "some-other-model-Q8_0", path: "/x" },
			{ label: "whisper-small-Q8_0", path: "/y" },
		];

		expect(pickBestModel(models)?.label).toBe("whisper-small-Q8_0");
	});

	test("has nothing to pick from an empty list", () => {
		expect(pickBestModel([])).toBeUndefined();
	});
});

describe("ensureFirstRunSettings", () => {
	test("does nothing when a settings file already exists", async () => {
		await writeSettings({ ...DEFAULT_SETTINGS, backend: "parakeet" });

		expect(await ensureFirstRunSettings()).toBeUndefined();
		expect((await readSettings()).settings.backend).toBe("parakeet");
	});

	test("chooses Deepgram when a key is present, and names the key to hold", async () => {
		process.env.DEEPGRAM_API_KEY = "test-key";

		const outcome = await ensureFirstRunSettings();

		expect(outcome?.wrote).toBe(true);
		expect(outcome?.message).toContain(DEFAULT_SETTINGS.shortcut);
		expect((await readSettings()).settings.backend).toBe("deepgram");
	});

	test("falls back to the best local model when no key is present", async () => {
		addCachedModel("parakeet-unified-en-0.6b-gguf", "parakeet-unified-en-0.6b-Q8_0.gguf");
		addCachedModel("parakeet-tdt_ctc-110m-gguf", "parakeet-tdt_ctc-110m-Q8_0.gguf");

		const outcome = await ensureFirstRunSettings();
		const { settings } = await readSettings();

		expect(outcome?.wrote).toBe(true);
		expect(settings.backend).toBe("parakeet");
		expect(settings.parakeet.modelPath).toContain("parakeet-tdt_ctc-110m");
	});

	test("writes nothing when there is neither a key nor a local model", async () => {
		const outcome = await ensureFirstRunSettings();

		expect(outcome?.wrote).toBe(false);
		expect(outcome?.message).toContain(DEFAULT_SETTINGS.deepgram.apiKeyEnv);
		expect(await Bun.file(settingsPath()).exists()).toBe(false);
	});
});
