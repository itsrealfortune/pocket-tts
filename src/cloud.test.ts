import { describe, expect, it } from "bun:test";
import { PocketTTS } from "./index.js";
import { CloudModeCloningError, UnknownVoiceError } from "./errors.js";
import { pcmToWav, SAMPLE_RATE } from "./audio.js";

/** Builds a fake streaming WAV Response for hermetic cloud tests. */
function fakeWavResponse(seconds = 0.2, chunkSize = 4096): Response {
	const n = Math.floor(seconds * SAMPLE_RATE);
	const pcm = new Float32Array(n).map((_, i) => Math.sin(i / 100) * 0.4);
	const wav = pcmToWav(pcm);
	// Split into network chunks; ReadableStream of Uint8Array
	let offset = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= wav.length) {
				controller.close();
				return;
			}
			controller.enqueue(
				new Uint8Array(wav.subarray(offset, offset + chunkSize)),
			);
			offset += chunkSize;
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "audio/wav" },
	});
}

/** Records calls and returns a canned response. */
function mockFetch(response: Response | null) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const impl = async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		if (!response) {
			throw new TypeError("network down");
		}
		return response;
	};
	return { calls, impl: impl as unknown as typeof fetch };
}

describe("cloud mode — loading", () => {
	it("loads with defaults (english, default voice)", async () => {
		const { impl } = mockFetch(fakeWavResponse());
		const tts = await PocketTTS.load({
			mode: "cloud",
			fetchImpl: impl,
		});
		expect(tts.mode).toBe("cloud");
		expect(tts.language).toBe("english");
		expect(tts.sampleRate).toBe(24000);
		tts.close();
	});

	it("resolves per-language default voices", async () => {
		const { impl } = mockFetch(fakeWavResponse());
		const tts = await PocketTTS.load({
			mode: "cloud",
			language: "french",
			fetchImpl: impl,
		});
		// CloudPocketTTS exposes the resolved voice
		expect((tts as unknown as { voice: string }).voice).toBe("estelle");
		tts.close();
	});

	it("strips trailing slashes from custom endpoints", async () => {
		const { impl } = mockFetch(fakeWavResponse());
		const tts = await PocketTTS.load({
			mode: "cloud",
			endpoint: "https://my.server///",
			fetchImpl: impl,
		});
		expect((tts as unknown as { endpoint: string }).endpoint).toBe(
			"https://my.server",
		);
		tts.close();
	});

	it("rejects cloning requests in cloud mode", async () => {
		await expect(
			PocketTTS.load({ mode: "cloud", voice: "./my-voice.wav" }),
		).rejects.toThrow(CloudModeCloningError);

		await expect(
			PocketTTS.load({
				mode: "cloud",
				voice: "https://example.com/v.wav",
			}),
		).rejects.toThrow(CloudModeCloningError);

		await expect(
			PocketTTS.load({ mode: "cloud", voice: "hf://kyutai/tts-voices/x.wav" }),
		).rejects.toThrow(CloudModeCloningError);
	});

	it("rejects unknown cloud voices with the catalog in the message", async () => {
		try {
			await PocketTTS.load({ mode: "cloud", voice: "random-voice" });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(UnknownVoiceError);
			expect((error as UnknownVoiceError).available.length).toBe(24);
			expect((error as UnknownVoiceError).message).toContain("jane");
		}
	});

	it("rejects unknown cloud languages", async () => {
		await expect(
			PocketTTS.load({
				mode: "cloud",
				language: "klingon" as never,
			}),
		).rejects.toThrow(/Unknown cloud language/);
	});
});

describe("cloud mode — synthesis", () => {
	it("streams chunks then a final empty marker", async () => {
		const { impl, calls } = mockFetch(fakeWavResponse(0.3, 1024));
		const tts = await PocketTTS.load({ mode: "cloud", fetchImpl: impl });
		const chunks: number[] = [];
		let firsts = 0;
		let lasts = 0;
		for await (const chunk of tts.stream("Hello streaming world.")) {
			chunks.push(chunk.pcm.length);
			if (chunk.isFirst) firsts++;
			if (chunk.isLast) lasts++;
		}
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://pocket-tts-api.kyutai.org/english/tts");
		expect(firsts).toBe(1);
		expect(lasts).toBe(1);
		// ~0.3s of 24kHz audio across multiple chunks
		const total = chunks.reduce((a, b) => a + b, 0);
		expect(total).toBeGreaterThan(SAMPLE_RATE * 0.25);
		expect(total).toBeLessThanOrEqual(SAMPLE_RATE * 0.31);
		tts.close();
	});

	it("sends multipart text + voice_url", async () => {
		const { impl, calls } = mockFetch(fakeWavResponse(0.05));
		const tts = await PocketTTS.load({
			mode: "cloud",
			language: "french",
			voice: "jean",
			fetchImpl: impl,
		});
		for await (const _ of tts.stream("Bonjour.")) {
			// drain
		}
		const body = calls[0]?.init?.body as FormData;
		expect(body).toBeInstanceOf(FormData);
		expect(body.get("text")).toBe("Bonjour.");
		expect(body.get("voice_url")).toBe("jean");
		tts.close();
	});

	it("synthesize() returns a complete WAV", async () => {
		const { impl } = mockFetch(fakeWavResponse(0.2));
		const tts = await PocketTTS.load({ mode: "cloud", fetchImpl: impl });
		const result = await tts.synthesize("Full synthesis test.");
		expect(result.mode).toBe("cloud");
		expect(result.language).toBe("english");
		expect(result.sampleRate).toBe(24000);
		expect(result.wav.subarray(0, 4).toString()).toBe("RIFF");
		expect(result.durationSec).toBeGreaterThan(0.15);
		expect(result.pcm.length).toBeGreaterThan(0);
		tts.close();
	});

	it("rejects empty text", async () => {
		const { impl } = mockFetch(fakeWavResponse());
		const tts = await PocketTTS.load({ mode: "cloud", fetchImpl: impl });
		const iterate = async () => {
			for await (const _ of tts.stream("   ")) {
				// drain
			}
		};
		await expect(iterate()).rejects.toThrow(/empty/);
		tts.close();
	});

	it("wraps HTTP errors with the status code", async () => {
		const { impl } = mockFetch(new Response("nope", { status: 503 }));
		const tts = await PocketTTS.load({ mode: "cloud", fetchImpl: impl });
		await expect(tts.synthesize("Hi.")).rejects.toMatchObject({
			code: "REQUEST_FAILED",
			status: 503,
		});
		tts.close();
	});

	it("wraps network failures", async () => {
		const { impl } = mockFetch(null);
		const tts = await PocketTTS.load({ mode: "cloud", fetchImpl: impl });
		await expect(tts.synthesize("Hi.")).rejects.toMatchObject({
			code: "REQUEST_FAILED",
		});
		tts.close();
	});

	it("close() aborts and blocks further synthesis", async () => {
		const { impl } = mockFetch(fakeWavResponse(0.1));
		const tts = await PocketTTS.load({ mode: "cloud", fetchImpl: impl });
		tts.close();
		await expect(tts.synthesize("Hi.")).rejects.toThrow(/closed/);
		// close is idempotent
		tts.close();
	});
});
