//! The Node worker's encrypted receipt envelope and fixed-position stage frames.
use super::{CHUNK, MAX_SAFE, stamp::hash};
use anyhow::{Result, anyhow, ensure};
use cantrip_crypto::{
    Zeroizing, decrypt_payload, derive_field_key, encrypt_payload, open_aes_gcm, parse_payload,
    random_bytes, seal_aes_gcm,
};
use cantrip_wire::{Value, parse_json_text, value::json};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

const HEADER: usize = 24;
const TAG: usize = 16;
const FRAME_BYTES: u64 = CHUNK + (HEADER + TAG) as u64;
const RECEIPT_BYTES: usize = 64 * 1024;

pub(super) struct Storage<'a> {
    directory: PathBuf,
    locks: &'a Path,
    owner: &'a Value,
    key: &'a [u8],
    revision: u64,
}

impl<'a> Storage<'a> {
    pub fn new(
        data: &Path,
        locks: &'a Path,
        owner: &'a Value,
        key: &'a [u8],
        revision: u64,
    ) -> Self {
        Self {
            directory: data.join("binary-file-writes"),
            locks,
            owner,
            key,
            revision,
        }
    }

    pub fn lock(&self, category: &str, key: &str) -> Result<File> {
        // The OS releases this lock even if an executor child dies mid-write.
        // Fixed buckets bound the number of persistent lock files, even when
        // clients look up arbitrarily many nonexistent uploads.
        cantrip_host::files::private_directory(self.locks)?;
        let file = open_file(
            &self.locks.join(format!("{category}-{}.lock", &key[..2])),
            true,
            false,
            true,
        )?;
        file.lock()?;
        Ok(file)
    }

    fn material(&self, upload: &str, field: &str) -> Result<(Zeroizing<Vec<u8>>, Value)> {
        let aad = json!({
            "ownerId":self.owner,"component":"surface-private-state","table":"worker:binary-file-writes",
            "rowId":upload,"field":field,"formatVersion":1,"keyRevision":self.revision,
        });
        Ok((derive_field_key(self.key, &aad)?, aad))
    }

    fn receipt(&self, key: &str) -> PathBuf {
        self.directory.join(format!("{key}.json"))
    }

    fn stage(&self, key: &str) -> PathBuf {
        self.directory.join(format!("{key}.stage"))
    }

    pub fn read(&self, key: &str) -> Result<Option<Value>> {
        let file = match open_file(&self.receipt(key), false, false, false) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let mut bytes = Vec::new();
        file.take((2 * RECEIPT_BYTES) as u64)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() < 2 * RECEIPT_BYTES,
            "Binary write receipt exceeds its storage limit."
        );
        let envelope = parse_payload(std::str::from_utf8(&bytes)?)?;
        let (material, aad) = self.material(key, "receipt-v1")?;
        let plaintext = decrypt_payload(&material, &envelope, &aad)?;
        Ok(Some(
            parse_json_text(std::str::from_utf8(&plaintext)?)
                .map_err(|_| anyhow!("Invalid binary write receipt."))?,
        ))
    }

    pub fn save(&self, key: &str, receipt: &Value) -> Result<()> {
        cantrip_host::files::private_directory(&self.directory)?;
        let plaintext = Zeroizing::new(receipt.stringify());
        ensure!(
            plaintext.len() <= RECEIPT_BYTES,
            "Binary write receipt exceeds its storage limit."
        );
        let (material, aad) = self.material(key, "receipt-v1")?;
        let envelope = encrypt_payload(&material, plaintext.as_bytes(), &aad)?;
        let mut pending = tempfile::NamedTempFile::new_in(&self.directory)?;
        pending.write_all(envelope.stringify().as_bytes())?;
        pending.as_file().sync_all()?;
        pending
            .persist(self.receipt(key))
            .map_err(|error| error.error)?;
        sync_directory(&self.directory)?;
        Ok(())
    }

    pub fn create(&self, key: &str) -> io::Result<()> {
        cantrip_host::files::private_directory(&self.directory)?;
        cantrip_host::files::open_private(&self.stage(key))?.sync_all()?;
        sync_directory(&self.directory)
    }

    pub fn discard(&self, key: &str) -> io::Result<()> {
        remove_file(&self.stage(key))
    }

    fn aad(&self, key: &str, offset: u64, length: usize, final_page: bool) -> String {
        Value::Array(vec![
            json!("cantrip-binary-write-chunk"),
            json!(1),
            self.owner.clone(),
            json!(key),
            json!(offset),
            json!(length),
            json!(final_page),
        ])
        .stringify()
    }

    pub fn append(
        &self,
        key: &str,
        offset: u64,
        bytes: &[u8],
        final_page: bool,
        frames: u64,
    ) -> Result<()> {
        let (material, _) = self.material(key, "chunks-v1")?;
        let nonce = random_bytes(12)?;
        let ciphertext = seal_aes_gcm(
            &material,
            &nonce,
            bytes,
            self.aad(key, offset, bytes.len(), final_page).as_bytes(),
        )?;
        let mut header = [0u8; HEADER];
        header[..4].copy_from_slice(&(bytes.len() as u32).to_le_bytes());
        header[4] = u8::from(final_page);
        header[8..20].copy_from_slice(&nonce);
        header[20..24].copy_from_slice(&u32::try_from(self.revision)?.to_le_bytes());
        let position = position(frames)?;
        let mut handle = open_file(&self.stage(key), true, false, false)?;
        // A previous append may have reached disk without its receipt.
        handle.set_len(position)?;
        handle.seek(SeekFrom::Start(position))?;
        handle.write_all(&header)?;
        handle.write_all(&ciphertext)?;
        handle.sync_all()?;
        Ok(())
    }

    pub fn open_stage(&self, key: &str) -> io::Result<File> {
        open_file(&self.stage(key), false, false, false)
    }

    pub fn frame(
        &self,
        key: &str,
        file: &mut File,
        index: u64,
    ) -> Result<(Zeroizing<Vec<u8>>, bool)> {
        let mut header = [0u8; HEADER];
        file.seek(SeekFrom::Start(position(index)?))?;
        read_exact(file, &mut header)?;
        let length = u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
        let revision = u32::from_le_bytes(header[20..].try_into().unwrap()) as u64;
        ensure!(
            length <= CHUNK as usize && header[4] <= 1 && revision == self.revision,
            "Binary staging frame is invalid."
        );
        let final_page = header[4] != 0;
        let mut ciphertext = vec![0; length + TAG];
        read_exact(file, &mut ciphertext)?;
        let (material, _) = self.material(key, "chunks-v1")?;
        let plaintext = open_aes_gcm(
            &material,
            &header[8..20],
            &ciphertext,
            self.aad(key, index * CHUNK, length, final_page).as_bytes(),
        )?;
        Ok((plaintext, final_page))
    }

    pub fn target_lock(&self, canonical_target: &Value) -> Result<File> {
        self.lock("target", &hash(canonical_target.stringify().as_bytes()))
    }
}

fn position(index: u64) -> Result<u64> {
    index
        .checked_mul(FRAME_BYTES)
        .filter(|&value| value <= MAX_SAFE)
        .ok_or_else(|| anyhow!("Binary staging exceeds supported byte addressing."))
}

fn read_exact(file: &mut File, bytes: &mut [u8]) -> Result<()> {
    file.read_exact(bytes).map_err(|error| {
        if error.kind() == io::ErrorKind::UnexpectedEof {
            anyhow!("Binary staging frame is incomplete.")
        } else {
            error.into()
        }
    })
}

pub(super) fn open_file(
    path: &Path,
    write: bool,
    exclusive: bool,
    create: bool,
) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(write)
        .create_new(exclusive)
        .create(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    options.open(path)
}

pub(super) fn remove_file(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

pub(super) fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(windows)]
    let _ = path;
    Ok(())
}
