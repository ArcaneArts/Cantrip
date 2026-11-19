use anyhow::{Context, Result, bail, ensure};
use cantrip_host::files::{open_private, private_directory};
use flate2::read::GzDecoder;
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, BufReader, Read, Write},
    path::{Path, PathBuf},
};
use tokio::sync::watch;
use unicode_normalization::UnicodeNormalization;

const MAX_ENTRIES: usize = 100_000;
const MAX_ENTRY_BYTES: u64 = 4_000_000_000;

pub(super) fn unpack(
    archive: &Path,
    format: &str,
    staging: &Path,
    maximum: u64,
    stop: watch::Receiver<bool>,
) -> Result<()> {
    let mut output = Extraction {
        root: staging,
        seen: HashSet::new(),
        remaining: maximum,
        stop,
    };
    let file = BufReader::new(File::open(archive)?);
    match format {
        "zip" => {
            let mut archive = zip::ZipArchive::new(file)?;
            ensure!(
                archive.len() <= MAX_ENTRIES,
                "Archive contains too many entries."
            );
            for index in 0..archive.len() {
                let mut entry = archive.by_index(index)?;
                let mode = entry.unix_mode().unwrap_or_default();
                let file_type = mode & 0o170000;
                ensure!(
                    matches!(file_type, 0 | 0o040000 | 0o100000),
                    "Archive contains a link or a special file."
                );
                let name = entry.name()?.into_owned();
                let size = entry.size();
                output.write(&name, size, entry.is_dir(), mode, &mut entry)?;
            }
        }
        "tar.gz" => {
            let mut archive = tar::Archive::new(GzDecoder::new(file));
            for entry in archive.entries()? {
                let mut entry = entry?;
                let kind = entry.header().entry_type();
                ensure!(
                    kind.is_file() || kind.is_dir(),
                    "Archive contains a link or a special file."
                );
                let name = std::str::from_utf8(&entry.path_bytes())?.to_owned();
                let mode = entry.header().mode()?;
                output.write(&name, entry.size(), kind.is_dir(), mode, &mut entry)?;
            }
        }
        _ => bail!("Unsupported archive format."),
    }
    Ok(())
}

pub(super) fn relative(name: &str) -> Result<PathBuf> {
    let name = name.trim_end_matches('/');
    ensure!(
        !name.is_empty() && !name.contains(['\\', ':']) && !name.chars().any(char::is_control),
        "Archive path is invalid."
    );
    let mut relative = PathBuf::new();
    for part in name.split('/') {
        ensure!(
            !matches!(part, "" | "." | ".."),
            "Archive path escapes staging."
        );
        if cfg!(windows) {
            let stem = part
                .split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_uppercase();
            let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && stem[3..]
                        .chars()
                        .any(|value| "123456789¹²³".contains(value))
                    && stem[3..].chars().count() == 1;
            ensure!(
                !device && !part.ends_with([' ', '.']),
                "Archive path is reserved on Windows."
            );
        }
        relative.push(part.nfc().collect::<String>());
    }
    Ok(relative)
}

struct Extraction<'a> {
    root: &'a Path,
    seen: HashSet<String>,
    remaining: u64,
    stop: watch::Receiver<bool>,
}

impl Extraction<'_> {
    fn write(
        &mut self,
        name: &str,
        size: u64,
        directory: bool,
        mode: u32,
        source: &mut impl Read,
    ) -> Result<()> {
        ensure!(
            !*self.stop.borrow(),
            "Managed runtime installation stopped."
        );
        let path = relative(name)?;
        let portable = path.to_str().context("Archive path is not Unicode.")?;
        let identity = if cfg!(windows) {
            portable.to_lowercase()
        } else {
            portable.to_owned()
        };
        ensure!(
            self.seen.len() < MAX_ENTRIES && self.seen.insert(identity),
            "Archive contains too many entries or a duplicate name."
        );
        ensure!(
            size <= self.remaining && size <= MAX_ENTRY_BYTES,
            "Archive exceeds its signed extraction budget."
        );
        self.remaining -= size;
        let output = self.root.join(path);
        if directory {
            ensure!(size == 0, "Archive directory has a payload.");
            private_directory(&output)?;
            return Ok(());
        }
        private_directory(output.parent().unwrap())?;
        let mut file = open_private(&output)?;
        let mut buffer = [0; 64 * 1024];
        let mut copied = 0_u64;
        loop {
            ensure!(
                !*self.stop.borrow(),
                "Managed runtime installation stopped."
            );
            let read = source.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            copied += read as u64;
            ensure!(copied <= size, "Archive entry exceeds its declared size.");
            file.write_all(&buffer[..read])?;
        }
        ensure!(
            copied == size,
            "Archive entry ended before its declared size."
        );
        make_executable(&file, mode)?;
        Ok(())
    }
}

#[cfg(unix)]
fn make_executable(file: &File, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if mode & 0o111 != 0 {
        file.set_permissions(fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn make_executable(_file: &File, _mode: u32) -> io::Result<()> {
    Ok(())
}
