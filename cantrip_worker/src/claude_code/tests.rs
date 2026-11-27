use super::*;

#[test]
fn verifies_the_anthropic_release_manifest() -> Result<()> {
    let manifest = include_bytes!("fixtures/manifest.json");
    let signature = include_bytes!("fixtures/manifest.json.sig");
    release::verify_manifest(manifest, signature)?;
    let mut changed = manifest.to_vec();
    changed.push(b' ');
    assert!(release::verify_manifest(&changed, signature).is_err());
    assert!(release::verify_manifest(manifest, b"bad signature").is_err());

    let origin = url::Url::parse("https://downloads.claude.ai/claude-code-releases/")?;
    let version = release::Version::parse("2.1.332")?;
    for target in [
        "darwin-arm64",
        "darwin-x64",
        "linux-arm64",
        "linux-x64",
        "linux-arm64-musl",
        "linux-x64-musl",
        "win32-arm64",
        "win32-x64",
    ] {
        let release = release::read_manifest(&origin, manifest, version, target)?;
        assert!(release.size > 0);
    }
    assert!(
        release::read_manifest(
            &origin,
            manifest,
            release::Version::parse("2.1.333")?,
            "darwin-arm64"
        )
        .is_err()
    );
    assert!(release::Version::parse("../2.1.332").is_err());
    Ok(())
}

#[cfg(target_os = "macos")]
#[test]
fn retains_macos_home_for_keychain_and_scopes_claude_config() -> Result<()> {
    let root = tempfile::tempdir()?;
    let home = std::env::home_dir().context("Missing macOS user home")?;
    for name in ["first", "second"] {
        let command = command(Path::new("/usr/bin/true"), &root.path().join(name))?;
        let command = command.as_std();
        let profile = command
            .get_current_dir()
            .context("Missing Claude profile")?;
        let environment = |key: &str| {
            command
                .get_envs()
                .find_map(|(name, value)| (name == key).then_some(value).flatten())
        };
        assert_eq!(environment("HOME"), Some(home.as_os_str()));
        assert_eq!(environment("USERPROFILE"), Some(profile.as_os_str()));
        assert_eq!(
            environment("CLAUDE_CONFIG_DIR"),
            Some(profile.join("config").as_os_str())
        );
    }
    Ok(())
}

#[tokio::test]
#[ignore = "downloads the current public native binary and runs only --version"]
async fn installs_public_claude_code_release_without_signing_in() -> Result<()> {
    let data = tempfile::tempdir()?;
    let manager = Manager::new(data.path());
    let installation = manager.installation().await?;
    println!("Verified Claude Code {}", installation.version());
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn installs_updates_rolls_back_and_isolates_profiles() -> Result<()> {
    use bytes::Bytes;
    use http_body_util::Full;
    use hyper::{Request, Response, body::Incoming, server::conn::http1, service::service_fn};
    use hyper_util::rt::TokioIo;
    use sha2::{Digest, Sha256};
    use std::{
        convert::Infallible,
        sync::{Arc, Mutex},
    };
    use tokio::net::TcpListener;

    struct Fixture {
        release: &'static str,
        output: &'static str,
        authentic: bool,
    }

    let data = tempfile::tempdir()?;
    let personal = data.path().join("personal");
    fs::create_dir(&personal)?;
    fs::write(personal.join(".claude.json"), b"personal settings")?;
    let managed = data.path().join("worker");
    let manager = Manager::new(&managed);
    assert!(manager.update_installed().await.is_ok());
    assert!(!managed.exists());

    let fixture = Arc::new(Mutex::new(Fixture {
        release: "2.1.1",
        output: "2.1.1",
        authentic: true,
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let origin = url::Url::parse(&format!("http://{}/", listener.local_addr()?))?;
    let server = tokio::spawn({
        let fixture = fixture.clone();
        async move {
            while let Ok((stream, _)) = listener.accept().await {
                let fixture = fixture.clone();
                let service = service_fn(move |request: Request<Incoming>| {
                    let content = {
                        let fixture = fixture.lock().unwrap();
                        let binary = format!(
                            "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '{} (Claude Code)'; else printf '%s\\n' \"$HOME\" \"$CLAUDE_CONFIG_DIR\" \"$DISABLE_UPDATES\"; fi\n",
                            fixture.output
                        );
                        let checksum = if fixture.authentic {
                            release::hex(&Sha256::digest(binary.as_bytes()))
                        } else {
                            "0".repeat(64)
                        };
                        match request.uri().path() {
                            "/latest" => fixture.release.to_owned(),
                            path if path.ends_with("/manifest.json") => {
                                let mut manifest =
                                    json!({"version": fixture.release, "platforms": {}});
                                manifest["platforms"][release::target().unwrap()] = json!({
                                    "binary": BINARY, "size": binary.len(), "checksum": checksum
                                });
                                manifest.stringify()
                            }
                            path if path.ends_with("/manifest.json.sig") => {
                                "fixture signature".into()
                            }
                            _ => binary,
                        }
                    };
                    async move { Ok::<_, Infallible>(Response::new(Full::new(Bytes::from(content)))) }
                });
                tokio::spawn(async move {
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        }
    });
    let source = Source::fixture(origin, |_, signature| {
        ensure!(signature == b"fixture signature");
        Ok(())
    });

    manager.install(&source, false).await?;
    let first = manager
        .current()
        .await?
        .context("Missing first installation.")?;
    assert_eq!(first.version(), "2.1.1");
    let profile_a = uuid::Uuid::new_v4();
    let profile_b = uuid::Uuid::new_v4();
    let mut outputs = Vec::new();
    for profile in [profile_a, profile_b] {
        let output = first.command(profile)?.output().await?;
        assert!(output.status.success());
        let output = String::from_utf8(output.stdout)?;
        let mut lines = output.lines();
        let home = lines.next().context("Missing Claude home")?;
        #[cfg(target_os = "macos")]
        assert_eq!(Some(Path::new(home)), std::env::home_dir().as_deref());
        #[cfg(not(target_os = "macos"))]
        assert!(home.ends_with(&profile.to_string()));
        assert!(
            lines
                .next()
                .context("Missing Claude config directory")?
                .ends_with(&format!("{profile}/config"))
        );
        assert_eq!(output.lines().last(), Some("1"));
        outputs.push(output);
    }
    assert_ne!(outputs[0], outputs[1]);

    for (output, authentic) in [("2.1.1", true), ("2.1.2", false)] {
        *fixture.lock().unwrap() = Fixture {
            release: "2.1.2",
            output,
            authentic,
        };
        assert!(manager.install(&source, true).await.is_err());
        assert_eq!(manager.current().await?.unwrap().version(), "2.1.1");
    }
    for version in ["2.1.2", "2.1.3"] {
        *fixture.lock().unwrap() = Fixture {
            release: version,
            output: version,
            authentic: true,
        };
        manager.install(&source, true).await?;
        assert_eq!(manager.current().await?.unwrap().version(), version);
    }

    let first_path = first.executable.clone();
    assert!(first_path.exists(), "leased binary must survive updates");
    assert!(first.command(profile_a)?.output().await?.status.success());
    drop(first);
    manager.install(&source, true).await?;
    assert!(!first_path.exists(), "unleased binary should be cleaned up");
    let current = manager.current().await?.unwrap();
    let damaged = current.executable.clone();
    drop(current);
    fs::remove_file(damaged)?;
    assert_eq!(manager.current().await?.unwrap().version(), "2.1.2");
    assert_eq!(
        fs::read(personal.join(".claude.json"))?,
        b"personal settings"
    );
    server.abort();
    Ok(())
}

#[cfg(unix)]
pub(crate) fn install_fixture(manager: &Manager, script: &str) -> Result<()> {
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::PermissionsExt;

    manager.storage.prepare()?;
    let stage = manager.storage.stage()?;
    let binary = stage.path().join(BINARY);
    fs::write(&binary, script)?;
    fs::set_permissions(binary, fs::Permissions::from_mode(0o700))?;
    let installed = Installed {
        version: release::Version::parse("2.1.1")?,
        size: script.len() as u64,
        checksum: release::hex(&Sha256::digest(script.as_bytes())),
    };
    manager.storage.promote(stage.path(), &installed)?;
    manager.storage.write(&Pointer {
        active: installed,
        previous: None,
    })
}
