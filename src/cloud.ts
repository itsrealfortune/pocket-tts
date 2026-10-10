/**
 * Cloud mode: streaming client for the Kyutai Pocket TTS API.
 *
 * The API accepts `POST {endpoint}/{language}/tts` with a multipart body
 * (`text` + `voice_url`) and responds with a streamed 24 kHz WAV. Time to
 * first byte is ~50-80 ms on the public endpoint; audio is playable while
 * it is still being generated. Only the 24 built-in voices are available
 * (the API has no upload endpoint — cloning requires local mode).
 */

import { pcmToWav, SAMPLE_RATE, WavStreamDecoder } from "./audio.js";
import {
	CloudModeCloningError,
	RequestFailedError,
	UnknownLanguageError,
	UnknownVoiceError,
} from "./errors.js";
import type {
	AudioChunk,
	CloudLanguage,
	CloudTtsOptions,
	PocketTTSInstance,
	SynthesisResult,
} from "./types.js";
import {
	CLOUD_DEFAULT_VOICE,
	CLOUD_LANGUAGE_LIST,
	CLOUD_VOICE_IDS,
	isCloudLanguage,
} from "./voices.js";

/** Default public demo endpoint operated by Kyutai (no SLA, be reasonable). */
export const DEFAULT_CLOUD_ENDPOINT = "https://pocket-tts-api.kyutai.org";

/** Rejects voice values that look like cloning requests in cloud mode. */
function assertNotCloningRequest(voice: string | undefined): void {
	if (voice === undefined) {
		return;
	}
	const looksLikePath =
		voice.includes("/") ||
		voice.includes("\\") ||
		voice.endsWith(".wav") ||
		voice.endsWith(".mp3") ||
		voice.endsWith(".flac") ||
		voice.startsWith("hf://") ||
		voice.startsWith("http://") ||
		voice.startsWith("https://");
	if (looksLikePath) {
		throw new CloudModeCloningError(voice);
	}
}

/**
 * Cloud Pocket TTS instance (built-in voices, HTTP streaming, no cloning).
 *
 * Create one with {@link PocketTTS.load} using `mode: "cloud"`.
 */
export class CloudPocketTTS implements PocketTTSInstance {
	/** Always `"cloud"` for this implementation. */
	readonly mode = "cloud" as const;
	/** Sample rate of all produced audio (24000). */
	readonly sampleRate = SAMPLE_RATE;
	/** Language code used for synthesis. */
	readonly language: CloudLanguage;
	/** Voice id sent with each request. */
	readonly voice: string;
	/** Base URL of the API, without trailing slash. */
	readonly endpoint: string;

	readonly #timeoutMs: number;
	readonly #fetch: typeof fetch;
	readonly #controllers = new Set<AbortController>();
	#closed = false;

	/**
	 * Use {@link PocketTTS.load} instead of constructing directly.
	 *
	 * @internal
	 */
	constructor(
		options: CloudTtsOptions & { language: CloudLanguage; voice: string },
	) {
		this.language = options.language;
		this.voice = options.voice;
		this.endpoint = (options.endpoint ?? DEFAULT_CLOUD_ENDPOINT).replace(
			/\/+$/,
			"",
		);
		this.#timeoutMs = options.timeoutMs ?? 120_000;
		this.#fetch = options.fetchImpl ?? globalThis.fetch;
		if (typeof this.#fetch !== "function") {
			throw new RequestFailedError(
				"No global fetch available. Node.js >= 18.17 is required for cloud mode.",
			);
		}
	}

	/**
	 * Synthesizes text, streaming audio chunks as they arrive.
	 *
	 * @param {string} text - The text to synthesize. Must not be empty.
	 * @returns {AsyncGenerator<AudioChunk>} Decoded 24 kHz chunks in order.
	 * @throws {RequestFailedError} On HTTP, network, or timeout failures.
	 * @example
	 * ```ts
	 * for await (const chunk of tts.stream("Bonjour tout le monde.")) {
	 *   player.enqueue(chunk.pcm);
	 * }
	 * ```
	 */
	async *stream(text: string): AsyncGenerator<AudioChunk> {
		if (this.#closed) {
			throw new RequestFailedError("Instance is closed.");
		}
		const trimmed = text.trim();
		if (!trimmed) {
			throw new RequestFailedError("text must not be empty");
		}

		const controller = new AbortController();
		this.#controllers.add(controller);
		const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
		try {
			const form = new FormData();
			form.append("text", trimmed);
			form.append("voice_url", this.voice);

			const response = await this.#fetch(
				`${this.endpoint}/${this.language}/tts`,
				{
					method: "POST",
					body: form,
					signal: controller.signal,
				},
			);
			if (!response.ok) {
				throw new RequestFailedError(
					`Pocket TTS cloud request failed (${response.status} ${response.statusText})`,
					response.status,
				);
			}
			if (!response.body) {
				throw new RequestFailedError(
					"Pocket TTS cloud response has no body",
					response.status,
				);
			}

			const decoder = new WavStreamDecoder();
			const reader = response.body.getReader();
			let isFirst = true;
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					if (!value || value.length === 0) {
						continue;
					}
					const pcm = decoder.push(value);
					if (pcm.length > 0) {
						yield {
							pcm,
							sampleRate: decoder.sampleRate,
							isFirst,
							isLast: false,
						};
						isFirst = false;
					}
				}
			} finally {
				reader.releaseLock();
			}
			// Signal stream end so playback pipelines can flush buffers.
			if (!isFirst) {
				yield {
					pcm: new Float32Array(0),
					sampleRate: decoder.sampleRate,
					isFirst: false,
					isLast: true,
				};
			}
		} catch (error) {
			if (controller.signal.aborted) {
				throw new RequestFailedError(
					`Pocket TTS cloud request timed out after ${this.#timeoutMs}ms`,
					undefined,
					{ cause: error },
				);
			}
			if (error instanceof RequestFailedError) {
				throw error;
			}
			throw new RequestFailedError(
				`Pocket TTS cloud request failed: ${(error as Error).message}`,
				undefined,
				{ cause: error },
			);
		} finally {
			clearTimeout(timer);
			this.#controllers.delete(controller);
		}
	}

	/**
	 * Synthesizes text and returns the complete WAV in one call.
	 *
	 * @param {string} text - The text to synthesize.
	 * @returns {Promise<SynthesisResult>} Full audio plus metadata.
	 * @throws {RequestFailedError} On HTTP, network, or timeout failures.
	 * @example
	 * ```ts
	 * const result = await tts.synthesize("Hello from the cloud.");
	 * await fs.writeFile("out.wav", result.wav);
	 * ```
	 */
	async synthesize(text: string): Promise<SynthesisResult> {
		const parts: Float32Array[] = [];
		for await (const chunk of this.stream(text)) {
			if (chunk.pcm.length > 0) {
				parts.push(chunk.pcm);
			}
		}
		return buildResult(parts, this.mode, this.language);
	}

	/** Aborts in-flight requests. Safe to call multiple times. */
	close(): void {
		this.#closed = true;
		for (const controller of this.#controllers) {
			controller.abort();
		}
		this.#controllers.clear();
	}
}

/**
 * Concatenates chunk PCM into a full {@link SynthesisResult}.
 * Shared by cloud and local runtimes.
 *
 * @internal
 */
export function buildResult(
	parts: Float32Array[],
	mode: "cloud" | "local",
	language: string,
): SynthesisResult {
	let total = 0;
	for (const part of parts) {
		total += part.length;
	}
	const pcm = new Float32Array(total);
	let offset = 0;
	for (const part of parts) {
		pcm.set(part, offset);
		offset += part.length;
	}
	return {
		wav: pcmToWav(pcm, SAMPLE_RATE),
		pcm,
		sampleRate: SAMPLE_RATE,
		durationSec: total / SAMPLE_RATE,
		mode,
		language,
	};
}

/**
 * Validates cloud options and builds a {@link CloudPocketTTS}.
 * Internal — use {@link PocketTTS.load}.
 *
 * @internal
 */
export function createCloudInstance(options: CloudTtsOptions): CloudPocketTTS {
	const language = options.language ?? "english";
	if (!isCloudLanguage(language)) {
		throw new UnknownLanguageError(language, CLOUD_LANGUAGE_LIST, "cloud");
	}
	assertNotCloningRequest(options.voice);
	const voice = options.voice ?? CLOUD_DEFAULT_VOICE[language];
	if (!CLOUD_VOICE_IDS.includes(voice)) {
		throw new UnknownVoiceError(voice, CLOUD_VOICE_IDS);
	}
	return new CloudPocketTTS({ ...options, language, voice });
}
