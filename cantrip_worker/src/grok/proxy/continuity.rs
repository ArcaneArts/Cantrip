//! Grok binds opaque reasoning to a stable conversation and turn identity.
use anyhow::Result;
use bytes::Bytes;
use cantrip_wire::{JsString, Value, parse_json_text};
use reqwest::header::{HeaderMap, HeaderValue};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

type ReasoningKey = [u8; 32];
type Turn = (JsString, JsString);

pub(super) struct Identity {
    conversation: JsString,
    request: JsString,
    model: Option<JsString>,
}

impl Identity {
    fn turn(&self) -> Turn {
        (self.conversation.clone(), self.request.clone())
    }
}

pub(super) struct Payload {
    pub bytes: Bytes,
    json: Option<Value>,
}

impl Payload {
    pub(super) fn new(bytes: Bytes) -> Self {
        let json = (!bytes.is_empty())
            .then(|| parse_json_text(&String::from_utf8_lossy(&bytes)).ok())
            .flatten()
            .filter(Value::is_object);
        Self { bytes, json }
    }

    fn identity(&self, default_conversation: &JsString) -> Identity {
        let payload = self.json.as_ref();
        let metadata = payload.and_then(|value| value.get("client_metadata"));
        let field = |object: Option<&Value>, key: &str| {
            object?
                .get(key)?
                .as_js_string()
                .map(JsString::trim)
                .filter(|text| !text.is_empty())
        };
        Identity {
            conversation: field(payload, "prompt_cache_key")
                .or_else(|| field(metadata, "session_id"))
                .or_else(|| field(metadata, "thread_id"))
                .unwrap_or_else(|| default_conversation.clone()),
            request: field(metadata, "turn_id").unwrap_or_else(random),
            model: field(payload, "model"),
        }
    }

    pub(super) fn keys(&self) -> HashSet<ReasoningKey> {
        self.json
            .as_ref()
            .and_then(|value| value["input"].as_array())
            .into_iter()
            .flatten()
            .filter(|entry| entry["type"] == "reasoning")
            .map(reasoning_key)
            .collect()
    }

    pub(super) fn strip(&mut self, rejected: Option<&HashSet<ReasoningKey>>) -> bool {
        let Some(json) = &mut self.json else {
            return false;
        };
        let Some(input) = json["input"].as_array() else {
            return false;
        };
        let should_keep = |entry: &Value| {
            entry["type"] != "reasoning"
                || rejected.is_some_and(|keys| !keys.contains(&reasoning_key(entry)))
        };
        if input.iter().all(should_keep) {
            return false;
        }
        json["input"] = Value::Array(
            input
                .iter()
                .filter(|entry| should_keep(entry))
                .cloned()
                .collect(),
        );
        self.bytes = Bytes::from(json.stringify());
        true
    }

    pub(super) fn stateless(&mut self) -> bool {
        self.strip(None);
        let Some(Value::Object(fields)) = &mut self.json else {
            return false;
        };
        fields.shift_remove("prompt_cache_key");
        self.bytes = Bytes::from(self.json.as_ref().unwrap().stringify());
        true
    }
}

fn reasoning_key(item: &Value) -> ReasoningKey {
    let source = ["encrypted_content", "id"]
        .into_iter()
        .find_map(|key| item[key].as_js_string().filter(|field| !field.is_empty()));
    match source {
        Some(value) => Sha256::digest(value.lossy().as_bytes()).into(),
        None => Sha256::digest(item.stringify().as_bytes()).into(),
    }
}

#[derive(Default)]
struct Conversation {
    next_turn: u64,
    turns: HashMap<JsString, u64>,
    stateless_turns: HashMap<JsString, JsString>,
    rejected: HashSet<ReasoningKey>,
    stateless: bool,
}

pub(super) struct Continuity {
    agent: JsString,
    default_conversation: JsString,
    conversations: HashMap<JsString, Conversation>,
}

impl Continuity {
    pub(super) fn new() -> Self {
        Self {
            agent: random(),
            default_conversation: random(),
            conversations: HashMap::new(),
        }
    }

    pub(super) fn prepare(
        &mut self,
        payload: &mut Payload,
        headers: &mut HeaderMap,
    ) -> Result<(Identity, bool)> {
        let identity = payload.identity(&self.default_conversation);
        let conversation = self
            .conversations
            .entry(identity.conversation.clone())
            .or_default();
        let turn = *conversation
            .turns
            .entry(identity.request.clone())
            .or_insert_with(|| {
                conversation.next_turn = conversation.next_turn.saturating_add(1);
                conversation.next_turn
            });
        header(headers, "x-grok-agent-id", &self.agent)?;
        if let Some(model) = &identity.model {
            header(headers, "x-grok-model-override", model)?;
        }
        if conversation.stateless {
            let request = conversation
                .stateless_turns
                .entry(identity.request.clone())
                .or_insert_with(random);
            header(headers, "x-grok-req-id", request)?;
            payload.stateless();
        } else {
            header(headers, "x-grok-conv-id", &identity.conversation)?;
            header(headers, "x-grok-req-id", &identity.request)?;
            header(headers, "x-grok-session-id", &identity.conversation)?;
            headers.insert("x-grok-turn-idx", HeaderValue::from_str(&turn.to_string())?);
            if !conversation.rejected.is_empty() {
                payload.strip(Some(&conversation.rejected));
            }
        }
        Ok((identity, conversation.stateless))
    }

    pub(super) fn quarantine(&mut self, identity: &Identity, keys: HashSet<ReasoningKey>) {
        let conversation = self
            .conversations
            .entry(identity.conversation.clone())
            .or_default();
        if !conversation.stateless {
            conversation.rejected.extend(keys);
        }
    }

    pub(super) fn stateless_headers(headers: &mut HeaderMap) -> Result<JsString> {
        for name in ["x-grok-conv-id", "x-grok-session-id", "x-grok-turn-idx"] {
            headers.remove(name);
        }
        let request = random();
        header(headers, "x-grok-req-id", &request)?;
        Ok(request)
    }

    pub(super) fn commit_stateless(&mut self, identity: &Identity, request: JsString) {
        let (conversation, turn) = identity.turn();
        let state = self.conversations.entry(conversation).or_default();
        state.stateless = true;
        state.stateless_turns.insert(turn, request);
        state.rejected.clear();
    }
}

fn random() -> JsString {
    uuid::Uuid::new_v4().to_string().into()
}

fn header(headers: &mut HeaderMap, name: &'static str, value: &JsString) -> Result<()> {
    headers.insert(name, HeaderValue::from_str(&value.lossy())?);
    Ok(())
}
