/**
 * Microphone capture.
 *
 * Contract with the rest of the package: a stream of Buffers of PCM s16le,
 * 16 kHz, mono. On Linux we shell out to `arecord`, falling back to SoX's
 * `rec`; on other platforms `rec` is the only path, which is a documented
 * degraded mode rather than a hidden one.
 *
 * Endpointing is the backend's job, so we never pass SoX silence arguments —
 * trimming silence locally would fight the server's own endpointing.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { SAMPLE_RATE } from "./formats.ts";

export type CaptureSession = { stop(): void };

export type CaptureStartResult =
	| { ok: true; session: CaptureSession }
	| { ok: false; reason: string; expected?: boolean };

export type CaptureAvailability = { available: boolean; reason?: string };

export interface Capture {
	checkAvailability(): Promise<CaptureAvailability>;
	start(onData: (chunk: Buffer) => void, onEnd: () => void): Promise<CaptureStartResult>;
}

const ARECORD = "arecord";
const SOX_REC = "rec";
const PROBE_TIMEOUT_MS = 150;

async function commandExists(command: string): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		let child: ChildProcess;
		try {
			child = spawn(command, ["--version"], { stdio: "ignore" });
		} catch {
			resolve(false);
			return;
		}
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			// Answered too slowly to be missing: a hung probe is not a missing binary.
			finish(true);
		}, 3000);
		child.once("error", () => finish(false));
		child.once("close", (code) => finish(code === 0));
	});
}

/** Ask `arecord` to open the default device and write raw frames to /dev/null. */
async function probeArecord(): Promise<{ ok: boolean; stderr: string }> {
	return new Promise((resolve) => {
		let stderr = "";
		let settled = false;
		const finish = (value: { ok: boolean; stderr: string }) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		let child: ChildProcess;
		try {
			child = spawn(ARECORD, ["-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw", "/dev/null"], {
				stdio: ["ignore", "ignore", "pipe"],
			});
		} catch {
			resolve({ ok: false, stderr: "arecord: command not found" });
			return;
		}
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			// Still running after 150 ms means the device opened and is producing.
			finish({ ok: true, stderr: "" });
		}, PROBE_TIMEOUT_MS);
		child.once("close", (code) => {
			clearTimeout(timer);
			finish({ ok: code === 0, stderr: stderr.trim() });
		});
		child.once("error", () => {
			clearTimeout(timer);
			finish({ ok: false, stderr: "arecord: command not found" });
		});
	});
}

async function hasSoundcards(): Promise<boolean> {
	try {
		const cards = (await readFile("/proc/asound/cards", "utf8")).trim();
		return cards.length > 0 && !cards.includes("no soundcards");
	} catch {
		return false;
	}
}

async function isWsl(): Promise<boolean> {
	try {
		return /microsoft/i.test(await readFile("/proc/version", "utf8"));
	} catch {
		return false;
	}
}

/** The package manager command that would install SoX on this system, if we can tell. */
async function soxInstallCommand(): Promise<string | null> {
	for (const [command, display] of [
		["apt-get", "sudo apt-get install sox"],
		["dnf", "sudo dnf install sox"],
		["pacman", "sudo pacman -S sox"],
	] as const) {
		if (await commandExists(command)) return display;
	}
	return null;
}

const WSL_REASON = [
	"Voice mode could not find a working audio recorder in WSL.",
	"WSL2 with WSLg provides audio via PulseAudio — install SoX with its PulseAudio backend (sudo apt install sox libsox-fmt-pulse) so recording works.",
	"If WSLg is not available (for example WSL1), run pi in native Windows instead.",
].join("\n");

export class SystemCapture implements Capture {
	private cachedAvailability: CaptureAvailability | undefined;
	private cachedArecord: boolean | undefined;
	private cachedSoxRec: boolean | undefined;

	async checkAvailability(): Promise<CaptureAvailability> {
		if (this.cachedAvailability) return this.cachedAvailability;
		this.cachedAvailability = await this.detect();
		return this.cachedAvailability;
	}

	/** Audio starts flowing only after the device opens, but never assume it did. */
	async start(onData: (chunk: Buffer) => void, onEnd: () => void): Promise<CaptureStartResult> {
		const canArecord = await this.useArecord();
		if (canArecord) {
			const session = this.spawnRecorder(
				ARECORD,
				["-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw", "-q", "-"],
				onData,
				onEnd,
			);
			if (session.ok) return session;
		}

		const session = this.spawnRecorder(
			SOX_REC,
			["-q", "--buffer", "1024", "-t", "raw", "-r", String(SAMPLE_RATE), "-e", "signed", "-b", "16", "-c", "1", "-"],
			onData,
			onEnd,
		);
		if (session.ok) return session;

		return {
			ok: false,
			reason: "Could not start an audio recorder. Check that SoX is installed and a microphone is available.",
		};
	}

	private async detect(): Promise<CaptureAvailability> {
		if (process.platform === "linux" && (await this.useArecord())) {
			return { available: true };
		}
		if (await this.useSoxRec()) {
			return { available: true };
		}
		if (await isWsl()) {
			return { available: false, reason: WSL_REASON };
		}
		if (process.platform === "linux" && !(await commandExists("sox"))) {
			const install = await soxInstallCommand();
			return {
				available: false,
				reason: install
					? `Voice mode requires SoX for audio recording. Install it with: ${install}`
					: "Voice mode requires SoX for audio recording. Install SoX manually:\n  macOS: brew install sox\n  Ubuntu/Debian: sudo apt-get install sox\n  Fedora: sudo dnf install sox",
			};
		}
		return {
			available: false,
			reason:
				"Voice mode requires a microphone, but no capture device could be opened. This usually means the host has no microphone (for example, a remote server).",
		};
	}

	private async useArecord(): Promise<boolean> {
		if (process.platform !== "linux") return false;
		if (this.cachedArecord !== undefined) return this.cachedArecord;
		this.cachedArecord = (await commandExists(ARECORD)) && (await probeArecord()).ok && (await hasSoundcards());
		return this.cachedArecord;
	}

	private async useSoxRec(): Promise<boolean> {
		if (this.cachedSoxRec !== undefined) return this.cachedSoxRec;
		this.cachedSoxRec = (await commandExists("sox")) && (await commandExists(SOX_REC));
		return this.cachedSoxRec;
	}

	private spawnRecorder(
		command: string,
		args: string[],
		onData: (chunk: Buffer) => void,
		onEnd: () => void,
	): CaptureStartResult {
		let child: ChildProcess;
		try {
			child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		} catch (error) {
			return { ok: false, reason: `${command} could not be started: ${String(error)}` };
		}

		let failed = false;
		child.stdout?.on("data", (chunk: Buffer) => onData(chunk));
		// Recorder stderr is noise unless the process then fails.
		child.stderr?.on("data", () => {});
		child.once("error", (error) => {
			failed = true;
			onEnd();
			void error;
		});
		child.once("close", () => {
			if (!failed) onEnd();
		});

		return {
			ok: true,
			session: {
				stop: () => {
					if (!child.killed) child.kill("SIGTERM");
				},
			},
		};
	}
}
