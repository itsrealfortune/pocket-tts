/**
 * Local-mode bundle management: download, cache, and load ONNX bundles.
 *
 * Bundles come from the community ONNX export of Pocket TTS
 * (`KevinAHM/pocket-tts-onnx` on Hugging Face, INT8-quantized, ~90-360 MB
 * per language). Each bundle is self-contained: ONNX models, SentencePiece
 * tokenizer, BOS voice marker, and metadata. The SentencePiece runtime
 * (WASM build from the reference web demo) is downloaded once per cache
 * directory and shared across languages.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { BundleDownloadError } from "../errors.js";
import type { LocalLanguage } from "../types.js";
import { LOCAL_LANGUAGES } from "../voices.js";

/** Base URL of the ONNX bundle repository. */
const BUNDLE_BASE =
	"https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/main/onnx";

/** SentencePiece WASM runtime from the reference web demo space. */
const SENTENCEPIECE_URL =
	"https://huggingface.co/spaces/KevinAHM/pocket-tts-web/raw/main/sentencepiece.js";

/** Files that make up one language bundle. */
const BUNDLE_FILES = [
	"bundle.json",
	"tokenizer.model",
	"bos_before_voice.npy",
	"flow_lm_main_int8.onnx",
	"flow_lm_flow_int8.onnx",
	"mimi_decoder_int8.onnx",
	"mimi_encoder_int8.onnx",
	"text_conditioner_int8.onnx",
] as const;

/**
 * Minimal structural type for the SentencePiece WASM runtime
 * (`sentencepiece.js` from the reference demo).
 */
export interface SentencePieceLike {
	/** Loads a SentencePiece model from a base64-encoded protobuf. */
	loadFromB64StringModel(b64model: string): Promise<unknown>;
	/** Encodes text into a token-id sequence. */
	encodeIds(text: string): number[];
	/** Decodes a token-id sequence back into text. */
	decodeIds(ids: number[]): string;
}

/** Default platform cache directory for downloaded bundles. */
export function defaultCacheDir(): string {
	const home = os.homedir();
	if (process.platform === "win32") {
		const base =
			process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
		return path.join(base, "pocket-tts");
	}
	if (process.platform === "darwin") {
		return path.join(home, "Library", "Caches", "pocket-tts");
	}
	const base = process.env.XDG_CACHE_HOME ?? path.join(home, ".cache");
	return path.join(base, "pocket-tts");
}

/** Downloads one file atomically (temp file + rename), skipping existing. */
/**
 * Downloads one file atomically (temp file + rename), skipping existing.
 * Streams to disk instead of buffering the whole response in memory
 * (bundles reach 300+ MB).
 */
async function downloadFile(
	url: string,
	dest: string,
	fetchImpl: typeof fetch,
): Promise<void> {
	if (fs.existsSync(dest)) {
		return;
	}
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	const tmp = `${dest}.tmp-${process.pid}`;
	try {
		const response = await fetchImpl(url);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} for ${url}`);
		}
		if (!response.body) {
			throw new Error(`empty response body for ${url}`);
		}
		await pipeline(
			Readable.fromWeb(
				response.body as import("node:stream/web").ReadableStream,
			),
			fs.createWriteStream(tmp),
		);
		fs.renameSync(tmp, dest);
	} catch (error) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// best effort cleanup
		}
		throw error;
	}
}

/** Resolved paths of every file in a downloaded bundle. */
export interface BundlePaths {
	/** Directory containing the bundle. */
	dir: string;
	/** Parsed `bundle.json` metadata. */
	metadata: Record<string, unknown>;
	/** Absolute path of each ONNX model, keyed by short name. */
	models: Record<
		| "flowLmMain"
		| "flowLmFlow"
		| "mimiDecoder"
		| "mimiEncoder"
		| "textConditioner",
		string
	>;
	/** Absolute path of the SentencePiece tokenizer model. */
	tokenizerPath: string;
	/** Absolute path of the BOS voice marker (`.npy`). */
	bosPath: string;
	/** Loaded SentencePiece runtime bound to `tokenizerPath`. */
	tokenizer: SentencePieceLike;
}

/**
 * Ensures a language bundle is downloaded and loads its tokenizer.
 *
 * @param {LocalLanguage} language - Bundle id (for example `"french_24l"`).
 * @param {string} cacheDir - Cache root (see {@link defaultCacheDir}).
 * @param {typeof fetch} [fetchImpl] - Custom fetch (tests/mirrors).
 * @returns {Promise<BundlePaths>} Resolved bundle paths plus tokenizer.
 * @throws {BundleDownloadError} When a file cannot be downloaded.
 * @internal
 */
export async function ensureBundle(
	language: LocalLanguage,
	cacheDir: string,
	fetchImpl: typeof fetch = globalThis.fetch,
): Promise<BundlePaths> {
	const dir = path.join(cacheDir, "bundles", language);
	// sentencepiece.js is independent of the bundle files — download it
	// in the same wave.
	const spPath = path.join(cacheDir, "sentencepiece.js");
	try {
		await Promise.all([
			...BUNDLE_FILES.map((file) =>
				downloadFile(
					`${BUNDLE_BASE}/${language}/${file}`,
					path.join(dir, file),
					fetchImpl,
				),
			),
			downloadFile(SENTENCEPIECE_URL, spPath, fetchImpl),
		]);
	} catch (error) {
		throw new BundleDownloadError(language, (error as Error).message, {
			cause: error,
		});
	}

	// SentencePiece runtime: shared, downloaded once per cache dir.
	// (already fetched in the parallel wave above)

	let metadata: Record<string, unknown>;
	try {
		metadata = JSON.parse(
			fs.readFileSync(path.join(dir, "bundle.json"), "utf8"),
		) as Record<string, unknown>;
	} catch (error) {
		throw new BundleDownloadError(
			language,
			`cannot read bundle.json: ${(error as Error).message}`,
			{ cause: error },
		);
	}

	const tokenizer = await loadSentencePiece(
		spPath,
		path.join(dir, "tokenizer.model"),
	);

	return {
		dir,
		metadata,
		models: {
			flowLmMain: path.join(dir, "flow_lm_main_int8.onnx"),
			flowLmFlow: path.join(dir, "flow_lm_flow_int8.onnx"),
			mimiDecoder: path.join(dir, "mimi_decoder_int8.onnx"),
			mimiEncoder: path.join(dir, "mimi_encoder_int8.onnx"),
			textConditioner: path.join(dir, "text_conditioner_int8.onnx"),
		},
		tokenizerPath: path.join(dir, "tokenizer.model"),
		bosPath: path.join(dir, "bos_before_voice.npy"),
		tokenizer,
	};
}

/** Loads the WASM SentencePiece runtime and binds it to a model file. */
async function loadSentencePiece(
	runtimePath: string,
	modelPath: string,
): Promise<SentencePieceLike> {
	const mod = (await import(pathToFileURL(runtimePath).href)) as {
		SentencePieceProcessor: new () => SentencePieceLike;
	};
	const sp = new mod.SentencePieceProcessor();
	const modelB64 = fs.readFileSync(modelPath).toString("base64");
	await sp.loadFromB64StringModel(modelB64);
	return sp;
}
