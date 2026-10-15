import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createFakeCtx, createFakePi, isolateAgentDir } from "./test-support/fake-pi.ts";

// Must run before the extension module is imported: it resolves its settings
// path at load time.
const { root } = isolateAgentDir("better-pi-voice");
const { DEFAULT_SETTINGS, readSettings, writeSettings } = await import("./src/settings.ts");
const { default: factory } = await import("./index.ts");

// Stand in for a configured install, so backend labels name a real model.
await writeSettings({
	...DEFAULT_SETTINGS,
	parakeet: { modelPath: "/models/parakeet-unified-en-0.6b-Q8_0.gguf" },
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The fake command context, extended with the bits only voice needs. */
function makeCtx(options: { select?: string[] } = {}) {
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
