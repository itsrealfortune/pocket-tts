/**
 * PCM/WAV helpers shared by the cloud and local runtimes.
 *
 * Pocket TTS always produces mono 24 kHz float32 audio; the cloud API
 * returns it as a 16-bit PCM WAV stream, the local runtime as float32
 * frames. These helpers convert between the two representations and
 * decode reference audio for voice cloning.
 */

import { AudioDecodeError } from "./errors.js";

/** Sample rate of every Pocket TTS model (fixed by the Mimi codec). */
export const SAMPLE_RATE = 24000;

/**
 * Wraps mono float32 samples into a standard 16-bit PCM WAV buffer.
 *
 * @param {Float32Array} pcm - Mono samples in `[-1, 1]`.
 * @param {number} [sampleRate] - Sample rate. Default: 24000.
 * @returns {Buffer} A complete RIFF/WAVE file.
 * @example
 * ```ts
 * const wav = pcmToWav(new Float32Array([0, 0.5, -0.5, 1]));
 * await fs.writeFile("out.wav", wav);
 * ```
 */
export function pcmToWav(pcm: Float32Array, sampleRate = SAMPLE_RATE): Buffer {
	const dataSize = pcm.length * 2;
	const buffer = Buffer.alloc(44 + dataSize);
	buffer.write("RIFF", 0);
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write("WAVE", 8);
	buffer.write("fmt ", 12);
	buffer.writeUInt32LE(16, 16); // PCM chunk size
	buffer.writeUInt16LE(1, 20); // format: PCM
	buffer.writeUInt16LE(1, 22); // channels: mono
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
	buffer.writeUInt16LE(2, 32); // block align
	buffer.writeUInt16LE(16, 34); // bits per sample
	buffer.write("data", 36);
	buffer.writeUInt32LE(dataSize, 40);
	for (let i = 0; i < pcm.length; i++) {
		const s = Math.max(-1, Math.min(1, pcm[i] as number));
		buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
	}
	return buffer;
}

/**
 * Incremental WAV-PCM16 parser for streaming responses.
 *
 * Feeds arbitrary network chunks and emits decoded float32 frames as soon
 * as enough bytes are available. Handles the 44-byte canonical header as
 * well as split int16 samples across chunk boundaries.
 */
export class WavStreamDecoder {
	#buffer: Uint8Array = new Uint8Array(0);
	#headerDone = false;
	#carry = 0;
	#hasCarry = false;

	/** Sample rate declared in the WAV header (available after the first chunk). */
	sampleRate = SAMPLE_RATE;

	/**
	 * Pushes a network chunk and returns any complete audio frames.
	 *
	 * @param {Uint8Array} chunk - Raw bytes received from the transport.
	 * @returns {Float32Array} Decoded samples (empty until the header is consumed).
	 */
	push(chunk: Uint8Array): Float32Array {
		const merged = new Uint8Array(this.#buffer.length + chunk.length);
		merged.set(this.#buffer, 0);
		merged.set(chunk, this.#buffer.length);
		this.#buffer = merged;

		if (!this.#headerDone) {
			// Walk RIFF chunks until we find "data" (the canonical WAV
			// header is 44 bytes; walking keeps odd headers working).
			const parsed = this.#findDataChunk();
			if (parsed === null) {
				return new Float32Array(0);
			}
			this.#buffer = this.#buffer.subarray(parsed);
			this.#headerDone = true;
		}

		let offset = 0;
		if (this.#hasCarry && this.#buffer.length >= 1) {
			// Complete the int16 sample started by the previous chunk.
			this.#buffer[1] = this.#buffer[0] as number;
			this.#carry |= (this.#buffer[0] as number) << 8;
			offset = 1;
			this.#hasCarry = false;
		}

		const available = this.#buffer.length - offset;
		if (available < 2) {
			if (available === 1) {
				this.#carry = this.#buffer[offset] as number;
				this.#hasCarry = true;
				this.#buffer = new Uint8Array(0);
			}
			return new Float32Array(0);
		}

		const sampleCount = Math.floor(available / 2);
		const out = new Float32Array(sampleCount);
		const view = new DataView(
			this.#buffer.buffer,
			this.#buffer.byteOffset + offset,
			sampleCount * 2,
		);
		for (let i = 0; i < sampleCount; i++) {
			out[i] = view.getInt16(i * 2, true) / 32768;
		}
		// Keep the trailing odd byte (partial sample) for the next push.
		this.#buffer = this.#buffer.subarray(offset + sampleCount * 2);
		return out;
	}

	/**
	 * Returns leftover samples at end of stream (normally none).
	 *
	 * @returns {Float32Array} Any trailing decoded samples.
	 */
	end(): Float32Array {
		return new Float32Array(0);
	}

	#findDataChunk(): number | null {
		const b = this.#buffer;
		if (b.length < 12) {
			return null;
		}
		const riff = String.fromCharCode(
			b[0] as number,
			b[1] as number,
			b[2] as number,
			b[3] as number,
		);
		const wave = String.fromCharCode(
			b[8] as number,
			b[9] as number,
			b[10] as number,
			b[11] as number,
		);
		if (riff !== "RIFF" || wave !== "WAVE") {
			throw new AudioDecodeError(
				"<stream>",
				"response is not a RIFF/WAVE stream",
			);
		}
		let pos = 12;
		const view = new DataView(b.buffer, b.byteOffset, b.length);
		while (pos + 8 <= b.length) {
			const id = String.fromCharCode(
				b[pos] as number,
				b[pos + 1] as number,
				b[pos + 2] as number,
				b[pos + 3] as number,
			);
			const size = view.getUint32(pos + 4, true);
			if (id === "fmt ") {
				// The sample rate lives at offset 12 of the fmt payload;
				// wait for the full chunk before reading it.
				if (pos + 16 > b.length) {
					return null;
				}
				this.sampleRate = view.getUint32(pos + 12, true);
			}
			if (id === "data") {
				if (size === 0xffffffff) {
					// Streaming server that does not know the final size:
					// the payload starts right after the chunk header.
					return pos + 8;
				}
				return pos + 8;
			}
			pos += 8 + size + (size % 2);
		}
		return null;
	}
}

/**
 * Converts 16-bit PCM bytes to float32 samples.
 *
 * @param {Int16Array} samples - Signed 16-bit samples.
 * @returns {Float32Array} Samples scaled to `[-1, 1)`.
 */
export function int16ToFloat32(samples: Int16Array): Float32Array {
	const out = new Float32Array(samples.length);
	for (let i = 0; i < samples.length; i++) {
		out[i] = (samples[i] as number) / 32768;
	}
	return out;
}

/**
 * Decodes a WAV buffer (16-bit PCM, mono or stereo) to mono float32.
 * Stereo input is downmixed by averaging channels.
 *
 * @param {Buffer} wav - Complete RIFF/WAVE file (16-bit PCM).
 * @returns {{ pcm: Float32Array; sampleRate: number }} Decoded audio.
 * @throws {AudioDecodeError} When the buffer is not a supported WAV file.
 */
export function wavToPcm(wav: Buffer): {
	pcm: Float32Array;
	sampleRate: number;
} {
	if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") {
		throw new AudioDecodeError("<buffer>", "not a RIFF/WAVE buffer");
	}
	const channels = wav.readUInt16LE(22);
	const sampleRate = wav.readUInt32LE(24);
	const bits = wav.readUInt16LE(34);
	if (bits !== 16) {
		throw new AudioDecodeError(
			"<buffer>",
			`unsupported bit depth ${bits} (only 16-bit PCM is supported)`,
		);
	}
	// Locate the data chunk (skips LIST/INFO extras).
	let pos = 12;
	let dataOffset = -1;
	let dataSize = 0;
	while (pos + 8 <= wav.length) {
		const id = wav.toString("ascii", pos, pos + 4);
		const size = wav.readUInt32LE(pos + 4);
		if (id === "data") {
			dataOffset = pos + 8;
			dataSize = Math.min(size, wav.length - dataOffset);
			break;
		}
		pos += 8 + size + (size % 2);
	}
	if (dataOffset < 0) {
		throw new AudioDecodeError("<buffer>", "no data chunk found");
	}
	const frames = Math.floor(dataSize / (2 * channels));
	if (channels === 1) {
		const samples = new Int16Array(
			wav.buffer,
			wav.byteOffset + dataOffset,
			frames,
		);
		return { pcm: int16ToFloat32(samples), sampleRate };
	}
	const pcm = new Float32Array(frames);
	for (let f = 0; f < frames; f++) {
		let sum = 0;
		for (let c = 0; c < channels; c++) {
			sum += wav.readInt16LE(dataOffset + (f * channels + c) * 2) / 32768;
		}
		pcm[f] = sum / channels;
	}
	return { pcm, sampleRate };
}

/**
 * Linearly resamples mono float32 audio to a target rate.
 * Good enough for voice-reference preprocessing (the encoder is robust
 * to the small interpolation error; avoids a heavy DSP dependency).
 *
 * @param {Float32Array} pcm - Mono input samples.
 * @param {number} fromRate - Input sample rate.
 * @param {number} toRate - Output sample rate.
 * @returns {Float32Array} Resampled audio.
 */
export function resamplePcm(
	pcm: Float32Array,
	fromRate: number,
	toRate: number,
): Float32Array {
	if (fromRate === toRate) {
		return pcm;
	}
	const ratio = fromRate / toRate;
	const outLength = Math.floor(pcm.length / ratio);
	const out = new Float32Array(outLength);
	for (let i = 0; i < outLength; i++) {
		const src = i * ratio;
		const lo = Math.floor(src);
		const hi = Math.min(lo + 1, pcm.length - 1);
		const t = src - lo;
		out[i] = (pcm[lo] as number) * (1 - t) + (pcm[hi] as number) * t;
	}
	return out;
}
