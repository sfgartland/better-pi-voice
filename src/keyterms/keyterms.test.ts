import { describe, expect, test } from "bun:test";
import {
	collectKeytermSets,
	collectKeyterms,
	correctTranscript,
	DEFAULT_MAX_TERMS,
	editDistance,
	estimateKeytermTokens,
	filePathsFromBranch,
	mineKeyterms,
	pathLikeTokens,
	sanitizeKeyterms,
	tokenizeLabel,
} from "./index.ts";
import { SEED_KEYTERMS } from "./seed.ts";

describe("tokenizeLabel", () => {
	test("splits camelCase boundaries", () => {
		expect(tokenizeLabel("getUserById")).toEqual(["get", "User"]);
		expect(tokenizeLabel("DictationController")).toEqual(["Dictation", "Controller"]);
	});

	test("splits on path and identifier separators", () => {
		expect(tokenizeLabel("src/foo/bar.ts")).toEqual(["src", "foo", "bar"]);
		expect(tokenizeLabel("snake_case_name")).toEqual(["snake", "case", "name"]);
	});

	test("drops words outside the 3-20 character window", () => {
		expect(tokenizeLabel("a ab abc abcdefghijklmnopqrstuvwxyz")).toEqual(["abc"]);
	});
});

describe("sanitizeKeyterms", () => {
	test("dedupes case-insensitively, keeping the first casing", () => {
		expect(sanitizeKeyterms(["MCP", "mcp", "Mcp"])).toEqual(["MCP"]);
	});

	test("keeps the user's ordering", () => {
		expect(sanitizeKeyterms(["zebra", "alpha"])).toEqual(["zebra", "alpha"]);
	});

	test("rejects terms that are too short or too long", () => {
		expect(sanitizeKeyterms(["ab", "x", "abcdefghijklmnopqrstuvwxyz", "valid"])).toEqual(["valid"]);
	});

	test("allows short multi-word phrases but not long ones", () => {
		expect(sanitizeKeyterms(["customer service"])).toEqual(["customer service"]);
		expect(sanitizeKeyterms(["one two three four five"])).toEqual([]);
	});

	test("strips non-printable and non-ASCII characters", () => {
		// The reference implementation does the same: it is a wire-safety filter,
		// not a transliteration.
		expect(sanitizeKeyterms(["caf\u00e9"])).toEqual(["caf"]);
		expect(sanitizeKeyterms(["ok\u0000ay"])).toEqual(["okay"]);
	});

	test("honours maxTerms", () => {
		expect(sanitizeKeyterms(["alpha", "bravo", "charlie"], { maxTerms: 2 })).toEqual(["alpha", "bravo"]);
	});

	test("counts the separator against the character budget", () => {
		// 4 + (1 + 4) = 9
		expect(sanitizeKeyterms(["aaaa", "bbbb"], { maxChars: 9 })).toEqual(["aaaa", "bbbb"]);
		expect(sanitizeKeyterms(["aaaa", "bbbb"], { maxChars: 8 })).toEqual(["aaaa"]);
	});

	test("stops before the estimated token budget", () => {
		// 20-char terms (the maximum) are 5 estimated tokens each. With a high term
		// cap and char budget, only the token cap can stop it, at ~80 terms.
		const many = Array.from({ length: 400 }, (_, i) => `term${String(i).padStart(16, "0")}`);
		const out = sanitizeKeyterms(many, { maxChars: 100_000, maxTerms: 1000 });
		expect(out.length).toBeGreaterThan(DEFAULT_MAX_TERMS);
		expect(out.length).toBeLessThan(1000);
		expect(estimateKeytermTokens(out)).toBeLessThanOrEqual(400);
		expect(estimateKeytermTokens(out)).toBeGreaterThan(350);
	});

	test("rejects a phrase whose words are all too short to carry signal", () => {
		expect(sanitizeKeyterms(["a b c"])).toEqual([]);
		// One real word is enough to keep a phrase with a short acronym.
		expect(sanitizeKeyterms(["TS config"])).toEqual(["TS config"]);
	});

	test("every seed term survives sanitisation", () => {
		// A seed entry that gets filtered out is dead weight in the source.
		expect(sanitizeKeyterms(SEED_KEYTERMS).length).toBe(SEED_KEYTERMS.length);
	});

	test("estimates tokens conservatively", () => {
		expect(estimateKeytermTokens(["abcd"])).toBe(1);
		expect(estimateKeytermTokens(["abcdefgh"])).toBe(2);
	});
});

describe("editDistance", () => {
	test("is zero for identical strings", () => {
		expect(editDistance("subagent", "subagent", 2)).toBe(0);
	});

	test("counts a substitution", () => {
		expect(editDistance("subagest", "subagent", 2)).toBe(1);
	});

	test("counts an adjacent transposition as one edit", () => {
		// This is the important case: ASR swaps letters far more often than it
		// substitutes them, and plain Levenshtein would charge two for it.
		expect(editDistance("subagnet", "subagent", 2)).toBe(1);
	});

	test("bails out past the limit", () => {
		expect(editDistance("completely", "different", 2)).toBeGreaterThan(2);
	});

	test("short-circuits on large length gaps", () => {
		expect(editDistance("a", "abcdefgh", 1)).toBe(2);
	});
});

describe("correctTranscript", () => {
	const keyterms = ["subagent", "idempotent", "tsconfig", "customer service"];

	test("leaves an already-correct keyterm alone", () => {
		const result = correctTranscript("the subagent ran", keyterms, "safe");
		expect(result.text).toBe("the subagent ran");
		expect(result.changes).toEqual([]);
	});

	test("repairs a one-edit error on a short token", () => {
		expect(correctTranscript("the subagnet ran", keyterms, "safe").text).toBe("the subagent ran");
	});

	test("repairs a transposition on a short token", () => {
		// 7 characters, so the limit is 1 — this only passes because OSA counts
		// the adjacent swap once.
		expect(correctTranscript("the tsconfgi file", keyterms, "safe").text).toBe("the tsconfig file");
	});

	test("repairs a two-edit error on a long token", () => {
		expect(correctTranscript("make it idempotant", keyterms, "safe").text).toBe("make it idempotent");
	});

	test("refuses to touch tokens shorter than five characters", () => {
		// "grpe" is 4 characters, so even a distance-1 match is ignored.
		expect(correctTranscript("grpe it", ["grep"], "safe").text).toBe("grpe it");
	});

	test("preserves surrounding punctuation and casing position", () => {
		expect(correctTranscript("subagnet, again.", keyterms, "safe").text).toBe("subagent, again.");
		expect(correctTranscript("Subagnet!", keyterms, "safe").text).toBe("subagent!");
	});

	test("never rewrites a token into a multi-word phrase", () => {
		expect(correctTranscript("customr", ["customer service"], "safe").text).toBe("customr");
	});

	test("report mode describes changes without applying them", () => {
		const result = correctTranscript("the subagnet ran", keyterms, "report");
		expect(result.text).toBe("the subagnet ran");
		expect(result.changes).toEqual([{ from: "subagnet", to: "subagent" }]);
	});

	test("off mode does nothing at all", () => {
		const result = correctTranscript("the subagnet ran", keyterms, "off");
		expect(result.text).toBe("the subagnet ran");
		expect(result.changes).toEqual([]);
	});

	test("leaves ordinary words alone", () => {
		const text = "please explain the thing that happened here";
		expect(correctTranscript(text, keyterms, "safe").text).toBe(text);
	});
});

describe("correctTranscript: split identifiers", () => {
	const terms = ["tsconfig", "worktree", "subagent"];

	test("rejoins an abbreviation split from the rest of a keyterm", () => {
		// The motivating case: ASR renders `tsconfig` as "TS config".
		expect(correctTranscript("the Worktree TS config", terms, "safe").text).toBe("the Worktree tsconfig");
	});

	test("leaves two ordinary-length words alone, even when they concatenate to a keyterm", () => {
		// Deliberate: joining "back end" into "backend" is right in one sentence and
		// wrong in the next. Only abbreviation-shaped splits are repaired, and
		// `report` mode is how you find out whether that is costing you anything.
		expect(correctTranscript("the work tree again", terms, "safe").text).toBe("the work tree again");
		expect(correctTranscript("some thing", ["something"], "safe").text).toBe("some thing");
		expect(correctTranscript("the back end", ["backend"], "safe").text).toBe("the back end");
	});

	test("only joins when the result is exactly a keyterm", () => {
		// "the config" would have to become "theconfig", which is not a keyterm.
		expect(correctTranscript("the config", terms, "safe").text).toBe("the config");
	});

	test("applies the keyterm's own casing", () => {
		// One token is 2 characters, so the abbreviation tell is present.
		expect(correctTranscript("the ts config", ["TSConfig"], "safe").text).toBe("the TSConfig");
	});

	test("will not join two ordinary-length words", () => {
		expect(correctTranscript("some thing", ["something"], "safe").text).toBe("some thing");
	});

	test("still repairs a misheard token after a join", () => {
		expect(correctTranscript("the Worktree tsconfgi", terms, "safe").text).toBe("the Worktree tsconfig");
	});

	test("report mode describes the join without applying it", () => {
		const result = correctTranscript("the TS config", terms, "report");
		expect(result.text).toBe("the TS config");
		expect(result.changes).toEqual([{ from: "TS config", to: "tsconfig" }]);
	});
});

describe("pathLikeTokens", () => {
	test("finds paths and ignores bare words", () => {
		expect(pathLikeTokens("look at src/foo/bar.ts and README")).toEqual(["src/foo/bar.ts"]);
	});

	test("does not mistake a prose slash pair for a path", () => {
		// Otherwise "read/write" becomes the generic keyterm "write".
		expect(pathLikeTokens("read/write and/or")).toEqual([]);
		expect(pathLikeTokens("edit src/foo/bar.ts")).toEqual(["src/foo/bar.ts"]);
	});
});

describe("mineKeyterms", () => {
	test("keeps a bare project name whole", () => {
		expect(mineKeyterms({ cwd: "/home/me/projects/marginalia" })).toEqual(["marginalia"]);
	});

	test("splits a hyphenated package name instead", () => {
		expect(mineKeyterms({ cwd: "/x/pi-add-better-pi-voice" })).toEqual(["add", "better", "voice"]);
	});

	test("prefers the repo name over the cwd basename", () => {
		expect(mineKeyterms({ cwd: "/x/worktree-1", repoName: "marginalia" })).toEqual(["marginalia", "worktree"]);
	});

	test("takes the stem of each touched file", () => {
		expect(mineKeyterms({ filePaths: ["/a/src/nested/DictationController.ts"] })).toEqual(["Dictation", "Controller"]);
	});

	test("scrapes paths out of prose", () => {
		expect(mineKeyterms({ texts: ["why does src/voice/backends/deepgram.ts fail?"] })).toEqual(["deepgram"]);
	});

	test("mines the skill's own name, not the generic SKILL.md document stem", () => {
		// Reading a skill is a read of `.../skills/<name>/SKILL.md`. The stem is a
		// convention, not vocabulary; the directory is the name that matters.
		expect(mineKeyterms({ filePaths: ["/home/me/.pi/agent/skills/multiagent-pipeline/SKILL.md"] })).toEqual([
			"multiagent",
			"pipeline",
		]);
	});

	test("uses the parent directory for other generic document names", () => {
		expect(mineKeyterms({ filePaths: ["/repo/skills/read-source/README.md"] })).toEqual(["read", "source"]);
	});

	test("drops a generic document name with no informative parent", () => {
		expect(mineKeyterms({ filePaths: ["SKILL.md", "README.md"] })).toEqual([]);
	});
});

describe("filePathsFromBranch", () => {
	const branch = [
		{ type: "message", message: { role: "user", content: "check src/audio/capture.ts for me" } },
		{ type: "message", message: { role: "system", content: "" } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "ok" },
					{ type: "toolCall", name: "read", arguments: { path: "/repo/src/backends/deepgram.ts", limit: 10 } },
					{ type: "toolCall", name: "bash", arguments: { command: "rm -rf /tmp/not-a-file.ts" } },
					{ type: "toolCall", name: "edit", arguments: { path: "/repo/src/controller.ts" } },
				],
			},
		},
		{ type: "message", message: { role: "assistant", content: "not an array" } },
		"garbage",
		null,
	];

	test("collects paths from file tools only, and from user text", () => {
		const paths = filePathsFromBranch(branch);
		expect(paths).toContain("/repo/src/backends/deepgram.ts");
		expect(paths).toContain("/repo/src/controller.ts");
		expect(paths).toContain("src/audio/capture.ts");
		// bash arguments are not file paths, even when they look like one.
		expect(paths.join(" ")).not.toContain("not-a-file");
	});

	test("tolerates malformed entries without throwing", () => {
		expect(() => filePathsFromBranch(branch)).not.toThrow();
		expect(filePathsFromBranch([])).toEqual([]);
	});
});

describe("collectKeyterms", () => {
	test("puts user terms first, then seed, then mined", () => {
		const terms = collectKeyterms({ userTerms: ["zzzcustom"], cwd: "/x/marginalia" });
		expect(terms[0]).toBe("zzzcustom");
		expect(terms[1]).toBe(SEED_KEYTERMS[0]!);
		expect(terms).toContain("marginalia");
	});

	test("drops the seed list when asked", () => {
		const terms = collectKeyterms({ cwd: "/x/marginalia", useSeed: false });
		expect(terms).toEqual(["marginalia"]);
	});

	test("truncation keeps the most specific terms", () => {
		const terms = collectKeyterms({ userTerms: ["kept"], cwd: "/x/marginalia", maxTerms: 2 });
		expect(terms).toEqual(["kept", SEED_KEYTERMS[0]!]);
	});

	test("dedupes a term that appears in both the seed list and the project", () => {
		const terms = collectKeyterms({ cwd: "/x/worktree", useSeed: true });
		expect(terms.filter((term) => term.toLowerCase() === "worktree").length).toBe(1);
	});
});

describe("collectKeytermSets", () => {
	test("biases with the seed list but keeps it out of correction", () => {
		const set = collectKeytermSets({ userTerms: ["zzzcustom"], cwd: "/x/marginalia" });

		expect(set.bias).toContain(SEED_KEYTERMS[0]!);
		expect(set.correct).toEqual(["zzzcustom", "marginalia"]);
	});

	test("reports truncation when the budget is reached", () => {
		const set = collectKeytermSets({ userTerms: ["one", "two"], cwd: "/x/marginalia", maxTerms: 2 });

		expect(set.truncated).toBe(true);
	});

	test("keeps mined seed jargon out of correction", () => {
		// `settings` is seed jargon and a plausible file name. It may bias the
		// recogniser, but it must not enter fuzzy repair, for the same reason the seed
		// list itself is excluded: repair turns real words into prose-adjacent terms.
		const set = collectKeytermSets({ filePaths: ["/repo/core/settings.ts"], useSeed: false });

		expect(set.bias).toContain("settings");
		expect(set.correct).not.toContain("settings");
	});
});

describe("correction safety on mined vocabulary", () => {
	test("does not rewrite ordinary words into a mined SKILL document stem", () => {
		const set = collectKeytermSets({ filePaths: ["/repo/skills/brainstorming/SKILL.md"] });

		expect(correctTranscript("i still need that", set.correct, "safe").text).toBe("i still need that");
		expect(correctTranscript("do not spill it", set.correct, "safe").text).toBe("do not spill it");
	});
});
