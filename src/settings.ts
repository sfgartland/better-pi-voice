/**
 * Settings for better-pi-voice, stored beside pi-voice's own file so the two
 * are easy to find together.
 *
 * Every field is optional on disk; anything missing or malformed falls back to
 * a default and produces a warning rather than an error, because a broken
 * settings file should not make the microphone stop working.
 */

import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
		chunkSeconds: 15,
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
			shortcut: pickString(source.shortcut, DEFAULT_SETTINGS.shortcut, "shortcut", warnings),
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
	const fromEnv = process.env[settings.deepgram.apiKeyEnv];
	if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();

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
