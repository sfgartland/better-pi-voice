/**
 * Wiring: pi's extension API on one side, the controller on the other.
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { DeepgramBackend } from "./backends/deepgram.ts";
import { ParakeetBackend } from "./backends/parakeet.ts";
import type { Capture } from "./capture.ts";
import { SystemCapture } from "./capture.ts";
import { VoiceController, type VoiceState } from "./controller.ts";
import { collectKeyterms, filePathsFromBranch } from "./keyterms/index.ts";
import { resolveDeepgramApiKey, type VoiceSettings } from "./settings.ts";
import type { VoiceBackend } from "./types.ts";
import { EditorSink, LEVEL_WIDGET_KEY, renderLevelBar, STATUS_KEY, statusText } from "./ui.ts";

/** Repaint the meter at most this often; the TUI is on the hot path. */
const LEVEL_FRAME_MS = 60;

export type Runtime = {
	toggle(): void;
	dispose(): void;
	get state(): VoiceState;
};

type Logger = { debug(message: string): void; notify(message: string, level?: "info" | "warning" | "error"): void };

export function createBackend(settings: VoiceSettings): VoiceBackend {
	if (settings.backend === "parakeet") {
		return new ParakeetBackend({ modelPath: settings.parakeet.modelPath, language: settings.language });
	}
	return new DeepgramBackend({
		apiKey: resolveDeepgramApiKey(settings),
		model: settings.deepgram.model,
		language: settings.language,
		smartFormat: settings.deepgram.smartFormat,
		endpointingMs: settings.deepgram.endpointingMs,
		utteranceEndMs: settings.deepgram.utteranceEndMs,
	});
}

/** The repository name, which is often the single most useful keyterm. */
async function detectRepoName(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	try {
		const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
		const root = result.stdout?.trim();
		return root ? basename(root) : undefined;
	} catch {
		return undefined;
	}
}

export async function createRuntime(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	settings: VoiceSettings,
	debugEnabled: boolean,
): Promise<Runtime> {
	const logger: Logger = {
		debug: (message) => {
			if (debugEnabled) process.stderr.write(`[better-pi-voice] ${message}\n`);
		},
		notify: (message, level = "info") => {
			ctx.ui.notify(message, level);
		},
	};

	const backend = createBackend(settings);
	const capture: Capture = new SystemCapture();
	const editor = new EditorSink({
		get: () => ctx.ui.getEditorText(),
		set: (text) => ctx.ui.setEditorText(text),
	});

	let lastLevelPaint = 0;

	const keyterms = async (): Promise<string[]> => {
		if (!settings.keyterms.enabled) return [];
		let repoName: string | undefined;
		let filePaths: string[] = [];
		try {
			const cwd = process.cwd();
			repoName = await detectRepoName(pi, cwd);
			if (settings.keyterms.mineSessionFiles) {
				filePaths = filePathsFromBranch(ctx.sessionManager.getBranch() as unknown[]);
			}
			return collectKeyterms({
				cwd,
				repoName,
				filePaths,
				userTerms: settings.keyterms.user,
				useSeed: settings.keyterms.seed,
				maxTerms: settings.keyterms.maxTerms,
			});
		} catch (error) {
			logger.debug(`keyterm mining failed: ${String(error)}`);
			return [];
		}
	};

	const controller = new VoiceController({
		backend,
		capture,
		mode: settings.mode,
		language: settings.language,
		correction: settings.correction,
		keyterms,
		hooks: {
			onState: (state) => {
				ctx.ui.setStatus(STATUS_KEY, statusText(state, settings.backend));
				if (state === "recording" || state === "arming") editor.begin();
				if (state === "idle" || state === "paused") ctx.ui.setWidget(LEVEL_WIDGET_KEY, undefined);
			},
			onInterim: (text) => editor.showInterim(text),
			onFinal: (text) => {
				const combined = editor.commit(text);
				if (settings.submitOnStop) pi.sendUserMessage(combined);
			},
			onLevel: (levels) => {
				const now = Date.now();
				if (now - lastLevelPaint < LEVEL_FRAME_MS) return;
				lastLevelPaint = now;
				ctx.ui.setWidget(LEVEL_WIDGET_KEY, [renderLevelBar(levels)], { placement: "aboveEditor" });
			},
			onError: (message, code) => {
				logger.debug(`error ${code}: ${message}`);
				ctx.ui.notify(message, "error");
			},
			onDebug: (message) => logger.debug(message),
		},
	});

	const availability = await backend.checkAvailability();
	if (!availability.available && availability.reason) {
		logger.notify(availability.reason, "warning");
	}

	// Hold-to-talk needs key *release*, which only exists in the raw input
	// stream. Tap mode uses the ordinary shortcut registration instead.
	let unsubscribeInput: (() => void) | undefined;
	if (settings.mode === "hold" && ctx.mode === "tui") {
		unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			const isRelease = isKeyRelease(data);
			const isRepeat = isKeyRepeat(data);
			if (!isRelease && !isRepeat && !matchesKey(data, settings.shortcut as KeyId)) return undefined;
			if (!matchesKey(data, settings.shortcut as KeyId)) return undefined;
			if (isRelease) controller.release();
			else if (isRepeat) controller.repeat();
			else controller.press();
			// Swallow the binding so it does not land in the editor as text.
			return { consume: true };
		});
	}

	return {
		toggle: () => controller.press(),
		dispose: () => {
			unsubscribeInput?.();
			controller.dispose();
			ctx.ui.setWidget(LEVEL_WIDGET_KEY, undefined);
			ctx.ui.setStatus(STATUS_KEY, undefined);
		},
		get state() {
			return controller.currentState;
		},
	};
}
