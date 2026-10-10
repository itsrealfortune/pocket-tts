/**
 * Error hierarchy for the pocket-tts module.
 *
 * Every error thrown by the public API extends {@link PocketTTSError} and
 * carries a stable machine-readable `code`, so callers can branch on error
 * kind without string matching.
 */

/** Stable error codes emitted by this module. */
export type PocketTTSErrorCode =
	| "CLOUD_MODE_NO_CLONING"
	| "UNKNOWN_VOICE"
	| "UNKNOWN_LANGUAGE"
	| "BUNDLE_DOWNLOAD_FAILED"
	| "AUDIO_DECODE_FAILED"
	| "REQUEST_FAILED"
	| "INVALID_OPTION";

/** Base class for every error thrown by the pocket-tts module. */
export class PocketTTSError extends Error {
	/** Stable machine-readable error code. */
	readonly code: PocketTTSErrorCode;

	/**
	 * @param {PocketTTSErrorCode} code - Stable error code for programmatic handling.
	 * @param {string} message - Human-readable description of the failure.
	 * @param {ErrorOptions} [options] - Standard error options (`cause`).
	 */
	constructor(
		code: PocketTTSErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "PocketTTSError";
		this.code = code;
	}
}

/**
 * Thrown when voice cloning is attempted in cloud mode.
 *
 * The Kyutai cloud API only serves its 24 built-in voices; cloning any
 * external audio requires the local mode (ONNX runtime).
 *
 * @example
 * ```ts
 * try {
 *   await PocketTTS.load({ mode: "cloud", voice: "./my-voice.wav" });
 * } catch (error) {
 *   if (error instanceof CloudModeCloningError) {
 *     // fall back to local mode for cloning
 *     await PocketTTS.load({ mode: "local", language: "french_24l", voice: "./my-voice.wav" });
 *   }
 * }
 * ```
 */
export class CloudModeCloningError extends PocketTTSError {
	/** The rejected voice value (path, URL, or raw audio). */
	readonly voice: unknown;

	/**
	 * @param {unknown} voice - The voice value that triggered the rejection.
	 */
	constructor(voice: unknown) {
		super(
			"CLOUD_MODE_NO_CLONING",
			"Cloud mode supports built-in voices only. Voice cloning requires mode: 'local'.",
		);
		this.name = "CloudModeCloningError";
		this.voice = voice;
	}
}

/** Thrown when a voice name is not part of the cloud catalog. */
export class UnknownVoiceError extends PocketTTSError {
	/** The rejected voice name. */
	readonly voice: string;
	/** Every voice name valid in the requested language. */
	readonly available: readonly string[];

	/**
	 * @param {string} voice - The rejected voice name.
	 * @param {readonly string[]} available - All valid voice names.
	 */
	constructor(voice: string, available: readonly string[]) {
		super(
			"UNKNOWN_VOICE",
			`Unknown voice "${voice}". Available: ${available.join(", ")}.`,
		);
		this.name = "UnknownVoiceError";
		this.voice = voice;
		this.available = available;
	}
}

/** Thrown when a language code is not supported by the selected mode. */
export class UnknownLanguageError extends PocketTTSError {
	/** The rejected language code. */
	readonly language: string;
	/** Every language valid for the selected mode. */
	readonly available: readonly string[];

	/**
	 * @param {string} language - The rejected language code.
	 * @param {readonly string[]} available - All valid language codes.
	 * @param {string} [mode] - The mode ("cloud" or "local") that rejected it.
	 */
	constructor(language: string, available: readonly string[], mode?: string) {
		super(
			"UNKNOWN_LANGUAGE",
			`Unknown ${mode ? `${mode} ` : ""}language "${language}". Available: ${available.join(", ")}.`,
		);
		this.name = "UnknownLanguageError";
		this.language = language;
		this.available = available;
	}
}

/** Thrown when a local-mode model bundle cannot be downloaded or read. */
export class BundleDownloadError extends PocketTTSError {
	/** The bundle language whose download failed (for example `"french_24l"`). */
	readonly language: string;

	/**
	 * @param {string} language - The bundle language that failed.
	 * @param {string} message - Human-readable failure description.
	 * @param {ErrorOptions} [options] - Standard error options (`cause`).
	 */
	constructor(language: string, message: string, options?: ErrorOptions) {
		super(
			"BUNDLE_DOWNLOAD_FAILED",
			`Failed to prepare Pocket TTS bundle for "${language}": ${message}`,
			options,
		);
		this.name = "BundleDownloadError";
		this.language = language;
	}
}

/** Thrown when a reference-audio file cannot be decoded (local mode cloning). */
export class AudioDecodeError extends PocketTTSError {
	/** Path or identifier of the audio that failed to decode. */
	readonly source: string;

	/**
	 * @param {string} source - Path or identifier of the undecodable audio.
	 * @param {string} message - Human-readable failure description.
	 * @param {ErrorOptions} [options] - Standard error options (`cause`).
	 */
	constructor(source: string, message: string, options?: ErrorOptions) {
		super(
			"AUDIO_DECODE_FAILED",
			`Cannot decode audio "${source}": ${message}`,
			options,
		);
		this.name = "AudioDecodeError";
		this.source = source;
	}
}

/** Thrown when a cloud request fails at the HTTP level (network or status). */
export class RequestFailedError extends PocketTTSError {
	/** HTTP status code when the server responded, `undefined` on network errors. */
	readonly status: number | undefined;

	/**
	 * @param {string} message - Human-readable failure description.
	 * @param {number} [status] - HTTP status code when available.
	 * @param {ErrorOptions} [options] - Standard error options (`cause`).
	 */
	constructor(message: string, status?: number, options?: ErrorOptions) {
		super("REQUEST_FAILED", message, options);
		this.name = "RequestFailedError";
		this.status = status;
	}
}

/** Thrown when load options are internally inconsistent. */
export class InvalidOptionError extends PocketTTSError {
	/**
	 * @param {string} message - Human-readable description of the invalid option.
	 */
	constructor(message: string) {
		super("INVALID_OPTION", message);
		this.name = "InvalidOptionError";
	}
}
