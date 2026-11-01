use super::*;
use crate::{
    chats::{managed_console, turn_configuration, turn_storage},
    policies::repository::PolicyRepository,
};
use anyhow::bail;

impl Bootstrap {
    pub(super) fn preflight(
        self: &Arc<Self>,
        owner: String,
        context: Value,
        input: Value,
        options: Value,
        started_at: i64,
        observer: Observer,
    ) -> BoxFuture<'static, Result<PreparedTurn>> {
        let this = self.clone();
        async move {
        let operation = options["structuredResult"]
            .get("taskOperation")
            .filter(|v| truthy(Some(v)));
        let task_relay=operation.map(|v|crate::settings::parse_response("taskOperationRelayRequestSchema",Some(v))).transpose()?
            .map(|operation|json!({"prompt":"Execute the encrypted Cantrip Task operation.","resultMode":json!({"kind":"task-encrypted","operation":operation})}));
        let direct_task_operation =
            operation.is_some_and(|v| v["classification"]["kind"] == "direct");
        let mut encrypted_task = options
            .get("encryptedTaskMessages")
            .filter(|v| !v.is_null())
            .cloned();
        let mut encrypted_chat = options
            .get("encryptedChatMessages")
            .filter(|v| !v.is_null())
            .cloned();
        let task_conversation = context["experience"] == "task" && truthy(encrypted_chat.as_ref());
        if task_conversation {
            let source = encrypted_chat.as_ref().unwrap();
            let reply = this
                .commands
                .request_with_timeout(
                    text(&context, "workerId")?,
                    json!({"type":"task.message.protect","message":source["userMessage"]}),
                    RequestTimeout::Default,
                    None,
                )
                .await?;
            let message =
                crate::settings::parse_response("taskMessageOpaqueContentSchema", reply.as_ref())?;
            if message.get("id") != source["userMessage"].get("id")
                || message.get("idempotencyKey") != source["userMessage"].get("idempotencyKey")
            {
                bail!("The protected Task message belongs to another submission.");
            }
            encrypted_task = Some(json!({"userMessage":message,"response":source["response"]}));
            encrypted_chat = None;
        }
        let (routing, principal, ctx, requested) = (
            this.routing.clone(),
            owner.clone(),
            context.clone(),
            input.get("modelId").cloned(),
        );
        let model_id = observer
            .run("resolve-model", async move {
                routing
                    .resolve_model_id(&principal, &ctx, requested.as_ref())
                    .await
            })
            .await?;
        let configuration =
            turn_configuration::model_configuration(&context, &input, Some(&model_id))?;
        let bound = if truthy(context.get("threadId"))
            && truthy(context.get("modelRouteId"))
            && managed_console::session_context(&context).is_some()
        {
            Some(vec![
                this.routing.bound_managed_runtime(&owner, &context).await?,
            ])
        } else {
            options["runtimes"].as_array().cloned()
        };
        let (routing, principal, ctx, config) = (
            this.routing.clone(),
            owner.clone(),
            context.clone(),
            configuration["turnModelConfiguration"].clone(),
        );
        let route_pairs = observer
            .run("resolve-model-routes", async move {
                routing
                    .route_pairs(&principal, &ctx, &config, bound.as_deref())
                    .await
            })
            .await?;
        let (chats, principal, ctx, ids) = (
            this.chats.clone(),
            owner.clone(),
            context.clone(),
            input
                .get("attachmentIds")
                .filter(|v| !v.is_null()).cloned()
                .unwrap_or_else(|| json!(Vec::<Value>::new())),
        );
        let attachments = observer
            .run("resolve-attachments", async move {
                chats.prompt_attachments(&principal, &ctx, &ids).await
            })
            .await?;
        let turn_mode = nullish(input.get("mode"), json!("default"));
        let turn_plan_mode = json!(if turn_mode == "plan" {
            "plan"
        } else {
            "default"
        });
        if context["experience"] == "agent"
            && encrypted_chat.is_none()
            && !truthy(options.get("structuredResult"))
        {
            let mut protected_input = input.clone();
            protected_input["mode"] = turn_mode.clone();
            let message = this
                .protection
                .protect(
                    text(&context, "workerId")?,
                    &protected_input,
                    &attachments
                        .iter()
                        .map(turn_storage::attachment_summary)
                        .collect::<Vec<_>>(),
                    configuration.get("requestedReasoningEffort"),
                    Some(&nullish(options.get("messageRole"), json!("user"))),
                )
                .await?;
            let response = json!({"id":uuid::Uuid::new_v4().to_string(),"idempotencyKey":format!("assistant:{}",text(&message,"id")?)});
            encrypted_chat = Some(json!({"userMessage":message,"response":response}));
        }
        let (database, principal, ctx) = (this.database.clone(), owner.clone(), context.clone());
        let (effective_policies, standalone_policies) = observer
            .run("resolve-effective-policies", async move {
                let policies = PolicyRepository::new(database);
                let effective = if ctx["contextKind"] == "project" {
                    policies
                        .resolve_effective(&principal, text(&ctx, "projectId")?)
                        .await?
                        .as_ref()
                        .map(Value::from_serialize)
                } else {
                    Some(json!({"policies":Vec::<Value>::new()}))
                };
                let standalone = if ctx["contextKind"] == "standalone" {
                    Value::from_serialize(&policies.resolve_standalone(&principal).await?)
                } else {
                    json!({"policies":Vec::<Value>::new()})
                };
                Ok((effective, standalone))
            })
            .await?;
        if context["contextKind"] == "project" && effective_policies.is_none() {
            bail!("The chat project is no longer available.");
        }
        let mcp_servers = if truthy(options.get("structuredResult")) && !direct_task_operation {
            Vec::new()
        } else {
            let (chats, principal, ctx) = (this.chats.clone(), owner.clone(), context.clone());
            observer
                .run("resolve-mcp-servers", async move {
                    chats
                        .effective_mcp_servers(
                            &principal,
                            if ctx["contextKind"] == "project" {
                                ctx["projectId"].as_str()
                            } else {
                                None
                            },
                            text(&ctx, "workerId")?,
                            if ctx["contextKind"] == "project" {
                                "ide"
                            } else {
                                "chat"
                            },
                        )
                        .await
                })
                .await?
        };
        if let Some(lease) = options.get("taskDispatchLease").filter(|v| truthy(Some(v))) {
            let mut update = Value::object([] as [(&str, Value); 0]);
            if context["experience"] == "task"
                && truthy(context.get("worktreeId"))
                && truthy(context.get("threadId"))
            {
                update["affinity"] = json!({"worktreeId":context["worktreeId"],"threadId":context["threadId"],"modelRouteId":context["modelRouteId"],"providerAccountId":context["providerAccountId"]});
            }
            let (database, lease) = (this.database.clone(), lease.clone());
            observer
                .run("mark-dispatch-running", async move {
                    crate::task_dispatch::Repository::new(database)
                        .mark_running(&lease, &update)
                        .await
                })
                .await?;
        }
        Ok(PreparedTurn {
            owner,
            input,
            options,
            started_at,
            observer,
            execution: context,
            native_receipt: None,
            model_id,
            requested_reasoning: configuration.get("requestedReasoningEffort").cloned(),
            route_pairs,
            attachments,
            encrypted_chat,
            encrypted_task,
            task_relay,
            task_conversation,
            direct_task_operation,
            turn_mode,
            turn_plan_mode,
            effective_policies: effective_policies.unwrap_or(Value::Null),
            standalone_policies,
            mcp_servers,
            attribution: Value::Null,
            protected_history: Vec::new(),
            protected_plan: None,
            user_message: Value::Null,
            immediate_corrective_followup: false,
            attributed_worker: None,
        })
        }.boxed()
    }
}
