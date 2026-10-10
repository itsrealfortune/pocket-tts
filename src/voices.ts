/**
 * Voice and language catalogs.
 *
 * The cloud voice list is extracted from the Kyutai web demo source
 * (`kyutai.org/tts`, chunk `5040-*.js`) and cross-checked against the live
 * API. The API name for each voice is the display name lowercased,
 * truncated at the first `(`, and with non-alphanumerics collapsed to `_`
 * — the exact transform the website applies before sending `voice_url`.
 */

import type {
	CloudLanguage,
	CloudVoice,
	LocalLanguage,
	LocalLanguageInfo,
} from "./types.js";

/** Every language served by the Kyutai cloud API, in catalog order. */
export const CLOUD_LANGUAGES: readonly CloudLanguage[] = [
	"english",
	"french",
	"german",
	"spanish",
	"portuguese",
	"italian",
	"dutch",
];

/**
 * The 24 built-in cloud voices (the ones selectable on kyutai.org).
 *
 * The cloud API only accepts these names — external audio cannot be cloned
 * server-side (no upload endpoint exists; `hf://` URLs currently fail).
 */
export const CLOUD_VOICES: readonly CloudVoice[] = [
	{
		id: "jane",
		name: "Jane",
		gender: "female",
		style: "conversation",
		pathOnServer: "vctk/p339_023_enhanced.wav",
	},
	{
		id: "alba",
		name: "Alba",
		gender: "male",
		style: "reading",
		pathOnServer: "alba-mackenna/casual.wav",
	},
	{
		id: "bill_boerst",
		name: "Bill Boerst",
		gender: "male",
		style: "reading",
		pathOnServer: "voice-zero/bill_boerst.wav",
	},
	{
		id: "caro_davy",
		name: "Caro Davy",
		gender: "female",
		style: "reading",
		pathOnServer: "voice-zero/caro_davy.wav",
	},
	{
		id: "peter_yearsley",
		name: "Peter Yearsley",
		gender: "male",
		style: "reading",
		pathOnServer: "voice-zero/peter_yearsley.wav",
	},
	{
		id: "stuart_bell",
		name: "Stuart Bell",
		gender: "male",
		style: "reading",
		pathOnServer: "voice-zero/stuart_bell.wav",
	},
	{
		id: "anna",
		name: "Anna",
		gender: "female",
		style: "conversation",
		pathOnServer: "vctk/p228_023_enhanced.wav",
	},
	{
		id: "azelma",
		name: "Azelma",
		gender: "female",
		style: "reading",
		pathOnServer: "vctk/p303_023_enhanced.wav",
	},
	{
		id: "charles",
		name: "Charles",
		gender: "male",
		style: "conversation",
		pathOnServer: "vctk/p254_023_enhanced.wav",
	},
	{
		id: "eponine",
		name: "Eponine",
		gender: "female",
		style: "reading",
		pathOnServer: "vctk/p262_023_enhanced.wav",
	},
	{
		id: "eve",
		name: "Eve",
		gender: "female",
		style: "conversation",
		pathOnServer: "vctk/p361_023_enhanced.wav",
	},
	{
		id: "fantine",
		name: "Fantine",
		gender: "female",
		style: "reading",
		pathOnServer: "vctk/p244_023_enhanced.wav",
	},
	{
		id: "george",
		name: "George",
		gender: "male",
		style: "conversation",
		pathOnServer: "vctk/p315_023_enhanced.wav",
	},
	{
		id: "mary",
		name: "Mary",
		gender: "female",
		style: "conversation",
		pathOnServer: "vctk/p333_023_enhanced.wav",
	},
	{
		id: "michael",
		name: "Michael",
		gender: "male",
		style: "conversation",
		pathOnServer: "vctk/p360_023_enhanced.wav",
	},
	{
		id: "paul",
		name: "Paul",
		gender: "male",
		style: "conversation",
		pathOnServer: "vctk/p259_023_enhanced.wav",
	},
	{
		id: "vera",
		name: "Vera",
		gender: "female",
		style: "conversation",
		pathOnServer: "vctk/p229_023_enhanced.wav",
	},
	{
		id: "jean",
		name: "Jean",
		gender: "male",
		style: "conversation",
		pathOnServer: "ears/p010/freeform_speech_01_enhanced.wav",
	},
	{
		id: "daan",
		name: "Daan",
		gender: "male",
		style: "conversation",
		languageHint: "dutch",
		pathOnServer: "dummy-path/daan.wav",
	},
	{
		id: "estelle",
		name: "Estelle",
		gender: "female",
		style: "conversation",
		languageHint: "french",
		pathOnServer: "dummy-path/estelle.wav",
	},
	{
		id: "giovanni",
		name: "Giovanni",
		gender: "male",
		style: "conversation",
		languageHint: "italian",
		pathOnServer: "dummy-path/giovanni.wav",
	},
	{
		id: "juergen",
		name: "Juergen",
		gender: "male",
		style: "conversation",
		languageHint: "german",
		pathOnServer: "dummy-path/juergen.wav",
	},
	{
		id: "lola",
		name: "Lola",
		gender: "female",
		style: "conversation",
		languageHint: "spanish",
		pathOnServer: "dummy-path/lola.wav",
	},
	{
		id: "rafael",
		name: "Rafael",
		gender: "male",
		style: "conversation",
		languageHint: "portuguese",
		pathOnServer: "dummy-path/rafael.wav",
	},
];

/** Default cloud voice per language (the language's native catalog voice). */
export const CLOUD_DEFAULT_VOICE: Readonly<Record<CloudLanguage, string>> = {
	english: "jane",
	french: "estelle",
	german: "juergen",
	spanish: "lola",
	portuguese: "rafael",
	italian: "giovanni",
	dutch: "daan",
};

/** Local ONNX bundles available for download (KevinAHM export). */
export const LOCAL_LANGUAGES: readonly LocalLanguageInfo[] = [
	{ id: "english_2026-04", name: "English", tag: "en", variant: "distilled" },
	{ id: "french_24l", name: "French", tag: "fr", variant: "24-layer" },
	{ id: "german", name: "German", tag: "de", variant: "distilled" },
	{
		id: "german_24l",
		name: "German (24-layer)",
		tag: "de",
		variant: "24-layer",
	},
	{ id: "italian", name: "Italian", tag: "it", variant: "distilled" },
	{
		id: "italian_24l",
		name: "Italian (24-layer)",
		tag: "it",
		variant: "24-layer",
	},
	{ id: "portuguese", name: "Portuguese", tag: "pt", variant: "distilled" },
	{
		id: "portuguese_24l",
		name: "Portuguese (24-layer)",
		tag: "pt",
		variant: "24-layer",
	},
	{ id: "spanish", name: "Spanish", tag: "es", variant: "distilled" },
	{
		id: "spanish_24l",
		name: "Spanish (24-layer)",
		tag: "es",
		variant: "24-layer",
	},
];

/** Every valid cloud voice id, in catalog order. */
export const CLOUD_VOICE_IDS: readonly string[] = CLOUD_VOICES.map((v) => v.id);

/** Cloud language codes as a plain string array (for error messages). */
export const CLOUD_LANGUAGE_LIST: readonly string[] = CLOUD_LANGUAGES;

/**
 * Lists every built-in cloud voice.
 *
 * @returns {readonly CloudVoice[]} The 24 catalog voices with metadata.
 * @example
 * ```ts
 * import { listCloudVoices } from "pocket-tts";
 * for (const voice of listCloudVoices()) {
 *   console.log(`${voice.id}: ${voice.name} (${voice.gender}, ${voice.style})`);
 * }
 * ```
 */
export function listCloudVoices(): readonly CloudVoice[] {
	return CLOUD_VOICES;
}

/**
 * Lists every language supported by the cloud API.
 *
 * @returns {readonly CloudLanguage[]} Cloud language codes.
 * @example
 * ```ts
 * import { listCloudLanguages } from "pocket-tts";
 * console.log(listCloudLanguages()); // ["english", "french", ...]
 * ```
 */
export function listCloudLanguages(): readonly CloudLanguage[] {
	return CLOUD_LANGUAGES;
}

/**
 * Lists every downloadable local-mode bundle.
 *
 * @returns {readonly LocalLanguageInfo[]} Bundle metadata (id, size tier).
 * @example
 * ```ts
 * import { listLocalLanguages } from "pocket-tts";
 * for (const bundle of listLocalLanguages()) {
 *   console.log(`${bundle.id}: ${bundle.name} (${bundle.variant})`);
 * }
 * ```
 */
export function listLocalLanguages(): readonly LocalLanguageInfo[] {
	return LOCAL_LANGUAGES;
}

/**
 * Checks whether a cloud language code is valid.
 *
 * @param {string} language - The language code to check.
 * @returns {boolean} True when the code is a supported cloud language.
 */
export function isCloudLanguage(language: string): language is CloudLanguage {
	return (CLOUD_LANGUAGES as readonly string[]).includes(language);
}

/**
 * Checks whether a local bundle id is valid.
 *
 * @param {string} language - The bundle id to check.
 * @returns {boolean} True when the id is a downloadable local bundle.
 */
export function isLocalLanguage(language: string): language is LocalLanguage {
	return (LOCAL_LANGUAGES as readonly LocalLanguageInfo[]).some(
		(l) => l.id === language,
	);
}

/**
 * Reverses the website's voice-name transform to recover the API id from
 * a display name (lowercase, cut at `(`, non-alphanumerics to `_`).
 *
 * @param {string} displayName - Display name, optionally with a `(…)` suffix.
 * @returns {string} The API voice id.
 */
export function voiceIdFromDisplayName(displayName: string): string {
	return (
		displayName
			.toLowerCase()
			.split("(")[0]
			?.trim()
			.replace(/[^a-z0-9]+/g, "_") ?? ""
	);
}
