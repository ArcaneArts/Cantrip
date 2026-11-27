//! A profile is private to its owning server and account on this worker.
use super::{Installation, Manager, storage::lock_file};
use crate::encryption::Service;
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, TryLockError},
    io::ErrorKind,
    path::PathBuf,
    time::Duration,
};
use tokio::process::Command;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Profile(Uuid);

impl Profile {
    pub fn bound(owner: &JsString, server: &JsString, account: Uuid) -> Self {
        let binding = json!({
            "scope": "cantrip.claude-code.profile.v1",
            "owner": owner, "server": server, "account": account.to_string(),
        });
        let digest = Sha256::digest(binding.stringify().as_bytes());
        let key = digest[..16].try_into().expect("16-byte profile ID");
        Self(uuid::Builder::from_custom_bytes(key).into_uuid())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SignIn {
    SignedOut,
    Subscription,
    Other,
}

impl SignIn {
    pub fn wire(self) -> &'static str {
        match self {
            Self::SignedOut => "signed-out",
            Self::Subscription => "signed-in",
            Self::Other => "unsupported-authentication",
        }
    }
}

pub struct ProfileLease {
    pub profile: Profile,
    _lock: File,
}

impl Manager {
    pub fn begin_sign_in(&self, profile: Profile) -> Result<ProfileLease> {
        let lease = self.lock_profile(profile)?;
        ensure!(
            !self.removed_profile(profile).try_exists()?,
            "This Claude Code account was removed."
        );
        Ok(lease)
    }

    fn removed_profile(&self, profile: Profile) -> PathBuf {
        self.storage
            .root
            .join("leases")
            .join(format!("account-{}.removed", profile.0))
    }

    fn lock_profile(&self, profile: Profile) -> Result<ProfileLease> {
        self.storage.prepare()?;
        let file = lock_file(
            &self
                .storage
                .root
                .join("leases")
                .join(format!("account-{}.lock", profile.0)),
        )?;
        match file.try_lock() {
            Ok(()) => Ok(ProfileLease {
                profile,
                _lock: file,
            }),
            Err(TryLockError::WouldBlock) => anyhow::bail!(
                "Claude Code is using this account. Try again when the request finishes."
            ),
            Err(TryLockError::Error(error)) => Err(error.into()),
        }
    }

    pub async fn auth_command(&self, request: &Value, encryption: &Service) -> Result<Value> {
        let (owner, identity) = encryption.bound_identity()?;
        let server = request["serverId"]
            .as_js_string()
            .context("Missing account server.")?;
        ensure!(
            identity.as_js_string() == Some(server),
            "Claude Code account belongs to a different server."
        );
        let account = Uuid::parse_str(
            request["accountId"]
                .as_str()
                .context("Missing Claude Code account.")?,
        )?;
        let profile = Profile::bound(&owner, server, account);
        let result = if request["type"] == "claude-code.auth.remove" {
            self.remove_profile(profile, || {
                ensure!(
                    encryption.bound_identity()? == (owner.clone(), identity.clone()),
                    "Claude Code account owner changed."
                );
                Ok(())
            })
            .await?;
            json!({"removed":true})
        } else {
            let status = self.sign_in_status(profile).await?;
            json!({"status":status.wire()})
        };
        ensure!(
            encryption.bound_identity()? == (owner, identity),
            "Claude Code account owner changed."
        );
        Ok(result)
    }

    async fn remove_profile(
        &self,
        profile: Profile,
        ensure_identity: impl Fn() -> Result<()>,
    ) -> Result<()> {
        let _lease = self.lock_profile(profile)?;
        let directory = self
            .storage
            .root
            .join("profiles")
            .join(profile.0.to_string());
        match fs::symlink_metadata(&directory) {
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            result => {
                ensure!(result?.is_dir(), "Claude Code profile is not a directory.");
                let installation = self.installation().await?;
                ensure_identity()?;
                if installation.sign_in_status(profile).await? != SignIn::SignedOut {
                    ensure_identity()?;
                    let mut command = installation.account_command(profile)?;
                    command.args(["auth", "logout"]).kill_on_drop(true);
                    tokio::time::timeout(Duration::from_secs(12), command.output())
                        .await
                        .context("Claude Code sign-out timed out.")??;
                    ensure!(
                        installation.sign_in_status(profile).await? == SignIn::SignedOut,
                        "Claude Code could not confirm sign-out."
                    );
                }
                ensure_identity()?;
                fs::remove_dir_all(directory)
                    .context("Could not remove the Claude Code profile.")?;
            }
        }
        ensure_identity()?;
        lock_file(&self.removed_profile(profile))?;
        Ok(())
    }

    pub async fn sign_in_status(&self, profile: Profile) -> Result<SignIn> {
        let root = self.storage.root.join("profiles");
        match fs::symlink_metadata(root.join(profile.0.to_string())) {
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(SignIn::SignedOut),
            result => ensure!(result?.is_dir(), "Claude Code profile is not a directory."),
        }
        let _lease = self.begin_sign_in(profile)?;
        let installation = self.installation().await?;
        installation.sign_in_status(profile).await
    }
}

impl Installation {
    pub(crate) fn account_command(&self, profile: Profile) -> Result<Command> {
        self.command(profile.0)
    }

    pub async fn sign_in_status(&self, profile: Profile) -> Result<SignIn> {
        let mut command = self.account_command(profile)?;
        command.args(["auth", "status"]).kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(12), command.output())
            .await
            .context("Claude Code sign-in status timed out.")??;
        ensure!(
            output.stdout.len() <= 16 * 1024,
            "Claude Code returned too much sign-in metadata."
        );
        let value = parse_json_text(std::str::from_utf8(&output.stdout)?)
            .map_err(|_| anyhow::anyhow!("Claude Code returned invalid sign-in status."))?;
        status(output.status.success(), &value)
    }
}

fn status(success: bool, value: &Value) -> Result<SignIn> {
    let logged_in = value["loggedIn"]
        .as_bool()
        .context("Claude Code did not report sign-in status.")?;
    if !logged_in {
        return Ok(SignIn::SignedOut);
    }
    ensure!(success, "Claude Code could not confirm sign-in.");
    Ok(if value["authMethod"] == "claude.ai" {
        SignIn::Subscription
    } else {
        SignIn::Other
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_depends_on_account_owner_and_server() {
        let account = Uuid::new_v4();
        let a = Profile::bound(&"owner".into(), &"server".into(), account);
        assert_eq!(
            a,
            Profile::bound(&"owner".into(), &"server".into(), account)
        );
        assert_ne!(
            a,
            Profile::bound(&"someone-else".into(), &"server".into(), account)
        );
        assert_ne!(
            a,
            Profile::bound(&"owner".into(), &"other-server".into(), account)
        );
        assert_ne!(
            a,
            Profile::bound(&"owner".into(), &"server".into(), Uuid::new_v4())
        );
    }

    #[test]
    fn subscription_status_is_affirmative_only_for_the_official_login() {
        assert_eq!(
            status(false, &json!({"loggedIn":false})).unwrap(),
            SignIn::SignedOut
        );
        assert_eq!(
            status(true, &json!({"loggedIn":true,"authMethod":"claude.ai"})).unwrap(),
            SignIn::Subscription
        );
        assert_eq!(
            status(true, &json!({"loggedIn":true,"authMethod":"api_key"})).unwrap(),
            SignIn::Other
        );
        assert!(status(true, &Value::Null).is_err());
        assert!(status(false, &json!({"loggedIn":true,"authMethod":"claude.ai"})).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn removal_logs_out_only_the_selected_profile_and_rejects_delayed_logins() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let manager = Manager::new(dir.path());
        super::super::tests::install_fixture(
            &manager,
            r#"#!/bin/sh
case "$1 $2" in
  'auth logout') rm -f "$CLAUDE_CONFIG_DIR/fixture-session" ;;
  'auth status')
    if [ -f "$CLAUDE_CONFIG_DIR/fixture-session" ]; then
      echo '{"loggedIn":true,"authMethod":"claude.ai"}'
    else
      echo '{"loggedIn":false}'
      exit 1
    fi ;;
  'fixture sign-in') touch "$CLAUDE_CONFIG_DIR/fixture-session" ;;
  *) exit 2 ;;
esac
"#,
        )?;
        let profiles = [Uuid::new_v4(), Uuid::new_v4()]
            .map(|id| Profile::bound(&"owner".into(), &"server".into(), id));
        let installation = manager.installation().await?;
        for profile in profiles {
            assert!(
                installation
                    .account_command(profile)?
                    .args(["fixture", "sign-in"])
                    .status()
                    .await?
                    .success()
            );
            assert_eq!(manager.sign_in_status(profile).await?, SignIn::Subscription);
        }
        let in_use = manager.begin_sign_in(profiles[0])?;
        assert!(
            manager
                .remove_profile(profiles[0], || Ok(()))
                .await
                .is_err()
        );
        drop(in_use);
        for _ in 0..2 {
            manager.remove_profile(profiles[0], || Ok(())).await?;
        }
        assert_eq!(
            manager.sign_in_status(profiles[0]).await?,
            SignIn::SignedOut
        );
        assert!(manager.begin_sign_in(profiles[0]).is_err());
        assert_eq!(
            manager.sign_in_status(profiles[1]).await?,
            SignIn::Subscription
        );
        Ok(())
    }
}
