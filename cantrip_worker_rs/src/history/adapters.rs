//! Verified adapters for an already authorized source binding. Native input
//! remains independent of historical presentation/context availability.
use super::{
    attachments,
    input_materializer::{Materializer, Published},
    lineage,
    projector::{Adapters, Materialization},
    turn_context::{self, Index},
};
use crate::{
    attachments::{Store as Files, content::Keys},
    metadata::Signal,
    native_items::{checked, obj, s},
};
use anyhow::{Result, bail};
use cantrip_history::{projection::Work, source::Journal};
use cantrip_wire::Value;
use std::{path::PathBuf, sync::Arc};
pub type PairCallback = Arc<dyn Fn(Value, Value) -> Work<Value> + Send + Sync>;
pub struct Options {
    pub directory: PathBuf,
    pub binding: Value,
    pub source: Journal,
    pub keys: Arc<dyn Keys>,
    pub files: Files,
    pub signal: Option<Signal>,
    pub child_scope: Option<PairCallback>,
    pub child_association: Option<PairCallback>,
    pub published_attachments: Option<Published>,
}
struct Inner {
    options: Options,
    contexts: Index,
    materializer: Materializer,
}
#[derive(Clone)]
pub struct Verified(Arc<Inner>);
impl Verified {
    pub fn new(options: Options) -> Result<Self> {
        let scope = options.source.scope();
        let (owner, server) = options.keys.attachment_identity()?;
        if [
            ("bindingId", "id"),
            ("threadId", "threadId"),
            ("chatId", "chatId"),
            ("workerId", "workerId"),
        ]
        .iter()
        .any(|(left, right)| scope[*left] != options.binding[*right])
            || scope["ownerId"] != s(owner)
            || scope["serverId"] != s(server)
        {
            bail!("Native history adapters require the exact authorized source binding.");
        }
        let contexts = Index::new(Arc::new(options.source.clone()), options.signal.clone());
        let store = attachments::Store::new(
            options.directory.join("attachments"),
            options.binding.clone(),
            options.keys.clone(),
            options.files.clone(),
        )?;
        let materializer = Materializer::new(
            options.directory.join("input-parts"),
            options.binding.clone(),
            options.keys.clone(),
            options.files.clone(),
            store,
            options.published_attachments.clone(),
        )?;
        Ok(Self(Arc::new(Inner {
            options,
            contexts,
            materializer,
        })))
    }
    fn ancestors(&self) -> &[Value] {
        self.0.options.binding["ancestorThreadIds"]
            .as_array()
            .map_or(&[], Vec::as_slice)
    }
    fn child_scope(&self, turn: &Value, root: &Value) -> Result<Value> {
        let ancestors = self.ancestors();
        if ancestors.is_empty() || root == turn {
            bail!("Native child history has no retained root turn.");
        }
        let child = self.0.contexts.child_metadata(ancestors.last().unwrap())?;
        let mut path = lineage::segments(&child["agentPath"]);
        if path.is_empty() {
            path.push(s("root"));
            path.extend(ancestors[1..].iter().cloned());
            path.push(self.0.options.binding["threadId"].clone());
        }
        checked(
            "agentScopeSchema",
            &obj([
                ("rootThreadId", ancestors[0].clone()),
                ("parentThreadId", ancestors.last().unwrap().clone()),
                ("agentThreadId", self.0.options.binding["threadId"].clone()),
                ("rootTurnId", root.clone()),
                ("agentPath", Value::Array(path)),
                ("depth", Value::Number(ancestors.len() as f64)),
                ("nickname", child["nickname"].clone()),
                ("role", child["role"].clone()),
                ("isRoot", Value::Bool(false)),
            ]),
        )
    }
}
impl Adapters for Verified {
    fn prepare(&self) -> Work<()> {
        self.0.contexts.refresh()
    }
    fn context(&self, _item: Value, turn: Value) -> Work<Value> {
        let this = self.clone();
        Box::pin(async move {
            let mut context = turn_context::resolve(&this.0.contexts.read(&turn)?)?;
            let root = context["rootTurnId"].clone();
            if let Value::Object(fields) = &mut context {
                fields.shift_remove("rootTurnId");
            }
            if !this.ancestors().is_empty() && (root.is_null() || root == turn["id"]) {
                bail!("Native child history has no retained root turn.");
            }
            if root.is_null() || root == turn["id"] {
                return Ok(context);
            }
            if this.0.options.child_scope.is_none() && this.ancestors().is_empty() {
                bail!("Native child history requires verified parent scope.");
            }
            let scope = match &this.0.options.child_scope {
                Some(callback) => callback(turn["id"].clone(), root.clone()).await?,
                None => this.child_scope(&turn["id"], &root)?,
            };
            let scope = checked("agentScopeSchema", &scope)?;
            if scope["agentThreadId"] != this.0.options.binding["threadId"]
                || scope["rootTurnId"] != root
                || scope["isRoot"] == true
            {
                bail!("Native history child scope belongs to another thread.");
            }
            context["agentScope"] = scope;
            Ok(context)
        })
    }
    fn materialize(
        &self,
        item: Value,
        turn: Value,
        context: Value,
        published: Option<Value>,
    ) -> Work<Materialization> {
        self.0
            .materializer
            .materialize(item, turn, context, published)
    }
    fn associate(&self, draft: Value, turn: Value) -> Work<Value> {
        let this = self.clone();
        Box::pin(async move {
            let context = turn_context::resolve(&this.0.contexts.read(&turn)?)?;
            let root = &context["rootTurnId"];
            let child = !root.is_null() && root != &turn["id"];
            if child {
                if let Some(callback) = &this.0.options.child_association {
                    return callback(draft, turn).await;
                }
                this.child_scope(&turn["id"], root)?;
            }
            let output = draft["identity"]["identityKind"] == "canonical"
                && matches!(
                    draft["identity"]["component"].as_str(),
                    Some("assistant" | "activity")
                );
            let mut result = obj([("kind", s(if output { "output" } else { "native" }))]);
            if output && child {
                result["rootTurnId"] = root.clone();
            }
            Ok(result)
        })
    }
}
