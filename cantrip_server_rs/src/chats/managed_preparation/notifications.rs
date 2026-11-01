use super::runtime::*;
use crate::{
    wire::{Value, coercion::truthy},
    workers::{bridge::WorkerBridge, command_bus::RequestTimeout},
};
use anyhow::Result;
use futures::FutureExt;
use std::{collections::HashMap, sync::Arc, time::Duration};

impl Service {
    pub fn subscribe(self: &Arc<Self>, bridge: &Arc<WorkerBridge>, worker: &str) {
        let mut state = self.state.lock().unwrap();
        if state.subscriptions.contains_key(worker) {
            return;
        }
        let (weak, id) = (Arc::downgrade(self), worker.to_owned());
        let subscription = bridge.subscribe_owned_notifications(
            worker,
            Arc::new(move |owner, notification| {
                let (weak, id) = (weak.clone(), id.clone());
                async move {
                    let Some(service) = weak.upgrade() else {
                        return Ok(());
                    };
                    if notification["type"] != "terminal.runtime.observed" {
                        return Ok(());
                    }
                    let _admission = service.admission(true)?;
                    service
                        .receive_notification(&owner, &id, &notification)
                        .await
                }
                .boxed()
            }),
        );
        state.subscriptions.insert(worker.to_owned(), subscription);
    }
    pub fn schedule_worker(
        self: &Arc<Self>,
        owner: String,
        worker: String,
        recoveries: futures::future::BoxFuture<'static, Result<HashMap<String, Recovery>>>,
    ) {
        let Ok(admission) = self.admission(false) else {
            return;
        };
        let service = self.clone();
        tokio::spawn(async move {
            let _admission = admission;
            let result = async {
                let recoveries = recoveries.await?;
                service.worker_connected(&owner, &worker, &recoveries).await
            }
            .await;
            if result.is_err() {
                eprintln!("{{\"event\":\"chat.preparation.reconnect-failed\"}}");
            }
        });
    }
    pub async fn receive_notification(
        &self,
        owner: &str,
        worker: &str,
        notification: &Value,
    ) -> Result<()> {
        if notification["type"] != "terminal.runtime.observed" {
            return Ok(());
        }
        let identity = (self.request_worker)(
            owner.to_owned(),
            worker.to_owned(),
            crate::wire::value::json!({"type":"worker-link.identity.resolve"}),
            RequestTimeout::After(Duration::from_secs(5)),
            None,
        )
        .await?;
        let Ok(identity) =
            crate::wire::parse("workerLinkIdentityResolveResultSchema", identity.as_ref())
        else {
            return Ok(());
        };
        if identity["serverId"] != self.server_id
            || identity["ownerId"] != owner
            || identity["workerId"] != worker
            || identity.get("workerProcessGeneration")
                != notification.get("workerProcessGeneration")
        {
            return Ok(());
        }
        let terminals = crate::terminals::Repository::new(self.repository.database.clone());
        let terminal = text(notification, "terminalId")?;
        let Some(context) = terminals
            .context(owner, terminal)
            .await?
            .filter(|c| c["workerId"] == worker && c["kind"] != "run-configuration")
        else {
            return Ok(());
        };
        if truthy(notification.get("managedPreparationGeneration"))
            && truthy(context.get("linkedChatId"))
        {
            if let Some(changed) = self
                .repository
                .console_exited(
                    owner,
                    worker,
                    terminal,
                    text(notification, "managedPreparationGeneration")?,
                )
                .await?
            {
                let chat = &changed["chatId"];
                for (resource, scope, entity) in [
                    (
                        "terminal",
                        crate::wire::value::json!({"kind":"project","projectId":context["projectId"]}),
                        crate::wire::value::json!(terminal),
                    ),
                    (
                        "chat-preparation",
                        crate::wire::value::json!({"kind":"chat","chatId":chat}),
                        chat.clone(),
                    ),
                    (
                        "chat",
                        crate::wire::value::json!({"kind":"project","projectId":context["projectId"]}),
                        chat.clone(),
                    ),
                ] {
                    (self.publish)(
                        crate::wire::value::json!({"ownerId":owner,"scope":scope,"resource":resource,"action":"invalidated","entityId":entity,"revision":Value::Null,"payload":Value::Null}),
                    );
                }
            }
        } else {
            // The same production notification also owns ordinary terminal exits.
            self.repository
                .database
                .query(
                    "UPDATE terminals SET status='exited',updated_at=$1 WHERE id=$2",
                    &[&crate::auth::now(), &terminal],
                )
                .await?;
            (self.publish)(
                crate::wire::value::json!({"ownerId":owner,"scope":crate::wire::value::json!({"kind":"current-user"}),"resource":"terminal","action":"invalidated","entityId":terminal,"revision":Value::Null,"payload":Value::Null}),
            );
        }
        Ok(())
    }
}
