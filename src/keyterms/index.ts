/**
 * Assembling the keyterm list a session starts with.
 */

import { type MineInput, mineKeyterms } from "./mine.ts";
import { sanitizeKeyterms } from "./sanitize.ts";
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

export type CollectOptions = MineInput & {
	/** Terms the user configured by hand. Highest priority. */
	userTerms?: readonly string[] | undefined;
	/** Include the built-in jargon seed list. Default true. */
	useSeed?: boolean | undefined;
	maxTerms?: number | undefined;
};

/**
 * Priority order: user terms, then seed jargon, then the current session's
 * vocabulary. Truncation drops the least specific first.
 */
export function collectKeyterms(options: CollectOptions = {}): string[] {
	const order: string[] = [];
	if (options.userTerms?.length) order.push(...options.userTerms);
	if (options.useSeed !== false) order.push(...SEED_KEYTERMS);
	order.push(...mineKeyterms(options));

	return sanitizeKeyterms(order, { maxTerms: options.maxTerms });
}
