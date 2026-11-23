use super::*;
use crate::wire::coercion::truthy;
use futures::future::{Shared, join_all};
use std::collections::HashMap;
type Lookup = Shared<BoxFuture<'static, Result<Option<Value>, Arc<anyhow::Error>>>>;
#[derive(Default)]
pub(super) struct State {
    pub jobs: usize,
    lookups: HashMap<String, (uuid::Uuid, Lookup)>,
}
pub(super) struct Pending {
    pub owner: String,
    pub chat: String,
    pub resource: &'static str,
    pub entity: Value,
    pub routing: Option<Value>,
}
struct Job(Arc<Service>);
impl Drop for Job {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().jobs -= 1;
        self.0.changed.notify_waiters();
    }
}
impl Service {
    fn lookup(self: &Arc<Self>, owner: &str, chat: &str) -> Lookup {
        let key = format!("{owner}\0{chat}");
        let mut state = self.state.lock().unwrap();
        if let Some((_, lookup)) = state.lookups.get(&key) {
            return lookup.clone();
        }
        let (service, owner, chat, id) = (
            self.clone(),
            owner.to_owned(),
            chat.to_owned(),
            uuid::Uuid::new_v4(),
        );
        let copied_key = key.clone();
        let lookup = async move {
            // Start the real lookup when fanout is admitted, as Source's async
            // loader does before returning its Promise. Concurrent callers share
            // the lookup until its actual database operation settles.
            let result = service
                .repository
                .live_routing(&owner, &chat)
                .await
                .map_err(Arc::new);
            let mut state = service.state.lock().unwrap();
            if state
                .lookups
                .get(&copied_key)
                .is_some_and(|(active, _)| *active == id)
            {
                state.lookups.remove(&copied_key);
            }
            result
        }
        .boxed()
        .shared();
        state.lookups.insert(key, (id, lookup.clone()));
        lookup
    }
    async fn route(self: Arc<Self>, pending: Pending) {
        let result:Result<()>=async {
            let context=if let Some(routing)=pending.routing.as_ref().filter(|v|truthy(Some(v))) {
                tokio::task::yield_now().await;Some(routing.clone())
            }else{self.lookup(&pending.owner,&pending.chat).await.map_err(|e|anyhow::anyhow!(e.to_string()))?};
            let Some(context)=context.filter(|c|c["experience"]=="task" && truthy(c.get("projectId")))else{return Ok(())};
            let entity=if pending.entity.is_null(){json!(pending.chat)}else{pending.entity.clone()};
            (self.dependencies.invalidate)(json!({"ownerId":pending.owner,"scope":json!({"kind":"project","projectId":context["projectId"]}),"resource":pending.resource,"action":"invalidated","entityId":entity,"revision":Value::Null,"payload":Value::Null}));
            Ok(())
        }.await;
        if let Err(error) = result {
            self.report(
                "warn",
                "Could not publish Task workload invalidation",
                error,
                json!({"chatId":pending.chat,"resource":pending.resource}),
            );
        }
    }
    fn enqueue(
        self: &Arc<Self>,
        pending: Vec<Pending>,
    ) -> Option<tokio::sync::oneshot::Receiver<()>> {
        if pending.is_empty() {
            return None;
        }
        self.state.lock().unwrap().jobs += 1;
        let job = Job(self.clone());
        let service = self.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        let mut work = async move {
            let _job = job;
            join_all(pending.into_iter().map(|p| service.clone().route(p))).await;
            let _ = send.send(());
        }
        .boxed();
        // Poll through admission before returning to the caller. Merely spawning
        // lets its next SQL write overtake the ID-only routing read on PGlite.
        // Known routing still yields inside route, preserving synchronous groups.
        if work.as_mut().now_or_never().is_none() {
            tokio::spawn(work);
        }
        Some(receive)
    }
    pub(super) fn fanout(self: &Arc<Self>, pending: Vec<Pending>) {
        let _ = self.enqueue(pending);
    }
    pub(super) async fn fanout_message(self: &Arc<Self>, pending: Vec<Pending>) {
        let known = pending.iter().all(|p| truthy(p.routing.as_ref()));
        if let Some(done) = self.enqueue(pending)
            && known
        {
            let _ = done.await;
        }
    }
}
