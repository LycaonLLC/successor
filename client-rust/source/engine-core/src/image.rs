//! Embedded PNG/JPEG decoder → RGBA8. `no_std` + `alloc`.
//!
//! PNG supports the 8-bit, non-interlaced forms emitted by the asset pipeline.
//! JPEG decoding uses `zune-jpeg`. Both paths enforce the same bounded image
//! dimensions before returning uploadable pixels.

use alloc::vec;
use alloc::vec::Vec;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ImageError {
    BadSignature,
    Truncated,
    BadChunk,
    UnsupportedBitDepth,
    UnsupportedColorType,
    UnsupportedMime,
    DimensionsTooLarge,
    Interlaced,
    Inflate,
    Jpeg,
    BadFilter,
    MissingPalette,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RgbaImage {
    pub width: u32,
    pub height: u32,
    /// `width * height * 4` bytes.
    pub pixels: Vec<u8>,
}

const MAX_DIMENSION: u32 = 8_192;
const MAX_PIXELS: u64 = 67_108_864;

fn validate_dimensions(width: u32, height: u32) -> Result<usize, ImageError> {
    if width == 0
        || height == 0
        || width > MAX_DIMENSION
        || height > MAX_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err(ImageError::DimensionsTooLarge);
    }
    (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or(ImageError::DimensionsTooLarge)
}

pub fn decode_image(mime: &str, bytes: &[u8]) -> Result<RgbaImage, ImageError> {
    match mime {
        "image/png" => decode_png(bytes),
        "image/jpeg" => decode_jpeg(bytes),
        _ => Err(ImageError::UnsupportedMime),
    }
}

pub fn decode_jpeg(bytes: &[u8]) -> Result<RgbaImage, ImageError> {
    use zune_core::bytestream::ZCursor;
    use zune_core::colorspace::ColorSpace;
    use zune_core::options::DecoderOptions;
    use zune_jpeg::JpegDecoder;

    let options = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGBA);
    let mut decoder = JpegDecoder::new_with_options(ZCursor::new(bytes), options);
    decoder.decode_headers().map_err(|_| ImageError::Jpeg)?;
    let (width, height) = decoder.dimensions().ok_or(ImageError::Jpeg)?;
    let width = u32::try_from(width).map_err(|_| ImageError::DimensionsTooLarge)?;
    let height = u32::try_from(height).map_err(|_| ImageError::DimensionsTooLarge)?;
    let expected = validate_dimensions(width, height)?;
    let pixels = decoder.decode().map_err(|_| ImageError::Jpeg)?;
    if pixels.len() != expected {
        return Err(ImageError::Jpeg);
    }
    Ok(RgbaImage {
        width,
        height,
        pixels,
    })
}
const SIG: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];

fn be_u32(b: &[u8], o: usize) -> Result<u32, ImageError> {
    if o + 4 > b.len() {
        return Err(ImageError::Truncated);
    }
    Ok((b[o] as u32) << 24 | (b[o + 1] as u32) << 16 | (b[o + 2] as u32) << 8 | b[o + 3] as u32)
}

pub fn decode_png(bytes: &[u8]) -> Result<RgbaImage, ImageError> {
    if bytes.len() < 8 || bytes[..8] != SIG {
        return Err(ImageError::BadSignature);
    }
    let mut pos = 8usize;
    let mut width = 0u32;
    let mut height = 0u32;
    let mut color_type = 0u8;
    let mut palette: Vec<[u8; 3]> = Vec::new();
    let mut trns: Vec<u8> = Vec::new();
    let mut idat: Vec<u8> = Vec::new();
    let mut seen_ihdr = false;

    while pos + 8 <= bytes.len() {
        let len = be_u32(bytes, pos)? as usize;
        let ctype = &bytes[pos + 4..pos + 8];
        let data_start = pos + 8;
        let data_end = data_start.checked_add(len).ok_or(ImageError::BadChunk)?;
        if data_end + 4 > bytes.len() {
            return Err(ImageError::Truncated);
        }
        let data = &bytes[data_start..data_end];
        match ctype {
            b"IHDR" => {
                if len < 13 {
                    return Err(ImageError::BadChunk);
                }
                width = be_u32(data, 0)?;
                height = be_u32(data, 4)?;
                let bit_depth = data[8];
                color_type = data[9];
                let interlace = data[12];
                if bit_depth != 8 {
                    return Err(ImageError::UnsupportedBitDepth);
                }
                if interlace != 0 {
                    return Err(ImageError::Interlaced);
                }
                if !matches!(color_type, 0 | 2 | 3 | 4 | 6) {
                    return Err(ImageError::UnsupportedColorType);
                }
                seen_ihdr = true;
                validate_dimensions(width, height)?;
            }
            b"PLTE" => {
                for c in data.chunks_exact(3) {
                    palette.push([c[0], c[1], c[2]]);
                }
            }
            b"tRNS" => trns = data.to_vec(),
            b"IDAT" => idat.extend_from_slice(data),
            b"IEND" => break,
            _ => {}
        }
        pos = data_end + 4; // skip CRC
    }
    if !seen_ihdr {
        return Err(ImageError::BadChunk);
    }

    let channels: usize = match color_type {
        0 => 1,
        2 => 3,
        3 => 1,
        4 => 2,
        6 => 4,
        _ => return Err(ImageError::UnsupportedColorType),
    };
    let raw =
        miniz_oxide::inflate::decompress_to_vec_zlib(&idat).map_err(|_| ImageError::Inflate)?;

    let w = width as usize;
    let h = height as usize;
    let stride = w
        .checked_mul(channels)
        .ok_or(ImageError::DimensionsTooLarge)?;
    let unfiltered = unfilter(&raw, w, h, channels, stride)?;

    // Expand to RGBA8.
    let mut pixels = vec![0u8; validate_dimensions(width, height)?];
    for i in 0..(w * h) {
        let src = i * channels;
        let dst = i * 4;
        match color_type {
            0 => {
                let g = unfiltered[src];
                pixels[dst] = g;
                pixels[dst + 1] = g;
                pixels[dst + 2] = g;
                pixels[dst + 3] = 255;
            }
            2 => {
                pixels[dst] = unfiltered[src];
                pixels[dst + 1] = unfiltered[src + 1];
                pixels[dst + 2] = unfiltered[src + 2];
                pixels[dst + 3] = 255;
            }
            3 => {
                let idx = unfiltered[src] as usize;
                let rgb = *palette.get(idx).ok_or(ImageError::MissingPalette)?;
                pixels[dst] = rgb[0];
                pixels[dst + 1] = rgb[1];
                pixels[dst + 2] = rgb[2];
                pixels[dst + 3] = trns.get(idx).copied().unwrap_or(255);
            }
            4 => {
                let g = unfiltered[src];
                pixels[dst] = g;
                pixels[dst + 1] = g;
                pixels[dst + 2] = g;
                pixels[dst + 3] = unfiltered[src + 1];
            }
            6 => {
                pixels[dst..dst + 4].copy_from_slice(&unfiltered[src..src + 4]);
            }
            _ => unreachable!(),
        }
    }
    Ok(RgbaImage {
        width,
        height,
        pixels,
    })
}

/// Reverse PNG scanline filtering in place, returning the raw pixel bytes
/// (filter bytes stripped).
fn unfilter(
    raw: &[u8],
    _w: usize,
    h: usize,
    channels: usize,
    stride: usize,
) -> Result<Vec<u8>, ImageError> {
    let bpp = channels; // 8-bit → bytes-per-pixel == channels
    let expected = h * (stride + 1);
    if raw.len() < expected {
        return Err(ImageError::Truncated);
    }
    let mut out = vec![0u8; h * stride];
    for y in 0..h {
        let filter = raw[y * (stride + 1)];
        let src = y * (stride + 1) + 1;
        let dst = y * stride;
        for x in 0..stride {
            let cur = raw[src + x];
            let a = if x >= bpp { out[dst + x - bpp] } else { 0 };
            let b = if y > 0 { out[dst - stride + x] } else { 0 };
            let c = if y > 0 && x >= bpp {
                out[dst - stride + x - bpp]
            } else {
                0
            };
            let recon = match filter {
                0 => cur,
                1 => cur.wrapping_add(a),
                2 => cur.wrapping_add(b),
                3 => cur.wrapping_add(((a as u16 + b as u16) / 2) as u8),
                4 => cur.wrapping_add(paeth(a, b, c)),
                _ => return Err(ImageError::BadFilter),
            };
            out[dst + x] = recon;
        }
    }
    Ok(out)
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let (a, b, c) = (a as i32, b as i32, c as i32);
    let p = a + b - c;
    let pa = (p - a).abs();
    let pb = (p - b).abs();
    let pc = (p - c).abs();
    if pa <= pb && pa <= pc {
        a as u8
    } else if pb <= pc {
        b as u8
    } else {
        c as u8
    }
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;

    /// Build a minimal RGBA PNG with zlib-stored IDAT and filter byte 0.
    fn build_rgba_png(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
        fn chunk(out: &mut Vec<u8>, tag: &[u8; 4], data: &[u8]) {
            out.extend_from_slice(&(data.len() as u32).to_be_bytes());
            out.extend_from_slice(tag);
            out.extend_from_slice(data);
            // CRC ignored by decoder; write zeros.
            out.extend_from_slice(&[0, 0, 0, 0]);
        }
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&w.to_be_bytes());
        ihdr.extend_from_slice(&h.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // depth 8, RGBA, deflate, filter 0, no interlace

        // Raw scanlines with filter byte 0.
        let mut raw = Vec::new();
        let stride = (w * 4) as usize;
        for y in 0..h as usize {
            raw.push(0u8);
            raw.extend_from_slice(&rgba[y * stride..(y + 1) * stride]);
        }
        let idat = miniz_oxide::deflate::compress_to_vec_zlib(&raw, 6);

        let mut out = Vec::new();
        out.extend_from_slice(&SIG);
        chunk(&mut out, b"IHDR", &ihdr);
        chunk(&mut out, b"IDAT", &idat);
        chunk(&mut out, b"IEND", &[]);
        out
    }

    #[test]
    fn roundtrips_2x2_rgba() {
        let src = vec![
            255, 0, 0, 255, 0, 255, 0, 255, // row 0: red, green
            0, 0, 255, 255, 255, 255, 0, 128, // row 1: blue, semi-yellow
        ];
        let png = build_rgba_png(2, 2, &src);
        let img = decode_png(&png).expect("decode");
        assert_eq!(img.width, 2);
        assert_eq!(img.height, 2);
        assert_eq!(img.pixels, src);
    }

    #[test]
    fn dispatches_png_and_rejects_unknown_mime() {
        let src = [7, 11, 13, 255];
        let png = build_rgba_png(1, 1, &src);
        assert_eq!(decode_image("image/png", &png).expect("PNG").pixels, src);
        assert_eq!(
            decode_image("image/webp", &png),
            Err(ImageError::UnsupportedMime)
        );
    }

    #[test]
    fn dispatches_embedded_corpus_jpeg_as_rgba() {
        let bytes = include_bytes!(
            "../../../../client-3d/public/assets/items/custom/accessories/field_cap.glb"
        );
        let document = crate::glb::parse(bytes).expect("field-cap GLB");
        let image = document
            .images
            .iter()
            .find(|image| image.mime_type == "image/jpeg")
            .expect("embedded JPEG");
        let decoded = decode_image(&image.mime_type, &image.bytes).expect("JPEG");
        assert_eq!(
            decoded.pixels.len(),
            decoded.width as usize * decoded.height as usize * 4
        );
        assert!(decoded.width <= MAX_DIMENSION && decoded.height <= MAX_DIMENSION);
    }

    #[test]
    fn rejects_oversized_png_before_inflate() {
        let mut png = build_rgba_png(1, 1, &[0, 0, 0, 255]);
        png[16..20].copy_from_slice(&(MAX_DIMENSION + 1).to_be_bytes());
        assert_eq!(decode_png(&png), Err(ImageError::DimensionsTooLarge));
    }

    #[test]
    fn rejects_non_png() {
        assert_eq!(decode_png(&[0u8; 8]), Err(ImageError::BadSignature));
    }
}
