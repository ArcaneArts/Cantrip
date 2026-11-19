use anyhow::{Context, Result};
use cantrip_wire::{JsString, Value};
use std::collections::HashSet;

pub(crate) const COMMAND: &str = "inference.revoke";
pub(crate) const REMOVED: &str = "The inference resource was removed.";

pub(crate) struct Target {
    pub(crate) chats: HashSet<JsString>,
    project: Option<JsString>,
}

impl Target {
    pub(in crate::codex) fn read(value: &Value) -> Result<Self> {
        let id = |value: &Value| {
            value
                .as_js_string()
                .cloned()
                .context("Invalid inference revocation resource ID.")
        };
        match value["kind"].as_str() {
            Some("chat") => Ok(Self {
                chats: HashSet::from([id(&value["chatId"])?]),
                project: None,
            }),
            Some("project") => Ok(Self {
                chats: value["chatIds"]
                    .as_array()
                    .context("Missing chats for inference revocation.")?
                    .iter()
                    .map(id)
                    .collect::<Result<_>>()?,
                project: Some(id(&value["projectId"])?),
            }),
            _ => anyhow::bail!("Invalid inference revocation resource."),
        }
    }

    pub(crate) fn matches(&self, chat: Option<&JsString>, project: Option<&JsString>) -> bool {
        chat.is_some_and(|chat| self.chats.contains(chat))
            || project.is_some_and(|project| self.project.as_ref() == Some(project))
    }
}

use crate::metadata::{Abort, Signal};

pub(in crate::codex) struct Resource {
    pub chat: JsString,
    pub project: Option<JsString>,
    abort: Abort,
    pub signal: Signal,
}

impl Resource {
    pub fn new(chat: JsString, project: Option<JsString>) -> Self {
        let (abort, signal) = Abort::new();
        Self {
            chat,
            project,
            abort,
            signal,
        }
    }

    pub fn matches(&self, target: &Target) -> bool {
        target.matches(Some(&self.chat), self.project.as_ref())
    }

    pub fn revoke(&self) {
        self.abort.abort(anyhow::anyhow!(REMOVED));
    }
}
