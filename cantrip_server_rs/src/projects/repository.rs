//! Project reads shared by resource routes and application-live authorization.
//! Preserve the complete mapper/validation path instead of an existence query.
use super::capabilities;
use crate::{
    auth::iso,
    database::{Database, Row},
    wire::{self, Value, value::Object},
};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use icu_collator::{Collator, CollatorBorrowed, options::CollatorOptions};
use icu_locale_core::Locale;
use std::{collections::HashMap, sync::Arc};

pub struct ProjectRepository {
    database: Arc<Database>,
    collator: CollatorBorrowed<'static>,
}
fn object(fields: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect::<Object>(),
    )
}
fn text(value: impl Into<String>) -> Value {
    Value::String(value.into().into())
}
fn copy(value: &Value, field: &str) -> Value {
    value.get(field).cloned().unwrap_or(Value::Null)
}
struct Worktree {
    raw: Value,
    // Conversion belongs to the selected primary's mapper, not the query.
    // The reference never serializes another worktree's observation date.
    row: Row,
}
struct Source {
    raw: Value,
    name: String,
    seen: DateTime<Utc>,
    created: DateTime<Utc>,
    updated: DateTime<Utc>,
}
fn nullish(preferred: Option<&Value>, fallback: Option<&Value>) -> Value {
    preferred
        .filter(|v| !v.is_null())
        .or(fallback)
        .cloned()
        .unwrap_or(Value::Null)
}
fn dirty(status: &Value) -> Result<Value> {
    if !wire::coercion::truthy(Some(status)) {
        return Ok(Value::Null);
    }
    let files = status
        .get("files")
        .filter(|v| !v.is_null())
        .context("Observed project files are unavailable")?;
    let length = match files {
        Value::Array(values) => Some(Value::Number(values.len() as f64)),
        Value::String(value) => Some(Value::Number(value.len() as f64)),
        _ => files.get("length").cloned(),
    };
    Ok(Value::Bool(
        wire::coercion::number(length.as_ref()).is_ok_and(|v| v > 0.0),
    ))
}
fn replica(source: &Source, worktrees: &[Worktree]) -> Result<Value> {
    let primary = worktrees
        .iter()
        .find(|w| w.raw["is_primary"].as_bool() == Some(true));
    let raw = primary.map(|w| &w.raw);
    let status = raw
        .and_then(|v| v.get("status_snapshot"))
        .and_then(|v| v.get("status"));
    let id = source.raw.get("id").context("Project source identity")?;
    let observed = primary
        .map(|worktree| worktree.row.get::<Option<DateTime<Utc>>>(1))
        .transpose()?
        .flatten();
    Ok(object([
        ("id", id.clone()),
        ("projectId", copy(&source.raw, "project_id")),
        ("sourceKind", copy(&source.raw, "source_kind")),
        ("workerId", copy(&source.raw, "worker_id")),
        ("workerName", text(&source.name)),
        (
            "workerOnline",
            Value::Bool(Utc::now().timestamp_millis() - source.seen.timestamp_millis() <= 30000),
        ),
        ("path", copy(&source.raw, "absolute_path")),
        ("displayPath", copy(&source.raw, "display_path")),
        ("placementMode", copy(&source.raw, "placement_mode")),
        ("ownershipKind", copy(&source.raw, "ownership_kind")),
        ("requestedPath", copy(&source.raw, "requested_path")),
        ("linkPath", copy(&source.raw, "link_path")),
        (
            "repositoryFingerprint",
            copy(&source.raw, "repository_fingerprint"),
        ),
        (
            "primaryWorktreeId",
            raw.map_or(Value::Null, |r| copy(r, "id")),
        ),
        (
            "branch",
            nullish(
                status.and_then(|s| s.get("branch")),
                raw.and_then(|r| r.get("branch")),
            ),
        ),
        (
            "head",
            nullish(
                status.and_then(|s| s.get("head")),
                raw.and_then(|r| r.get("head")),
            ),
        ),
        ("dirty", dirty(status.unwrap_or(&Value::Null))?),
        (
            "ready",
            Value::Bool(raw.is_some_and(|r| r["lifecycle_state"] == "ready")),
        ),
        ("worktreeCount", Value::Number(worktrees.len() as f64)),
        (
            "lastObservedAt",
            observed.map_or(Value::Null, |v| text(iso(v))),
        ),
        ("createdAt", text(iso(source.created))),
        ("updatedAt", text(iso(source.updated))),
    ]))
}
fn project(
    raw: &Value,
    replicas: Vec<Value>,
    created: DateTime<Utc>,
    updated: DateTime<Utc>,
) -> Result<Value> {
    let origin = raw["origin_kind"].as_str().context("Project origin")?;
    let caps = capabilities(
        origin,
        raw["git_capability"]
            .as_bool()
            .context("Project Git capability")?,
        raw["github_capability"]
            .as_bool()
            .context("Project GitHub capability")?,
    );
    let github = if [
        "github_repository_id",
        "github_repository_full_name",
        "github_repository_url",
    ]
    .into_iter()
    .all(|key| wire::coercion::truthy(raw.get(key)))
    {
        object([
            ("repositoryId", copy(raw, "github_repository_id")),
            ("nameWithOwner", copy(raw, "github_repository_full_name")),
            ("url", copy(raw, "github_repository_url")),
        ])
    } else {
        Value::Null
    };
    let source = replicas
        .iter()
        .find(|r| {
            wire::coercion::truthy(raw.get("preferred_worker_id"))
                && r["workerId"] == raw["preferred_worker_id"]
                && r["ready"] == Value::Bool(true)
        })
        .or_else(|| replicas.iter().find(|r| r["ready"] == Value::Bool(true)))
        .or_else(|| replicas.first());
    let source = source
        .map(|replica| {
            object([
                ("id", copy(replica, "id")),
                ("sourceKind", copy(replica, "sourceKind")),
                ("workerId", copy(replica, "workerId")),
                ("path", copy(replica, "path")),
                ("displayPath", copy(replica, "displayPath")),
                ("placementMode", copy(replica, "placementMode")),
                ("ownershipKind", copy(replica, "ownershipKind")),
                ("requestedPath", copy(replica, "requestedPath")),
                ("linkPath", copy(replica, "linkPath")),
            ])
        })
        .unwrap_or(Value::Null);
    let result = object([
        ("id", copy(raw, "id")),
        ("nameProtection", copy(raw, "protected_label")),
        ("position", copy(raw, "position")),
        ("originKind", copy(raw, "origin_kind")),
        ("folderManagement", copy(raw, "folder_management")),
        ("capabilities", Value::from_serialize(&caps)),
        ("setupStatus", copy(raw, "setup_status")),
        ("setupError", copy(raw, "setup_error")),
        ("worktreePolicy", copy(raw, "worktree_policy")),
        ("preferredWorkerId", copy(raw, "preferred_worker_id")),
        ("github", github),
        ("source", source),
        ("replicas", Value::Array(replicas)),
        ("createdAt", text(iso(created))),
        ("updatedAt", text(iso(updated))),
    ]);
    wire::parse("projectWireSummarySchema", Some(&result))
        .map_err(|_| anyhow::anyhow!("Invalid project wire summary"))
}
impl ProjectRepository {
    pub fn new(database: Arc<Database>) -> Result<Self> {
        let locale = sys_locale::get_locale()
            .and_then(|locale| locale.parse::<Locale>().ok())
            .unwrap_or_else(|| "en-US".parse().unwrap());
        Ok(Self {
            database,
            collator: Collator::try_new(locale.into(), CollatorOptions::default())
                .context("Project sorting locale")?,
        })
    }
    pub async fn list(&self, owner: &str) -> Result<Vec<Value>> {
        let projects=self.database.query("SELECT to_jsonb(p)::text,p.created_at,p.updated_at FROM projects p WHERE owner_id=$1 ORDER BY position ASC,created_at ASC",&[&owner]).await?;
        let ids = projects
            .iter()
            .map(|row| {
                let raw: Value = serde_json::from_str(&row.get::<String>(0)?)?;
                Ok(raw["id"].as_str().context("Project identity")?.to_owned())
            })
            .collect::<Result<Vec<_>>>()?;
        let mut by_project = ids
            .iter()
            .map(|id| (id.clone(), Vec::new()))
            .collect::<HashMap<String, Vec<Value>>>();
        if !ids.is_empty() {
            let sources=self.database.query("SELECT to_jsonb(s)::text,coalesce(w.display_name,w.name),w.last_seen_at,s.created_at,s.updated_at,w.started_at FROM project_sources s INNER JOIN projects p ON p.id=s.project_id INNER JOIN workers w ON w.id=s.worker_id WHERE p.owner_id=$1 AND s.project_id=ANY($2::text[]) AND s.removed_at IS NULL ORDER BY s.created_at ASC,s.id ASC",&[&owner,&ids]).await?.iter().map(|row|{
                // toWorkerSummary serializes startedAt even when this caller
                // consumes only its name and online fields.
                row.get::<DateTime<Utc>>(5)?;
                Ok(Source{raw:serde_json::from_str(&row.get::<String>(0)?)?,name:row.get(1)?,seen:row.get(2)?,created:row.get(3)?,updated:row.get(4)?})
            }).collect::<Result<Vec<_>>>()?;
            if !sources.is_empty() {
                let source_ids = sources
                    .iter()
                    .map(|s| {
                        s.raw["id"]
                            .as_str()
                            .context("Project source identity")
                            .map(str::to_owned)
                    })
                    .collect::<Result<Vec<_>>>()?;
                let mut worktrees = HashMap::<String, Vec<Worktree>>::new();
                for row in self.database.query("SELECT to_jsonb(w)::text,w.status_observed_at FROM project_worktrees w WHERE project_source_id=ANY($1::text[]) ORDER BY is_primary DESC,created_at ASC",&[&source_ids]).await? {
                    let raw:Value=serde_json::from_str(&row.get::<String>(0)?)?;let source=raw["project_source_id"].as_str().context("Worktree source identity")?.to_owned();
                    worktrees.entry(source).or_default().push(Worktree{raw,row});
                }
                for source in sources {
                    let id = source.raw["id"]
                        .as_str()
                        .context("Project source identity")?;
                    let project = source.raw["project_id"]
                        .as_str()
                        .context("Source project identity")?;
                    if let Some(replicas) = by_project.get_mut(project) {
                        replicas.push(replica(
                            &source,
                            worktrees.get(id).map_or(&[], Vec::as_slice),
                        )?);
                    }
                }
                for replicas in by_project.values_mut() {
                    replicas.sort_by(|left, right| {
                        right["ready"]
                            .as_bool()
                            .cmp(&left["ready"].as_bool())
                            .then_with(|| {
                                self.collator.compare_utf16(
                                    left["createdAt"].as_js_string().unwrap().units(),
                                    right["createdAt"].as_js_string().unwrap().units(),
                                )
                            })
                            .then_with(|| {
                                self.collator.compare_utf16(
                                    left["id"].as_js_string().unwrap().units(),
                                    right["id"].as_js_string().unwrap().units(),
                                )
                            })
                    });
                }
            }
        }
        projects
            .iter()
            .map(|row| {
                let raw: Value = serde_json::from_str(&row.get::<String>(0)?)?;
                let id = raw["id"].as_str().context("Project identity")?;
                project(
                    &raw,
                    by_project.remove(id).unwrap_or_default(),
                    row.get(1)?,
                    row.get(2)?,
                )
            })
            .collect()
    }
}
