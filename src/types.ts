/**
 * Public type definitions for the pocket-tts module.
 */

/** Languages served by the Kyutai cloud API. */
export type CloudLanguage =
	| "english"
	| "french"
	| "german"
	| "spanish"
	| "portuguese"
	| "italian"
	| "dutch";

/**
 * Local-mode model bundles (ONNX export by KevinAHM, INT8).
 *
 * `"*-24l"` bundles are the bigger non-distilled preview models (slower,
 * higher quality); the plain names are the 6-layer distilled models that
 * run faster than real time on modern laptop CPUs.
 */
export type LocalLanguage =
	| "english_2026-04"
	| "french_24l"
	| "german"
	| "german_24l"
	| "italian"
	| "italian_24l"
	| "portuguese"
	| "portuguese_24l"
	| "spanish"
	| "spanish_24l";

/** One built-in cloud voice from the Kyutai catalog. */
export interface CloudVoice {
	/** API identifier accepted as `voice` in cloud mode (for example `"jane"`). */
	id: string;
	/** Display name shown in the Kyutai web UI (for example `"Jane"`). */
	name: string;
	/** Speaker gender as advertised by the source catalog. */
	gender: "female" | "male";
	/** Speaking style as advertised by the source catalog. */
	style: string;
	/**
	 * Language this voice is natively associated with, when the catalog
	 * advertises one (for example Estelle is French). Voices are otherwise
	 * usable with every cloud language — cloning is language-agnostic.
	 */
	languageHint?: CloudLanguage;
	/** Source path in the `kyutai/tts-voices` Hugging Face repository. */
	pathOnServer: string;
}

/** Metadata describing one downloadable local-mode bundle. */
export interface LocalLanguageInfo {
	/** Bundle identifier accepted as `language` in local mode. */
	id: LocalLanguage;
	/** Human-readable language name. */
	name: string;
	/** BCP-47-style language tag (for example `"fr"`). */
	tag: string;
	/** Model size tier: distilled 6-layer, or the larger 24-layer preview. */
	variant: "distilled" | "24-layer";
}

/** One decoded audio chunk yielded by {@link PocketTTSInstance.stream}. */
export interface AudioChunk {
	/** Mono float32 PCM samples in `[-1, 1]` at {@link AudioChunk.sampleRate}. */
	pcm: Float32Array;
	/** Sample rate of the chunk (always 24000 for Pocket TTS). */
	sampleRate: number;
	/** True on the first audio chunk of a synthesis run. */
	isFirst: boolean;
	/** True on the last audio chunk of a synthesis run. */
	isLast: boolean;
}

/** Result of a full {@link PocketTTSInstance.synthesize} call. */
export interface SynthesisResult {
	/** Complete audio as a standard 16-bit PCM WAV buffer. */
	wav: Buffer;
	/** Decoded mono float32 PCM samples at {@link SynthesisResult.sampleRate}. */
	pcm: Float32Array;
	/** Sample rate of the audio (always 24000 for Pocket TTS). */
	sampleRate: number;
	/** Duration of the produced audio, in seconds. */
	durationSec: number;
	/** Mode that produced the audio. */
	mode: "cloud" | "local";
	/** Language code used for synthesis. */
	language: string;
}

/** Options for {@link PocketTTS.load} in cloud mode. */
export interface CloudTtsOptions {
	/** Use the Kyutai cloud API (built-in voices, streaming, no cloning). */
	mode: "cloud";
	/**
	 * Cloud language to synthesize in. Default: `"english"`.
	 * Every built-in voice works with every language (the voice provides
	 * the timbre, the language endpoint provides the model).
	 */
	language?: CloudLanguage;
	/**
	 * Built-in voice id from {@link CloudVoice.id} (for example `"jane"`,
	 * `"estelle"`). Default: the language's native default voice.
	 */
	voice?: string;
	/**
	 * API base URL. Default: the public Kyutai demo endpoint
	 * (`https://pocket-tts-api.kyutai.org`). Point this at your own
	 * `pocket-tts serve` instance to self-host.
	 */
	endpoint?: string;
	/** Overall request timeout in milliseconds. Default: 120000. */
	timeoutMs?: number;
	/**
	 * Custom `fetch` implementation. Intended for tests, proxies, or
	 * instrumentation; defaults to the global `fetch`.
	 */
	fetchImpl?: typeof fetch;
}

/**
 * Raw PCM voice reference for local-mode cloning: float32 samples plus
 * their sample rate (any rate — resampled to 24 kHz internally).
 */
export interface PcmReference {
	/** Mono float32 samples in `[-1, 1]`. */
	pcm: Float32Array;
	/** Sample rate of `pcm` in Hz. */
	sampleRate: number;
}

/** Options for {@link PocketTTS.load} in local mode. */
export interface LocalTtsOptions {
	/** Use the local ONNX runtime (zero-shot voice cloning, offline). */
	mode: "local";
	/**
	 * Model bundle to load. The bundle is downloaded once (140–360 MB)
	 * into the cache directory, then reused. Default: `"english_2026-04"`.
	 */
	language?: LocalLanguage;
	/**
	 * Voice reference for cloning. Accept a path to a WAV file, raw
	 * float32 samples (mono, any sample rate — resampled to 24 kHz), or
	 * a {@link PcmReference} pair. 1–30 seconds of clean speech works
	 * best; the reference is encoded once and cached for the session.
	 */
	voice: string | Float32Array | PcmReference;
	/**
	 * Cache directory for downloaded bundles and the tokenizer runtime.
	 * Default: `$XDG_CACHE_HOME/pocket-tts` (Linux),
	 * `~/Library/Caches/pocket-tts` (macOS), `%LOCALAPPDATA%/pocket-tts`
	 * (Windows).
	 */
	cacheDir?: string;
	/**
	 * Intra-op thread count for ONNX Runtime. Default: ORT's choice.
	 */
	numThreads?: number;
	/**
	 * Disables ORT's CPU memory arena and memory pattern, trading a small
	 * speed loss for much lower peak memory. Useful on shared or low-RAM
	 * machines (the 24-layer bundles need ~2 GB with the default arena).
	 */
	lowMemory?: boolean;
	/**
	 * Sampling temperature. Lower is more deterministic/stable.
	 * Default: `0.7` (the reference web runtime's value).
	 */
	temperature?: number;
	/**
	 * Number of Euler steps of the flow-matching sampler per frame.
	 * More steps = higher quality, slower. Default: `1`; Kyutai suggests
	 * `5` with `temperature: 0.5` for highest quality.
	 */
	lsdSteps?: number;
	/**
	 * Custom `fetch` used to download bundles. Intended for tests or
	 * mirrors; defaults to the global `fetch`.
	 */
	fetchImpl?: typeof fetch;
}

/** Options accepted by {@link PocketTTS.load}. */
export type PocketTTSOptions = CloudTtsOptions | LocalTtsOptions;

/**
 * A Pocket TTS instance (cloud or local). Both modes expose the same
 * streaming interface; capabilities differ (only local clones voices).
 */
export interface PocketTTSInstance {
	/** Runtime that produced this instance. */
	readonly mode: "cloud" | "local";
	/** Language code used for synthesis. */
	readonly language: string;
	/** Sample rate of all produced audio (24000 for Pocket TTS). */
	readonly sampleRate: number;
	/**
	 * Synthesizes `text`, yielding audio chunks as soon as they are
	 * available. Cloud mode streams from the HTTP response; local mode
	 * yields every few decoded frames (first chunk after ~240 ms of audio).
	 *
	 * @param {string} text - The text to synthesize.
	 * @returns {AsyncGenerator<AudioChunk>} Audio chunks in playback order.
	 * @throws {RequestFailedError} When a cloud request fails (cloud mode).
	 * @example
	 * ```ts
	 * for await (const chunk of tts.stream("Bonjour tout le monde.")) {
	 *   player.enqueue(chunk.pcm);
	 * }
	 * ```
	 */
	stream(text: string): AsyncGenerator<AudioChunk>;
	/**
	 * Synthesizes `text` and returns the complete audio as a WAV buffer.
	 *
	 * @param {string} text - The text to synthesize.
	 * @returns {Promise<SynthesisResult>} The full audio plus metadata.
	 * @throws {RequestFailedError} When a cloud request fails (cloud mode).
	 * @example
	 * ```ts
	 * const result = await tts.synthesize("Hello world.");
	 * await fs.writeFile("out.wav", result.wav);
	 * ```
	 */
	synthesize(text: string): Promise<SynthesisResult>;
	/**
	 * Releases any held resources (HTTP controllers, ONNX sessions).
	 * Safe to call multiple times. After `close()`, the instance must not
	 * be used anymore.
	 */
	close(): void;
}
