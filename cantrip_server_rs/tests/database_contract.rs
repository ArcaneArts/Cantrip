use std::{path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Result, bail};
use cantrip_server::{
    database::Database,
    managed_postgres::ManagedPostgres,
    migrations::{MIGRATIONS, migrate},
};
use serde_json::json;

async fn exercise(database: &Database) -> Result<()> {
    assert_eq!(migrate(database).await?, MIGRATIONS.len());
    assert_eq!(migrate(database).await?, 0);
    let rows = database
        .query(
            "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id",
            &[],
        )
        .await?;
    assert_eq!(rows.len(), MIGRATIONS.len());
    for (row, migration) in rows.iter().zip(MIGRATIONS) {
        assert_eq!(row.get::<String>(0)?, migration.hash);
        assert_eq!(row.get::<i64>(1)?, migration.when);
    }
    database
        .execute("CREATE TABLE rust_contract (id integer PRIMARY KEY, payload jsonb NOT NULL)")
        .await?;
    let payload = json!({"label":"retained 🦀", "nullable":null, "nested":{"value":42}});
    database
        .query(
            "INSERT INTO rust_contract VALUES ($1, $2)",
            &[&1_i32, &payload],
        )
        .await?;
    let rows = database
        .query(
            "SELECT payload, payload #>> '{nested,value}' FROM rust_contract WHERE id = $1",
            &[&1_i32],
        )
        .await?;
    assert_eq!(rows[0].get::<serde_json::Value>(0)?, payload);
    assert_eq!(rows[0].get::<String>(1)?, "42");
    let rollback: Result<()> = database
        .transaction(|transaction| {
            Box::pin(async move {
                transaction
                    .query("INSERT INTO rust_contract VALUES (2, '{}'::jsonb)", &[])
                    .await?;
                bail!("intentional rollback")
            })
        })
        .await;
    assert_eq!(rollback.unwrap_err().to_string(), "intentional rollback");
    database
        .transaction(|transaction| {
            Box::pin(async move {
                transaction
                    .execute("INSERT INTO rust_contract VALUES (3, '{}'::jsonb)")
                    .await?;
                Ok(())
            })
        })
        .await?;
    assert!(
        database
            .query("INSERT INTO rust_contract VALUES (1, '{}'::jsonb)", &[])
            .await
            .is_err()
    );
    let rows = database
        .query("SELECT array_agg(id ORDER BY id) FROM rust_contract", &[])
        .await?;
    assert_eq!(rows[0].get::<Vec<i32>>(0)?, vec![1, 3]);
    let (started, observed) = tokio::sync::oneshot::channel();
    let interrupted = database.transaction(move |transaction| {
        Box::pin(async move {
            transaction
                .execute("INSERT INTO rust_contract VALUES (4, '{}'::jsonb)")
                .await?;
            let _ = started.send(());
            std::future::pending::<Result<()>>().await
        })
    });
    tokio::select! {
        result = interrupted => bail!("transaction unexpectedly completed: {result:?}"),
        result = observed => result?,
    }
    assert_eq!(
        database
            .query("SELECT count(*) FROM rust_contract", &[])
            .await?[0]
            .get::<i64>(0)?,
        2
    );
    let mut notifications = database.listen("rust_contract").await?;
    database
        .query("SELECT pg_notify('rust_contract', $1)", &[&"committed"])
        .await?;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), notifications.recv()).await??,
        ("rust_contract".into(), "committed".into())
    );
    Ok(())
}

#[tokio::test]
async fn native_pglite_runs_the_existing_schema_and_survives_reopen() -> Result<()> {
    if let Ok(phase) = std::env::var("CANTRIP_NATIVE_DATABASE_PHASE") {
        let path = PathBuf::from(std::env::var("CANTRIP_NATIVE_DATABASE_ROOT")?);
        let database = Database::pglite(&path).await?;
        match phase.as_str() {
            "seed" => exercise(&database).await?,
            "reopen" => {
                assert_eq!(migrate(&database).await?, 0);
                assert_eq!(
                    database
                        .query("SELECT count(*) FROM rust_contract", &[])
                        .await?[0]
                        .get::<i64>(0)?,
                    2
                );
            }
            _ => bail!("unexpected native database test phase"),
        }
        database.close().await?;
        return Ok(());
    }
    // A real server restarts in a new process. Native PostgreSQL also owns
    // process-wide signal handlers, so keep it out of the PostgreSQL-child test.
    let root = tempfile::Builder::new()
        .prefix("cantrip pglite ")
        .tempdir()?;
    for phase in ["seed", "reopen"] {
        let status = tokio::process::Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "native_pglite_runs_the_existing_schema_and_survives_reopen",
                "--nocapture",
            ])
            .env("CANTRIP_NATIVE_DATABASE_PHASE", phase)
            .env("CANTRIP_NATIVE_DATABASE_ROOT", root.path().join("database"))
            .kill_on_drop(true)
            .status()
            .await?;
        assert!(status.success(), "native PGlite {phase} failed");
    }
    Ok(())
}

#[tokio::test]
async fn postgres_runs_the_same_schema_and_contract() -> Result<()> {
    // CI and developer invocations supply real PostgreSQL executables explicitly.
    let binary_directory = PathBuf::from(std::env::var("CANTRIP_TEST_POSTGRES_BIN_DIR")?);
    let root = tempfile::Builder::new()
        .prefix("cantrip postgres ")
        .tempdir()?;
    let runtime = ManagedPostgres::start(root.path(), &binary_directory).await?;
    let database = Arc::new(Database::postgres(runtime.configuration()).await?);
    exercise(&database).await?;
    // Exercise external selection through the real executable as well as the
    // client layer. Only this isolated fixture's synthetic credential is used.
    let configuration = runtime.configuration();
    let url = format!(
        "postgresql://{}:{}@127.0.0.1:{}/postgres",
        configuration.get_user().unwrap(),
        std::str::from_utf8(configuration.get_password().unwrap())?,
        configuration.get_ports()[0]
    );
    let status = tokio::process::Command::new(env!("CARGO_BIN_EXE_cantrip-server"))
        .args(["--migrate-only", "--database", "postgres", "--data-dir"])
        .arg(root.path())
        .env("DATABASE_URL", url)
        .kill_on_drop(true)
        .status()
        .await?;
    assert!(status.success(), "external-PostgreSQL executable failed");
    let mut requests = Vec::new();
    for _ in 0..12 {
        let database = database.clone();
        requests.push(tokio::spawn(async move {
            database
                .query("SELECT count(*) FROM rust_contract", &[])
                .await
        }));
    }
    for request in requests {
        assert_eq!(request.await??[0].get::<i64>(0)?, 2);
    }
    database.close().await?;
    database.close().await?;
    assert!(database.query("SELECT 1", &[]).await.is_err());
    runtime.close().await?;
    let runtime = ManagedPostgres::start(root.path(), &binary_directory).await?;
    let database = Database::postgres(runtime.configuration()).await?;
    assert_eq!(migrate(&database).await?, 0);
    assert_eq!(
        database
            .query("SELECT count(*) FROM rust_contract", &[])
            .await?[0]
            .get::<i64>(0)?,
        2
    );
    database.close().await?;
    runtime.close().await?;
    Ok(())
}

#[cfg(windows)]
#[tokio::test]
async fn postgres_windows_owner_exit_kills_descendants_and_retains_data() -> Result<()> {
    use std::{
        io::Write,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    };
    use tokio::io::{AsyncBufReadExt, BufReader};
    use windows_sys::Win32::{
        Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
    };

    let binary_directory = PathBuf::from(std::env::var("CANTRIP_TEST_POSTGRES_BIN_DIR")?);
    if let Ok(path) = std::env::var("CANTRIP_POSTGRES_OWNER_EXIT_ROOT") {
        let root = PathBuf::from(path);
        let runtime = ManagedPostgres::start(&root, &binary_directory).await?;
        let database = Database::postgres(runtime.configuration()).await?;
        database
            .execute("CREATE TABLE owner_exit_probe (value text NOT NULL); INSERT INTO owner_exit_probe VALUES ('retained after owner exit')")
            .await?;
        database.close().await?;
        let pid = std::fs::read_to_string(root.join("data/postmaster.pid"))?
            .lines()
            .next()
            .unwrap()
            .parse::<u32>()?;
        println!("CANTRIP_POSTGRES_OWNER_READY={pid}");
        std::io::stdout().flush()?;
        std::future::pending::<()>().await;
        drop(runtime);
        return Ok(());
    }
    let root = tempfile::Builder::new()
        .prefix("cantrip postgres owner ")
        .tempdir()?;
    let mut owner = tokio::process::Command::new(std::env::current_exe()?)
        .args([
            "--exact",
            "postgres_windows_owner_exit_kills_descendants_and_retains_data",
            "--nocapture",
        ])
        .env("CANTRIP_POSTGRES_OWNER_EXIT_ROOT", root.path())
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut output = BufReader::new(owner.stdout.take().unwrap()).lines();
    let pid = tokio::time::timeout(Duration::from_secs(60), async {
        while let Some(line) = output.next_line().await? {
            if let Some(pid) = line.strip_prefix("CANTRIP_POSTGRES_OWNER_READY=") {
                return Ok(pid.parse::<u32>()?);
            }
        }
        bail!("database owner exited without reporting actual readiness");
    })
    .await??;
    // Observe the exact live postmaster before killing its owner. Holding only
    // a process handle cannot keep the owner's non-inherited job handle alive.
    let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if raw.is_null() {
        return Err(std::io::Error::last_os_error().into());
    }
    let postmaster = unsafe { OwnedHandle::from_raw_handle(raw) };
    owner.kill().await?;
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            match unsafe { WaitForSingleObject(postmaster.as_raw_handle(), 0) } {
                WAIT_OBJECT_0 => return Ok::<_, anyhow::Error>(()),
                WAIT_TIMEOUT => tokio::time::sleep(Duration::from_millis(50)).await,
                _ => return Err(std::io::Error::last_os_error().into()),
            }
        }
    })
    .await??;
    let runtime = ManagedPostgres::start(root.path(), &binary_directory).await?;
    let database = Database::postgres(runtime.configuration()).await?;
    assert_eq!(
        database
            .query("SELECT value FROM owner_exit_probe", &[])
            .await?[0]
            .get::<String>(0)?,
        "retained after owner exit"
    );
    database.close().await?;
    runtime.close().await?;
    Ok(())
}
