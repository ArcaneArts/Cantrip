//! Native execution-target descriptors. Protected surface labels remain opaque.
use crate::{
    projects::placement::{self, Connected},
    wire::{Value, coercion},
};
use anyhow::{Context, Result};
use std::collections::HashSet;

fn text(s: &str) -> Value {
    Value::String(s.into())
}
fn copy(v: &Value, key: &str) -> Value {
    v.get(key).cloned().unwrap_or(Value::Null)
}
fn rows<'a>(input: &'a Value, key: &str) -> Result<&'a [Value]> {
    input[key]
        .as_array()
        .map(Vec::as_slice)
        .with_context(|| format!("Execution catalog {key}"))
}
fn requested(input: &Value, kind: &str) -> bool {
    input
        .get("resourceKinds")
        .filter(|v| coercion::truthy(Some(v)))
        .is_none_or(|v| {
            v.as_array()
                .is_some_and(|kinds| kinds.iter().any(|k| k == kind))
        })
}
fn place(project: &Value, worker: Value, replica: Value, worktree: Value, surface: Value) -> Value {
    Value::object([
        ("projectId", project.clone()),
        ("workerId", worker),
        ("projectReplicaId", replica),
        ("worktreeId", worktree),
        ("surface", surface),
    ])
}
fn surface(kind: &str, id: &Value) -> Value {
    Value::object([("kind", text(kind)), ("id", id.clone())])
}
fn target(project: &Value, kind: &str, key: &str, id: &Value) -> Value {
    Value::object([
        ("kind", text(kind)),
        ("projectId", project.clone()),
        (key, id.clone()),
    ])
}
fn surface_target(project: &Value, kind: &str, id: &Value) -> Value {
    Value::object([
        ("kind", text("surface")),
        ("projectId", project.clone()),
        ("surfaceKind", text(kind)),
        ("surfaceId", id.clone()),
    ])
}
pub(super) fn availability(
    worker: &Value,
    capability: Option<&str>,
    connected: Connected<'_>,
) -> Result<Value> {
    let online = coercion::truthy(worker.get("online"))
        && connected.is_none_or(|f| worker["workerId"].as_str().is_some_and(f));
    let name = worker["name"]
        .as_str()
        .context("Execution target worker name")?;
    if online && capability.is_some() {
        anyhow::ensure!(
            !worker["remoteSurfaces"].is_null(),
            "Cannot read remote capability from null"
        );
    }
    let (kind, reason) = if !online {
        ("worker-offline", Some(format!("Worker {name} is offline.")))
    } else if capability.is_some_and(|kind| !coercion::truthy(worker["remoteSurfaces"].get(kind))) {
        (
            "capability-unavailable",
            Some(format!(
                "Worker {name} does not support {}.",
                capability.unwrap()
            )),
        )
    } else {
        ("available", None)
    };
    Ok(Value::object([
        ("availability", text(kind)),
        ("online", Value::Bool(online)),
        (
            "unavailableReason",
            reason.map_or(Value::Null, |v| text(&v)),
        ),
    ]))
}
struct Candidate {
    placement: Value,
    target: Value,
    kind: &'static str,
    status: Value,
    title: Value,
    protection: Value,
    capability: Option<&'static str>,
    unavailable: Option<String>,
}
impl Candidate {
    fn new(placement: Value, target: Value, kind: &'static str, status: Value) -> Self {
        Self {
            placement,
            target,
            kind,
            status,
            title: Value::Null,
            protection: Value::Null,
            capability: None,
            unavailable: None,
        }
    }
}
struct Builder<'a> {
    input: &'a Value,
    connected: Connected<'a>,
    descriptors: Vec<Value>,
}
impl Builder<'_> {
    fn append(&mut self, candidate: Candidate) -> Result<()> {
        if self
            .input
            .get("resourceKinds")
            .filter(|v| coercion::truthy(Some(v)))
            .is_some_and(|v| {
                v.as_array()
                    .is_some_and(|kinds| !kinds.iter().any(|k| k == candidate.kind))
            })
        {
            return Ok(());
        }
        let Some(worker) = rows(self.input, "workers")?
            .iter()
            .rev()
            .find(|w| w["workerId"] == candidate.placement["workerId"])
        else {
            return Ok(());
        };
        let mut available = availability(worker, candidate.capability, self.connected)?;
        if available["availability"] == "available"
            && candidate
                .unavailable
                .as_ref()
                .is_some_and(|s| !s.is_empty())
        {
            available["availability"] = text("resource-unavailable");
            available["online"] = Value::Bool(true);
            available["unavailableReason"] = text(candidate.unavailable.as_ref().unwrap());
        }
        self.descriptors.push(Value::object([
            ("target", candidate.target),
            ("placement", candidate.placement),
            ("resourceKind", text(candidate.kind)),
            ("title", candidate.title),
            ("titleProtection", candidate.protection),
            ("status", candidate.status),
            (
                "worker",
                Value::object([
                    ("workerId", copy(worker, "workerId")),
                    ("name", copy(worker, "name")),
                    ("online", copy(&available, "online")),
                ]),
            ),
            ("availability", copy(&available, "availability")),
            ("unavailableReason", copy(&available, "unavailableReason")),
        ]));
        Ok(())
    }
    fn worktree_surface(
        &mut self,
        row: &Value,
        kind: &'static str,
        worktree_key: &str,
        status: Value,
    ) -> Result<()> {
        let Some(tree) = rows(self.input, "worktrees")?
            .iter()
            .rev()
            .find(|w| w["id"] == row[worktree_key])
        else {
            return Ok(());
        };
        let worker = row
            .get("activeWorkerId")
            .filter(|v| !v.is_null())
            .unwrap_or(&tree["workerId"]);
        if !coercion::truthy(Some(worker)) || *worker != tree["workerId"] {
            return Ok(());
        }
        let mut candidate = Candidate::new(
            place(
                &self.input["projectId"],
                worker.clone(),
                copy(tree, "projectSourceId"),
                copy(tree, "id"),
                surface(kind, &row["id"]),
            ),
            surface_target(&self.input["projectId"], kind, &row["id"]),
            kind,
            status,
        );
        candidate.protection = copy(row, "titleProtection");
        if tree["lifecycleState"] != "ready" {
            candidate.unavailable = Some(format!(
                "Worktree {} is {}.",
                tree["name"].as_str().context("Worktree name")?,
                tree["lifecycleState"].as_str().context("Worktree state")?
            ));
        }
        self.append(candidate)
    }
}
pub fn build(input: &Value, connected: Connected<'_>) -> Result<Value> {
    let project = &input["projectId"];
    let mut builder = Builder {
        input,
        connected,
        descriptors: Vec::new(),
    };
    for worker in rows(input, "workers")?
        .iter()
        .filter(|_| requested(input, "worker"))
    {
        let replica = rows(input, "replicas")?
            .iter()
            .find(|r| r["workerId"] == worker["workerId"]);
        let primary = replica.and_then(|r| {
            rows(input, "worktrees").ok()?.iter().find(|w| {
                w["id"] == r["primaryWorktreeId"]
                    && w["projectSourceId"] == r["id"]
                    && w["workerId"] == worker["workerId"]
                    && w["lifecycleState"] == "ready"
            })
        });
        let online = coercion::truthy(worker.get("online"))
            && connected.is_none_or(|f| worker["workerId"].as_str().is_some_and(f));
        let mut candidate = Candidate::new(
            place(
                project,
                copy(worker, "workerId"),
                replica.map_or(Value::Null, |r| copy(r, "id")),
                primary.map_or(Value::Null, |w| copy(w, "id")),
                Value::Null,
            ),
            target(project, "worker", "workerId", &worker["workerId"]),
            "worker",
            text(if online { "online" } else { "offline" }),
        );
        candidate.title = copy(worker, "name");
        builder.append(candidate)?;
    }
    for replica in rows(input, "replicas")?
        .iter()
        .filter(|_| requested(input, "replica"))
    {
        let primary = rows(input, "worktrees")?.iter().find(|w| {
            w["id"] == replica["primaryWorktreeId"]
                && w["projectSourceId"] == replica["id"]
                && w["workerId"] == replica["workerId"]
                && w["lifecycleState"] == "ready"
        });
        let ready = coercion::truthy(replica.get("ready"));
        let name = replica["workerName"]
            .as_str()
            .context("Replica worker name")?;
        let mut candidate = Candidate::new(
            place(
                project,
                copy(replica, "workerId"),
                copy(replica, "id"),
                primary.map_or(Value::Null, |w| copy(w, "id")),
                Value::Null,
            ),
            target(project, "replica", "projectReplicaId", &replica["id"]),
            "replica",
            text(if ready { "ready" } else { "not ready" }),
        );
        candidate.title = text(&format!("{name} project replica"));
        if !ready || primary.is_none() {
            candidate.unavailable = Some(format!("The project replica on {name} is not ready."));
        }
        builder.append(candidate)?;
    }
    for tree in rows(input, "worktrees")?
        .iter()
        .filter(|_| requested(input, "worktree"))
    {
        let mut candidate = Candidate::new(
            place(
                project,
                copy(tree, "workerId"),
                copy(tree, "projectSourceId"),
                copy(tree, "id"),
                Value::Null,
            ),
            target(project, "worktree", "worktreeId", &tree["id"]),
            "worktree",
            copy(tree, "lifecycleState"),
        );
        candidate.title = copy(tree, "name");
        if tree["lifecycleState"] != "ready" {
            candidate.unavailable = Some(format!(
                "Worktree {} is {}.",
                tree["name"].as_str().context("Worktree name")?,
                tree["lifecycleState"].as_str().context("Worktree state")?
            ));
        }
        builder.append(candidate)?;
    }
    for row in rows(input, "chats")? {
        builder.worktree_surface(row, "chat", "activeWorktreeId", copy(row, "status"))?;
    }
    for row in rows(input, "terminals")? {
        if row["kind"] != "run-configuration" {
            builder.worktree_surface(row, "terminal", "worktreeId", copy(row, "status"))?;
        }
    }
    for (key, kind) in [("explorers", "explorer"), ("codeTabs", "code")] {
        for row in rows(input, key)? {
            builder.worktree_surface(row, kind, "worktreeId", Value::Null)?;
        }
    }
    let mut represented = HashSet::new();
    for browser in rows(input, "browsers")? {
        let remote = rows(input, "remoteSurfaces")?
            .iter()
            .find(|r| r["id"] == browser["id"]);
        let worker = browser
            .get("workerId")
            .filter(|v| !v.is_null())
            .or_else(|| remote.and_then(|r| r.get("workerId")));
        let Some(worker) = worker.filter(|v| coercion::truthy(Some(v))) else {
            continue;
        };
        represented.insert(browser["id"].stringify());
        let mut candidate = Candidate::new(
            place(
                project,
                worker.clone(),
                Value::Null,
                Value::Null,
                surface("browser", &browser["id"]),
            ),
            surface_target(project, "browser", &browser["id"]),
            "browser",
            remote.map_or(Value::Null, |r| copy(r, "status")),
        );
        candidate.capability = Some("browser");
        candidate.protection = copy(browser, "titleProtection");
        builder.append(candidate)?;
    }
    for desktop in rows(input, "desktops")? {
        represented.insert(desktop["id"].stringify());
        let mut candidate = Candidate::new(
            place(
                project,
                copy(desktop, "workerId"),
                Value::Null,
                Value::Null,
                surface("remote-desktop", &desktop["id"]),
            ),
            surface_target(project, "remote-desktop", &desktop["id"]),
            "remote-desktop",
            copy(desktop, "status"),
        );
        candidate.capability = Some("desktop");
        candidate.protection = copy(desktop, "titleProtection");
        builder.append(candidate)?;
    }
    for remote in rows(input, "remoteSurfaces")? {
        if represented.contains(&remote["id"].stringify()) {
            continue;
        }
        let mut candidate = Candidate::new(
            place(
                project,
                copy(remote, "workerId"),
                Value::Null,
                Value::Null,
                surface("remote-surface", &remote["id"]),
            ),
            surface_target(project, "remote-surface", &remote["id"]),
            "remote-surface",
            copy(remote, "status"),
        );
        candidate.capability = Some(if remote["kind"] == "browser" {
            "browser"
        } else {
            "desktop"
        });
        candidate.protection = copy(remote, "titleProtection");
        builder.append(candidate)?;
    }
    let collator = placement::collator()?;
    builder.descriptors.sort_by(|l, r| {
        collator
            .compare_utf16(
                l["resourceKind"].as_js_string().unwrap().units(),
                r["resourceKind"].as_js_string().unwrap().units(),
            )
            .then_with(|| {
                collator.compare_utf16(
                    &l["target"].stringify().encode_utf16().collect::<Vec<_>>(),
                    &r["target"].stringify().encode_utf16().collect::<Vec<_>>(),
                )
            })
    });
    let maximum = input
        .get("maximumTargets")
        .cloned()
        .unwrap_or(Value::Number(2000.0));
    let truncated;
    if maximum.is_null() {
        truncated = false;
    } else {
        let n = coercion::number(Some(&maximum))
            .map_err(|()| anyhow::anyhow!("Invalid target limit"))?;
        let len = builder.descriptors.len();
        truncated = (len as f64) > n;
        let end = if n.is_nan() {
            0
        } else if n.trunc() < 0.0 {
            ((len as f64) + n.trunc()).clamp(0.0, len as f64) as usize
        } else {
            n.trunc().min(len as f64) as usize
        };
        builder.descriptors.truncate(end);
    }
    Ok(Value::object([
        ("projectId", project.clone()),
        ("targets", Value::Array(builder.descriptors)),
        ("truncated", Value::Bool(truncated)),
    ]))
}
