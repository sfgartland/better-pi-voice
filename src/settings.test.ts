import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, isValidShortcut, parseDotenv, parseSettings, resolveDeepgramApiKey, resolveMaxTerms } from "./settings.ts";
import { DEFAULT_CHUNK_SECONDS } from "./backends/parakeet.ts";

describe("parseSettings", () => {
	test("falls back to defaults for an empty file", () => {
		const { settings, warnings } = parseSettings({});
		expect(settings).toEqual(DEFAULT_SETTINGS);
		expect(warnings).toEqual([]);
	});

	test("treats a non-object as defaults and says so", () => {
		const { settings, warnings } = parseSettings("nonsense");
		expect(settings).toEqual(DEFAULT_SETTINGS);
		expect(warnings.length).toBe(1);
	});

	test("reads the documented fields", () => {
		const { settings } = parseSettings({
			backend: "parakeet",
			mode: "tap",
			shortcut: "ctrl+alt+v",
			language: "de",
			correction: "off",
			submitOnStop: true,
			keyterms: { user: ["subagent"] },
			deepgram: { model: "nova-3-medical" },
			parakeet: { modelPath: "/models/parakeet.gguf" },
		});
		expect(settings.backend).toBe("parakeet");
		expect(settings.mode).toBe("tap");
		expect(settings.shortcut).toBe("ctrl+alt+v");
		expect(settings.language).toBe("de");
		expect(settings.correction).toBe("off");
		expect(settings.submitOnStop).toBe(true);
		expect(settings.keyterms.user).toEqual(["subagent"]);
		expect(settings.deepgram.model).toBe("nova-3-medical");
		expect(settings.parakeet.modelPath).toBe("/models/parakeet.gguf");
	});

	test("keeps defaults for fields of the wrong type and warns once each", () => {
		const { settings, warnings } = parseSettings({
			backend: "whisper",
			mode: 42,
			language: "",
			keyterms: { user: "subagent", maxTerms: 0 },
			correction: "aggressive",
		});
		expect(settings.backend).toBe("deepgram");
		expect(settings.mode).toBe("hold");
		expect(settings.language).toBe("en");
		expect(settings.keyterms.user).toEqual([]);
		expect(settings.keyterms.maxTerms).toBe(DEFAULT_SETTINGS.keyterms.maxTerms);
		expect(settings.correction).toBe("safe");
		expect(warnings.length).toBe(6);
	});

	test("ignores unknown fields rather than failing", () => {
		const { settings, warnings } = parseSettings({ somethingElse: true });
		expect(settings).toEqual(DEFAULT_SETTINGS);
		expect(warnings).toEqual([]);
	});

	test("keeps a partially valid deepgram block", () => {
		const { settings } = parseSettings({ deepgram: { smartFormat: false, endpointingMs: "fast" } });
		expect(settings.deepgram.smartFormat).toBe(false);
		expect(settings.deepgram.endpointingMs).toBe(DEFAULT_SETTINGS.deepgram.endpointingMs);
	});

	test("warns about a shortcut pi-tui could never match", () => {
		const { settings, warnings } = parseSettings({ shortcut: "crtl+alt+z" });

		expect(settings.shortcut).toBe(DEFAULT_SETTINGS.shortcut);
		expect(warnings.some((warning) => warning.startsWith("shortcut"))).toBe(true);
	});
});

describe("isValidShortcut", () => {
	test("accepts modifiers, special keys and symbols", () => {
		for (const key of ["ctrl+alt+z", "esc", "pageUp", "super+k", "ctrl+shift+p", "space", "f11", "`"]) {
			expect(isValidShortcut(key)).toBe(true);
		}
	});

	test("rejects a misspelled, dangling or doubled modifier, and junk", () => {
		for (const key of ["crtl+alt+z", "ctrl+", "ctrl+ctrl+a", "", "   ", "a+b"]) {
			expect(isValidShortcut(key)).toBe(false);
		}
	});
});

describe("parseDotenv", () => {
	test("finds the preferred name", () => {
		expect(parseDotenv("OTHER=1\nDEEPGRAM_API_KEY=abc123\n", "DEEPGRAM_API_KEY")).toBe("abc123");
	});

	test("strips quotes and whitespace", () => {
		expect(parseDotenv('DEEPGRAM_API_KEY="  abc  "\n', "DEEPGRAM_API_KEY")).toBe("abc");
		expect(parseDotenv("export DEEPGRAM_API_KEY=abc\n", "DEEPGRAM_API_KEY")).toBe("abc");
	});

	test("falls back to any deepgram-ish name", () => {
		// The key in the wild is often lowercase snake_case.
		expect(parseDotenv("opencode_go_key=x\ndeepgram_key=zzz\n", "DEEPGRAM_API_KEY")).toBe("zzz");
	});

	test("ignores comments, blanks and empty values", () => {
		expect(parseDotenv("# comment\n\nDEEPGRAM_API_KEY=\n", "DEEPGRAM_API_KEY")).toBeUndefined();
	});

	test("returns undefined when nothing matches", () => {
		expect(parseDotenv("OPENAI_API_KEY=x\n", "DEEPGRAM_API_KEY")).toBeUndefined();
	});
});

describe("resolveDeepgramApiKey", () => {
	test("prefers the environment", () => {
		const settings = { ...DEFAULT_SETTINGS, deepgram: { ...DEFAULT_SETTINGS.deepgram, apiKeyEnv: "TEST_DG_KEY" } };
		process.env.TEST_DG_KEY = "from-env";
		try {
			expect(resolveDeepgramApiKey(settings)).toBe("from-env");
		} finally {
			delete process.env.TEST_DG_KEY;
		}
	});

	test("falls back to the key file", () => {
		const dir = mkdtempSync(join(tmpdir(), "better-pi-voice-key-"));
		const file = join(dir, "keys.env");
		writeFileSync(file, "deepgram_key=file-key\n");
		const settings = {
			...DEFAULT_SETTINGS,
			deepgram: {
				...DEFAULT_SETTINGS.deepgram,
				apiKeyEnv: "DEFINITELY_NOT_SET_KEY",
				apiKeyFile: file,
			},
		};
		try {
			expect(resolveDeepgramApiKey(settings)).toBe("file-key");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("uses an inline key when the environment is unset", () => {
		const settings = {
			...DEFAULT_SETTINGS,
			deepgram: {
				...DEFAULT_SETTINGS.deepgram,
				apiKeyEnv: "DEFINITELY_NOT_SET_KEY",
				apiKey: "inline-key",
				apiKeyFile: null,
			},
		};
		expect(resolveDeepgramApiKey(settings)).toBe("inline-key");
	});

	test("the environment overrides an inline key", () => {
		process.env.TEST_DG_INLINE = "from-env";
		try {
			const settings = {
				...DEFAULT_SETTINGS,
				deepgram: { ...DEFAULT_SETTINGS.deepgram, apiKeyEnv: "TEST_DG_INLINE", apiKey: "inline-key" },
			};
			expect(resolveDeepgramApiKey(settings)).toBe("from-env");
		} finally {
			delete process.env.TEST_DG_INLINE;
		}
	});

	test("does not treat a prototype member named by apiKeyEnv as a key", () => {
		const settings = {
			...DEFAULT_SETTINGS,
			deepgram: { ...DEFAULT_SETTINGS.deepgram, apiKeyEnv: "toString", apiKeyFile: null },
		};
		expect(resolveDeepgramApiKey(settings)).toBeUndefined();
	});

	test("returns undefined when neither source exists", () => {
		const settings = {
			...DEFAULT_SETTINGS,
			deepgram: {
				...DEFAULT_SETTINGS.deepgram,
				apiKeyEnv: "DEFINITELY_NOT_SET_KEY",
				apiKeyFile: "/tmp/vsmoke/does-not-exist.env",
			},
		};
		expect(resolveDeepgramApiKey(settings)).toBeUndefined();
	});
});

describe("chunkSeconds and the batch default agree at 15", () => {
	test("both come from one place", () => {
		expect(DEFAULT_SETTINGS.parakeet.chunkSeconds).toBe(15);
		expect(DEFAULT_CHUNK_SECONDS).toBe(15);
	});
});

describe("keyterm caps", () => {
	test("keyterm cap defaults to the backend's own budget", () => {
		expect(resolveMaxTerms(DEFAULT_SETTINGS)).toBe(100); // deepgram
		expect(resolveMaxTerms({ ...DEFAULT_SETTINGS, backend: "parakeet" })).toBe(60);
		expect(
			resolveMaxTerms({ ...DEFAULT_SETTINGS, keyterms: { ...DEFAULT_SETTINGS.keyterms, maxTerms: 12 } }),
		).toBe(12);
	});

	test("an explicit keyterms.maxTerms is parsed and kept", () => {
		const { settings } = parseSettings({ keyterms: { maxTerms: 7 } });
		expect(settings.keyterms.maxTerms).toBe(7);
	});
});
