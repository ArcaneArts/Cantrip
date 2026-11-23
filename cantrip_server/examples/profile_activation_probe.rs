//! Deterministic local interruption of real profile activation operations.
//! This example is not part of the packaged server.
use anyhow::{Context, Result};
use cantrip_server::profile::activate_profile_with_progress;
use serde_json::json;
use std::{io::Write, path::PathBuf};

fn main() -> Result<()> {
    let mut arguments = std::env::args_os().skip(1);
    let source = PathBuf::from(arguments.next().context("prepared profile")?);
    let destination = PathBuf::from(arguments.next().context("active profile")?);
    let pause = arguments.next().context("pause after step")?;
    activate_profile_with_progress(&source, &destination, |step| {
        let value = serde_json::to_value(step).unwrap();
        if value.as_str() == pause.to_str() {
            println!(
                "{}",
                json!({"event":"profile.activation.paused","step":step})
            );
            std::io::stdout().flush().unwrap();
            loop {
                std::thread::park();
            }
        }
    })?;
    Ok(())
}
