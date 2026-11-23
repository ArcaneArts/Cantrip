use anyhow::{Context, Result, ensure};
use cantrip_server::database_transfer::native_pglite::dump_sql;
use std::{io::Write, path::PathBuf};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    ensure!(
        args.len() == 2,
        "Usage: native-export-fixture <new root> <pg_dump>"
    );
    let root = std::path::absolute(PathBuf::from(&args[0]))?;
    let pg_dump = std::path::absolute(PathBuf::from(&args[1]))?;
    std::fs::create_dir_all(&root)?;
    let database = pglite::PGlite::open_with(
        root.join("database"),
        pglite::PGliteOptions {
            start_params: vec![
                "log_min_messages=fatal".into(),
                "log_min_error_statement=panic".into(),
            ],
            ..Default::default()
        },
    )
    .await?;
    let result: Result<()> = async {
        database.exec("CREATE TABLE public.native_probe(id bigint PRIMARY KEY, value text, metadata jsonb, precise numeric, bytes bytea)").await?;
        let literal="before\n\\restrict CantripNativeDumpProbe42\nmiddle\n\\unrestrict CantripNativeDumpProbe42\nafter 🦀";
        database.query("INSERT INTO public.native_probe VALUES(9007199254740993,$1,NULL,123456789012345678901234567890.12345,decode('00ff','hex'))", &[&literal]).await?;
        database.exec("INSERT INTO public.native_probe VALUES(2,'JSON null','null'::jsonb,NULL,NULL)").await?;
        database.exec(&format!("CREATE FUNCTION public.native_probe() RETURNS text LANGUAGE sql AS $body$ SELECT $literal${literal}$literal$::text $body$")).await?;
        let sql = dump_sql(&database, &pg_dump).await?;
        let mut options=std::fs::OpenOptions::new();options.write(true).create_new(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output=options.open(root.join("native.sql"))?;
        output.write_all(sql.as_bytes())?;output.sync_all()?;
        ensure!(database.query("SELECT count(*)::int FROM public.native_probe", &[]).await?[0].get::<i32>(0)? == 2,"source session is unusable after dump");
        let error = dump_sql(&database, &root.join("missing-pg-dump")).await.expect_err("actual missing executable must fail");
        ensure!(!format!("{error:?}").contains(&root.display().to_string()),"default error exposes private path");
        ensure!(error.downcast_ref::<cantrip_server::database_transfer::native_pglite::ExportFailure>().context("export failure type")?.original().chain().any(|cause|cause.downcast_ref::<std::io::Error>().is_some()),"actual private IO diagnostics were not retained");
        Ok(())
    }.await;
    let closed = database.close().await;
    result?;
    closed?;
    println!("native export and private launch-error checks passed");
    Ok(())
}
