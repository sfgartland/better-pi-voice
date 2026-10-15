/**
 * better-pi-voice — streaming voice input for pi.
 *
 * Registration only; the implementation is loaded on first use so startup stays
 * cheap and a broken voice setup cannot stop pi from starting.
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { availableModels, resolveParakeetModelPath } from "./src/backends/parakeet.ts";
import { ensureFirstRunSettings } from "./src/first-run.ts";
import { backendLabel, createRuntime, type Runtime } from "./src/runtime.ts";
import {
	applySetting,
	readSettings,
	resolveDeepgramApiKey,
	SETTABLE_KEYS,
	settingsPath,
	type VoiceSettings,
	writeSettings,
} from "./src/settings.ts";

const BACKENDS = ["deepgram", "parakeet"] as const;
type BackendId = (typeof BACKENDS)[number];

function isBackend(value: string): value is BackendId {
	return (BACKENDS as readonly string[]).includes(value);
}

async function addUserKeyterm(raw: string): Promise<string> {
	const { settings } = await readSettings();
	const term = raw.trim();
	if (!term) return "Nothing to add.";
	if (settings.keyterms.user.some((entry) => entry.toLowerCase() === term.toLowerCase())) {
		return `"${term}" is already in the keyterm list.`;
	}
	await writeSettings({ ...settings, keyterms: { ...settings.keyterms, user: [...settings.keyterms.user, term] } });
	return `Added keyterm "${term}". It applies from the next recording.`;
}

async function removeUserKeyterm(raw: string): Promise<string> {
	const { settings } = await readSettings();
	const term = raw.trim().toLowerCase();
	const next = settings.keyterms.user.filter((entry) => entry.toLowerCase() !== term);
	if (next.length === settings.keyterms.user.length) return `"${term}" is not in the keyterm list.`;
	await writeSettings({ ...settings, keyterms: { ...settings.keyterms, user: next } });
	return `Removed keyterm "${raw.trim()}".`;
}

function describe(settings: VoiceSettings, runtime: Runtime | undefined): string {
	const lines = [
		"better-pi-voice",
		`  backend    ${backendLabel(settings)}`,
		`  mode       ${settings.mode}`,
		`  shortcut   ${settings.shortcut}`,
		`  language   ${settings.language}`,
		`  keyterms   ${
			settings.keyterms.enabled
				? `on (seed ${settings.keyterms.seed ? "on" : "off"}, ${String(settings.keyterms.user.length)} custom)`
				: "off"
		}`,
		`  correction ${settings.correction}`,
		`  state      ${runtime?.state ?? "idle"}`,
		`  settings   ${settingsPath()}`,
	];
	if (settings.backend === "deepgram") {
		const keyEnv = settings.deepgram.apiKeyEnv;
		const apiKeyFile = settings.deepgram.apiKeyFile;
		const hasKey = resolveDeepgramApiKey(settings) !== undefined;
		lines.push(
			`  api key    ${
				hasKey
					? `set (${keyEnv}${apiKeyFile ? ` or ${apiKeyFile}` : ""})`
					: apiKeyFile
						? `MISSING (${keyEnv}; no key in ${apiKeyFile})`
						: `MISSING (${keyEnv})`
			}`,
		);
	}
	return lines.join("\n");
}

export default async function betterPiVoice(pi: ExtensionAPI): Promise<void> {
	const { settings, warnings } = await readSettings();
	for (const warning of warnings) process.stderr.write(`[better-pi-voice] ${warning}\n`);

	let runtime: Runtime | undefined;
	let runtimePromise: Promise<Runtime> | undefined;
	let disposed = false;

	const ensureRuntime = async (ctx: ExtensionContext): Promise<Runtime | undefined> => {
		if (disposed) return undefined;
		if (runtime) return runtime;
		runtimePromise ??= readSettings().then(({ settings: fresh }) => createRuntime(pi, ctx, fresh, false));
		let created: Runtime;
		try {
			created = await runtimePromise;
		} catch (error) {
			// A transient failure must not pin a rejected promise and disable voice for
			// the rest of the session.
			runtimePromise = undefined;
			ctx.ui.notify(`Voice input could not start: ${error instanceof Error ? error.message : String(error)}`, "error");
			return undefined;
		}
		if (disposed) {
			// session_shutdown won the race; do not install a live runtime.
			await created.dispose();
			return undefined;
		}
		runtime = created;
		return runtime;
	};

	pi.registerCommand("voice", {
		description: "Voice input status and settings: /voice backend|model|set",
		handler: async (args, ctx) => {
			// pi's declared type says `args: string`, but a bare command invocation
			// passes nothing at all, so this must tolerate undefined.
			const [action, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const value = rest.join(" ").trim();

			if (action === "backend") {
				let target = value;
				if (!target) {
					if (!ctx.hasUI) {
						ctx.ui.notify("Pass a backend explicitly: /voice backend deepgram|parakeet", "warning");
						return;
					}
					target = (await ctx.ui.select("Voice backend", [...BACKENDS])) ?? "";
				}
				if (!target) return; // cancelled
				if (!isBackend(target)) {
					ctx.ui.notify(`Unknown backend "${target}". Use one of: ${BACKENDS.join(", ")}.`, "warning");
					return;
				}
				const { settings: current } = await readSettings();
				if (current.backend === target) {
					ctx.ui.notify(`Voice backend is already ${target} (${backendLabel(current)}).`, "info");
					return;
				}
				if (target === "parakeet" && !(await resolveParakeetModelPath(current.parakeet.modelPath))) {
					ctx.ui.notify("No Parakeet model found. Run /voice model to pick one, then switch the backend.", "warning");
					return;
				}
				const next = { ...current, backend: target };
				await writeSettings(next);
				// Notify before reloading: the reload replaces this runtime, so
				// nothing after the await may touch it.
				ctx.ui.notify(`Voice backend set to ${backendLabel(next)}. Reloading…`, "info");
				await ctx.reload();
				return;
			}

			if (action === "model") {
				const { settings: current } = await readSettings();
				let target = value;
				if (!target) {
					const models = await availableModels();
					if (models.length === 0) {
						ctx.ui.notify(
							"No Parakeet models found under the Hugging Face cache. Pass a path: /voice model /path/to/model.gguf",
							"warning",
						);
						return;
					}
					if (!ctx.hasUI) {
						ctx.ui.notify(
							`Pass a path explicitly. Available: ${models.map((model) => model.label).join(", ")}`,
							"warning",
						);
						return;
					}
					const chosen = await ctx.ui.select(
						"Parakeet model",
						models.map((model) => model.label),
					);
					if (!chosen) return; // cancelled
					target = models.find((model) => model.label === chosen)?.path ?? "";
				}
				if (!target) return;
				// Both the explicit path and the picker go through the same validation,
				// so a dangling path cannot be written by either route.
				const result = applySetting(current, "model", target);
				if ("error" in result) {
					ctx.ui.notify(result.error, "warning");
					return;
				}
				await writeSettings(result.settings);
				const stored = result.settings.parakeet.modelPath ?? target;
				const backendNote =
					result.settings.backend === "parakeet"
						? ""
						: " The backend is still deepgram; /voice backend parakeet to use it.";
				ctx.ui.notify(`Parakeet model set to ${basename(stored)}.${backendNote} Reloading…`, "info");
				await ctx.reload();
				return;
			}

			if (action === "set") {
				if (rest.length < 2) {
					ctx.ui.notify(`Usage: /voice set <key> <value>. Keys: ${SETTABLE_KEYS.join(", ")}.`, "warning");
					return;
				}
				const key = rest[0]!;
				const settingValue = rest.slice(1).join(" ").trim();
				const { settings: current } = await readSettings();
				const result = applySetting(current, key, settingValue);
				if ("error" in result) {
					ctx.ui.notify(result.error, "warning");
					return;
				}
				await writeSettings(result.settings);
				ctx.ui.notify(`${key} set to ${settingValue}. Reloading…`, "info");
				await ctx.reload();
				return;
			}

			const { settings: current } = await readSettings();
			ctx.ui.notify(describe(current, runtime), "info");
		},
	});

	pi.registerCommand("voice-keyterms", {
		description: "List, add or remove custom voice keyterms",
		handler: async (args, ctx) => {
			const [action, ...rest] = (args ?? "").trim().split(/\s+/);
			const value = rest.join(" ").trim();
			if (action === "add" && value) {
				ctx.ui.notify(await addUserKeyterm(value), "info");
				return;
			}
			if (action === "remove" && value) {
				ctx.ui.notify(await removeUserKeyterm(value), "info");
				return;
			}
			const { settings: current } = await readSettings();
			ctx.ui.notify(
				current.keyterms.user.length > 0
					? `Custom keyterms:\n  ${current.keyterms.user.join("\n  ")}`
					: "No custom keyterms yet. Use /voice-keyterms add <term>.",
				"info",
			);
		},
	});

	// Tap mode is a plain toggle, so an ordinary shortcut registration is enough.
	if (settings.mode === "tap") {
		pi.registerShortcut(settings.shortcut as KeyId, {
			description: "Start or stop voice input",
			handler: async (ctx) => {
				const active = await ensureRuntime(ctx);
				active?.toggle();
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		// A duplicate session_start must not leak the previous runtime.
		await runtime?.dispose();
		disposed = false;
		runtimePromise = undefined;
		runtime = undefined;
		const firstRun = await ensureFirstRunSettings();
		if (firstRun) ctx.ui.notify(firstRun.message, firstRun.wrote ? "info" : "warning");
		await ensureRuntime(ctx);
	});

	pi.on("session_shutdown", async () => {
		disposed = true;
		await runtime?.dispose();
		runtime = undefined;
		runtimePromise = undefined;
	});
}
