//! Worker-owned content addressed cache for public Cantrip OS packages.
use crate::cantrip_os::{checked, operations::save, text};
use crate::filesystem::Scope;
use anyhow::{Result, anyhow, ensure};
use cantrip_wire::{Value, parse_json_text, value::json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, Write},
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub(super) struct Catalog {
    source: PathBuf,
    cache: PathBuf,
}

impl Catalog {
    pub fn new(data: &Path) -> Self {
        Self {
            source: std::env::var_os("CANTRIP_OS_PACKAGE_DIRECTORY")
                .map(PathBuf::from)
                .unwrap_or_else(|| data.join("cantrip-os-packages")),
            cache: data.join("cantrip-os-package-artifacts"),
        }
    }

    fn location(&self, artifact: &Value) -> Result<PathBuf> {
        Ok(self
            .cache
            .join(format!("{}.deb", text(artifact, "sha256")?)))
    }

    pub fn file(&self, artifact: &Value, scope: &Scope) -> Result<File> {
        let path = self.location(artifact)?;
        let mut file = open(&path)?;
        verify(&mut file, None, artifact, scope)?;
        let saved = manifest(&path.with_extension("deb.json"))?;
        ensure!(
            saved["artifact"] == *artifact,
            "The saved package metadata changed."
        );
        file.rewind()?;
        Ok(file)
    }

    fn retain(&self, document: &Value, scope: &Scope) -> Result<()> {
        let artifact = &document["artifact"];
        match self.file(artifact, scope) {
            Ok(_) => return Ok(()),
            Err(error) if missing(&error) => {}
            Err(error) => return Err(error),
        }
        let path = self.location(artifact)?;
        cantrip_host::files::secure_directory(&self.cache)?;
        match open(&path) {
            Ok(mut file) => verify(&mut file, None, artifact, scope)?,
            Err(error) if missing(&error) => {
                let mut input = open(&self.source.join(text(document, "file")?))?;
                let mut pending = tempfile::NamedTempFile::new_in(&self.cache)?;
                verify(&mut input, Some(pending.as_file_mut()), artifact, scope)?;
                pending.as_file().sync_all()?;
                if let Err(error) = pending.persist_noclobber(&path)
                    && error.error.kind() != io::ErrorKind::AlreadyExists
                {
                    return Err(error.error.into());
                }
            }
            Err(error) => return Err(error),
        }
        let metadata = path.with_extension("deb.json");
        if let Err(error) = save(&metadata, document, true)
            && !error
                .downcast_ref::<io::Error>()
                .is_some_and(|error| error.kind() == io::ErrorKind::AlreadyExists)
        {
            return Err(error);
        }
        self.file(artifact, scope)?;
        Ok(())
    }

    pub fn list(&self, scope: &Scope) -> Result<(Vec<Value>, usize)> {
        let directory = match fs::read_dir(&self.source) {
            Ok(directory) => directory,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok((vec![], 0)),
            Err(error) => return Err(error.into()),
        };
        let mut files = Vec::new();
        for entry in directory {
            let name = entry?.file_name();
            if let Some(name) = name.to_str()
                && let Some(hash) = name.strip_suffix(".json")
                && hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                files.push(name.to_owned());
            }
        }
        files.sort_unstable();
        let mut available = Vec::new();
        let mut errors = Vec::new();
        for name in files {
            scope.check()?;
            let result: Result<Value> = (|| {
                let document = manifest(&self.source.join(&name))?;
                let artifact = &document["artifact"];
                ensure!(
                    name == format!("{}.json", text(artifact, "sha256")?),
                    "Catalogue manifest identity changed"
                );
                self.retain(&document, scope)?;
                ensure!(
                    available.len() < 256,
                    "Package catalogue exceeds 256 artifacts"
                );
                Ok(artifact.clone())
            })();
            match result {
                Ok(artifact) => available.push(artifact),
                Err(error) => errors.push(json!({"manifest":name,"message":error.to_string()})),
            }
        }
        let unavailable = errors.len();
        if unavailable != 0 {
            save(
                &self.cache.join("catalog-errors.json"),
                &json!({"version":1,"errors":errors}),
                false,
            )?;
        }
        Ok((available, unavailable))
    }
}

fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<io::Error>()
        .is_some_and(|error| error.kind() == io::ErrorKind::NotFound)
}

fn open(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file(),
        "Package artifact is not a regular file."
    );
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        ensure!(
            metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0,
            "Package artifact is not a regular file."
        );
    }
    Ok(file)
}

fn manifest(path: &Path) -> Result<Value> {
    let mut source = String::new();
    open(path)?.read_to_string(&mut source)?;
    checked(
        "cantripOsPackageManifestSchema",
        parse_json_text(&source).map_err(|_| anyhow!("Invalid package manifest JSON"))?,
    )
}

fn verify(
    file: &mut File,
    mut copy: Option<&mut File>,
    artifact: &Value,
    scope: &Scope,
) -> Result<()> {
    let bytes = artifact["bytes"]
        .as_u64()
        .ok_or_else(|| anyhow!("Package size"))?;
    ensure!(
        file.metadata()?.len() == bytes,
        "Package artifact size changed."
    );
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut actual = 0;
    loop {
        scope.check()?;
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        actual += count as u64;
        ensure!(actual <= bytes, "Package artifact size changed.");
        hash.update(&buffer[..count]);
        if let Some(copy) = &mut copy {
            copy.write_all(&buffer[..count])?;
        }
    }
    let hash: String = hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    ensure!(
        actual == bytes && artifact["sha256"] == hash,
        "Package artifact checksum changed."
    );
    Ok(())
}
