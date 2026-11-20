//! Cantrip OS backup frame authentication for the shared v1 file and wire format.
use super::{aad, open_field, seal_field};
use crate::{Zeroizing, checked, decryption_error, encode};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{Value, value::json};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy)]
pub enum BackupFrame {
    Metadata,
    Chunk,
    End,
}

impl BackupFrame {
    pub const CHUNK_BYTES: usize = 1024 * 1024;
    pub const METADATA_BYTES: usize = 16 * 1024 * 1024;

    fn tag(self) -> &'static str {
        match self {
            Self::Metadata => "metadata",
            Self::Chunk => "chunk",
            Self::End => "end",
        }
    }

    fn limit(self) -> usize {
        match self {
            Self::Metadata => Self::METADATA_BYTES,
            Self::Chunk => Self::CHUNK_BYTES,
            Self::End => 4096,
        }
    }
}

pub struct BackupCipher<'a> {
    context: Value,
    server_hash: Value,
    key: &'a [u8],
}

impl<'a> BackupCipher<'a> {
    pub fn new(context: &Value, revision: u64, key: &'a [u8]) -> Result<Self> {
        let mut context = checked("cantripOsBackupCryptoContextSchema", context)?;
        let server = context["serverId"]
            .as_js_string()
            .context("Backup server identity")?;
        // TextEncoder replaces an unmatched UTF-16 surrogate with U+FFFD.
        let bytes = String::from_utf16_lossy(server.units());
        let server_hash = json!(encode(&Sha256::digest(bytes.as_bytes())));
        context["keyRevision"] = json!(revision);
        Ok(Self {
            context,
            server_hash,
            key,
        })
    }

    fn associated(&self, kind: BackupFrame, seq: u64) -> Result<Value> {
        ensure!(seq <= (1 << 53) - 1, "Invalid backup sequence.");
        let tag = kind.tag();
        let row = Value::Array(vec![
            self.server_hash.clone(),
            self.context["backupId"].clone(),
            json!(tag),
            json!(seq),
        ])
        .stringify();
        aad(
            &self.context,
            &json!("repository-content"),
            &json!("protocol:cantrip-os-private-backup"),
            &json!(row),
            &json!(format!("private_backup_{tag}")),
        )
    }

    pub fn seal(&self, kind: BackupFrame, seq: u64, plaintext: &[u8]) -> Result<Value> {
        ensure!(
            plaintext.len() <= kind.limit(),
            "Private backup frame is too large."
        );
        let envelope = seal_field(self.key, &self.associated(kind, seq)?, plaintext)?;
        Ok(json!({"kind":kind.tag(),"sequence":seq,"envelope":envelope}))
    }

    /// The caller supplies the expected position in the stream or message.
    pub fn open(&self, kind: BackupFrame, seq: u64, frame: &Value) -> Result<Zeroizing<Vec<u8>>> {
        super::authenticate(|| {
            let frame = checked("cantripOsBackupFrameSchema", frame)?;
            if frame["kind"] != kind.tag()
                || frame["sequence"].as_u64() != Some(seq)
                || frame["envelope"]["keyRevision"] != self.context["keyRevision"]
                || frame["envelope"]["ciphertext"]
                    .as_js_string()
                    .is_none_or(|text| text.len() > (kind.limit() + 16).div_ceil(3) * 4)
            {
                return Err(decryption_error());
            }
            let bytes = open_field(self.key, &self.associated(kind, seq)?, &frame["envelope"])?;
            if bytes.len() > kind.limit() {
                return Err(decryption_error());
            }
            Ok(bytes)
        })
    }
}
