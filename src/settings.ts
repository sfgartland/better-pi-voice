/**
 * Settings for better-pi-voice, stored beside pi-voice's own file so the two
 * are easy to find together.
 *
 * Every field is optional on disk; anything missing or malformed falls back to
 * a default and produces a warning rather than an error, because a broken
 * settings file should not make the microphone stop working.
 */

import { readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CorrectionMode } from "./keyterms/correct.ts";

export const SETTINGS_FILENAME = "better-pi-voice.json";
export const DEFAULT_SHORTCUT = "ctrl+alt+z";

export type BackendId = "deepgram" | "parakeet";
export type VoiceMode = "hold" | "tap";

export type VoiceSettings = {
	backend: BackendId;
	shortcut: string;
	mode: VoiceMode;
	language: string;
	deepgram: {
		apiKeyEnv: string;
		/** Optional dotenv-style file to read the key from when the env var is unset. */
		apiKeyFile: string | null;
		model: string;
		smartFormat: boolean;
		endpointingMs: number;
		utteranceEndMs: number;
	};
	parakeet: {
		modelPath: string | null;
		/** "batch" transcribes in pieces; "streaming" decodes continuously. */
		mode: "streaming" | "batch";
		/** Batch mode: chunk length while recording. 0 waits until the end. */
		chunkSeconds: number;
		/**
		 * Batch mode: how quiet a boundary must be to cut at. "auto" derives it from
		 * each recording's own noise floor, which is what works across rooms; a number
		 * pins it. Lower is stricter.
		 */
		silenceLevel: number | "auto";
		/** Hold the model in memory this long after the last recording. */
		idleUnloadMs: number;
		/** Hand the memory back early once load per CPU reaches this. */
		loadShedRatio: number;
	};
	keyterms: {
		enabled: boolean;
		seed: boolean;
		mineSessionFiles: boolean;
		maxTerms: number;
		user: string[];
	};
	correction: CorrectionMode;
	submitOnStop: boolean;
};

export const DEFAULT_SETTINGS: VoiceSettings = {
	backend: "deepgram",
	shortcut: DEFAULT_SHORTCUT,
	mode: "hold",
	language: "en",
	deepgram: {
		apiKeyEnv: "DEEPGRAM_API_KEY",
		apiKeyFile: null,
		model: "nova-3",
		smartFormat: true,
		endpointingMs: 300,
		utteranceEndMs: 1000,
	},
	parakeet: {
		modelPath: null,
		// Batch is several times faster here, and it is the only option for the
		// small models, none of which can stream. Chunking means text still
		// arrives while you speak, in pieces, rather than all at the end.
		mode: "batch",
		// A target, not a limit: audio is cut at the first real pause at or after
		// 70% of this, so short and medium dictation arrives in one piece and only
		// long speech is chunked.
		chunkSeconds: 30,
		// Derived per recording. A fixed number cannot span rooms: one recording
		// measured here never dropped below 0.05 (music playing) while another
		// paused around 0.3. Pin a number only to override that.
		silenceLevel: "auto",
		// Load is fast enough on the machines this was built for (about 0.4s
		// warm) that holding ~700MB between recordings is not worth it. The
		// residency machinery below stays for larger models and other hardware.
		idleUnloadMs: 0,
		loadShedRatio: 0.8,
	},
	keyterms: {
		enabled: true,
		seed: true,
		mineSessionFiles: true,
		maxTerms: 60,
		user: [],
	},
	correction: "safe",
	submitOnStop: false,
};

export function settingsPath(): string {
	return join(getAgentDir(), SETTINGS_FILENAME);
}

/**
 * Persist settings.
 *
 * Writes the fully merged object, so the file ends up self-documenting at the
 * cost of no longer looking like the minimal file a user hand-wrote. Unknown
 * fields are not preserved, which is the trade for not carrying a schema.
 *
 * Creates the agent directory if it is missing: the first write must not fail
 * just because nothing has been written to this agent dir before.
 */
export async function writeSettings(settings: VoiceSettings): Promise<void> {
	const path = settingsPath();
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(settings, null, "\t")}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(value: unknown, fallback: string, field: string, warnings: string[]): string {
	if (value === undefined) return fallback;
	if (typeof value === "string" && value.trim().length > 0) return value;
	warnings.push(`${field} must be a non-empty string; using "${fallback}".`);
	return fallback;
}

function pickBoolean(value: unknown, fallback: boolean, field: string, warnings: string[]): boolean {
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	warnings.push(`${field} must be true or false; using ${String(fallback)}.`);
	return fallback;
}

function pickInteger(value: unknown, fallback: number, field: string, warnings: string[], min = 0): number {
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isInteger(value) && value >= min) return value;
	warnings.push(`${field} must be an integer >= ${min}; using ${fallback}.`);
	return fallback;
}

function pickNumber(value: unknown, fallback: number, field: string, warnings: string[], min = 0): number {
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isFinite(value) && value >= min) return value;
	warnings.push(`${field} must be a number >= ${min}; using ${fallback}.`);
	return fallback;
}

/** A level threshold, or the string "auto" to derive one per recording. */
function pickNumberOrAuto(value: unknown, field: string, warnings: string[]): number | "auto" {
	if (value === undefined || value === "auto") return "auto";
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	warnings.push(`${field} must be a number >= 0 or "auto"; using "auto".`);
	return "auto";
}

function pickEnum<T extends string>(
	value: unknown,
	allowed: readonly T[],
	fallback: T,
	field: string,
	warnings: string[],
): T {
	if (value === undefined) return fallback;
	if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
	warnings.push(`${field} must be one of ${allowed.join(", ")}; using "${fallback}".`);
	return fallback;
}

function pickStringArray(value: unknown, fallback: string[], field: string, warnings: string[]): string[] {
	if (value === undefined) return fallback;
	if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return [...value];
	warnings.push(`${field} must be an array of strings; ignoring it.`);
	return fallback;
}

function pickNullableString(value: unknown, fallback: string | null, field: string, warnings: string[]): string | null {
	if (value === undefined || value === null) return fallback;
	if (typeof value === "string" && value.trim().length > 0) return value;
	warnings.push(`${field} must be a non-empty string or null; using ${fallback === null ? "null" : `"${fallback}"`}.`);
	return fallback;
}

/** Modifiers pi-tui understands, mirroring its unexported key-id parser. */
const SHORTCUT_MODIFIERS = ["shift", "alt", "ctrl", "super"];

/**
 * Whether a string is a key identifier pi-tui can match, such as `ctrl+alt+z`.
 *
 * pi-tui does not export its key-id parser, so this mirrors it: known modifiers
 * each used at most once, then a single non-empty base key. A misspelling like
 * `crtl+alt+z` fails because `crtl` is not a modifier and the leftover contains
 * `+`. Without this a typo would be written, reported as success, and then
 * silently match nothing.
 */
export function isValidShortcut(value: string): boolean {
	let key = value.trim().toLowerCase();
	const seen = new Set<string>();
	while (true) {
		const modifier = SHORTCUT_MODIFIERS.find((name) => key.startsWith(`${name}+`));
		if (!modifier) break;
		if (seen.has(modifier)) return false;
		seen.add(modifier);
		key = key.slice(modifier.length + 1);
	}
	return key.length > 0 && (key === "+" || !key.includes("+"));
}

function pickShortcut(value: unknown, fallback: string, warnings: string[]): string {
	if (value === undefined) return fallback;
	if (typeof value === "string" && isValidShortcut(value)) return value.trim();
	warnings.push(`shortcut must look like "ctrl+alt+z"; using "${fallback}".`);
	return fallback;
}

/** Merge a parsed settings file over the defaults, reporting anything unusable. */
export function parseSettings(raw: unknown): { settings: VoiceSettings; warnings: string[] } {
	const warnings: string[] = [];
	const source = isRecord(raw) ? raw : {};
	if (raw !== undefined && !isRecord(raw)) {
		warnings.push(`${SETTINGS_FILENAME} must contain a JSON object; using defaults.`);
	}

	const deepgram = isRecord(source.deepgram) ? source.deepgram : {};
	const parakeet = isRecord(source.parakeet) ? source.parakeet : {};
	const keyterms = isRecord(source.keyterms) ? source.keyterms : {};

	return {
		settings: {
			backend: pickEnum(
				source.backend,
				["deepgram", "parakeet"] as const,
				DEFAULT_SETTINGS.backend,
				"backend",
				warnings,
			),
			shortcut: pickShortcut(source.shortcut, DEFAULT_SETTINGS.shortcut, warnings),
			mode: pickEnum(source.mode, ["hold", "tap"] as const, DEFAULT_SETTINGS.mode, "mode", warnings),
			language: pickString(source.language, DEFAULT_SETTINGS.language, "language", warnings),
			deepgram: {
				apiKeyEnv: pickString(deepgram.apiKeyEnv, DEFAULT_SETTINGS.deepgram.apiKeyEnv, "deepgram.apiKeyEnv", warnings),
				apiKeyFile: pickNullableString(deepgram.apiKeyFile, null, "deepgram.apiKeyFile", warnings),
				model: pickString(deepgram.model, DEFAULT_SETTINGS.deepgram.model, "deepgram.model", warnings),
				smartFormat: pickBoolean(
					deepgram.smartFormat,
					DEFAULT_SETTINGS.deepgram.smartFormat,
					"deepgram.smartFormat",
					warnings,
				),
				endpointingMs: pickInteger(
					deepgram.endpointingMs,
					DEFAULT_SETTINGS.deepgram.endpointingMs,
					"deepgram.endpointingMs",
					warnings,
				),
				utteranceEndMs: pickInteger(
					deepgram.utteranceEndMs,
					DEFAULT_SETTINGS.deepgram.utteranceEndMs,
					"deepgram.utteranceEndMs",
					warnings,
				),
			},
			parakeet: {
				modelPath: pickNullableString(parakeet.modelPath, null, "parakeet.modelPath", warnings),
				mode: pickEnum(
					parakeet.mode,
					["streaming", "batch"] as const,
					DEFAULT_SETTINGS.parakeet.mode,
					"parakeet.mode",
					warnings,
				),
				chunkSeconds: pickInteger(
					parakeet.chunkSeconds,
					DEFAULT_SETTINGS.parakeet.chunkSeconds,
					"parakeet.chunkSeconds",
					warnings,
				),
				silenceLevel: pickNumberOrAuto(parakeet.silenceLevel, "parakeet.silenceLevel", warnings),
				idleUnloadMs: pickInteger(
					parakeet.idleUnloadMs,
					DEFAULT_SETTINGS.parakeet.idleUnloadMs,
					"parakeet.idleUnloadMs",
					warnings,
				),
				loadShedRatio: pickNumber(
					parakeet.loadShedRatio,
					DEFAULT_SETTINGS.parakeet.loadShedRatio,
					"parakeet.loadShedRatio",
					warnings,
				),
			},
			keyterms: {
				enabled: pickBoolean(keyterms.enabled, DEFAULT_SETTINGS.keyterms.enabled, "keyterms.enabled", warnings),
				seed: pickBoolean(keyterms.seed, DEFAULT_SETTINGS.keyterms.seed, "keyterms.seed", warnings),
				mineSessionFiles: pickBoolean(
					keyterms.mineSessionFiles,
					DEFAULT_SETTINGS.keyterms.mineSessionFiles,
					"keyterms.mineSessionFiles",
					warnings,
				),
				maxTerms: pickInteger(keyterms.maxTerms, DEFAULT_SETTINGS.keyterms.maxTerms, "keyterms.maxTerms", warnings, 1),
				user: pickStringArray(keyterms.user, [], "keyterms.user", warnings),
			},
			correction: pickEnum(
				source.correction,
				["off", "safe", "report"] as const,
				DEFAULT_SETTINGS.correction,
				"correction",
				warnings,
			),
			submitOnStop: pickBoolean(source.submitOnStop, DEFAULT_SETTINGS.submitOnStop, "submitOnStop", warnings),
		},
		warnings,
	};
}

export const SETTABLE_KEYS = [
	"backend",
	"mode",
	"model",
	"language",
	"correction",
	"submitOnStop",
	"chunkSeconds",
	"silenceLevel",
	"shortcut",
] as const;
export type SettableKey = (typeof SETTABLE_KEYS)[number];

/** The warning name `parseSettings` uses for each settable key. A Map, not an
 * object literal: `applySetting` takes arbitrary user input, and inherited
 * members like `toString` must not resolve to a field name. */
const FIELD_FOR_KEY = new Map<SettableKey, string>([
	["backend", "backend"],
	["mode", "mode"],
	["model", "parakeet.modelPath"],
	["language", "language"],
	["correction", "correction"],
	["submitOnStop", "submitOnStop"],
	["chunkSeconds", "parakeet.chunkSeconds"],
	["silenceLevel", "parakeet.silenceLevel"],
	["shortcut", "shortcut"],
]);

function parseBooleanText(value: string): boolean | undefined {
	const text = value.trim().toLowerCase();
	if (["true", "1", "on", "yes"].includes(text)) return true;
	if (["false", "0", "off", "no"].includes(text)) return false;
	return undefined;
}

/** Expand `~`, make absolute, and require a file that is actually a GGUF. */
function resolveModelFile(value: string): { path: string } | { error: string } {
	const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
	const absolute = resolve(expanded);
	let isFile = false;
	try {
		isFile = statSync(absolute).isFile();
	} catch {
		isFile = false;
	}
	if (!isFile) return { error: `No file at ${value}.` };
	if (!/\.gguf$/i.test(absolute)) return { error: `${value} is not a .gguf model file.` };
	return { path: absolute };
}

/** Coerce one typed-by-the-user value onto the object, or name why it cannot be. */
function withSetting(settings: VoiceSettings, key: SettableKey, value: string): VoiceSettings | string {
	switch (key) {
		case "backend":
			return { ...settings, backend: value as VoiceSettings["backend"] };
		case "mode":
			return { ...settings, mode: value as VoiceSettings["mode"] };
		case "model": {
			const model = resolveModelFile(value);
			return "error" in model
				? model.error
				: { ...settings, parakeet: { ...settings.parakeet, modelPath: model.path } };
		}
		case "language":
			return { ...settings, language: value };
		case "correction":
			return { ...settings, correction: value as CorrectionMode };
		case "shortcut":
			// Validated by parseSettings (pickShortcut), like the enum fields.
			return { ...settings, shortcut: value.trim() };
		case "submitOnStop": {
			const parsed = parseBooleanText(value);
			return parsed === undefined ? "submitOnStop must be true or false." : { ...settings, submitOnStop: parsed };
		}
		case "chunkSeconds": {
			const parsed = Number(value);
			return !Number.isInteger(parsed) || parsed < 0
				? "chunkSeconds must be an integer >= 0."
				: { ...settings, parakeet: { ...settings.parakeet, chunkSeconds: parsed } };
		}
		case "silenceLevel": {
			if (value.trim() === "auto") {
				return { ...settings, parakeet: { ...settings.parakeet, silenceLevel: "auto" } };
			}
			const parsed = Number(value);
			return !Number.isFinite(parsed) || parsed < 0
				? `silenceLevel must be a number >= 0 or "auto".`
				: { ...settings, parakeet: { ...settings.parakeet, silenceLevel: parsed } };
		}
		default:
			return `Unknown setting "${key}".`;
	}
}

/**
 * Apply one `/voice set <key> <value>` change.
 *
 * The value is coerced to its field's type, then the whole object is run
 * through `parseSettings`: if the real parser would fall back on that field,
 * the change is rejected rather than silently written as a default. That keeps
 * one source of truth for what a valid value is.
 */
export function applySetting(
	settings: VoiceSettings,
	key: string,
	value: string,
): { settings: VoiceSettings } | { error: string } {
	const field = FIELD_FOR_KEY.get(key as SettableKey);
	if (!field) return { error: `Unknown setting "${key}". Try: ${SETTABLE_KEYS.join(", ")}.` };

	const mutated = withSetting(settings, key as SettableKey, value);
	if (typeof mutated === "string") return { error: mutated };

	const { settings: parsed, warnings } = parseSettings(mutated);
	const offender = warnings.find((warning) => warning.startsWith(field));
	if (offender) return { error: offender };
	return { settings: parsed };
}

/** Read the settings file. A missing file is not an error. */
export async function readSettings(): Promise<{ settings: VoiceSettings; warnings: string[] }> {
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(settingsPath(), "utf8")) as unknown;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { settings: DEFAULT_SETTINGS, warnings: [] };
		return {
			settings: DEFAULT_SETTINGS,
			warnings: [`Could not read ${SETTINGS_FILENAME}: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
	return parseSettings(raw);
}

/**
 * Find the Deepgram API key.
 *
 * The environment wins, then an optional dotenv-style file. The file exists
 * because a key often already lives in another project's `.env`, and being told
 * to export it in every shell is worse than reading it once.
 *
 * Never stored in the settings file itself.
 */
export function resolveDeepgramApiKey(settings: VoiceSettings): string | undefined {
	const raw = process.env[settings.deepgram.apiKeyEnv];
	// `process.env` inherits from Object.prototype, so a settings file that names
	// `toString` or `__proto__` would otherwise yield a function, not a key.
	if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();

	const file = settings.deepgram.apiKeyFile;
	if (!file) return undefined;
	try {
		return parseDotenv(readFileSync(file, "utf8"), settings.deepgram.apiKeyEnv);
	} catch {
		return undefined;
	}
}

/**
 * Parse `NAME=value` lines and return the wanted name, falling back to any name
 * containing "deepgram" so a differently-spelled key still works.
 */
export function parseDotenv(contents: string, preferredName: string): string | undefined {
	const entries: Array<[string, string]> = [];
	for (const line of contents.split("\n")) {
		const match = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		// Trim, then unquote, then trim again: `KEY="  abc  "` must yield "abc".
		const value = match[2]!
			.trim()
			.replace(/^['"]|['"]$/g, "")
			.trim();
		if (value.length > 0) entries.push([match[1]!, value]);
	}

	const exact = entries.find(([name]) => name === preferredName);
	if (exact) return exact[1];

	const loose = entries.find(([name]) => name.toLowerCase().includes("deepgram"));
	return loose?.[1];
}
