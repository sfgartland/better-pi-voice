/**
 * The guided setup wizard, run by `/voice setup` or the first time the shortcut
 * is pressed with no settings file.
 *
 * Every prompt goes through an injected `SetupIo`, and the final live test
 * through `tryIt`, so the whole flow is testable without a terminal.
 */

import { readFileSync } from "node:fs";
import { type AvailableModel, availableModels } from "./backends/parakeet.ts";
import {
	applySetting,
	isValidShortcut,
	parseDotenv,
	type VoiceSettings,
	writeKeyFile,
	writeSettings,
} from "./settings.ts";

export type TryItOutcome = "done" | "change";

export type SetupIo = {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
	/** The live test at the end; injected so the wizard can be driven headless. */
	tryIt(settings: VoiceSettings): Promise<TryItOutcome>;
};

export type SetupOptions = {
	/** Starting point: current settings, or the defaults on a fresh install. */
	base: VoiceSettings;
	/** Model discovery, overridable in tests. */
	models?: (() => Promise<AvailableModel[]>) | undefined;
};

const BACKENDS = ["Deepgram — cloud, needs an API key", "Local Parakeet — private, runs a model on disk"];
const KEY_METHODS = ["Paste a key now (kept 0600, never in settings)", "Use an existing dotenv file", "Skip for now"];
const MODES = ["Hold to talk (press and hold)", "Tap to start and stop"];
const ENTER_PATH = "Enter a path…";

function summary(settings: VoiceSettings): string {
	const lines = [
		`backend    ${
			settings.backend === "deepgram" ? `Deepgram (${settings.deepgram.model})` : `Parakeet (${settings.parakeet.mode})`
		}`,
	];
	if (settings.backend === "deepgram") {
		lines.push(`key        ${settings.deepgram.apiKeyFile ?? "not set"}`);
	} else {
		lines.push(`model      ${settings.parakeet.modelPath ?? "not set"}`);
	}
	lines.push(`mode       ${settings.mode}`, `shortcut   ${settings.shortcut}`);
	return lines.join("\n");
}

async function askForKey(io: SetupIo, settings: VoiceSettings): Promise<VoiceSettings | undefined> {
	const env = settings.deepgram.apiKeyEnv;
	const pick = await io.select("Deepgram API key", KEY_METHODS);
	if (pick === undefined) return undefined; // cancelled the whole wizard

	if (pick.startsWith("Paste")) {
		const entered = (await io.input("Deepgram API key"))?.trim();
		if (!entered) return undefined;
		const path = await writeKeyFile(env, entered);
		return { ...settings, deepgram: { ...settings.deepgram, apiKey: null, apiKeyFile: path } };
	}

	if (pick.startsWith("Use")) {
		const path = (await io.input("Path to a dotenv file containing the key"))?.trim();
		if (!path) return undefined;
		let found: string | undefined;
		try {
			found = parseDotenv(readFileSync(path, "utf8"), env);
		} catch {
			found = undefined;
		}
		if (!found) {
			io.notify(`No ${env} found in ${path}; continuing without a cloud key.`, "warning");
			return settings;
		}
		return { ...settings, deepgram: { ...settings.deepgram, apiKey: null, apiKeyFile: path } };
	}

	io.notify("No key set; Deepgram will need one before it can transcribe.", "warning");
	return settings;
}

async function askForModel(
	io: SetupIo,
	options: SetupOptions,
	settings: VoiceSettings,
): Promise<VoiceSettings | undefined> {
	const models = await (options.models ?? availableModels)();
	const pick = await io.select("Parakeet model already on disk", [...models.map((model) => model.label), ENTER_PATH]);
	if (pick === undefined) return undefined;

	if (pick === ENTER_PATH) {
		const path = (await io.input("Path to a .gguf model"))?.trim();
		if (!path) return undefined;
		const applied = applySetting(settings, "model", path);
		if ("error" in applied) {
			io.notify(applied.error, "warning");
			return settings;
		}
		return applied.settings;
	}

	const model = models.find((entry) => entry.label === pick);
	return model ? { ...settings, parakeet: { ...settings.parakeet, modelPath: model.path } } : settings;
}

async function collect(io: SetupIo, options: SetupOptions, base: VoiceSettings): Promise<VoiceSettings | undefined> {
	const backendPick = await io.select("How should voice input run?", BACKENDS);
	if (backendPick === undefined) return undefined;
	let settings: VoiceSettings = {
		...base,
		backend: backendPick.startsWith("Deepgram") ? "deepgram" : "parakeet",
	};

	if (settings.backend === "deepgram") {
		const keyed = await askForKey(io, settings);
		if (keyed === undefined) return undefined;
		settings = keyed;
	} else {
		const modeled = await askForModel(io, options, settings);
		if (modeled === undefined) return undefined;
		settings = modeled;
	}

	const modePick = await io.select("How do you want to start and stop?", MODES);
	if (modePick === undefined) return undefined;
	settings = { ...settings, mode: modePick.startsWith("Hold") ? "hold" : "tap" };

	const shortcut = await io.input(`Shortcut (Enter keeps ${settings.shortcut})`, settings.shortcut);
	if (shortcut === undefined) return undefined;
	const trimmed = shortcut.trim();
	if (trimmed && trimmed !== settings.shortcut) {
		if (isValidShortcut(trimmed)) settings = { ...settings, shortcut: trimmed };
		else io.notify(`"${trimmed}" is not a valid shortcut; keeping ${settings.shortcut}.`, "warning");
	}

	if (!(await io.confirm("Save this setup?", summary(settings)))) return undefined;
	return settings;
}

/**
 * Walk the user through setup, save the result, then run the live test. If the
 * test asks to change something, the wizard runs again from the top.
 */
export async function runSetup(io: SetupIo, options: SetupOptions): Promise<VoiceSettings | undefined> {
	let current = options;
	while (true) {
		const settings = await collect(io, current, current.base);
		if (!settings) return undefined;

		await writeSettings(settings);
		const outcome = await io.tryIt(settings);
		if (outcome === "done") return settings;
		current = { ...current, base: settings };
	}
}
