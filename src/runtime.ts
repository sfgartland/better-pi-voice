/**
 * Wiring: pi's extension API on one side, the controller on the other.
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, isKittyProtocolActive, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { DeepgramBackend } from "./backends/deepgram.ts";
import { ParakeetBackend } from "./backends/parakeet.ts";
import type { Capture } from "./capture.ts";
import { SystemCapture } from "./capture.ts";
import { VoiceController, type VoiceState } from "./controller.ts";
import { collectKeytermSets, filePathsFromBranch, type KeytermSet } from "./keyterms/index.ts";
import { resolveDeepgramApiKey, type VoiceSettings } from "./settings.ts";
import type { VoiceBackend } from "./types.ts";
import { EditorSink, LEVEL_WIDGET_KEY, renderLevelBar, STATUS_KEY, statusText } from "./ui.ts";

/** Repaint the meter at most this often; the TUI is on the hot path. */
const LEVEL_FRAME_MS = 60;

/** Say the hold-mode fallback notice at most once per process. */
let warnedAboutRelease = false;

export type Runtime = {
	toggle(): void;
	dispose(): Promise<void>;
	get state(): VoiceState;
	/** Backend and model, for status and for /voice. */
	readonly label: string;
};

type Logger = { debug(message: string): void; notify(message: string, level?: "info" | "warning" | "error"): void };

export function createBackend(settings: VoiceSettings): VoiceBackend {
	if (settings.backend === "parakeet") {
		return new ParakeetBackend({
			modelPath: settings.parakeet.modelPath,
			language: settings.language,
			mode: settings.parakeet.mode,
			chunkSeconds: settings.parakeet.chunkSeconds,
			silenceLevel: settings.parakeet.silenceLevel,
			idleUnloadMs: settings.parakeet.idleUnloadMs,
			loadShedRatio: settings.parakeet.loadShedRatio,
		});
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

/**
 * What to call the active backend, including which model it will use. Shown in
 * the status line and by /voice, because "which one is listening?" is the first
 * question when a transcript comes back wrong.
 */
export function backendLabel(settings: VoiceSettings): string {
	if (settings.backend === "parakeet") {
		const stem = settings.parakeet.modelPath
			? basename(settings.parakeet.modelPath).replace(/\.gguf$/i, "")
			: "pi-voice's model";
		return `parakeet ${stem} (${settings.parakeet.mode})`;
	}
	return `deepgram ${settings.deepgram.model}`;
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
	const label = backendLabel(settings);

	// Hold-to-talk needs the key *release* event, which the terminal only reports
	// under the Kitty keyboard protocol. Probe for it instead of assuming: if
	// releases will never arrive, hold mode would leave the microphone open until
	// the repeat fallback fires, so degrade to tap-to-toggle and say so once.
	const releaseSupported = isKittyProtocolActive();
	const effectiveMode: "hold" | "tap" = settings.mode === "hold" && !releaseSupported ? "tap" : settings.mode;
	const fellBackToTap = settings.mode === "hold" && effectiveMode === "tap";
	const capture: Capture = new SystemCapture();
	const editor = new EditorSink({
		get: () => ctx.ui.getEditorText(),
		set: (text) => ctx.ui.setEditorText(text),
	});

	let lastLevelPaint = 0;

	const keyterms = async (): Promise<KeytermSet> => {
		const empty: KeytermSet = { bias: [], correct: [], truncated: false };
		if (!settings.keyterms.enabled) return empty;
		let repoName: string | undefined;
		let filePaths: string[] = [];
		try {
			const cwd = ctx.cwd;
			repoName = await detectRepoName(pi, cwd);
			if (settings.keyterms.mineSessionFiles) {
				filePaths = filePathsFromBranch(ctx.sessionManager.getBranch() as unknown[]);
			}
			const set = collectKeytermSets({
				cwd,
				repoName,
				filePaths,
				userTerms: settings.keyterms.user,
				useSeed: settings.keyterms.seed,
				maxTerms: settings.keyterms.maxTerms,
			});
			if (set.truncated) logger.debug(`keyterm list truncated to ${String(set.bias.length)}`);
			return set;
		} catch (error) {
			logger.debug(`keyterm mining failed: ${String(error)}`);
			return empty;
		}
	};

	const controller = new VoiceController({
		backend,
		capture,
		mode: effectiveMode,
		language: settings.language,
		correction: settings.correction,
		keyterms,
		hooks: {
			onState: (state) => {
				ctx.ui.setStatus(STATUS_KEY, statusText(state, label));
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

	// Probe the microphone now rather than on the first keypress, so the first
	// recording starts immediately and a missing device is reported up front.
	const captureAvailability = await capture.checkAvailability();
	if (!captureAvailability.available && captureAvailability.reason) {
		logger.notify(captureAvailability.reason, "warning");
	}

	// Show which backend and model are active before anything is recorded.
	ctx.ui.setStatus(STATUS_KEY, statusText("idle", label));

	// Hold-to-talk needs key *release*, which only exists in the raw input
	// stream. Tap mode uses the ordinary shortcut registration instead.
	let runtimeDisposed = false;
	let unsubscribeInput: (() => void) | undefined;
	if (effectiveMode === "hold" && ctx.mode === "tui") {
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
	} else if (fellBackToTap) {
		// The configured hold mode cannot work on this terminal, so wire the
		// shortcut itself as a toggle. It cannot be unregistered, so guard it
		// against firing after this runtime is disposed.
		pi.registerShortcut(settings.shortcut as KeyId, {
			description: "Start or stop voice input",
			handler: () => {
				if (!runtimeDisposed) controller.press();
			},
		});
		if (!warnedAboutRelease) {
			warnedAboutRelease = true;
			logger.notify(
				`This terminal does not report key releases, so hold-to-talk is unavailable. Tap ${settings.shortcut} to start and stop instead.`,
				"warning",
			);
		}
	}

	return {
		toggle: () => controller.press(),
		dispose: async () => {
			runtimeDisposed = true;
			unsubscribeInput?.();
			controller.dispose();
			await backend.dispose?.();
			ctx.ui.setWidget(LEVEL_WIDGET_KEY, undefined);
			ctx.ui.setStatus(STATUS_KEY, undefined);
		},
		get state() {
			return controller.currentState;
		},
		label,
	};
}
