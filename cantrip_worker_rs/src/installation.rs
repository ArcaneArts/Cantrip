//! Resolution policy from the Node worker. Discovery does not verify or launch
//! Codex; manifest verification and runtime probing belong to their startup phase.
use cantrip_config::resolve;
use cantrip_wire::{Value, value::json};
use std::path::{Path, PathBuf};
pub mod verify;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Installation {
    pub binary: PathBuf,
    pub manifest_path: Option<PathBuf>,
    pub source: &'static str,
}

impl Installation {
    pub fn to_value(&self) -> Value {
        json!({"binary":self.binary.to_string_lossy(), "manifestPath":self.manifest_path.as_ref().map(|p| p.to_string_lossy().into_owned()), "source":self.source})
    }
}

pub fn discover(
    worker_root: &Path,
    platform: &str,
    architecture: &str,
    explicit: Option<&str>,
) -> Installation {
    if let Some(binary) = explicit.filter(|value| !value.is_empty()) {
        return Installation {
            binary: binary.into(),
            manifest_path: None,
            source: "override",
        };
    }
    let executable = if platform == "win32" {
        "codex.exe"
    } else {
        "codex"
    };
    let workspace = resolve(
        worker_root,
        Path::new(&format!(
            "../cantrip_codex/.build/{platform}-{architecture}/bundle"
        )),
    );
    for (directory, source) in [
        (worker_root.join("bin"), "bundle"),
        (workspace, "workspace"),
    ] {
        let binary = directory.join(executable);
        let manifest_path = directory.join("codex-runtime.json");
        if binary.exists() || manifest_path.exists() {
            return Installation {
                binary,
                manifest_path: Some(manifest_path),
                source,
            };
        }
    }
    Installation {
        binary: "codex".into(),
        manifest_path: None,
        source: "path",
    }
}
