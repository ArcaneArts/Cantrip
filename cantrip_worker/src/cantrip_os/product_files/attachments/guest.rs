use super::{REQUEST, RESULT, hash, size, text, validate_receipt};
use crate::attachments::paths::{MAX_BYTES, safe_filename, segment};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_crypto::{Zeroizing, content::attachment_digest};
use cantrip_wire::{Value, value::json};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions, OpenOptionsExt},
};
use std::{
    io::{ErrorKind, Read, Write},
    path::Path,
};
use uuid::Uuid;

const MAX_BASE64: usize = MAX_BYTES.div_ceil(3) * 4;
pub(in crate::cantrip_os::product_files) const FRAME_LIMIT: usize = MAX_BASE64 + 4096;
const ROOT: &str = ".local/share/cantrip-os-executor/attachments";

pub(in crate::cantrip_os::product_files) fn materialize(
    home: &Path,
    request: &Value,
    context: &Value,
) -> Result<Value> {
    ensure!(
        request["type"] == REQUEST
            && context["surfaceKind"] == "chat-files"
            && context["surfaceId"] == request["chatId"]
            && request.as_object().is_some_and(|fields| fields.len() == 7),
        "Misrouted Linux attachment."
    );
    let identity = |key| {
        request[key]
            .as_js_string()
            .context("Invalid Linux attachment identity.")
    };
    let chat = segment(identity("chatId")?, "Chat id")?;
    let attachment = segment(identity("attachmentId")?, "Attachment id")?;
    let name = identity("fileName")?;
    let filename = name
        .as_str()
        .filter(|name| !name.is_empty())
        .context("Invalid Linux attachment file name.")?;
    ensure!(
        safe_filename(name) == *name,
        "Invalid Linux attachment file name."
    );
    let digest = hash(request)?;
    let size = size(request)?;
    let data = text(request, "dataBase64")?;
    ensure!(data.len() <= MAX_BASE64, "Linux attachment is too large.");
    let bytes = Zeroizing::new(STANDARD.decode(data)?);
    ensure!(
        bytes.len() == size && attachment_digest(&bytes) == digest,
        "Linux attachment content verification failed."
    );
    let canonical_home = home.canonicalize()?;
    let root = Dir::open_ambient_dir(&canonical_home, ambient_authority())?;
    let directory = Path::new(ROOT).join(chat).join(attachment).join(digest);
    root.create_dir_all(&directory)?;
    let directory = root.canonicalize(&directory)?;
    let handle = root.open_dir(&directory)?;
    publish(&handle, Path::new(filename), &bytes)?;
    drop(bytes);
    let target = directory.join(filename);
    verify(&root, &target, size, digest)?;
    let path = canonical_home.join(target);
    let path = path.to_str().context("Invalid Linux attachment path.")?;
    Ok(json!({"type":RESULT,"value":json!({"path":path,"sha256":digest,"sizeBytes":size})}))
}

fn publish(directory: &Dir, name: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true).mode(0o400);
    let staging = format!(".cantrip-attachment-{}", Uuid::new_v4());
    let mut file = directory.open_with(&staging, &options)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        match directory.hard_link(&staging, directory, name) {
            Ok(()) => directory.open(".")?.sync_all(),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(error),
        }
    })();
    let cleanup = directory.remove_file(&staging);
    result?;
    cleanup?;
    Ok(())
}

pub(in crate::cantrip_os::product_files) fn verify_saved(
    home: &Path,
    receipt: &Value,
) -> Result<()> {
    let path = Path::new(validate_receipt(receipt)?);
    let canonical = home.canonicalize()?;
    let path = path
        .strip_prefix(&canonical)
        .context("The Linux attachment escaped its workspace home.")?;
    let root = Dir::open_ambient_dir(canonical, ambient_authority())?;
    verify(&root, path, size(receipt)?, hash(receipt)?)
}

fn verify(root: &Dir, path: &Path, size: usize, digest: &str) -> Result<()> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    let file = root.open_with(path, &options)?;
    let info = file.metadata()?;
    ensure!(
        info.is_file() && info.len() == size as u64,
        "The materialized Linux attachment changed."
    );
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(size as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() == size && attachment_digest(&bytes) == digest,
        "The materialized Linux attachment changed."
    );
    Ok(())
}
