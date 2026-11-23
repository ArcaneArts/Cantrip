//! Narrow CLI selectors preserve the Source repository's lookup phases.
use super::{
    TargetRepository, catalog,
    reads::Kind,
    selector_queries::{self, Identity},
};
use crate::{
    cli::selectors,
    projects::{
        placement::{self, Connected},
        repository::ProjectRepository,
    },
    wire::{JsString, Value, value::json},
};
use anyhow::{Context, Result};
use futures::FutureExt;

struct Scope {
    bound: bool,
    local_git: bool,
    owning: Option<String>,
    eligible: Vec<String>,
}
impl Scope {
    fn allows(&self, id: &Value) -> bool {
        if self.bound {
            self.owning.as_deref() == id.as_str()
        } else {
            !self.local_git || self.eligible.iter().any(|worker| id == worker.as_str())
        }
    }
}
impl TargetRepository {
    async fn selector_scope(&self, owner: &str, project: &str) -> Result<Option<Scope>> {
        let result=self.database.query("SELECT p.git_capability,w.lifecycle_state,p.origin_kind,p.preferred_worker_id,s.worker_id FROM projects p LEFT JOIN project_sources s ON s.project_id=p.id AND s.removed_at IS NULL LEFT JOIN project_worktrees w ON w.project_source_id=s.id AND w.is_primary=true WHERE p.id=$1 AND p.owner_id=$2 ORDER BY coalesce(w.lifecycle_state='ready',false) DESC,s.created_at ASC,s.id ASC",&[&project,&owner]).await;
        let rows = selector_queries::context(
            result,
            "scope",
            Identity {
                owner,
                project,
                selector: None,
                owning: None,
                eligible: &[],
            },
        )?;
        let Some(first) = rows.first() else {
            return Ok(None);
        };
        let managed = first.get::<String>(2)? == "managed-folder";
        let git = first.get::<bool>(0)?;
        let mut eligible = Vec::new();
        for row in &rows {
            if row.get::<Option<String>>(1)?.as_deref() == Some("ready")
                && let Some(id) = row.get::<Option<String>>(4)?
                && !id.is_empty()
                && !eligible.contains(&id)
            {
                eligible.push(id);
            }
        }
        Ok(Some(Scope {
            bound: managed && !git,
            local_git: managed && git,
            owning: first
                .get::<Option<String>>(3)?
                .or(first.get::<Option<String>>(4)?),
            eligible,
        }))
    }
    async fn exact_cli_surface(
        &self,
        owner: &str,
        project: &str,
        kind: &str,
        id: &JsString,
    ) -> Result<Option<Value>> {
        let encoded = id.lossy();
        let (sql, _browser) = if kind == "browser" {
            ("SELECT p.git_capability,p.origin_kind,p.preferred_worker_id,r.worker_id,exists(SELECT 1 FROM project_sources s INNER JOIN project_worktrees w ON w.project_source_id=s.id AND w.is_primary=true AND w.lifecycle_state='ready' WHERE s.project_id=p.id AND s.worker_id=r.worker_id AND s.removed_at IS NULL) FROM browsers b INNER JOIN projects p ON p.id=b.project_id AND p.owner_id=$1 INNER JOIN remote_surfaces r ON r.id=b.id AND r.project_id=p.id AND r.kind='browser' INNER JOIN workers k ON k.id=r.worker_id AND k.owner_id=$1 AND k.unlinked_at IS NULL WHERE b.id=$3 AND b.project_id=$2 LIMIT 1".to_owned(), true)
        } else {
            let table = if kind == "explorer" {
                "explorers"
            } else {
                "terminals"
            };
            (
                format!(
                    "SELECT p.git_capability,p.origin_kind,p.preferred_worker_id,r.active_worker_id,true FROM {table} r INNER JOIN projects p ON p.id=r.project_id AND p.owner_id=$1 INNER JOIN project_worktrees w ON w.id=r.worktree_id AND w.worker_id=r.active_worker_id INNER JOIN project_sources s ON s.id=w.project_source_id AND s.project_id=p.id AND s.removed_at IS NULL INNER JOIN workers k ON k.id=r.active_worker_id AND k.owner_id=$1 AND k.unlinked_at IS NULL WHERE r.id=$3 AND r.project_id=$2{} LIMIT 1",
                    if kind == "terminal" {
                        " AND r.kind<>'run-configuration'"
                    } else {
                        ""
                    }
                ),
                false,
            )
        };
        let rows = selector_queries::context(
            self.database
                .query(&sql, &[&owner, &project, &encoded.as_ref()])
                .await,
            &format!("exact-{kind}"),
            Identity {
                owner,
                project,
                selector: Some(id),
                owning: None,
                eligible: &[],
            },
        )?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let managed = row.get::<String>(1)? == "managed-folder";
        let git = row.get::<bool>(0)?;
        let worker = row.get::<String>(3)?;
        let allowed = if managed && git {
            row.get::<bool>(4)?
        } else if managed {
            let owning = if let Some(preferred) = row.get::<Option<String>>(2)? {
                Some(preferred)
            } else {
                self.selector_scope(owner, project)
                    .await?
                    .and_then(|s| s.owning)
            };
            owning.as_deref() == Some(&worker)
        } else {
            true
        };
        Ok(allowed.then(||json!({"outcome":"selected","target":json!({"kind":"surface","projectId":project,"surfaceKind":kind,"surfaceId":Value::String(id.clone())})})))
    }
    async fn cli_candidates(
        &self,
        owner: &str,
        project: &str,
        scope: &Scope,
        selector: &JsString,
        exact: bool,
    ) -> Result<Vec<Value>> {
        // Protected titles are never opened. Only public worker/worktree labels
        // participate in SQL filtering, with JS fallback for non-ASCII labels.
        let match_id = |id: &str| {
            if exact {
                format!("{id}=$3")
            } else {
                format!("starts_with({id},$3)")
            }
        };
        let plaintext = |id: &str, title: &str| {
            let title_filter = if selector.units().iter().any(|u| *u > 127) {
                "true".to_owned()
            } else {
                format!(
                    "length({title})<>octet_length({title}) OR {}",
                    if exact {
                        format!("lower({title})=$4")
                    } else {
                        format!("strpos(lower({title}),$4)>0")
                    }
                )
            };
            format!("({} OR ({title_filter}))", match_id(id))
        };
        let allowed = if scope.bound {
            "k.id=$5"
        } else if scope.local_git {
            "k.id=ANY($6::text[])"
        } else {
            "true"
        };
        let excluded = if scope.bound { "false" } else { "true" };
        let title = "coalesce(k.display_name,k.name)";
        let mut queries = vec![
            format!(
                "SELECT k.id,'worker'::text AS resource_kind,null::text AS surface_kind,{title} AS title FROM workers k WHERE k.owner_id=$1 AND k.unlinked_at IS NULL AND {allowed} AND {}",
                plaintext("k.id", title)
            ),
            format!(
                "SELECT s.id,'replica'::text,null::text,{title} || ' project replica' FROM project_sources s INNER JOIN workers k ON k.id=s.worker_id AND k.owner_id=$1 AND k.unlinked_at IS NULL WHERE s.project_id=$2 AND s.removed_at IS NULL AND {excluded} AND {}",
                plaintext("s.id", &format!("{title} || ' project replica'"))
            ),
            format!(
                "SELECT w.id,'worktree'::text,null::text,w.name FROM project_worktrees w INNER JOIN project_sources s ON s.id=w.project_source_id AND s.project_id=$2 AND s.removed_at IS NULL INNER JOIN workers k ON k.id=w.worker_id AND k.owner_id=$1 AND k.unlinked_at IS NULL WHERE {excluded} AND {}",
                plaintext("w.id", "w.name")
            ),
        ];
        for (table, kind, tree, active, extra) in [
            (
                "chats",
                "chat",
                "active_worktree_id",
                "(r.active_worker_id IS NULL OR w.worker_id=r.active_worker_id)",
                " AND r.archived_at IS NULL",
            ),
            (
                "terminals",
                "terminal",
                "worktree_id",
                "w.worker_id=r.active_worker_id",
                " AND r.kind<>'run-configuration'",
            ),
            (
                "explorers",
                "explorer",
                "worktree_id",
                "w.worker_id=r.active_worker_id",
                "",
            ),
            (
                "code_tabs",
                "code",
                "worktree_id",
                "w.worker_id=r.active_worker_id",
                "",
            ),
        ] {
            queries.push(format!("SELECT r.id,'{kind}'::text,'{kind}'::text,null::text FROM {table} r INNER JOIN project_worktrees w ON w.id=r.{tree} AND {active} INNER JOIN project_sources s ON s.id=w.project_source_id AND s.project_id=$2 AND s.removed_at IS NULL INNER JOIN workers k ON k.id=w.worker_id AND k.owner_id=$1 AND k.unlinked_at IS NULL WHERE r.project_id=$2 AND {allowed} AND {}{extra}",match_id("r.id")));
        }
        for (table, kind, join_kind, extra) in [
            ("browsers", "browser", "browser", ""),
            (
                "project_views",
                "remote-desktop",
                "desktop",
                " AND r.kind='remote-desktop'",
            ),
        ] {
            queries.push(format!("SELECT r.id,'{kind}'::text,'{kind}'::text,null::text FROM {table} r INNER JOIN remote_surfaces x ON x.id=r.id AND x.project_id=$2 AND x.kind='{join_kind}' INNER JOIN workers k ON k.id=x.worker_id AND k.owner_id=$1 AND k.unlinked_at IS NULL WHERE r.project_id=$2 AND {allowed} AND {}{extra}",match_id("r.id")));
        }
        queries.push(format!("SELECT x.id,'remote-surface'::text,'remote-surface'::text,null::text FROM remote_surfaces x INNER JOIN workers k ON k.id=x.worker_id AND k.owner_id=$1 AND k.unlinked_at IS NULL WHERE x.project_id=$2 AND {allowed} AND {} AND NOT EXISTS(SELECT 1 FROM browsers b WHERE b.id=x.id) AND NOT EXISTS(SELECT 1 FROM project_views v WHERE v.id=x.id AND v.kind='remote-desktop' AND x.kind='desktop')",match_id("x.id")));
        // Give every bound slot its SQL type, including slots unused by this
        // scope variant. This CTE does not filter or gate candidate execution.
        let sql = format!(
            "WITH cli_parameters AS (SELECT $1::text,$2::text,$3::text,$4::text,$5::text,$6::text[]) SELECT * FROM ({}) candidates",
            queries.join(" UNION ALL ")
        );
        let selector_utf8 = selector.lossy();
        let lower = selector.lowercase().lossy().into_owned();
        let owning = scope.owning.as_deref().unwrap_or("");
        let result = self
            .database
            .query(
                &sql,
                &[
                    &owner,
                    &project,
                    &selector_utf8.as_ref(),
                    &lower,
                    &owning,
                    &scope.eligible,
                ],
            )
            .await;
        let scope_kind = if scope.bound {
            "bound"
        } else if scope.local_git {
            if scope.eligible.is_empty() {
                "local-empty"
            } else {
                "local-ready"
            }
        } else {
            "any"
        };
        let key = format!(
            "{scope_kind}-{}-{}",
            if selector.units().iter().any(|unit| *unit > 127) {
                "unicode"
            } else {
                "ascii"
            },
            if exact { "exact" } else { "partial" }
        );
        let rows = selector_queries::context(
            result,
            &key,
            Identity {
                owner,
                project,
                selector: Some(selector),
                owning: scope.owning.as_deref(),
                eligible: &scope.eligible,
            },
        )?;
        let mut candidates=rows.iter().map(|row| {
            let id=row.get::<String>(0)?;let kind=row.get::<String>(1)?;
            let target=match kind.as_str() {
                "worker"=>json!({"kind":"worker","projectId":project,"workerId":id}),
                "replica"=>json!({"kind":"replica","projectId":project,"projectReplicaId":id}),
                "worktree"=>json!({"kind":"worktree","projectId":project,"worktreeId":id}),
                _=>json!({"kind":"surface","projectId":project,"surfaceKind":row.get::<Option<String>>(2)?,"surfaceId":id}),
            };
            Ok(json!({"resourceKind":kind,"target":target,"title":row.get::<Option<String>>(3)?}))
        }).collect::<Result<Vec<_>>>()?;
        let collator = placement::collator()?;
        candidates.sort_by(|l, r| {
            collator
                .compare_utf16(
                    l["resourceKind"].as_js_string().unwrap().units(),
                    r["resourceKind"].as_js_string().unwrap().units(),
                )
                .then_with(|| {
                    collator.compare_utf16(
                        selectors::target_id(&l["target"])
                            .unwrap()
                            .as_js_string()
                            .unwrap()
                            .units(),
                        selectors::target_id(&r["target"])
                            .unwrap()
                            .as_js_string()
                            .unwrap()
                            .units(),
                    )
                })
        });
        Ok(candidates)
    }
    async fn focused_cli_catalog(
        &self,
        owner: &str,
        project: &str,
        kind: &str,
        connected: Connected<'_>,
    ) -> Result<Option<Value>> {
        let reads = self.reads();
        let projects = ProjectRepository::new(self.database.clone())?;
        // Source starts only this kind's collaborators. A bad unrelated Chat or
        // Browser record must not prevent a focused Terminal lookup.
        let resources = async {
            match kind {
                "browser" => reads.resources(Kind::Browser, owner, project).await,
                "explorer" => reads.resources(Kind::Explorer, owner, project).await,
                "terminal" => reads.resources(Kind::Terminal, owner, project).await,
                _ => Ok(Vec::new()),
            }
        };
        let trees = async {
            if kind == "browser" {
                Ok(Vec::new())
            } else {
                reads.worktrees(owner, project).await
            }
        };
        let replicas = async {
            if kind == "worker" {
                projects.replicas(owner, project).await
            } else {
                Ok(Some(Vec::new()))
            }
        };
        let (scope, workers, resources, trees, replicas) = tokio::try_join!(
            self.selector_scope(owner, project).boxed(),
            reads.workers(owner).boxed(),
            resources.boxed(),
            trees.boxed(),
            replicas.boxed()
        )?;
        let (Some(scope), Some(replicas)) = (scope, replicas) else {
            return Ok(None);
        };
        let workers = workers
            .into_iter()
            .filter(|worker| scope.allows(&worker["workerId"]))
            .collect::<Vec<_>>();
        let mut input = json!({"projectId":project,"resourceKinds":vec![kind],"maximumTargets":Value::Null,"workers":workers,"replicas":replicas,"worktrees":trees,"chats":Vec::<Value>::new(),"terminals":Vec::<Value>::new(),"explorers":Vec::<Value>::new(),"codeTabs":Vec::<Value>::new(),"browsers":Vec::<Value>::new(),"desktops":Vec::<Value>::new(),"remoteSurfaces":Vec::<Value>::new()});
        if let Some(key) = match kind {
            "browser" => Some("browsers"),
            "explorer" => Some("explorers"),
            "terminal" => Some("terminals"),
            _ => None,
        } {
            input[key] = Value::Array(resources);
        }
        let mut result = catalog::build(&input, connected)?;
        if scope.bound && kind == "worktree" {
            result["targets"] = json!(Vec::<Value>::new());
        }
        Ok(Some(result))
    }
    pub async fn select_cli(
        &self,
        owner: &str,
        project: &str,
        kind: Option<&str>,
        selector: Option<&JsString>,
        context: &Value,
        connected: Connected<'_>,
    ) -> Result<Option<Value>> {
        if let (Some(kind @ ("browser" | "explorer" | "terminal")), Some(selector)) =
            (kind, selector)
        {
            if let Some(exact) = self
                .exact_cli_surface(owner, project, kind, selector)
                .await?
            {
                return Ok(Some(exact));
            }
        } else if selector.is_none()
            && kind == Some("terminal")
            && let Some(id) = context["terminalId"].as_js_string()
        {
            if let Some(exact) = self
                .exact_cli_surface(owner, project, "terminal", id)
                .await?
            {
                return Ok(Some(exact));
            }
        } else if selector.is_none() && kind == Some("worker") {
            let reads = self.reads();
            let (scope, worker) = tokio::try_join!(
                self.selector_scope(owner, project),
                reads.worker(owner, &context["workerId"])
            )?;
            let Some(scope) = scope else { return Ok(None) };
            if (scope.bound || scope.local_git) && scope.allows(&context["workerId"]) {
                return Ok(Some(
                    if let Some(worker) = worker
                        && catalog::availability(&worker, None, connected)?["availability"]
                            == "available"
                    {
                        json!({"outcome":"selected","target":json!({"kind":"worker","projectId":project,"workerId":context["workerId"]})})
                    } else {
                        json!({"outcome":"unavailable"})
                    },
                ));
            }
        }
        if kind.is_none()
            && let Some(selector) = selector
        {
            let Some(scope) = self.selector_scope(owner, project).await? else {
                return Ok(None);
            };
            let exact = self
                .cli_candidates(owner, project, &scope, selector, true)
                .await?;
            if let Some(selected) = selectors::target_exact(&exact, selector)? {
                return Ok(Some(selected));
            }
            return Ok(Some(selectors::target_explicit(
                &self
                    .cli_candidates(owner, project, &scope, selector, false)
                    .await?,
                selector,
            )?));
        }
        let catalog = if let Some(kind) = kind {
            self.focused_cli_catalog(owner, project, kind, connected)
                .await?
        } else {
            self.catalog(owner, project, connected).await?
        };
        catalog.map(|catalog|selectors::target_default(catalog["targets"].as_array().context("CLI target catalog")?,&json!({"currentTerminalId":context["terminalId"],"currentWorkerId":context["workerId"],"currentWorktreeId":context["worktreeId"],"resourceKind":kind,"selector":selector.cloned().map(Value::String)}))).transpose()
    }
}
