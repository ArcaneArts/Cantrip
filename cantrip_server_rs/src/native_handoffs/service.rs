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
#[derive(Clone)]
pub struct Service {
    repository: Repository,
    commands: Arc<LimitedCommandBus>,
    publish: Publish,
    active: Arc<Mutex<HashMap<String, (uuid::Uuid, Recovery)>>>,
    operations: Arc<Operations>,
}
impl Service {
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
                if this.commands.request_with_timeout(&text(&state["workerId"])?,json!({"type":"chat.runtime.handoff","chatId":state["chatId"],"operationId":state["operationId"],"intent":intent}),RequestTimeout::Disabled,None).await.is_err(){
                    this.repository.failure(&owner,&text(&state["workerId"])?,&text(&state["operationId"])?,"handoff-worker-unavailable").await?;
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
            let state = this.repository.begin(&owner, &chat, &input).await?;
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
            let state=this.repository.begin(&owner,&chat,&input).await?;(this.publish)(&owner,&chat);
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
