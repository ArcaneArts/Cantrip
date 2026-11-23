use super::*;
impl Service {
    pub(super) async fn finish(
        &self,
        input: &Recovery<'_>,
        ok: bool,
        finalized: Option<&str>,
    ) -> Result<()> {
        let Recovery {
            owner,
            worker,
            n,
            context,
            logical,
            ..
        } = *input;
        let (chat, lane) = (text(&n["chatId"])?, text(&n["executionLaneId"])?);
        self.dependencies
            .live
            .interrupt_interactions(owner, chat, Some(lane))
            .await?;
        let status = if ok { "idle" } else { "failed" };
        let finished = if let Some(logical) = logical {
            native_commands::runtime::finish_gui::finish_managed_gui(
                &self.native,
                &self.dependencies.commands,
                owner,
                worker,
                logical,
                status,
                &|error| {
                    self.log(
                        "warn",
                        "Recovered logical completion remains queued for acknowledgment",
                        json!({"err":logging::error_details(&error),"chatId":n["chatId"]}),
                    );
                },
            )
            .await?
        } else {
            self.lanes.finish(chat, lane, status, &Value::Null).await?
        };
        let mut recovered_failed = false;
        if logical.is_none()
            && !finished
            && n["outcome"]["ok"] == true
            && let Some(current) = self.chats.execution_context(owner, chat).await?
            && current["status"] == "failed"
            && !truthy(current.get("executionLaneId"))
        {
            self.chats.set_status(chat, "idle").await?;
            recovered_failed = true;
        }
        self.dependencies.live.publish_boundary(
            owner,
            chat,
            &context["chat"]["projectId"],
            Some(&context["chat"]),
        );
        if let Some(finalized) = finalized
            && ok
            && let Err(error) = self
                .dependencies
                .goals
                .launch_prepared(owner, chat, finalized, goals::GoalOptions::default())
                .await
        {
            self.dependencies
                .goals
                .fail_launch(owner, chat, finalized, Arc::new(error))
                .await?;
        }
        let reported_ok = n["outcome"]["ok"] == true;
        let mut fields = json!({"event":"chat.turn.outcome-recovered","subsystem":"chat-execution","operation":"recover-outcome","status":if ok {"completed"}else{"failed"},"chatId":n["chatId"],"clientMessageId":n["clientMessageId"],"executionLaneId":n["executionLaneId"],"outcome":if reported_ok {"completed"}else{"failed"},"workerId":worker});
        if reported_ok {
            fields["responseCharacterCount"] = json!(
                n["outcome"]["result"]["text"]
                    .as_js_string()
                    .context("Recovered response text")?
                    .units()
                    .len()
            );
            for key in ["threadId", "turnId"] {
                if let Some(value) = n["outcome"]["result"].get(key) {
                    fields[key] = value.clone();
                }
            }
        } else {
            fields["reasonCode"] = json!("worker-reported-failure");
        }
        self.log("info", "Recovered agent turn outcome from worker", fields);
        if (finished || recovered_failed)
            && (n["contextKind"] == "standalone"
                || !self
                    .dependencies
                    .continuation
                    .continue_worktree_transition(owner, chat)
                    .await?)
        {
            drop(self.dependencies.continuation.dispatch(owner, chat));
        }
        Ok(())
    }
}
