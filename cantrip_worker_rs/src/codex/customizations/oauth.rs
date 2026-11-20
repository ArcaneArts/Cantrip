//! MCP sign-in attempts belong to one chat and one native process generation.
use super::{TIMEOUT, Target, nonempty};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexMap;
use std::{
    net::{Ipv4Addr, Ipv6Addr},
    sync::{Arc, Mutex},
};
use url::{Host, Url};

pub(in crate::codex) const LOGIN: &str = "mcpServer/oauth/login";
pub(in crate::codex) const COMPLETED: &str = "mcpServer/oauthLogin/completed";
const MAX_ATTEMPTS: usize = 100;
const START_FAILED: &str = "Codex could not start MCP authorization.";
const LOGIN_FAILED: &str = "MCP authorization failed. Review the authorization page and try again.";

#[derive(Clone, Eq, PartialEq, Hash)]
struct Key {
    chat: JsString,
    server: JsString,
}

impl Key {
    fn from_request(target: &Target<'_>, input: &Value) -> Result<Self> {
        Ok(Self {
            chat: nonempty(&target.operation.scope["chatId"])
                .context("Missing MCP authorization chat.")?
                .clone(),
            server: nonempty(&input["server"])
                .context("Missing MCP authorization server.")?
                .clone(),
        })
    }
}

#[derive(Clone, Copy)]
enum Outcome {
    Succeeded,
    Failed,
    FailedToStart,
}

enum Phase {
    Starting(Option<Outcome>),
    Pending(Option<JsString>),
    Finished(Outcome),
}

struct Attempt {
    sequence: u64,
    phase: Phase,
}

#[derive(Default)]
struct State {
    sequence: u64,
    uses_login_ids: bool,
    attempts: IndexMap<Key, Attempt>,
    early: IndexMap<(JsString, JsString), Outcome>,
}

#[derive(Clone, Default)]
pub(in crate::codex) struct Attempts(Arc<Mutex<State>>);

impl Attempts {
    fn begin(&self, key: &Key) -> Result<u64> {
        let mut state = self.0.lock().unwrap();
        ensure!(
            !state.attempts.iter().any(|(other, attempt)| {
                other.server == key.server
                    && (matches!(attempt.phase, Phase::Pending(None))
                        || (!state.uses_login_ids && matches!(attempt.phase, Phase::Starting(_))))
            }),
            "MCP authorization is already pending for this server.",
        );
        state.sequence += 1;
        let sequence = state.sequence;
        state.attempts.shift_remove(key);
        state.attempts.insert(
            key.clone(),
            Attempt {
                sequence,
                phase: Phase::Starting(None),
            },
        );
        if state.attempts.len() > MAX_ATTEMPTS {
            state.attempts.shift_remove_index(0);
        }
        Ok(sequence)
    }

    fn started(&self, key: &Key, sequence: u64, result: Result<Option<JsString>, ()>) {
        let mut state = self.0.lock().unwrap();
        let early = if let Ok(Some(login)) = &result {
            state.uses_login_ids = true;
            state
                .early
                .shift_remove(&(key.server.clone(), login.clone()))
        } else {
            None
        };
        let Some(attempt) = state.attempts.get_mut(key) else {
            return;
        };
        let Phase::Starting(legacy) = attempt.phase else {
            return;
        };
        if attempt.sequence != sequence {
            return;
        }
        attempt.phase = match result {
            Ok(login) => match if login.is_some() { early } else { legacy } {
                Some(outcome) => Phase::Finished(outcome),
                None => Phase::Pending(login),
            },
            Err(()) => Phase::Finished(Outcome::FailedToStart),
        };
    }

    pub(in crate::codex) fn complete(&self, params: &Value) {
        // This Cantrip operation authorizes a server in the account's Codex
        // configuration. A thread-scoped native login is a separate flow.
        if !params["threadId"].is_null() {
            return;
        }
        let (Some(server), Some(success)) =
            (nonempty(&params["name"]), params["success"].as_bool())
        else {
            return;
        };
        let outcome = if success {
            Outcome::Succeeded
        } else {
            Outcome::Failed
        };
        let mut state = self.0.lock().unwrap();
        if let Some(login) = nonempty(&params["loginId"]) {
            if let Some((_, attempt)) = state.attempts.iter_mut().find(|(key, attempt)| {
                &key.server == server
                    && matches!(&attempt.phase, Phase::Pending(Some(id)) if id == login)
            }) {
                attempt.phase = Phase::Finished(outcome);
            } else if state.attempts.iter().any(|(key, attempt)| {
                &key.server == server && matches!(attempt.phase, Phase::Starting(_))
            }) {
                // Codex can notify before the login RPC returns its ID.
                state.early.insert((server.clone(), login.clone()), outcome);
                if state.early.len() > MAX_ATTEMPTS {
                    state.early.shift_remove_index(0);
                }
            }
            return;
        }
        // Older app servers omit the login ID. Use their notification only
        // when it identifies a single candidate in this runtime.
        let mut candidates = state.attempts.iter_mut().filter(|(key, attempt)| {
            &key.server == server
                && matches!(attempt.phase, Phase::Starting(_) | Phase::Pending(None))
        });
        if let Some((_, attempt)) = candidates.next()
            && candidates.next().is_none()
        {
            match &mut attempt.phase {
                Phase::Starting(early) => *early = Some(outcome),
                _ => attempt.phase = Phase::Finished(outcome),
            }
        }
    }

    fn status(&self, key: &Key) -> Value {
        let state = self.0.lock().unwrap();
        let (status, error) = match state.attempts.get(key).map(|attempt| &attempt.phase) {
            Some(Phase::Starting(_) | Phase::Pending(_)) => ("pending", None),
            Some(Phase::Finished(Outcome::Succeeded)) => ("succeeded", None),
            Some(Phase::Finished(Outcome::Failed)) => ("failed", Some(LOGIN_FAILED)),
            Some(Phase::Finished(Outcome::FailedToStart)) => ("failed", Some(START_FAILED)),
            None => ("unknown", None),
        };
        json!({"server":key.server,"status":status,"error":error})
    }
}

fn authorization_url(response: &Value) -> Result<&str> {
    let raw = response["authorizationUrl"]
        .as_str()
        .context(START_FAILED)?;
    let parsed = Url::parse(raw).map_err(|_| anyhow!(START_FAILED))?;
    let loopback = match parsed.host() {
        Some(Host::Domain("localhost")) => true,
        Some(Host::Ipv4(address)) => address == Ipv4Addr::LOCALHOST,
        Some(Host::Ipv6(address)) => address == Ipv6Addr::LOCALHOST,
        _ => false,
    };
    ensure!(
        parsed.scheme() == "https" || (parsed.scheme() == "http" && loopback),
        START_FAILED
    );
    Ok(raw)
}

pub(super) async fn start(target: &Target<'_>, input: &Value) -> Result<Value> {
    ensure!(
        target.report["methods"][LOGIN] == "available",
        "The installed Codex runtime does not support MCP OAuth login."
    );
    let key = Key::from_request(target, input)?;
    target.operation.assert_current()?;
    let attempts = target.runtime.mcp_oauth();
    let sequence = attempts.begin(&key)?;
    let result = target
        .runtime
        .request(
            LOGIN.into(),
            Some(json!({"name":key.server,"threadId":Value::Null})),
            Some(TIMEOUT),
            None,
        )
        .await;
    let result = result.ok().flatten().and_then(|response| {
        let url = authorization_url(&response).ok()?;
        let value = crate::http::checked(
            "codexMcpOauthStartResultSchema",
            &json!({"server":key.server,"authorizationUrl":url,"status":"pending"}),
        )
        .ok()?;
        Some((value, nonempty(&response["loginId"]).cloned()))
    });
    match result {
        Some((value, login)) => {
            attempts.started(&key, sequence, Ok(login));
            Ok(value)
        }
        None => {
            attempts.started(&key, sequence, Err(()));
            Err(anyhow!(START_FAILED))
        }
    }
}

pub(super) fn status(target: &Target<'_>, input: &Value) -> Result<Value> {
    Ok(target
        .runtime
        .mcp_oauth()
        .status(&Key::from_request(target, input)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(chat: &str) -> Key {
        Key {
            chat: chat.into(),
            server: "shared".into(),
        }
    }

    fn completion(login: &str, success: bool) -> Value {
        json!({"name":"shared","loginId":login,"success":success})
    }

    #[test]
    fn correlates_completion_before_reply_and_isolates_chat_retries() {
        let attempts = Attempts::default();
        let a = key("chat-a");
        let b = key("chat-b");
        let first = attempts.begin(&a).unwrap();
        attempts.started(&a, first, Ok(Some("old".into())));
        let retry = attempts.begin(&a).unwrap();
        let other = attempts.begin(&b).unwrap();
        attempts.complete(&completion("old", false));
        attempts.complete(&completion("retry", true));
        attempts.started(&a, retry, Ok(Some("retry".into())));
        attempts.started(&b, other, Ok(Some("other".into())));
        assert_eq!(attempts.status(&a)["status"], "succeeded");
        assert_eq!(attempts.status(&b)["status"], "pending");
        attempts.complete(&json!({
            "name":"shared","threadId":"unrelated","loginId":"other","success":true
        }));
        assert_eq!(attempts.status(&b)["status"], "pending");
        attempts.complete(&completion("other", false));
        assert_eq!(attempts.status(&b)["error"], LOGIN_FAILED);
        assert_eq!(attempts.status(&a)["status"], "succeeded");
    }

    #[test]
    fn accepts_an_unambiguous_legacy_completion_and_safe_links() {
        let attempts = Attempts::default();
        let a = key("chat-a");
        let sequence = attempts.begin(&a).unwrap();
        assert!(attempts.begin(&key("other-chat")).is_err());
        attempts.complete(&json!({"name":"shared","success":true}));
        attempts.started(&a, sequence, Ok(None));
        assert_eq!(attempts.status(&a)["status"], "succeeded");
        let sequence = attempts.begin(&a).unwrap();
        attempts.started(&a, sequence, Ok(None));
        assert!(attempts.begin(&a).is_err());
        attempts.complete(&json!({"name":"shared","success":false}));
        assert_eq!(attempts.status(&a)["status"], "failed");
        assert!(attempts.begin(&a).is_ok());
        for valid in [
            "https://example.test/login",
            "http://127.0.0.1/test",
            "http://[::1]/test",
        ] {
            assert!(authorization_url(&json!({"authorizationUrl":valid})).is_ok());
        }
        for invalid in [
            "file:///test",
            "http://example.test/login",
            "http://localhost.example.test",
        ] {
            assert!(authorization_url(&json!({"authorizationUrl":invalid})).is_err());
        }
    }
}
