#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

use super::Inventory;
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_config::Environment;
use cantrip_wire::{Value, value::json};
use futures::{StreamExt, stream};
use image::{DynamicImage, ImageFormat, ImageReader, Limits, RgbaImage};
use indexmap::IndexSet;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::{Mutex, Semaphore};
use unicode_normalization::UnicodeNormalization;

const SIZE: u32 = 64;
const CACHED_BYTES: usize = 128_000;
const MISSING_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const CONCURRENCY: usize = 4;

pub(super) fn key(application: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"v1\0");
    hash.update(crate::platform::platform().as_bytes());
    hash.update(b"\0");
    hash.update(normalized(application).as_bytes());
    let mut key = "desktop-app-v1-".to_owned();
    for byte in &hash.finalize()[..20] {
        use std::fmt::Write;
        let _ = write!(key, "{byte:02x}");
    }
    key
}

fn normalized(application: &str) -> String {
    application
        .trim_matches(cantrip_wire::text::whitespace)
        .nfkc()
        .collect::<String>()
        .to_lowercase()
}

pub(crate) struct Store {
    directory: PathBuf,
    slots: Semaphore,
    keys: [Mutex<()>; 16],
    #[cfg(target_os = "macos")]
    home: Option<PathBuf>,
    #[cfg(target_os = "linux")]
    roots: Vec<PathBuf>,
}

impl Store {
    pub(crate) fn new(data: &Path, _environment: &Environment) -> Self {
        Self {
            directory: data.join("desktop").join("application-icons"),
            slots: Semaphore::new(CONCURRENCY),
            keys: Default::default(),
            #[cfg(target_os = "macos")]
            home: _environment
                .get("HOME")
                .filter(|home| !home.is_empty())
                .map(PathBuf::from),
            #[cfg(target_os = "linux")]
            roots: linux::roots(_environment),
        }
    }

    pub(crate) async fn resolve(&self, inventory: &Inventory, keys: &Value) -> Vec<Value> {
        let keys: IndexSet<_> = keys
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        stream::iter(keys.into_iter().map(|key| async move {
            // A key supplied by the viewer can only select an application in
            // this surface's inventory. It never becomes a lookup path alone.
            let application = inventory.windows.iter().find_map(|window| {
                (window["iconKey"] == key.as_str())
                    .then(|| window["application"].as_str())
                    .flatten()
            });
            let data = match application {
                Some(application) => self.load(&key, application).await,
                None => None,
            };
            json!({"key":key,"mimeType":"image/png","data":data})
        }))
        .buffered(CONCURRENCY)
        .collect()
        .await
    }

    async fn load(&self, key: &str, application: &str) -> Option<String> {
        let index = usize::from(*key.as_bytes().last()?) % self.keys.len();
        let _guard = self.keys[index].lock().await;
        let _slot = self.slots.acquire().await.ok()?;
        let png = self.directory.join(format!("{key}.png"));
        let missing = self.directory.join(format!("{key}.missing"));
        let (cached, fresh_negative) = {
            let png = png.clone();
            let missing = missing.clone();
            tokio::task::spawn_blocking(move || {
                let cached =
                    read_regular(&png, CACHED_BYTES).and_then(|bytes| normalize_png(&bytes));
                let fresh = fs::symlink_metadata(missing)
                    .ok()
                    .filter(fs::Metadata::is_file)
                    .and_then(|metadata| metadata.modified().ok()?.elapsed().ok())
                    .is_some_and(|age| age < MISSING_TTL);
                (cached, fresh)
            })
            .await
            .ok()?
        };
        if let Some(bytes) = cached {
            return Some(STANDARD.encode(bytes));
        }
        if fresh_negative {
            return None;
        }
        let extracted = extract(self, application).await;
        let data = extracted.as_ref().map(|bytes| STANDARD.encode(bytes));
        let directory = self.directory.clone();
        let _ = tokio::task::spawn_blocking(move || {
            if cantrip_host::files::private_directory(&directory).is_err() {
                return;
            }
            let (path, contents) = match extracted.as_deref() {
                Some(bytes) => (&png, bytes),
                None => (&missing, b"missing".as_slice()),
            };
            if let Ok(mut temporary) = tempfile::NamedTempFile::new_in(directory)
                && temporary.write_all(contents).is_ok()
                && temporary.persist(path).is_ok()
                && extracted.is_some()
            {
                let _ = fs::remove_file(missing);
            }
        })
        .await;
        data
    }
}

async fn extract(_store: &Store, _application: &str) -> Option<Vec<u8>> {
    #[cfg(target_os = "macos")]
    return macos::extract(_application, _store.home.as_deref()).await;
    #[cfg(windows)]
    return windows::extract(_application).await;
    #[cfg(target_os = "linux")]
    {
        let roots = _store.roots.clone();
        let application = _application.to_owned();
        tokio::task::spawn_blocking(move || linux::extract(&application, &roots))
            .await
            .ok()?
    }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    None
}

fn read_regular(path: &Path, limit: usize) -> Option<Vec<u8>> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return None;
    }
    let mut data = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut data).ok()?;
    (data.len() <= limit).then_some(data)
}

fn image_limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(2_048);
    limits.max_image_height = Some(2_048);
    limits.max_alloc = Some(24 * 1024 * 1024);
    limits
}

fn normalize_png(data: &[u8]) -> Option<Vec<u8>> {
    let mut reader = ImageReader::with_format(Cursor::new(data), ImageFormat::Png);
    reader.limits(image_limits());
    icon_png(reader.decode().ok()?)
}

fn icon_png(image: DynamicImage) -> Option<Vec<u8>> {
    let image = image
        .thumbnail(image.width().min(SIZE), image.height().min(SIZE))
        .to_rgba8();
    let mut canvas = RgbaImage::new(SIZE, SIZE);
    let x = i64::from((SIZE - image.width()) / 2);
    let y = i64::from((SIZE - image.height()) / 2);
    image::imageops::overlay(&mut canvas, &image, x, y);
    let mut png = Cursor::new(Vec::new());
    canvas.write_to(&mut png, ImageFormat::Png).ok()?;
    Some(png.into_inner())
}
