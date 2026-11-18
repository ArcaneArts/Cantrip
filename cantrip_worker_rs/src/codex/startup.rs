use super::discovery::{self, Options};
use crate::{config::Config, installation::verify, logging::Logs};
use anyhow::Result;
use cantrip_config::Environment;
use cantrip_wire::{Value, value::json};
use std::path::Path;
/// Discover the installed native runtime without advertising an unfinished
/// worker execution adapter. The report will feed its owning runtime clients.
pub async fn prepare(
    config: &Config,
    cwd: &Path,
    environment: &Environment,
    logs: &Logs,
) -> Result<Value> {
    let installation = &config.codex_installation;
    let manifest = verify::verify(
        installation,
        crate::platform::platform(),
        crate::platform::architecture(),
        cwd,
    )
    .await?;
    let mut options = Options::local(
        cwd.into(),
        environment
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    );
    options.bundled = manifest.is_some();
    let report = discovery::discover(
        &installation.binary,
        &config.data_directory.join("codex-compatibility-probe"),
        &options,
    )
    .await?;
    if let Some(manifest) = manifest
        && report["version"]["semantic"] != manifest["version"]
    {
        anyhow::bail!(
            "Bundled Codex reports {}; manifest expects {}.",
            report["version"]["semantic"]
                .as_str()
                .unwrap_or("no version"),
            manifest["version"].as_js_string().unwrap().lossy()
        );
    }
    logs.event("info","Codex runtime discovery completed",json!({"event":"codex.runtime.discovered","subsystem":"worker-startup","operation":"probe-codex-runtime","workerId":config.worker_id,"compatibility":report["compatibility"],"version":report["version"],"source":installation.source}));
    Ok(report)
}
