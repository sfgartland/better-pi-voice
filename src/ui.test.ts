import { describe, expect, test } from "bun:test";
import { EditorSink, LEVEL_WIDGET_KEY, renderLevelBar, statusText } from "./ui.ts";

/** An editor whose contents the test controls directly. */
function makeEditor(initial = "") {
	let text = initial;
	return {
		get: () => text,
		set: (next: string) => {
			text = next;
		},
		peek: () => text,
		type: (more: string) => {
			text += more;
		},
	};
}

describe("renderLevelBar", () => {
	test("always renders exactly the requested width", () => {
		expect(renderLevelBar([], 10)).toHaveLength(10);
		expect(renderLevelBar([0.5], 10)).toHaveLength(10);
		expect(
			renderLevelBar(
				Array.from({ length: 40 }, () => 1),
				24,
			),
		).toHaveLength(24);
	});

	test("silence renders as blanks and full scale as blocks", () => {
		expect(renderLevelBar([0, 0, 0], 3)).toBe("   ");
		expect(renderLevelBar([1, 1, 1], 3)).toBe("\u2588\u2588\u2588");
	});

	test("uses the most recent samples", () => {
		const levels = [0, 0, 1, 1];
		expect(renderLevelBar(levels, 2)).toBe("\u2588\u2588");
	});

	test("clamps out-of-range values instead of throwing", () => {
		// A negative level is silence, not saturation.
		expect(renderLevelBar([0, 9], 2)).toBe(" \u2588");
		expect(renderLevelBar([-5, 1.5], 2)).toBe(" \u2588");
	});
});

describe("EditorSink", () => {
	test("appends the transcript on its own line after existing text", () => {
		const editor = makeEditor("fix this bug");
		const sink = new EditorSink(editor);
		sink.begin();
		expect(sink.commit(0, "and then the other one")).toBe("fix this bug\nand then the other one");
		expect(editor.peek()).toBe("fix this bug\nand then the other one");
	});

	test("writes no leading newline into an empty editor", () => {
		const editor = makeEditor("");
		const sink = new EditorSink(editor);
		sink.begin();
		expect(sink.commit(0, "hello")).toBe("hello");
	});

	test("replaces its own interim text rather than appending to it", () => {
		const editor = makeEditor("");
		const sink = new EditorSink(editor);
		sink.begin();
		sink.showInterim(0, "hello");
		sink.showInterim(0, "hello world");
		expect(editor.peek()).toBe("hello world");
	});

	test("commit after interims leaves exactly one copy", () => {
		const editor = makeEditor("");
		const sink = new EditorSink(editor);
		sink.begin();
		sink.showInterim(0, "hello wor");
		expect(sink.commit(0, "hello world")).toBe("hello world");
		expect(editor.peek()).toBe("hello world");
	});

	test("respects text the user typed while dictating", () => {
		const editor = makeEditor("");
		const sink = new EditorSink(editor);
		sink.begin();
		sink.showInterim(0, "first phrase");
		// The user keeps typing while the transcript updates.
		editor.type(" my own words");
		sink.showInterim(0, "second phrase");
		expect(editor.peek()).toContain("my own words");
		expect(editor.peek()).toContain("second phrase");
	});

	test("the final result is built on what the user typed", () => {
		const editor = makeEditor("note: ");
		const sink = new EditorSink(editor);
		sink.begin();
		editor.type("(mine) ");
		expect(sink.commit(0, "from speech")).toBe("note: (mine) \nfrom speech");
	});

	test("empty text leaves the editor untouched", () => {
		const editor = makeEditor("keep me");
		const sink = new EditorSink(editor);
		sink.begin();
		expect(sink.commit(0, "   ")).toBe("keep me");
		expect(editor.peek()).toBe("keep me");
	});

	test("begin() re-captures the prefix for a new session", () => {
		const editor = makeEditor("first session");
		const sink = new EditorSink(editor);
		sink.begin();
		sink.commit(0, "done");

		editor.set("second session");
		sink.begin();
		expect(sink.commit(0, "again")).toBe("second session\nagain");
		expect(editor.peek()).toBe("second session\nagain");
	});

	test("renders finals in sequence order even when they commit out of order", () => {
		const editor = makeEditor("note: ");
		const sink = new EditorSink(editor);
		sink.begin();
		sink.showInterim(1, "live words");
		sink.commit(0, "first");
		expect(editor.peek()).toBe("note: first\nlive words");
		sink.commit(1, "final words");
		expect(editor.peek()).toBe("note: final words");
	});

	test("adopts user typing between finals instead of overwriting it", () => {
		const editor = makeEditor("");
		const sink = new EditorSink(editor);
		sink.begin();
		editor.type("typed by hand");
		sink.commit(0, "from speech");
		expect(editor.peek()).toBe("typed by hand\nfrom speech");
		expect(sink.submitText()).toBe("typed by hand\nfrom speech");
	});
});

describe("statusText", () => {
	test("shows how many recordings are still pending", () => {
		expect(statusText("processing", "deepgram nova-3", 1)).toContain("1 recording");
		expect(statusText("queued", "deepgram nova-3", 3)).toContain("3 recordings");
		expect(statusText("recording", "deepgram nova-3", 2)).toContain("2 queued");
	});

	test("names the backend and model in every state", () => {
		const label = "deepgram nova-3";
		for (const state of ["idle", "arming", "recording", "processing", "queued", "paused"] as const) {
			expect(statusText(state, label)).toContain(label);
		}
	});

	test("is quiet apart from the label while idle", () => {
		expect(statusText("idle", "deepgram nova-3")).toBe("deepgram nova-3");
	});

	test("says what is happening while recording and transcribing", () => {
		expect(statusText("recording", "deepgram nova-3")).toContain("listening");
		expect(statusText("processing", "deepgram nova-3")).toContain("transcribing with");
	});

	test("distinguishes the two backends", () => {
		expect(statusText("recording", "parakeet parakeet-unified-en-0.6b")).toContain("parakeet");
		expect(statusText("recording", "parakeet parakeet-unified-en-0.6b")).not.toContain("deepgram");
	});

	test("explains a tripped breaker", () => {
		expect(statusText("paused", "deepgram nova-3")).toContain("paused");
	});
});

describe("widget key", () => {
	test("is namespaced to this extension", () => {
		expect(LEVEL_WIDGET_KEY).toStartWith("better-pi-voice");
	});
});
