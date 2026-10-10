# pocket-tts

Streaming [Pocket TTS](https://kyutai.org/blog/2026-01-13-pocket-tts/) for Node.js — Kyutai's 100M-parameter TTS with **zero-shot voice cloning**, in two modes:

- **cloud** — the Kyutai API: 24 built-in voices, 7 languages, audio streamed from the first byte (~60 ms TTFB). No cloning (the API has no upload endpoint).
- **local** — the community ONNX export: offline, **clone any voice from 1–30 s of reference audio** (no training, ~3–8 s one-shot on a laptop CPU), 10 language bundles.

Both modes share one interface: `stream()` yields audio chunks as they're produced, `synthesize()` returns a complete WAV.

## Install

```bash
npm install pocket-tts
```

Node.js ≥ 18.17 (cloud mode uses the global `fetch`). Local mode additionally needs [`onnxruntime-node`](https://www.npmjs.com/package/onnxruntime-node) (installed automatically as an optional peer):

```bash
npm install onnxruntime-node   # local mode only
```

## Quick start

### Cloud mode (built-in voices, streaming)

```ts
import { PocketTTS } from "pocket-tts";

const tts = await PocketTTS.load({
  mode: "cloud",
  language: "french",
  voice: "estelle",
});

// Streamed: chunks arrive while the audio is still being generated
for await (const chunk of tts.stream("Bonjour tout le monde.")) {
  player.enqueue(chunk.pcm); // Float32Array @ 24 kHz
}
tts.close();
```

### Local mode (zero-shot voice cloning)

```ts
import { PocketTTS } from "pocket-tts";
import * as fs from "node:fs";

const tts = await PocketTTS.load({
  mode: "local",
  language: "french_24l",
  voice: "./my-voice.wav", // any clean WAV — cloned without training
});

const result = await tts.synthesize("Cette phrase sort de ma voix clonée.");
await fs.writeFile("cloned.wav", result.wav);
tts.close();
```

The model bundle (~90–360 MB) is downloaded once into the cache directory on first use, then reused.

## Voices

Cloud mode accepts **only** the 24 built-in voices (the API has no cloning endpoint):

```ts
import { listCloudVoices } from "pocket-tts";

for (const voice of listCloudVoices()) {
  console.log(`${voice.id}: ${voice.name} (${voice.gender}, ${voice.style})`);
}
// jane: Jane (female, conversation)
// estelle: Estelle (female, conversation)  ← French
// …24 total
```

Languages: `english`, `french`, `german`, `spanish`, `portuguese`, `italian`, `dutch`. Voices are language-agnostic — `estelle` works with the English model too (the voice provides the timbre, the language the model).

Requesting a clone (`./voice.wav`, a URL, …) in cloud mode throws `CloudModeCloningError` — cloning requires local mode.

## Local bundles

```ts
import { listLocalLanguages } from "pocket-tts";

console.log(listLocalLanguages());
// english_2026-04 (distilled), french_24l (24-layer), german, german_24l, …
```

The `*_24l` bundles are the larger non-distilled preview models (higher quality, slower); plain names are the 6-layer distilled models that reach real time on modern laptops. Measured on an i5-7500 (2017 desktop CPU): English 6-layer ≈ 0.8× real time, French 24-layer ≈ 0.5×. On a recent laptop CPU or with a GPU both are comfortably faster.

## API

### `PocketTTS.load(options)`

| Option | Mode | Type | Default | Notes |
|---|---|---|---|---|
| `mode` | both | `"cloud" \| "local"` | required | Runtime selection |
| `language` | cloud | `CloudLanguage` | `"english"` | 7 languages |
| `language` | local | `LocalLanguage` | `"english_2026-04"` | 10 bundles |
| `voice` | cloud | `string` | language default | Built-in voice id only |
| `voice` | local | `string \| Float32Array \| { pcm, sampleRate }` | required | WAV path or raw samples to clone |
| `endpoint` | cloud | `string` | Kyutai demo API | Point at your own `pocket-tts serve` |
| `timeoutMs` | cloud | `number` | `120000` | Overall request timeout |
| `cacheDir` | local | `string` | platform cache dir | Bundle download cache |
| `numThreads` | local | `number` | ORT default | Intra-op threads |
| `lowMemory` | local | `boolean` | `false` | Disables ORT memory arena (lower peak RAM, small speed loss) |
| `temperature` | local | `number` | `0.7` | Lower = more stable |
| `lsdSteps` | local | `number` | `1` | Flow sampler steps; `5` + `temperature: 0.5` = highest quality |
| `fetchImpl` | both | `typeof fetch` | global fetch | Tests, proxies, mirrors |

### `tts.stream(text)`

Async generator of `AudioChunk { pcm: Float32Array, sampleRate, isFirst, isLast }` at 24 kHz. Cloud mode streams from the HTTP response (TTFB ~60 ms on the public API); local mode emits the first chunk after ~240 ms of generated audio (3 frames), then every ~960 ms.

### `tts.synthesize(text)`

Returns `SynthesisResult { wav: Buffer, pcm: Float32Array, sampleRate, durationSec, mode, language }`. On cloud mode the WAV is what the server streamed; on local mode it's assembled from the decoded chunks.

### `tts.close()`

Aborts in-flight work and releases ONNX sessions. Idempotent.

### Errors

Every error extends `PocketTTSError` with a stable `code`:

| Error | Code | When |
|---|---|---|
| `CloudModeCloningError` | `CLOUD_MODE_NO_CLONING` | Cloning requested in cloud mode |
| `UnknownVoiceError` | `UNKNOWN_VOICE` | Cloud voice id not in the catalog (`error.available` lists them) |
| `UnknownLanguageError` | `UNKNOWN_LANGUAGE` | Invalid language code |
| `BundleDownloadError` | `BUNDLE_DOWNLOAD_FAILED` | Local bundle download failed |
| `AudioDecodeError` | `AUDIO_DECODE_FAILED` | Reference audio undecodable |
| `RequestFailedError` | `REQUEST_FAILED` | Cloud HTTP/network/timeout failure (`error.status`) |
| `InvalidOptionError` | `INVALID_OPTION` | Inconsistent options (e.g. no voice prepared) |

## Self-hosting the cloud mode

The default endpoint is Kyutai's public demo API (no SLA — be reasonable). To self-host, run the official server and point the client at it:

```bash
uvx pocket-tts serve --language french --default-voice ./my-voice.wav
```

```ts
const tts = await PocketTTS.load({
  mode: "cloud",
  endpoint: "http://localhost:8000",
  // voice: whatever your server exposes
});
```

The client targets the `POST /{language}/tts` multipart shape (`text` + `voice_url`) used by the Kyutai deployment. Community OpenAI-compatible servers (`/v1/audio/speech`) speak a different protocol and are not directly compatible.

## How cloning works (local mode)

Zero-shot, no training: reference audio → Mimi encoder → speaker embedding → one prefill pass conditions the flow-LM's KV caches. The prepared state is cached for the instance, so cloning cost (~3–8 s on a laptop CPU, dominated by encoding the reference) is paid once; switching voices re-runs the prefill only.

## Licenses

- Module code: MIT
- [Pocket TTS models](https://huggingface.co/kyutai/pocket-tts): CC-BY-4.0 (Kyutai, MIT-licensed code)
- [ONNX export](https://huggingface.co/KevinAHM/pocket-tts-onnx): Apache-2.0 (KevinAHM)
- `sentencepiece.js` runtime: from the [reference web demo](https://huggingface.co/spaces/KevinAHM/pocket-tts-web), downloaded at runtime into the cache dir

Cloud mode sends your text to Kyutai's API; use local mode for privacy-sensitive content.
