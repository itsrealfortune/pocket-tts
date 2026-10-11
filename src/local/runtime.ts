/**
 * Local mode: ONNX runtime for Pocket TTS with zero-shot voice cloning.
 *
 * Port of the reference stateful web runtime (KevinAHM/pocket-tts-web
 * `inference-worker.js`), validated end-to-end in the tts-universal
 * benchmark. Inference is frame-by-frame: a flow-matching LM with
 * explicit KV-cache states (72 state tensors), Euler integration of the
 * flow (1 step by default), and a streaming Mimi decoder (56 conv
 * states). The first audio chunk is emitted after 3 frames (~240 ms of
 * audio); chunks of 12 frames follow.
 *
 * Voice cloning is zero-shot: reference audio is encoded once by the
 * Mimi encoder into a speaker embedding, then a prefill pass conditions
 * the flow LM's KV caches. No training, ~3-8 s one-shot on a laptop CPU.
 */

import * as fs from "node:fs";
import { SAMPLE_RATE, resamplePcm, wavToPcm } from "../audio.js";
import { buildResult } from "../cloud.js";
import { AudioDecodeError, InvalidOptionError } from "../errors.js";
import type {
	AudioChunk,
	LocalTtsOptions,
	PcmReference,
	PocketTTSInstance,
	SynthesisResult,
} from "../types.js";
import { isLocalLanguage } from "../voices.js";
import {
	type BundlePaths,
	ensureBundle,
	type SentencePieceLike,
} from "./bundle.js";

/** Structural type for onnxruntime-node (lazy-loaded, kept minimal). */
interface OrtTensor {
	data: ArrayLike<number> | BigInt64Array;
	dims: number[];
}
interface OrtSession {
	run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
	outputNames: string[];
}
interface OrtModule {
	InferenceSession: {
		create(path: string, options?: unknown): Promise<OrtSession>;
	};
	Tensor: new (type: string, data: unknown, dims: number[]) => OrtTensor;
}

/** The five ONNX sessions backing a local instance. */
interface LocalSessions {
	flowLmMain: OrtSession;
	flowLmFlow: OrtSession;
	mimiDecoder: OrtSession;
	mimiEncoder: OrtSession;
	textConditioner: OrtSession;
}

/** One entry of a bundle state manifest (explicit tensor states). */
interface StateEntry {
	input_name: string;
	output_name: string;
	dtype: "float32" | "int64" | "bool";
	fill: "nan" | "ones" | "zeros" | "empty";
	shape: number[];
}

/** Raw speaker embedding extracted from reference audio. */
export interface SpeakerEmbedding {
	/** Embedding samples (frames × conditioning dim). */
	data: Float32Array;
	/** Tensor shape, e.g. `[1, frames, 1024]`. */
	shape: number[];
}

/** Reference voice prepared for synthesis (cached conditioned state). */
export interface PreparedVoice {
	/** The speaker embedding produced by the Mimi encoder. */
	embedding: SpeakerEmbedding;
	/** Latency of the encode + prefill, in milliseconds. */
	prepMs: number;
}

const MAX_FRAMES = 500;

/** BigInt cache for small token ids (avoids per-call BigInt allocation). */
const BIGINT_CACHE: bigint[] = [];
for (let i = 0; i < 1024; i++) {
	BIGINT_CACHE[i] = BigInt(i);
}

function toBig(value: number): bigint {
	return BIGINT_CACHE[value] ?? BigInt(value);
}

/** Converts token ids to a BigInt64Array using the cache. */
function buildTokenIds(tokenIds: number[]): BigInt64Array {
	const out = new BigInt64Array(tokenIds.length);
	for (let i = 0; i < tokenIds.length; i++) {
		out[i] = toBig(tokenIds[i] as number);
	}
	return out;
}
const EOS_THRESHOLD = -4.0;
const CHUNK_GAP_SEC = 0.25;
const FIRST_CHUNK_FRAMES = 3;
const NORMAL_CHUNK_FRAMES = 12;

/** Creates the initial value of one state tensor (per the manifest fill). */
function makeStateData(
	dtype: StateEntry["dtype"],
	fill: StateEntry["fill"],
	size: number,
): ArrayLike<number> | BigInt64Array {
	if (dtype === "int64") {
		return new BigInt64Array(size);
	}
	if (dtype === "bool") {
		const data = new Uint8Array(size);
		if (fill === "ones") {
			data.fill(1);
		}
		return data;
	}
	const data = new Float32Array(size);
	if (fill === "nan") {
		data.fill(NaN);
	} else if (fill === "ones") {
		data.fill(1);
	}
	return data;
}

/**
 * Builds the initial state as real ORT tensors — ORT rejects plain
 * `{ data, dims }` objects ("Tensor.location must be a string").
 */
function initState(
	manifest: StateEntry[],
	tensor: (type: string, data: unknown, dims: number[]) => OrtTensor,
): Record<string, OrtTensor> {
	const state: Record<string, OrtTensor> = {};
	for (const entry of manifest) {
		const size = entry.shape.reduce((a, b) => a * b, 1);
		state[entry.input_name] = tensor(
			entry.dtype,
			makeStateData(entry.dtype, entry.fill, size),
			entry.shape,
		);
	}
	return state;
}

function updateState(
	state: Record<string, OrtTensor>,
	result: Record<string, OrtTensor>,
	manifest: StateEntry[],
): void {
	for (const entry of manifest) {
		const value = result[entry.output_name];
		if (value) {
			state[entry.input_name] = value;
		}
	}
}

/** Parses a float32 `.npy` buffer (the BOS voice marker format). */
function parseNpyFloat32(buffer: Buffer): {
	data: Float32Array;
	shape: number[];
} {
	if (buffer.length < 10 || buffer[0] !== 0x93 || buffer[1] !== 0x4e) {
		throw new AudioDecodeError("<npy>", "invalid NPY file");
	}
	const major = buffer[6] as number;
	const headerLen =
		major === 1 ? buffer.readUInt16LE(8) : buffer.readUInt32LE(8);
	const headerOffset = major === 1 ? 10 : 12;
	const headerText = buffer
		.subarray(headerOffset, headerOffset + headerLen)
		.toString("latin1");
	const match = headerText.match(/\(\s*([0-9,\s]+)\)/);
	if (!match?.[1]) {
		throw new AudioDecodeError("<npy>", "cannot parse NPY shape");
	}
	const shape = match[1]
		.split(",")
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => Number.parseInt(p, 10));
	const dataOffset = headerOffset + headerLen;
	const data = new Float32Array(
		buffer.buffer.slice(
			buffer.byteOffset + dataOffset,
			buffer.byteOffset + buffer.length,
		),
	);
	return { data, shape };
}

/** Sentence splitter mirroring the reference runtime. */
const SENTENCE_SPLIT_RE = /[^.!?]+[.!?]+|[^.!?]+$/g;

/** One text chunk ready for the flow LM, plus EOS padding frames. */
interface TextChunk {
	chunk: string;
	framesAfterEos: number;
}

/**
 * Local Pocket TTS instance (offline, zero-shot voice cloning).
 *
 * Create one with {@link PocketTTS.load} using `mode: "local"`.
 */
export class LocalPocketTTS implements PocketTTSInstance {
	/** Always `"local"` for this implementation. */
	readonly mode = "local" as const;
	/** Sample rate of all produced audio (24000). */
	readonly sampleRate = SAMPLE_RATE;
	/** Bundle id used for synthesis (for example `"french_24l"`). */
	readonly language: string;
	/** Paths of the loaded bundle (models, tokenizer, metadata). */
	readonly bundle: BundlePaths;

	readonly #ort: OrtModule;
	readonly #sessions: LocalSessions;
	readonly #tokenizer: SentencePieceLike;
	readonly #meta: {
		latentDim: number;
		conditioningDim: number;
		maxTokenPerChunk: number;
		samplesPerFrame: number;
		flowManifest: StateEntry[];
		mimiManifest: StateEntry[];
		insertBosBeforeVoice: boolean;
		removeSemicolons: boolean;
		framesAfterEos: number;
	};
	readonly #bosBeforeVoice: SpeakerEmbedding | null = null;
	readonly #temperature: number;
	readonly #lsdSteps: number;
	#voiceState: Record<string, OrtTensor> | null = null;
	#voiceEmbedding: Float32Array | null = null;
	#closed = false;

	/** Creates an ONNX tensor (thin wrapper over `new ort.Tensor(...)`). */
	#tensor(type: string, data: unknown, dims: number[]): OrtTensor {
		return new this.#ort.Tensor(type, data, dims);
	}

	/**
	 * Use {@link PocketTTS.load} instead of constructing directly.
	 *
	 * @internal
	 */
	constructor(
		ort: OrtModule,
		sessions: LocalSessions,
		bundle: BundlePaths,
		language: string,
		options: { temperature: number; lsdSteps: number },
	) {
		this.#ort = ort;
		this.#sessions = sessions;
		this.bundle = bundle;
		this.language = language;
		this.#tokenizer = bundle.tokenizer;
		this.#temperature = options.temperature;
		this.#lsdSteps = options.lsdSteps;

		const meta = bundle.metadata;
		this.#meta = {
			latentDim: Number(meta.latent_dim ?? 32),
			conditioningDim: Number(meta.conditioning_dim ?? 1024),
			maxTokenPerChunk: Number(meta.max_token_per_chunk ?? 50),
			samplesPerFrame: Number(meta.samples_per_frame ?? 1920),
			flowManifest: (meta.flow_lm_state_manifest ?? []) as StateEntry[],
			mimiManifest: (meta.mimi_state_manifest ?? []) as StateEntry[],
			insertBosBeforeVoice: meta.insert_bos_before_voice === true,
			removeSemicolons: meta.remove_semicolons === true,
			framesAfterEos: Number(meta.model_recommended_frames_after_eos ?? 8),
		};
		this.#bosBeforeVoice = meta.bos_before_voice_file
			? parseNpyFloat32(fs.readFileSync(bundle.bosPath))
			: null;
	}

	/**
	 * Loads a local bundle (downloading it on first use) and creates all
	 * ONNX sessions. The voice is prepared separately via
	 * {@link LocalPocketTTS.prepareVoice}.
	 *
	 * @param {LocalTtsOptions} options - Local mode options.
	 * @returns {Promise<LocalPocketTTS>} A ready (voiceless) instance.
	 * @throws {BundleDownloadError} When the bundle cannot be fetched.
	 * @internal
	 */
	static async load(
		options: LocalTtsOptions & { language: string },
	): Promise<LocalPocketTTS> {
		const ort = await loadOrt();
		const { defaultCacheDir } = await import("./bundle.js");
		const cacheDir = options.cacheDir ?? defaultCacheDir();
		const bundle = await ensureBundle(
			options.language,
			cacheDir,
			options.fetchImpl,
		);

		const sessionOptions: Record<string, unknown> = {
			executionProviders: ["cpu"],
			graphOptimizationLevel: "all",
		};
		if (options.numThreads !== undefined) {
			sessionOptions.intraOpNumThreads = options.numThreads;
		}
		if (options.lowMemory) {
			sessionOptions.enableCpuMemArena = false;
			sessionOptions.enableMemPattern = false;
		}
		const [flowLmMain, flowLmFlow, mimiDecoder, mimiEncoder, textConditioner] =
			await Promise.all([
				ort.InferenceSession.create(bundle.models.flowLmMain, sessionOptions),
				ort.InferenceSession.create(bundle.models.flowLmFlow, sessionOptions),
				ort.InferenceSession.create(bundle.models.mimiDecoder, sessionOptions),
				ort.InferenceSession.create(bundle.models.mimiEncoder, sessionOptions),
				ort.InferenceSession.create(
					bundle.models.textConditioner,
					sessionOptions,
				),
			]);

		return new LocalPocketTTS(
			ort,
			{ flowLmMain, flowLmFlow, mimiDecoder, mimiEncoder, textConditioner },
			bundle,
			options.language,
			{
				temperature: options.temperature ?? 0.7,
				lsdSteps: options.lsdSteps ?? 1,
			},
		);
	}

	/**
	 * Encodes reference audio into a speaker embedding (zero-shot cloning).
	 *
	 * Accepts a WAV file path, raw float32 samples at any rate (resampled
	 * to 24 kHz), or a {@link PcmReference} pair. 1-30 s of clean speech
	 * works best. The result can be reused across many synthesize calls.
	 *
	 * @param {string | Float32Array | PcmReference} voice - Voice reference source.
	 * @returns {Promise<PreparedVoice>} The embedding plus preparation timing.
	 * @throws {AudioDecodeError} When the reference cannot be decoded.
	 * @example
	 * ```ts
	 * const prepared = await tts.prepareVoice("./my-voice.wav");
	 * console.log(`voice prepared in ${prepared.prepMs}ms`);
	 * ```
	 */
	async prepareVoice(
		voice: string | Float32Array | PcmReference,
	): Promise<PreparedVoice> {
		const start = performance.now();
		let pcm: Float32Array;
		if (typeof voice === "string") {
			let bytes: Buffer;
			try {
				bytes = fs.readFileSync(voice);
			} catch (error) {
				throw new AudioDecodeError(voice, (error as Error).message, {
					cause: error,
				});
			}
			const decoded = wavToPcm(bytes);
			pcm = resamplePcm(decoded.pcm, decoded.sampleRate, SAMPLE_RATE);
		} else if (voice instanceof Float32Array) {
			pcm = voice;
		} else {
			pcm = resamplePcm(voice.pcm, voice.sampleRate, SAMPLE_RATE);
		}
		if (pcm.length === 0) {
			throw new AudioDecodeError("<voice>", "reference audio is empty");
		}

		// Mimi encoder: audio -> speaker embedding
		const encoderInput = this.#tensor("float32", pcm, [1, 1, pcm.length]);
		const encResult = await this.#sessions.mimiEncoder.run({
			audio: encoderInput,
		});
		const encOut =
			encResult[this.#sessions.mimiEncoder.outputNames[0] as string];
		if (!encOut) {
			throw new AudioDecodeError("<voice>", "encoder produced no output");
		}
		let dims = [...encOut.dims];
		while (dims.length > 3 && dims[0] === 1) {
			dims = dims.slice(1);
		}
		if (dims.length < 3) {
			dims = [1, dims[0] as number, dims[1] as number];
		}
		// ORT float32 outputs are already Float32Array — reuse, no copy.
		const embedding =
			encOut.data instanceof Float32Array
				? encOut.data
				: new Float32Array(encOut.data as ArrayLike<number>);

		// Flow LM prefill: condition the KV caches on the speaker embedding
		// (optionally prefixed with the BOS marker).
		const flowState = initState(this.#meta.flowManifest, (t, d, s) =>
			this.#tensor(t, d, s),
		);
		let voiceData = embedding;
		let voiceDims = dims;
		if (this.#meta.insertBosBeforeVoice && this.#bosBeforeVoice) {
			const bos = this.#bosBeforeVoice.data;
			const combined = new Float32Array(bos.length + embedding.length);
			combined.set(bos, 0);
			combined.set(embedding, bos.length);
			voiceData = combined;
			// The BOS marker adds frames along the time axis: use its shape
			// (e.g. [1, 1, 1024]), not the raw float count.
			const bosFrames = this.#bosBeforeVoice.shape[1] ?? 1;
			voiceDims = [
				1,
				(voiceDims[1] as number) + bosFrames,
				voiceDims[2] as number,
			];
		}
		const prefill = await this.#sessions.flowLmMain.run({
			sequence: this.#tensor("float32", new Float32Array(0), [
				1,
				0,
				this.#meta.latentDim,
			]),
			text_embeddings: this.#tensor("float32", voiceData, voiceDims),
			...flowState,
		});
		updateState(flowState, prefill, this.#meta.flowManifest);
		this.#voiceState = flowState;
		this.#voiceEmbedding = embedding;

		return {
			embedding: { data: embedding, shape: dims },
			prepMs: performance.now() - start,
		};
	}

	/** Prepares text the same way the reference runtime does. */
	#prepareText(text: string): TextChunk {
		let prompt = text.trim();
		if (!prompt) {
			return { chunk: "", framesAfterEos: 1 };
		}
		prompt = prompt
			.replace(/\r/g, " ")
			.replace(/\n/g, " ")
			.replace(/\s+/g, " ");
		if (this.#meta.removeSemicolons) {
			prompt = prompt.replace(/;/g, ",");
		}
		if (prompt && !/[A-ZÀ-Þ]/.test(prompt[0] as string)) {
			prompt = (prompt[0] as string).toUpperCase() + prompt.slice(1);
		}
		if (prompt && /[0-9A-Za-zÀ-ÿ]/.test(prompt[prompt.length - 1] as string)) {
			prompt += ".";
		}
		return {
			chunk: prompt,
			framesAfterEos: this.#meta.framesAfterEos,
		};
	}

	/** Splits prepared text into token-limited chunks (sentences first). */
	#splitChunks(text: string): TextChunk[] {
		const prepared = this.#prepareText(text);
		if (!prepared.chunk) {
			return [];
		}
		const sentences = prepared.chunk.match(SENTENCE_SPLIT_RE) ?? [];
		const trimmed = sentences.map((s) => s.trim()).filter(Boolean);
		if (trimmed.length === 0) {
			return [
				{ chunk: prepared.chunk, framesAfterEos: prepared.framesAfterEos },
			];
		}
		const maxTokens = this.#meta.maxTokenPerChunk;
		const chunks: TextChunk[] = [];
		let current = "";
		for (const sentence of trimmed) {
			const ids = this.#tokenizer.encodeIds(sentence);
			if (ids.length > maxTokens) {
				if (current) {
					chunks.push({
						chunk: current.trim(),
						framesAfterEos: prepared.framesAfterEos,
					});
					current = "";
				}
				for (let i = 0; i < ids.length; i += maxTokens) {
					const piece = this.#tokenizer
						.decodeIds(ids.slice(i, i + maxTokens))
						.trim();
					if (piece) {
						chunks.push({
							chunk: piece,
							framesAfterEos: prepared.framesAfterEos,
						});
					}
				}
				continue;
			}
			if (!current) {
				current = sentence;
				continue;
			}
			const combined = `${current} ${sentence}`;
			if (this.#tokenizer.encodeIds(combined).length > maxTokens) {
				chunks.push({
					chunk: current.trim(),
					framesAfterEos: prepared.framesAfterEos,
				});
				current = sentence;
			} else {
				current = combined;
			}
		}
		if (current) {
			chunks.push({
				chunk: current.trim(),
				framesAfterEos: prepared.framesAfterEos,
			});
		}
		return chunks;
	}

	/**
	 * Synthesizes text, streaming decoded audio chunks.
	 *
	 * The first chunk is emitted after ~240 ms of generated audio
	 * (3 frames); subsequent chunks hold 12 frames (~960 ms). A 0.25 s
	 * silence gap is inserted between text chunks, mirroring the
	 * reference runtime.
	 *
	 * @param {string} text - The text to synthesize.
	 * @returns {AsyncGenerator<AudioChunk>} Decoded 24 kHz chunks in order.
	 * @throws {InvalidOptionError} When no voice has been prepared.
	 * @example
	 * ```ts
	 * await tts.prepareVoice("./my-voice.wav");
	 * for await (const chunk of tts.stream("Bonjour, c'est cloné !")) {
	 *   player.enqueue(chunk.pcm);
	 * }
	 * ```
	 */
	async *stream(text: string): AsyncGenerator<AudioChunk> {
		if (this.#closed) {
			throw new InvalidOptionError("Instance is closed.");
		}
		if (!this.#voiceState || !this.#voiceEmbedding) {
			throw new InvalidOptionError(
				"No voice prepared. Call prepareVoice() before synthesizing in local mode.",
			);
		}
		const textChunks = this.#splitChunks(text);
		if (textChunks.length === 0) {
			throw new InvalidOptionError("text must not be empty");
		}

		const lat = this.#meta.latentDim;
		const condDim = this.#meta.conditioningDim;
		const emptySeq = this.#tensor("float32", new Float32Array(0), [1, 0, lat]);
		const emptyText = this.#tensor("float32", new Float32Array(0), [
			1,
			0,
			condDim,
		]);
		// Precomputed Euler grid (s, t) for the flow sampler.
		const stGrid: { s: OrtTensor; t: OrtTensor }[] = [];
		{
			const dt = 1 / this.#lsdSteps;
			for (let step = 0; step < this.#lsdSteps; step++) {
				const s = step / this.#lsdSteps;
				stGrid.push({
					s: this.#tensor("float32", new Float32Array([s]), [1, 1]),
					t: this.#tensor("float32", new Float32Array([s + dt]), [1, 1]),
				});
			}
		}

		let mimiState = initState(this.#meta.mimiManifest, (t, d, s) =>
			this.#tensor(t, d, s),
		);
		let flowState: Record<string, OrtTensor> = { ...this.#voiceState };
		let isFirst = true;
		const std = Math.sqrt(this.#temperature);

		for (let chunkIdx = 0; chunkIdx < textChunks.length; chunkIdx++) {
			// Reset per-chunk states (matches the reference runtime) so
			// each text chunk starts from the same speaker conditioning.
			if (chunkIdx > 0) {
				flowState = { ...this.#voiceState };
				mimiState = initState(this.#meta.mimiManifest, (t, d, s) =>
					this.#tensor(t, d, s),
				);
			}
			const { chunk, framesAfterEos } = textChunks[chunkIdx] as TextChunk;

			const tokenIds = this.#tokenizer.encodeIds(chunk);
			let textEmb = (
				await this.#sessions.textConditioner.run({
					token_ids: this.#tensor(
						"int64",
						buildTokenIds(tokenIds),
						[1, tokenIds.length],
					),
				})
			)[this.#sessions.textConditioner.outputNames[0] as string] as OrtTensor;
			if (textEmb.dims.length === 2) {
				const embData =
					textEmb.data instanceof Float32Array
						? textEmb.data
						: new Float32Array(textEmb.data as ArrayLike<number>);
				textEmb = this.#tensor("float32", embData, [
					1,
					textEmb.dims[0] as number,
					textEmb.dims[1] as number,
				]);
			}

			const condResult = await this.#sessions.flowLmMain.run({
				sequence: emptySeq,
				text_embeddings: textEmb,
				...flowState,
			});
			updateState(flowState, condResult, this.#meta.flowManifest);

			const frameLatents: Float32Array[] = [];
			let decodedFrames = 0;
			let currentLatent = this.#tensor(
				"float32",
				new Float32Array(lat).fill(NaN),
				[1, 1, lat],
			);
			let eosStep: number | null = null;

			for (let step = 0; step < MAX_FRAMES; step++) {
				const arResult = await this.#sessions.flowLmMain.run({
					sequence: currentLatent,
					text_embeddings: emptyText,
					...flowState,
				});
				const conditioning = arResult.conditioning as OrtTensor;
				const eosLogit = (arResult.eos_logit as OrtTensor).data[0] as number;
				if (eosLogit > EOS_THRESHOLD && eosStep === null) {
					eosStep = step;
				}
				const shouldStop = eosStep !== null && step >= eosStep + framesAfterEos;

				// Gaussian latent sample (temperature-scaled)
				const latentData = new Float32Array(lat);
				for (let i = 0; i < lat; i++) {
					let u = 0;
					let v = 0;
					while (u === 0) u = Math.random();
					while (v === 0) v = Math.random();
					latentData[i] =
						Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * std;
				}

				// Euler integration of the probability flow
				const dt = 1 / this.#lsdSteps;
				for (let lsd = 0; lsd < this.#lsdSteps; lsd++) {
					const grid = stGrid[lsd] as { s: OrtTensor; t: OrtTensor };
					const flowResult = await this.#sessions.flowLmFlow.run({
						c: conditioning,
						s: grid.s,
						t: grid.t,
						x: this.#tensor("float32", latentData, [1, lat]),
					});
					const dir = (flowResult.flow_dir as OrtTensor).data;
					for (let i = 0; i < lat; i++) {
						latentData[i] = (latentData[i] as number) + (dir[i] as number) * dt;
					}
				}

				frameLatents.push(new Float32Array(latentData));
				currentLatent = this.#tensor("float32", latentData, [1, 1, lat]);
				updateState(flowState, arResult, this.#meta.flowManifest);

				// Decode in batches (first chunk smaller for low latency)
				const pending = frameLatents.length - decodedFrames;
				let decodeSize = 0;
				if (shouldStop) {
					decodeSize = pending;
				} else if (isFirst && pending >= FIRST_CHUNK_FRAMES) {
					decodeSize = FIRST_CHUNK_FRAMES;
				} else if (pending >= NORMAL_CHUNK_FRAMES) {
					decodeSize = NORMAL_CHUNK_FRAMES;
				}

				if (decodeSize > 0) {
					const decodeLatents = new Float32Array(decodeSize * lat);
					for (let f = 0; f < decodeSize; f++) {
						decodeLatents.set(
							frameLatents[decodedFrames + f] as Float32Array,
							f * lat,
						);
					}
					const decodeResult = await this.#sessions.mimiDecoder.run({
						latent: this.#tensor("float32", decodeLatents, [
							1,
							decodeSize,
							lat,
						]),
						...mimiState,
					});
					updateState(mimiState, decodeResult, this.#meta.mimiManifest);
					decodedFrames += decodeSize;
					const audioOut = decodeResult[
						this.#sessions.mimiDecoder.outputNames[0] as string
					] as OrtTensor;
					// Reuse the ORT output buffer (fresh per run, safe to yield).
					const pcm =
						audioOut.data instanceof Float32Array
							? audioOut.data
							: new Float32Array(audioOut.data as ArrayLike<number>);
					const isLast = shouldStop && chunkIdx === textChunks.length - 1;
					yield { pcm, sampleRate: SAMPLE_RATE, isFirst, isLast };
					isFirst = false;
				}

				if (shouldStop) {
					break;
				}
			}

			// Silence gap between text chunks (reference behavior)
			if (chunkIdx < textChunks.length - 1) {
				const gap = Math.max(1, Math.floor(CHUNK_GAP_SEC * SAMPLE_RATE));
				yield {
					pcm: new Float32Array(gap),
					sampleRate: SAMPLE_RATE,
					isFirst: false,
					isLast: false,
				};
			}
		}
	}

	/**
	 * Synthesizes text and returns the complete WAV in one call.
	 *
	 * @param {string} text - The text to synthesize.
	 * @returns {Promise<SynthesisResult>} Full audio plus metadata.
	 * @throws {InvalidOptionError} When no voice has been prepared.
	 * @example
	 * ```ts
	 * const result = await tts.synthesize("Hello cloned voice.");
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

	/** Releases ONNX sessions. Safe to call multiple times. */
	close(): void {
		this.#closed = true;
		const maybe = this.#sessions as unknown as Record<
			string,
			{ close?: () => Promise<void> } | undefined
		>;
		for (const session of Object.values(maybe)) {
			if (session && typeof session.close === "function") {
				void session.close().catch(() => {});
			}
		}
	}
}

/** Lazily loads onnxruntime-node with a helpful error. */
async function loadOrt(): Promise<OrtModule> {
	try {
		const mod = (await import("onnxruntime-node")) as unknown as {
			default?: OrtModule;
		} & OrtModule;
		return mod.default ?? mod;
	} catch (error) {
		throw new InvalidOptionError(
			`Local mode requires "onnxruntime-node" (npm install onnxruntime-node). Loading it failed: ${(error as Error).message}`,
		);
	}
}

/**
 * Validates local options and builds a {@link LocalPocketTTS}.
 * Internal — use {@link PocketTTS.load}.
 *
 * @internal
 */
export async function createLocalInstance(
	options: LocalTtsOptions,
): Promise<LocalPocketTTS> {
	const language = options.language ?? "english_2026-04";
	if (!isLocalLanguage(language)) {
		throw new InvalidOptionError(
			`Unknown local language "${language}". See listLocalLanguages().`,
		);
	}
	if (options.voice === undefined || options.voice === null) {
		throw new InvalidOptionError(
			"Local mode requires a voice reference (WAV path, Float32Array, or { pcm, sampleRate }).",
		);
	}
	const tts = await LocalPocketTTS.load({ ...options, language });
	await tts.prepareVoice(options.voice);
	return tts;
}
