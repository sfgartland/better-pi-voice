/**
 * The live "Try it" step at the end of setup: a modal pane that records through
 * the freshly chosen backend and shows what was heard, so setup ends with
 * something the user has seen work rather than a promise.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, isKeyRelease, isKeyRepeat, type KeyId, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { SystemCapture } from "./capture.ts";
import { VoiceController, type VoiceState } from "./controller.ts";
import { createBackend } from "./runtime.ts";
import type { VoiceSettings } from "./settings.ts";

export type TryItOutcome = "done" | "change";

export class TryItPane implements Component {
	/** Hold-to-talk needs key-release events, which are filtered out by default. */
	readonly wantsKeyRelease = true;

	private transcript = "";
	private state: VoiceState = "idle";
	private level = 0;
	private error: string | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly done: (outcome: TryItOutcome) => void,
		private readonly shortcut: string,
		private readonly controller: VoiceController,
	) {}

	render(width: number): string[] {
		const filled = Math.max(0, Math.min(width, Math.round(this.level * width)));
		const lines = [
			"Try it — speak to confirm your setup",
			`  press ${this.shortcut} to start, then again to stop`,
			`  state     ${this.state}`,
			`  level     ${"#".repeat(filled)}`,
		];
		if (this.error) lines.push(`  error     ${this.error}`);
		lines.push(`  heard     ${this.transcript || "(nothing yet)"}`);
		lines.push("  Enter: looks good    Esc: change settings");
		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "enter")) {
			this.done("done");
			return;
		}
		if (matchesKey(data, "escape")) {
			this.done("change");
			return;
		}
		if (!matchesKey(data, this.shortcut as KeyId)) return;
		if (isKeyRelease(data)) this.controller.release();
		else if (isKeyRepeat(data)) this.controller.repeat();
		else this.controller.press();
	}

	invalidate(): void {}

	setState(state: VoiceState): void {
		this.state = state;
		this.tui.requestRender();
	}

	setTranscript(text: string): void {
		this.transcript = text;
		this.tui.requestRender();
	}

	setLevel(level: number): void {
		this.level = level;
		this.tui.requestRender();
	}

	setError(message: string): void {
		this.error = message;
		this.tui.requestRender();
	}
}

/**
 * Show the Try-it pane. Returns "done" when the user is happy and "change" when
 * they want to adjust, and "done" immediately when there is no TUI to show it.
 */
export async function runTryIt(ctx: ExtensionContext, settings: VoiceSettings): Promise<TryItOutcome> {
	if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") return "done";

	const backend = createBackend(settings);
	const capture = new SystemCapture();
	let pane: TryItPane | undefined;

	// Tap semantics inside the pane: one key toggles, so it works whether or not
	// the terminal reports key releases.
	const controller = new VoiceController({
		backend,
		capture,
		mode: "tap",
		language: settings.language,
		correction: settings.correction,
		keyterms: async () => ({ bias: [], correct: [], truncated: false }),
		hooks: {
			onState: (state) => pane?.setState(state),
			onInterim: (text) => pane?.setTranscript(text),
			onFinal: (text) => pane?.setTranscript(text),
			onLevel: (levels) => pane?.setLevel(levels[0] ?? 0),
			onError: (message) => pane?.setError(message),
		},
	});

	try {
		return await ctx.ui.custom<TryItOutcome>((tui, _theme, _keybindings, done) => {
			pane = new TryItPane(tui, done, settings.shortcut, controller);
			return pane;
		});
	} finally {
		controller.dispose();
		await backend.dispose?.();
	}
}
