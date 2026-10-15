/**
 * First-run setup.
 *
 * With no settings file, holding the shortcut does nothing and says nothing.
 * Pick a backend the machine can actually use and write it down, so a new
 * install works on the first keypress: Deepgram when a key is already reachable
 * (environment or a dotenv file the user pointed at), otherwise the best local
 * model already on disk, otherwise nothing plus an explanation — a written
 * configuration that cannot work is worse than no configuration at all.
 */

import { existsSync } from "node:fs";
import { type AvailableModel, availableModels } from "./backends/parakeet.ts";
import {
	DEFAULT_SETTINGS,
	resolveDeepgramApiKey,
	settingsPath,
	type VoiceSettings,
	writeSettings,
} from "./settings.ts";

/**
 * Preference order from docs/reports/2026-10-15-voice-model-benchmarks.md:
 * fastest and smallest first, and only models that survive a chunk boundary
 * (canary is ranked above the slower ones only because it is second-best on
 * speed among the models this machine measured).
 */
const MODEL_PREFERENCE = [
	"parakeet-tdt_ctc-110m",
	"canary-180m",
	"parakeet-tdt-0.6b-v2",
	"nemotron-3.5-asr-streaming-0.6b",
	"sensevoice",
	"parakeet-unified-en-0.6b",
];

/** The model to configure out of the box, chosen from what is already on disk. */
export function pickBestModel(models: AvailableModel[]): AvailableModel | undefined {
	for (const preferred of MODEL_PREFERENCE) {
		const match = models.find((model) => model.label.toLowerCase().includes(preferred));
		if (match) return match;
	}
	return models[0];
}

export type FirstRunOutcome =
	| { wrote: true; settings: VoiceSettings; message: string }
	| { wrote: false; message: string };

/**
 * If no settings file exists yet, choose and write one. Returns undefined when
 * there is already a file to respect.
 */
export async function ensureFirstRunSettings(): Promise<FirstRunOutcome | undefined> {
	if (existsSync(settingsPath())) return undefined;

	if (resolveDeepgramApiKey(DEFAULT_SETTINGS)) {
		await writeSettings(DEFAULT_SETTINGS);
		return {
			wrote: true,
			settings: DEFAULT_SETTINGS,
			message: `better-pi-voice is using Deepgram ${DEFAULT_SETTINGS.deepgram.model}. Hold ${DEFAULT_SETTINGS.shortcut} to talk.`,
		};
	}

	const best = pickBestModel(await availableModels());
	if (!best) {
		return {
			wrote: false,
			message:
				`better-pi-voice is not configured: no ${DEFAULT_SETTINGS.deepgram.apiKeyEnv} and no local Parakeet ` +
				"model under the Hugging Face cache. Set the key, or run /voice model <path>.",
		};
	}

	const settings: VoiceSettings = {
		...DEFAULT_SETTINGS,
		backend: "parakeet",
		parakeet: { ...DEFAULT_SETTINGS.parakeet, modelPath: best.path },
	};
	await writeSettings(settings);
	return {
		wrote: true,
		settings,
		message:
			`better-pi-voice is using the local Parakeet model ${best.label}. Hold ${settings.shortcut} to talk. ` +
			`No ${DEFAULT_SETTINGS.deepgram.apiKeyEnv} was found, so the cloud backend is off.`,
	};
}
