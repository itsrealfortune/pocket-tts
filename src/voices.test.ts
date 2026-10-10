import { describe, expect, it } from "bun:test";
import {
	CLOUD_DEFAULT_VOICE,
	CLOUD_LANGUAGES,
	CLOUD_VOICES,
	isCloudLanguage,
	isLocalLanguage,
	listCloudLanguages,
	listCloudVoices,
	listLocalLanguages,
	voiceIdFromDisplayName,
} from "./voices.js";

describe("cloud voice catalog", () => {
	it("has 24 voices with unique ids", () => {
		expect(CLOUD_VOICES).toHaveLength(24);
		const ids = CLOUD_VOICES.map((v) => v.id);
		expect(new Set(ids).size).toBe(24);
	});

	it("every voice has a name, gender, style and server path", () => {
		for (const voice of CLOUD_VOICES) {
			expect(voice.name.length).toBeGreaterThan(0);
			expect(["female", "male"]).toContain(voice.gender);
			expect(voice.style.length).toBeGreaterThan(0);
			expect(voice.pathOnServer).toContain("/");
		}
	});

	it("voice ids match the website's display-name transform", () => {
		for (const voice of CLOUD_VOICES) {
			// The API id must equal the display name run through the site's
			// transform (lowercase, cut at "(", non-alnum to "_").
			const derived = voiceIdFromDisplayName(
				`${voice.name} (${voice.gender[0]}, ${voice.style})`,
			);
			expect(voice.id).toBe(derived);
		}
	});

	it("multilingual voices carry a language hint", () => {
		const hinted = CLOUD_VOICES.filter((v) => v.languageHint);
		expect(hinted.map((v) => v.id).sort()).toEqual([
			"daan",
			"estelle",
			"giovanni",
			"juergen",
			"lola",
			"rafael",
		]);
	});
});

describe("language catalogs", () => {
	it("cloud languages match the API surface", () => {
		expect(CLOUD_LANGUAGES).toEqual([
			"english",
			"french",
			"german",
			"spanish",
			"portuguese",
			"italian",
			"dutch",
		]);
		expect(listCloudLanguages()).toHaveLength(7);
	});

	it("every cloud language has a default voice that exists", () => {
		for (const language of CLOUD_LANGUAGES) {
			const defaultVoice = CLOUD_DEFAULT_VOICE[language];
			expect(CLOUD_VOICES.some((v) => v.id === defaultVoice)).toBe(true);
		}
	});

	it("local bundles cover the exported languages", () => {
		const bundles = listLocalLanguages();
		expect(bundles.length).toBeGreaterThanOrEqual(10);
		expect(bundles.some((b) => b.id === "french_24l")).toBe(true);
		expect(bundles.some((b) => b.id === "english_2026-04")).toBe(true);
		// Distilled and 24-layer variants both listed
		expect(
			bundles.filter((b) => b.variant === "distilled").length,
		).toBeGreaterThan(0);
		expect(
			bundles.filter((b) => b.variant === "24-layer").length,
		).toBeGreaterThan(0);
	});

	it("type guards accept valid codes and reject others", () => {
		expect(isCloudLanguage("french")).toBe(true);
		expect(isCloudLanguage("klingon")).toBe(false);
		expect(isLocalLanguage("french_24l")).toBe(true);
		expect(isLocalLanguage("french")).toBe(false);
	});
});

describe("listCloudVoices", () => {
	it("returns the full catalog", () => {
		expect(listCloudVoices()).toBe(CLOUD_VOICES);
	});
});

describe("voiceIdFromDisplayName", () => {
	it("lowercases and collapses non-alphanumerics", () => {
		expect(voiceIdFromDisplayName("Jane (f, conversation)")).toBe("jane");
		expect(voiceIdFromDisplayName("Bill Boerst (m, reading)")).toBe(
			"bill_boerst",
		);
		expect(voiceIdFromDisplayName("Rafael (Brazilian Portuguese, m)")).toBe(
			"rafael",
		);
	});
});
