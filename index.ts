/**
 * better-pi-voice — streaming voice input for pi.
 *
 * Registration only; the implementation is loaded on first use so startup stays
 * cheap and a broken voice setup cannot stop pi from starting.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { backendLabel, createRuntime, type Runtime } from "./src/runtime.ts";
import { readSettings, settingsPath, type VoiceSettings, writeSettings } from "./src/settings.ts";

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
		`  backend    ${settings.backend}${settings.backend === "deepgram" ? ` (${settings.deepgram.model})` : ""}`,
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
		const hasEnv = Boolean(process.env[keyEnv]);
		lines.push(
			`  api key    ${
				hasEnv
					? `set (${keyEnv})`
					: settings.deepgram.apiKeyFile
						? `from ${settings.deepgram.apiKeyFile}`
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
		runtime = await runtimePromise;
		return runtime;
	};

	pi.registerCommand("voice", {
		description: "Voice input status; /voice backend [deepgram|parakeet] to switch",
		handler: async (args, ctx) => {
			// pi's declared type says `args: string`, but a bare command invocation
			// passes nothing at all, so this must tolerate undefined.
			const [action, value] = (args ?? "").trim().split(/\s+/);

			if (action === "backend") {
				let target = value ?? "";
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
				await writeSettings({ ...current, backend: target });
				const label = backendLabel({ ...current, backend: target });
				// Notify before reloading: the reload replaces this runtime, so
				// nothing after the await may touch it.
				ctx.ui.notify(`Voice backend set to ${label}. Reloading…`, "info");
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
		disposed = false;
		runtimePromise = undefined;
		runtime = undefined;
		await ensureRuntime(ctx);
	});

	pi.on("session_shutdown", async () => {
		disposed = true;
		runtime?.dispose();
		runtime = undefined;
		runtimePromise = undefined;
	});
}
