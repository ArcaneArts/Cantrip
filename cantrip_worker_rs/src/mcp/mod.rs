//! First-party Cantrip MCP. Binding authority remains with the
//! authenticated worker broker.
pub mod bindings;
mod broker;
mod cua;
pub(crate) mod discovery;
mod rpc;
mod stdio;

use anyhow::{Result, bail};
use std::{
    ffi::{OsStr, OsString},
    path::PathBuf,
};

const UNICODE_SCALARS_ENV: &str = "CANTRIP_MCP_UNICODE_SCALARS";
const UNICODE_SCALARS_HEADER: &str = "cantrip-mcp-unicode-scalars";

pub fn run(arguments: impl IntoIterator<Item = OsString>) -> Result<()> {
    run_stdio(arguments, false)
}

pub fn run_cua(arguments: impl IntoIterator<Item = OsString>) -> Result<()> {
    run_stdio(arguments, true)
}

fn run_stdio(arguments: impl IntoIterator<Item = OsString>, cua: bool) -> Result<()> {
    let command = if cua { "cua-mcp" } else { "mcp" };
    let mut arguments = arguments.into_iter();
    let path = match (
        arguments.next().as_deref(),
        arguments.next(),
        arguments.next(),
    ) {
        (Some(flag), Some(path), None) if flag == OsStr::new("--connection") => PathBuf::from(path),
        _ => bail!("Usage: cantrip-worker {command} --connection <path>"),
    };
    let path = cantrip_config::resolve(&std::env::current_dir()?, &path);
    if path.to_string_lossy().encode_utf16().count() > 8_192 {
        bail!("Cantrip MCP connection path is too long.");
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(async {
        let service = async {
            let broker = broker::Broker::connect(&path).await?;
            let profile = std::env::var_os("CANTRIP_MCP_PROFILE");
            let profile = if cua {
                "cua"
            } else {
                match profile.as_deref().and_then(OsStr::to_str) {
                    None if profile.is_none() => "ide",
                    Some(profile @ ("ide" | "standalone-web")) => profile,
                    _ => bail!("Cantrip MCP profile is invalid."),
                }
            };
            let unicode_scalars =
                std::env::var_os(UNICODE_SCALARS_ENV).as_deref() == Some(OsStr::new("1"));
            stdio::serve(
                broker,
                profile,
                unicode_scalars,
                tokio::io::stdin(),
                tokio::io::stdout(),
            )
            .await
        };
        tokio::select! {
            result = service => result,
            result = shutdown_signal() => result,
        }
    });
    // Tokio's stdin reader can still be waiting on the parent when a signal
    // closes the service. Leave that OS read to process exit.
    runtime.shutdown_background();
    if cua {
        result.map_err(|_| anyhow::anyhow!("Cantrip CUA MCP failed to start."))
    } else {
        result.map_err(|error| anyhow::anyhow!("Cantrip MCP failed: {error}"))
    }
}

async fn shutdown_signal() -> Result<()> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result?,
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await?;
    Ok(())
}
