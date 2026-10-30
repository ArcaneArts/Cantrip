use std::{env, fs, path::PathBuf, process::Command};

use sha2::{Digest, Sha256};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // A dependency's build-script link arguments do not propagate to the final
    // executable. PL/pgSQL resolves backend symbols from that executable.
    match env::var("CARGO_CFG_TARGET_OS")?.as_str() {
        "macos" => println!("cargo:rustc-link-arg=-Wl,-export_dynamic"),
        "linux" => println!("cargo:rustc-link-arg=-Wl,--export-dynamic"),
        _ => {}
    }
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?).join("..");
    println!(
        "cargo:rerun-if-changed={}",
        root.join("version.json").display()
    );
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
    for name in [
        "scripts/version.mjs",
        "scripts/server-rust/build-version.mjs",
    ] {
        println!("cargo:rerun-if-changed={}", root.join(name).display());
    }
    let git = |args: &[&str]| -> Result<String, Box<dyn std::error::Error>> {
        let output = Command::new("git").args(args).current_dir(&root).output()?;
        if !output.status.success() {
            return Err(format!(
                "git {}: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr)
            )
            .into());
        }
        Ok(String::from_utf8(output.stdout)?.trim().into())
    };
    let version = Command::new("node")
        .arg("scripts/server-rust/build-version.mjs")
        .current_dir(&root)
        .output()?;
    if !version.status.success() {
        return Err(format!(
            "resolve build version: {}",
            String::from_utf8_lossy(&version.stderr)
        )
        .into());
    }
    let _: serde_json::Value = serde_json::from_slice(&version.stdout)?;
    fs::write(
        PathBuf::from(env::var("OUT_DIR")?).join("version.json"),
        version.stdout,
    )?;
    if let Ok(head) = git(&["rev-parse", "--git-path", "HEAD"]) {
        println!("cargo:rerun-if-changed={}", root.join(head).display());
    }
    if let Ok(reference) = git(&["symbolic-ref", "-q", "HEAD"])
        && let Ok(path) = git(&["rev-parse", "--git-path", &reference])
    {
        println!("cargo:rerun-if-changed={}", root.join(path).display());
    }
    let directory = root.join("cantrip_server/drizzle");
    let journal_path = directory.join("meta/_journal.json");
    println!("cargo:rerun-if-changed={}", journal_path.display());
    let journal: serde_json::Value = serde_json::from_slice(&fs::read(journal_path)?)?;
    let mut generated = String::from("pub const MIGRATIONS: &[Migration] = &[\n");
    for entry in journal["entries"]
        .as_array()
        .ok_or("missing migration entries")?
    {
        let name = entry["tag"].as_str().ok_or("missing migration tag")?;
        let when = entry["when"]
            .as_i64()
            .ok_or("missing migration timestamp")?;
        let source_path = directory.join(format!("{name}.sql"));
        println!("cargo:rerun-if-changed={}", source_path.display());
        let sql = fs::read_to_string(source_path)?;
        let hash = format!("{:x}", Sha256::digest(sql.as_bytes()));
        generated.push_str(&format!(
            "Migration {{ name: {name:?}, when: {when}, hash: {hash:?}, sql: {sql:?} }},\n"
        ));
    }
    generated.push_str("];\n");
    fs::write(
        PathBuf::from(env::var("OUT_DIR")?).join("migrations.rs"),
        generated,
    )?;
    Ok(())
}
