/**
 * The guided setup wizard, run by `/voice setup` or the first time the shortcut
 * is pressed with no settings file.
 *
 * Every prompt goes through an injected `SetupIo`, and the final live test and
 * model download through injectable functions, so the whole flow is testable
 * without a terminal or the network.
 */

import { readFileSync } from "node:fs";
import { type AvailableModel, availableModels } from "./backends/parakeet.ts";
import { type CatalogModel, downloadModel, formatSize, MODEL_CATALOG } from "./model-download.ts";
import {
	applySetting,
	isValidShortcut,
	parseDotenv,
	resolveDeepgramApiKey,
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
	/** A transient status line, used for download progress. */
	progress?(message: string): void;
	clearProgress?(): void;
	/** The live test at the end; injected so the wizard can be driven headless. */
	tryIt(settings: VoiceSettings): Promise<TryItOutcome>;
};

export type DownloadFn = (
	model: CatalogModel,
	onProgress: (downloaded: number, total: number) => void,
) => Promise<string>;

export type SetupOptions = {
	/** Starting point: current settings, or the defaults on a fresh install. */
	base: VoiceSettings;
	/** Model discovery, overridable in tests. */
	models?: (() => Promise<AvailableModel[]>) | undefined;
	/** Model download, overridable in tests. */
	download?: DownloadFn | undefined;
};

const BACKENDS = ["Deepgram — cloud, needs an API key", "Local Parakeet — private, runs a model on disk"];
const PASTE = "Paste a key now (kept 0600, never in settings)";
const USE_FILE = "Use an existing dotenv file";
const SKIP = "Skip for now";
const MODES = ["Hold to talk (press and hold)", "Tap to start and stop"];
export const ENTER_PATH = "Enter a path…";

/** How the local model runs. These labels carry the explanation, since that is where the choice is made. */
export const BATCH_MODE_LABEL = "Batch — transcribe in short slices as you talk: fastest here, works with every model";
export const STREAMING_MODE_LABEL =
	"Streaming — decode continuously for lower delay; on this machine it runs slower than real time";

export type ModelChoice = { label: string; model?: CatalogModel; path?: string };

/** The Parakeet model menu: catalog entries (with their download size) first, then local files. */
export function modelChoices(local: AvailableModel[]): ModelChoice[] {
	const choices: ModelChoice[] = [];
	for (const model of MODEL_CATALOG) {
		const present = local.find((entry) => entry.path.endsWith(model.filename));
		const status = present ? "on disk" : `download ${formatSize(model.size)}`;
		const star = model.recommended ? " ★ recommended" : "";
		choices.push({ label: `${model.name}${star} — ${status} — ${model.note}`, model, path: present?.path });
	}
	for (const entry of local) {
		if (MODEL_CATALOG.some((model) => entry.path.endsWith(model.filename))) continue;
		choices.push({ label: `${entry.label} — on disk`, path: entry.path });
	}
	return choices;
}

function summary(settings: VoiceSettings, hasEnvKey: boolean): string {
	const lines = [
		`backend    ${
			settings.backend === "deepgram" ? `Deepgram (${settings.deepgram.model})` : `Parakeet (${settings.parakeet.mode})`
		}`,
	];
	if (settings.backend === "deepgram") {
		const source = settings.deepgram.apiKeyFile
			? settings.deepgram.apiKeyFile
			: hasEnvKey
				? `${settings.deepgram.apiKeyEnv} (environment)`
				: "not set";
		lines.push(`key        ${source}`);
	} else {
		lines.push(`model      ${settings.parakeet.modelPath ?? "not set"}`);
	}
	lines.push(`mode       ${settings.mode}`, `shortcut   ${settings.shortcut}`);
	return lines.join("\n");
}

/** A key already reachable through the environment, ignoring inline/file settings. */
function environmentKey(settings: VoiceSettings): string | undefined {
	return resolveDeepgramApiKey({
		...settings,
		deepgram: { ...settings.deepgram, apiKey: null, apiKeyFile: null },
	});
}

async function askForKey(io: SetupIo, settings: VoiceSettings): Promise<VoiceSettings | undefined> {
	const env = settings.deepgram.apiKeyEnv;
	const envOption = `Use the key already in ${env}`;
	const hasEnvKey = environmentKey(settings) !== undefined;
	const methods = hasEnvKey ? [envOption, PASTE, USE_FILE, SKIP] : [PASTE, USE_FILE, SKIP];
	const pick = await io.select("Deepgram API key", methods);
	if (pick === undefined) return undefined; // cancelled the whole wizard

	if (hasEnvKey && pick === envOption) {
		// Read from the environment at runtime; store nothing.
		return { ...settings, deepgram: { ...settings.deepgram, apiKey: null, apiKeyFile: null } };
	}

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

/**
 * Ask how the local model should run, and say what each choice means.
 *
 * Streaming is only offered for a model known to support it; a batch-only or
 * unknown model gets Batch and a sentence saying why.
 */
async function askRunMode(
	io: SetupIo,
	settings: VoiceSettings,
	supportsStreaming: boolean | undefined,
): Promise<VoiceSettings | undefined> {
	if (supportsStreaming !== true) {
		io.notify(
			supportsStreaming === false
				? "Using Batch mode: the model transcribes while you speak, in short slices, and results land a few seconds behind you. This model has no streaming support, so Batch is the only option."
				: "Using Batch mode: the model transcribes while you speak, in short slices. Streaming needs a model built for it.",
			"info",
		);
		return { ...settings, parakeet: { ...settings.parakeet, mode: "batch" } };
	}

	const pick = await io.select("How should the local model run?", [BATCH_MODE_LABEL, STREAMING_MODE_LABEL]);
	if (pick === undefined) return undefined;
	return {
		...settings,
		parakeet: { ...settings.parakeet, mode: pick.startsWith("Streaming") ? "streaming" : "batch" },
	};
}

async function askForModel(
	io: SetupIo,
	options: SetupOptions,
	settings: VoiceSettings,
): Promise<VoiceSettings | undefined> {
	const local = await (options.models ?? availableModels)();
	const choices = modelChoices(local);
	const pick = await io.select("Parakeet model", [...choices.map((choice) => choice.label), ENTER_PATH]);
	if (pick === undefined) return undefined;

	if (pick === ENTER_PATH) {
		const path = (await io.input("Path to a .gguf model"))?.trim();
		if (!path) return undefined;
		const applied = applySetting(settings, "model", path);
		if ("error" in applied) {
			io.notify(applied.error, "warning");
			return settings;
		}
		return askRunMode(io, applied.settings, undefined);
	}

	const choice = choices.find((entry) => entry.label === pick);
	if (!choice) return settings;
	if (choice.path) {
		return askRunMode(
			io,
			{ ...settings, parakeet: { ...settings.parakeet, modelPath: choice.path } },
			choice.model?.streaming,
		);
	}
	if (!choice.model) return settings;

	// Selecting a catalog model downloads it; there is no second prompt.
	const model = choice.model;
	io.progress?.(`Downloading ${model.name} (${formatSize(model.size)})…`);
	try {
		const download = options.download ?? downloadModel;
		const path = await download(model, (downloaded, total) => {
			const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
			io.progress?.(`Downloading ${model.name}… ${String(percent)}%`);
		});
		return askRunMode(io, { ...settings, parakeet: { ...settings.parakeet, modelPath: path } }, model.streaming);
	} catch (error) {
		io.notify(
			`Download failed: ${error instanceof Error ? error.message : String(error)}. Re-run /voice setup; the partial download is kept and resumed.`,
			"error",
		);
		// Abort rather than save a configuration with no usable model.
		return undefined;
	} finally {
		io.clearProgress?.();
	}
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

	if (!(await io.confirm("Save this setup?", summary(settings, environmentKey(settings) !== undefined)))) {
		return undefined;
	}
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
