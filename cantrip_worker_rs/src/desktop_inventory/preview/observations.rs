//! Transient model images owned by an observed native turn.
use super::native::{self, Attachment, ResultData};
use crate::{
    http::checked,
    metadata::{Abort, Signal},
};
use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_crypto::Zeroizing;
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::{Semaphore, SemaphorePermit};
use uuid::Uuid;

const CAPACITY: usize = 4;
const AUTHORITY_KEYS: &[&str] = &[
    "ownerId",
    "serverId",
    "workerId",
    "chatId",
    "projectId",
    "contextKind",
    "placementId",
    "generation",
    "profile",
];

#[derive(Clone)]
pub(crate) struct ModelImage {
    pub(crate) native: Value,
    pub(crate) model: Value,
    pub(crate) png: JsString,
}

pub(super) struct Registry {
    entries: Mutex<VecDeque<Entry>>,
    readers: Semaphore,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            entries: Mutex::default(),
            readers: Semaphore::new(CAPACITY),
        }
    }
}

pub(crate) struct ObservedTurn {
    registry: Arc<Registry>,
    id: Uuid,
    latest: Mutex<Option<Uuid>>,
}

struct Entry {
    turn: Uuid,
    call: Uuid,
    epoch: u64,
    authority: Value,
    metadata: Value,
    png: JsString,
    attachment: Weak<Attachment>,
    retire: Abort,
    signal: Signal,
}

impl Entry {
    fn live(&self) -> bool {
        self.signal.check().is_ok()
            && self
                .attachment
                .upgrade()
                .is_some_and(|attachment| attachment.matches_observation(&self.metadata["session"]))
    }

    fn matches(&self, authority: &Value, epoch: u64) -> bool {
        self.epoch == epoch
            && AUTHORITY_KEYS
                .iter()
                .all(|key| self.authority[*key] == authority[*key])
    }
}

impl Drop for Entry {
    fn drop(&mut self) {
        self.retire
            .abort(anyhow::anyhow!("The agent observation expired."));
    }
}

pub(super) struct Read<'a> {
    _permit: SemaphorePermit<'a>,
    signal: Signal,
}

impl Read<'_> {
    pub(super) fn check(&self) -> Result<()> {
        self.signal.check()
    }
}

impl Registry {
    pub(super) fn turn(self: &Arc<Self>) -> ObservedTurn {
        ObservedTurn {
            registry: self.clone(),
            id: Uuid::new_v4(),
            latest: Mutex::default(),
        }
    }

    pub(super) fn list(&self, authority: &Value, epoch: u64) -> ResultData {
        let mut entries = self.entries.lock().unwrap();
        entries.retain(Entry::live);
        let sources = entries
            .iter()
            .filter(|entry| entry.matches(authority, epoch))
            .map(|entry| entry.metadata["source"].clone())
            .collect::<Vec<_>>();
        ResultData {
            data: json!({"sources":sources}),
            pixels: Zeroizing::new(Vec::new()),
        }
    }

    pub(super) fn read(
        &self,
        authority: &Value,
        epoch: u64,
        id: &Value,
    ) -> Result<(ResultData, Read<'_>)> {
        let (data, png, read) = {
            let mut entries = self.entries.lock().unwrap();
            entries.retain(Entry::live);
            let entry = entries
                .iter()
                .find(|entry| entry.matches(authority, epoch) && entry.metadata["source"]["sourceId"] == *id)
                .ok_or_else(|| {
                    native::reject(
                        "execution-unavailable",
                        "Computer-use authority is unavailable for this agent turn. After Stop, a permission-profile change, or a computer-use settings change, start a new agent turn; js_reset cannot restore revoked authority.",
                    )
                })?;
            let permit = self.readers.try_acquire().map_err(|_| {
                native::reject("capacity", "Computer-use observation readers are busy.")
            })?;
            (
                entry.metadata.clone(),
                entry.png.clone(),
                Read {
                    _permit: permit,
                    signal: entry.signal.clone(),
                },
            )
        };
        read.check()?;
        let pixels = Zeroizing::new(STANDARD.decode(png.as_str().context("Invalid agent PNG.")?)?);
        read.check()?;
        Ok((ResultData { data, pixels }, read))
    }

    pub(super) fn expire(&self, epoch: u64) {
        self.entries
            .lock()
            .unwrap()
            .retain(|entry| entry.epoch == epoch);
    }

    pub(super) fn revoke(&self, matches: impl Fn(&Value) -> bool) {
        self.entries
            .lock()
            .unwrap()
            .retain(|entry| !matches(&entry.authority));
    }
}

impl ObservedTurn {
    pub(crate) fn begin(&self, call: Uuid) {
        let mut latest = self.latest.lock().unwrap();
        self.remove();
        *latest = Some(call);
    }

    pub(crate) fn clear(&self) {
        let mut latest = self.latest.lock().unwrap();
        *latest = None;
        self.remove();
    }

    fn remove(&self) {
        self.registry
            .entries
            .lock()
            .unwrap()
            .retain(|entry| entry.turn != self.id);
    }

    pub(super) fn publish(
        &self,
        call: Uuid,
        root: &JsString,
        authority: (&Value, u64),
        attachment: &Arc<Attachment>,
        image: ModelImage,
        active: Signal,
    ) {
        let latest = self.latest.lock().unwrap();
        if *latest != Some(call) || active.check().is_err() {
            return;
        }
        let session = &image.native["session"];
        let Some(helper) = attachment.observation_signal(session) else {
            return;
        };
        let byte_count = image.model["byteCount"].as_u64().unwrap_or_default();
        if byte_count == 0 || image.png.len() as u64 != 4 * byte_count.div_ceil(3) {
            return;
        }
        let mut rendition = image.model;
        rendition["mediaType"] = json!("image/png");
        rendition["cursorIncluded"] = json!(true);
        let Ok(metadata) = checked(
            "cuaAgentObservationSchema",
            &json!({
                "source":json!({
                    "sourceId":Uuid::new_v4().to_string(),"rootThreadId":root,
                    "binding":session["binding"],"target":session["target"],
                    "cursorRevision":session["cursor"]["revision"],
                    "observationRevision":session["observationRevision"],
                    "observedAtMs":chrono::Utc::now().timestamp_millis(),
                }),
                "session":session,"image":rendition,"nativeImage":image.native["image"],
            }),
        ) else {
            return;
        };
        let (retire, signal) = Abort::new();
        let signal = Signal::any(vec![active, helper, signal]);
        let entry = Entry {
            turn: self.id,
            call,
            epoch: authority.1,
            authority: authority.0.clone(),
            metadata,
            png: image.png,
            attachment: Arc::downgrade(attachment),
            retire,
            signal: signal.clone(),
        };
        {
            let mut entries = self.registry.entries.lock().unwrap();
            if !entry.live() {
                return;
            }
            entries.retain(|existing| existing.turn != self.id && existing.live());
            if entries.len() >= CAPACITY {
                entries.pop_front();
            }
            entries.push_back(entry);
        }
        let registry = Arc::downgrade(&self.registry);
        let id = self.id;
        tokio::spawn(async move {
            signal.cancelled().await;
            if let Some(registry) = registry.upgrade() {
                registry
                    .entries
                    .lock()
                    .unwrap()
                    .retain(|entry| entry.turn != id || entry.call != call);
            }
        });
    }
}

impl Drop for ObservedTurn {
    fn drop(&mut self) {
        self.remove();
    }
}
