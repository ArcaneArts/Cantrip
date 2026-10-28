//! Project execution placement, including the source repository's selection order.
use crate::{
    database::Database,
    wire::{self, Value},
};
use anyhow::{Context, Result};
use icu_collator::{Collator, CollatorBorrowed, options::CollatorOptions};
use icu_locale_core::Locale;
use std::{collections::HashSet, fmt, sync::Arc};

pub type Connected<'a> = Option<&'a (dyn Fn(&str) -> bool + Send + Sync)>;

#[derive(Debug)]
pub struct Unavailable {
    pub code: &'static str,
    pub message: String,
}
impl fmt::Display for Unavailable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.message.fmt(f)
    }
}
impl std::error::Error for Unavailable {}
pub(super) fn unavailable<T>(code: &'static str, message: impl Into<String>) -> Result<T> {
    Err(Unavailable {
        code,
        message: message.into(),
    }
    .into())
}
pub(super) fn string(value: &Value, key: &str) -> Result<String> {
    value[key]
        .as_str()
        .map(str::to_owned)
        .with_context(|| format!("Placement {key}"))
}
pub(super) fn value(value: impl Into<String>) -> Value {
    Value::String(value.into().into())
}
fn millis(raw: &Value, key: &str) -> Option<i64> {
    raw[key].as_js_string().and_then(wire::date_milliseconds)
}
pub(super) fn collator() -> Result<CollatorBorrowed<'static>> {
    let locale = sys_locale::get_locale()
        .and_then(|v| v.parse::<Locale>().ok())
        .unwrap_or_else(|| "en-US".parse().unwrap());
    Collator::try_new(locale.into(), CollatorOptions::default()).context("Placement sorting locale")
}

struct Replica {
    source: Value,
    worktree: Value,
}
struct Snapshot {
    project: Value,
    workers: Vec<Value>,
    replicas: Vec<Replica>,
    default_worker: Option<String>,
}
pub struct PlacementRepository {
    database: Arc<Database>,
    collator: CollatorBorrowed<'static>,
}
impl PlacementRepository {
    pub fn new(database: Arc<Database>) -> Result<Self> {
        Ok(Self {
            database,
            collator: collator()?,
        })
    }
    pub async fn resolve(
        &self,
        owner: &str,
        project_id: &str,
        surface: &str,
        target: Option<&Value>,
        connected: Connected<'_>,
        allow_offline_explicit: bool,
    ) -> Result<Value> {
        let rows = self
            .database
            .query(
                "SELECT to_jsonb(p)::text FROM projects p WHERE id=$1 AND owner_id=$2 LIMIT 1",
                &[&project_id, &owner],
            )
            .await?;
        let Some(row) = rows.first() else {
            return unavailable("project-not-found", "Project not found.");
        };
        let project: Value = serde_json::from_str(&row.get::<String>(0)?)?;
        if target.is_some_and(|t| t["projectId"] != project_id) {
            return unavailable(
                "target-mismatch",
                "The execution target belongs to a different project.",
            );
        }
        if target.is_some_and(|t| t["kind"] == "surface") {
            return unavailable(
                "target-mismatch",
                "A new surface cannot use an existing surface as its placement target.",
            );
        }
        // These are independent READ COMMITTED statements, matching Promise.all.
        let owner_params: [&(dyn tokio_postgres::types::ToSql + Sync); 1] = [&owner];
        let project_params: [&(dyn tokio_postgres::types::ToSql + Sync); 1] = [&project_id];
        let (settings, workers, replicas) = tokio::try_join!(
            self.database.query("SELECT default_worker_id FROM user_settings WHERE user_id=$1 LIMIT 1", &owner_params),
            self.database.query("SELECT to_jsonb(w)::text FROM workers w WHERE owner_id=$1 AND unlinked_at IS NULL ORDER BY id ASC", &owner_params),
            self.database.query("SELECT to_jsonb(s)::text,to_jsonb(w)::text FROM project_sources s LEFT JOIN project_worktrees w ON w.project_source_id=s.id WHERE s.project_id=$1 AND s.removed_at IS NULL", &project_params),
        )?;
        let snapshot = Snapshot {
            project,
            default_worker: settings
                .first()
                .map(|r| r.get::<Option<String>>(0))
                .transpose()?
                .flatten(),
            workers: workers
                .iter()
                .map(|r| Ok(serde_json::from_str(&r.get::<String>(0)?)?))
                .collect::<Result<_>>()?,
            replicas: replicas
                .iter()
                .map(|r| {
                    Ok(Replica {
                        source: serde_json::from_str(&r.get::<String>(0)?)?,
                        worktree: r
                            .get::<Option<String>>(1)?
                            .map(|s| serde_json::from_str(&s))
                            .transpose()?
                            .unwrap_or(Value::Null),
                    })
                })
                .collect::<Result<_>>()?,
        };
        let bound = snapshot.project["origin_kind"] == "managed-folder"
            && snapshot.project["git_capability"] == false;
        let owning = if bound {
            snapshot.project["preferred_worker_id"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| {
                    snapshot
                        .replicas
                        .iter()
                        .find(|r| r.source["source_kind"] == "folder")
                        .and_then(|r| r.source["worker_id"].as_str().map(str::to_owned))
                })
        } else {
            None
        };
        let state = Selection {
            snapshot: &snapshot,
            project_id,
            surface,
            connected,
            allow_offline_explicit,
            bound,
            owning: owning.as_deref(),
            collator: &self.collator,
        };
        if let Some(target) = target.filter(|t| t["kind"] != "project") {
            let (worker, source, worktree) = if target["kind"] == "worker" {
                (target["workerId"].clone(), None, None)
            } else if target["kind"] == "replica" {
                let Some(row) = snapshot
                    .replicas
                    .iter()
                    .find(|r| r.source["id"] == target["projectReplicaId"])
                else {
                    return unavailable(
                        "target-not-found",
                        "The selected project replica was not found.",
                    );
                };
                (
                    row.source["worker_id"].clone(),
                    Some(string(&row.source, "id")?),
                    None,
                )
            } else {
                let Some(row) = snapshot
                    .replicas
                    .iter()
                    .find(|r| !r.worktree.is_null() && r.worktree["id"] == target["worktreeId"])
                else {
                    return unavailable("target-not-found", "The selected worktree was not found.");
                };
                if row.worktree["worker_id"] != row.source["worker_id"] {
                    return unavailable(
                        "target-mismatch",
                        "The selected worktree and project replica belong to different workers.",
                    );
                }
                if row.worktree["lifecycle_state"] != "ready" {
                    return unavailable(
                        "worktree-unavailable",
                        "The selected worktree is not ready.",
                    );
                }
                (
                    row.worktree["worker_id"].clone(),
                    Some(string(&row.source, "id")?),
                    Some(string(&row.worktree, "id")?),
                )
            };
            return state
                .worker(
                    &worker,
                    "explicit",
                    source.as_deref(),
                    worktree.as_deref(),
                    true,
                )?
                .context("Explicit placement did not resolve");
        }
        let preferred = if bound {
            vec![(owning.as_deref(), "project-preference")]
        } else {
            vec![
                (
                    snapshot.project["preferred_worker_id"].as_str(),
                    "project-preference",
                ),
                (snapshot.default_worker.as_deref(), "default-worker"),
            ]
        };
        let mut visited = HashSet::new();
        for (worker, selection) in preferred {
            let Some(worker) = worker.filter(|w| !w.is_empty()) else {
                continue;
            };
            if !visited.insert(worker.to_owned()) {
                continue;
            }
            if let Some(result) = state.worker(&value(worker), selection, None, None, bound)? {
                return Ok(result);
            }
        }
        if !bound {
            for worker in &snapshot.workers {
                let id = string(worker, "id")?;
                if !visited.contains(&id)
                    && let Some(result) =
                        state.worker(&worker["id"], "fallback", None, None, false)?
                {
                    return Ok(result);
                }
            }
        }
        unavailable(
            "no-compatible-placement",
            format!("No online worker has a compatible {surface} placement for this project."),
        )
    }
}

struct Selection<'a> {
    snapshot: &'a Snapshot,
    project_id: &'a str,
    surface: &'a str,
    connected: Connected<'a>,
    allow_offline_explicit: bool,
    bound: bool,
    owning: Option<&'a str>,
    collator: &'a CollatorBorrowed<'static>,
}
impl Selection<'_> {
    fn worker(
        &self,
        worker_key: &Value,
        selection: &str,
        source_id: Option<&str>,
        worktree_id: Option<&str>,
        strict: bool,
    ) -> Result<Option<Value>> {
        if self.bound && self.owning.is_some_and(|id| worker_key != &value(id)) {
            return if strict {
                unavailable(
                    "target-mismatch",
                    "This worker-managed folder is bound to its owning worker.",
                )
            } else {
                Ok(None)
            };
        }
        let Some(worker) = self
            .snapshot
            .workers
            .iter()
            .find(|w| &w["id"] == worker_key)
        else {
            return if strict {
                unavailable(
                    "target-not-found",
                    "The selected worker is not linked to this account.",
                )
            } else {
                Ok(None)
            };
        };
        // Match JS Map keys before crossing the UTF-8 boundary. A lone UTF-16
        // surrogate is an unmatched identifier, never a replacement-character ID.
        let worker_id = worker["id"].as_str().context("Persisted worker identity")?;
        let online = self.connected.map_or_else(
            || {
                millis(worker, "last_seen_at")
                    .is_some_and(|seen| chrono::Utc::now().timestamp_millis() - seen <= 30000)
            },
            |f| f(worker_id),
        );
        let name = worker["display_name"]
            .as_str()
            .or_else(|| worker["name"].as_str())
            .context("Placement worker name")?;
        if !(strict && self.allow_offline_explicit || online) {
            return if strict {
                unavailable("worker-offline", format!("Worker {name} is offline."))
            } else {
                Ok(None)
            };
        }
        let supported = match self.surface {
            "browser" => {
                anyhow::ensure!(
                    !worker["remote_surface_capabilities"].is_null(),
                    "Cannot read browser capability from null"
                );
                wire::coercion::truthy(worker["remote_surface_capabilities"].get("browser"))
            }
            "remote-desktop" => {
                anyhow::ensure!(
                    !worker["remote_surface_capabilities"].is_null(),
                    "Cannot read desktop capability from null"
                );
                wire::coercion::truthy(worker["remote_surface_capabilities"].get("desktop"))
            }
            _ => true,
        };
        if !supported {
            return if strict {
                unavailable(
                    "capability-unavailable",
                    format!("Worker {name} does not support {}.", self.surface),
                )
            } else {
                Ok(None)
            };
        }
        let source_id = source_id.filter(|s| !s.is_empty());
        let source = self
            .snapshot
            .replicas
            .iter()
            .find(|r| {
                source_id.map_or(r.source["worker_id"] == worker_id, |id| {
                    r.source["id"] == id
                })
            })
            .map(|r| &r.source);
        if source_id.is_some()
            && (source.is_none() || source.is_some_and(|s| s["worker_id"] != worker_id))
        {
            return if strict {
                unavailable(
                    "target-not-found",
                    "The selected replica is not active on this worker.",
                )
            } else {
                Ok(None)
            };
        }
        let requires_root = self.snapshot.project["origin_kind"] == "managed-folder"
            || matches!(self.surface, "chat" | "terminal" | "explorer" | "code");
        let placement = |source: Value, worktree: Value| {
            Value::object([
                (
                    "placement",
                    Value::object([
                        ("projectId", value(self.project_id)),
                        ("workerId", value(worker_id)),
                        ("projectReplicaId", source),
                        ("worktreeId", worktree),
                        ("surface", Value::Null),
                    ]),
                ),
                ("selection", value(selection)),
            ])
        };
        if !requires_root {
            return Ok(Some(placement(
                source_id.map_or(Value::Null, value),
                worktree_id.map_or(Value::Null, value),
            )));
        }
        let Some(source) = source else {
            return if strict {
                unavailable(
                    "replica-unavailable",
                    if self.bound {
                        "The worker-managed folder has not finished preparing its execution root."
                    } else {
                        "The selected worker does not have an active project replica."
                    },
                )
            } else {
                Ok(None)
            };
        };
        let mut worktrees = self
            .snapshot
            .replicas
            .iter()
            .filter(|r| {
                r.source["id"] == source["id"]
                    && !r.worktree.is_null()
                    && r.worktree["worker_id"] == r.source["worker_id"]
                    && r.worktree["lifecycle_state"] == "ready"
            })
            .map(|r| &r.worktree)
            .collect::<Vec<_>>();
        worktrees.sort_by(|left, right| {
            right["is_default"]
                .as_bool()
                .cmp(&left["is_default"].as_bool())
                .then_with(|| {
                    right["is_primary"]
                        .as_bool()
                        .cmp(&left["is_primary"].as_bool())
                })
                .then_with(
                    || match (millis(left, "created_at"), millis(right, "created_at")) {
                        (Some(l), Some(r)) => l.cmp(&r),
                        _ => std::cmp::Ordering::Equal,
                    },
                )
                .then_with(|| {
                    self.collator.compare_utf16(
                        left["id"].as_js_string().unwrap().units(),
                        right["id"].as_js_string().unwrap().units(),
                    )
                })
        });
        let worktree = worktree_id.filter(|s| !s.is_empty()).map_or_else(
            || worktrees.first().copied(),
            |id| worktrees.iter().find(|w| w["id"] == id).copied(),
        );
        let Some(worktree) = worktree else {
            return if strict {
                unavailable(
                    "worktree-unavailable",
                    if self.bound {
                        "The worker-managed folder execution root is not ready."
                    } else if worktree_id.is_some_and(|s| !s.is_empty()) {
                        "The selected worktree is not ready on this project replica."
                    } else {
                        "The selected project replica has no ready worktree."
                    },
                )
            } else {
                Ok(None)
            };
        };
        Ok(Some(placement(
            source["id"].clone(),
            worktree["id"].clone(),
        )))
    }
}
