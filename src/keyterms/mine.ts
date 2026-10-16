/**
 * Deriving vocabulary from the pi session.
 *
 * A coding agent knows which words the user is about to say: the project name,
 * and the files that are already in play. Both are cheap to collect and are
 * what makes recognition of jargon and filenames work.
 */

import { basename, dirname } from "node:path";
import { tokenizeLabel } from "./sanitize.ts";

/** Tools whose arguments name a file the user cares about. */
const PATH_TOOLS = new Set(["read", "write", "edit", "notebookEdit", "ls", "grep", "find"]);

export type MineInput = {
	cwd?: string | undefined;
	repoName?: string | undefined;
	/** Absolute or relative file paths already touched in this session. */
	filePaths?: readonly string[] | undefined;
	/** Text to scrape for path-like strings (typically the user's messages). */
	texts?: readonly string[] | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function addIfString(out: string[], value: unknown): void {
	if (typeof value === "string" && value.length > 0) out.push(value);
}

/**
 * Collect file paths named by tool calls (and paths mentioned in user text)
 * from a session branch.
 *
 * Written defensively and shape-tolerantly: session entries are persisted JSON
 * that has changed shape before, and a missed path only costs a keyterm.
 */
export function filePathsFromBranch(entries: readonly unknown[]): string[] {
	const out: string[] = [];

	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		const message = isRecord(entry.message) ? entry.message : undefined;
		if (!message) continue;

		const role = message.role;
		const content = message.content;

		if (role === "assistant" && Array.isArray(content)) {
			for (const block of content) {
				if (!isRecord(block) || block.type !== "toolCall") continue;
				const name = typeof block.name === "string" ? block.name : "";
				if (!PATH_TOOLS.has(name)) continue;
				const args = isRecord(block.arguments) ? block.arguments : undefined;
				if (!args) continue;
				addIfString(out, args.path);
				addIfString(out, args.file_path);
				addIfString(out, args.notebook_path);
				if (Array.isArray(args.paths)) for (const path of args.paths) addIfString(out, path);
			}
			continue;
		}

		if (role === "user") {
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.filter((block): block is Record<string, unknown> => isRecord(block))
								.filter((block) => block.type === "text" && typeof block.text === "string")
								.map((block) => block.text as string)
								.join(" ")
						: "";
			for (const token of pathLikeTokens(text)) out.push(token);
		}
	}

	return out;
}

/**
 * Pull path-like strings out of prose. Requires a separator, so "README" alone
 * is not treated as a path but "src/foo/bar.ts" is.
 *
 * A single separator with no file-looking tail is usually prose, not a path:
 * "read/write and/or" would otherwise yield the generic keyterm "write".
 */
export function pathLikeTokens(text: string): string[] {
	const found = text.match(/[A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)+/g) ?? [];
	return found.filter((token) => {
		const segments = token.split("/").filter(Boolean);
		const last = segments[segments.length - 1] ?? "";
		return last.includes(".") || segments.length >= 3;
	});
}

/** Basename without its extension, because nobody says "dot tee ess". */
function stem(path: string): string {
	const base = basename(path);
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Stems that name a document rather than a thing.
 *
 * A file called `SKILL.md` (or `README.md`, `INDEX.md`, …) is a convention. Its
 * stem is a generic English word, not vocabulary, and mining it is actively
 * harmful: the correction pass then rewrites real words one edit away from it
 * (`still`, `spill`, `skull` and `swill` all became `SKILL`). For these names the
 * parent directory is the informative one — `…/skills/brainstorming/SKILL.md` is
 * about brainstorming.
 */
const GENERIC_STEMS = new Set([
	"skill",
	"readme",
	"index",
	"license",
	"licence",
	"changelog",
	"contributing",
	"copying",
	"notice",
	"authors",
	"todo",
	"main",
	"package",
	"setup",
]);

/** The terms one file path contributes: usually its stem, else its parent directory. */
function termsFromPath(path: string): string[] {
	if (!GENERIC_STEMS.has(stem(path).toLowerCase())) return tokenizeLabel(stem(path));

	const parent = basename(dirname(path));
	// A generic name with no directory (`SKILL.md`) or at a filesystem root has
	// nothing informative to offer; mining `.` or `/` would only add noise.
	if (!parent || parent === "." || parent === "/") return [];
	return tokenizeLabel(parent);
}

/**
 * Build the candidate term list. Order matters: callers that truncate will
 * prefer the earlier entries, so the most specific signals come first.
 */
export function mineKeyterms(input: MineInput): string[] {
	const out: string[] = [];

	for (const label of [input.repoName, input.cwd ? basename(input.cwd) : undefined]) {
		if (!label) continue;
		// A bare name is worth passing whole ("marginalia"); a hyphenated package
		// name is not ("pi-add-better-pi-voice"), so split that one instead.
		if (/^[A-Za-z0-9]+$/.test(label) && label.length >= 2 && label.length <= 50) {
			out.push(label);
		} else {
			out.push(...tokenizeLabel(label));
		}
	}

	for (const path of input.filePaths ?? []) {
		out.push(...termsFromPath(path));
	}

	for (const text of input.texts ?? []) {
		for (const token of pathLikeTokens(text)) {
			out.push(...termsFromPath(token));
		}
	}

	return out;
}
