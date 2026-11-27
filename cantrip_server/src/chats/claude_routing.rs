//! Resolve worker-local subscriptions using the account's current CLI observations.
use super::routing::ModelRouting;
use crate::{
    database::Database,
    settings::{parse_response, reasoning::ConfigurationFailure, repository::SettingsRepository},
    wire::{Value, value::json},
    workers::command_bus::LimitedCommandBus,
};
use anyhow::{Context, Result};
use futures::{StreamExt, stream};
use std::{sync::Arc, time::Duration};

pub(super) struct ClaudeRouting {
    settings: SettingsRepository,
    commands: Arc<LimitedCommandBus>,
    server: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Availability {
    Available,
    Unknown,
    Exhausted,
    SignedOut,
}

fn availability(observation: &Value, model: &str) -> Availability {
    match observation["status"].as_str() {
        Some("signed-out" | "unsupported-authentication") => return Availability::SignedOut,
        Some("signed-in") => {}
        _ => return Availability::Unknown,
    }
    let Ok(usage) = parse_response("claudeCodeAccountUsageSchema", observation.get("usage")) else {
        return Availability::Unknown;
    };
    let opus = model == "opus" || model.starts_with("claude-opus-");
    let sonnet = model == "sonnet" || model.starts_with("claude-sonnet-");
    let mut reported = false;
    for window in usage["windows"].as_array().into_iter().flatten() {
        let applies = match window["label"].as_str() {
            Some("Current session" | "Current week" | "Current week (all models)") => true,
            Some("Current week (Opus)" | "Current week (Opus only)") => opus,
            Some("Current week (Sonnet)" | "Current week (Sonnet only)") => sonnet,
            _ => false,
        };
        if applies && let Some(used) = window["usedPercent"].as_f64() {
            if used >= 100.0 {
                return Availability::Exhausted;
            }
            reported = true;
        }
    }
    if reported {
        Availability::Available
    } else {
        Availability::Unknown
    }
}

impl ClaudeRouting {
    pub(super) fn new(
        database: Arc<Database>,
        commands: Arc<LimitedCommandBus>,
        server: String,
    ) -> Self {
        Self {
            settings: SettingsRepository::new(database),
            commands,
            server,
        }
    }

    async fn observe(&self, worker: &str, account: &str, model: &str) -> Availability {
        let request = |command: Value, timeout: u64| {
            self.commands
                .request(worker, command, Some(Duration::from_secs(timeout)), None)
        };
        let usage = request(
            json!({"type":"claude-code.account.inspect","accountId":account,
                "serverId":self.server,"section":"usage"}),
            30,
        )
        .await;
        if let Ok(Some(usage)) = usage {
            // The worker only reads usage after Claude confirms subscription auth.
            return availability(&json!({"status":"signed-in","usage":usage}), model);
        }
        match request(
            json!({"type":"claude-code.auth.status","accountId":account,"serverId":self.server}),
            15,
        )
        .await
        {
            Ok(Some(status)) => availability(&status, model),
            // A busy worker may be unable to inspect the account. Attempt
            // inference if no positively available account is found.
            _ => Availability::Unknown,
        }
    }

    async fn select(
        &self,
        owner: &str,
        worker: &str,
        runtime: &Value,
        routing: &ModelRouting,
    ) -> Result<Option<String>> {
        let provider = runtime["provider"]["id"]
            .as_str()
            .context("Claude provider identity")?;
        let model = runtime["model"]["name"]
            .as_str()
            .context("Claude model name")?;
        let mut accounts = self
            .settings
            .claude_worker_accounts(owner, provider, worker)
            .await?;
        if let Some(index) = accounts
            .iter()
            .position(|account| runtime["provider"]["accountId"].as_str() == Some(account.as_str()))
        {
            let preferred = accounts.remove(index);
            accounts.insert(0, preferred);
        }
        let now = crate::auth::now().timestamp_millis() as f64;
        accounts.retain(|account| {
            let mut candidate = runtime.clone();
            candidate["provider"]["accountId"] = json!(account);
            !routing.cooling(&candidate, now)
        });
        let observations = stream::iter(accounts.into_iter().map(|account| async move {
            let status = self.observe(worker, &account, model).await;
            (account, status)
        }))
        .buffered(4);
        futures::pin_mut!(observations);
        let mut fallback = None;
        while let Some((account, status)) = observations.next().await {
            match status {
                Availability::Available => return Ok(Some(account)),
                Availability::Unknown => {
                    fallback.get_or_insert(account);
                }
                Availability::Exhausted | Availability::SignedOut => {}
            }
        }
        Ok(fallback)
    }
}

impl ModelRouting {
    pub(in crate::chats) async fn select_claude_accounts(
        &self,
        owner: &str,
        context: &Value,
        mut pairs: Vec<Value>,
    ) -> Result<Vec<Value>> {
        let Some(routing) = &self.claude else {
            return Ok(pairs);
        };
        let worker = context["workerId"]
            .as_str()
            .context("Claude worker identity")?;
        let mut retained = Vec::with_capacity(pairs.len());
        for mut pair in pairs.drain(..) {
            let root = &pair["root"]["runtime"];
            if root["provider"]["kind"] == "claude-code" {
                let Some(account) = routing.select(owner, worker, root, self).await? else {
                    continue;
                };
                pair["root"]["runtime"]["provider"]["accountId"] = json!(account);
                if !pair["subagent"].is_null() {
                    pair["subagent"]["runtime"]["provider"]["accountId"] = json!(account);
                }
            }
            retained.push(pair);
        }
        anyhow::ensure!(
            !retained.is_empty(),
            ConfigurationFailure(json!({
                "code":"root-model-unavailable",
                "error":"No signed-in Claude Code account on this worker has remaining usage for this model.",
                "field":"modelId","retryable":true,
            }))
        );
        Ok(retained)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_observations_distinguish_unknown_usage_from_exhausted_accounts() {
        assert_eq!(
            availability(&json!({"status":"signed-out"}), "opus"),
            Availability::SignedOut
        );
        assert_eq!(
            availability(&json!({"status":"signed-in","usage":Value::Null}), "opus"),
            Availability::Unknown
        );
        let usage = json!({"status":"signed-in","usage":json!({
            "subscriptionType":"pro","windows":[
                json!({"label":"Current session","usedPercent":62,"resetText":Value::Null}),
                json!({"label":"Current week (Opus only)","usedPercent":100,"resetText":Value::Null}),
                json!({"label":"Extra usage","usedPercent":100,"resetText":Value::Null}),
            ]
        })});
        assert_eq!(availability(&usage, "opus"), Availability::Exhausted);
        assert_eq!(
            availability(&usage, "claude-sonnet-4-5"),
            Availability::Available
        );
    }
}
