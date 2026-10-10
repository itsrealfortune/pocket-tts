/**
 * Local mode example: zero-shot voice cloning, fully offline.
 *
 * The model bundle (~90-360 MB) is downloaded once into the cache dir.
 * Provide a reference WAV (1-30 s of clean speech) via VOICE_WAV env var,
 * or point at any sample from ~/tts-universal/samples.
 *
 * Run: VOICE_WAV=../tts-universal/voices/fortune-ref-24k.wav npm run example:local
 */
import * as fs from "node:fs";
import { listLocalLanguages, PocketTTS } from "../src/index.ts";

async function main(): Promise<void> {
	const voiceWav =
		process.env.VOICE_WAV ?? "../tts-universal/voices/fortune-ref-24k.wav";
	if (!fs.existsSync(voiceWav)) {
		console.error(
			`Reference voice not found: ${voiceWav}\nSet VOICE_WAV to a 1-30s WAV file.`,
		);
		process.exit(1);
	}

	console.log("Available local bundles:");
	for (const bundle of listLocalLanguages()) {
		console.log(`  ${bundle.id.padEnd(16)} ${bundle.name} (${bundle.variant})`);
	}

	const language = (process.env.POCKET_LANG ?? "french_24l") as
		| "french_24l"
		| "english_2026-04";

	console.log(`\nLoading ${language} (downloads the bundle on first use)...`);
	const t0 = performance.now();
	const tts = await PocketTTS.load({
		mode: "local",
		language,
		voice: voiceWav,
		// Low-memory profile for shared boxes:
		numThreads: 2,
		lowMemory: true,
	});
	console.log(`ready in ${(performance.now() - t0).toFixed(0)}ms`);

	console.log("\nStreaming with the cloned voice:");
	const t1 = performance.now();
	let firstAt: number | null = null;
	let samples = 0;
	for await (const chunk of tts.stream(
		"Salut ! Cette phrase est synthétisée avec une voix clonée localement, sans entraînement.",
	)) {
		if (chunk.pcm.length === 0) {
			continue;
		}
		samples += chunk.pcm.length;
		if (firstAt === null) {
			firstAt = performance.now() - t1;
			console.log(`  first audio chunk after ${firstAt.toFixed(0)}ms`);
		}
	}
	console.log(
		`  ${(samples / 24000).toFixed(2)}s of audio in ${(performance.now() - t1).toFixed(0)}ms`,
	);

	const result = await tts.synthesize(
		"Et voilà, le clonage vocal fonctionne entièrement hors ligne.",
	);
	fs.writeFileSync("cloned-output.wav", result.wav);
	console.log(`\nsaved cloned-output.wav (${result.durationSec.toFixed(2)}s)`);

	tts.close();
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
