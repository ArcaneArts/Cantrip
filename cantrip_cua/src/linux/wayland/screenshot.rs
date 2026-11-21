use crate::{
    backend::Raster,
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    target::Bounds,
};
use percent_encoding::percent_decode_str;
use rustix::fs::{Mode, OFlags, open};
use std::{
    ffi::OsString,
    fs::{self, File},
    io::BufReader,
    os::unix::{ffi::OsStringExt, fs::MetadataExt},
    path::{Component, Path, PathBuf},
    time::SystemTime,
};

const MAX_PNG_BYTES: usize = 128 * 1024 * 1024;

pub(super) fn portal_file(uri: &str, requested: SystemTime) -> Result<File> {
    let raw = uri
        .strip_prefix("file://")
        .filter(|value| value.starts_with('/') && !value.contains(['?', '#']))
        .ok_or_else(|| failed("The desktop portal returned an invalid screenshot URI."))?;
    let bytes: Vec<u8> = percent_decode_str(raw).collect();
    let path = PathBuf::from(OsString::from_vec(bytes));
    if !path.is_absolute()
        || path
            .components()
            .any(|segment| matches!(segment, Component::ParentDir | Component::CurDir))
    {
        return Err(failed(
            "The desktop portal returned an invalid screenshot path.",
        ));
    }

    let file = read_file(&path)?;
    let source = file
        .metadata()
        .map_err(|_| failed("Cannot inspect the portal screenshot."))?;
    let recent = |instant: std::io::Result<SystemTime>| instant.is_ok_and(|time| time >= requested);
    let temporary = path.starts_with(std::env::temp_dir())
        || std::env::var_os("XDG_RUNTIME_DIR").is_some_and(|root| {
            Path::new(&root).is_absolute() && path.starts_with(Path::new(&root))
        });
    if source.uid() == rustix::process::geteuid().as_raw()
        && (recent(source.created()) || (temporary && recent(source.modified())))
        && fs::symlink_metadata(&path).is_ok_and(|current| {
            current.is_file() && source.dev() == current.dev() && source.ino() == current.ino()
        })
    {
        // The reply transfers a fresh screenshot. Keep the readable fd, then
        // discard that verified copy so a continuous view leaves no images.
        let _ = fs::remove_file(path);
    }
    Ok(file)
}

pub(super) fn read_file(path: &Path) -> Result<File> {
    let fd = open(
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK,
        Mode::empty(),
    )
    .map_err(|_| failed("Cannot open the Wayland screenshot."))?;
    let file = File::from(fd);
    let metadata = file
        .metadata()
        .map_err(|_| failed("Cannot inspect the Wayland screenshot."))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_PNG_BYTES as u64 {
        return Err(failed("The Wayland screenshot is not a bounded image."));
    }
    Ok(file)
}

pub(super) fn decode(
    file: File,
    desktop: Bounds,
    output: Bounds,
    cancel: &Cancellation,
) -> Result<Raster> {
    let mut decoder = png::Decoder::new_with_limits(
        BufReader::new(file),
        png::Limits {
            bytes: MAX_PNG_BYTES,
        },
    );
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|_| failed("The Wayland screenshot is not a valid PNG."))?;
    let (width, height) = reader.info().size();
    let region = crop(width, height, desktop, output)?;
    let size = reader
        .output_buffer_size()
        .filter(|size| *size <= MAX_PNG_BYTES)
        .ok_or_else(|| failed("The Wayland screenshot exceeds the pixel limit."))?;
    cancel.check()?;
    let mut pixels = vec![0; size];
    let info = reader
        .next_frame(&mut pixels)
        .map_err(|_| failed("The Wayland screenshot could not be decoded."))?;
    if info.width != width || info.height != height {
        return Err(failed("The desktop screenshot is not a complete frame."));
    }
    let channels = info.color_type.samples();
    let (scaled_width, scaled_height) =
        super::capture::scaled_dimensions(region.width, region.height)?;
    let mut rgba = Vec::with_capacity(scaled_width as usize * scaled_height as usize * 4);
    for row in 0..scaled_height {
        cancel.check()?;
        let y = region.top + sample(row, region.height, scaled_height);
        for col in 0..scaled_width {
            let x = region.left + sample(col, region.width, scaled_width);
            let offset = y as usize * info.line_size + x as usize * channels;
            let pixel = &pixels[offset..offset + channels];
            let opacity =
                |channel: u8, alpha: u8| ((u16::from(channel) * u16::from(alpha)) / 255) as u8;
            let rgb = match pixel {
                [gray] => [*gray, *gray, *gray, 255],
                [gray, alpha] => [
                    opacity(*gray, *alpha),
                    opacity(*gray, *alpha),
                    opacity(*gray, *alpha),
                    255,
                ],
                [r, g, b] => [*r, *g, *b, 255],
                [r, g, b, alpha] => [
                    opacity(*r, *alpha),
                    opacity(*g, *alpha),
                    opacity(*b, *alpha),
                    255,
                ],
                _ => {
                    return Err(failed(
                        "The Wayland screenshot has an unsupported color format.",
                    ));
                }
            };
            rgba.extend_from_slice(&rgb);
        }
    }
    Ok(Raster {
        width: scaled_width,
        height: scaled_height,
        rgba,
    })
}

fn sample(position: u32, source: u32, destination: u32) -> u32 {
    (u64::from(position) * u64::from(source) / u64::from(destination)) as u32
}

struct Region {
    left: u32,
    top: u32,
    width: u32,
    height: u32,
}

fn crop(width: u32, height: u32, desktop: Bounds, output: Bounds) -> Result<Region> {
    desktop.validate()?;
    output.validate()?;
    let sx = f64::from(width) / desktop.width;
    let sy = f64::from(height) / desktop.height;
    if width == 0
        || height == 0
        || (desktop.height * sx - f64::from(height)).abs() > 1.
            && (desktop.width * sy - f64::from(width)).abs() > 1.
    {
        return Err(failed(
            "The desktop screenshot does not match the captured output layout.",
        ));
    }
    let left = (output.x - desktop.x) * sx;
    let top = (output.y - desktop.y) * sy;
    let right = left + output.width * sx;
    let bottom = top + output.height * sy;
    // Crop inward if a scaled boundary falls between pixels. Neighboring
    // monitors must never contribute pixels to the selected output.
    let left = left.ceil() as u32;
    let top = top.ceil() as u32;
    let right = right.floor() as u32;
    let bottom = bottom.floor() as u32;
    if output.x < desktop.x
        || output.y < desktop.y
        || right > width
        || bottom > height
        || right <= left
        || bottom <= top
    {
        return Err(failed(
            "The selected output is outside the desktop screenshot.",
        ));
    }
    let region = Region {
        left,
        top,
        width: right - left,
        height: bottom - top,
    };
    if u64::from(region.width) * u64::from(region.height) > MAX_PNG_BYTES as u64 {
        return Err(failed(
            "The selected Wayland screenshot region exceeds the size limit.",
        ));
    }
    Ok(region)
}

fn failed(message: &'static str) -> CuaError {
    CuaError::new(ErrorCode::CaptureFailed, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Seek, SeekFrom};

    #[test]
    fn screenshot_crop_excludes_the_neighbor_at_scaled_negative_origins() {
        let mut file = tempfile::tempfile().unwrap();
        {
            let mut encoder = png::Encoder::new(&mut file, 8, 4);
            encoder.set_color(png::ColorType::Rgba);
            let mut writer = encoder.write_header().unwrap();
            let pixels: Vec<_> = (0..4)
                .flat_map(|_| {
                    (0..8).flat_map(|column| {
                        if column < 4 {
                            [255, 17, 59, 255]
                        } else {
                            [34, 91, 166, 255]
                        }
                    })
                })
                .collect();
            writer.write_image_data(&pixels).unwrap();
            writer.finish().unwrap();
        }
        file.seek(SeekFrom::Start(0)).unwrap();
        let desktop = Bounds {
            x: -2.,
            y: -1.,
            width: 4.,
            height: 2.,
        };
        let selected = Bounds {
            x: 0.,
            y: -1.,
            width: 2.,
            height: 2.,
        };
        let raster = decode(file, desktop, selected, &Cancellation::default()).unwrap();
        assert_eq!((raster.width, raster.height), (4, 4));
        assert!(
            raster
                .rgba
                .chunks_exact(4)
                .all(|pixel| pixel == [34, 91, 166, 255])
        );

        let wrong = crop(8, 8, desktop, selected);
        assert!(wrong.is_err());
    }
}
