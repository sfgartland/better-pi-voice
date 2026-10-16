/**
 * Assembling the keyterm list a session starts with.
 */

import { type MineInput, mineKeyterms } from "./mine.ts";
import { DEFAULT_MAX_TERMS, sanitizeKeyterms } from "./sanitize.ts";
import { SEED_KEYTERMS } from "./seed.ts";

export {
	type CorrectionChange,
	type CorrectionMode,
	type CorrectionResult,
	correctTranscript,
	editDistance,
	MIN_CORRECTABLE_LENGTH,
} from "./correct.ts";
export { filePathsFromBranch, type MineInput, mineKeyterms, pathLikeTokens } from "./mine.ts";
export {
	DEFAULT_MAX_CHARS,
	DEFAULT_MAX_TERMS,
	estimateKeytermTokens,
	MAX_ESTIMATED_TOKENS,
	type SanitizeOptions,
	sanitizeKeyterms,
	tokenizeLabel,
} from "./sanitize.ts";
export { SEED_KEYTERMS } from "./seed.ts";

/** Seed terms lowercased, so a mined term that collides with one can be spotted. */
const SEED_LOWER = new Set(SEED_KEYTERMS.map((term) => term.toLowerCase()));

export type CollectOptions = MineInput & {
	/** Terms the user configured by hand. Highest priority. */
	userTerms?: readonly string[] | undefined;
	/** Include the built-in jargon seed list. Default true. */
	useSeed?: boolean | undefined;
	maxTerms?: number | undefined;
};

export type KeytermSet = {
	/** Terms sent to the recogniser for biasing. */
	bias: string[];
	/**
	 * Terms the post-hoc correction pass may repair toward. Deliberately
	 * narrower than `bias`: see `collectKeytermSets`.
	 */
	correct: string[];
	/** True when the budget dropped candidates. */
	truncated: boolean;
};

/**
 * The terms to bias the recogniser with, and the narrower list the correction
 * pass may use, from a single mining pass.
 *
 * Correction excludes the seed jargon on purpose. The seed exists to bias
 * Deepgram's recogniser, but its 45 entries are ordinary-English-adjacent words
 * ("parser", "schema", "settings", "extension"), and a fuzzy matcher given those
 * rewrites correct speech into them (`parse` -> `parser`). Biasing and repair
 * want different vocabularies, so they get different lists.
 */
export function collectKeytermSets(options: CollectOptions = {}): KeytermSet {
	const user = options.userTerms ?? [];
	const mined = mineKeyterms(options);
	const biasOrder = options.useSeed !== false ? [...user, ...SEED_KEYTERMS, ...mined] : [...user, ...mined];
	const bias = sanitizeKeyterms(biasOrder, { maxTerms: options.maxTerms });
	// A mined term that collides with the seed jargon (a file named `settings.ts`,
	// say) is still only an ordinary English word. It may bias the recogniser, but
	// fuzzy repair must not aim at it — the seed is excluded from correction for
	// exactly that reason. User terms are explicit, so they are left alone.
	const correctable = mined.filter((term) => !SEED_LOWER.has(term.toLowerCase()));
	const correct = sanitizeKeyterms([...user, ...correctable], { maxTerms: options.maxTerms });
	const cap = options.maxTerms ?? DEFAULT_MAX_TERMS;
	// Something was actually dropped, and the budget is what dropped it.
	return { bias, correct, truncated: bias.length >= cap && biasOrder.length > bias.length };
}

/**
 * Priority order: user terms, then seed jargon, then the current session's
 * vocabulary. Truncation drops the least specific first.
 */
export function collectKeyterms(options: CollectOptions = {}): string[] {
	return collectKeytermSets(options).bias;
}
