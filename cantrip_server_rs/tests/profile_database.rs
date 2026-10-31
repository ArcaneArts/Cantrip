use cantrip_server::{
    config::{DatabaseMode, Environment, ServerConfig},
    profile::{apply_database, remember_database},
};
use std::path::Path;

fn environment(root: &Path) -> Environment {
    Environment::from([("CANTRIP_DATA_DIR".into(), root.to_str().unwrap().into())])
}

#[test]
fn stored_external_connection_survives_restart_without_printing_credentials() {
    let root = tempfile::tempdir().unwrap();
    let url = "postgresql://owner:private-password@localhost/existing";
    let mut input = environment(root.path());
    input.insert("DATABASE_URL".into(), url.into());
    let config = ServerConfig::read(&input, root.path()).unwrap();
    remember_database(&config).unwrap();
    let mut restarted = environment(root.path());
    apply_database(&mut restarted, root.path()).unwrap();
    let config = ServerConfig::read(&restarted, root.path()).unwrap();
    assert!(config.database_mode == DatabaseMode::Postgres);
    assert_eq!(config.database_url.as_deref(), Some(url));
    let mut empty_override = environment(root.path());
    empty_override.insert("DATABASE_URL".into(), " \t".into());
    apply_database(&mut empty_override, root.path()).unwrap();
    let config = ServerConfig::read(&empty_override, root.path()).unwrap();
    assert!(config.database_mode == DatabaseMode::Postgres);
    assert_eq!(config.database_url.as_deref(), Some(url));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(root.path().join("server-database.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn stored_local_modes_keep_their_selection_and_binary_path() {
    let root = tempfile::tempdir().unwrap();
    for (mode, expected) in [
        ("pglite", DatabaseMode::Pglite),
        ("bundled-postgres", DatabaseMode::BundledPostgres),
    ] {
        let mut input = environment(root.path());
        input.insert("CANTRIP_DATABASE_MODE".into(), mode.into());
        input.insert(
            "CANTRIP_POSTGRES_BIN_DIR".into(),
            "relative-binaries".into(),
        );
        let config = ServerConfig::read(&input, root.path()).unwrap();
        remember_database(&config).unwrap();
        let mut restarted = environment(root.path());
        apply_database(&mut restarted, root.path()).unwrap();
        let config = ServerConfig::read(&restarted, root.path()).unwrap();
        assert!(config.database_mode == expected);
        assert_eq!(
            config.postgres_bin_directory.as_deref(),
            Some(root.path().join("relative-binaries").as_path())
        );
        assert!(!root.path().join("server-db").exists());
        assert!(!root.path().join("postgres").exists());
    }
}

#[test]
fn explicit_backend_inputs_override_a_broken_profile_without_a_metadata_gate() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("server-database.json"),
        "not-json-private-credential",
    )
    .unwrap();
    let mut external = environment(root.path());
    external.insert(
        "DATABASE_URL".into(),
        "postgresql://owner:explicit@localhost/selected".into(),
    );
    apply_database(&mut external, root.path()).unwrap();
    assert!(
        ServerConfig::read(&external, root.path())
            .unwrap()
            .database_mode
            == DatabaseMode::Postgres
    );
    let mut local = environment(root.path());
    local.insert("CANTRIP_DATABASE_MODE".into(), "pglite".into());
    apply_database(&mut local, root.path()).unwrap();
    assert!(
        ServerConfig::read(&local, root.path())
            .unwrap()
            .database_mode
            == DatabaseMode::Pglite
    );
    let mut implicit = environment(root.path());
    let error = apply_database(&mut implicit, root.path()).unwrap_err();
    assert!(!format!("{error:?}").contains("private-credential"));
    assert!(
        std::fs::read_to_string(root.path().join("server-database.json"))
            .unwrap()
            .contains("private-credential")
    );
}

#[test]
fn existing_environment_overrides_stored_values_and_an_empty_url_never_resets_storage() {
    let root = tempfile::tempdir().unwrap();
    let mut input = environment(root.path());
    input.insert("CANTRIP_DATABASE_MODE".into(), "bundled-postgres".into());
    input.insert(
        "CANTRIP_POSTGRES_BIN_DIR".into(),
        "previous-binaries".into(),
    );
    remember_database(&ServerConfig::read(&input, root.path()).unwrap()).unwrap();
    let mut restarted = environment(root.path());
    restarted.insert("DATABASE_URL".into(), " \t".into());
    restarted.insert("CANTRIP_POSTGRES_BIN_DIR".into(), "updated-binaries".into());
    apply_database(&mut restarted, root.path()).unwrap();
    let config = ServerConfig::read(&restarted, root.path()).unwrap();
    assert!(config.database_mode == DatabaseMode::BundledPostgres);
    assert_eq!(
        config.postgres_bin_directory.as_deref(),
        Some(root.path().join("updated-binaries").as_path())
    );
}

#[test]
fn an_unconfigured_existing_profile_keeps_the_original_environment_default() {
    let root = tempfile::tempdir().unwrap();
    let mut input = environment(root.path());
    apply_database(&mut input, root.path()).unwrap();
    assert!(
        ServerConfig::read(&input, root.path())
            .unwrap()
            .database_mode
            == DatabaseMode::Pglite
    );
    assert!(!root.path().join("server-database.json").exists());
}
