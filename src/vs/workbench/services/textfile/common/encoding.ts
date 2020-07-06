/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DecoderStream } from 'iconv-lite-umd';
import { Readable, ReadableStream, newWriteableStream } from 'vs/base/common/stream';
import { VSBuffer, VSBufferReadable, VSBufferReadableStream } from 'vs/base/common/buffer';

export const UTF8 = 'utf8';
export const UTF8_with_bom = 'utf8bom';
export const UTF16be = 'utf16be';
export const UTF16le = 'utf16le';

export type UTF_ENCODING = typeof UTF8 | typeof UTF8_with_bom | typeof UTF16be | typeof UTF16le;

export function isUTFEncoding(encoding: string): encoding is UTF_ENCODING {
	return [UTF8, UTF8_with_bom, UTF16be, UTF16le].some(utfEncoding => utfEncoding === encoding);
}

export const UTF16be_BOM = [0xFE, 0xFF];
export const UTF16le_BOM = [0xFF, 0xFE];
export const UTF8_BOM = [0xEF, 0xBB, 0xBF];

const ZERO_BYTE_DETECTION_BUFFER_MAX_LEN = 512; 	// number of bytes to look at to decide about a file being binary or not
const NO_ENCODING_GUESS_MIN_BYTES = 512; 			// when not auto guessing the encoding, small number of bytes are enough
const AUTO_ENCODING_GUESS_MIN_BYTES = 512 * 8; 		// with auto guessing we want a lot more content to be read for guessing
const AUTO_ENCODING_GUESS_MAX_BYTES = 512 * 128; 	// set an upper limit for the number of bytes we pass on to jschardet

export interface IDecodeStreamOptions {
	guessEncoding: boolean;
	minBytesRequiredForDetection?: number;

	overwriteEncoding(detectedEncoding: string | null): Promise<string>;
}

export interface IDecodeStreamResult {
	stream: ReadableStream<string>;
	detected: IDetectedEncodingResult;
}

export function toDecodeStream(source: VSBufferReadableStream, options: IDecodeStreamOptions): Promise<IDecodeStreamResult> {
	const minBytesRequiredForDetection = options.minBytesRequiredForDetection ?? options.guessEncoding ? AUTO_ENCODING_GUESS_MIN_BYTES : NO_ENCODING_GUESS_MIN_BYTES;

	return new Promise<IDecodeStreamResult>((resolve, reject) => {
		const target = newWriteableStream<string>(strings => strings.join(''));

		const bufferedChunks: VSBuffer[] = [];
		let bytesBuffered = 0;

		let decoder: DecoderStream | undefined = undefined;

		const createDecoder = async () => {
			try {

				// detect encoding from buffer
				const detected = await detectEncodingFromBuffer({
					buffer: VSBuffer.concat(bufferedChunks),
					bytesRead: bytesBuffered
				}, options.guessEncoding);

				// ensure to respect overwrite of encoding
				detected.encoding = await options.overwriteEncoding(detected.encoding);

				// decode and write buffered content
				const iconv = await import('iconv-lite-umd');
				decoder = iconv.getDecoder(toNodeEncoding(detected.encoding));
				const decoded = decoder.write(VSBuffer.concat(bufferedChunks).buffer);
				target.write(decoded);

				bufferedChunks.length = 0;
				bytesBuffered = 0;

				// signal to the outside our detected encoding and final decoder stream
				resolve({
					stream: target,
					detected
				});
			} catch (error) {
				reject(error);
			}
		};

		// Stream error: forward to target
		source.on('error', error => target.error(error));

		// Stream data
		source.on('data', async chunk => {

			// if the decoder is ready, we just write directly
			if (decoder) {
				target.write(decoder.write(chunk.buffer));
			}

			// otherwise we need to buffer the data until the stream is ready
			else {
				bufferedChunks.push(chunk);
				bytesBuffered += chunk.byteLength;

				// buffered enough data for encoding detection, create stream
				if (bytesBuffered >= minBytesRequiredForDetection) {

					// pause stream here until the decoder is ready
					source.pause();

					await createDecoder();

					// resume stream now that decoder is ready but
					// outside of this stack to reduce recursion
					setTimeout(() => source.resume());
				}
			}
		});

		// Stream end
		source.on('end', async () => {

			// we were still waiting for data to do the encoding
			// detection. thus, wrap up starting the stream even
			// without all the data to get things going
			if (!decoder) {
				await createDecoder();
			}

			// end the target with the remainders of the decoder
			target.end(decoder?.end());
		});
	});
}

export async function toEncodeReadable(readable: Readable<string>, encoding: string, options?: { addBOM?: boolean }): Promise<VSBufferReadable> {
	const iconv = await import('iconv-lite-umd');
	const encoder = iconv.getEncoder(toNodeEncoding(encoding), options);

	let bytesRead = 0;
	let done = false;

	return {
		read() {
			if (done) {
				return null;
			}

			const chunk = readable.read();
			if (typeof chunk !== 'string') {
				done = true;

				// If we are instructed to add a BOM but we detect that no
				// bytes have been read, we must ensure to return the BOM
				// ourselves so that we comply with the contract.
				if (bytesRead === 0 && options?.addBOM) {
					switch (encoding) {
						case UTF8:
						case UTF8_with_bom:
							return VSBuffer.wrap(Uint8Array.from(UTF8_BOM));
						case UTF16be:
							return VSBuffer.wrap(Uint8Array.from(UTF16be_BOM));
						case UTF16le:
							return VSBuffer.wrap(Uint8Array.from(UTF16le_BOM));
					}
				}

				const leftovers = encoder.end();
				if (leftovers && leftovers.length > 0) {
					return VSBuffer.wrap(leftovers);
				}

				return null;
			}

			bytesRead += chunk.length;

			return VSBuffer.wrap(encoder.write(chunk));
		}
	};
}

export async function encodingExists(encoding: string): Promise<boolean> {
	const iconv = await import('iconv-lite-umd');

	return iconv.encodingExists(toNodeEncoding(encoding));
}

export function toNodeEncoding(enc: string | null): string {
	if (enc === UTF8_with_bom || enc === null) {
		return UTF8; // iconv does not distinguish UTF 8 with or without BOM, so we need to help it
	}

	return enc;
}

export function detectEncodingByBOMFromBuffer(buffer: VSBuffer | null, bytesRead: number): typeof UTF8_with_bom | typeof UTF16le | typeof UTF16be | null {
	if (!buffer || bytesRead < UTF16be_BOM.length) {
		return null;
	}

	const b0 = buffer.readUInt8(0);
	const b1 = buffer.readUInt8(1);

	// UTF-16 BE
	if (b0 === UTF16be_BOM[0] && b1 === UTF16be_BOM[1]) {
		return UTF16be;
	}

	// UTF-16 LE
	if (b0 === UTF16le_BOM[0] && b1 === UTF16le_BOM[1]) {
		return UTF16le;
	}

	if (bytesRead < UTF8_BOM.length) {
		return null;
	}

	const b2 = buffer.readUInt8(2);

	// UTF-8
	if (b0 === UTF8_BOM[0] && b1 === UTF8_BOM[1] && b2 === UTF8_BOM[2]) {
		return UTF8_with_bom;
	}

	return null;
}

// we explicitly ignore a specific set of encodings from auto guessing
// - ASCII: we never want this encoding (most UTF-8 files would happily detect as
//          ASCII files and then you could not type non-ASCII characters anymore)
// - UTF-16: we have our own detection logic for UTF-16
// - UTF-32: we do not support this encoding in VSCode
const IGNORE_ENCODINGS = ['ascii', 'utf-16', 'utf-32'];

/**
 * Guesses the encoding from buffer.
 */
async function guessEncodingByBuffer(buffer: VSBuffer): Promise<string | null> {
	const jschardet = await import('jschardet');

	// ensure to limit buffer for guessing due to https://github.com/aadsm/jschardet/issues/53
	const limitedBuffer = buffer.slice(0, AUTO_ENCODING_GUESS_MAX_BYTES);
	// override type since jschardet expects Buffer even though can accept Uint8Array
	// can be fixed once https://github.com/aadsm/jschardet/pull/58 is merged
	const jschardetTypingsWorkaround = limitedBuffer.buffer as any;

	const guessed = jschardet.detect(jschardetTypingsWorkaround);
	if (!guessed || !guessed.encoding) {
		return null;
	}

	const enc = guessed.encoding.toLowerCase();
	if (0 <= IGNORE_ENCODINGS.indexOf(enc)) {
		return null; // see comment above why we ignore some encodings
	}

	return toIconvLiteEncoding(guessed.encoding);
}

const JSCHARDET_TO_ICONV_ENCODINGS: { [name: string]: string } = {
	'ibm866': 'cp866',
	'big5': 'cp950'
};

function toIconvLiteEncoding(encodingName: string): string {
	const normalizedEncodingName = encodingName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
	const mapped = JSCHARDET_TO_ICONV_ENCODINGS[normalizedEncodingName];

	return mapped || normalizedEncodingName;
}

/**
 * The encodings that are allowed in a settings file don't match the canonical encoding labels specified by WHATWG.
 * See https://encoding.spec.whatwg.org/#names-and-labels
 * Iconv-lite strips all non-alphanumeric characters, but ripgrep doesn't. For backcompat, allow these labels.
 */
export function toCanonicalName(enc: string): string {
	switch (enc) {
		case 'shiftjis':
			return 'shift-jis';
		case 'utf16le':
			return 'utf-16le';
		case 'utf16be':
			return 'utf-16be';
		case 'big5hkscs':
			return 'big5-hkscs';
		case 'eucjp':
			return 'euc-jp';
		case 'euckr':
			return 'euc-kr';
		case 'koi8r':
			return 'koi8-r';
		case 'koi8u':
			return 'koi8-u';
		case 'macroman':
			return 'x-mac-roman';
		case 'utf8bom':
			return 'utf8';
		default:
			const m = enc.match(/windows(\d+)/);
			if (m) {
				return 'windows-' + m[1];
			}

			return enc;
	}
}

export interface IDetectedEncodingResult {
	encoding: string | null;
	seemsBinary: boolean;
}

export interface IReadResult {
	buffer: VSBuffer | null;
	bytesRead: number;
}

export function detectEncodingFromBuffer(readResult: IReadResult, autoGuessEncoding?: false): IDetectedEncodingResult;
export function detectEncodingFromBuffer(readResult: IReadResult, autoGuessEncoding?: boolean): Promise<IDetectedEncodingResult>;
export function detectEncodingFromBuffer({ buffer, bytesRead }: IReadResult, autoGuessEncoding?: boolean): Promise<IDetectedEncodingResult> | IDetectedEncodingResult {

	// Always first check for BOM to find out about encoding
	let encoding = detectEncodingByBOMFromBuffer(buffer, bytesRead);

	// Detect 0 bytes to see if file is binary or UTF-16 LE/BE
	// unless we already know that this file has a UTF-16 encoding
	let seemsBinary = false;
	if (encoding !== UTF16be && encoding !== UTF16le && buffer) {
		let couldBeUTF16LE = true; // e.g. 0xAA 0x00
		let couldBeUTF16BE = true; // e.g. 0x00 0xAA
		let containsZeroByte = false;

		// This is a simplified guess to detect UTF-16 BE or LE by just checking if
		// the first 512 bytes have the 0-byte at a specific location. For UTF-16 LE
		// this would be the odd byte index and for UTF-16 BE the even one.
		// Note: this can produce false positives (a binary file that uses a 2-byte
		// encoding of the same format as UTF-16) and false negatives (a UTF-16 file
		// that is using 4 bytes to encode a character).
		for (let i = 0; i < bytesRead && i < ZERO_BYTE_DETECTION_BUFFER_MAX_LEN; i++) {
			const isEndian = (i % 2 === 1); // assume 2-byte sequences typical for UTF-16
			const isZeroByte = (buffer.readUInt8(i) === 0);

			if (isZeroByte) {
				containsZeroByte = true;
			}

			// UTF-16 LE: expect e.g. 0xAA 0x00
			if (couldBeUTF16LE && (isEndian && !isZeroByte || !isEndian && isZeroByte)) {
				couldBeUTF16LE = false;
			}

			// UTF-16 BE: expect e.g. 0x00 0xAA
			if (couldBeUTF16BE && (isEndian && isZeroByte || !isEndian && !isZeroByte)) {
				couldBeUTF16BE = false;
			}

			// Return if this is neither UTF16-LE nor UTF16-BE and thus treat as binary
			if (isZeroByte && !couldBeUTF16LE && !couldBeUTF16BE) {
				break;
			}
		}

		// Handle case of 0-byte included
		if (containsZeroByte) {
			if (couldBeUTF16LE) {
				encoding = UTF16le;
			} else if (couldBeUTF16BE) {
				encoding = UTF16be;
			} else {
				seemsBinary = true;
			}
		}
	}

	// Auto guess encoding if configured
	if (autoGuessEncoding && !seemsBinary && !encoding && buffer) {
		return guessEncodingByBuffer(buffer.slice(0, bytesRead)).then(guessedEncoding => {
			return {
				seemsBinary: false,
				encoding: guessedEncoding
			};
		});
	}

	return { seemsBinary, encoding };
}