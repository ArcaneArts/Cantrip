use anyhow::Result;
use cantrip_server::{
    config::DatabaseMode,
    profile::{Bundle, ProfileFailure, pack_profile},
};
use std::{fs, path::Path};

fn fixture(root: &Path) -> Result<()> {
    fs::create_dir_all(root.join("nested 😺/empty"))?;
    fs::create_dir_all(root.join("server-db"))?;
    fs::write(
        root.join("server-db/physical-database"),
        b"must not copy physical engine files",
    )?;
    fs::write(
        root.join("secret-encryption-key.json"),
        b"opaque existing key bytes\0\xff\r\n",
    )?;
    fs::write(
        root.join("nested 😺/state.bin"),
        b"private\r\nstate\nbare\rend",
    )?;
    Ok(())
}
#[test]
fn opaque_files_empty_directories_and_sql_publish_together() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let source = temp.path().join("source");
    fixture(&source)?;
    let sql = temp.path().join("trusted.sql");
    fs::write(&sql, b"SELECT 'sql\r\nbytes';\n")?;
    let bundle = temp.path().join("bundle");
    let exported = pack_profile(&source, &sql, DatabaseMode::Pglite, &bundle)?;
    assert_eq!(exported.file_count, 2);
    let manifest = fs::read_to_string(bundle.join("manifest.json"))?;
    assert!(manifest.contains("nested 😺/state.bin"));
    let destination = temp.path().join("materialized");
    let stage = Bundle::open(&bundle)?.stage(&destination)?;
    assert!(!destination.exists());
    let result = stage.materialize()?;
    assert_eq!(result.bundle_id, exported.bundle_id);
    assert_eq!(
        fs::read(destination.join("server-profile-import.sql"))?,
        fs::read(sql)?
    );
    for path in ["secret-encryption-key.json", "nested 😺/state.bin"] {
        assert_eq!(
            fs::read(source.join(path))?,
            fs::read(destination.join(path))?
        );
    }
    assert!(destination.join("nested 😺/empty").is_dir());
    assert!(!destination.join("server-db").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&destination)?.permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(destination.join("secret-encryption-key.json"))?
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    Ok(())
}
#[test]
fn publication_never_replaces_even_an_empty_existing_destination() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let source = temp.path().join("source");
    fixture(&source)?;
    let sql = temp.path().join("trusted.sql");
    fs::write(&sql, b"SELECT 1")?;
    let output = temp.path().join("existing");
    fs::create_dir(&output)?;
    let error = pack_profile(&source, &sql, DatabaseMode::Pglite, &output)
        .err()
        .expect("actual rename must fail");
    assert_eq!(
        error.downcast_ref::<ProfileFailure>().unwrap().io_kind,
        Some(std::io::ErrorKind::AlreadyExists)
    );
    assert_eq!(fs::read_dir(&output)?.count(), 0);
    fs::write(output.join("keep"), b"unrelated existing bytes")?;
    assert!(pack_profile(&source, &sql, DatabaseMode::Pglite, &output).is_err());
    assert_eq!(fs::read(output.join("keep"))?, b"unrelated existing bytes");
    Ok(())
}
#[test]
fn tampered_assets_and_path_traversal_never_create_the_destination() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let source = temp.path().join("source");
    fixture(&source)?;
    let sql = temp.path().join("trusted.sql");
    fs::write(&sql, b"SELECT 1")?;
    let bundle = temp.path().join("bundle");
    pack_profile(&source, &sql, DatabaseMode::Pglite, &bundle)?;
    let original = fs::read(bundle.join("files/secret-encryption-key.json"))?;
    fs::write(
        bundle.join("files/secret-encryption-key.json"),
        b"private-tampered-key",
    )?;
    let destination = temp.path().join("restored");
    let error = Bundle::open(&bundle)?
        .stage(&destination)
        .err()
        .expect("actual checksum mismatch");
    assert!(!format!("{error:?}").contains("private-tampered-key"));
    assert!(!destination.exists());
    fs::write(bundle.join("files/secret-encryption-key.json"), original)?;
    let manifest = fs::read(bundle.join("manifest.json"))?;
    for path in [
        "../outside",
        "/outside",
        "x/../../outside",
        "C:\\outside",
        "x\\..\\outside",
    ] {
        let mut value: serde_json::Value = serde_json::from_slice(&manifest)?;
        value["files"][0]["path"] = serde_json::json!(path);
        fs::write(bundle.join("manifest.json"), serde_json::to_vec(&value)?)?;
        let result = Bundle::open(&bundle).and_then(|bundle| bundle.stage(&destination));
        assert!(result.is_err());
        assert!(!destination.exists());
        assert!(!temp.path().join("outside").exists());
    }
    Ok(())
}
#[test]
fn changed_sql_is_rejected_without_publication_and_keeps_private_diagnostics() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let source = temp.path().join("source");
    fixture(&source)?;
    let sql = temp.path().join("trusted.sql");
    fs::write(&sql, b"SELECT 'original';")?;
    let bundle = temp.path().join("bundle");
    pack_profile(&source, &sql, DatabaseMode::Pglite, &bundle)?;
    fs::write(
        bundle.join("database.sql"),
        b"SELECT 'private-changed-sql';",
    )?;
    let destination = temp.path().join("restored");
    let error = Bundle::open(&bundle)?
        .stage(&destination)
        .err()
        .expect("changed SQL must fail");
    let private = error.downcast_ref::<ProfileFailure>().unwrap();
    assert!(private.original().to_string().contains("SQL checksum"));
    assert!(!format!("{error:?}").contains("SQL checksum"));
    assert!(!format!("{error:#}").contains("private-changed-sql"));
    assert!(!destination.exists());
    assert!(!fs::read_dir(temp.path())?.any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".cantrip-profile-")
    }));
    Ok(())
}
#[test]
fn export_inside_the_profile_does_not_recurse_into_its_own_stage() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let source = temp.path().join("source");
    fixture(&source)?;
    let sql = temp.path().join("trusted.sql");
    fs::write(&sql, b"SELECT 1")?;
    let result = pack_profile(
        &source,
        &sql,
        DatabaseMode::Pglite,
        &source.join("backups/bundle"),
    )?;
    assert_eq!(result.file_count, 2);
    Ok(())
}
#[cfg(unix)]
#[test]
fn file_links_are_materialized_and_directory_cycles_fail_without_publication() -> Result<()> {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir()?;
    let source = temp.path().join("source");
    fixture(&source)?;
    let sql = temp.path().join("trusted.sql");
    fs::write(&sql, b"SELECT 1")?;
    symlink(
        source.join("secret-encryption-key.json"),
        source.join("linked-key"),
    )?;
    let bundle = temp.path().join("bundle");
    pack_profile(&source, &sql, DatabaseMode::Pglite, &bundle)?;
    assert!(fs::symlink_metadata(bundle.join("files/linked-key"))?.is_file());
    symlink(&source, source.join("cycle"))?;
    let output = temp.path().join("cycle-output");
    assert!(pack_profile(&source, &sql, DatabaseMode::Pglite, &output).is_err());
    assert!(!output.exists());
    Ok(())
}

#[cfg(unix)]
#[test]
fn stopped_chromium_profile_keeps_data_without_process_links() -> Result<()> {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir()?;
    let source = temp.path().join("source");
    fixture(&source)?;
    let browser = "worker/browser/profiles/captured";
    let profile = source.join(browser);
    fs::create_dir_all(&profile)?;
    fs::write(profile.join("Preferences"), b"saved browser state")?;
    for name in [
        "RunningChromeVersion",
        "SingletonCookie",
        "SingletonLock",
        "SingletonSocket",
    ] {
        symlink("stopped-process", profile.join(name))?;
    }
    // The same name outside Chromium's profile still describes user data.
    let unrelated = source.join("SingletonLock");
    symlink("secret-encryption-key.json", &unrelated)?;
    let sql = temp.path().join("trusted.sql");
    fs::write(&sql, b"SELECT 1")?;
    let bundle = temp.path().join("bundle");
    pack_profile(&source, &sql, DatabaseMode::Pglite, &bundle)?;
    let staged = bundle.join("files").join(browser);
    assert_eq!(
        fs::read(staged.join("Preferences"))?,
        b"saved browser state"
    );
    assert_eq!(fs::read_dir(&staged)?.count(), 1);
    assert_eq!(
        fs::read(bundle.join("files/SingletonLock"))?,
        fs::read(unrelated)?
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn retains_unix_asset_names_with_colons_through_logical_restore() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let source = temp.path().join("source");
    let template = Path::new("worker/managed-runtimes/searxng/app/templates/searxng:example");
    fs::create_dir_all(source.join(template).parent().unwrap())?;
    fs::write(source.join(template), b"retained search runtime template")?;
    let sql = temp.path().join("trusted.sql");
    fs::write(&sql, b"SELECT 1")?;
    let bundle = temp.path().join("bundle");
    pack_profile(&source, &sql, DatabaseMode::Pglite, &bundle)?;
    let destination = temp.path().join("restored");
    Bundle::open(&bundle)?.stage(&destination)?.materialize()?;
    assert_eq!(
        fs::read(destination.join(template))?,
        b"retained search runtime template"
    );
    Ok(())
}
