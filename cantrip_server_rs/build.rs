use std::{env, fs, path::PathBuf};

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
