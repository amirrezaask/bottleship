/* tslint:disable */
/* eslint-disable */

/**
 * Extract every entry from an in-memory 7z archive.
 *
 * Returns a JS `Array` of `{ name: string, data: Uint8Array }`. Directory
 * entries are skipped (only files are returned). Unsupported coders (BCJ2,
 * PPMd, AES-encrypted streams) surface as a JS exception with a clear message.
 */
export function extract_7z(bytes: Uint8Array): Array<any>;

/**
 * Inflate a raw DEFLATE stream (no zlib/gzip header).
 *
 * `expected_size` is the exact uncompressed size from a trusted container
 * directory. The value is also a hard upper bound and is checked against the
 * fixed API limit before `miniz_oxide` allocates or grows its output vector.
 * The optional wasm-bindgen shape is retained for ABI compatibility, but an
 * omitted value fails explicitly; there is no unbounded fallback.
 */
export function inflate_raw(bytes: Uint8Array, expected_size?: number | null): Uint8Array;

/**
 * Decode a raw LZMA1 stream given explicit props, dictionary size, and the
 * uncompressed output size.
 *
 * `props` is the 5-byte LZMA props header in the *standard* encoding
 * (1 byte lc/lp/pb + 4 bytes LE dict size). If only the 1-byte lc/lp/pb is
 * supplied, `dict_size` is used to synthesise the 4 dict bytes.
 */
export function lzma_decode(props: Uint8Array, dict_size: number, data: Uint8Array, out_size: bigint): Uint8Array;
