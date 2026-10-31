//! Exercise the real pg_dump process, not a generated SQL fixture. Windows
//! plain stdout used to turn LF into CRLF inside both rows and SQL functions.
use anyhow::{Result, ensure};
use cantrip_server::database_transfer::{native_pglite::dump_sql, prepare_sql};
use std::path::PathBuf;

#[tokio::test]
async fn native_dump_roundtrip_preserves_mixed_newline_and_unicode_bytes() -> Result<()> {
    const RESTORE_ROOT: &str = "CANTRIP_TEST_NATIVE_DUMP_RESTORE_ROOT";
    let literal = "LF\nCRLF\r\nbare CR\rend\n\\restrict Literal42\r\n\\unrestrict Literal42\n😺 e\u{301} ' \\\t";
    if let Some(root) = std::env::var_os(RESTORE_ROOT) {
        let root = PathBuf::from(root);
        let restored = pglite::PGlite::open(root.join("restored")).await?;
        let result: Result<()> = async {
            restored
                .exec(&std::fs::read_to_string(root.join("dump.sql"))?)
                .await?;
            let rows = restored
                .query(
                    "SELECT value,public.byte_function() FROM public.byte_probe",
                    &[],
                )
                .await?;
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].get::<String>(0)?.as_bytes(), literal.as_bytes());
            assert_eq!(rows[0].get::<String>(1)?.as_bytes(), literal.as_bytes());
            Ok(())
        }
        .await;
        let closed = restored.close().await;
        result?;
        closed?;
        return Ok(());
    }
    let executable = std::env::var_os("CANTRIP_TEST_PG_DUMP_PATH")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("CANTRIP_TEST_POSTGRES_BIN_DIR").map(|path| {
                PathBuf::from(path).join(format!("pg_dump{}", std::env::consts::EXE_SUFFIX))
            })
        })
        .unwrap_or_else(|| PathBuf::from("pg_dump"));
    let root = tempfile::tempdir()?;
    let source = pglite::PGlite::open(root.path().join("source")).await?;
    source
        .exec("CREATE TABLE public.byte_probe(id integer PRIMARY KEY, value text)")
        .await?;
    source
        .query("INSERT INTO public.byte_probe VALUES(1,$1)", &[&literal])
        .await?;
    source.exec(&format!("CREATE FUNCTION public.byte_function() RETURNS text LANGUAGE sql AS $body$ SELECT $literal${literal}$literal$::text $body$")).await?;
    assert_eq!(
        source
            .query(
                "SELECT value,public.byte_function() FROM public.byte_probe",
                &[]
            )
            .await?[0]
            .get::<String>(1)?,
        literal
    );
    let result = dump_sql(&source, &executable).await;
    let closed = source.close().await;
    let sql = prepare_sql(result?)?.sql;
    closed?;
    std::fs::write(root.path().join("dump.sql"), sql)?;
    // The native PGlite backend cannot reopen after close in one process.
    // Restore in a genuinely fresh process, as the production CLI does.
    let restored = std::process::Command::new(std::env::current_exe()?)
        .args([
            "--exact",
            "native_dump_roundtrip_preserves_mixed_newline_and_unicode_bytes",
            "--nocapture",
        ])
        .env(RESTORE_ROOT, root.path())
        .output()?;
    ensure!(
        restored.status.success(),
        "fresh restore process failed: {} {}",
        String::from_utf8_lossy(&restored.stdout),
        String::from_utf8_lossy(&restored.stderr)
    );
    Ok(())
}
