//! Read model and usage metadata from the installed CLI without an inference turn.
use super::{Installation, Manager, Profile, SignIn, inference::bounded};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{Value, parse_json_text, value::json};
use std::{collections::HashSet, process::Stdio, time::Duration};
use tokio::io::AsyncWriteExt;

const INITIALIZE: &str = "{\"type\":\"control_request\",\"request_id\":\"catalog\",\"request\":{\"subtype\":\"initialize\"}}\n";

impl Manager {
    pub(super) async fn inspect(&self, profile: Profile, section: &str) -> Result<Value> {
        let _lease = self.begin_inference(profile)?;
        let installation = self
            .current()
            .await?
            .context("Claude Code is not installed.")?;
        match section {
            "models" => {
                let response = installation.metadata(profile, true).await?;
                model_list(&response)
            }
            "usage" => {
                let (sign_in, auth) = installation.auth_status(profile).await?;
                ensure!(
                    sign_in == SignIn::Subscription,
                    "Sign in to this Claude Code account on its worker."
                );
                let response = installation.metadata(profile, false).await?;
                usage(&response, auth["subscriptionType"].as_str())
            }
            _ => anyhow::bail!("Unknown Claude Code inspection section."),
        }
    }
}

impl Installation {
    async fn metadata(&self, profile: Profile, models: bool) -> Result<String> {
        let mut command = self.account_command(profile)?;
        command
            .args([
                "--print",
                "--safe-mode",
                "--tools",
                "",
                "--strict-mcp-config",
                "--mcp-config",
                r#"{"mcpServers":{}}"#,
                "--no-session-persistence",
                "--output-format",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if models {
            command.args(["stream-json", "--input-format", "stream-json", "--verbose"]);
        } else {
            command.args(["json", "/usage"]);
        }
        let mut child = command
            .spawn()
            .context("Could not start Claude Code metadata command.")?;
        let mut input = child.stdin.take().context("Missing metadata input.")?;
        let output = child.stdout.take().context("Missing metadata output.")?;
        let (exit, _, output) = tokio::time::timeout(Duration::from_secs(15), async {
            tokio::try_join!(
                async { Ok::<_, anyhow::Error>(child.wait().await?) },
                async move {
                    if models {
                        input.write_all(INITIALIZE.as_bytes()).await?;
                    }
                    input.shutdown().await?;
                    Ok(())
                },
                async { Ok(bounded(output, 512 * 1024).await?) }
            )
        })
        .await
        .context("Claude Code metadata request timed out.")??;
        ensure!(
            exit.success(),
            "Claude Code could not load account metadata."
        );
        Ok(String::from_utf8(output).context("Claude Code returned invalid metadata.")?)
    }
}

fn model_list(output: &str) -> Result<Value> {
    let data = output
        .lines()
        .filter_map(|line| parse_json_text(line).ok())
        .find_map(|frame| {
            let response = &frame["response"];
            (frame["type"] == "control_response"
                && response["request_id"] == "catalog"
                && response["subtype"] == "success")
                .then(|| response["response"].clone())
        })
        .context("Claude Code returned no model catalog.")?;
    let account = &data["account"];
    ensure!(
        account["subscriptionType"]
            .as_str()
            .is_some_and(|plan| !plan.is_empty()),
        "Sign in to this Claude Code account on its worker."
    );
    let inventory = data["models"]
        .as_array()
        .context("Missing Claude Code models.")?;
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for model in inventory {
        let Some(id) = model["value"]
            .as_str()
            .filter(|id| *id != "default" && !id.is_empty())
        else {
            continue;
        };
        if !seen.insert(id) {
            continue;
        }
        let name = model["displayName"]
            .as_str()
            .filter(|name| !name.is_empty())
            .unwrap_or(id);
        let efforts: Vec<_> = model["supportedEffortLevels"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        models.push(json!({"id":id,"name":name,"description":model["description"].as_str(),"efforts":efforts}));
    }
    Ok(json!({"models":models}))
}

fn usage(output: &str, subscription_type: Option<&str>) -> Result<Value> {
    let result = parse_json_text(output)
        .map_err(|_| anyhow::anyhow!("Claude Code returned invalid usage metadata."))?;
    ensure!(
        result["type"] == "result"
            && result["subtype"] == "success"
            && result["local_command"] == "usage"
            && result["num_turns"].as_u64() == Some(0),
        "Claude Code could not report subscription usage."
    );
    let text = result["result"]
        .as_str()
        .context("Missing Claude Code usage.")?;
    let windows: Vec<_> = text.lines().filter_map(usage_window).collect();
    ensure!(
        !windows.is_empty(),
        "Claude Code did not report subscription usage."
    );
    Ok(json!({"subscriptionType":subscription_type,"windows":windows}))
}

fn usage_window(line: &str) -> Option<Value> {
    let (label, detail) = line.trim().split_once(": ")?;
    if !(label == "Current session" || label.starts_with("Current week") || label == "Extra usage")
    {
        return None;
    }
    let (percent, tail) = detail.split_once("% used")?;
    let percent: f64 = percent.parse().ok()?;
    if !(0.0..=100.0).contains(&percent) {
        return None;
    }
    let reset = tail.trim().strip_prefix("· resets ");
    Some(json!({"label":label,"usedPercent":percent,"resetText":reset}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_uses_model_ids_and_excludes_the_default_selector() -> Result<()> {
        let frame = r#"{"type":"control_response","response":{
            "subtype":"success","request_id":"catalog","response":{
                "account":{"subscriptionType":"Claude Pro","email":"private"},
                "models":[
                    {"value":"default","displayName":"Default (recommended)"},
                    {"value":"opus","displayName":"Opus","supportedEffortLevels":["high"]},
                    {"value":"opus","displayName":"Duplicate"},
                    {"value":"claude-sonnet-example","displayName":"Sonnet"}
                ]
            }
        }}"#;
        let frame = parse_json_text(frame).expect("Valid model fixture");
        let value = model_list(&frame.stringify())?;
        let models = value["models"].as_array().context("Model inventory")?;
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["id"], "opus");
        assert_eq!(models[0]["name"], "Opus");
        assert_eq!(
            models[0]["efforts"]
                .as_array()
                .and_then(|values| values.first())
                .and_then(Value::as_str),
            Some("high")
        );
        assert_eq!(models[1]["id"], "claude-sonnet-example");
        assert!(value.get("account").is_none());
        Ok(())
    }

    #[test]
    fn usage_returns_only_native_subscription_windows() -> Result<()> {
        let frame = json!({"type":"result","subtype":"success","local_command":"usage",
            "num_turns":0,"result":"Current session: 0% used\nCurrent week (all models): 12% used · resets Friday\nCurrent week (Sonnet only): 13% used\nUnexpected line: 90% used"
        });
        let result = usage(&frame.stringify(), Some("pro"))?;
        assert_eq!(result["subscriptionType"], "pro");
        let windows = result["windows"].as_array().context("Usage windows")?;
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[1]["usedPercent"].as_u64(), Some(12));
        assert_eq!(windows[1]["resetText"], "Friday");
        let mut nonlocal = frame;
        nonlocal["num_turns"] = json!(1);
        assert!(usage(&nonlocal.stringify(), None).is_err());
        Ok(())
    }
}
