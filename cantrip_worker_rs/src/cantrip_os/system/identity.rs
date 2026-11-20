use super::super::{docker::LocalDocker, text};
use crate::filesystem::Scope;
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_wire::{Value, parse_json_text};
use std::io::Read;
use tar::{Archive, EntryType};
use uuid::{Uuid, Variant};

const CONFIG: &str = "/etc/cantrip-os/executor.json";
const MAX_FILE: u64 = 1024 * 1024;
const MAX_ARCHIVE: usize = 2 * 1024 * 1024;

pub(super) struct Identity {
    pub id: Value,
    pub attachment: Value,
    pub path: String,
}

fn absolute(path: &str) -> Result<String> {
    ensure!(
        path.starts_with('/') && !path.contains('\0'),
        "The guest identity path is not absolute."
    );
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}

fn canonical(path: &str) -> Result<&str> {
    let mut normalized = absolute(path)?;
    if normalized != "/" && path.ends_with('/') {
        normalized.push('/');
    }
    ensure!(
        path == normalized,
        "A canonical guest identity path is required"
    );
    Ok(path)
}

enum Member {
    File(Vec<u8>),
    Link(String),
}

// Docker supplies a tar stream even for a single file. Follow links by
// requesting another guest path and never extract archive names on the host.
fn member(bytes: &[u8]) -> Result<Member> {
    ensure!(
        bytes.len() <= MAX_ARCHIVE,
        "The guest identity archive exceeds its metadata limit"
    );
    let mut archive = Archive::new(bytes);
    let mut selected = None;
    let mut link_path = None;
    let mut end = 0;
    for entry in archive.entries()?.raw(true) {
        let mut entry = entry?;
        let size = entry.size();
        ensure!(size <= MAX_FILE, "Guest identity archive is too large");
        end = entry.raw_file_position() + size.next_multiple_of(512);
        ensure!(
            end <= bytes.len() as u64,
            "Guest identity archive is incomplete"
        );
        match entry.header().entry_type() {
            EntryType::Regular | EntryType::Symlink => {
                ensure!(
                    selected.is_none(),
                    "Guest identity archive contains more than one file"
                );
                selected = if entry.header().entry_type() == EntryType::Regular {
                    let mut file = Vec::with_capacity(size as usize);
                    entry.read_to_end(&mut file)?;
                    Some(Member::File(file))
                } else {
                    ensure!(size == 0, "Invalid guest identity symlink archive");
                    let target = match link_path.take() {
                        Some(path) => path,
                        None => std::str::from_utf8(
                            &entry
                                .link_name_bytes()
                                .context("The guest identity symlink has no target")?,
                        )?
                        .to_owned(),
                    };
                    ensure!(
                        !target.is_empty(),
                        "The guest identity symlink has no target"
                    );
                    Some(Member::Link(target))
                };
            }
            EntryType::XHeader | EntryType::XGlobalHeader => {
                if let Some(extensions) = entry.pax_extensions()? {
                    for field in extensions {
                        let field = field?;
                        let value = std::str::from_utf8(field.value_bytes())?;
                        if field.key_bytes() == b"linkpath" {
                            link_path = Some(value.to_owned());
                        }
                    }
                }
            }
            EntryType::GNULongLink => {
                let mut value = Vec::with_capacity(size as usize);
                entry.read_to_end(&mut value)?;
                link_path = Some(
                    std::str::from_utf8(value.split(|byte| *byte == 0).next().unwrap_or(&[]))?
                        .to_owned(),
                );
            }
            EntryType::GNULongName => {}
            _ => return Err(anyhow!("The guest identity path is not a regular file")),
        }
    }
    let tail = &bytes[end as usize..];
    ensure!(
        tail.len() >= 1024 && tail.iter().all(|byte| *byte == 0),
        "Guest identity archive has no complete terminator"
    );
    selected.context("The guest identity archive has no file")
}

async fn read(engine: &LocalDocker, id: &str, path: &str, lifetime: &Scope) -> Result<Value> {
    let mut selected = canonical(path)?.to_owned();
    for _ in 0..=40 {
        match member(&engine.read_archive(id, &selected, lifetime).await?)? {
            Member::File(bytes) => {
                return parse_json_text(std::str::from_utf8(&bytes)?)
                    .map_err(|_| anyhow!("The guest identity file is not valid JSON"));
            }
            Member::Link(link) => {
                selected = if link.starts_with('/') {
                    absolute(&link)?
                } else {
                    let (parent, _) = selected.rsplit_once('/').unwrap_or(("", ""));
                    absolute(&format!("{parent}/{link}"))?
                };
            }
        }
    }
    Err(anyhow!("The guest identity symlink chain is too long"))
}

async fn config(engine: &LocalDocker, id: &str, lifetime: &Scope) -> Result<String> {
    let value = read(engine, id, CONFIG, lifetime).await?;
    let state = absolute(text(&value, "state_dir")?)?;
    Ok(format!("{}/instance.json", state.trim_end_matches('/')))
}

fn has_valid_id(value: &Value) -> bool {
    let Some(text) = value.as_str().filter(|id| id.len() == 36) else {
        return false;
    };
    Uuid::parse_str(text).is_ok_and(|id| {
        id.is_nil()
            || text == "ffffffff-ffff-ffff-ffff-ffffffffffff"
            || (id.get_variant() == Variant::RFC4122 && (1..=8).contains(&id.get_version_num()))
    })
}

pub(super) async fn current(
    engine: &LocalDocker,
    id: &str,
    known: Option<&str>,
    lifetime: &Scope,
) -> Result<Identity> {
    let mut path = match config(engine, id, lifetime).await {
        Ok(path) => path,
        Err(error) => canonical(known.ok_or(error)?)?.to_owned(),
    };
    let value = match read(engine, id, &path, lifetime).await {
        Ok(value) => value,
        Err(error) => {
            path = canonical(known.filter(|known| *known != path).ok_or(error)?)?.to_owned();
            read(engine, id, &path, lifetime).await?
        }
    };
    // A valid identity for a different owner or Worker must reach the
    // authority comparison. The old file is only a fallback for read errors.
    let attachment = value
        .get("attachment")
        .context("The guest identity file has no attachment field")?;
    ensure!(
        value["version"].as_f64() == Some(1.0)
            && has_valid_id(&value["instance_id"])
            && (matches!(attachment, Value::Null)
                || (attachment.is_object()
                    && ["owner_id", "worker_id"].into_iter().all(|field| {
                        attachment[field]
                            .as_js_string()
                            .is_some_and(|id| (1..=200).contains(&id.len()))
                    }))),
        "The guest identity file is invalid"
    );
    Ok(Identity {
        id: value["instance_id"].clone(),
        attachment: attachment.clone(),
        path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_a_complete_single_file_docker_archive() -> Result<()> {
        let mut builder = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_ustar();
        header.set_size(2);
        header.set_mode(0o600);
        builder.append_data(&mut header, "instance.json", &b"{}"[..])?;
        let complete = builder.into_inner()?;
        assert!(matches!(member(&complete)?, Member::File(bytes) if bytes == b"{}"));
        assert!(member(&complete[..complete.len() - 512]).is_err());

        let mut appended = complete.clone();
        appended.extend_from_slice(&complete);
        assert!(member(&appended).is_err());
        Ok(())
    }
}
