use crate::{
    error::{CuaError, ErrorCode, Result},
    target::{Bounds, MAX_IMAGE_PIXELS},
};

/// Native window records can contain empty or non-finite rectangles, including
/// transient system windows. Validate their actual frame before a native filter
/// initializer enters WindowServer; being offscreen or occluded is not invalid.
pub(super) fn native_frame(x: f64, y: f64, width: f64, height: f64) -> Result<Bounds> {
    let bounds = Bounds {
        x,
        y,
        width,
        height,
    };
    if bounds.validate().is_err() || !(x + width).is_finite() || !(y + height).is_finite() {
        return Err(CuaError::new(
            ErrorCode::CaptureFailed,
            "The native source has no valid capture rectangle.",
        ));
    }
    Ok(bounds)
}

/// Inventory describes the actual logical frame with a deliberately nominal
/// bounded 1x raster. Listing windows never constructs native capture filters.
/// Explicit capture refreshes this descriptor using the selected filter's real
/// content rectangle and point-to-pixel scale before producing any image.
pub(super) fn inventory_geometry(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(Bounds, f64, u32, u32)> {
    let bounds = native_frame(x, y, width, height)?;
    let (width, height) = output_size(bounds, 1.0)?;
    Ok((bounds, f64::from(width) / bounds.width, width, height))
}

/// Target coordinates remain logical points; only output pixels are downscaled.
pub(super) fn output_size(bounds: Bounds, scale: f64) -> Result<(u32, u32)> {
    bounds.validate()?;
    if !scale.is_finite() || scale <= 0.0 {
        return Err(CuaError::new(
            ErrorCode::CaptureFailed,
            "Invalid native display scale.",
        ));
    }
    let width = (bounds.width * scale).ceil();
    let height = (bounds.height * scale).ceil();
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err(CuaError::new(
            ErrorCode::CaptureFailed,
            "Invalid native capture dimensions.",
        ));
    }
    // Division before multiplication also handles enormous finite dimensions.
    const OUTPUT_PIXELS: u32 = 4_000_000;
    let ratio = (f64::from(OUTPUT_PIXELS) / width / height)
        .sqrt()
        .min(1.0)
        .min(16_384.0 / width)
        .min(16_384.0 / height);
    let width = (width * ratio)
        .floor()
        .max(1.0)
        .min(f64::from(OUTPUT_PIXELS)) as u32;
    let height = (height * ratio)
        .floor()
        .max(1.0)
        .min(f64::from(OUTPUT_PIXELS)) as u32;
    let height = height.min((OUTPUT_PIXELS / width).max(1));
    Ok((width, height))
}

pub(super) fn bounded_text(value: String, maximum: usize) -> String {
    let mut end = value.len().min(maximum);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

/// Validate the actual returned image layout before asking CoreGraphics to
/// copy its provider. Allow bounded native row padding above the RGBA budget.
pub(super) fn native_storage_length(width: u32, height: u32, stride: usize) -> Result<usize> {
    let row = (width as usize).checked_mul(4);
    let pixels = (width as usize).checked_mul(height as usize);
    let length = stride.checked_mul(height as usize);
    if row.is_none_or(|row| stride < row)
        || pixels.is_none_or(|pixels| pixels == 0 || pixels > MAX_IMAGE_PIXELS)
        || length.is_none_or(|length| length == 0 || length > 32 * 1024 * 1024)
    {
        return Err(CuaError::new(
            ErrorCode::CaptureFailed,
            "Invalid native image storage.",
        ));
    }
    Ok(length.expect("native storage length was validated"))
}

/// SCK's SDR CGImage is native BGRA. Copy rows explicitly: no desktop-origin
/// offset, vertical flip, stride padding, or premultiplied alpha enters PNG RGBA.
pub(super) fn bgra_to_rgba(
    bytes: &[u8],
    width: u32,
    height: u32,
    stride: usize,
    premultiplied: bool,
    opaque: bool,
    mut cancelled: impl FnMut() -> bool,
) -> Result<Vec<u8>> {
    let length = native_storage_length(width, height, stride)?;
    if length > bytes.len() {
        return Err(CuaError::new(
            ErrorCode::CaptureFailed,
            "Invalid native image storage.",
        ));
    }
    let mut rgba = vec![0; width as usize * height as usize * 4];
    for y in 0..height as usize {
        if cancelled() {
            rgba.fill(0);
            return Err(CuaError::new(
                ErrorCode::Cancelled,
                "CUA request cancelled.",
            ));
        }
        for x in 0..width as usize {
            let source = &bytes[y * stride + x * 4..][..4];
            let alpha = if opaque { 255 } else { source[3] };
            let channel = |value: u8| {
                if premultiplied && alpha != 255 {
                    if alpha == 0 {
                        0
                    } else {
                        ((u32::from(value) * 255 + u32::from(alpha) / 2) / u32::from(alpha))
                            .min(255) as u8
                    }
                } else {
                    value
                }
            };
            rgba[(y * width as usize + x) * 4..][..4].copy_from_slice(&[
                channel(source[2]),
                channel(source[1]),
                channel(source[0]),
                alpha,
            ]);
        }
    }
    Ok(rgba)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bounds(width: f64, height: f64) -> Bounds {
        Bounds {
            x: -200.0,
            y: 900.0,
            width,
            height,
        }
    }
    #[test]
    fn dimensions_preserve_retina_and_downscale_large_displays() {
        assert_eq!(output_size(bounds(320.0, 200.0), 2.0).unwrap(), (640, 400));
        let (width, height) = output_size(bounds(3456.0, 2234.0), 2.0).unwrap();
        assert!((width as usize * height as usize) <= MAX_IMAGE_PIXELS);
        assert!((f64::from(width) / f64::from(height) - 3456.0 / 2234.0).abs() < 0.002);
        for (w, h) in [(1.0, 1e30), (1e30, 1.0), (1e200, 1e200)] {
            let (w, h) = output_size(bounds(w, h), 1.0).unwrap();
            assert!(w > 0 && h > 0 && w as usize * h as usize <= MAX_IMAGE_PIXELS);
            assert!(w <= 16_384 && h <= 16_384);
        }
    }

    #[test]
    fn inventory_is_nominal_until_selected_capture_reports_native_scale() {
        let (frame, scale, width, height) =
            inventory_geometry(-2000.0, 700.0, 320.0, 240.0).unwrap();
        assert_eq!((frame.x, frame.y), (-2000.0, 700.0));
        assert_eq!((scale, width, height), (1.0, 320, 240));
        assert_eq!(output_size(frame, 2.0).unwrap(), (640, 480));
        let (frame, scale, width, height) = inventory_geometry(0.0, 0.0, 8000.0, 5000.0).unwrap();
        assert!(width as usize * height as usize <= 4_000_000);
        assert_eq!(scale, f64::from(width) / frame.width);
        assert!(scale < 1.0);
        assert!(inventory_geometry(0.0, 0.0, 0.0, 240.0).is_err());
        assert!(inventory_geometry(f64::NAN, 0.0, 320.0, 240.0).is_err());
    }
    #[test]
    fn invalid_geometry_rejected() {
        for value in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(output_size(bounds(value, 10.0), 1.0).is_err());
            assert!(output_size(bounds(10.0, 10.0), value).is_err());
        }
        assert!(output_size(bounds(f64::MAX, 10.0), 2.0).is_err());
    }

    #[test]
    fn native_frames_reject_empty_null_and_overflow_but_keep_offscreen_windows() {
        let offscreen = native_frame(-20000.0, -10000.0, 320.0, 200.0).unwrap();
        assert_eq!(
            (offscreen.x, offscreen.y, offscreen.width),
            (-20000.0, -10000.0, 320.0)
        );
        for (x, y, width, height) in [
            (0.0, 0.0, 0.0, 100.0),
            (0.0, 0.0, 100.0, 0.0),
            (0.0, 0.0, -1.0, 100.0),
            (f64::INFINITY, f64::INFINITY, 0.0, 0.0),
            (f64::NAN, 0.0, 100.0, 100.0),
            (0.0, 0.0, f64::INFINITY, 100.0),
            (f64::MAX, 0.0, f64::MAX, 1.0),
            (0.0, f64::MAX, 1.0, f64::MAX),
        ] {
            assert_eq!(
                native_frame(x, y, width, height).unwrap_err().code,
                ErrorCode::CaptureFailed
            );
        }
    }
    #[test]
    fn color_rows_stride_and_alpha_are_explicit() {
        let pixels = bgra_to_rgba(
            &[0, 0, 255, 255, 9, 9, 9, 9, 255, 0, 0, 255, 8, 8, 8, 8],
            1,
            2,
            8,
            false,
            false,
            || false,
        )
        .unwrap();
        assert_eq!(pixels, [255, 0, 0, 255, 0, 0, 255, 255]);
        assert_eq!(
            bgra_to_rgba(&[32, 64, 128, 128], 1, 1, 4, true, false, || false).unwrap(),
            [255, 128, 64, 128]
        );
        assert_eq!(
            bgra_to_rgba(&[3, 4, 5, 0], 1, 1, 4, true, false, || false).unwrap(),
            [0, 0, 0, 0]
        );
        assert!(bgra_to_rgba(&[0; 4], 1, 1, 3, false, false, || false).is_err());
        assert!(bgra_to_rgba(&[0; 4], 1, 2, 4, false, false, || false).is_err());
        assert_eq!(
            bgra_to_rgba(&[0; 4], 1, 1, 4, false, false, || true)
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
    }
    #[test]
    fn unicode_metadata_is_not_split_in_the_middle_of_utf8() {
        assert_eq!(bounded_text("a😀b".into(), 4), "a");
        assert_eq!(bounded_text("a😀b".into(), 5), "a😀");
    }

    #[test]
    fn native_layout_is_bounded_before_copying_provider_bytes() {
        assert_eq!(native_storage_length(1, 1, 4).unwrap(), 4);
        assert_eq!(native_storage_length(3, 2, 64).unwrap(), 128);
        assert_eq!(
            native_storage_length(1, 1, 32 * 1024 * 1024).unwrap(),
            32 * 1024 * 1024
        );
        for (width, height, stride) in [
            (0, 1, 4),
            (1, 0, 4),
            (1, 1, 0),
            (2, 1, 7),
            (1, 2, usize::MAX),
            (1, 1, 32 * 1024 * 1024 + 1),
            (4096, 4096, 16384),
        ] {
            assert_eq!(
                native_storage_length(width, height, stride)
                    .unwrap_err()
                    .code,
                ErrorCode::CaptureFailed
            );
        }
    }
}
