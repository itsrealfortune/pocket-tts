/**
 * pocket-tts — Streaming Pocket TTS for Node.js.
 *
 * Two modes, one interface:
 *
 * - **cloud** — the Kyutai public API: 24 built-in voices, 7 languages,
 *   audio streamed from the first byte (~60 ms TTFB). No cloning (the API
 *   has no upload endpoint).
 * - **local** — the ONNX runtime (KevinAHM community export): offline,
 *   **zero-shot voice cloning** from any reference audio (~3-8 s one-shot
 *   on a laptop CPU), 10 bundles. Slower than real time on old CPUs for
 *   the 24-layer models; the 6-layer distilled bundles reach real time
 *   on modern laptops.
 *
 * @example Cloud mode (built-in voices, streaming)
 * ```ts
 * import { PocketTTS } from "pocket-tts";
 *
 * const tts = await PocketTTS.load({ mode: "cloud", language: "french", voice: "estelle" });
 * for await (const chunk of tts.stream("Bonjour tout le monde.")) {
 *   player.enqueue(chunk.pcm); // Float32Array @ 24 kHz
 * }
 * tts.close();
 * ```
 *
 * @example Local mode (zero-shot voice cloning)
 * ```ts
 * import { PocketTTS } from "pocket-tts";
 *
 * const tts = await PocketTTS.load({
 *   mode: "local",
 *   language: "french_24l",
 *   voice: "./my-voice.wav", // any 1-30 s WAV, cloned without training
 * });
 * const result = await tts.synthesize("Cette phrase sort de ma voix clonée.");
 * await fs.writeFile("cloned.wav", result.wav);
 * tts.close();
 * ```
 *
 * @module pocket-tts
 */

import { createCloudInstance } from "./cloud.js";
import { createLocalInstance } from "./local/runtime.js";
import type { PocketTTSInstance, PocketTTSOptions } from "./types.js";

/** Factory for cloud and local Pocket TTS instances. */
// biome-ignore lint/complexity/noStaticOnlyClass: intentional namespace-style API (matches pipertts)
export class PocketTTS {
	/**
	 * Loads a Pocket TTS instance in the requested mode.
	 *
	 * Cloud mode validates the voice against the built-in catalog and
	 * rejects cloning attempts with {@link CloudModeCloningError}. Local
	 * mode downloads the model bundle on first use (cached), then encodes
	 * the voice reference (zero-shot cloning — no training).
	 *
	 * @param {PocketTTSOptions} options - Mode, language, voice, and runtime options.
	 * @returns {Promise<PocketTTSInstance>} A ready-to-stream instance.
	 * @throws {CloudModeCloningError} When cloning is requested in cloud mode.
	 * @throws {UnknownVoiceError} When a cloud voice id is not in the catalog.
	 * @throws {UnknownLanguageError} When a cloud language code is invalid.
	 * @throws {BundleDownloadError} When a local bundle cannot be downloaded.
	 * @throws {AudioDecodeError} When a voice reference cannot be decoded.
	 * @throws {InvalidOptionError} When options are internally inconsistent.
	 * @example
	 * ```ts
	 * const cloud = await PocketTTS.load({ mode: "cloud" }); // english, default voice
	 * const local = await PocketTTS.load({ mode: "local", voice: "./ref.wav" });
	 * ```
	 */
	static async load(options: PocketTTSOptions): Promise<PocketTTSInstance> {
		if (options.mode === "cloud") {
			return createCloudInstance(options);
		}
		if (options.mode === "local") {
			return createLocalInstance(options);
		}
		// Exhaustiveness: reaching here means the mode was never valid.
		throw new Error(
			`pocket-tts: unknown mode "${(options as { mode?: string }).mode}". Use "cloud" or "local".`,
		);
	}
}

export { DEFAULT_CLOUD_ENDPOINT } from "./cloud.js";
export {
	AudioDecodeError,
	BundleDownloadError,
	CloudModeCloningError,
	InvalidOptionError,
	PocketTTSError,
	RequestFailedError,
	UnknownLanguageError,
	UnknownVoiceError,
} from "./errors.js";
export { defaultCacheDir } from "./local/bundle.js";
export type { PreparedVoice } from "./local/runtime.js";
export { CloudPocketTTS } from "./cloud.js";
export { LocalPocketTTS } from "./local/runtime.js";
export {
	CLOUD_DEFAULT_VOICE,
	CLOUD_LANGUAGES,
	CLOUD_VOICES,
	isCloudLanguage,
	isLocalLanguage,
	listCloudLanguages,
	listCloudVoices,
	listLocalLanguages,
	LOCAL_LANGUAGES,
	voiceIdFromDisplayName,
} from "./voices.js";
export { pcmToWav, resamplePcm, SAMPLE_RATE, wavToPcm } from "./audio.js";
export type {
	AudioChunk,
	CloudLanguage,
	CloudTtsOptions,
	CloudVoice,
	LocalLanguage,
	LocalLanguageInfo,
	LocalTtsOptions,
	PocketTTSInstance,
	PocketTTSOptions,
	SynthesisResult,
} from "./types.js";
export type { PocketTTSErrorCode } from "./errors.js";
