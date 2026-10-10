import { describe, expect, it } from "bun:test";
import {
	AudioDecodeError,
	BundleDownloadError,
	CloudModeCloningError,
	InvalidOptionError,
	PocketTTSError,
	RequestFailedError,
	UnknownLanguageError,
	UnknownVoiceError,
} from "./errors.js";
import type { PocketTTSErrorCode } from "./errors.js";

describe("error hierarchy", () => {
	it("every error extends PocketTTSError with a stable code", () => {
		const cases: [PocketTTSError, PocketTTSErrorCode][] = [
			[new CloudModeCloningError("./v.wav"), "CLOUD_MODE_NO_CLONING"],
			[new UnknownVoiceError("x", ["a"]), "UNKNOWN_VOICE"],
			[new UnknownLanguageError("x", ["a"]), "UNKNOWN_LANGUAGE"],
			[new BundleDownloadError("fr", "boom"), "BUNDLE_DOWNLOAD_FAILED"],
			[new AudioDecodeError("f.wav", "bad"), "AUDIO_DECODE_FAILED"],
			[new RequestFailedError("net"), "REQUEST_FAILED"],
			[new InvalidOptionError("nope"), "INVALID_OPTION"],
		];
		for (const [error, code] of cases) {
			expect(error).toBeInstanceOf(PocketTTSError);
			expect(error).toBeInstanceOf(Error);
			expect(error.code).toBe(code);
		}
	});

	it("CloudModeCloningError carries the rejected voice", () => {
		const error = new CloudModeCloningError("./my-voice.wav");
		expect(error.voice).toBe("./my-voice.wav");
		expect(error.message).toMatch(/built-in voices only/);
		expect(error.message).toMatch(/mode: 'local'/);
	});

	it("UnknownVoiceError lists available voices", () => {
		const error = new UnknownVoiceError("zzz", ["jane", "alba"]);
		expect(error.voice).toBe("zzz");
		expect(error.available).toEqual(["jane", "alba"]);
		expect(error.message).toContain("jane");
	});

	it("UnknownLanguageError mentions the mode when given", () => {
		const error = new UnknownLanguageError("xx", ["french"], "cloud");
		expect(error.language).toBe("xx");
		expect(error.message).toContain("cloud");
		expect(error.message).toContain("french");
	});

	it("BundleDownloadError prefixes the language", () => {
		const error = new BundleDownloadError("french_24l", "HTTP 404");
		expect(error.language).toBe("french_24l");
		expect(error.message).toContain("french_24l");
		expect(error.message).toContain("HTTP 404");
	});

	it("RequestFailedError keeps the HTTP status", () => {
		const error = new RequestFailedError("fail", 503);
		expect(error.status).toBe(503);
		expect(new RequestFailedError("net").status).toBeUndefined();
	});
});
