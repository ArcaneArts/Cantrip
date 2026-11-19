use crate::filesystem::Scope;
use anyhow::{Context, Result, anyhow, bail};
use cantrip_wire::{Value, parse_json_text, value::json};
use std::{
    ffi::{OsStr, OsString},
    io,
    time::Duration,
};

const DEADLINE: Duration = Duration::from_secs(60);
const MAX_RECEIPT: usize = 1024 * 1024;

pub(crate) struct DeliveryUnknown(pub(crate) String);
impl std::fmt::Debug for DeliveryUnknown {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("CantripOS delivery unknown")
    }
}
impl std::fmt::Display for DeliveryUnknown {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl std::error::Error for DeliveryUnknown {}

pub(crate) enum Transport {
    Docker(String),
    Ssh {
        host: String,
        port: u16,
        user: String,
        identity: String,
        known_hosts: String,
    },
}

/// Use only the established guest control programs. Neither carrier forwards
/// host credentials, and each SSH argument crosses the remote shell quoted.
pub(super) enum Program {
    Executor,
    Workspaces,
}

impl Transport {
    pub(crate) fn executor_connection(
        &self,
        binding: &Value,
    ) -> Result<(&'static OsStr, Vec<OsString>)> {
        let workspace = super::text(binding, "workspace_id")?;
        Ok(self.spec(
            Program::Executor,
            &["connect", workspace, "--expect", &binding.stringify()],
        ))
    }

    pub(crate) fn from_value(value: &Value) -> Result<Self> {
        let field = |name: &str| {
            value[name]
                .as_str()
                .map(str::to_owned)
                .context("OS transport field is unavailable.")
        };
        Ok(match value["kind"].as_str() {
            Some("docker") => Self::Docker(field("container")?),
            Some("ssh") => Self::Ssh {
                host: field("host")?,
                port: u16::try_from(value["port"].as_u64().context("OS transport port")?)?,
                user: field("user")?,
                identity: field("identityFile")?,
                known_hosts: field("knownHostsFile")?,
            },
            _ => bail!("Unsupported guest transport"),
        })
    }

    pub(super) fn spec(
        &self,
        program: Program,
        arguments: &[&str],
    ) -> (&'static OsStr, Vec<OsString>) {
        let guest = match program {
            Program::Executor => "/usr/bin/cantrip-executor",
            Program::Workspaces => "/usr/bin/cantrip-workspaces",
        };
        let strings = |values: &[&str]| values.iter().map(OsString::from).collect::<Vec<_>>();
        match self {
            Self::Docker(container) => {
                let mut args = strings(&["exec", "-i", "--user", "0", "--", container, guest]);
                args.extend(strings(arguments));
                (OsStr::new("docker"), args)
            }
            Self::Ssh {
                host,
                port,
                user,
                identity,
                known_hosts,
            } => {
                let mut args = strings(&[
                    "-T",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "StrictHostKeyChecking=yes",
                    "-o",
                    "ForwardAgent=no",
                    "-o",
                    "IdentitiesOnly=yes",
                    "-o",
                ]);
                let remote = ["sudo", "-n", "--", guest]
                    .into_iter()
                    .chain(arguments.iter().copied())
                    .map(|part| format!("'{}'", part.replace('\'', "'\\''")))
                    .collect::<Vec<_>>()
                    .join(" ");
                args.extend([
                    format!("UserKnownHostsFile={known_hosts}").into(),
                    "-i".into(),
                    identity.into(),
                    "-p".into(),
                    port.to_string().into(),
                    "--".into(),
                    format!("{user}@{host}").into(),
                    remote.into(),
                ]);
                (OsStr::new("ssh"), args)
            }
        }
    }

    pub(super) async fn control(
        &self,
        program: Program,
        arguments: &[&str],
        scope: &Scope,
    ) -> Result<Value> {
        let (command, args) = self.spec(program, arguments);
        scope.check()?;
        let result = scope
            .capture_timeout(command, &args, MAX_RECEIPT, DEADLINE)
            .await
            .map_err(|error| {
                if error.downcast_ref::<io::Error>().is_some_and(|e| {
                    matches!(
                        e.kind(),
                        io::ErrorKind::NotFound
                            | io::ErrorKind::PermissionDenied
                            | io::ErrorKind::InvalidInput
                    )
                }) {
                    error
                } else {
                    anyhow!(DeliveryUnknown(
                        "Executor control disconnected; reconcile before retrying a mutation"
                            .into()
                    ))
                }
            })?;
        if result.timed_out {
            return Err(DeliveryUnknown(
                "Executor control timed out; reconcile before retrying a mutation".into(),
            )
            .into());
        }
        if result.overflow.is_some() || result.code != Some(0) {
            let tail = &result.stderr[result.stderr.len().saturating_sub(4096)..];
            return Err(DeliveryUnknown(format!(
                "Executor control exited {}: {}",
                result
                    .code
                    .map_or_else(|| "null".into(), |code| code.to_string()),
                String::from_utf8_lossy(tail)
            ))
            .into());
        }
        parse_json_text(&String::from_utf8_lossy(&result.stdout)).map_err(|_| {
            DeliveryUnknown("Executor returned an invalid control receipt".into()).into()
        })
    }
}

pub(super) fn workspace(receipt: &Value) -> Result<Value> {
    super::checked(
        "cantripOsWorkspaceObservationSchema",
        json!({
            "guestWorkspaceId": receipt["id"], "uid": receipt["uid"], "gid": receipt["gid"],
            "homeGuestPath": receipt["home"],
        }),
    )
}
