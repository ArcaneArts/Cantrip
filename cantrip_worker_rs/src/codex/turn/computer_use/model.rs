use crate::{
    computer_use::{HostEvaluation, HostSnapshot},
    desktop_inventory::preview::ModelImage,
    metadata::Signal,
};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_crypto::Zeroizing;
use cantrip_wire::{Value, value::json};
use image::{
    ImageBuffer, ImageDecoder, ImageEncoder, Pixel,
    codecs::png::{PngDecoder, PngEncoder},
};
use sha2::{Digest, Sha256};
use std::io::Cursor;
use tokio::sync::Semaphore;

const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024 / 2;
const MAX_MODEL_PIXELS: u32 = 600_000;
static ENCODING: Semaphore = Semaphore::const_new(4);

pub(super) fn reset() -> Value {
    json!({"content":vec![json!({"type":"text","text":"Computer-use JavaScript state and target attachment reset. No native input was performed."})]})
}

pub(super) async fn result(
    output: HostEvaluation,
    signal: Signal,
) -> Result<(Value, Option<ModelImage>)> {
    signal.check()?;
    let HostEvaluation {
        value,
        images,
        input_receipts,
    } = output;
    let mut content = Vec::new();
    let mut metadata = Vec::new();
    let mut latest = None;
    if !images.is_empty() {
        ensure!(images.len() <= 2, "Computer-use image capacity reached.");
        let slot = ENCODING
            .try_acquire()
            .context("Computer-use image encoding capacity reached.")?;
        let decoding = signal.clone();
        let work = tokio::task::spawn_blocking(move || {
            let _slot = slot;
            images
                .into_iter()
                .map(|snapshot| {
                    decoding.check()?;
                    encode(snapshot).map_err(|_| {
                        anyhow::anyhow!("The computer-use image could not be encoded.")
                    })
                })
                .collect::<Result<Vec<_>>>()
        });
        let images = tokio::select! {
            biased;
            reason = signal.cancelled() => return Err(reason.into()),
            images = work => images??,
        };
        latest = images.last().cloned();
        for image in images {
            metadata.push(json!({"native":image.native,"model":image.model}));
            content.push(json!({"type":"image","mimeType":"image/png","data":image.png}));
        }
    }
    let mut report = json!({"value":value});
    if !input_receipts.is_empty() {
        report["inputAttempts"] = json!(
            input_receipts
                .iter()
                .map(|receipt| { json!({"method":receipt["method"],"outcome":receipt["outcome"]}) })
                .collect::<Vec<_>>()
        );
        report["inputVerification"] = json!(
            "These are dispatch receipts, not proof that the application reacted or produced sound. Unknown remains unverified even when the final expression is a snapshot. Do not claim the note played or the click worked without observed evidence or user confirmation; do not replay uncertain input."
        );
    }
    report["images"] = json!(metadata);
    report["coordinates"] = json!(
        "Target-local logical points. For model image pixels use x * logicalWidth / model.width and y * logicalHeight / model.height. moveCursor changes the logical cursor only; movePointer sends actual pointer movement on the assigned Linux desktop."
    );
    signal.check()?;
    content.insert(0, json!({"type":"text","text":report.stringify()}));
    Ok((json!({"content":content}), latest))
}

fn encode(snapshot: HostSnapshot) -> Result<ModelImage> {
    let image = &snapshot.metadata["image"];
    let width = image["width"].as_u64().context("Image width is missing.")? as u32;
    let height = image["height"]
        .as_u64()
        .context("Image height is missing.")? as u32;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(32 * 1024 * 1024);
    limits.max_image_width = Some(width);
    limits.max_image_height = Some(height);
    let decoder = PngDecoder::with_limits(Cursor::new(&*snapshot.pixels), limits)?;
    let color = decoder.color_type();
    ensure!(
        decoder.dimensions() == (width, height),
        "Image dimensions changed."
    );
    let mut raw = Zeroizing::new(vec![0; usize::try_from(decoder.total_bytes())?]);
    decoder.read_image(&mut raw)?;
    let (bytes, width, height) = if snapshot.pixels.len() <= MAX_IMAGE_BYTES {
        (snapshot.pixels, width, height)
    } else {
        let scale = (f64::from(MAX_MODEL_PIXELS) / (f64::from(width) * f64::from(height)))
            .sqrt()
            .min(1.0);
        let mut size = (
            (f64::from(width) * scale).floor().max(1.0) as u32,
            (f64::from(height) * scale).floor().max(1.0) as u32,
        );
        if size.0 > size.1 {
            size.0 = size.0.min(MAX_MODEL_PIXELS / size.1);
        } else {
            size.1 = size.1.min(MAX_MODEL_PIXELS / size.0);
        }
        let pixels = match color {
            image::ColorType::L8 => resize::<image::Luma<u8>>(&raw, (width, height), size)?,
            image::ColorType::La8 => resize::<image::LumaA<u8>>(&raw, (width, height), size)?,
            image::ColorType::Rgb8 => resize::<image::Rgb<u8>>(&raw, (width, height), size)?,
            image::ColorType::Rgba8 => resize::<image::Rgba<u8>>(&raw, (width, height), size)?,
            _ => anyhow::bail!("Unexpected native image color format."),
        };
        let mut encoded = Zeroizing::new(Vec::new());
        PngEncoder::new(&mut *encoded).write_image(&pixels, size.0, size.1, color.into())?;
        (encoded, size.0, size.1)
    };
    ensure!(
        bytes.len() <= MAX_IMAGE_BYTES,
        "Computer-use image byte limit exceeded."
    );
    let sha: String = Sha256::digest(&*bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(ModelImage {
        native: snapshot.metadata,
        model: json!({"width":width,"height":height,"byteCount":bytes.len(),"sha256":sha}),
        png: STANDARD.encode(&*bytes).into(),
    })
}

fn resize<P: Pixel<Subpixel = u8> + 'static>(
    raw: &[u8],
    source: (u32, u32),
    size: (u32, u32),
) -> Result<Zeroizing<Vec<u8>>> {
    let view = ImageBuffer::<P, _>::from_raw(source.0, source.1, raw)
        .context("Unexpected native image length.")?;
    let scaled =
        image::imageops::resize(&view, size.0, size.1, image::imageops::FilterType::Lanczos3);
    Ok(Zeroizing::new(scaled.into_raw()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::codecs::png::{CompressionType, FilterType};

    #[test]
    fn oversized_capture_keeps_native_geometry_and_bounds_model_image() -> Result<()> {
        let (width, height) = (1100_u32, 1000_u32);
        let mut png = Zeroizing::new(Vec::new());
        PngEncoder::new_with_quality(
            &mut *png,
            CompressionType::Uncompressed,
            FilterType::NoFilter,
        )
        .write_image(
            &vec![129; (width * height * 4) as usize],
            width,
            height,
            image::ExtendedColorType::Rgba8,
        )?;
        assert!(png.len() > MAX_IMAGE_BYTES);
        let metadata = json!({"image":json!({"width":width,"height":height})});
        let image = encode(HostSnapshot {
            metadata: metadata.clone(),
            pixels: png,
        })?;
        assert_eq!(image.native, metadata);
        let bytes = STANDARD.decode(image.png.as_str().unwrap())?;
        let decoder = PngDecoder::new(Cursor::new(&bytes))?;
        let (model_width, model_height) = decoder.dimensions();
        assert!(model_width < width && model_height < height);
        assert!(model_width * model_height <= MAX_MODEL_PIXELS);
        assert!(bytes.len() <= MAX_IMAGE_BYTES);
        assert_eq!(image.model["width"], json!(model_width));
        assert_eq!(image.model["height"], json!(model_height));
        assert_eq!(image.model["byteCount"], json!(bytes.len()));
        Ok(())
    }
}
