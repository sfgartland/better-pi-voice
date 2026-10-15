/**
 * Stream a raw PCM file (16 kHz mono s16le) through the local Parakeet backend.
 *
 * The unit tests cover the pipeline with a fake backend, so this is the only
 * thing that proves the transcribe-cpp wiring actually runs.
 *
 *   bun scripts/parakeet-smoke.ts speech.pcm [model.gguf]
 */

import { readFile } from "node:fs/promises";
import { ParakeetBackend } from "../src/backends/parakeet.ts";
import type { VoiceEvent } from "../src/types.ts";

const CHUNK_BYTES = 3200;
const [file, modelArg] = process.argv.slice(2);
if (!file) {
	console.error("usage: bun scripts/parakeet-smoke.ts <file.pcm> [model.gguf]");
	process.exit(2);
}

const pcm = await readFile(file);
console.log(`file     ${file} (${String(Math.round(pcm.length / 32))} ms)`);

const backend = new ParakeetBackend({ modelPath: modelArg ?? null });
const availability = await backend.checkAvailability();
console.log(`model    ${backend.model}`);
if (!availability.available) {
	console.error(`unavailable: ${availability.reason ?? "unknown"}`);
	process.exit(1);
}

const startedAt = Date.now();
const at = () => String(Date.now() - startedAt).padStart(6);
const finals: string[] = [];

const stream = await backend.start(
	{ language: "en", keyterms: [], signal: new AbortController().signal },
	(event: VoiceEvent) => {
		if (event.type === "interim") process.stdout.write(`\r[${at()}ms] interim  ${event.text.slice(-80)}`.padEnd(110));
		else if (event.type === "final") {
			finals.push(event.text);
			console.log(`\n[${at()}ms] FINAL    ${event.text}`);
		} else console.log(`\n[${at()}ms] ERROR    ${event.code ?? "?"}: ${event.message}`);
	},
);
if (!stream) {
	console.error("backend did not start");
	process.exit(1);
}

for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
	stream.feed(pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, pcm.length)));
	await new Promise((resolve) => setTimeout(resolve, 100));
}

const outcome = await stream.finalize();
stream.close();
console.log(`[${at()}ms] finalize -> ${outcome}`);
console.log(`\ntranscript: ${finals.join(" ")}`);
