import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { isolateAgentDir } from "../test-support/fake-pi.ts";

// Resolve and isolate the agent dir before importing settings, which reads it.
const { root } = isolateAgentDir("better-pi-voice-overview");
const { OverviewPane, overviewLines } = await import("./overview.ts");
const { DEFAULT_SETTINGS } = await import("./settings.ts");

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("overviewLines", () => {
	test("summarises the saved setup and how to use it", () => {
		const text = overviewLines({ ...DEFAULT_SETTINGS, backend: "deepgram" }).join("\n");

		expect(text).toContain("better-pi-voice is ready");
		expect(text).toContain(DEFAULT_SETTINGS.shortcut);
		expect(text).toContain("How to use it");
		expect(text).toContain("/voice setup");
	});

	test("describes hold and tap modes differently", () => {
		expect(overviewLines({ ...DEFAULT_SETTINGS, mode: "hold" }).join("\n")).toContain(
			`Hold ${DEFAULT_SETTINGS.shortcut}`,
		);
		expect(overviewLines({ ...DEFAULT_SETTINGS, mode: "tap" }).join("\n")).toContain(
			`Press ${DEFAULT_SETTINGS.shortcut}`,
		);
	});
});

describe("OverviewPane", () => {
	test("Enter closes and Esc asks to change", () => {
		let outcome: string | undefined;
		const pane = new OverviewPane(
			(result) => {
				outcome = result;
			},
			["line"],
		);
		expect(pane.render(40)).toEqual(["line"]);

		pane.handleInput("\r");
		expect(outcome).toBe("done");

		pane.handleInput("\u001b");
		expect(outcome).toBe("change");
	});
});
