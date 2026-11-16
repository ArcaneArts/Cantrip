use std::{env, fs, path::PathBuf, process::Command};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?).join("..");
    for path in [
        "version.json",
        "scripts/version.mjs",
        "scripts/worker-rust/build-version.mjs",
    ] {
        println!("cargo:rerun-if-changed={}", root.join(path).display());
    }
    for name in [
        "CANTRIP_VERSION_PATCH",
        "CANTRIP_SYNTHETIC_BUILD",
        "CANTRIP_SYNTHETIC_COMMIT_SHA",
        "CANTRIP_SYNTHETIC_BUILT_AT",
        "CANTRIP_SYNTHETIC_BUILD_ID",
        "CANTRIP_SYNTHETIC_OVERLAY_DIGEST",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    let version = Command::new("node")
        .arg("scripts/worker-rust/build-version.mjs")
        .current_dir(&root)
        .output()?;
    if !version.status.success() {
        return Err(format!(
            "resolve worker build version: {}",
            String::from_utf8_lossy(&version.stderr)
        )
        .into());
    }
    fs::write(
        PathBuf::from(env::var("OUT_DIR")?).join("version.json"),
        version.stdout,
    )?;
    for arguments in [
        vec!["rev-parse", "--git-path", "HEAD"],
        vec!["symbolic-ref", "-q", "HEAD"],
    ] {
        let Ok(output) = Command::new("git")
            .args(&arguments)
            .current_dir(&root)
            .output()
        else {
            continue;
        };
        if output.status.success() {
            let value = String::from_utf8(output.stdout)?.trim().to_owned();
            let path = if arguments[0] == "symbolic-ref" {
                let Ok(resolved) = Command::new("git")
                    .args(["rev-parse", "--git-path", &value])
                    .current_dir(&root)
                    .output()
                else {
                    continue;
                };
                if !resolved.status.success() {
                    continue;
                }
                String::from_utf8(resolved.stdout)?.trim().to_owned()
            } else {
                value
            };
            println!("cargo:rerun-if-changed={}", root.join(path).display());
        }
    }
    if env::var("CARGO_CFG_TARGET_OS")? == "windows" {
        println!("cargo:rerun-if-changed=windows.rc");
        println!("cargo:rerun-if-changed=windows.manifest");
        embed_resource::compile_for_everything("windows.rc", embed_resource::NONE)
            .manifest_required()
            .expect("embed Windows UTF-8 process manifest");
    }
    Ok(())
}
