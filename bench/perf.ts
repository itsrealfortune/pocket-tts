/**
 * Performance benchmark for pocket-tts hot paths.
 * Run: npx tsx bench/perf.ts
 * Saves JSON to results/perf.json for before/after comparison.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	pcmToWav,
	resamplePcm,
	SAMPLE_RATE,
	WavStreamDecoder,
	wavToPcm,
} from "../src/audio.ts";
import { ensureBundle } from "../src/local/bundle.ts";
import { PocketTTS } from "../src/index.ts";

const SEC = 30;
const N = SEC * SAMPLE_RATE;

function med(a: number[]): number {
	const s = [...a].sort((x, y) => x - y);
	return s[Math.floor(s.length / 2)] as number;
}

function makeSine(seconds: number): Float32Array {
	const out = new Float32Array(seconds * SAMPLE_RATE);
	for (let i = 0; i < out.length; i++) {
		out[i] = Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * 0.5;
	}
	return out;
}

function bench(name: string, fn: () => void, runs = 7): number {
	fn(); // warm
	const times: number[] = [];
	for (let i = 0; i < runs; i++) {
		const t = performance.now();
		fn();
		times.push(performance.now() - t);
	}
	const m = med(times);
	console.log(`${name.padEnd(42)} ${m.toFixed(1)}ms`);
	return m;
}

const results: Record<string, number> = {};
const pcm = makeSine(SEC);

console.log(`=== pocket-tts perf (cpu: ${os.cpus()[0]?.model}) ===\n`);

// 1. WAV encode/decode
results.wavEncode30s = bench("pcmToWav (30s audio)", () => {
	pcmToWav(pcm);
});
const wav = pcmToWav(pcm);
results.wavDecode30s = bench("wavToPcm mono (30s)", () => {
	wavToPcm(wav);
});

// stereo decode: duplicate mono into interleaved stereo
const stereo = Buffer.alloc(44 + N * 4);
wav.copy(stereo, 0, 0, 44);
stereo.writeUInt16LE(2, 22);
stereo.writeUInt32LE(SAMPLE_RATE * 4, 28);
const s16 = new Int16Array(wav.buffer, wav.byteOffset + 44, N);
const ds16 = new Int16Array(stereo.buffer, stereo.byteOffset + 44, N * 2);
for (let i = 0; i < N; i++) {
	ds16[i * 2] = s16[i] as number;
	ds16[i * 2 + 1] = s16[i] as number;
}
results.wavDecodeStereo30s = bench("wavToPcm stereo (30s)", () => {
	wavToPcm(stereo);
});

// 2. Streaming decoder: 30s WAV in network chunks
for (const chunkSize of [4096, 65536]) {
	const name = `WavStreamDecoder (30s, ${chunkSize / 1024}KB chunks)`;
	results[`decoder${chunkSize}`] = bench(name, () => {
		const dec = new WavStreamDecoder();
		let total = 0;
		for (let i = 0; i < wav.length; i += chunkSize) {
			total += dec.push(wav.subarray(i, i + chunkSize)).length;
		}
		if (total !== N) throw new Error(`got ${total}`);
	});
}

// 3. Resample
const in44k = makeSine(5);
results.resample44to24 = bench("resamplePcm 44.1k->24k (5s)", () => {
	resamplePcm(in44k, 44100, SAMPLE_RATE);
});

// 4. ensureBundle with mock fetch (80ms latency, ~450MB worth of small stubs
//    scaled to 3 files x 2MB to keep the bench fast)
const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), "pocket-bench-"));
const MOCK_LATENCY_MS = 80;
const MOCK_SIZE = 2 * 1024 * 1024;
const mockPayload = new Uint8Array(MOCK_SIZE);
const mockFetch = (async (url: string) => {
	await new Promise((r) => setTimeout(r, MOCK_LATENCY_MS));
	const name = url.split("/").pop() ?? "file";
	let body: Uint8Array | string = mockPayload;
	if (name === "bundle.json") body = JSON.stringify({ latent_dim: 32 });
	if (name === "tokenizer.model") {
		body = fs.readFileSync(
			path.join(os.homedir(), ".cache/pocket-tts/bundles/french_24l/tokenizer.model"),
		);
	}
	if (name === "sentencepiece.js") {
		body = fs.readFileSync(
			path.join(os.homedir(), ".cache/pocket-tts/sentencepiece.js"),
		);
	}
	return new Response(body as BodyInit, { status: 200 });
}) as unknown as typeof fetch;

// async bench handled manually below
{
	const runs: number[] = [];
	for (let i = 0; i < 3; i++) {
		const dir = path.join(tmpCache, `run${i}`);
		const t = performance.now();
		try {
			await ensureBundle("french_24l", dir, mockFetch);
		} catch {
			// tokenizer.model in mock may fail to load WASM at this stage is fine for timing downloads
		}
		runs.push(performance.now() - t);
	}
	results.bundleDownload = med(runs);
	console.log(
		`${"ensureBundle (8 files @80ms, mock)".padEnd(42)} ${results.bundleDownload.toFixed(1)}ms`,
	);
}
fs.rmSync(tmpCache, { recursive: true, force: true });

// 5. Local runtime end-to-end (real french_24l bundle, real voice)
const REF = path.join(os.homedir(), "tts-universal/voices/fortune-ref-24k.wav");
if (fs.existsSync(REF)) {
	const LONG_TEXT = Array.from(
		{ length: 6 },
		(_, i) =>
			`Phrase numéro ${i + 1} avec un texte suffisamment long pour forcer plusieurs chunks de tokenisation et mesurer le coût réel du runtime local.`,
	).join(" ");

	const runs: { wall: number; samples: number }[] = [];
	let tts: Awaited<ReturnType<typeof PocketTTS.load>> | null = null;
	try {
		tts = await PocketTTS.load({
			mode: "local",
			language: "french_24l",
			voice: REF,
			lowMemory: true,
			numThreads: 2,
		});
		await tts.synthesize("Échauffement."); // warm
		for (let i = 0; i < 2; i++) {
			const t = performance.now();
			const r = await tts.synthesize(LONG_TEXT);
			runs.push({ wall: performance.now() - t, samples: r.pcm.length });
		}
		const walls = runs.map((r) => r.wall);
		const audioSec = (runs[0]?.samples ?? 0) / SAMPLE_RATE;
		results.localE2EWall = med(walls);
		results.localE2ERtf = audioSec / (med(walls) / 1000);
		console.log(
			`${"local synthesize (6 phrases, fr_24l)".padEnd(42)} ${results.localE2EWall.toFixed(0)}ms (RTF ${results.localE2ERtf.toFixed(2)}x)`,
		);
	} catch (error) {
		console.log(`local E2E skipped: ${(error as Error).message.slice(0, 80)}`);
	} finally {
		tts?.close();
	}
} else {
	console.log("local E2E skipped: no reference voice");
}

console.log("\n=== summary (JSON) ===");
console.log(JSON.stringify(results, null, 1));
fs.mkdirSync("results", { recursive: true });
fs.writeFileSync("results/perf.json", JSON.stringify(results, null, 2));
