import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateAgentDir } from "../test-support/fake-pi.ts";
import type { SetupIo, TryItOutcome } from "./setup.ts";

// Must isolate before importing the settings module, which resolves pi's agent
// dir when it writes.
const { root } = isolateAgentDir("better-pi-voice-setup");
const { modelChoices, runSetup } = await import("./setup.ts");
const { MODEL_CATALOG } = await import("./model-download.ts");
const { DEFAULT_SETTINGS, keyFilePath, readSettings, settingsPath } = await import("./settings.ts");

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
	rmSync(settingsPath(), { force: true });
	rmSync(keyFilePath(), { force: true });
	delete process.env.DEEPGRAM_API_KEY;
});

type Answers = { select?: string[]; input?: string[]; confirm?: boolean[]; tryIt?: TryItOutcome[] };

function makeIo(answers: Answers = {}) {
	const selects = [...(answers.select ?? [])];
	const inputs = [...(answers.input ?? [])];
	const confirms = [...(answers.confirm ?? [])];
	const tryIts = [...(answers.tryIt ?? [])];
	const notifications: Array<{ message: string; level?: string }> = [];
	const io: SetupIo = {
		select: async () => selects.shift(),
		input: async () => inputs.shift(),
		confirm: async () => confirms.shift() ?? true,
		notify: (message, level) => notifications.push({ message, level }),
		tryIt: async () => tryIts.shift() ?? "done",
	};
	return { io, notifications };
}

const DEEPGRAM = "Deepgram — cloud, needs an API key";
const PARAKEET = "Local Parakeet — private, runs a model on disk";
const PASTE = "Paste a key now (kept 0600, never in settings)";
const DOTENV = "Use an existing dotenv file";
const SKIP = "Skip for now";
const HOLD = "Hold to talk (press and hold)";
const TAP = "Tap to start and stop";
const MODEL = { label: "parakeet-tdt_ctc-110m-Q8_0", path: "/models/parakeet-tdt_ctc-110m-Q8_0.gguf" };
// The exact menu label the wizard builds for a catalog model already on disk.
const LOCAL_MODEL_LABEL = modelChoices([MODEL])[0]!.label;

describe("runSetup", () => {
	test("configures Deepgram by pasting a key, keeping it out of settings", async () => {
		const { io } = makeIo({ select: [DEEPGRAM, PASTE, HOLD], input: ["dg-secret", "ctrl+alt+z"] });

		const result = await runSetup(io, { base: DEFAULT_SETTINGS });

		expect(result?.backend).toBe("deepgram");
		expect(result?.mode).toBe("hold");
		expect(result?.deepgram.apiKey).toBeNull();
		expect(result?.deepgram.apiKeyFile).toBe(keyFilePath());
		expect((await readSettings()).settings.deepgram.apiKeyFile).toBe(keyFilePath());
	});

	test("uses a dotenv file that contains a key", async () => {
		const file = join(root, "keys.env");
		writeFileSync(file, "deepgram_key=file-key\n");
		const { io } = makeIo({ select: [DEEPGRAM, DOTENV, TAP], input: [file, "ctrl+alt+z"] });

		const result = await runSetup(io, { base: DEFAULT_SETTINGS });

		expect(result?.deepgram.apiKeyFile).toBe(file);
		expect(result?.mode).toBe("tap");
	});

	test("warns but continues when a dotenv has no key", async () => {
		const file = join(root, "empty.env");
		writeFileSync(file, "SOMETHING_ELSE=1\n");
		const { io, notifications } = makeIo({ select: [DEEPGRAM, DOTENV, HOLD], input: [file, "ctrl+alt+z"] });

		const result = await runSetup(io, { base: DEFAULT_SETTINGS });

		expect(result?.deepgram.apiKeyFile).toBeNull();
		expect(notifications.some((entry) => entry.message.includes("No DEEPGRAM_API_KEY"))).toBe(true);
	});

	test("picks a local model from disk", async () => {
		const { io } = makeIo({ select: [PARAKEET, LOCAL_MODEL_LABEL, HOLD], input: ["ctrl+alt+z"] });

		const result = await runSetup(io, { base: DEFAULT_SETTINGS, models: async () => [MODEL] });

		expect(result?.backend).toBe("parakeet");
		expect(result?.parakeet.modelPath).toBe(MODEL.path);
	});

	test("accepts an explicit model path when nothing is on disk", async () => {
		const file = join(root, "model.gguf");
		writeFileSync(file, "not a real model");
		const { io } = makeIo({ select: [PARAKEET, "Enter a path…", HOLD], input: [file, "ctrl+alt+z"] });

		const result = await runSetup(io, { base: DEFAULT_SETTINGS, models: async () => [] });

		expect(result?.parakeet.modelPath).toBe(file);
	});

	test("keeps the current shortcut and warns when the new one is invalid", async () => {
		const { io, notifications } = makeIo({ select: [PARAKEET, LOCAL_MODEL_LABEL, HOLD], input: ["crtl+alt+z"] });

		const result = await runSetup(io, { base: DEFAULT_SETTINGS, models: async () => [MODEL] });

		expect(result?.shortcut).toBe(DEFAULT_SETTINGS.shortcut);
		expect(notifications.some((entry) => entry.message.includes("not a valid shortcut"))).toBe(true);
	});

	test("returns nothing when the user cancels the backend step", async () => {
		const { io } = makeIo({ select: [] });
		expect(await runSetup(io, { base: DEFAULT_SETTINGS })).toBeUndefined();
	});

	test("returns nothing when the summary is rejected", async () => {
		const { io } = makeIo({ select: [DEEPGRAM, SKIP, HOLD], input: ["ctrl+alt+z"], confirm: [false] });
		expect(await runSetup(io, { base: DEFAULT_SETTINGS })).toBeUndefined();
	});

	test("runs the wizard again when Try it asks for a change", async () => {
		const { io } = makeIo({
			select: [PARAKEET, LOCAL_MODEL_LABEL, HOLD, DEEPGRAM, SKIP, TAP],
			input: ["ctrl+alt+z", "ctrl+shift+v"],
			tryIt: ["change", "done"],
		});

		const result = await runSetup(io, { base: DEFAULT_SETTINGS, models: async () => [MODEL] });

		expect(result?.backend).toBe("deepgram");
		expect(result?.mode).toBe("tap");
		expect(result?.shortcut).toBe("ctrl+shift+v");
	});

	test("offers the key already present in the environment", async () => {
		process.env.DEEPGRAM_API_KEY = "from-env";
		try {
			const { io } = makeIo({
				select: [DEEPGRAM, "Use the key already in DEEPGRAM_API_KEY", HOLD],
				input: ["ctrl+alt+z"],
			});

			const result = await runSetup(io, { base: DEFAULT_SETTINGS });

			expect(result?.backend).toBe("deepgram");
			expect(result?.deepgram.apiKeyFile).toBeNull();
			expect(result?.deepgram.apiKey).toBeNull();
		} finally {
			delete process.env.DEEPGRAM_API_KEY;
		}
	});

	test("downloads a catalog model the user selects", async () => {
		const choice = modelChoices([])[0]!; // the recommended model, not on disk
		let progressCalls = 0;
		const { io } = makeIo({ select: [PARAKEET, choice.label, HOLD], input: ["ctrl+alt+z"] });
		io.progress = () => {
			progressCalls++;
		};

		const result = await runSetup(io, {
			base: DEFAULT_SETTINGS,
			models: async () => [],
			download: async (_model, onProgress) => {
				onProgress(50, 100);
				return "/downloaded/parakeet.gguf";
			},
		});

		expect(result?.parakeet.modelPath).toBe("/downloaded/parakeet.gguf");
		expect(progressCalls).toBeGreaterThan(0);
	});

	test("uses a catalog model already on disk without downloading", async () => {
		const catalog = MODEL_CATALOG[0]!;
		const local = { label: catalog.id, path: `/x/${catalog.filename}` };
		const choice = modelChoices([local])[0]!;
		let downloads = 0;
		const { io } = makeIo({ select: [PARAKEET, choice.label, HOLD], input: ["ctrl+alt+z"] });

		const result = await runSetup(io, {
			base: DEFAULT_SETTINGS,
			models: async () => [local],
			download: async () => {
				downloads++;
				return "/nope";
			},
		});

		expect(result?.parakeet.modelPath).toBe(`/x/${catalog.filename}`);
		expect(downloads).toBe(0);
	});

	test("aborts setup when a download fails, saving no half-config", async () => {
		const choice = modelChoices([])[0]!;
		const { io, notifications } = makeIo({ select: [PARAKEET, choice.label] });

		const result = await runSetup(io, {
			base: DEFAULT_SETTINGS,
			models: async () => [],
			download: async () => {
				throw new Error("network died");
			},
		});

		expect(result).toBeUndefined();
		expect(notifications.some((entry) => entry.message.includes("Download failed"))).toBe(true);
	});
});
