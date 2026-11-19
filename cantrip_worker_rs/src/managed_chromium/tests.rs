use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::VerifyingKey;
use std::{fs, path::PathBuf};

#[test]
fn archive_entries_must_remain_inside_staging() {
    for name in [
        "../file",
        "/etc/file",
        "a/./file",
        "a//file",
        "C:/file",
        "a\\file",
        "a\0b",
    ] {
        assert!(archive::relative(name).is_err(), "{name}");
    }
    assert_eq!(
        archive::relative("browsers/chrome-headless-shell").unwrap(),
        PathBuf::from("browsers").join("chrome-headless-shell")
    );
}

#[tokio::test]
#[ignore = "run with scripts/worker-rust/managed-chromium-smoke.mjs"]
async fn signed_release_install_update_and_failure() -> Result<()> {
    let base = std::env::var("CANTRIP_TEST_CHROMIUM_MANIFEST")?;
    let certificate = fs::read(std::env::var_os("CANTRIP_TEST_CHROMIUM_CERTIFICATE").unwrap())?;
    let key = STANDARD.decode(std::env::var("CANTRIP_TEST_CHROMIUM_KEY")?)?;
    let data = tempfile::tempdir()?;
    let source = Source {
        client: source::client()?
            .add_root_certificate(reqwest::Certificate::from_pem(&certificate)?)
            .build()?,
        manifest: format!("{base}/first"),
        key_id: "fixture-ed25519".into(),
        key: VerifyingKey::from_bytes(key.as_slice().try_into()?)?,
    };
    let mut manager = Manager::new(data.path(), source);
    let logs = Logs::initialize(data.path(), &Environment::default(), data.path()).await;
    let action = |name| json!({"component":"playwright","action":name});
    let first = manager.action(&action("check-update"), &logs).await?;
    assert_eq!(first["status"]["state"], "ready", "{}", first.stringify());
    assert_eq!(first["status"]["installedVersion"], "fixture-1");
    let pointer = manager.storage.root.join("current.json");
    let original = fs::read(&pointer)?;
    let existing = manager.action(&action("check-update"), &logs).await?;
    assert_eq!(existing["status"]["state"], "ready");
    assert_eq!(fs::read(&pointer)?, original);
    let installed = manager.action(&action("reinstall"), &logs).await?;
    assert_eq!(
        installed["status"]["state"],
        "ready",
        "{}",
        installed.stringify()
    );
    let original = fs::read(&pointer)?;
    for (route, category) in [
        ("unsigned", "signature"),
        ("wrong-digest", "integrity"),
        ("unhealthy", "health-check"),
        ("duplicate", "integrity"),
    ] {
        manager.source.manifest = format!("{base}/{route}");
        let rejected = manager.action(&action("check-update"), &logs).await?;
        assert_eq!(
            rejected["status"]["state"],
            "degraded",
            "{}",
            rejected.stringify()
        );
        assert_eq!(
            rejected["status"]["failure"]["category"],
            category,
            "{}",
            rejected.stringify()
        );
        assert_eq!(fs::read(&pointer)?, original);
        assert!(
            fs::read_dir(manager.storage.root.join("staging"))?
                .next()
                .is_none()
        );
    }
    manager.source.manifest = format!("{base}/second");
    let updated = manager.action(&action("check-update"), &logs).await?;
    assert_eq!(
        updated["status"]["installedVersion"],
        "fixture-2",
        "{}",
        updated.stringify()
    );
    assert_eq!(updated["status"]["previousVersion"], "fixture-1");
    let profiles = manager.storage.root.join("state/profiles");
    fs::create_dir_all(&profiles)?;
    fs::write(profiles.join("owned-test-marker"), b"fixture")?;
    manager.action(&action("clear-profiles"), &logs).await?;
    assert!(fs::read_dir(profiles)?.next().is_none());
    let cleared = manager.action(&action("clear-cache"), &logs).await?;
    assert_eq!(cleared["status"]["installedVersion"], "fixture-2");
    logs.close().await;
    Ok(())
}
