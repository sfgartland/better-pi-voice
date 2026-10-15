/**
 * Normalising candidate keyterms before they go on the wire.
 *
 * Deliberately strict: a malformed keyterm is not rejected by Deepgram, it is
 * silently accepted and boosts nothing (or, in the worst case, an over-budget
 * `Configure` update kills the stream). So the client owns the budget.
 */

export const MIN_TERM_LENGTH = 3;
export const MAX_TERM_LENGTH = 20;
/** Multi-word phrases are allowed, but not long ones. */
export const MAX_PHRASE_WORDS = 4;
export const MAX_PHRASE_LENGTH = 40;
/** Stay well inside Deepgram's 100-terms / 500-tokens hard limit. */
export const DEFAULT_MAX_TERMS = 60;
export const DEFAULT_MAX_CHARS = 1024;
/** Conservative proxy for Deepgram's 500-token cap. */
export const MAX_ESTIMATED_TOKENS = 400;

export type SanitizeOptions = {
	maxTerms?: number;
	maxChars?: number;
};

/**
 * Split a label into candidate words: camelCase boundaries, then any run of
 * separators (`-`, `_`, `.`, `/`, whitespace). Words outside the length window
 * are dropped, matching the reference implementation.
 */
export function tokenizeLabel(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[-_./\s]+/)
		.map((part) => part.trim())
		.filter((part) => part.length >= MIN_TERM_LENGTH && part.length <= MAX_TERM_LENGTH);
}

/** Strip anything a terminal or a wire format could mangle. */
function clean(term: string): string {
	return term
		.replace(/[^\x20-\x7E]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function isAcceptable(term: string): boolean {
	if (term.length === 0) return false;
	const words = term.split(" ");
	if (words.length > MAX_PHRASE_WORDS) return false;
	if (term.length > MAX_PHRASE_LENGTH) return false;
	// A single word must satisfy the tighter token window.
	if (words.length === 1) {
		return term.length >= MIN_TERM_LENGTH && term.length <= MAX_TERM_LENGTH;
	}
	// A phrase needs at least one word long enough to carry signal, or "a b c"
	// rides in on the phrase allowance; every word still has to fit the window.
	if (words.every((word) => word.length < MIN_TERM_LENGTH)) return false;
	return words.every((word) => word.length <= MAX_TERM_LENGTH);
}

/**
 * Conservative stand-in for Deepgram's "500 tokens across all keyterms".
 * Not exact — Deepgram does not document the tokenizer — so the budget is set
 * low enough that being wrong by a wide margin is still safe.
 */
export function estimateKeytermTokens(terms: readonly string[]): number {
	let tokens = 0;
	for (const term of terms) {
		tokens += term.split(" ").reduce((sum, word) => sum + Math.max(1, Math.ceil(word.length / 4)), 0);
	}
	return tokens;
}

/**
 * Clean, dedupe (case-insensitively, first occurrence wins so the user's own
 * casing survives), and truncate to the budget.
 */
export function sanitizeKeyterms(input: Iterable<string>, options: SanitizeOptions = {}): string[] {
	const maxTerms = options.maxTerms ?? DEFAULT_MAX_TERMS;
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

	const seen = new Set<string>();
	const out: string[] = [];
	let chars = 0;
	let tokens = 0;

	for (const raw of input) {
		if (out.length >= maxTerms) break;
		const term = clean(raw);
		if (!isAcceptable(term)) continue;

		const key = term.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);

		// +1 for the separator between query parameters.
		const cost = term.length + (out.length > 0 ? 1 : 0);
		if (chars + cost > maxChars) continue;

		const tokenCost = estimateKeytermTokens([term]);
		if (tokens + tokenCost > MAX_ESTIMATED_TOKENS) continue;

		out.push(term);
		chars += cost;
		tokens += tokenCost;
	}

	return out;
}
