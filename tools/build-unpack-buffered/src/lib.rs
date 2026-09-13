//! unpack-buffered — BottleShip's owned archive/codec decompression library.
//!
//! Consolidates the decompression primitives the game-ingestion pipeline needs
//! into one maintained Rust→wasm crate (replacing a scatter of hand-ports).
//!
//! All APIs operate on in-memory byte buffers — there is NO filesystem on
//! `wasm32-unknown-unknown`. Errors surface as JS exceptions (`Result<_, JsValue>`)
//! with a human-readable message rather than panicking.
//!
//! ## Exposed (wasm-bindgen) API
//! - `extract_7z(bytes) -> Array<{ name: string, data: Uint8Array }>`
//! - `inflate_raw(bytes, expected_size?) -> Uint8Array` (the size is required;
//!   omitting it fails closed)
//! - `lzma_decode(props, dict_size, data, out_size) -> Uint8Array`

use std::io::Cursor;

/// One decoded archive entry, collected with only sevenz_rust2::Error in scope
/// (the for_each_entries closure cannot return JsValue).
struct RawEntry {
    name: String,
    data: Vec<u8>,
}

use wasm_bindgen::prelude::*;

// ---------------------------------------------------------------------------
// 7z extraction
// ---------------------------------------------------------------------------

/// Extract every entry from an in-memory 7z archive.
///
/// Returns a JS `Array` of `{ name: string, data: Uint8Array }`. Directory
/// entries are skipped (only files are returned). Unsupported coders (BCJ2,
/// PPMd, AES-encrypted streams) surface as a JS exception with a clear message.
#[wasm_bindgen]
pub fn extract_7z(bytes: &[u8]) -> Result<js_sys::Array, JsValue> {
    use sevenz_rust2::ArchiveReader;

    // ArchiveReader wants an owned source; copy into a Vec so the reader owns
    // its backing store (the &[u8] is only borrowed for this call).
    let cursor = Cursor::new(bytes.to_vec());

    let mut reader =
        ArchiveReader::new(cursor, sevenz_rust2::Password::empty()).map_err(map_7z_err)?;

    // Collect inside the closure using only sevenz errors (the closure must
    // return Result<bool, sevenz_rust2::Error>), then marshal to JS afterward.
    let mut entries: Vec<RawEntry> = Vec::new();
    reader
        .for_each_entries(|entry, rdr| {
            if entry.is_directory() {
                return Ok(true);
            }
            let mut data = Vec::with_capacity(entry.size() as usize);
            // Drain the per-entry reader fully. Errors (e.g. unsupported coder)
            // propagate out of for_each_entries as sevenz_rust2::Error.
            rdr.read_to_end(&mut data)?;
            entries.push(RawEntry {
                name: entry.name().to_string(),
                data,
            });
            Ok(true)
        })
        .map_err(map_7z_err)?;

    let out = js_sys::Array::new();
    for e in &entries {
        let obj = js_sys::Object::new();
        set_prop(&obj, "name", &JsValue::from_str(&e.name))?;
        let arr = js_sys::Uint8Array::new_with_length(e.data.len() as u32);
        arr.copy_from(&e.data);
        set_prop(&obj, "data", &arr)?;
        out.push(&obj);
    }

    Ok(out)
}

fn set_prop(obj: &js_sys::Object, key: &str, val: &JsValue) -> Result<(), JsValue> {
    js_sys::Reflect::set(obj, &JsValue::from_str(key), val)
        .map(|_| ())
        .map_err(|_| JsValue::from_str("failed to set object property"))
}

fn map_7z_err(e: sevenz_rust2::Error) -> JsValue {
    // Surface unsupported-coder cases with a recognisable, actionable message.
    let msg = e.to_string();
    let hint = if msg.contains("BCJ2") {
        " (BCJ2 filter not supported)"
    } else if msg.contains("PPMd") || msg.contains("PPMD") {
        " (PPMd coder not supported in this build)"
    } else if msg.contains("password") || msg.contains("AES") || msg.contains("encrypt") {
        " (AES-encrypted archives not supported)"
    } else {
        ""
    };
    JsValue::from_str(&format!("7z extraction failed: {msg}{hint}"))
}

// ---------------------------------------------------------------------------
// raw DEFLATE
// ---------------------------------------------------------------------------

/// Maximum output admitted by the buffered raw-DEFLATE API.
///
/// This is deliberately independent of the caller-provided size. A forged
/// archive metadata value must not be able to make `miniz_oxide` reserve a
/// multi-gigabyte vector before it has decoded anything.
const MAX_INFLATE_OUTPUT_BYTES: usize = 64 * 1024 * 1024;

fn inflate_raw_bounded(
    bytes: &[u8],
    expected_size: u32,
    max_output_size: usize,
) -> Result<Vec<u8>, String> {
    let expected_size = expected_size as usize;
    if expected_size > max_output_size {
        return Err(format!(
            "expected output size {expected_size} exceeds the {max_output_size}-byte limit"
        ));
    }

    let output = miniz_oxide::inflate::decompress_to_vec_with_limit(bytes, expected_size)
        .map_err(|error| format!("bounded decode failed: {error}"))?;
    if output.len() != expected_size {
        return Err(format!(
            "decoded output size {} does not match expected size {expected_size}",
            output.len()
        ));
    }
    Ok(output)
}

/// Inflate a raw DEFLATE stream (no zlib/gzip header).
///
/// `expected_size` is the exact uncompressed size from a trusted container
/// directory. The value is also a hard upper bound and is checked against the
/// fixed API limit before `miniz_oxide` allocates or grows its output vector.
/// The optional wasm-bindgen shape is retained for ABI compatibility, but an
/// omitted value fails explicitly; there is no unbounded fallback.
#[wasm_bindgen]
pub fn inflate_raw(bytes: &[u8], expected_size: Option<u32>) -> Result<Vec<u8>, JsValue> {
    let expected_size = expected_size
        .ok_or_else(|| JsValue::from_str("inflate_raw requires an exact expected output size"))?;
    inflate_raw_bounded(bytes, expected_size, MAX_INFLATE_OUTPUT_BYTES)
        .map_err(|error| JsValue::from_str(&format!("inflate_raw failed: {error}")))
}

#[cfg(test)]
mod tests {
    use super::inflate_raw_bounded;

    fn encoded(input: &[u8]) -> Vec<u8> {
        miniz_oxide::deflate::compress_to_vec(input, 6)
    }

    #[test]
    fn valid_stream_is_byte_equivalent_at_the_declared_size() {
        let input = b"stable decompressor output";
        let output = inflate_raw_bounded(&encoded(input), input.len() as u32, 128).unwrap();
        assert_eq!(output, input);
    }

    #[test]
    fn valid_empty_stream_is_accepted_at_zero_size() {
        let output = inflate_raw_bounded(&encoded(b""), 0, 128).unwrap();
        assert!(output.is_empty());
    }

    #[test]
    fn forged_larger_expected_size_is_rejected() {
        let input = b"actual output";
        let error =
            inflate_raw_bounded(&encoded(input), (input.len() + 1) as u32, 128).unwrap_err();
        assert!(error.contains("does not match expected size"), "{error}");
    }

    #[test]
    fn expansion_beyond_configured_cap_is_rejected_before_decode() {
        let error = inflate_raw_bounded(&encoded(b"too large"), 9, 8).unwrap_err();
        assert!(error.contains("exceeds the 8-byte limit"), "{error}");
    }

    #[test]
    fn truncated_stream_is_rejected() {
        let input = b"truncated compressed stream";
        let mut compressed = encoded(input);
        compressed.pop();
        let error = inflate_raw_bounded(&compressed, input.len() as u32, 128).unwrap_err();
        assert!(error.contains("decode failed"), "{error}");
    }

    #[test]
    fn trailing_output_is_rejected_by_the_exact_bound() {
        let input = b"prefix plus trailing output";
        let error = inflate_raw_bounded(&encoded(input), 6, 128).unwrap_err();
        assert!(error.contains("decode failed"), "{error}");
    }
}

// ---------------------------------------------------------------------------
// LZMA1
// ---------------------------------------------------------------------------

/// Decode a raw LZMA1 stream given explicit props, dictionary size, and the
/// uncompressed output size.
///
/// `props` is the 5-byte LZMA props header in the *standard* encoding
/// (1 byte lc/lp/pb + 4 bytes LE dict size). If only the 1-byte lc/lp/pb is
/// supplied, `dict_size` is used to synthesise the 4 dict bytes.
#[wasm_bindgen]
pub fn lzma_decode(
    props: &[u8],
    dict_size: u32,
    data: &[u8],
    out_size: u64,
) -> Result<Vec<u8>, JsValue> {
    use lzma_rs::decompress::{Options, UnpackedSize};

    // lzma-rs parses a 5-byte props header (1 byte lc/lp/pb + 4 bytes LE dict
    // size) from the stream, then the compressed payload. We pass the
    // uncompressed size out-of-band via UnpackedSize::UseProvided, so the 8-byte
    // size field is NOT part of the framing here.
    let mut framed = Vec::with_capacity(5 + data.len());

    if props.len() >= 5 {
        framed.extend_from_slice(&props[..5]);
    } else if !props.is_empty() {
        // 1-byte lc/lp/pb form: synthesise the 4 dict-size bytes from dict_size.
        framed.push(props[0]);
        framed.extend_from_slice(&dict_size.to_le_bytes());
    } else {
        return Err(JsValue::from_str("lzma_decode: empty props"));
    }
    framed.extend_from_slice(data);

    let mut input = Cursor::new(framed);
    let mut out: Vec<u8> = Vec::with_capacity(out_size as usize);

    let opts = Options {
        unpacked_size: UnpackedSize::UseProvided(Some(out_size)),
        ..Default::default()
    };

    lzma_rs::lzma_decompress_with_options(&mut input, &mut out, &opts)
        .map_err(|e| JsValue::from_str(&format!("lzma_decode failed: {e:?}")))?;

    Ok(out)
}
