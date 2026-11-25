//! Canonical source-to-publication orchestration. The durable Projection owns
//! stages/checkpoints; adapters supply verified context and authorized files.
pub mod bootstrap;
mod items;
pub mod rebase;
mod turns;
use super::{client::Client, preparation, render};
use crate::{
    metadata::Signal,
    native_items::{array, checked, obj, s, text},
};
use anyhow::{Result, bail};
use cantrip_history::{
    canonical,
    content::Encryption,
    projection::{Project, Projected, Work},
    reducer,
};
use cantrip_transport::lifecycle::owned;
use cantrip_wire::{JsString, Value};
use indexmap::IndexMap;
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub trait Resolver: Send + Sync {
    fn resolve(&self, input: Value, signal: Option<Signal>) -> Work<Value>;
}
impl Resolver for Client {
    fn resolve(&self, input: Value, signal: Option<Signal>) -> Work<Value> {
        Client::resolve(self, &input, signal)
    }
}
pub struct Materialization {
    pub input_parts: Option<Value>,
    pub attachments: Value,
}
/// Callbacks never receive mutable reducer state. Context is selected before
/// reservation; materialization runs only after the exact identity mapping.
pub trait Adapters: Send + Sync {
    fn prepare(&self) -> Work<()> {
        Box::pin(async { Ok(()) })
    }
    fn bootstrap(&self) -> Work<Value> {
        Box::pin(async { Ok(Value::Null) })
    }
    fn context(&self, item: Value, turn: Value) -> Work<Value>;
    fn materialize(
        &self,
        item: Value,
        turn: Value,
        context: Value,
        published_attachments: Option<Value>,
    ) -> Work<Materialization>;
    fn associate(&self, draft: Value, turn: Value) -> Work<Value>;
}
pub struct Options {
    pub binding: Value,
    pub service: Arc<dyn Encryption>,
    pub client: Arc<dyn Resolver>,
    pub adapters: Arc<dyn Adapters>,
    pub max_items_per_batch: Option<Value>,
    pub signal: Option<Signal>,
}
struct Inner {
    options: Options,
    limit: usize,
}
#[derive(Clone)]
pub struct Projector(Arc<Inner>);
impl Projector {
    pub fn new(mut options: Options) -> Result<Self> {
        options.binding = checked("nativeHistoryBindingSchema", &options.binding)?;
        let limit = checked(
            "historySourcePageLimitSchema",
            options
                .max_items_per_batch
                .as_ref()
                .filter(|v| !v.is_null())
                .unwrap_or(&Value::Number(512.)),
        )?
        .as_u64()
        .unwrap() as usize;
        Ok(Self(Arc::new(Inner { options, limit })))
    }
    pub fn callback(&self) -> Project {
        let this = self.clone();
        Arc::new(move |records, previous| this.project(records, previous))
    }
    pub fn project(&self, records: Vec<Value>, previous: Value) -> Work<Projected> {
        let this = self.clone();
        owned(async move { this.run(records, previous).await })
    }
    fn active(&self) -> Result<()> {
        if let Some(signal) = &self.0.options.signal {
            signal.check()?;
        }
        Ok(())
    }
    async fn run(&self, records: Vec<Value>, previous: Value) -> Result<Projected> {
        self.active()?;
        let initial = if previous.is_null() {
            self.0.options.adapters.bootstrap().await?
        } else {
            previous
        };
        self.active()?;
        let saved = if initial.is_null() {
            None
        } else {
            Some(checked("nativeHistoryProjectorStateSchema", &initial)?)
        };
        let source = reducer::reduce(
            saved.as_ref().map(|v| &v["source"]),
            &records,
            text(&self.0.options.binding["threadId"])?,
        )?;
        self.0.options.adapters.prepare().await?;
        self.active()?;
        let state = checked(
            "nativeHistoryProjectorStateSchema",
            &obj([
                ("version", Value::Number(1.)),
                ("source", source.clone()),
                (
                    "items",
                    saved
                        .as_ref()
                        .map_or(Value::Array(Vec::new()), |v| v["items"].clone()),
                ),
                (
                    "turns",
                    saved
                        .as_ref()
                        .map_or(Value::Array(Vec::new()), |v| v["turns"].clone()),
                ),
            ]),
        )?;
        let mut publications = IndexMap::new();
        let mut restored: IndexMap<String, Vec<Value>> = IndexMap::new();
        for publication in array(&state["items"])? {
            publications.insert(key(&publication["identity"]), publication.clone());
            let id = &publication["identity"];
            restored
                .entry(group(&id["turnId"], &id["itemId"], &id["identityKind"]))
                .or_default()
                .push(publication.clone());
        }
        let turn_publications = array(&state["turns"])?
            .iter()
            .map(|p| Ok((text(&p["turnId"])?.clone(), p.clone())))
            .collect::<Result<IndexMap<_, _>>>()?;
        let mut run = Run {
            projector: self.clone(),
            state,
            publications,
            turn_publications,
            pending: Vec::new(),
            batches: Batches::new(self.0.limit),
        };
        for turn in array(&source["turns"])? {
            let reduced = without(turn, "items");
            let items = array(&turn["items"])?;
            let failure = render::turn_failure::item(turn, items.len());
            for item in items.iter().chain(failure.iter()) {
                self.active()?;
                let prior = restored.get(&group(&turn["id"], &item["id"], &item["identityKind"]));
                if let Some(prior) = prior.filter(|p| !p.is_empty()) {
                    if item["lifecycle"] != "completed"
                        && prior.iter().all(|v| v["canonicalState"] == "completed")
                    {
                        continue;
                    }
                    let basis = source_fingerprint(item, &turn["ordinal"], &item["ordinal"]);
                    if prior
                        .iter()
                        .all(|v| v["fingerprint"].is_null() && v["sourceFingerprint"] == basis)
                    {
                        continue;
                    }
                }
                let context = self
                    .0
                    .options
                    .adapters
                    .context(item.clone(), reduced.clone())
                    .await?;
                let mut context = spread(context);
                context["threadId"] = self.0.options.binding["threadId"].clone();
                context["turnId"] = turn["id"].clone();
                for (component, draft) in render::item(item, &context)?.into_iter().enumerate() {
                    let order = obj([
                        ("turn", turn["ordinal"].clone()),
                        ("item", item["ordinal"].clone()),
                        ("component", Value::Number(component as f64)),
                    ]);
                    let prior = run.publications.get(&key(&draft["identity"]));
                    if prior.is_some_and(|v| {
                        v["fingerprint"]
                            == draft_fingerprint(&draft, &order, &Value::Array(Vec::new()))
                    }) {
                        continue;
                    }
                    let association = if prior.is_some() {
                        obj([("kind", s("existing"))])
                    } else if draft["identity"]["component"] == "user"
                        && draft["identity"]["identityKind"] == "canonical"
                        && draft["source"]["body"]["clientId"]
                            .as_js_string()
                            .is_some_and(|v| !v.is_empty())
                    {
                        obj([
                            ("kind", s("observed-input")),
                            (
                                "clientUserMessageId",
                                draft["source"]["body"]["clientId"].clone(),
                            ),
                        ])
                    } else {
                        self.0
                            .options
                            .adapters
                            .associate(draft.clone(), reduced.clone())
                            .await?
                    };
                    run.pending.push(Pending {
                        draft,
                        association,
                        item: item.clone(),
                        turn: reduced.clone(),
                        context: context.clone(),
                        order,
                    });
                    if run.pending.len() >= self.0.limit {
                        run.flush_items().await?;
                    }
                }
            }
            run.turn(turn, &reduced, &source)?;
        }
        run.flush_items().await?;
        run.batches.flush();
        self.active()?;
        run.state["items"] = Value::Array(run.publications.into_values().collect());
        run.state["turns"] = Value::Array(run.turn_publications.into_values().collect());
        Ok(Projected {
            state: checked("nativeHistoryProjectorStateSchema", &run.state)?,
            batches: run.batches.finished,
        })
    }
}
fn without(value: &Value, key: &str) -> Value {
    let mut value = value.clone();
    remove(&mut value, key);
    value
}
// Preserve JavaScript object spread at the callback boundary. Primitive
// presentation values must not panic a native process before actual rendering.
fn spread(value: Value) -> Value {
    match value {
        Value::Object(_) => value,
        Value::Array(ref values) => Value::object(
            values
                .iter()
                .cloned()
                .enumerate()
                .map(|(i, v)| (i.to_string(), v)),
        ),
        Value::String(ref value) => Value::object(
            value
                .units()
                .iter()
                .enumerate()
                .map(|(i, &u)| (i.to_string(), Value::String(JsString::new(vec![u])))),
        ),
        _ => obj([]),
    }
}
fn remove(value: &mut Value, key: &str) {
    if let Value::Object(fields) = value {
        fields.shift_remove(key);
    }
}
fn fingerprint(value: &Value) -> Value {
    s(Sha256::digest(value.stringify_canonical().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>())
}
fn key(identity: &Value) -> String {
    identity.stringify_canonical()
}
fn group(turn: &Value, item: &Value, kind: &Value) -> String {
    Value::Array(vec![turn.clone(), item.clone(), kind.clone()]).stringify()
}
pub fn source_fingerprint(item: &Value, turn_ordinal: &Value, item_ordinal: &Value) -> Value {
    fingerprint(&obj([
        ("source", without(item, "origin")),
        ("turnOrdinal", turn_ordinal.clone()),
        ("itemOrdinal", item_ordinal.clone()),
    ]))
}
fn draft_fingerprint(draft: &Value, order: &Value, attachments: &Value) -> Value {
    let mut draft = draft.clone();
    draft["source"] = without(&draft["source"], "origin");
    fingerprint(&obj([
        ("draft", draft),
        ("order", order.clone()),
        ("attachments", attachments.clone()),
    ]))
}
struct Pending {
    draft: Value,
    association: Value,
    item: Value,
    turn: Value,
    context: Value,
    order: Value,
}
struct Batches {
    current: Value,
    bytes: usize,
    limit: usize,
    finished: Vec<Value>,
}
impl Batches {
    fn new(limit: usize) -> Self {
        Self {
            current: obj([
                ("items", Value::Array(Vec::new())),
                ("turns", Value::Array(Vec::new())),
            ]),
            bytes: 0,
            limit,
            finished: Vec::new(),
        }
    }
    fn flush(&mut self) {
        if !self.current["items"].as_array().unwrap().is_empty()
            || !self.current["turns"].as_array().unwrap().is_empty()
        {
            let next = Self::new(self.limit);
            self.finished
                .push(std::mem::replace(&mut self.current, next.current));
        }
        self.bytes = 0;
    }
    fn append(&mut self, kind: &str, value: Value) {
        let bytes = value.stringify().len();
        if array(&self.current["items"]).unwrap().len()
            + array(&self.current["turns"]).unwrap().len()
            >= self.limit
            || (self.bytes + bytes > 4 * 1024 * 1024 && self.bytes > 0)
        {
            self.flush();
        }
        if let Value::Array(values) = &mut self.current[kind] {
            values.push(value);
        }
        self.bytes += bytes;
    }
}
struct Run {
    projector: Projector,
    state: Value,
    publications: IndexMap<String, Value>,
    turn_publications: IndexMap<JsString, Value>,
    pending: Vec<Pending>,
    batches: Batches,
}
