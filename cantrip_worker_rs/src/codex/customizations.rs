//! Protected Project Chat inventory and the native customization operations.
pub(super) mod external;
mod inventory;
mod mcp;
pub(super) mod oauth;

use super::{managed::Runtime, skills};
use crate::{filesystem::paths, protected_content::customization::Operation};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

const TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Copy)]
pub(super) enum Command {
    Inventory,
    SkillRoots,
    McpRead,
    McpReload,
    McpOauthStart,
    McpOauthStatus,
    ExternalPreview,
    ExternalApply,
    ExternalStatus,
}

impl Command {
    pub fn find(value: &str) -> Option<Self> {
        Some(match value {
            "customization.inventory.read" => Self::Inventory,
            "customization.skill-roots.set" => Self::SkillRoots,
            "customization.mcp.resource.read" => Self::McpRead,
            "customization.mcp.reload" => Self::McpReload,
            "customization.mcp.oauth.start" => Self::McpOauthStart,
            "customization.mcp.oauth.status" => Self::McpOauthStatus,
            "customization.external.preview" => Self::ExternalPreview,
            "customization.external.apply" => Self::ExternalApply,
            "customization.external.status" => Self::ExternalStatus,
            _ => return None,
        })
    }

    pub fn mutating(self) -> bool {
        matches!(
            self,
            Self::SkillRoots | Self::McpReload | Self::McpOauthStart | Self::ExternalApply
        )
    }

    pub fn schemas(self) -> (Option<&'static str>, &'static str) {
        match self {
            Self::Inventory => (None, "codexCustomizationInventorySchema"),
            Self::SkillRoots => (
                Some("codexSkillRootsUpdateSchema"),
                "codexSkillRootsResultSchema",
            ),
            Self::McpRead => (
                Some("codexMcpResourceReadRequestSchema"),
                "codexMcpResourceReadSchema",
            ),
            Self::McpReload => (
                Some("codexMcpReloadRequestSchema"),
                "codexMcpReloadResultSchema",
            ),
            Self::McpOauthStart => (
                Some("codexMcpOauthStartSchema"),
                "codexMcpOauthStartResultSchema",
            ),
            Self::McpOauthStatus => (
                Some("codexMcpOauthStartSchema"),
                "codexMcpOauthStatusSchema",
            ),
            Self::ExternalPreview => (None, "codexExternalImportPreviewSchema"),
            Self::ExternalApply => (
                Some("codexExternalImportApplySchema"),
                "codexExternalImportStatusSchema",
            ),
            Self::ExternalStatus => (
                Some("codexExternalImportStatusRequestSchema"),
                "codexExternalImportStatusSchema",
            ),
        }
    }

    pub fn lifecycle(self, value: &Value) -> Option<&'static str> {
        match self {
            Self::McpOauthStart => Some("pending"),
            Self::McpOauthStatus | Self::ExternalApply | Self::ExternalStatus => {
                Some(match value["status"].as_str() {
                    Some("pending") => "pending",
                    Some("unknown") => "unknown",
                    _ => "completed",
                })
            }
            _ => None,
        }
    }

    pub async fn run(self, target: Target<'_>, input: &Value) -> Result<Value> {
        match self {
            Self::Inventory => inventory::read(&target).await,
            Self::SkillRoots => set_roots(&target, input).await,
            Self::McpRead => mcp::read(&target, input).await,
            Self::McpReload => mcp::reload(&target).await,
            Self::McpOauthStart => oauth::start(&target, input).await,
            Self::McpOauthStatus => oauth::status(&target, input),
            Self::ExternalPreview => external::preview(&target).await,
            Self::ExternalApply => external::apply(&target, input).await,
            Self::ExternalStatus => external::status(&target, input),
        }
    }
}

pub(super) struct Target<'a> {
    pub runtime: &'a Runtime,
    pub cwd: &'a JsString,
    pub thread: &'a Value,
    pub global: Option<&'a Path>,
    pub report: &'a Value,
    pub force_reload: bool,
    pub operation: &'a Operation<'a>,
}

fn resolve_roots(cwd: &Path, requested: &[Value]) -> Result<Vec<PathBuf>> {
    let cwd = paths::canonical_sync(cwd)?;
    let mut resolved = Vec::<PathBuf>::new();
    for root in requested {
        let name = root.as_js_string().context("Invalid extra skill root.")?;
        let candidate = cantrip_config::resolve(&cwd, &paths::native(name));
        let canonical = paths::canonical_sync(&candidate)?;
        ensure!(
            paths::within(&cwd, &canonical),
            "Extra skill roots must resolve within the selected project checkout."
        );
        ensure!(
            canonical.metadata()?.is_dir(),
            "Extra skill root is not a directory: {}",
            name.lossy()
        );
        if !resolved
            .iter()
            .any(|existing| paths::equal(&canonical, existing))
        {
            resolved.push(canonical);
        }
    }
    Ok(resolved)
}

async fn set_roots(target: &Target<'_>, input: &Value) -> Result<Value> {
    let requested = input["roots"]
        .as_array()
        .context("Missing extra skill roots.")?
        .clone();
    let directory = paths::native(target.cwd);
    let project =
        tokio::task::spawn_blocking(move || resolve_roots(&directory, &requested)).await??;
    let mut roots = target
        .global
        .map(paths::text)
        .into_iter()
        .collect::<Vec<_>>();
    let project = project
        .into_iter()
        .map(|path| paths::text(&path))
        .collect::<Vec<_>>();
    for entry in &project {
        if !roots
            .iter()
            .any(|root| paths::equal(&paths::native(root), &paths::native(entry)))
        {
            roots.push(entry.clone());
        }
    }
    let mut state = target.runtime.project_skill_roots().write().await;
    target.operation.assert_current()?;
    target
        .runtime
        .request(
            "skills/extraRoots/set".into(),
            Some(json!({"extraRoots":roots})),
            Some(TIMEOUT),
            None,
        )
        .await?;
    *state = project;
    Ok(json!({"roots": &*state}))
}

fn entries<'a>(object: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    object[key].as_array().into_iter().flatten()
}

fn optional(value: &Value) -> Value {
    value.as_js_string().map_or(Value::Null, |text| json!(text))
}

fn nonempty(value: &Value) -> Option<&JsString> {
    value.as_js_string().filter(|value| !value.is_empty())
}

fn integer(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .filter(|number| *number <= 9_007_199_254_740_991)
}
