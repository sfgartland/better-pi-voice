import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeCtx, createFakePi, isolateAgentDir } from "./test-support/fake-pi.ts";

// Must run before the extension module is imported: it resolves its settings
// path at load time.
const { root } = isolateAgentDir("better-pi-voice");
const { DEFAULT_SETTINGS, readSettings, settingsPath, writeSettings } = await import("./src/settings.ts");
const { default: factory } = await import("./index.ts");

// Stand in for a configured install, so backend labels name a real model.
await writeSettings({
	...DEFAULT_SETTINGS,
	parakeet: { modelPath: "/models/parakeet-unified-en-0.6b-Q8_0.gguf" },
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The fake command context, extended with the bits only voice needs. */
function makeCtx(options: { select?: string[]; hasUI?: boolean } = {}) {
	const base = createFakeCtx(options);
	let reloaded = 0;
	const editor = { text: "" };
	const ctx = {
		...base.ctx,
		reload: async () => {
			reloaded++;
		},
		ui: {
			...base.ctx.ui,
			getEditorText: () => editor.text,
			setEditorText: (text: string) => {
				editor.text = text;
			},
			onTerminalInput: () => () => {},
		},
	};
	return { ...base, ctx, reloads: () => reloaded };
}

async function load() {
	const pi = createFakePi();
	await factory(pi.api);
	return pi;
}

const HUB = join(process.env.XDG_CACHE_HOME ?? "", "huggingface", "hub");

function addCachedModel(repo: string, file: string): string {
	const dir = join(HUB, `models--test--${repo}`, "snapshots", "abc123");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, file);
	writeFileSync(path, "not a real model");
	return path;
}

// Each test starts from the same configured install, so order cannot leak state.
beforeEach(async () => {
	rmSync(HUB, { recursive: true, force: true });
	delete process.env.DEEPGRAM_API_KEY;
	await writeSettings({
		...DEFAULT_SETTINGS,
		parakeet: { ...DEFAULT_SETTINGS.parakeet, modelPath: "/models/parakeet-unified-en-0.6b-Q8_0.gguf" },
	});
});

describe("command argument handling", () => {
	test("/voice with no arguments reports status instead of throwing", async () => {
		const pi = await load();
		const { ctx, notifications } = makeCtx();

		// pi's declared type is `args: string`, but it passes nothing at all when
		// the command is invoked bare. An unguarded args.trim() throws here.
		await pi.run("voice", undefined as unknown as string, ctx);

		expect(notifications.length).toBe(1);
		expect(notifications[0]!.message).toContain("better-pi-voice");
	});

	test("/voice-keyterms with no arguments lists instead of throwing", async () => {
		const pi = await load();
		const { ctx, notifications } = makeCtx();

		await pi.run("voice-keyterms", undefined as unknown as string, ctx);

		expect(notifications.length).toBe(1);
		expect(notifications[0]!.message).toContain("keyterm");
	});

	test("/voice with only whitespace is treated as no arguments", async () => {
		const pi = await load();
		const { ctx, notifications } = makeCtx();

		await pi.run("voice", "   ", ctx);

		expect(notifications[0]!.message).toContain("better-pi-voice");
	});
});

describe("/voice backend", () => {
	test("switches backend, reports the model, and reloads", async () => {
		const pi = await load();
		const { ctx, notifications, reloads } = makeCtx();

		await pi.run("voice", "backend parakeet", ctx);

		expect((await readSettings()).settings.backend).toBe("parakeet");
		expect(notifications[0]!.message).toContain("parakeet");
		// The label must name the model, not just the backend.
		expect(notifications[0]!.message).toContain("parakeet-unified-en-0.6b");
		expect(reloads()).toBe(1);

		// Put it back so the other tests see the default.
		await pi.run("voice", "backend deepgram", ctx);
	});

	test("offers a picker when no backend is named", async () => {
		const pi = await load();
		const { ctx, notifications } = makeCtx({ select: ["parakeet"] });

		await pi.run("voice", "backend", ctx);

		expect((await readSettings()).settings.backend).toBe("parakeet");
		expect(notifications[0]!.message).toContain("parakeet");

		await pi.run("voice", "backend deepgram", ctx);
	});

	test("a cancelled picker changes nothing", async () => {
		const pi = await load();
		await pi.run("voice", "backend deepgram", makeCtx().ctx);
		const { ctx, notifications, reloads } = makeCtx({ select: [] });

		await pi.run("voice", "backend", ctx);

		expect((await readSettings()).settings.backend).toBe("deepgram");
		expect(notifications).toEqual([]);
		expect(reloads()).toBe(0);
	});

	test("rejects an unknown backend without writing settings", async () => {
		const pi = await load();
		const { ctx, notifications, reloads } = makeCtx();

		await pi.run("voice", "backend whisper", ctx);

		expect((await readSettings()).settings.backend).toBe("deepgram");
		expect(notifications[0]!.message).toContain("Unknown backend");
		expect(reloads()).toBe(0);
	});

	test("says so when the backend is already selected", async () => {
		const pi = await load();
		const { ctx, notifications, reloads } = makeCtx();

		await pi.run("voice", "backend deepgram", ctx);

		expect(notifications[0]!.message).toContain("already");
		expect(reloads()).toBe(0);
	});
});

describe("/voice-keyterms", () => {
	test("adds, lists and removes a term", async () => {
		const pi = await load();

		await pi.run("voice-keyterms", "add zzzsubagent", makeCtx().ctx);
		expect((await readSettings()).settings.keyterms.user).toContain("zzzsubagent");

		// An empty string behaves the same as no arguments: list what is there.
		const empty = makeCtx();
		await pi.run("voice-keyterms", "", empty.ctx);
		expect(empty.notifications[0]!.message).toContain("zzzsubagent");

		const listed = makeCtx();
		await pi.run("voice-keyterms", undefined as unknown as string, listed.ctx);
		expect(listed.notifications[0]!.message).toContain("zzzsubagent");

		await pi.run("voice-keyterms", "remove zzzsubagent", makeCtx().ctx);
		expect((await readSettings()).settings.keyterms.user).not.toContain("zzzsubagent");
	});

	test("does not add the same term twice", async () => {
		const pi = await load();
		await pi.run("voice-keyterms", "add zzzdupe", makeCtx().ctx);
		const { ctx, notifications } = makeCtx();

		await pi.run("voice-keyterms", "add ZZzdupe", ctx);

		expect(notifications[0]!.message).toContain("already");
		expect((await readSettings()).settings.keyterms.user.filter((t) => t.toLowerCase() === "zzzdupe").length).toBe(1);
	});
});

describe("/voice set", () => {
	test("sets a numeric chunk length and reloads", async () => {
		const pi = await load();
		const { ctx, notifications, reloads } = makeCtx();

		await pi.run("voice", "set chunkSeconds 45", ctx);

		expect((await readSettings()).settings.parakeet.chunkSeconds).toBe(45);
		expect(notifications[0]!.message).toContain("chunkSeconds");
		expect(reloads()).toBe(1);
	});

	test("sets booleans, enums and the auto silence level", async () => {
		const pi = await load();

		await pi.run("voice", "set submitOnStop true", makeCtx().ctx);
		expect((await readSettings()).settings.submitOnStop).toBe(true);

		await pi.run("voice", "set correction report", makeCtx().ctx);
		expect((await readSettings()).settings.correction).toBe("report");

		await pi.run("voice", "set mode tap", makeCtx().ctx);
		expect((await readSettings()).settings.mode).toBe("tap");

		await pi.run("voice", "set silenceLevel auto", makeCtx().ctx);
		expect((await readSettings()).settings.parakeet.silenceLevel).toBe("auto");

		await pi.run("voice", "set silenceLevel 0.4", makeCtx().ctx);
		expect((await readSettings()).settings.parakeet.silenceLevel).toBe(0.4);
	});

	test("rejects a value the parser would fall back on, without writing", async () => {
		const pi = await load();
		const { ctx, notifications, reloads } = makeCtx();

		await pi.run("voice", "set correction bogus", ctx);

		expect((await readSettings()).settings.correction).toBe("safe");
		expect(notifications[0]!.message.toLowerCase()).toContain("correction");
		expect(reloads()).toBe(0);
	});

	test("rejects a non-numeric chunk length", async () => {
		const pi = await load();
		const { ctx, notifications, reloads } = makeCtx();

		await pi.run("voice", "set chunkSeconds soon", ctx);

		expect((await readSettings()).settings.parakeet.chunkSeconds).toBe(30);
		expect(notifications.length).toBe(1);
		expect(reloads()).toBe(0);
	});

	test("rejects an unknown setting", async () => {
		const pi = await load();
		const { ctx, notifications, reloads } = makeCtx();

		await pi.run("voice", "set frobnicate yes", ctx);

		expect(notifications[0]!.message).toContain("Unknown setting");
		expect(reloads()).toBe(0);
	});

	test("rejects a key inherited from Object.prototype instead of resetting settings", async () => {
		const pi = await load();
		const { ctx, notifications, reloads } = makeCtx();

		await pi.run("voice", "set toString x", ctx);

		expect(notifications[0]!.message).toContain("Unknown setting");
		expect((await readSettings()).settings.backend).toBe("deepgram");
		expect((await readSettings()).settings.parakeet.chunkSeconds).toBe(30);
		expect(reloads()).toBe(0);
	});

	test("rejects a model path that does not exist", async () => {
		const pi = await load();
		const { ctx, notifications, reloads } = makeCtx();

		await pi.run("voice", "set model /nope/missing.gguf", ctx);

		expect(notifications[0]!.message).toContain("No file");
		expect((await readSettings()).settings.parakeet.modelPath).toBe("/models/parakeet-unified-en-0.6b-Q8_0.gguf");
		expect(reloads()).toBe(0);
	});

	test("accepts an existing model file for `set model`", async () => {
		const file = join(tmpdir(), `better-pi-voice-setmodel-${String(process.pid)}.gguf`);
		writeFileSync(file, "not a real model");
		const pi = await load();
		const { ctx, reloads } = makeCtx();

		await pi.run("voice", `set model ${file}`, ctx);

		expect((await readSettings()).settings.parakeet.modelPath).toBe(file);
		expect(reloads()).toBe(1);
		rmSync(file, { force: true });
	});

	test("a bare /voice set explains the keys instead of throwing", async () => {
		const pi = await load();
		const { ctx, notifications } = makeCtx();

		await pi.run("voice", "set", ctx);

		expect(notifications[0]!.message).toContain("set <key> <value>");
	});
});

describe("/voice model", () => {
	test("accepts an explicit path", async () => {
		const file = join(tmpdir(), `better-pi-voice-model-${String(process.pid)}.gguf`);
		writeFileSync(file, "not a real model");
		const pi = await load();
		const { ctx, notifications, reloads } = makeCtx();

		await pi.run("voice", `model ${file}`, ctx);

		expect((await readSettings()).settings.parakeet.modelPath).toBe(file);
		expect(notifications[0]!.message).toContain("better-pi-voice-model");
		expect(reloads()).toBe(1);
		rmSync(file, { force: true });
	});

	test("rejects a path that does not exist", async () => {
		const pi = await load();
		const { ctx, notifications, reloads } = makeCtx();

		await pi.run("voice", "model /nope/missing.gguf", ctx);

		expect((await readSettings()).settings.parakeet.modelPath).toBe("/models/parakeet-unified-en-0.6b-Q8_0.gguf");
		expect(notifications[0]!.message).toContain("No file");
		expect(reloads()).toBe(0);
	});

	test("picks from the models already on disk", async () => {
		addCachedModel("parakeet-tdt_ctc-110m-gguf", "parakeet-tdt_ctc-110m-Q8_0.gguf");
		const pi = await load();
		const { ctx, notifications, reloads } = makeCtx({ select: ["parakeet-tdt_ctc-110m-Q8_0"] });

		await pi.run("voice", "model", ctx);

		expect((await readSettings()).settings.parakeet.modelPath).toContain("parakeet-tdt_ctc-110m");
		expect(notifications[0]!.message).toContain("parakeet-tdt_ctc-110m");
		expect(reloads()).toBe(1);
	});

	test("a cancelled picker changes nothing", async () => {
		addCachedModel("parakeet-tdt_ctc-110m-gguf", "parakeet-tdt_ctc-110m-Q8_0.gguf");
		const pi = await load();
		const { ctx, notifications, reloads } = makeCtx({ select: [] });

		await pi.run("voice", "model", ctx);

		expect((await readSettings()).settings.parakeet.modelPath).toBe("/models/parakeet-unified-en-0.6b-Q8_0.gguf");
		expect(notifications).toEqual([]);
		expect(reloads()).toBe(0);
	});

	test("without a UI it lists the models instead of prompting", async () => {
		addCachedModel("parakeet-tdt_ctc-110m-gguf", "parakeet-tdt_ctc-110m-Q8_0.gguf");
		const pi = await load();
		const { ctx, notifications, reloads } = makeCtx({ hasUI: false });

		await pi.run("voice", "model", ctx);

		expect(notifications[0]!.message).toContain("Pass a path explicitly");
		expect(notifications[0]!.message).toContain("parakeet-tdt_ctc-110m");
		expect(reloads()).toBe(0);
	});

	test("says so when no model is on disk", async () => {
		const pi = await load();
		const { ctx, notifications, reloads } = makeCtx();

		await pi.run("voice", "model", ctx);

		expect(notifications[0]!.message).toContain("No Parakeet models");
		expect(reloads()).toBe(0);
	});
});

describe("first run", () => {
	test("configures itself and tells the user which key to hold", async () => {
		rmSync(settingsPath(), { force: true });
		process.env.DEEPGRAM_API_KEY = "test-key";
		const pi = await load();
		const { ctx, notifications } = makeCtx();

		await pi.emit("session_start", {}, ctx);

		expect(notifications[0]!.message).toContain("Deepgram");
		expect(notifications[0]!.message).toContain("ctrl+alt+z");
		expect((await readSettings()).settings.backend).toBe("deepgram");
	});

	test("writes nothing and warns when nothing is usable", async () => {
		rmSync(settingsPath(), { force: true });
		const pi = await load();
		const { ctx, notifications } = makeCtx();

		await pi.emit("session_start", {}, ctx);

		expect(notifications[0]!.message).toContain("not configured");
		expect(notifications[0]!.type).toBe("warning");
		expect(await Bun.file(settingsPath()).exists()).toBe(false);
	});
});
