use super::native_pglite::failure;
use crate::database::Database;
use anyhow::{Context, Result};
use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{io::Write, path::Path};

pub struct PreparedDump {
    pub sql: String,
    pub guards_removed: usize,
    pub portable_transaction_timeout: bool,
}

/// Adapt generated pg_dump syntax only. Identical lines in row values or
/// function bodies are data and must never be searched/replaced globally.
pub fn prepare_sql(mut sql: String) -> Result<PreparedDump> {
    let mut guards_removed = 0;
    let header = Regex::new(r"\A((?:--[^\n]*\n|\r?\n)*)\\restrict ([A-Za-z0-9]+)\r?\n")?;
    if let Some(prefix) = header.captures(&sql) {
        let footer = Regex::new(&format!(r"\r?\n\\unrestrict {}[\t \r\n]*\z", &prefix[2]))?;
        if let Some(end) = footer.find(&sql) {
            let start = prefix.get(0).unwrap().end();
            if end.start() >= start {
                sql = format!("{}{}\n", &prefix[1], &sql[start..end.start()]);
                guards_removed = 2;
            }
        }
    }
    let prelude = Regex::new(
        r"\A((?:--[^\n]*\n|\r?\n)*SET statement_timeout = 0;\r?\nSET lock_timeout = 0;\r?\nSET idle_in_transaction_session_timeout = 0;\r?\n)SET transaction_timeout = 0;\r?\n",
    )?;
    let mut portable_transaction_timeout = false;
    if let Some(prefix) = prelude.captures(&sql) {
        sql = format!(
            "{}DO $cantrip_dump_settings$ BEGIN PERFORM pg_catalog.set_config('transaction_timeout', '0', false); EXCEPTION WHEN undefined_object THEN NULL; END $cantrip_dump_settings$;\n{}",
            &prefix[1],
            &sql[prefix.get(0).unwrap().end()..]
        );
        portable_transaction_timeout = true;
    }
    Ok(PreparedDump {
        sql,
        guards_removed,
        portable_transaction_timeout,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReceipt {
    pub format: &'static str,
    pub database_engine: &'static str,
    pub bytes: usize,
    pub sha256: String,
    pub psql_guards_removed: usize,
    pub portable_transaction_timeout: bool,
}

/// Export a stopped server's database without applying migrations or refreshing
/// identities. Publish the complete private file atomically without overwriting
/// an existing path. A killed export may leave a private staging file, never a
/// partially published destination.
pub async fn export_sql(
    database: &Database,
    file: &Path,
    executable: &Path,
) -> Result<ExportReceipt> {
    let file = std::path::absolute(file)
        .map_err(|error| failure(error.into(), "resolving export destination"))?;
    let parent = file.parent().context("export parent directory")?;
    let mut pending = tempfile::Builder::new()
        .prefix(".cantrip-export-")
        .tempfile_in(parent)
        .map_err(|error| failure(error.into(), "creating private export staging"))?;
    let raw = database
        .dump_sql(executable)
        .await
        .map_err(|error| failure(error, "collecting database SQL"))?;
    let prepared = prepare_sql(raw).map_err(|error| failure(error, "preparing SQL export"))?;
    let bytes = prepared.sql.as_bytes();
    let receipt = ExportReceipt {
        format: "postgresql-sql",
        database_engine: database.engine(),
        bytes: bytes.len(),
        sha256: format!("{:x}", Sha256::digest(bytes)),
        psql_guards_removed: prepared.guards_removed,
        portable_transaction_timeout: prepared.portable_transaction_timeout,
    };
    pending
        .write_all(bytes)
        .and_then(|_| pending.as_file().sync_all())
        .map_err(|error| failure(error.into(), "writing private export"))?;
    pending
        .persist_noclobber(&file)
        .map_err(|error| failure(error.error.into(), "publishing SQL export"))?;
    #[cfg(unix)]
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| failure(error.into(), "syncing export directory"))?;
    Ok(receipt)
}
