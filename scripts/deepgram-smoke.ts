/**
 * Stream a raw PCM file (16 kHz mono s16le) to Deepgram through the real
 * backend, printing every event with a timestamp.
 *
 * Two purposes: prove the wire contract works against the live service, and
 * A/B the effect of keyterms on a fixed utterance.
 *
 *   DEEPGRAM_API_KEY=... bun scripts/deepgram-smoke.ts speech.pcm
 *   DEEPGRAM_API_KEY=... bun scripts/deepgram-smoke.ts speech.pcm subagent,worktree,tsconfig,marginalia,OAuth,webhook
 */

import { readFile } from "node:fs/promises";
import { DeepgramBackend } from "../src/backends/deepgram.ts";
import type { VoiceEvent } from "../src/types.ts";

const CHUNK_BYTES = 3200; // 100 ms
const CHUNK_INTERVAL_MS = 100;
const HARD_TIMEOUT_MS = 30_000;

const [file, termsArg] = process.argv.slice(2);
if (!file) {
	console.error("usage: bun scripts/deepgram-smoke.ts <file.pcm> [keyterm,keyterm,...]");
	process.exit(2);
}

const keyterms = termsArg
	? termsArg
			.split(",")
			.map((term) => term.trim())
			.filter(Boolean)
	: [];

const apiKey = process.env.DEEPGRAM_API_KEY;
if (!apiKey) {
	console.error("DEEPGRAM_API_KEY is not set");
	process.exit(2);
}

const pcm = await readFile(file);
console.log(`file          ${file} (${String(pcm.length)} bytes, ${String(Math.round(pcm.length / 32))} ms)`);
console.log(`keyterms      ${keyterms.length > 0 ? keyterms.join(", ") : "(none)"}`);
console.log(`model         ${process.env.DEEPGRAM_MODEL ?? "nova-3"}`);
console.log("");

const startedAt = Date.now();
const at = () => Date.now() - startedAt;

const backend = new DeepgramBackend({
	apiKey,
	model: process.env.DEEPGRAM_MODEL,
	baseUrl: process.env.DEEPGRAM_URL,
});

let lastAudioSentAt = 0;
let sawFinalAt = 0;
const finals: string[] = [];

const stream = await backend.start(
	{ language: "en", keyterms, signal: new AbortController().signal },
	(event: VoiceEvent) => {
		switch (event.type) {
			case "interim":
				process.stdout.write(`\r[${String(at()).padStart(6)}ms] interim  ${event.text.slice(-90)}`.padEnd(120));
				return;
			case "final":
				finals.push(event.text);
				if (!sawFinalAt) sawFinalAt = at();
				if (lastAudioSentAt > 0) {
					console.log(
						`\n[${String(at()).padStart(6)}ms] FINAL    ${event.text}   (+${String(at() - lastAudioSentAt)}ms after last audio)`,
					);
				} else {
					console.log(`\n[${String(at()).padStart(6)}ms] FINAL    ${event.text}`);
				}
				return;
			case "error":
				console.log(`\n[${String(at()).padStart(6)}ms] ERROR    ${event.code ?? "?"}: ${event.message}`);
				return;
		}
	},
);

if (!stream) {
	console.error("backend did not start a stream");
	process.exit(1);
}

const hardStop = setTimeout(() => {
	console.error(`\nno result after ${String(HARD_TIMEOUT_MS)}ms; giving up`);
	stream.close();
	process.exit(1);
}, HARD_TIMEOUT_MS);

// Feed in real time so the timings mean something.
for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
	stream.feed(pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, pcm.length)));
	lastAudioSentAt = at();
	await new Promise((resolve) => setTimeout(resolve, CHUNK_INTERVAL_MS));
}

const audioDoneAt = at();
console.log(
	`\n[${String(audioDoneAt).padStart(6)}ms] audio sent (${String(audioDoneAt)}ms of real time for ${String(Math.round(pcm.length / 32))}ms of audio)`,
);

const finalizeStart = at();
const outcome = await stream.finalize();
const finalizeMs = at() - finalizeStart;
clearTimeout(hardStop);
stream.close();

console.log(`[${String(at()).padStart(6)}ms] finalize -> ${outcome} (${String(finalizeMs)}ms)`);
console.log("");
console.log(`transcript: ${finals.join(" ")}`);
console.log(
	`speech ended at ~${String(audioDoneAt)}ms; first final at ${sawFinalAt > 0 ? `${String(sawFinalAt)}ms` : "never"}`,
);
