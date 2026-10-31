//! Offline native pg_dump access to PGlite. The caller owns the stopped server's
//! database and supplies the packaged native pg_dump executable.
use anyhow::{Context, Result, ensure};
use std::{collections::BTreeMap, path::Path, process::Stdio, time::Duration};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    process::Command,
};

pub struct ExportFailure {
    phase: &'static str,
    io_kind: Option<std::io::ErrorKind>,
    original: anyhow::Error,
}
impl ExportFailure {
    /// SQL diagnostics may contain private values. Ordinary error rendering does
    /// not expose them; diagnostic callers must opt in explicitly.
    pub fn original(&self) -> &anyhow::Error {
        &self.original
    }
}
impl std::fmt::Display for ExportFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Logical database export failed during {}", self.phase)?;
        if let Some(kind) = self.io_kind {
            write!(f, " ({kind:?})")?;
        }
        Ok(())
    }
}
impl std::fmt::Debug for ExportFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}
impl std::error::Error for ExportFailure {}
pub(super) fn failure(error: anyhow::Error, phase: &'static str) -> anyhow::Error {
    if error.is::<ExportFailure>() {
        return error;
    }
    let io_kind = error.chain().find_map(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .map(std::io::Error::kind)
    });
    ExportFailure {
        phase,
        io_kind,
        original: error,
    }
    .into()
}

struct Metadata {
    user: String,
    database: String,
    parameters: Vec<(&'static str, String)>,
}

/// Obtain a real plain INSERT-format dump without any JavaScript runtime. This
/// returns pg_dump's original SQL, including generated psql guard commands. File
/// publication and SQL-only normalization belong to the offline transfer caller.
pub async fn dump_sql(database: &pglite::PGlite, executable: &Path) -> Result<String> {
    dump_inner(database, executable)
        .await
        .map_err(|error| failure(error, "native pg_dump"))
}

async fn dump_inner(database: &pglite::PGlite, executable: &Path) -> Result<String> {
    let rows=database.query("SELECT current_setting('server_version'),current_user::text,current_database()::text,current_setting('TimeZone'),current_setting('DateStyle'),current_setting('standard_conforming_strings'),current_setting('is_superuser')",&[]).await?;
    let row = &rows[0];
    let metadata = Metadata {
        user: row.get(1)?,
        database: row.get(2)?,
        parameters: vec![
            ("server_version", row.get(0)?),
            ("server_encoding", "UTF8".into()),
            ("client_encoding", "UTF8".into()),
            ("TimeZone", row.get(3)?),
            ("DateStyle", row.get(4)?),
            ("standard_conforming_strings", row.get(5)?),
            ("is_superuser", row.get(6)?),
            ("integer_datetimes", "on".into()),
        ],
    };
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let password = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut command = Command::new(executable);
    command
        .args([
            "--no-password",
            "--inserts",
            "--no-owner",
            "--no-privileges",
            "--encoding=UTF8",
        ])
        .args(super::dump_stream::OPTIONS)
        .env("PGHOST", "127.0.0.1")
        .env("PGHOSTADDR", "127.0.0.1")
        .env("PGPORT", port.to_string())
        .env("PGUSER", &metadata.user)
        .env("PGDATABASE", &metadata.database)
        .env("PGPASSWORD", &password)
        .env("PGSSLMODE", "disable")
        .env("PGGSSENCMODE", "disable")
        .env("PGCHANNELBINDING", "disable")
        .env("PGTARGETSESSIONATTRS", "any")
        .env_remove("PGREQUIREAUTH")
        .env("PGCONNECT_TIMEOUT", "2")
        .env_remove("PGOPTIONS")
        .env_remove("PGSERVICE")
        .env_remove("PGSERVICEFILE")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = command.spawn().context("launch native pg_dump")?;
    let serve = serve(listener, database, &password, &metadata);
    let wait = child.wait_with_output();
    tokio::pin!(serve, wait);
    let output = tokio::select! {
        result=&mut serve=>{result?;wait.await?},
        result=&mut wait=>{
            let output=result?;
            if output.status.success(){serve.await?;}
            output
        },
    };
    ensure!(
        output.status.success(),
        "native pg_dump exited {:?}: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    super::dump_stream::decode(&output.stdout)
}

fn packet(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    out.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
    out.extend_from_slice(body);
    out
}
async fn frame(stream: &mut TcpStream) -> Result<(u8, Vec<u8>)> {
    let tag = stream.read_u8().await?;
    let length = stream.read_u32().await?;
    ensure!(
        (4..=1_073_741_824).contains(&length),
        "invalid protocol frame length"
    );
    let mut body = vec![0; (length - 4) as usize];
    stream.read_exact(&mut body).await?;
    Ok((tag, body))
}
async fn authenticate(stream: &mut TcpStream, password: &str, metadata: &Metadata) -> Result<()> {
    loop {
        let length = stream.read_u32().await?;
        ensure!(
            (8..=10_000).contains(&length),
            "invalid startup frame length"
        );
        let mut startup = vec![0; (length - 4) as usize];
        stream.read_exact(&mut startup).await?;
        match u32::from_be_bytes(startup[..4].try_into()?) {
            80_877_103 | 80_877_104 => stream.write_all(b"N").await?,
            196_608 => {
                let fields = std::str::from_utf8(&startup[4..])?;
                ensure!(fields.ends_with("\0\0"), "invalid startup parameters");
                let values: Vec<_> = fields[..fields.len() - 1].split_terminator('\0').collect();
                ensure!(
                    values.len().is_multiple_of(2),
                    "invalid startup parameter pairs"
                );
                let values: BTreeMap<_, _> = values
                    .chunks_exact(2)
                    .map(|pair| (pair[0], pair[1]))
                    .collect();
                ensure!(
                    values.get("user") == Some(&metadata.user.as_str())
                        && values.get("database") == Some(&metadata.database.as_str()),
                    "unexpected export database identity"
                );
                break;
            }
            _ => anyhow::bail!("unsupported startup protocol"),
        }
    }
    stream.write_all(&packet(b'R', &3u32.to_be_bytes())).await?;
    let (tag, body) = frame(stream).await?;
    let expected = format!("{password}\0");
    ensure!(
        tag == b'p' && bool::from(body.as_slice().ct_eq(expected.as_bytes())),
        "invalid export authentication"
    );
    stream.write_all(&packet(b'R', &0u32.to_be_bytes())).await?;
    for (key, value) in &metadata.parameters {
        stream
            .write_all(&packet(b'S', format!("{key}\0{value}\0").as_bytes()))
            .await?;
    }
    // Cancellation keys are private to this temporary endpoint. pg_dump errors
    // and caller cancellation tear down the session; no external PID is exposed.
    stream
        .write_all(&packet(b'K', &[0, 0, 0, 1, 0, 0, 0, 0]))
        .await?;
    stream.write_all(&packet(b'Z', b"I")).await?;
    Ok(())
}
async fn serve(
    listener: TcpListener,
    database: &pglite::PGlite,
    password: &str,
    metadata: &Metadata,
) -> Result<()> {
    // An unauthenticated local connection never acquires the native session.
    // Keep accepting after an invalid peer; the actual pg_dump owns completion.
    let mut stream = loop {
        let (mut stream, _) = listener.accept().await?;
        stream.set_nodelay(true)?;
        if matches!(
            tokio::time::timeout(
                Duration::from_secs(2),
                authenticate(&mut stream, password, metadata)
            )
            .await,
            Ok(Ok(()))
        ) {
            break stream;
        }
    };
    let mut session = database.wire_session().await;
    let mut pending = Vec::new();
    loop {
        let (tag, body) = match frame(&mut stream).await {
            Ok(value) => value,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::UnexpectedEof) =>
            {
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        // Terminate must close this client, never the embedded singleton engine.
        if tag == b'X' {
            ensure!(body.is_empty(), "invalid Terminate frame");
            return Ok(());
        }
        pending.extend_from_slice(&packet(tag, &body));
        if !matches!(tag, b'Q' | b'F' | b'S' | b'c' | b'f') {
            continue;
        }
        let response = session.exchange(std::mem::take(&mut pending)).await?;
        let mut cursor = 0;
        let mut previous = 0;
        while cursor < response.len() {
            ensure!(cursor + 5 <= response.len(), "truncated native response");
            let length = u32::from_be_bytes(response[cursor + 1..cursor + 5].try_into()?) as usize;
            ensure!(
                length >= 4 && cursor + 1 + length <= response.len(),
                "invalid native response"
            );
            let tag = response[cursor];
            // Native protocol may repeat ReadyForQuery; async notifications are
            // not replies belonging to pg_dump. Preserve every other frame.
            if !(tag == b'A' || (tag == b'Z' && previous == b'Z')) {
                stream
                    .write_all(&response[cursor..cursor + 1 + length])
                    .await?;
                previous = tag;
            }
            cursor += 1 + length;
        }
    }
}
