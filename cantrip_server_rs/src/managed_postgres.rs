use std::{
    fs::OpenOptions,
    net::TcpListener,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use tokio::process::Command;
use tokio::time::{Instant, sleep};
use tokio_postgres::{Config, NoTls};
use uuid::Uuid;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix::PostgresProcess as Child;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows::PostgresProcess as Child;

#[derive(Serialize, Deserialize)]
struct Credentials {
    username: String,
    password: String,
}

/// Owns the postmaster child or Windows process job. Close database sessions first.
pub struct ManagedPostgres {
    child: Child,
    #[cfg(windows)]
    binary_directory: PathBuf,
    #[cfg(windows)]
    data_directory: PathBuf,
    configuration: Config,
}

fn binary(directory: &Path, name: &str) -> PathBuf {
    directory.join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
}

fn private_directory(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn private_file(path: &Path) -> Result<std::fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}

impl ManagedPostgres {
    pub async fn start(root: &Path, binary_directory: &Path) -> Result<Self> {
        #[cfg(unix)]
        let owner = std::env::current_exe()?;
        #[cfg(windows)]
        let owner = PathBuf::new();
        Self::start_with_owner(root, binary_directory, &owner).await
    }

    /// The Unix owner executable must call `run_owner_if_requested` at entry.
    /// Integration-test harnesses pass the actual server, rather than libtest.
    pub async fn start_with_owner(
        root: &Path,
        binary_directory: &Path,
        owner_program: &Path,
    ) -> Result<Self> {
        private_directory(root)?;
        let credential_path = root.join("credentials.json");
        let credentials = match std::fs::read(&credential_path) {
            Ok(bytes) => serde_json::from_slice::<Credentials>(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let credentials = Credentials {
                    username: "cantrip".into(),
                    password: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
                };
                serde_json::to_writer(private_file(&credential_path)?, &credentials)?;
                credentials
            }
            Err(error) => return Err(error.into()),
        };
        #[cfg(windows)]
        let data_directory = root.join("data");
        #[cfg(windows)]
        if !data_directory.join("PG_VERSION").try_exists()? {
            let password_path = root.join(format!("init-password-{}", Uuid::new_v4()));
            use std::io::Write;
            writeln!(private_file(&password_path)?, "{}", credentials.password)?;
            let result = Command::new(binary(binary_directory, "initdb"))
                .arg("-D")
                .arg(&data_directory)
                .arg("-U")
                .arg(&credentials.username)
                .arg("--auth=scram-sha-256")
                .arg("--encoding=UTF8")
                .arg("--locale=C")
                .arg("--pwfile")
                .arg(&password_path)
                .output()
                .await;
            std::fs::remove_file(password_path)?;
            let output = result.context("launch bundled initdb")?;
            if !output.status.success() {
                bail!("initdb failed: {}", String::from_utf8_lossy(&output.stderr));
            }
        }
        let port = TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port();
        let log = OpenOptions::new()
            .append(true)
            .create(true)
            .open(root.join("postgres.log"))?;
        #[cfg(windows)]
        let child = Child::start(binary_directory, &data_directory, port, log)?;
        #[cfg(windows)]
        let _ = owner_program;
        #[cfg(unix)]
        let child = Child::start(owner_program, root, binary_directory, port, log)?;
        let mut configuration = Config::new();
        configuration
            .host("127.0.0.1")
            .port(port)
            .user(&credentials.username)
            .password(&credentials.password)
            .dbname("postgres")
            .connect_timeout(Duration::from_secs(1));
        let mut runtime = Self {
            child,
            #[cfg(windows)]
            binary_directory: binary_directory.into(),
            #[cfg(windows)]
            data_directory,
            configuration,
        };
        if let Err(error) = runtime.wait_for_connection().await {
            let _ = runtime.child.kill().await;
            let log = std::fs::read_to_string(root.join("postgres.log"))
                .unwrap_or_else(|failure| format!("startup log unavailable: {failure}"));
            let tail = log
                .lines()
                .rev()
                .take(40)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n");
            return Err(error.context(format!("bundled PostgreSQL startup output:\n{tail}")));
        }
        Ok(runtime)
    }

    pub fn configuration(&self) -> &Config {
        &self.configuration
    }

    async fn wait_for_connection(&mut self) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(status) = self.child.try_wait()? {
                bail!("bundled PostgreSQL exited during startup ({status}); see postgres.log");
            }
            match self.configuration.connect(NoTls).await {
                Ok((client, connection)) => {
                    let connection = tokio::spawn(connection);
                    let result = client.simple_query("SELECT 1").await;
                    drop(client);
                    connection.await??;
                    result?;
                    return Ok(());
                }
                Err(error) if Instant::now() >= deadline => {
                    return Err(error).context("connect to bundled PostgreSQL during startup");
                }
                Err(_) => sleep(Duration::from_millis(100)).await,
            }
        }
    }

    pub async fn close(mut self) -> Result<()> {
        #[cfg(windows)]
        {
            let output = Command::new(binary(&self.binary_directory, "pg_ctl"))
                .arg("-D")
                .arg(&self.data_directory)
                .args(["stop", "-m", "fast", "-w", "-t", "30"])
                .output()
                .await
                .context("stop bundled PostgreSQL")?;
            if !output.status.success() {
                bail!(
                    "PostgreSQL shutdown failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
        #[cfg(unix)]
        self.child.release();
        let status = self.child.wait().await?;
        if !status.success() {
            bail!("PostgreSQL owner exited unsuccessfully ({status})");
        }
        Ok(())
    }
}

/// Internal native process entry, before the ordinary server/fixture parser.
/// Only Unix needs a pipe owner; Windows retains its kernel-owned process job.
pub async fn run_owner_if_requested() -> Result<bool> {
    #[cfg(unix)]
    {
        unix::run_if_requested().await
    }
    #[cfg(windows)]
    {
        Ok(false)
    }
}
