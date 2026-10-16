/**
 * The end-of-setup overview pane: a static summary of what was just configured
 * and how to use it. It replaces the live "Try it" pane — that pane is kept in
 * `try-it.ts` for later reference, but is no longer wired into the wizard.
 *
 * The pane blocks nothing it does not have to: Enter closes it, and Esc loops
 * back into the wizard so a wrong choice can be fixed on the spot. It points at
 * `/voice setup` for changing anything later.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey } from "@earendil-works/pi-tui";
import { settingsPath, type VoiceSettings } from "./settings.ts";

export type OverviewOutcome = "done" | "change";

/** Where the Deepgram key comes from, for the summary line. */
function keySource(settings: VoiceSettings): string {
	if (settings.deepgram.apiKeyFile) return settings.deepgram.apiKeyFile;
	if (process.env[settings.deepgram.apiKeyEnv]) return `${settings.deepgram.apiKeyEnv} (environment)`;
	if (settings.deepgram.apiKey) return "stored in settings";
	return "not set";
}

/** The lines the overview pane shows. Exported so they can be asserted directly. */
export function overviewLines(settings: VoiceSettings): string[] {
	const lines = ["better-pi-voice is ready", ""];
	lines.push(
		`  backend    ${
			settings.backend === "deepgram" ? `Deepgram (${settings.deepgram.model})` : `Parakeet (${settings.parakeet.mode})`
		}`,
	);
	if (settings.backend === "deepgram") {
		lines.push(`  key        ${keySource(settings)}`);
	} else {
		lines.push(`  model      ${settings.parakeet.modelPath ?? "not set"}`);
	}
	lines.push(
		`  mode       ${settings.mode === "hold" ? "hold to talk" : "tap to start and stop"}`,
		`  shortcut   ${settings.shortcut}`,
		`  language   ${settings.language}`,
		`  keyterms   ${settings.keyterms.enabled ? "on" : "off"}`,
		`  settings   ${settingsPath()}`,
		"",
		"How to use it",
		settings.mode === "hold"
			? `  Hold ${settings.shortcut}, speak, then let go. The words land in the editor;`
			: `  Press ${settings.shortcut} to start, press it again to stop. The words land in the editor;`,
		"  nothing is sent until you submit the prompt.",
		"",
		"Change any of this later with /voice setup.",
		"  /voice           show the current status",
		"  /voice-keyterms  add your own jargon",
		"",
		"Enter: close    Esc: change settings",
	);
	return lines;
}

export class OverviewPane implements Component {
	constructor(
		private readonly done: (outcome: OverviewOutcome) => void,
		private readonly lines: string[],
	) {}

	render(_width: number): string[] {
		return this.lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done("change");
			return;
		}
		if (matchesKey(data, "enter")) this.done("done");
	}

	invalidate(): void {}
}

/**
 * Show the overview. Returns "done" when the user closes it and "change" when
 * they want to adjust, and "done" immediately when there is no TUI to show it.
 */
export async function runOverview(ctx: ExtensionContext, settings: VoiceSettings): Promise<OverviewOutcome> {
	if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") return "done";
	const lines = overviewLines(settings);
	return ctx.ui.custom<OverviewOutcome>((_tui, _theme, _keybindings, done) => new OverviewPane(done, lines));
}
