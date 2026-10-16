import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateAgentDir } from "../test-support/fake-pi.ts";
import type { SetupIo, TryItOutcome } from "./setup.ts";

// Must isolate before importing the settings module, which resolves pi's agent
// dir when it writes.
const { root } = isolateAgentDir("better-pi-voice-setup");
const { runSetup } = await import("./setup.ts");
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
		const { io } = makeIo({ select: [PARAKEET, MODEL.label, HOLD], input: ["ctrl+alt+z"] });

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
		const { io, notifications } = makeIo({ select: [PARAKEET, MODEL.label, HOLD], input: ["crtl+alt+z"] });

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
			select: [PARAKEET, MODEL.label, HOLD, DEEPGRAM, SKIP, TAP],
			input: ["ctrl+alt+z", "ctrl+shift+v"],
			tryIt: ["change", "done"],
		});

		const result = await runSetup(io, { base: DEFAULT_SETTINGS, models: async () => [MODEL] });

		expect(result?.backend).toBe("deepgram");
		expect(result?.mode).toBe("tap");
		expect(result?.shortcut).toBe("ctrl+shift+v");
	});
});
