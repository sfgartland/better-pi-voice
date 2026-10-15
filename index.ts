/**
 * better-pi-voice — streaming voice input for pi.
 *
 * Registration only; the implementation is loaded on first use so startup stays
 * cheap and a broken voice setup cannot stop pi from starting.
 */

import { writeFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { createRuntime, type Runtime } from "./src/runtime.ts";
import { DEFAULT_SETTINGS, readSettings, settingsPath, type VoiceSettings } from "./src/settings.ts";

/** Re-read the settings file, keeping the defaults for anything missing. */
async function loadSettings(): Promise<{ settings: VoiceSettings; warnings: string[] }> {
	return readSettings();
}

async function addUserKeyterm(term: string): Promise<string> {
	const { settings } = await readSettings();
	const trimmed = term.trim();
	if (!trimmed) return "Nothing to add.";
	const existing = settings.keyterms.user;
	if (existing.some((entry) => entry.toLowerCase() === trimmed.toLowerCase())) {
		return `"${trimmed}" is already in the keyterm list.`;
	}
	const next: VoiceSettings = { ...settings, keyterms: { ...settings.keyterms, user: [...existing, trimmed] } };
	await writeFile(settingsPath(), `${JSON.stringify(next, null, "\t")}\n`, "utf8");
	return `Added keyterm "${trimmed}". It applies from the next recording.`;
}

async function removeUserKeyterm(term: string): Promise<string> {
	const { settings } = await readSettings();
	const trimmed = term.trim().toLowerCase();
	const next = settings.keyterms.user.filter((entry) => entry.toLowerCase() !== trimmed);
	if (next.length === settings.keyterms.user.length) return `"${term}" is not in the keyterm list.`;
	await writeFile(
		settingsPath(),
		`${JSON.stringify({ ...settings, keyterms: { ...settings.keyterms, user: next } }, null, "\t")}\n`,
		"utf8",
	);
	return `Removed keyterm "${term}".`;
}

function describe(settings: VoiceSettings, runtime: Runtime | undefined): string {
	const lines = [
		`better-pi-voice`,
		`  backend    ${settings.backend}${settings.backend === "deepgram" ? ` (${settings.deepgram.model})` : ""}`,
		`  mode       ${settings.mode}`,
		`  shortcut   ${settings.shortcut}`,
		`  language   ${settings.language}`,
		`  keyterms   ${settings.keyterms.enabled ? `on (seed ${settings.keyterms.seed ? "on" : "off"}, ${String(settings.keyterms.user.length)} custom)` : "off"}`,
		`  correction ${settings.correction}`,
		`  state      ${runtime?.state ?? "idle"}`,
		`  settings   ${settingsPath()}`,
	];
	if (settings.backend === "deepgram") {
		lines.push(
			`  api key    ${process.env[settings.deepgram.apiKeyEnv] ? `set (${settings.deepgram.apiKeyEnv})` : `MISSING (${settings.deepgram.apiKeyEnv})`}`,
		);
	}
	return lines.join("\n");
}

export default async function betterPiVoice(pi: ExtensionAPI): Promise<void> {
	const { settings, warnings } = await loadSettings();
	for (const warning of warnings) process.stderr.write(`[better-pi-voice] ${warning}\n`);

	let runtime: Runtime | undefined;
	let runtimePromise: Promise<Runtime> | undefined;
	let disposed = false;

	const ensureRuntime = async (ctx: ExtensionContext): Promise<Runtime | undefined> => {
		if (disposed) return undefined;
		if (runtime) return runtime;
		runtimePromise ??= loadSettings().then(({ settings: fresh }) => createRuntime(pi, ctx, fresh, false));
		runtime = await runtimePromise;
		return runtime;
	};

	pi.registerCommand("voice", {
		description: "Show voice input status and configuration",
		handler: async (_args, ctx) => {
			const { settings: current } = await readSettings();
			ctx.ui.notify(describe(current, runtime), "info");
		},
	});

	pi.registerCommand("voice-keyterms", {
		description: "List, add or remove custom voice keyterms",
		handler: async (args, ctx) => {
			const [action, ...rest] = args.trim().split(/\s+/);
			const value = rest.join(" ");
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
		disposed = false;
		runtimePromise = undefined;
		runtime = undefined;
		await ensureRuntime(ctx);
		if (ctx.mode === "tui" && settings.mode === "hold") {
			ctx.ui.setStatus("better-pi-voice-hint", undefined);
		}
	});

	pi.on("session_shutdown", async () => {
		disposed = true;
		runtime?.dispose();
		runtime = undefined;
		runtimePromise = undefined;
	});

	// Keep the default shortcut discoverable without starting anything.
	if (settings.shortcut === DEFAULT_SETTINGS.shortcut) {
		void 0;
	}
}
