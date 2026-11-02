use super::*;
impl Service {
    pub(super) async fn run_one(
        self: &Arc<Self>,
        owner: &str,
        claim: &Value,
        prepared_runtime: Option<Value>,
    ) -> Result<()> {
        let mut launch_stage = "resolve-context";
        let result:Result<()>=async {
            let context=self.stage(claim,launch_stage,{
                let (chats,owner,chat)=(self.chats.clone(),owner.to_owned(),text(&claim["cycle"]["chatId"])?);
                async move {chats.execution_context(&owner,&chat).await}
            }).await?;
            let context=context.filter(|c|c["experience"]=="task" && c["projectId"]==claim["projectId"] && c["workerId"]==claim["cycle"]["physicalWorkerId"] && c["worktreeId"]==claim["cycle"]["worktreeId"]).context("The claimed Task placement is no longer available.")?;
            launch_stage="resolve-runtime";
            let configuration=&claim["cycle"]["modelConfiguration"];
            let model=configuration["modelId"].clone();
            let kind=claim["cycle"]["operationKind"].clone();
            anyhow::ensure!(kind!="goal-continuation" && truthy(claim["cycle"].get("modelRouteId")) && truthy(Some(&model)),"The claimed Task cycle is not executable yet.");
            let runtime=self.stage(claim,launch_stage,{
                let (routing,owner,context,model,cycle)=(self.dependencies.routing.clone(),owner.to_owned(),context.clone(),model.clone(),claim["cycle"].clone());
                async move {
                    if let Some(runtime)=prepared_runtime {return Ok(Some(runtime));}
                    let runtimes=routing.available_runtimes(&owner,&json!({"workerId":context["workerId"],"providerAccountId":cycle["providerAccountId"]}),&text(&model)?).await?;
                    Ok(runtimes.into_iter().find(|r|r["routeId"]==cycle["modelRouteId"] && r["provider"]["accountId"]==cycle["providerAccountId"]))
                }
            }).await?.context("The claimed Task model route is no longer available.")?;
            launch_stage="load-operation";
            let (task,prior)=self.stage(claim,launch_stage,{
                let (tasks,owner,chat,operation)=(self.tasks.clone(),owner.to_owned(),text(&context["chatId"])?,claim["cycle"]["operationId"].clone());
                async move {let lookup=json!({"operationId":operation});futures::try_join!(tasks.get(&owner,&chat),tasks.get_operation_context(&owner,&chat,&lookup))}
            }).await?;
            let task=task.context("The claimed Task no longer exists.")?;
            if let Some(prior)=prior.as_ref().filter(|p|truthy(p.get("relayResult"))) {
                if prior["round"]["kind"]=="finalize" {
                    self.launch_goal(owner,claim,&context,&runtime,&text(&prior["round"]["id"])?).await?;
                }else{
                    self.dispatch.heartbeat(&claim["lease"],&Value::Null).await?;
                    self.dispatch.settle(&claim["lease"],"succeeded",&Value::Null).await?;
                    self.publish(owner,&text(&context["chatId"])?,Some(&context));self.tick();
                }
                return Ok(());
            }
            let (request,started_task)=if let Some(prior)=prior {
                (prior["relayRequest"].clone(),prior["task"].clone())
            }else{
                launch_stage="prepare-operation";
                let response=self.stage(claim,launch_stage,{
                    let (commands,worker,operation,kind,task,timeout)=(self.dependencies.commands.clone(),text(&context["workerId"])?,claim["cycle"]["operationId"].clone(),kind.clone(),task.clone(),self.dependencies.limits.preflight_timeout_ms);
                    async move {Ok(commands.request_with_timeout(&worker,json!({"type":"task.operation.prepare","operationId":operation,"operationKind":kind,"task":task}),RequestTimeout::After(stage::delay(timeout)),None).await?)}
                }).await?;
                let prepared=crate::settings::parse_response("taskEncryptedOperationStartSchema",response.as_ref())?;
                launch_stage="persist-operation";
                let started=self.stage(claim,launch_stage,{
                    let (tasks,owner,chat)=(self.tasks.clone(),owner.to_owned(),text(&context["chatId"])?);
                    async move {tasks.begin_operation(&owner,&chat,&prepared).await}
                }).await?.context("The claimed Task no longer exists.")?;
                self.publish(owner,&text(&context["chatId"])?,Some(&context));
                (started["relayRequest"].clone(),started["task"].clone())
            };
            launch_stage="begin-turn";
            let user_message={
                let _retention=self.retain_preflight(claim);
                let hooks=self.completion_hooks(owner,claim,&context,&runtime,&request);
                let input=json!({"text":"Run the encrypted Task operation.","attachmentIds":started_task["draftAttachmentIds"],"idempotencyKey":format!("task-operation:{}",text(&request["operationId"])?),"modelId":model,"reasoningEffort":configuration["reasoningEffort"],"customSubagentModel":configuration["customSubagentModel"],"subagentModelId":configuration["subagentModelId"],"subagentReasoningEffort":configuration["subagentReasoningEffort"]});
                let options=json!({"purpose":"Scheduled encrypted Task operation","encryptedTaskMessages":json!({"userMessage":request["userMessage"]}),"preflightWorkerCommandTimeoutMs":self.dependencies.limits.preflight_timeout_ms,"runtimes":vec![runtime.clone()],"taskDispatchLease":claim["lease"],"structuredResult":json!({"taskOperation":request})});
                // begin() admits owned bootstrap work immediately. Invoke it
                // inside the stage so its events follow the launch-stage start.
                let (runtime,owner,context)=(self.dependencies.runtime.clone(),owner.to_owned(),context.clone());
                self.stage(claim,launch_stage,async move {runtime.begin(&owner,&context,&input,&options,hooks).await}).await?
            };
            anyhow::ensure!(truthy(user_message.get("executionLaneId")),"Encrypted Task operation did not acquire a lane.");
            launch_stage="attach-execution";
            self.stage(claim,launch_stage,{
                let (tasks,owner,chat,operation)=(self.tasks.clone(),owner.to_owned(),text(&context["chatId"])?,text(&request["operationId"])?);
                async move {tasks.attach_operation_execution(&owner,&chat,&operation,&json!({"executionLaneId":user_message["executionLaneId"],"userMessageId":user_message["id"]})).await}
            }).await?;
            Ok(())
        }.await;
        if let Err(error) = result {
            if launch_stage == "begin-turn"
                && matches!(downcast_ref::<LaneError>(&error), Some(LaneError::Busy(_)))
            {
                self.dispatch
                    .defer_for_capacity(&claim["lease"], &Value::Null)
                    .await?;
                self.publish(
                    owner,
                    &text(&claim["cycle"]["chatId"])?,
                    Some(&json!({"experience":"task","projectId":claim["projectId"]})),
                );
                return Ok(());
            }
            self.log("warn","Scheduled Task operation failed to start",json!({"event":"task.operation.launch-failed","subsystem":"task-scheduler","operation":"launch-operation","status":"failed","reasonCode":"preflight-failed","stage":launch_stage,"chatId":claim["cycle"]["chatId"],"cycleId":claim["cycle"]["id"],"serverVersion":crate::settings::quota::server_version(),"err":stage::error_details(&error)}));
            self.finish_failure_one(owner, claim, Some(&error)).await?;
        }
        Ok(())
    }
    pub(super) fn launch_goal(
        self: &Arc<Self>,
        owner: &str,
        claim: &Value,
        context: &Value,
        runtime: &Value,
        operation: &str,
    ) -> BoxFuture<'static, Result<()>> {
        let (this, owner, claim, context, runtime, operation) = (
            self.clone(),
            owner.to_owned(),
            claim.clone(),
            context.clone(),
            runtime.clone(),
            operation.to_owned(),
        );
        self.operations.run(async move {
            let chat = text(&context["chatId"])?;
            let launch: Result<()> = async {
                this.dependencies.goals.retain(&claim["lease"]).await?;
                this.dependencies
                    .goals
                    .launch_prepared(
                        &owner,
                        &chat,
                        &operation,
                        GoalOptions {
                            hooks: this
                                .dependencies
                                .goals
                                .scheduled_hooks(&owner, &claim["lease"]),
                            dispatch_lease: Some(claim["lease"].clone()),
                            model_configuration: Some(claim["cycle"]["modelConfiguration"].clone()),
                            runtimes: Some(vec![runtime]),
                            ..GoalOptions::default()
                        },
                    )
                    .await?;
                Ok(())
            }
            .await;
            if let Err(error) = launch {
                let error = Arc::new(error);
                this.dependencies.goals.release(&claim["lease"]["cycleId"]);
                let persisted = this
                    .dependencies
                    .goals
                    .fail_launch(&owner, &chat, &operation, error.clone())
                    .await;
                let cleanup: Result<()> = async {
                    let settled: Result<()> = async {
                        this.dispatch
                            .heartbeat(&claim["lease"], &Value::Null)
                            .await?;
                        this.dispatch
                            .settle(&claim["lease"], "failed", &Value::Null)
                            .await?;
                        Ok(())
                    }
                    .await;
                    if let Err(error) = settled
                        && downcast_ref::<task_dispatch::Conflict>(&error).is_none()
                    {
                        return Err(error);
                    }
                    this.publish(&owner, &chat, Some(&context));
                    this.retries
                        .note_failure(
                            &owner,
                            &chat,
                            &format!(
                                "goal-launch:{}:{}",
                                text(&claim["cycle"]["id"])?,
                                claim["lease"]["fencingToken"].stringify()
                            ),
                            tasks::failure_kind::for_error(&error),
                            None,
                        )
                        .await?;
                    this.publish(&owner, &chat, Some(&context));
                    this.tick();
                    Ok(())
                }
                .await;
                cleanup?;
                persisted?;
            }
            Ok(())
        })
    }
}
