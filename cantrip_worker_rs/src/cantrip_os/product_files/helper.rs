//! Workspace-account file operations with the existing version-one journal.
use super::{digest, is_import, mutation, records, stream, text};
use crate::{
    cantrip_os::operations::save,
    encryption::ComponentKey,
    filesystem::{
        Scope,
        explorer::{self, binary_write, imports::Imports},
        paths,
    },
};
use anyhow::{Context, Result, bail, ensure};
use cantrip_crypto::{Zeroizing, checked, random_bytes};
use cantrip_wire::{Value, parse_json_text, value::json};
use std::{
    env,
    fs::File,
    io::{self, BufRead, Read, Write},
    os::fd::AsFd,
    path::{Path, PathBuf},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    net::unix::pipe::Receiver,
    time::timeout,
};
use uuid::Uuid;

const FRAME_LIMIT: usize = 8 * 1024 * 1024;

pub async fn run() -> Result<()> {
    // Match the previous guest service's creation mask before opening paths.
    unsafe {
        libc::umask(0o077);
    }
    let mut args = env::args_os().skip(1);
    let root = PathBuf::from(args.next().context("Expected a captured Linux root.")?);
    let identity = args.next().context("Expected a captured Linux identity.")?;
    let identity = identity
        .to_str()
        .filter(|identity| valid_digest(identity))
        .context("Invalid Linux file helper identity.")?;
    let mode = args.next();
    let streaming = mode.as_deref().is_some_and(|mode| mode == "--stream");
    ensure!(
        root.is_absolute() && (mode.is_none() || streaming) && args.next().is_none(),
        "Invalid Linux file helper invocation."
    );
    let home =
        PathBuf::from(env::var_os("HOME").context("The Linux workspace home is unavailable.")?);
    ensure!(home.is_absolute(), "The Linux workspace home is invalid.");
    let directory = home
        .join(".local/state/cantrip-os-executor/files")
        .join(identity);
    if streaming {
        let reader = Receiver::from_owned_fd(io::stdin().as_fd().try_clone_to_owned()?)?;
        let mut reader = BufReader::new(reader);
        let imports = Imports::default();
        emit(&json!({"ready":true,"version":1,"identity":identity}))?;
        let mut input = Vec::new();
        loop {
            input.clear();
            let mut bounded = (&mut reader).take((FRAME_LIMIT + 1) as u64);
            match timeout(stream::IDLE, bounded.read_until(b'\n', &mut input)).await {
                Ok(Ok(0)) | Err(_) => return Ok(()),
                Ok(result) => {
                    result?;
                }
            }
            if !respond(&root, &directory, Some(&imports), &input).await? {
                return Ok(());
            }
        }
    }
    let mut input = Vec::new();
    io::stdin()
        .lock()
        .take((FRAME_LIMIT + 1) as u64)
        .read_until(b'\n', &mut input)?;
    respond(&root, &directory, None, &input).await?;
    Ok(())
}

async fn respond(
    root: &Path,
    directory: &Path,
    imports: Option<&Imports>,
    input: &[u8],
) -> Result<bool> {
    ensure!(
        input.len() <= FRAME_LIMIT && input.last() == Some(&b'\n'),
        "The Linux file helper request is incomplete."
    );
    let frame = parse_json_text(std::str::from_utf8(input)?)
        .map_err(|_| anyhow::anyhow!("Invalid Linux file helper request."))?;
    let id = text(&frame, "id")?;
    Uuid::parse_str(id)?;
    let mut surface = frame["context"].clone();
    ensure!(
        surface.is_object(),
        "Expected a Linux file operation context."
    );
    surface["direction"] = json!("request");
    let surface = checked("surfaceStreamContextSchema", &surface)?;
    ensure!(
        surface["operationId"] == id
            && matches!(
                surface["surfaceKind"].as_str(),
                Some("explorer" | "file-document")
            ),
        "Misrouted OS file request."
    );
    let context = super::record_context(&surface);
    let response = match dispatch(root, directory, imports, &frame, &context).await {
        Ok(result) => result,
        Err(error) => completed(explorer::failure(&error)),
    };
    let mut frame = json!({"id":id,"result":response});
    let retained = imports.is_some_and(Imports::is_active);
    if imports.is_some() {
        frame["retained"] = json!(retained);
    }
    emit(&frame)?;
    Ok(retained)
}

fn emit(frame: &Value) -> Result<()> {
    let mut output = io::stdout().lock();
    writeln!(output, "{}", frame.stringify())?;
    output.flush()?;
    Ok(())
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
}

async fn dispatch(
    root: &Path,
    directory: &Path,
    imports: Option<&Imports>,
    frame: &Value,
    context: &Value,
) -> Result<Value> {
    let id = &frame["id"];
    if frame["action"] == "observe" {
        let fingerprint = text(frame, "digest")?;
        ensure!(
            valid_digest(fingerprint),
            "Invalid Linux file operation digest."
        );
        return observe(directory, context, fingerprint);
    }
    ensure!(
        frame["action"] == "execute",
        "Unknown Linux file operation action."
    );
    let request = checked("explorerOperationRequestContentSchema", &frame["request"])?;
    if !mutation(text(&request, "type")?)? {
        return Ok(execute(root, directory, imports, context, &request).await);
    }
    let fingerprint = digest(json!({"id":id,"request":request,"context":context}));
    let path = receipt_path(directory, context);
    let record = json!({"digest":fingerprint});
    match save(&path, &record, true) {
        Ok(()) => {}
        Err(error)
            if error
                .downcast_ref::<io::Error>()
                .is_some_and(|cause| cause.kind() == io::ErrorKind::AlreadyExists) =>
        {
            return observe(directory, context, &fingerprint);
        }
        Err(error) => return Err(error),
    }
    let result = execute(root, directory, imports, context, &request).await;
    save(&path, &json!({"digest":fingerprint,"result":result}), false)?;
    Ok(result)
}

fn receipt_path(directory: &Path, context: &Value) -> PathBuf {
    directory.join(format!("{}.json", digest(context.clone())))
}

fn observe(directory: &Path, context: &Value, fingerprint: &str) -> Result<Value> {
    let Some(record) = records::read(&receipt_path(directory, context))? else {
        bail!(
            "The OS file operation has no saved completion. Its outcome is unknown; it was not replayed."
        );
    };
    ensure!(
        record["digest"] == fingerprint,
        "OS file operation identity was reused with different input."
    );
    let result = record.get("result")
        .context("The OS file operation has an unknown outcome. Inspect the file before issuing another mutation.")?;
    Ok(result.clone())
}

async fn execute(
    root: &Path,
    directory: &Path,
    imports: Option<&Imports>,
    context: &Value,
    request: &Value,
) -> Value {
    let scope = Scope::default();
    let result = if binary_write::action(request).is_some() {
        guest_binary(root, directory, context, request).await
    } else if is_import(request["type"].as_str().unwrap_or_default()) {
        match imports {
            Some(imports) if context["surfaceKind"] == "explorer" => {
                imports.execute(root, context, request, &scope).await
            }
            _ => Err(anyhow::anyhow!("Misrouted OS file import.")),
        }
    } else {
        explorer::execute(root, request, &scope).await
    };
    match result {
        Ok(result) => {
            json!({"complete":explorer::complete(&result, request),"outcome":json!({"ok":true,"result":result})})
        }
        Err(error) => completed(explorer::failure(&error)),
    }
}

async fn guest_binary(
    root: &Path,
    directory: &Path,
    context: &Value,
    request: &Value,
) -> Result<Value> {
    let identity = directory
        .file_name()
        .and_then(|name| name.to_str())
        .context("Invalid guest file identity.")?;
    let locks = directory
        .parent()
        .unwrap()
        .with_file_name("binary-write-locks");
    let writer = binary_write::Writer::new(directory, &locks);
    let key = ComponentKey {
        key: guest_key(directory)?,
        key_revision: 1,
    };
    writer
        .execute(&paths::text(root), context, request, json!(identity), key)
        .await
}

fn guest_key(directory: &Path) -> Result<Zeroizing<Vec<u8>>> {
    cantrip_host::files::private_directory(directory)?;
    let name = directory.join("cache-key");
    let opened = match File::open(&name) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let key = random_bytes(32)?;
            let mut candidate = tempfile::NamedTempFile::new_in(directory)?;
            candidate.write_all(&key)?;
            candidate.as_file().sync_all()?;
            match candidate.persist_noclobber(&name) {
                Ok(_) => File::open(directory)?.sync_all()?,
                Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.error.into()),
            }
            File::open(name)?
        }
        Err(error) => return Err(error.into()),
    };
    let mut key = Zeroizing::new(Vec::new());
    opened.take(33).read_to_end(&mut key)?;
    ensure!(key.len() == 32, "Invalid local file cache key.");
    Ok(key)
}

fn completed(outcome: Value) -> Value {
    json!({"complete":true,"outcome":outcome})
}
