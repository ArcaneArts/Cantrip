//! Offline logical SQL restore. No JavaScript participates in the native path.
use crate::{database::Database, migrations::migrate_transaction};
use anyhow::{Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;

pub struct RestoreFailure {
    pub phase: &'static str,
    pub sqlstate: Option<String>,
    pub io_kind: Option<std::io::ErrorKind>,
    original: anyhow::Error,
}
impl RestoreFailure {
    /// Original diagnostics may contain exported row values. Explicit callers
    /// can inspect them; ordinary CLI error rendering never includes them.
    pub fn original(&self) -> &anyhow::Error {
        &self.original
    }
}
impl std::fmt::Display for RestoreFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Logical database restore failed during {}", self.phase)?;
        if let Some(code) = &self.sqlstate {
            write!(f, " (SQLSTATE {code})")?;
        }
        if let Some(kind) = self.io_kind {
            write!(f, " ({kind:?})")?;
        }
        Ok(())
    }
}
impl std::fmt::Debug for RestoreFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}
impl std::error::Error for RestoreFailure {}
fn failure(error: anyhow::Error, phase: &'static str) -> anyhow::Error {
    let sqlstate = error
        .chain()
        .find_map(|cause| {
            if let Some(pglite::Error::Database { sqlstate, .. }) =
                cause.downcast_ref::<pglite::Error>()
            {
                return Some(sqlstate.clone());
            }
            cause
                .downcast_ref::<tokio_postgres::Error>()
                .and_then(|e| e.as_db_error())
                .map(|e| e.code().code().to_owned())
        })
        .filter(|code| {
            code.len() == 5
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
        });
    let io_kind = error.chain().find_map(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .map(std::io::Error::kind)
    });
    RestoreFailure {
        phase,
        sqlstate,
        io_kind,
        original: error,
    }
    .into()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReceipt {
    pub bytes: usize,
    pub sha256: String,
    pub migrations_applied: usize,
}

/// Import a trusted INSERT-format pg_dump export into the selected destination. All
/// archive DDL/data and pending Cantrip migrations share one transaction.
/// Existing objects produce their real database error and roll back the load.
pub async fn restore_sql(database: &Database, file: &Path) -> Result<RestoreReceipt> {
    let bytes = tokio::fs::read(file)
        .await
        .context("read SQL export")
        .map_err(|error| failure(error, "reading the export"))?;
    let receipt_bytes = bytes.len();
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let sql = String::from_utf8(bytes)
        .context("SQL export must be UTF-8")
        .map_err(|error| failure(error, "decoding the export"))?;
    let migrations_applied = database
        .transaction(|transaction| {
            Box::pin(async move {
                transaction
                    .execute("SELECT pg_advisory_xact_lock(4310, 1)")
                    .await?;
                let search_path: String =
                    transaction.query("SHOW search_path", &[]).await?[0].get(0)?;
                transaction.execute(&sql).await?;
                // pg_dump leaves an empty search_path. Pending historical SQL
                // uses its original unqualified public-table references.
                transaction
                    .query("SELECT set_config('search_path',$1,false)", &[&search_path])
                    .await?;
                migrate_transaction(transaction).await
            })
        })
        .await
        .map_err(|error| failure(error, "SQL restore and pending migrations"))?;
    Ok(RestoreReceipt {
        bytes: receipt_bytes,
        sha256: digest,
        migrations_applied,
    })
}
