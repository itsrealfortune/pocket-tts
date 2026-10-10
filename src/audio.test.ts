import { describe, expect, it } from "bun:test";
import {
	int16ToFloat32,
	pcmToWav,
	resamplePcm,
	SAMPLE_RATE,
	WavStreamDecoder,
	wavToPcm,
} from "./audio.js";
import { AudioDecodeError } from "./errors.js";

/** Builds a sine wave for round-trip tests. */
function sine(seconds: number, freq = 440): Float32Array {
	const n = Math.floor(seconds * SAMPLE_RATE);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		out[i] = Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * 0.5;
	}
	return out;
}

describe("pcmToWav / wavToPcm", () => {
	it("round-trips mono audio within int16 precision", () => {
		const pcm = sine(0.5);
		const wav = pcmToWav(pcm);
		expect(wav.subarray(0, 4).toString()).toBe("RIFF");
		expect(wav.subarray(8, 12).toString()).toBe("WAVE");
		expect(wav.readUInt32LE(24)).toBe(SAMPLE_RATE);

		const decoded = wavToPcm(wav);
		expect(decoded.sampleRate).toBe(SAMPLE_RATE);
		expect(decoded.pcm.length).toBe(pcm.length);
		let maxDiff = 0;
		for (let i = 0; i < pcm.length; i++) {
			maxDiff = Math.max(
				maxDiff,
				Math.abs((pcm[i] as number) - (decoded.pcm[i] as number)),
			);
		}
		expect(maxDiff).toBeLessThan(1 / 32000);
	});

	it("downmixes stereo to mono", () => {
		// 2 frames, stereo: L=1.0, R=-1.0 -> average 0
		const data = Buffer.alloc(44 + 8);
		pcmToWav(new Float32Array(0)).copy(data, 0, 0, 44);
		data.writeUInt16LE(2, 22); // channels = 2
		data.writeUInt32LE(4, 28); // byte rate placeholder
		data.writeInt16LE(32767, 44);
		data.writeInt16LE(-32767, 46);
		data.writeInt16LE(32767, 48);
		data.writeInt16LE(-32767, 50);
		data.writeUInt32LE(8, 40); // data size
		const decoded = wavToPcm(data);
		expect(decoded.pcm.length).toBe(2);
		expect(Math.abs(decoded.pcm[0] as number)).toBeLessThan(0.001);
	});

	it("rejects non-WAV buffers", () => {
		expect(() => wavToPcm(Buffer.alloc(10))).toThrow(AudioDecodeError);
	});
});

describe("WavStreamDecoder", () => {
	it("decodes a WAV fed in tiny network chunks", () => {
		const pcm = sine(0.1);
		const wav = pcmToWav(pcm);
		const decoder = new WavStreamDecoder();
		const out: Float32Array[] = [];
		// Feed 7 bytes at a time to stress header/sample boundary handling
		for (let i = 0; i < wav.length; i += 7) {
			const piece = wav.subarray(i, Math.min(i + 7, wav.length));
			const got = decoder.push(new Uint8Array(piece));
			if (got.length > 0) {
				out.push(got);
			}
		}
		expect(decoder.sampleRate).toBe(SAMPLE_RATE);
		let total = 0;
		for (const part of out) {
			total += part.length;
		}
		expect(total).toBe(pcm.length);
		// Spot-check a few samples survived the chunking
		const joined = new Float32Array(total);
		let offset = 0;
		for (const part of out) {
			joined.set(part, offset);
			offset += part.length;
		}
		expect(
			Math.abs((joined[100] as number) - (pcm[100] as number)),
		).toBeLessThan(0.001);
	});

	it("throws on non-RIFF streams", () => {
		const decoder = new WavStreamDecoder();
		expect(() => decoder.push(new Uint8Array(64))).toThrow(AudioDecodeError);
	});
});

describe("resamplePcm", () => {
	it("keeps length proportional to the rate ratio", () => {
		const input = new Float32Array(44100);
		const out = resamplePcm(input, 44100, 24000);
		expect(Math.abs(out.length - 24000)).toBeLessThanOrEqual(1);
	});

	it("returns the same array when rates match", () => {
		const input = new Float32Array([0.1, 0.2]);
		expect(resamplePcm(input, 24000, 24000)).toBe(input);
	});
});

describe("int16ToFloat32", () => {
	it("scales to [-1, 1)", () => {
		const out = int16ToFloat32(new Int16Array([32767, -32768, 0]));
		expect(out[0]).toBeCloseTo(1, 3);
		expect(out[1]).toBe(-1);
		expect(out[2]).toBe(0);
	});
});
