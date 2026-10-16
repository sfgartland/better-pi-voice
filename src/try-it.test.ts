import { describe, expect, test } from "bun:test";
import { TryItPane } from "./try-it.ts";

function makePane() {
	const calls: string[] = [];
	const controller = {
		press: () => calls.push("press"),
		release: () => calls.push("release"),
		repeat: () => calls.push("repeat"),
	};
	let outcome: string | undefined;
	const pane = new TryItPane(
		{ requestRender: () => {} } as never,
		(done) => {
			outcome = done;
		},
		"ctrl+alt+z",
		controller as never,
	);
	return { pane, calls, outcome: () => outcome };
}

describe("TryItPane", () => {
	test("Space starts a recording and toggles on the next press", () => {
		const { pane, calls } = makePane();
		pane.handleInput(" ");
		pane.handleInput(" ");
		expect(calls).toEqual(["press", "press"]);
	});

	test("Enter accepts, Esc asks to change", () => {
		const accept = makePane();
		accept.pane.handleInput("\r");
		expect(accept.outcome()).toBe("done");

		const change = makePane();
		change.pane.handleInput("\u001b");
		expect(change.outcome()).toBe("change");
	});

	test("renders the current state, level and transcript", () => {
		const { pane } = makePane();
		pane.setState("recording");
		pane.setTranscript("hello world");
		pane.setLevel(0.5);

		const text = pane.render(40).join("\n");

		expect(text).toContain("Try it");
		expect(text).toContain("recording");
		expect(text).toContain("hello world");
	});
});
