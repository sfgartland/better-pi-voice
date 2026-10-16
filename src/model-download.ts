/**
 * Downloading the local GGUF models the setup wizard offers.
 *
 * Deliberately plain: one HTTPS GET to Hugging Face's `resolve` endpoint per
 * file, streamed into our own cache with a size and sha256 check. We do not
 * reproduce Hugging Face's blob/symlink cache layout because the settings store
 * an absolute model path; a flat directory of files is enough.
 */

import { createHash } from "node:crypto";
import { createWriteStream, statSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export type CatalogModel = {
	id: string;
	name: string;
	repository: string;
	filename: string;
	size: number;
	sha256: string;
	/** One line shown next to the model in the picker. */
	note: string;
	recommended?: boolean;
};

/**
 * The known Parakeet/ASR GGUFs from the benchmarks report, best first. Sizes and
 * checksums match `@earendil-works/pi-voice`'s catalog.
 */
export const MODEL_CATALOG: CatalogModel[] = [
	{
		id: "parakeet-tdt_ctc-110m",
		name: "parakeet-tdt_ctc-110m",
		repository: "handy-computer/parakeet-tdt_ctc-110m-gguf",
		filename: "parakeet-tdt_ctc-110m-Q8_0.gguf",
		size: 135_373_280,
		sha256: "7dd44c74a331d788a4e5f8b16913b3feb29ced22cf5613aad0e0f6cd30516296",
		note: "smallest and fastest here, and safe to cut at pauses",
		recommended: true,
	},
	{
		id: "canary-180m-flash",
		name: "canary-180m-flash",
		repository: "handy-computer/canary-180m-flash-gguf",
		filename: "canary-180m-flash-Q8_0.gguf",
		size: 218_447_552,
		sha256: "e13c7f5d0952b056a027cfffec13e3a3a134d1608babed24f983568f141e297c",
		note: "fast batch model; en, de, es, fr",
	},
	{
		id: "parakeet-tdt-0.6b-v2",
		name: "parakeet-tdt-0.6b-v2",
		repository: "handy-computer/parakeet-tdt-0.6b-v2-gguf",
		filename: "parakeet-tdt-0.6b-v2-Q8_0.gguf",
		size: 729_574_912,
		sha256: "f0d0e99cebb6d3b83f1f7069b82b5d3c2e39a54545b0da039cb4bafd9c4e5caa",
		note: "batch model, more accurate than the 110m",
	},
	{
		id: "nemotron-3.5-asr-streaming-0.6b",
		name: "nemotron-3.5-asr-streaming-0.6b",
		repository: "handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf",
		filename: "nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf",
		size: 751_094_240,
		sha256: "b94545b313b3223fda7b2857a52681da813935c2127643d1e9ff0c23d988089c",
		note: "streaming, 32 languages",
	},
	{
		id: "parakeet-unified-en-0.6b",
		name: "parakeet-unified-en-0.6b",
		repository: "handy-computer/parakeet-unified-en-0.6b-gguf",
		filename: "parakeet-unified-en-0.6b-Q8_0.gguf",
		size: 731_357_568,
		sha256: "4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795",
		note: "most accurate, but too slow to stream here",
	},
];

function cacheHome(): string {
	const xdg = process.env.XDG_CACHE_HOME?.trim();
	return xdg ? xdg : join(homedir(), ".cache");
}

/** Where downloaded models live: a flat directory, one file per model. */
export function modelsDir(): string {
	return join(cacheHome(), "better-pi-voice", "models");
}

export function formatSize(bytes: number): string {
	const mb = bytes / 1024 / 1024;
	return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${String(Math.round(mb))} MB`;
}

/** A catalog file counts as present when it exists at the expected size. */
export function isDownloaded(model: CatalogModel): boolean {
	try {
		return statSync(join(modelsDir(), model.filename)).size === model.size;
	} catch {
		return false;
	}
}

export type DownloadOptions = {
	signal?: AbortSignal;
	onProgress?: (downloaded: number, total: number) => void;
	/** Overridable for tests; defaults to the global fetch. */
	fetch?: typeof fetch;
};

/** Download one catalog model, verify its checksum, and return its path. */
export async function downloadModel(model: CatalogModel, options: DownloadOptions = {}): Promise<string> {
	const fetchImpl = options.fetch ?? fetch;
	const target = join(modelsDir(), model.filename);
	if (isDownloaded(model)) {
		options.onProgress?.(model.size, model.size);
		return target;
	}

	await mkdir(modelsDir(), { recursive: true });
	const partial = `${target}.part`;
	const url = `https://huggingface.co/${model.repository}/resolve/main/${model.filename}`;
	const response = await fetchImpl(url, { signal: options.signal });
	if (!response.ok || !response.body) {
		throw new Error(`Could not download ${model.name} (HTTP ${String(response.status)})`);
	}

	const total = Number(response.headers.get("content-length")) || model.size;
	const hash = createHash("sha256");
	let downloaded = 0;
	const meter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			hash.update(chunk);
			downloaded += chunk.length;
			options.onProgress?.(downloaded, total);
			callback(null, chunk);
		},
	});

	await pipeline(
		Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
		meter,
		createWriteStream(partial),
	);

	if (model.sha256 && hash.digest("hex") !== model.sha256) {
		await rm(partial, { force: true });
		throw new Error(`${model.name} failed its checksum; the download may be corrupt.`);
	}
	await rename(partial, target);
	return target;
}
