/**
 * Demo server: real-time Pocket TTS over HTTP with Hono.
 *
 * Exposes the pocket-tts module through a small REST API and serves a
 * browser UI that plays audio *while it is being generated* (binary PCM
 * stream + AudioWorklet — the same architecture as the Kyutai web demo).
 *
 * Endpoints:
 * - `GET  /`                        the demo UI
 * - `GET  /api/config`              modes/voices/languages inventory
 * - `POST /api/tts/stream`          chunked PCM16LE @24kHz (real-time playback)
 * - `POST /api/tts/wav`             complete WAV (download)
 * - `POST /api/local/prepare`       load the local engine ahead of time
 *
 * Environment:
 * - `POCKET_VOICE`      path to a reference WAV → enables local mode (cloning)
 * - `POCKET_LANG`       local bundle id (default `french_24l`)
 * - `POCKET_ENDPOINT`   cloud API base URL (default: Kyutai demo)
 * - `PORT`              server port (default 3000)
 *
 * Run: `npm run demo` (add `POCKET_VOICE=./my-voice.wav` for local mode)
 */

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	isCloudLanguage,
	listCloudLanguages,
	listCloudVoices,
	listLocalLanguages,
	PocketTTS,
	type PocketTTSInstance,
} from "../src/index.ts";

const PORT = Number(process.env.PORT ?? 3000);
const LOCAL_VOICE = process.env.POCKET_VOICE;
if (LOCAL_VOICE && !fs.existsSync(path.resolve(LOCAL_VOICE))) {
	console.error(
		`POCKET_VOICE file not found: ${path.resolve(LOCAL_VOICE)}\n` +
			`Use an absolute path or a path relative to the project root, e.g.\n` +
			`  POCKET_VOICE=$HOME/tts-universal/voices/fortune-ref-24k.wav npm run demo`,
	);
	process.exit(1);
}
const LOCAL_LANG = (process.env.POCKET_LANG ?? "french_24l") as Parameters<
	typeof PocketTTS.load
>[0] extends { language?: infer L } ? L : never;
const CLOUD_ENDPOINT = process.env.POCKET_ENDPOINT;

/** Serializes local generations (one ONNX inference at a time on CPU). */
let localQueue: Promise<unknown> = Promise.resolve();
let localTts: PocketTTSInstance | null = null;
let localPromise: Promise<PocketTTSInstance> | null = null;
let localError: string | null = null;

/**
 * Returns the shared local instance, loading it (and cloning the voice)
 * on first use. Concurrent callers share one load promise.
 */
function getLocal(): Promise<PocketTTSInstance> {
	if (localTts) {
		return Promise.resolve(localTts);
	}
	if (!LOCAL_VOICE) {
		return Promise.reject(
			localError ?? "Local mode disabled: set POCKET_VOICE to a WAV file.",
		);
	}
	if (!localPromise) {
		localPromise = PocketTTS.load({
			mode: "local",
			language: LOCAL_LANG,
			voice: path.resolve(LOCAL_VOICE),
			lowMemory: true,
		})
			.then((instance) => {
				localTts = instance;
				return instance;
			})
			.catch((error: Error) => {
				localError = error.message;
				localPromise = null;
				throw error;
			});
	}
	return localPromise;
}

/** Builds a cloud instance for one request (voice fixed per instance). */
/**
 * Builds a cloud instance for one request (voice fixed per instance).
 * Invalid languages fall through to the module's UnknownLanguageError,
 * surfaced as a 503 by the callers.
 */
async function getCloud(
	voice?: string,
	language = "french",
): Promise<PocketTTSInstance> {
	if (!isCloudLanguage(language)) {
		throw new Error(
			`Unknown cloud language "${language}". Available: ${listCloudLanguages().join(", ")}`,
		);
	}
	return PocketTTS.load({
		mode: "cloud",
		language,
		voice: voice ?? "estelle",
		...(CLOUD_ENDPOINT ? { endpoint: CLOUD_ENDPOINT } : {}),
	});
}

/** Resolves the instance for a request mode ("cloud" | "local"). */
async function resolveInstance(
	mode: string,
	voice?: string,
	language?: string,
): Promise<PocketTTSInstance> {
	if (mode === "local") {
		return getLocal();
	}
	return getCloud(voice, language);
}

const app = new Hono();

app.get("/api/config", (c) =>
	c.json({
		sampleRate: 24000,
		cloud: {
			enabled: true,
			languages: listCloudLanguages(),
			voices: listCloudVoices().map((v) => ({
				id: v.id,
				name: v.name,
				gender: v.gender,
				style: v.style,
				languageHint: v.languageHint ?? null,
			})),
		},
		local: {
			enabled: Boolean(LOCAL_VOICE),
			ready: localTts !== null,
			error: localError,
			languages: listLocalLanguages().map((l) => l.id),
		},
	}),
);

app.post("/api/local/prepare", async (c) => {
	if (!LOCAL_VOICE) {
		return c.json({ ok: false, error: "POCKET_VOICE not set" }, 404);
	}
	try {
		await getLocal();
		return c.json({ ok: true });
	} catch (error) {
		return c.json({ ok: false, error: (error as Error).message }, 500);
	}
});

interface TtsRequest {
	text: string;
	mode?: string;
	voice?: string;
	language?: string;
}

app.post("/api/tts/stream", async (c) => {
	const body = (await c.req.json()) as TtsRequest;
	if (!body?.text?.trim()) {
		return c.json({ error: "text is required" }, 400);
	}
	const mode = body.mode ?? "cloud";

	let tts: PocketTTSInstance;
	try {
		tts = await resolveInstance(mode, body.voice, body.language);
	} catch (error) {
		return c.json({ error: (error as Error).message }, 503);
	}

	// Chunked binary PCM16LE — the browser converts back to float32 and
	// feeds an AudioWorklet for gapless real-time playback.
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const chunk of tts.stream(body.text)) {
					if (chunk.pcm.length === 0) {
						continue;
					}
					const pcm16 = new Int16Array(chunk.pcm.length);
					for (let i = 0; i < chunk.pcm.length; i++) {
						const s = Math.max(-1, Math.min(1, chunk.pcm[i] as number));
						pcm16[i] = Math.round(s * 32767);
					}
					controller.enqueue(
						new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength),
					);
				}
				controller.close();
			} catch (error) {
				controller.error(error);
			}
		},
		cancel() {
			// Client disconnected: generation runs to completion server-side
			// (rudimentary demo; a production server would wire an
			// AbortSignal through tts.stream()).
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "application/octet-stream",
			"X-Sample-Rate": "24000",
			"X-Audio-Format": "pcm16le",
			"Cache-Control": "no-cache",
		},
	});
});

app.post("/api/tts/wav", async (c) => {
	const body = (await c.req.json()) as TtsRequest;
	if (!body?.text?.trim()) {
		return c.json({ error: "text is required" }, 400);
	}
	try {
		const tts = await resolveInstance(body.mode ?? "cloud", body.voice, body.language);
		const result = await tts.synthesize(body.text);
		return new Response(new Uint8Array(result.wav), {
			headers: {
				"Content-Type": "audio/wav",
				"Content-Length": String(result.wav.length),
			},
		});
	} catch (error) {
		return c.json({ error: (error as Error).message }, 503);
	}
});

app.get("/*", serveStatic({ root: "./demo/public" }));
app.get("/", serveStatic({ path: "./demo/public/index.html" }));

serve({ fetch: app.fetch, port: PORT }, (info) => {
	console.log(`pocket-tts demo → http://localhost:${info.port}`);
	console.log(
		`cloud: enabled (Kyutai demo${CLOUD_ENDPOINT ? ` → ${CLOUD_ENDPOINT}` : ""})`,
	);
	console.log(
		LOCAL_VOICE
			? `local: enabled (bundle ${LOCAL_LANG}, voice ${LOCAL_VOICE})`
			: "local: disabled (set POCKET_VOICE=./voice.wav to enable cloning)",
	);
});
