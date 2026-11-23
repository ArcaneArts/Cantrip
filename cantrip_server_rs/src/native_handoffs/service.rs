//! Worker transport acknowledgement is separate from durable destination selection.
use super::*;
use crate::{
    chats::turn_runtime::stages::Operations,
    workers::command_bus::{LimitedCommandBus, RequestTimeout},
};
use futures::future::{BoxFuture, Shared};
use std::{collections::HashMap, sync::Mutex};
pub type Recovery = Shared<BoxFuture<'static, Result<(), Arc<anyhow::Error>>>>;
pub type Publish = Arc<dyn Fn(&str, &str) + Send + Sync>;
/// Finish the actual native transfer before a Task Goal control selects a root.
/// This performs no inference and owns no provider ticket.
pub async fn settle_task_control(
    repository: &Repository,
    commands: &Arc<LimitedCommandBus>,
    owner: &str,
    chat: &str,
) -> Result<()> {
    let Some(mut state) = repository.active_task_goal_for_chat(owner, chat).await? else {
        return Ok(());
    };
    if state["phase"] != "committed" {
        match repository
            .request_cancellation(owner, chat, &text(&state["operationId"])?)
            .await
        {
            Ok(cancelled) => state = cancelled,
            Err(cause) => {
                if cause
                    .downcast_ref::<CommandError>()
                    .is_none_or(|error| error.code != "handoff-already-committed")
                {
                    return Err(cause);
                }
                let Some(current) = repository
                    .get(owner, chat, &text(&state["operationId"])?)
                    .await?
                else {
                    return Err(cause);
                };
                state = current;
            }
        }
    }
    commands
        .request_with_timeout(
            &text(&state["workerId"])?,
            json!({
        "type":"chat.runtime.handoff","chatId":chat,"operationId":state["operationId"],
        "intent":if state["cancelRequested"]==true{"cancel"}else{"continue"}}),
            RequestTimeout::Disabled,
            None,
        )
        .await?;
    let settled = repository
        .get(owner, chat, &text(&state["operationId"])?)
        .await?;
    if settled
        .as_ref()
        .is_none_or(|state| !matches!(state["phase"].as_str(), Some("completed" | "cancelled")))
    {
        return Err(CommandError::new("handoff-control-settlement-pending",
            Some("The provider transfer has not settled. Retry the Goal control after the transfer finishes."),409).into());
    }
    Ok(())
}
#[derive(Clone)]
pub struct Service {
    repository: Repository,
    commands: Arc<LimitedCommandBus>,
    publish: Publish,
    active: Arc<Mutex<HashMap<String, (uuid::Uuid, Recovery)>>>,
    operations: Arc<Operations>,
}
impl Service {
    fn task_reader(&self, owner: &str) -> task_goal_capture::TaskGoalCaptureReader {
        let (commands, owner) = (self.commands.clone(), owner.to_owned());
        Arc::new(move |scope, cycle, input| {
            let (commands, owner) = (commands.clone(), owner.clone());
            async move {
                let worker = text(&scope["workerId"])?;
                let mut command = json!({"type":"task.goal.source","scope":scope,"cycleId":cycle});
                if let Some(input) = input {
                    command["input"] = input;
                }
                // Attempt the actual capture before checking connection identity.
                let response = commands
                    .request_with_timeout(
                        &worker,
                        command,
                        RequestTimeout::After(std::time::Duration::from_secs(10)),
                        None,
                    )
                    .await?;
                let captured = crate::settings::parse_response(
                    "taskGoalHandoffCaptureSchema",
                    response.as_ref(),
                )?;
                let actual = commands.connection_identity(&worker);
                if actual.as_ref().is_none_or(|connection| {
                    connection.owner != owner
                        || captured["record"]["workerGeneration"].as_str()
                            != Some(connection.process_generation.as_str())
                }) {
                    return reject("handoff-task-goal-worker-replaced");
                }
                Ok(captured)
            }
            .boxed()
        })
    }
    async fn begin_captured(&self, owner: &str, chat: &str, input: &Value) -> Result<Value> {
        let input = parse("nativeRuntimeHandoffRequestSchema", input)?;
        let captured = self
            .repository
            .capture_task_goal(owner, chat, self.task_reader(owner), Some(&input))
            .await?;
        self.repository
            .begin_captured(owner, chat, &input, captured)
            .await
    }
    pub fn read_task_source(&self, owner: &str, chat: &str) -> BoxFuture<'static, Result<Value>> {
        let (this, owner, chat) = (self.clone(), owner.to_owned(), chat.to_owned());
        self.operations.run(async move {
            this.repository
                .read_task_source(&owner, &chat, this.task_reader(&owner))
                .await
        })
    }
    pub fn owned<T, F>(&self, operation: F) -> BoxFuture<'static, Result<T>>
    where
        T: Send + 'static,
        F: std::future::Future<Output = Result<T>> + Send + 'static,
    {
        self.operations.run(operation)
    }
    pub fn new(
        database: Arc<Database>,
        commands: Arc<LimitedCommandBus>,
        publish: Publish,
    ) -> Arc<Self> {
        Arc::new(Self {
            repository: Repository::new(database),
            commands,
            publish,
            active: Arc::default(),
            operations: Arc::default(),
        })
    }
    pub fn dispatch(&self, owner: &str, state: &Value, reconnect: bool) -> Recovery {
        if matches!(state["phase"].as_str(), Some("completed" | "cancelled")) {
            return async { Ok(()) }.boxed().shared();
        }
        let intent = if state["cancelRequested"] == true {
            "cancel"
        } else {
            "continue"
        };
        let key = format!(
            "{}:{intent}",
            state["operationId"]
                .as_str()
                .expect("Validated handoff UUID")
        );
        let mut active = self.active.lock().unwrap();
        if !reconnect && let Some((_, operation)) = active.get(&key) {
            return operation.clone();
        }
        let (this, owner, state, id, copied) = (
            self.clone(),
            owner.to_owned(),
            state.clone(),
            uuid::Uuid::new_v4(),
            key.clone(),
        );
        let operation=self.operations.run(async move{
            let result=async{
                let request = this.commands.request_with_timeout(
                    &text(&state["workerId"])?,
                    json!({"type":"chat.runtime.handoff","chatId":state["chatId"],"operationId":state["operationId"],"intent":intent}),
                    RequestTimeout::Disabled,
                    None,
                ).await;
                let owns_attempt = this.active.lock().unwrap().get(&copied)
                    .is_some_and(|(current,_)|*current==id);
                if request.is_err() && owns_attempt {
                    this.repository.dispatch_failure(&owner, &state).await?;
                }
                Ok(())
            }.await;
            {let mut active=this.active.lock().unwrap();if active.get(&copied).is_some_and(|(current,_)|*current==id){active.remove(&copied);}}
            (this.publish)(&owner,&text(&state["chatId"])?);
            result
        }).map(|result|result.map_err(Arc::new)).boxed().shared();
        active.insert(key, (id, operation.clone()));
        operation
    }
    pub fn start(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
    ) -> BoxFuture<'static, Result<Value>> {
        let (this, owner, chat, input) = (
            self.clone(),
            owner.to_owned(),
            chat.to_owned(),
            input.clone(),
        );
        self.operations.run(async move {
            let state = this.begin_captured(&owner, &chat, &input).await?;
            drop(this.dispatch(&owner, &state, false));
            (this.publish)(&owner, &text(&state["chatId"])?);
            Ok(state)
        })
    }
    pub fn retry(
        &self,
        owner: &str,
        chat: &str,
        operation: &str,
    ) -> BoxFuture<'static, Result<Option<Value>>> {
        let (this, owner, chat, operation) = (
            self.clone(),
            owner.to_owned(),
            chat.to_owned(),
            operation.to_owned(),
        );
        self.operations.run(async move {
            let state = this.repository.get(&owner, &chat, &operation).await?;
            if let Some(state) = &state {
                drop(this.dispatch(&owner, state, false));
            }
            Ok(state)
        })
    }
    pub fn cancel(
        &self,
        owner: &str,
        chat: &str,
        operation: &str,
    ) -> BoxFuture<'static, Result<Value>> {
        let (this, owner, chat, operation) = (
            self.clone(),
            owner.to_owned(),
            chat.to_owned(),
            operation.to_owned(),
        );
        self.operations.run(async move {
            let state = this
                .repository
                .request_cancellation(&owner, &chat, &operation)
                .await?;
            drop(this.dispatch(&owner, &state, false));
            (this.publish)(&owner, &text(&state["chatId"])?);
            Ok(state)
        })
    }
    pub fn begin_and_wait(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
    ) -> BoxFuture<'static, Result<Value, Arc<anyhow::Error>>> {
        let (this, owner, chat, input) = (
            self.clone(),
            owner.to_owned(),
            chat.to_owned(),
            input.clone(),
        );
        self.operations.run(async move{
            let state=this.begin_captured(&owner,&chat,&input).await?;(this.publish)(&owner,&chat);
            // Keep the actual error available to HTTP/error mapping without
            // flattening SQL or command failures into a synthetic string error.
            let transport=this.dispatch(&owner,&state,false).await;
            if let Err(error)=transport{return Ok(Err(error))}
            let settled=this.repository.get(&owner,&chat,&text(&state["operationId"])?).await?;
            if let Some(state)=settled.as_ref().filter(|s|s["phase"]=="completed"){return Ok(Ok(state.clone()))}
            let code=settled.as_ref().and_then(|s|s.get("errorCode")).filter(|v|!v.is_null()).map(text).transpose()?.unwrap_or_else(||"handoff-not-completed".into());
            Err(CommandError::new(code,Some("The account switch did not complete. Retry the account transfer before sending this message."),409).into())
        }).map(|result|match result{Ok(value)=>value,Err(error)=>Err(Arc::new(error))}).boxed()
    }
    pub fn worker_connected(
        &self,
        owner: &str,
        worker: &str,
    ) -> BoxFuture<'static, Result<HashMap<String, Recovery>>> {
        let (this, owner, worker) = (self.clone(), owner.to_owned(), worker.to_owned());
        self.operations.run(async move {
            let states = this.repository.active_for_worker(&owner, &worker).await?;
            states
                .into_iter()
                .map(|state| Ok((text(&state["chatId"])?, this.dispatch(&owner, &state, true))))
                .collect()
        })
    }
    pub async fn drained(&self) {
        self.operations.drained().await;
    }
}
