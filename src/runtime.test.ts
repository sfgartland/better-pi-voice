import { describe, expect, test } from "bun:test";
import { backendLabel } from "./runtime.ts";
import { DEFAULT_SETTINGS, type VoiceSettings } from "./settings.ts";

function withSettings(overrides: Partial<VoiceSettings>): VoiceSettings {
	return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("backendLabel", () => {
	test("names the Deepgram model", () => {
		expect(backendLabel(DEFAULT_SETTINGS)).toBe("deepgram nova-3");
	});

	test("follows a customised Deepgram model", () => {
		const settings = withSettings({
			deepgram: { ...DEFAULT_SETTINGS.deepgram, model: "nova-3-medical" },
		});
		expect(backendLabel(settings)).toBe("deepgram nova-3-medical");
	});

	test("names the local model from its file", () => {
		const settings = withSettings({
			backend: "parakeet",
			parakeet: { ...DEFAULT_SETTINGS.parakeet, modelPath: "/models/parakeet-unified-en-0.6b-Q8_0.gguf" },
		});
		expect(backendLabel(settings)).toBe("parakeet parakeet-unified-en-0.6b-Q8_0 (batch)");
	});

	test("says where the local model comes from when it is inherited", () => {
		// modelPath null means pi-voice's configuration is used, which is worth
		// saying out loud rather than showing nothing.
		const settings = withSettings({ backend: "parakeet", parakeet: { ...DEFAULT_SETTINGS.parakeet, modelPath: null } });
		expect(backendLabel(settings)).toBe("parakeet pi-voice's model (batch)");
	});

	test("never reports the cloud model while configured for local", () => {
		const settings = withSettings({
			backend: "parakeet",
			parakeet: { ...DEFAULT_SETTINGS.parakeet, modelPath: "/m/x.gguf" },
		});
		expect(backendLabel(settings)).not.toContain("deepgram");
		expect(backendLabel(settings)).not.toContain("nova-3");
	});
});
