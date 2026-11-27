//! Noninteractive Claude Code with the worker-owned subscription profile.
use super::{Installation, Manager, Profile};
use crate::metadata::Signal;
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, parse_json_text};
use std::{
    process::{ExitStatus, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Child,
};

const PROMPT_LIMIT: usize = 8 * 1024 * 1024;
const OUTPUT_LIMIT: u64 = 8 * 1024 * 1024;
const ERROR_LIMIT: u64 = 256 * 1024;

pub(crate) struct Prompt<'a> {
    pub model: &'a str,
    pub instructions: &'a str,
    pub text: &'a str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Failure {
    SignIn,
    Quota,
    Model,
    Timeout,
    InvalidOutput,
    Execution,
}

impl Failure {
    pub fn code(self) -> &'static str {
        match self {
            Self::SignIn => "provider-reauth-required",
            Self::Quota => "claude-code-quota",
            Self::Model => "claude-code-model-unavailable",
            Self::Timeout => "claude-code-timeout",
            Self::InvalidOutput => "claude-code-invalid-output",
            Self::Execution => "claude-code-inference-failed",
        }
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::SignIn => "Sign in to this Claude Code account on its worker and try again.",
            Self::Quota => "This Claude Code account has reached a usage limit.",
            Self::Model => "Claude Code could not use the selected model on this account.",
            Self::Timeout => "Claude Code inference timed out.",
            Self::InvalidOutput => "Claude Code returned an invalid inference result.",
            Self::Execution => "Claude Code inference failed on the worker.",
        })
    }
}
impl std::error::Error for Failure {}

impl Manager {
    pub(crate) async fn infer(
        &self,
        owner: &JsString,
        server: &JsString,
        account: &Value,
        prompt: Prompt<'_>,
        timeout: Duration,
        signal: &Signal,
    ) -> Result<String> {
        let account = uuid::Uuid::parse_str(
            account
                .as_str()
                .context("Choose a Claude Code account on this worker.")?,
        )?;
        let profile = Profile::bound(owner, server, account);
        signal.check()?;
        let installation = tokio::select! {
            reason = signal.cancelled() => return Err(reason.into()),
            result = self.installation() => result?,
        };
        let _lease = self.begin_inference(profile)?;
        installation.infer(profile, prompt, timeout, signal).await
    }
}

impl Installation {
    async fn infer(
        &self,
        profile: Profile,
        prompt: Prompt<'_>,
        timeout: Duration,
        signal: &Signal,
    ) -> Result<String> {
        ensure!(
            !prompt.text.is_empty() && prompt.text.len() <= PROMPT_LIMIT,
            "Claude Code prompt is empty or too large."
        );
        ensure!(
            (1..=500).contains(&prompt.model.len()),
            "Invalid Claude Code model."
        );
        let mut command = self.account_command(profile)?;
        command
            .args([
                "--print",
                "--output-format",
                "json",
                "--safe-mode",
                "--tools",
                "",
                "--disallowedTools",
                "mcp__*",
                "--strict-mcp-config",
                "--mcp-config",
                r#"{"mcpServers":{}}"#,
                "--permission-prompts",
                "none",
                "--no-session-persistence",
                "--max-turns",
                "1",
            ])
            .arg(format!("--model={}", prompt.model))
            .arg(format!("--system-prompt={}", prompt.instructions))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        signal.check()?;
        #[cfg(unix)]
        let mut child = command
            .process_group(0)
            .spawn()
            .map_err(|_| Failure::Execution)?;
        #[cfg(windows)]
        let (mut child, job) = codex_utils_pty::JobObject::spawn_background(&mut command)
            .map_err(|_| Failure::Execution)?;
        #[cfg(unix)]
        let group = child.id().and_then(|pid| i32::try_from(pid).ok());
        let outcome = tokio::select! {
            biased;
            reason = signal.cancelled() => Err(reason.into()),
            result = tokio::time::timeout(timeout, capture(&mut child, prompt.text)) => {
                result.map_err(|_| Failure::Timeout).and_then(|result| result).map_err(anyhow::Error::from)
            },
        };
        let (exit, stdout, stderr) = match outcome {
            Ok(output) => output,
            Err(error) => {
                #[cfg(unix)]
                if let Some(group) = group {
                    // This group was created for this exact child at launch.
                    unsafe { libc::killpg(group, libc::SIGKILL) };
                }
                #[cfg(windows)]
                if let Some(job) = job {
                    let _ = job.terminate();
                }
                let _ = child.kill().await;
                return Err(error);
            }
        };
        signal.check()?;
        parse(exit.success(), &stdout, &stderr).map_err(Into::into)
    }
}

async fn capture(
    child: &mut Child,
    input: &str,
) -> std::result::Result<(ExitStatus, Vec<u8>, Vec<u8>), Failure> {
    let mut stdin = child.stdin.take().ok_or(Failure::Execution)?;
    let stdout = child.stdout.take().ok_or(Failure::Execution)?;
    let stderr = child.stderr.take().ok_or(Failure::Execution)?;
    let send = async move {
        match stdin.write_all(input.as_bytes()).await {
            Ok(()) => stdin.shutdown().await.map_err(|_| Failure::Execution),
            // An immediate authentication error may close stdin before the result arrives.
            Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
            Err(_) => Err(Failure::Execution),
        }
    };
    let wait = async { child.wait().await.map_err(|_| Failure::Execution) };
    let (exit, (), stdout, stderr) = tokio::try_join!(
        wait,
        send,
        bounded(stdout, OUTPUT_LIMIT),
        bounded(stderr, ERROR_LIMIT)
    )?;
    Ok((exit, stdout, stderr))
}

async fn bounded(
    input: impl AsyncRead + Unpin,
    limit: u64,
) -> std::result::Result<Vec<u8>, Failure> {
    let mut bytes = Vec::new();
    input
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| Failure::Execution)?;
    if bytes.len() as u64 > limit {
        return Err(Failure::InvalidOutput);
    }
    Ok(bytes)
}

fn parse(success: bool, stdout: &[u8], stderr: &[u8]) -> std::result::Result<String, Failure> {
    let body = std::str::from_utf8(stdout)
        .ok()
        .and_then(|text| parse_json_text(text).ok());
    if success
        && let Some(body) = &body
        && body["type"] == "result"
        && body["subtype"] == "success"
        && body["is_error"] == false
    {
        return body["result"]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or(Failure::InvalidOutput);
    }
    if success && body.as_ref().is_none_or(|body| body["is_error"] != true) {
        return Err(Failure::InvalidOutput);
    }
    let stderr = String::from_utf8_lossy(stderr);
    let text = body.as_ref().map(Value::stringify).unwrap_or_default();
    let error = format!("{text}\n{stderr}").to_ascii_lowercase();
    let contains = |parts: &[&str]| parts.iter().any(|part| error.contains(part));
    if contains(&[
        "login expired",
        "login reached its time limit",
        "please run /login",
        "not logged in",
        "not authenticated",
        "authentication_error",
        "invalid oauth token",
    ]) {
        Err(Failure::SignIn)
    } else if contains(&[
        "rate_limit_error",
        "rate limit",
        "usage limit",
        "quota exceeded",
        "out of extra usage",
        "hit your limit",
    ]) {
        Err(Failure::Quota)
    } else if contains(&[
        "model not found",
        "invalid model",
        "model is not available",
        "issue with the selected model",
        "do not have access to the model",
    ]) {
        Err(Failure::Model)
    } else {
        Err(Failure::Execution)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::{claude_code::tests::install_fixture, metadata::Abort};
    use std::fs;

    #[tokio::test]
    async fn managed_subprocess_receives_plain_stdin_and_runs_without_tools() -> Result<()> {
        let work = tempfile::tempdir()?;
        let manager = Manager::new(work.path());
        install_fixture(
            &manager,
            r#"#!/bin/sh
tool_setting=unrestricted
safe_mode=no
for arg in "$@"; do
  if [ "$tool_setting" = next ]; then
    [ -z "$arg" ] || exit 5
    tool_setting=disabled
  fi
  case "$arg" in
    --tools) tool_setting=next ;;
    --safe-mode) safe_mode=yes ;;
  esac
done
[ "$tool_setting" = disabled ] && [ "$safe_mode" = yes ] || exit 6
[ -z "${ANTHROPIC_API_KEY+x}" ] && [ "$HOME/config" = "$CLAUDE_CONFIG_DIR" ] || exit 7
input=$(/bin/cat)
case "$input" in
  "label please")
    printf '%s' "$input" > "$HOME/fixture-input"
    echo '{"type":"result","subtype":"success","is_error":false,"result":"Orchard inventory"}' ;;
  "summary please") echo '{"type":"result","subtype":"success","is_error":false,"result":"Two crates reached the orchard."}' ;;
  "auth error") echo '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["Login expired"]}'; exit 1 ;;
  "quota error") echo '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["rate_limit_error"]}'; exit 1 ;;
  "model error") echo 'issue with the selected model' >&2; exit 1 ;;
  "bad output") echo 'an unexpected response' ;;
  "hang")
    printf '%s' "$$" > "$HOME/fixture-pid"
    exec /bin/sleep 60 ;;
  *) exit 8 ;;
esac
"#,
        )?;
        let first = uuid::Uuid::new_v4();
        let second = uuid::Uuid::new_v4();
        let owner = JsString::from("owner");
        let server = JsString::from("server");
        let (_abort, signal) = Abort::new();
        let invoke =
            |account: uuid::Uuid, prompt: &'static str, timeout: Duration, signal: Signal| {
                let manager = &manager;
                let owner = &owner;
                let server = &server;
                async move {
                    manager
                        .infer(
                            owner,
                            server,
                            &Value::String(account.to_string().into()),
                            Prompt {
                                model: "sonnet",
                                instructions: "fixture instructions",
                                text: prompt,
                            },
                            timeout,
                            &signal,
                        )
                        .await
                }
            };
        let deadline = Duration::from_secs(5);
        assert_eq!(
            invoke(first, "label please", deadline, signal.clone()).await?,
            "Orchard inventory"
        );
        assert_eq!(
            invoke(second, "summary please", deadline, signal.clone()).await?,
            "Two crates reached the orchard."
        );
        for (request, expected) in [
            ("auth error", Failure::SignIn),
            ("quota error", Failure::Quota),
            ("model error", Failure::Model),
            ("bad output", Failure::InvalidOutput),
        ] {
            let error = invoke(first, request, deadline, signal.clone())
                .await
                .unwrap_err();
            assert_eq!(error.downcast_ref::<Failure>(), Some(&expected));
        }
        let installation = manager.installation().await?;
        let first_profile = installation.account_command(Profile::bound(&owner, &server, first))?;
        let first_dir = first_profile.as_std().get_current_dir().unwrap();
        let second_profile =
            installation.account_command(Profile::bound(&owner, &server, second))?;
        let second_dir = second_profile.as_std().get_current_dir().unwrap();
        assert_eq!(
            fs::read_to_string(first_dir.join("fixture-input"))?,
            "label please"
        );
        assert!(!second_dir.join("fixture-input").exists());
        let pid_file = first_dir.join("fixture-pid");
        let (abort, cancel) = Abort::new();
        let (error, ready) = tokio::join!(
            invoke(first, "hang", deadline, cancel),
            tokio::time::timeout(Duration::from_secs(3), async {
                while fs::read_to_string(&pid_file)
                    .ok()
                    .and_then(|value| value.parse::<i32>().ok())
                    .is_none()
                {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                abort.abort(anyhow::anyhow!("Cancelled fixture request"));
            })
        );
        ready?;
        assert_eq!(error.unwrap_err().to_string(), "Cancelled fixture request");
        let pid = fs::read_to_string(&pid_file)?.parse::<i32>()?;
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        let error = invoke(first, "hang", Duration::from_millis(200), signal)
            .await
            .unwrap_err();
        assert_eq!(error.downcast_ref::<Failure>(), Some(&Failure::Timeout));
        let pid = fs::read_to_string(&pid_file)?.parse::<i32>()?;
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        Ok(())
    }
}
