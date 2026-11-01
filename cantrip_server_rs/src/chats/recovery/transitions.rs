use super::*;
use crate::{
    chats::{
        live_mutations::MessageOptions, message_queries::MessageKind,
        protect_input::InputProtection,
    },
    projects::targets::TargetRepository,
    settings::operation_error_message,
};
impl Service {
    pub fn continue_worktree_transition(
        &self,
        owner: &str,
        chat: &str,
    ) -> BoxFuture<'static, Result<bool>> {
        if !self
            .state
            .lock()
            .unwrap()
            .transitions
            .insert(chat.to_owned())
        {
            return async { Ok(true) }.boxed();
        }
        let (this, owner, chat) = (self.clone(), owner.to_owned(), chat.to_owned());
        self.operations.run(async move {
            let result = this.continue_transition(&owner, &chat).await;
            this.state.lock().unwrap().transitions.remove(&chat);
            result
        })
    }
    async fn continue_transition(&self, owner: &str, chat: &str) -> Result<bool> {
        let Some(pending) = self.lanes.pending_transition(owner, chat).await? else {
            return Ok(false);
        };
        let Some(current) = self
            .chats
            .execution_context(owner, chat)
            .await?
            .filter(|c| !executing(c))
        else {
            return Ok(true);
        };
        if current["contextKind"] != "project" {
            return Ok(false);
        }
        if truthy(current.get("automationPaused"))
            || !self
                .dependencies
                .commands
                .is_connected(&text(&pending["worktree"]["workerId"])?)
        {
            return Ok(true);
        }
        if current["experience"] == "task"
            && matches!(current["status"].as_str(), Some("offline" | "failed"))
            && self
                .dependencies
                .tasks
                .recover(owner.to_owned(), chat.to_owned())
                .await?
        {
            return Ok(true);
        }
        let prepared = async {
            let model = self
                .dependencies
                .routing
                .resolve_model_id(owner, &current, None)
                .await?;
            self.dependencies
                .routing
                .available_runtimes(owner, &current, &text(&model)?)
                .await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = prepared {
            self.log(
                "error",
                "Could not prepare a pending worktree continuation",
                json!({"chatId":chat,"err":logging::error_details(&error)}),
            );
            return Ok(true);
        }
        if pending["lane"]["transitionKind"] == "release" {
            let Some(source) = TargetRepository::new(self.dependencies.database.clone())
                .worktree_context(
                    owner,
                    &text(&current["projectId"])?,
                    &text(&current["worktreeId"])?,
                )
                .await?
            else {
                return Ok(true);
            };
            let verified=async {
                let response=self.dependencies.commands.request_with_timeout(&text(&source["workerId"])?,json!({"type":"worktree.status","sourcePath":source["sourcePath"],"worktreePath":source["worktree"]["path"]}),crate::workers::command_bus::RequestTimeout::Default,None).await?;
                let status=crate::settings::parse_response("worktreeStatusResultSchema",response.as_ref())?;
                if !status["status"]["files"].as_array().context("Worktree status files")?.is_empty() {
                    self.lanes.cancel_transition(owner,chat,&text(&pending["lane"]["id"])?).await?;
                    let key=super::super::turn_runtime::events::identifier(&[&json!("transition-cancelled:"),&pending["lane"]["id"]]);
                    self.system_message(owner,chat,json!("Worktree release was cancelled because new uncommitted changes appeared before the turn finished."),key,None).await?;
                    return Ok::<_,anyhow::Error>(false)
                }
                Ok(true)
            }.await;
            match verified {
                Ok(false) => return Ok(false),
                Ok(true) => (),
                Err(error) => {
                    self.log(
                        "error",
                        "Could not verify a pending worktree release",
                        json!({"chatId":chat,"err":logging::error_details(&error)}),
                    );
                    return Ok(true);
                }
            }
        }
        let Some(applied) = self
            .lanes
            .apply_transition(owner, chat, &text(&pending["lane"]["id"])?)
            .await?
        else {
            return Ok(true);
        };
        let Some(next) = self.chats.execution_context(owner, chat).await? else {
            return Ok(true);
        };
        let started = self
            .begin_continuation(owner, &pending, &applied, &next)
            .await;
        if let Err(error) = started {
            self.log(
                "error",
                "Could not start a worktree continuation",
                json!({"chatId":chat,"err":logging::error_details(&error)}),
            );
            let key = super::super::turn_runtime::events::identifier(&[
                &json!("worktree-continuation-error:"),
                &pending["lane"]["id"],
            ]);
            let content = super::super::turn_runtime::events::identifier(&[
                &json!("The chat moved to "),
                &applied["worktree"]["name"],
                &json!(", but its automatic continuation could not start: "),
                &Value::String(operation_error_message(&error)),
            ]);
            self.system_message(owner,chat,content,key,Some(&json!({"executionLaneId":pending["lane"]["id"],"worktreeId":applied["worktree"]["id"]}))).await?;
        }
        Ok(true)
    }
    async fn begin_continuation(
        &self,
        owner: &str,
        pending: &Value,
        applied: &Value,
        next: &Value,
    ) -> Result<()> {
        let text = if applied["transitionKind"] == "release" {
            json!(
                "Returned to Primary after releasing the previous worktree. Continue the user's request from this checkout."
            )
        } else {
            let mut pieces = vec![json!("Continued in "), applied["worktree"]["name"].clone()];
            if truthy(applied["worktree"].get("branch")) {
                pieces.extend([
                    json!(" ("),
                    applied["worktree"]["branch"].clone(),
                    json!(")"),
                ]);
            }
            pieces.push(json!(". Continue the user's request from this checkout."));
            super::super::turn_runtime::events::identifier(&pieces.iter().collect::<Vec<_>>())
        };
        let key = super::super::turn_runtime::events::identifier(&[
            &json!("worktree-continuation:"),
            &pending["lane"]["id"],
        ]);
        let input = json!({"text":text,"mode":"default","idempotencyKey":key});
        if next["experience"] == "task"
            && self
                .dependencies
                .tasks
                .continue_goal(owner.to_owned(), next.clone(), input.clone())
                .await?
        {
            return Ok(());
        }
        let protected = InputProtection::new(self.dependencies.commands.clone())
            .protect(
                &super::text(&next["workerId"])?,
                &input,
                &[],
                next.get("reasoningEffort"),
                Some(&json!("system")),
            )
            .await?;
        let response = json!({"id":uuid::Uuid::new_v4().to_string(),"idempotencyKey":super::super::turn_runtime::events::identifier(&[&json!("assistant:"),&protected["id"]])});
        let purpose = super::super::turn_runtime::events::identifier(&[
            &json!("Controlled "),
            &applied["transitionKind"],
            &json!(" continuation"),
        ]);
        (self.dependencies.begin)(owner.to_owned(),next.clone(),input,json!({"encryptedChatMessages":json!({"userMessage":protected,"response":response}),"acquiringActor":"agent","messageRole":"system","purpose":purpose})).await?;
        Ok(())
    }
    async fn system_message(
        &self,
        owner: &str,
        chat: &str,
        text: Value,
        key: Value,
        attribution: Option<&Value>,
    ) -> Result<()> {
        self.dependencies.live.write_message(owner,chat,&json!({"role":"system","content":vec![json!({"type":"text","text":text})],"idempotencyKey":key}),MessageOptions{attribution,kind:MessageKind::Plain,upsert:false,routing:None}).await?;
        Ok(())
    }
    pub fn resume_transitions(&self, owner: &str, worker: &str) -> BoxFuture<'static, Result<()>> {
        let (this, owner, worker) = (self.clone(), owner.to_owned(), worker.to_owned());
        self.operations.run(async move {
            if !this.dependencies.commands.is_connected(&worker){return Ok(())}
            this.dependencies.tasks.reconcile(owner.clone()).await?;
            let chats=this.lanes.pending_transition_chat_ids(&owner,&worker).await?;
            futures::future::join_all(chats.into_iter().map(|chat| {
                let (this,owner,worker)=(this.clone(),owner.clone(),worker.clone());
                async move {if let Err(error)=this.continue_worktree_transition(&owner,&chat).await {this.log("error","Could not recover a pending worktree transition",json!({"chatId":chat,"workerId":worker,"err":logging::error_details(&error)}));}}
            })).await;
            Ok(())
        })
    }
}
