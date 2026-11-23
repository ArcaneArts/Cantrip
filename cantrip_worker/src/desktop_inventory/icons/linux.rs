use super::{SIZE, icon_png, image_limits, normalized, read_regular};
use cantrip_config::Environment;
use image::{DynamicImage, ImageDecoder, ImageReader};
use indexmap::IndexSet;
use resvg::{tiny_skia, usvg};
use std::{
    fs,
    io::Cursor,
    path::{Component, Path, PathBuf},
};

const SOURCE_BYTES: usize = 2 * 1024 * 1024;

pub(super) fn roots(environment: &Environment) -> Vec<PathBuf> {
    let home = environment.get("HOME").map(PathBuf::from);
    let data = environment
        .get("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| home.map(|home| home.join(".local/share")));
    let system = environment
        .get("XDG_DATA_DIRS")
        .filter(|value| !value.is_empty())
        .map(String::as_str)
        .unwrap_or("/usr/local/share:/usr/share");
    data.into_iter()
        .chain(std::env::split_paths(system).filter(|path| path.is_absolute()))
        .collect::<IndexSet<_>>()
        .into_iter()
        .collect()
}

pub(super) fn extract(application: &str, roots: &[PathBuf]) -> Option<Vec<u8>> {
    let normalized = normalized(application);
    let application = normalized.strip_suffix(".desktop").unwrap_or(&normalized);
    for root in roots {
        let Ok(entries) = fs::read_dir(root.join("applications")) else {
            continue;
        };
        for path in entries.flatten().map(|entry| entry.path()).take(4_096) {
            if path.extension().and_then(|value| value.to_str()) != Some("desktop") {
                continue;
            }
            let icon = read_regular(&path, 128 * 1024).and_then(|bytes| {
                let entry = std::str::from_utf8(&bytes).ok()?;
                desktop_icon(entry, application)
            });
            if let Some(icon) = icon
                && let Some(image) = resolve(&icon, roots)
            {
                return Some(image);
            }
        }
    }
    None
}

fn desktop_icon(contents: &str, application: &str) -> Option<String> {
    let mut section = false;
    let mut matches = false;
    let mut icon = None;
    for line in contents.lines().map(str::trim) {
        if line.starts_with('[') && line.ends_with(']') {
            section = line == "[Desktop Entry]";
            continue;
        }
        if !section || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key {
            "Name" | "StartupWMClass" => matches |= normalized(value) == application,
            "Exec" => {
                let executable = value
                    .split_whitespace()
                    .next()
                    .unwrap_or_default()
                    .trim_matches(['"', '\'']);
                matches |= Path::new(executable)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| normalized(name) == application);
            }
            "Icon" => icon = Some(value),
            _ => {}
        }
    }
    matches
        .then_some(icon?)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

fn resolve(icon: &str, roots: &[PathBuf]) -> Option<Vec<u8>> {
    let path = Path::new(icon);
    if path.is_absolute() {
        return decode(path);
    }
    let mut parts = path.components();
    if !matches!(parts.next(), Some(Component::Normal(_))) || parts.next().is_some() {
        return None;
    }
    let sizes = ["64x64", "128x128", "256x256", "48x48", "scalable"];
    let extensions = ["png", "svg", "xpm"];
    for root in roots {
        for size in sizes {
            let apps = root.join("icons/hicolor").join(size).join("apps");
            for extension in extensions {
                if let Some(image) = decode(&apps.join(format!("{icon}.{extension}"))) {
                    return Some(image);
                }
            }
        }
        for extension in extensions {
            if let Some(image) = decode(&root.join("pixmaps").join(format!("{icon}.{extension}"))) {
                return Some(image);
            }
        }
    }
    None
}

fn decode(path: &Path) -> Option<Vec<u8>> {
    let data = read_regular(path, SOURCE_BYTES)?;
    match path.extension().and_then(|value| value.to_str()) {
        Some("svg") => svg(&data),
        Some("xpm") => {
            let mut decoder = image_extras::xpm::XpmDecoder::new(Cursor::new(data)).ok()?;
            decoder.set_limits(image_limits()).ok()?;
            icon_png(DynamicImage::from_decoder(decoder).ok()?)
        }
        _ => {
            let mut reader = ImageReader::new(Cursor::new(data))
                .with_guessed_format()
                .ok()?;
            reader.limits(image_limits());
            icon_png(reader.decode().ok()?)
        }
    }
}

fn svg(data: &[u8]) -> Option<Vec<u8>> {
    let options = usvg::Options {
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: Box::new(|_, _, _| None),
            resolve_string: Box::new(|_, _| None),
        },
        ..usvg::Options::default()
    };
    let tree = usvg::Tree::from_data(data, &options).ok()?;
    let size = tree.size();
    let target = SIZE as f32;
    let scale = (target / size.width()).min(target / size.height());
    let shift = (
        (target - size.width() * scale) * 0.5,
        (target - size.height() * scale) * 0.5,
    );
    let transform = tiny_skia::Transform::from_row(scale, 0.0, 0.0, scale, shift.0, shift.1);
    let mut pixels = tiny_skia::Pixmap::new(SIZE, SIZE)?;
    resvg::render(&tree, transform, &mut pixels.as_mut());
    pixels.encode_png().ok()
}
