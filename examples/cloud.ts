/**
 * Cloud mode example: stream audio from the Kyutai API.
 *
 * Run: npm run example:cloud
 */
import { listCloudVoices, PocketTTS } from "../src/index.ts";

async function main(): Promise<void> {
	console.log("Available cloud voices:");
	for (const voice of listCloudVoices()) {
		const hint = voice.languageHint ? ` [${voice.languageHint}]` : "";
		console.log(`  ${voice.id.padEnd(16)} ${voice.name} (${voice.gender}, ${voice.style})${hint}`);
	}

	const tts = await PocketTTS.load({
		mode: "cloud",
		language: "french",
		voice: "estelle",
	});

	console.log("\nStreaming (chunks arrive as they are generated):");
	const t0 = performance.now();
	let chunks = 0;
	let samples = 0;
	let firstAt: number | null = null;
	for await (const chunk of tts.stream(
		"Bonjour ! Ceci est un exemple de streaming avec le module pocket-tts.",
	)) {
		if (chunk.pcm.length === 0) {
			continue;
		}
		chunks++;
		samples += chunk.pcm.length;
		if (firstAt === null) {
			firstAt = performance.now() - t0;
			console.log(`  first audio chunk after ${firstAt.toFixed(0)}ms`);
		}
	}
	const total = performance.now() - t0;
	console.log(
		`  ${chunks} chunks, ${(samples / 24000).toFixed(2)}s of audio in ${total.toFixed(0)}ms`,
	);

	// Full synthesis returns a ready-to-save WAV
	const result = await tts.synthesize("Le mode synthesize renvoie un fichier WAV complet.");
	console.log(
		`\nsynthesize: ${result.durationSec.toFixed(2)}s of audio, ${result.wav.length} bytes WAV`,
	);

	tts.close();
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
