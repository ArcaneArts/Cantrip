//! Test-only explicit inspection of private export diagnostics from a real SQL failure.
use anyhow::{Context, Result, ensure};
use cantrip_server::{
    database::Database,
    database_transfer::{export_sql, native_pglite::ExportFailure},
};
use std::path::PathBuf;
#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    ensure!(
        args.len() == 3,
        "Usage: database-export-diagnostics <pg_dump> <destination> <diagnostic needle>"
    );
    let database = Database::postgres_url(&std::env::var("DATABASE_URL")?).await?;
    let rows = database
        .query(
            "SELECT current_user::text,session_user::text,current_setting('application_name')",
            &[],
        )
        .await?;
    let identity = serde_json::json!({"active_role":rows[0].get::<String>(0)?,"login_role":rows[0].get::<String>(1)?,"application_name":rows[0].get::<String>(2)?});
    let exported = export_sql(
        &database,
        &PathBuf::from(&args[1]),
        &PathBuf::from(&args[0]),
    )
    .await;
    database.close().await?;
    if args[2] == "--expect-success" {
        let receipt = exported?;
        println!(
            "{}",
            serde_json::json!({"identity":identity,"receipt":receipt})
        );
        return Ok(());
    }
    let error = exported.expect_err("actual restricted database export must fail");
    let needle = args[2].to_str().context("UTF-8 diagnostic needle")?;
    let private = error
        .downcast_ref::<ExportFailure>()
        .context("redacted export failure type")?;
    ensure!(
        format!("{:#}", private.original()).contains(needle),
        "real private SQL diagnostic was not retained"
    );
    ensure!(
        !error.to_string().contains(needle) && !format!("{error:?}").contains(needle),
        "ordinary rendering exposes private SQL context"
    );
    println!(
        "{}",
        serde_json::json!({"actualSqlFailure":true,"privateDiagnosticRetained":true,"ordinaryRenderingRedacted":true})
    );
    Ok(())
}
