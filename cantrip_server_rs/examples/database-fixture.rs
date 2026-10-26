//! Test-only private PostgreSQL owner for the socket compatibility harness.
//! This executable is never included in a server distribution.
use anyhow::{Context, Result};
use cantrip_server::managed_postgres::ManagedPostgres;
use clap::Parser;
use serde_json::json;
use std::{io::Write, path::PathBuf};
use tokio::io::AsyncReadExt;

#[derive(Parser)]
struct Arguments {
    #[arg(long)]
    data_dir: PathBuf,
    #[arg(long)]
    postgres_bin_dir: PathBuf,
}

#[tokio::main]
async fn main() -> Result<()> {
    let arguments = Arguments::parse();
    let runtime = ManagedPostgres::start(&arguments.data_dir, &arguments.postgres_bin_dir).await?;
    let config = runtime.configuration();
    let mut url = url::Url::parse("postgresql://127.0.0.1/postgres")?;
    url.set_port(Some(config.get_ports()[0])).unwrap();
    url.set_username(config.get_user().context("fixture database username")?)
        .unwrap();
    url.set_password(Some(std::str::from_utf8(
        config.get_password().context("fixture database password")?,
    )?))
    .unwrap();
    println!(
        "{}",
        json!({"event":"server.listening","origin":url.as_str()})
    );
    std::io::stdout().flush()?;
    let mut input = tokio::io::stdin();
    let mut bytes = [0; 256];
    while input.read(&mut bytes).await? > 0 {}
    runtime.close().await
}
