use super::{
    LaneError, LaneRepository, branch_leases, conflict, optional, query, raw, required, text,
};
use crate::{
    chats::guard::{self, Access},
    database::{Executor, Transaction},
    wire::{self, Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};

async fn standalone(ex: Executor<'_, '_>, owner: &str, chat: &str) -> Result<bool> {
    let rows = query(
        ex,
        "SELECT context_kind FROM chats WHERE id=$1 AND owner_id=$2 LIMIT 1",
        &[&chat, &owner],
        &[json!(chat), json!(owner)],
    )
    .await?;
    Ok(rows
        .first()
        .map(|row| row.get::<String>(0))
        .transpose()?
        .as_deref()
        == Some("standalone"))
}
fn map_project_error<T>(result: Result<T>) -> Result<T> {
    result.map_err(|error| {
        if error.is::<LaneError>() {
            return error;
        }
        if let Some(lease) = error.downcast_ref::<branch_leases::LeaseError>() {
            return if lease.busy {
                LaneError::Busy(lease.message.clone())
            } else {
                LaneError::Conflict(lease.message.clone())
            }
            .into();
        }
        let message = error.to_string().to_lowercase();
        if message.contains("unique") || message.contains("duplicate") {
            return conflict("The worktree is already leased by another chat.");
        }
        error
    })
}
fn context(
    row: &Value,
    runtime: &Value,
    lane: &Value,
    chat_id: &str,
    standalone: bool,
    at: &str,
) -> Result<Value> {
    let (chat, settings, root) = (&row["chat"], &row["settings"], &row["root"]);
    let model = crate::settings::parse_response(
        "modelConfigurationSchema",
        Some(
            &json!({"modelId":chat["model_id"],"reasoningEffort":chat["reasoning_effort"],"customSubagentModel":chat["custom_subagent_model"],"subagentModelId":chat["subagent_model_id"],"subagentReasoningEffort":chat["subagent_reasoning_effort"]}),
        ),
    )?;
    let default = settings
        .get(if standalone {
            "default_chat_permission_profile_id"
        } else {
            "default_permission_profile_id"
        })
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!(":workspace"));
    let mut context = json!({"contextKind":if standalone{"standalone"}else{"project"},"automationPaused":if standalone{Value::Bool(false)}else{chat["automation_paused"].clone()},"computerUseEnabled":settings["computer_use_enabled"]==true,"computerUseAuthorityGeneration":chat["computer_use_authority_generation"],"chatId":chat_id,"cwd":root[if standalone{"protected_path_handle"}else{"absolute_path"}],"experience":if standalone{json!("agent")}else{chat["experience"].clone()},"defaultPermissionProfileId":default,"executionLaneId":lane["id"],"isPrimary":if standalone{Value::Bool(true)}else{root["is_primary"].clone()},"status":"running","modelId":chat["model_id"],"reasoningEffort":chat["reasoning_effort"],"modelConfiguration":model,"modelRouteId":runtime["model_route_id"],"providerAccountId":runtime["provider_account_id"],"permissionProfileId":chat["permission_profile_id"],"planMode":if standalone{json!("default")}else{chat["plan_mode"].clone()},"projectId":if standalone{Value::Null}else{chat["project_id"].clone()},"rootKind":if standalone{Value::Null}else{root["root_kind"].clone()},"scratchRootId":if standalone{root["id"].clone()}else{Value::Null},"threadId":runtime["codex_thread_id"],"workerId":root["worker_id"],"worktreeId":if standalone{Value::Null}else{root["id"].clone()},"worktreeMode":if standalone{Value::Null}else{chat["worktree_mode"].clone()},"worktreePolicy":if standalone{Value::Null}else{row["project"]["worktree_policy"].clone()}});
    if standalone {
        context["scratchRootStatus"] = json!("ready");
    } else {
        context["executionLaneActivatedAt"] = json!(at);
    }
    Ok(context)
}
async fn start(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    actor: &str,
    purpose: &str,
    standalone: bool,
) -> Result<Option<Value>> {
    let ex = Executor::Transaction(tx);
    if standalone {
        if query(ex,"SELECT id FROM chats WHERE id=$1 AND owner_id=$2 AND context_kind='standalone' AND archived_at IS NULL LIMIT 1 FOR UPDATE",&[&chat,&owner],&[json!(chat),json!(owner)]).await?.is_empty(){return Ok(None);}
    } else {
        query(ex,"WITH locked_project AS MATERIALIZED (SELECT projects.id FROM projects INNER JOIN chats ON chats.project_id=projects.id WHERE projects.owner_id=$1 AND chats.id=$2 FOR UPDATE OF projects) SELECT chats.id FROM locked_project INNER JOIN chats ON chats.project_id=locked_project.id WHERE chats.id=$2 FOR UPDATE OF chats",&[&owner,&chat],&[json!(owner),json!(chat)]).await?;
        guard::assert_runtime_writable(tx, chat, None, None, Access::Write).await?;
    }
    let sql = if standalone {
        "SELECT jsonb_build_object('chat',to_jsonb(c),'root',to_jsonb(root),'runtime',to_jsonb(r),'settings',to_jsonb(s))::text FROM chats c INNER JOIN standalone_chat_roots root ON root.id=c.active_scratch_root_id AND root.chat_id=c.id AND root.owner_id=c.owner_id AND root.worker_id=c.active_worker_id LEFT JOIN chat_runtime_sessions r ON r.chat_id=c.id AND r.worker_id=root.worker_id AND r.scratch_root_id=root.id LEFT JOIN user_settings s ON s.user_id=c.owner_id WHERE c.id=$1 LIMIT 1"
    } else {
        "SELECT jsonb_build_object('chat',to_jsonb(c),'project',to_jsonb(p),'settings',to_jsonb(s),'root',to_jsonb(w),'runtime',to_jsonb(r))::text FROM chats c INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$2 LEFT JOIN user_settings s ON s.user_id=p.owner_id INNER JOIN project_worktrees w ON w.id=c.active_worktree_id LEFT JOIN chat_runtime_sessions r ON r.chat_id=c.id AND r.worker_id=w.worker_id AND r.worktree_id=w.id WHERE c.id=$1 LIMIT 1"
    };
    let rows = if standalone {
        query(ex, sql, &[&chat], &[json!(chat)]).await?
    } else {
        query(ex, sql, &[&chat, &owner], &[json!(chat), json!(owner)]).await?
    };
    let Some(row) = rows.first().map(raw).transpose()? else {
        return Ok(None);
    };
    let (current, root) = (&row["chat"], &row["root"]);
    if standalone {
        if root["status"] != "ready" || !truthy(root.get("protected_path_handle")) {
            return Err(conflict(if root["status"] == "provisioning" {
                "The standalone Chat scratch root is still provisioning."
            } else {
                "The standalone Chat scratch root is unavailable."
            }));
        }
        if matches!(
            current["status"].as_str(),
            Some("running" | "waiting-for-approval")
        ) {
            return Err(conflict("This Chat already has an active execution."));
        }
    } else {
        if !truthy(current.get("project_id")) {
            anyhow::bail!("Project Chat operation received a standalone Chat.");
        }
        if root["lifecycle_state"] != "ready" {
            return Err(conflict(
                "The selected worktree is not ready for execution.",
            ));
        }
        if truthy(current.get("automation_paused")) {
            return Err(conflict(
                "Chat automation is paused. Resume the chat before starting another turn.",
            ));
        }
        if !query(ex,"SELECT id FROM chat_relocation_jobs WHERE chat_id=$1 AND state IN ('queued','waiting-for-idle','validating','preparing-replica','transferring-attachments','hydrating-runtime','ready-to-commit','blocked') LIMIT 1",&[&chat],&[json!(chat)]).await?.is_empty(){return Err(conflict("Chat relocation is active. Cancel it before starting another turn on the source placement."));}
        if !query(ex,"SELECT state FROM chat_import_jobs WHERE chat_id=$1 AND state NOT IN ('succeeded','cancelled') LIMIT 1",&[&chat],&[json!(chat)]).await?.is_empty(){return Err(conflict("This imported chat must finish runtime hydration before it can continue."));}
    }
    let now = crate::auth::now();
    if query(ex,"UPDATE chats SET status='running',updated_at=$1 WHERE id=$2 AND status NOT IN ('running','waiting-for-approval') RETURNING id",&[&now,&chat],&[json!(crate::auth::iso(now)),json!(chat)]).await?.is_empty(){return Err(if standalone{conflict("This Chat already has an active execution.")}else{LaneError::Busy("This chat already has an active execution.".into()).into()});}
    let worker = text(&root["worker_id"])?;
    let placement = text(&root["id"])?;
    let runtime = if !row["runtime"].is_null() {
        row["runtime"].clone()
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        let column = if standalone {
            "scratch_root_id"
        } else {
            "worktree_id"
        };
        let sql = format!(
            "INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,{column}) VALUES($1,$2,$3,$4) RETURNING to_jsonb(chat_runtime_sessions)::text"
        );
        required(
            &query(
                ex,
                &sql,
                &[&id, &chat, &worker, &placement],
                &[json!(id), json!(chat), json!(worker), json!(placement)],
            )
            .await?,
            if standalone {
                "creating a standalone Chat runtime"
            } else {
                "creating an execution runtime"
            },
        )?
    };
    let column = if standalone {
        "scratch_root_id"
    } else {
        "worktree_id"
    };
    let sql = format!(
        "SELECT to_jsonb(l)::text FROM chat_execution_lanes l WHERE chat_id=$1 AND {column}=$2 AND state<>'released' ORDER BY created_at DESC LIMIT 1"
    );
    let existing = query(
        ex,
        &sql,
        &[&chat, &placement],
        &[json!(chat), json!(placement)],
    )
    .await?;
    let existing = existing.first().map(raw).transpose()?;
    let mut millis = crate::auth::now().timestamp_millis();
    if !standalone {
        let previous = if let Some(previous) = existing
            .as_ref()
            .and_then(|l| l.get("activated_at"))
            .filter(|v| !v.is_null())
        {
            wire::date_milliseconds(previous.as_js_string().context("Invalid time value")?)
                .context("Invalid time value")?
        } else {
            0
        };
        millis = millis.max(previous + 1);
    }
    let at = wire::date_iso_milliseconds(millis).context("Invalid time value")?;
    let exclusive = !standalone && root["is_primary"] != true;
    let runtime_id = text(&runtime["id"])?;
    let thread = optional(&runtime["codex_thread_id"])?;
    let lane = if let Some(existing) = existing {
        let id = text(&existing["id"])?;
        required(&query(ex,"UPDATE chat_execution_lanes SET acquiring_actor=$1,exclusive=$2,purpose=$3,state='active',activated_at=$4::text::timestamptz,released_at=NULL,runtime_session_id=$5,codex_thread_id=$6,updated_at=$4::text::timestamptz WHERE id=$7 RETURNING to_jsonb(chat_execution_lanes)::text",&[&actor,&exclusive,&purpose,&at,&runtime_id,&thread,&id],&[json!(actor),json!(exclusive),json!(purpose),json!(at),json!(runtime_id),json!(thread),json!(id)]).await?,if standalone{"activating a standalone Chat execution lane"}else{"activating an execution lane"})?
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        let head = if standalone {
            None
        } else {
            optional(&root["head"])?
        };
        let sql = format!(
            "INSERT INTO chat_execution_lanes(id,chat_id,{column},worker_id,acquiring_actor,exclusive,purpose,state,starting_head,runtime_session_id,codex_thread_id,activated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11::text::timestamptz) RETURNING to_jsonb(chat_execution_lanes)::text"
        );
        required(
            &query(
                ex,
                &sql,
                &[
                    &id,
                    &chat,
                    &placement,
                    &worker,
                    &actor,
                    &exclusive,
                    &purpose,
                    &head,
                    &runtime_id,
                    &thread,
                    &at,
                ],
                &[
                    json!(id),
                    json!(chat),
                    json!(placement),
                    json!(worker),
                    json!(actor),
                    json!(exclusive),
                    json!(purpose),
                    json!(head),
                    json!(runtime_id),
                    json!(thread),
                    json!(at),
                ],
            )
            .await?,
            if standalone {
                "creating a standalone Chat execution lane"
            } else {
                "creating an execution lane"
            },
        )?
    };
    if !standalone {
        branch_leases::acquire(
            tx,
            &text(&current["project_id"])?,
            chat,
            &text(&lane["id"])?,
            root,
        )
        .await?;
    }
    Ok(Some(context(&row, &runtime, &lane, chat, standalone, &at)?))
}
pub async fn start_in_transaction(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    actor: &str,
    purpose: &str,
) -> Result<Option<Value>> {
    let standalone = standalone(Executor::Transaction(tx), owner, chat).await?;
    let (owner, chat, actor, purpose) = (
        owner.to_owned(),
        chat.to_owned(),
        actor.to_owned(),
        purpose.to_owned(),
    );
    let result = super::savepoint(tx, |tx| {
        Box::pin(async move { start(tx, &owner, &chat, &actor, &purpose, standalone).await })
    })
    .await;
    if standalone {
        result
    } else {
        map_project_error(result)
    }
}
impl LaneRepository {
    pub async fn start(
        &self,
        owner: &str,
        chat: &str,
        actor: &str,
        purpose: &str,
    ) -> Result<Option<Value>> {
        let standalone = standalone(Executor::Database(&self.database), owner, chat).await?;
        let (owner, chat, actor, purpose) = (
            owner.to_owned(),
            chat.to_owned(),
            actor.to_owned(),
            purpose.to_owned(),
        );
        let result = self
            .database
            .transaction(|tx| {
                Box::pin(
                    async move { start(tx, &owner, &chat, &actor, &purpose, standalone).await },
                )
            })
            .await;
        if standalone {
            result
        } else {
            map_project_error(result)
        }
    }
}
