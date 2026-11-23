use super::{flight::Cache, mode};
use crate::{
    history::{client::Client, projector::Resolver as IdentityClient},
    metadata::{Guard, Signal},
    native_items::{array, checked, obj, s, text},
};
use anyhow::{Result, bail};
use cantrip_history::projection::Work;
use cantrip_wire::{JsString, Value};
use std::sync::Arc;
pub type Select = Arc<dyn Fn(&Value) -> Result<Option<Value>> + Send + Sync>;
pub type Scope = Arc<dyn Fn(JsString, Option<Value>) -> Work<Option<Value>> + Send + Sync>;
pub type Mode = Arc<dyn Fn(Value) -> Work<Value> + Send + Sync>;
#[derive(Clone)]
pub struct Bound {
    binding: Value,
    client: Arc<dyn IdentityClient>,
    select: Select,
    cache: Cache<Option<Value>>,
}
impl Bound {
    pub fn new(binding: Value, client: Arc<dyn IdentityClient>, select: Select) -> Self {
        Self {
            binding,
            client,
            select,
            cache: Cache::default(),
        }
    }
    pub fn resolve(&self, output: Value) -> Work<Option<Value>> {
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let Some(selected) = (this.select)(&output)? else {
                return Ok(None);
            };
            let identity = checked("nativeHistoryItemIdentitySchema", &selected)?;
            if identity["threadId"] != this.binding["threadId"] {
                bail!("Native output identity belongs to a different history binding.");
            }
            let key = identity.stringify();
            let expected = key.clone();
            let keep = this.clone();
            this.cache
                .get(key, move || {
                    cantrip_transport::lifecycle::owned(async move {
                        let item = output_item(&output);
                        let mut association = obj([("kind", s("output"))]);
                        if item["agentScope"]["isRoot"] == false {
                            association["rootTurnId"] = item["agentScope"]["rootTurnId"].clone();
                        }
                        let mappings = keep
                            .client
                            .resolve(
                                obj([
                                    ("chatId", keep.binding["chatId"].clone()),
                                    ("bindingId", keep.binding["id"].clone()),
                                    (
                                        "items",
                                        Value::Array(vec![obj([
                                            ("identity", identity),
                                            ("association", association),
                                        ])]),
                                    ),
                                ]),
                                None,
                            )
                            .await?;
                        if array(&mappings)?.len() != 1 {
                            bail!("Native output resolution omitted its unique mapping.");
                        }
                        let mapping =
                            checked("nativeHistoryItemMappingSchema", &array(&mappings)?[0])?;
                        if mapping["identity"].stringify() != expected
                            || cantrip_wire::coercion::truthy(mapping.get("preservedInput"))
                        {
                            bail!("Native output resolution returned an unrelated mapping.");
                        }
                        Ok(Some(obj([
                            ("id", mapping["messageId"].clone()),
                            ("idempotencyKey", mapping["idempotencyKey"].clone()),
                        ])))
                    })
                })
                .await
        })
    }
}
pub trait ClientApi: Send + Sync {
    fn open(&self, input: Value, signal: Option<Signal>) -> Work<Value>;
    fn resolve(&self, input: Value, signal: Option<Signal>) -> Work<Value>;
}
impl ClientApi for Client {
    fn open(&self, input: Value, signal: Option<Signal>) -> Work<Value> {
        Client::open(self, &input, signal)
    }
    fn resolve(&self, input: Value, signal: Option<Signal>) -> Work<Value> {
        Client::resolve(self, &input, signal)
    }
}
struct Timed {
    client: Arc<dyn ClientApi>,
    signal: Option<Signal>,
}
impl IdentityClient for Timed {
    fn resolve(&self, input: Value, _: Option<Signal>) -> Work<Value> {
        let running = self.client.resolve(input, self.signal.clone());
        let guard = Guard::metadata(self.signal.clone(), None);
        cantrip_transport::lifecycle::owned(async move { guard.run(running).await })
    }
}
pub struct Options {
    pub client: Arc<dyn ClientApi>,
    pub scope: Scope,
    pub mode: Mode,
    pub signal: Option<Signal>,
}
struct Inner {
    options: Options,
    bindings: Cache<Bound>,
}
#[derive(Clone)]
pub struct Managed(Arc<Inner>);
impl Managed {
    pub fn new(options: Options) -> Self {
        Self(Arc::new(Inner {
            options,
            bindings: Cache::default(),
        }))
    }
    pub fn resolve(&self, output: Value) -> Work<Option<Value>> {
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let Some(selected) = native_identity(&output)? else {
                return Ok(None);
            };
            let item = output_item(&output);
            let scope = (this.0.options.scope)(
                text(&selected["threadId"])?.clone(),
                item.get("agentScope").cloned(),
            )
            .await?
            .ok_or_else(|| {
                anyhow::anyhow!("Live native output is missing its dispatched history scope.")
            })?;
            if selected["threadId"] != scope["threadId"] {
                return Ok(None);
            }
            let key =
                Value::Array(vec![scope["chatId"].clone(), scope["threadId"].clone()]).stringify();
            let keep = this.clone();
            let bound = this
                .0
                .bindings
                .get(key, move || {
                    cantrip_transport::lifecycle::owned(async move {
                        let binding = Guard::metadata(keep.0.options.signal.clone(), None)
                            .run(
                                keep.0
                                    .options
                                    .client
                                    .open(scope.clone(), keep.0.options.signal.clone()),
                            )
                            .await?;
                        if binding["chatId"] != scope["chatId"]
                            || binding["threadId"] != scope["threadId"]
                        {
                            bail!("Live native output received an unrelated history binding.");
                        }
                        Ok(Bound::new(
                            binding,
                            Arc::new(Timed {
                                client: keep.0.options.client.clone(),
                                signal: keep.0.options.signal.clone(),
                            }),
                            Arc::new(native_identity),
                        ))
                    })
                })
                .await?;
            let resolved = bound.resolve(output);
            let mode = (this.0.options.mode)(selected);
            let (resolved, mode) = futures::try_join!(resolved, mode)?;
            Ok(resolved.map(|mut value| {
                value["mode"] = mode;
                value
            }))
        })
    }
}
pub fn with_mode(resolver: mode::Resolver) -> Mode {
    Arc::new(move |identity| resolver.resolve(identity))
}
fn output_item(output: &Value) -> &Value {
    if output["kind"] == "message" {
        &output["message"]
    } else {
        &output["activity"]
    }
}
pub fn native_identity(output: &Value) -> Result<Option<Value>> {
    let item = output_item(output);
    let correlation = &item["correlation"];
    if !correlation["sourceMethod"]
        .as_js_string()
        .is_some_and(|v| v.units().starts_with(&[105, 116, 101, 109, 47]))
        || ["threadId", "turnId", "itemId"]
            .iter()
            .any(|k| !cantrip_wire::coercion::truthy(correlation.get(k)))
        || item["id"] != correlation["itemId"]
    {
        return Ok(None);
    }
    Ok(Some(obj([
        ("threadId", correlation["threadId"].clone()),
        ("turnId", correlation["turnId"].clone()),
        ("itemId", correlation["itemId"].clone()),
        (
            "component",
            s(if output["kind"] == "message" {
                "assistant"
            } else {
                "activity"
            }),
        ),
        ("identityKind", s("canonical")),
    ])))
}
