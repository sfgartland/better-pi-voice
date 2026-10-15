/**
 * Conservative post-hoc repair for backends that cannot be biased.
 *
 * Parakeet has no vocabulary knob, so a misheard keyterm has to be fixed after
 * the fact or not at all. This pass is deliberately dumb, bounded, and
 * observable — fuzzy repair is exactly the kind of thing that quietly ruins
 * dictation, so every change is reported and the whole pass can be turned off.
 *
 * Only ever applied to FINAL transcripts, never to interims.
 */

export type CorrectionMode = "off" | "safe" | "report";

export type CorrectionChange = { from: string; to: string };

export type CorrectionResult = { text: string; changes: CorrectionChange[] };

/** Never touch a token shorter than this; there is not enough signal. */
export const MIN_CORRECTABLE_LENGTH = 5;

/**
 * Bounded Damerau-Levenshtein distance (optimal string alignment).
 *
 * Adjacent transpositions cost 1, not 2. That matters here: swapping two
 * letters is one of the most common ways ASR mangles a technical term
 * ("subagent" -> "subagnet"), and scoring it as two edits would put it out of
 * reach for short tokens. Only the adjacent-swap case is added, so the metric
 * stays deliberately conservative.
 *
 * Prunes as soon as a whole row exceeds `limit`. The returned value can be the
 * true distance above `limit`, so callers must compare with `> limit`; only the
 * `a === b` short-circuit returns exactly 0.
 */
export function editDistance(a: string, b: string, limit: number): number {
	if (a === b) return 0;
	if (Math.abs(a.length - b.length) > limit) return limit + 1;

	// Three rolling rows: OSA needs the row two back for the transposition check.
	let prevPrev = new Array<number>(b.length + 1).fill(0);
	let prev = new Array<number>(b.length + 1);
	let cur = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;

	for (let i = 1; i <= a.length; i++) {
		cur[0] = i;
		let rowMin = cur[0]!;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let value = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				value = Math.min(value, prevPrev[j - 2]! + 1);
			}
			cur[j] = value;
			if (value < rowMin) rowMin = value;
		}
		if (rowMin > limit) return limit + 1;
		const recycled = prevPrev;
		prevPrev = prev;
		prev = cur;
		cur = recycled;
	}
	return prev[b.length]!;
}

function allowedDistance(length: number): number {
	return length <= 7 ? 1 : 2;
}

/**
 * Join two adjacent tokens when their concatenation is exactly a keyterm.
 *
 * This exists because ASR splits camelCase and hyphenated identifiers: a keyterm
 * of `tsconfig` comes back as "TS config", and `worktree` as "work tree". A
 * single-token repair cannot reach those, so they are merged first.
 *
 * Kept narrow on purpose: the join must be an EXACT case-insensitive match for a
 * keyterm, the two tokens must be separated by exactly one space, and one of them
 * must be at most three characters (an abbreviation, which is the tell). Joining
 * words is the most dangerous thing this file does, so it only fires when the
 * result is unambiguous.
 */
function mergeSplitKeyterms(
	text: string,
	singleWordKeyterms: readonly string[],
): { text: string; changes: CorrectionChange[] } {
	const matches = [...text.matchAll(/[A-Za-z][A-Za-z']*/g)];
	const changes: CorrectionChange[] = [];
	let out = "";
	let cursor = 0;

	for (let i = 0; i < matches.length - 1; i++) {
		const left = matches[i]!;
		const right = matches[i + 1]!;
		const leftWord = left[0];
		const rightWord = right[0];

		// Exactly one space between them, so punctuation and line breaks are safe.
		if (text.slice((left.index ?? 0) + leftWord.length, right.index) !== " ") continue;

		// Only abbreviation-shaped splits. "TS config" qualifies; "back end" and
		// "work tree" do not, because in the next sentence those are two words.
		const [short, long] = leftWord.length <= rightWord.length ? [leftWord, rightWord] : [rightWord, leftWord];
		if (short.length > 3 || long.length > 16) continue;
		if (short.length > 2 && short !== short.toUpperCase()) continue;

		const joined = `${leftWord}${rightWord}`.toLowerCase();
		const keyterm = singleWordKeyterms.find((term) => term.toLowerCase() === joined);
		if (!keyterm) continue;

		out += text.slice(cursor, left.index) + keyterm;
		cursor = (right.index ?? 0) + rightWord.length;
		changes.push({ from: `${leftWord} ${rightWord}`, to: keyterm });
		i++; // The right-hand token has been consumed.
	}

	out += text.slice(cursor);
	return { text: out, changes };
}

/**
 * Repair tokens that are one or two edits away from a keyterm.
 *
 * Refuses to act when: the mode is off, the token is shorter than
 * `MIN_CORRECTABLE_LENGTH`, the token already matches a keyterm, the candidate
 * is a multi-word phrase, or the distance exceeds the bound for that length.
 */
export function correctTranscript(
	text: string,
	keyterms: readonly string[],
	mode: CorrectionMode = "safe",
): CorrectionResult {
	if (mode === "off" || keyterms.length === 0) return { text, changes: [] };

	// Single-word keyterms only: rewriting one token into a phrase would change
	// the word count and that is not a repair, it is a rewrite.
	const candidates = keyterms.filter((term) => !term.includes(" "));
	if (candidates.length === 0) return { text, changes: [] };

	const lower = new Set(candidates.map((term) => term.toLowerCase()));
	const changes: CorrectionChange[] = [];

	// Pass 1: rejoin identifiers the recogniser split apart.
	const merged = mergeSplitKeyterms(text, candidates);
	changes.push(...merged.changes);
	const working = mode === "report" ? text : merged.text;

	// Pass 2: repair single misheard tokens.
	const corrected = working.replace(/[A-Za-z][A-Za-z']*/g, (token) => {
		if (token.length < MIN_CORRECTABLE_LENGTH) return token;
		const needle = token.toLowerCase();
		if (lower.has(needle)) return token;

		const limit = allowedDistance(token.length);
		let best: { term: string; distance: number } | undefined;
		for (const term of candidates) {
			// Cheap length gate before running the matrix.
			if (Math.abs(term.length - token.length) > limit) continue;
			const distance = editDistance(needle, term.toLowerCase(), limit);
			if (distance > limit) continue;
			if (!best || distance < best.distance) best = { term, distance };
		}

		if (!best) return token;
		changes.push({ from: token, to: best.term });
		return mode === "report" ? token : best.term;
	});

	if (mode === "report") return { text, changes };
	return { text: corrected, changes };
}
