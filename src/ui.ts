/**
 * The visible parts: the level meter, the status line, and getting text into
 * the editor without stomping on what the user is typing.
 */

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

	constructor(private readonly editor: EditorTextAccess) {}

	/** Capture the surrounding text when a session begins. */
	begin(): void {
		this.prefix = this.editor.get();
		this.lastWritten = undefined;
	}

	/** Show live text, replacing whatever we last showed. */
	showInterim(text: string): void {
		this.refreshPrefix();
		this.write(this.join(text));
	}

	/** Final text for the session. Returns what should be submitted. */
	commit(text: string): string {
		this.refreshPrefix();
		const combined = this.join(text);
		this.write(combined);
		return combined;
	}

	private refreshPrefix(): void {
		const current = this.editor.get();
		// Before the first write, the captured prefix is what we expect to find;
		// after it, what we last wrote is. Anything else means the user typed.
		const expected = this.lastWritten ?? this.prefix;
		if (current !== expected) this.prefix = current;
	}

	private join(text: string): string {
		const trimmed = text.trim();
		if (!trimmed) return this.prefix;
		if (this.prefix.length === 0) return trimmed;
		// Put the transcript on its own line so it never runs into existing prose.
		return this.prefix.endsWith("\n") ? `${this.prefix}${trimmed}` : `${this.prefix}\n${trimmed}`;
	}

	private write(text: string): void {
		this.lastWritten = text;
		this.editor.set(text);
	}
}

export function statusText(
	state: "idle" | "arming" | "recording" | "processing" | "paused",
	backend: string,
): string | undefined {
	switch (state) {
		case "arming":
			return `\u25cf ${backend}: connecting\u2026`;
		case "recording":
			return `\u25cf ${backend}: listening`;
		case "processing":
			return `${backend}: transcribing\u2026`;
		case "paused":
			return `${backend}: paused after repeated failures`;
		default:
			return undefined;
	}
}
