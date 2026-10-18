/**
 * The visible parts: the level meter, the status line, and getting text into
 * the editor without stomping on what the user is typing.
 */

import type { VoiceState } from "./controller.ts";

export const LEVEL_WIDGET_KEY = "better-pi-voice-level";
export const STATUS_KEY = "better-pi-voice";

const BLOCKS = [" ", "\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];

/** Render a rolling level window as a single line of block characters. */
export function renderLevelBar(levels: readonly number[], width = 24): string {
	const cells: string[] = [];
	for (let i = 0; i < width; i++) {
		const source = levels[levels.length - width + i];
		const level = source === undefined ? 0 : Math.max(0, Math.min(1, source));
		cells.push(BLOCKS[Math.round(level * (BLOCKS.length - 1))]!);
	}
	return cells.join("");
}

export type EditorTextAccess = {
	get(): string;
	set(text: string): void;
};

/**
 * Keeps interim text in the editor without destroying the user's own typing.
 *
 * The editor is shared state: the user can keep typing while dictating. So we
 * remember what we last wrote; if the editor no longer matches it, the user
 * edited and we adopt their text as the new prefix instead of overwriting it.
 */
export class EditorSink {
	private prefix = "";
	private lastWritten: string | undefined;
	private readonly finals = new Map<number, string>();
	private live: { seq: number; text: string } | undefined;
	/** The user typed since we last wrote, so their text owns the line. */
	private adopted = false;

	constructor(private readonly editor: EditorTextAccess) {}

	/**
	 * Start a new recording's editor region. Text already committed by earlier
	 * recordings is folded into the prefix so this recording continues after it
	 * rather than replacing it.
	 */
	begin(): void {
		if (this.finals.size > 0 || this.live) {
			this.prefix = this.renderAll();
			this.finals.clear();
			this.live = undefined;
		}
		this.refreshPrefix();
		this.lastWritten = undefined;
		this.adopted = false;
	}

	/** Show live text, replacing whatever we last showed. */
	showInterim(seq: number, text: string): void {
		this.refreshPrefix();
		this.live = { seq, text };
		this.write(this.renderPreview());
	}

	/** Commit one recording's final text. Returns what the editor now holds. */
	commit(seq: number, text: string): string {
		this.refreshPrefix();
		if (text.trim().length > 0) {
			this.finals.set(seq, text);
			if (this.live?.seq === seq) this.live = undefined;
		}
		const rendered = this.renderPreview();
		this.write(rendered);
		return rendered;
	}

	/** Everything committed so far, in recording order, for submission. */
	submitText(): string {
		const text = this.renderAll();
		this.finals.clear();
		this.live = undefined;
		return text;
	}

	/** The committed final with the largest `seq`. */
	private latestFinal(): { seq: number; text: string } | undefined {
		let latest: { seq: number; text: string } | undefined;
		for (const [seq, text] of this.finals) {
			if (!latest || seq > latest.seq) latest = { seq, text };
		}
		return latest;
	}

	/** What the editor shows: the newest final, then the live interim. */
	private renderPreview(): string {
		let out = this.prefix;
		const latest = this.latestFinal();
		if (latest) out = this.join(out, latest.text);
		if (this.live) out = this.join(out, this.live.text);
		return out;
	}

	/** Every committed final in recording order, then the live interim. */
	private renderAll(): string {
		let out = this.prefix;
		for (const seq of [...this.finals.keys()].sort((a, b) => a - b)) {
			out = this.join(out, this.finals.get(seq) ?? "");
		}
		if (this.live) out = this.join(out, this.live.text);
		return out;
	}

	private refreshPrefix(): void {
		const current = this.editor.get();
		// Before the first write, the captured prefix is what we expect to find;
		// after it, what we last wrote is. Anything else means the user typed.
		const expected = this.lastWritten ?? this.prefix;
		if (current !== expected) {
			this.prefix = current;
			this.adopted = true;
		}
	}

	private join(text: string, extra: string): string {
		const trimmed = extra.trim();
		if (!trimmed) return text;
		if (text.length === 0) return trimmed;
		if (text.endsWith("\n")) return `${text}${trimmed}`;
		// A prefix ending in a space is a label ("note: "), so the transcript
		// continues it. Once the user is typing, it always starts a new line.
		if (text.endsWith(" ") && !this.adopted) return `${text}${trimmed}`;
		return `${text}\n${trimmed}`;
	}

	private write(text: string): void {
		this.lastWritten = text;
		this.editor.set(text);
	}
}

/**
 * The status line. `label` names the backend and the model, so it is always
 * obvious which one is listening — that is the first question when dictation
 * comes back wrong.
 */
export function statusText(state: VoiceState, label: string, queueDepth = 0): string | undefined {
	const pending = queueDepth >= 1 ? `${String(queueDepth)} ${queueDepth === 1 ? "recording" : "recordings"}` : "";
	const waiting = queueDepth >= 1 ? ` (${pending} waiting)` : "";
	switch (state) {
		case "arming":
			return `\u25cf ${label}: connecting\u2026`;
		case "recording":
			return queueDepth > 1
				? `\u25cf ${label}: listening (${String(queueDepth)} queued)`
				: `\u25cf ${label}: listening`;
		case "processing":
			return `transcribing with ${label}\u2026${waiting}`;
		case "queued":
			return `transcribing with ${label}\u2026${waiting}`;
		case "paused":
			return `${label}: paused after repeated failures`;
		default:
			// Shown while idle too, so the active backend is discoverable without
			// starting a recording.
			return label;
	}
}
