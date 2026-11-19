//! Route checkpoint resources only between the current native runner and the
//! worker's matching account grant. They never become runtime observations.
use crate::{
    codex::{rpc_protocol::RESOURCE_RESOLVE, session::Session},
    encryption::Service,
};
use anyhow::{Context, Result, bail};
use cantrip_crypto::content::{
    NativeResourceComponent as Component, open_native_resources, seal_native_resources,
};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

pub(super) struct Grant {
    pub service: Arc<Service>,
    pub owner: JsString,
    pub server: JsString,
}

impl Grant {
    fn current(&self) -> bool {
        self.service.bound_identity().is_ok_and(|(owner, server)| {
            owner == self.owner && server.as_js_string() == Some(&self.server)
        })
    }

    fn process(&self, request: &Value, component: Component) -> Result<Value> {
        let seal = request["seal"] == true;
        let revision = if seal {
            None
        } else {
            let envelope = component.envelope(&request["value"])?;
            Some(
                envelope["keyRevision"]
                    .as_u64()
                    .context("Native resource key revision")?,
            )
        };
        let bound = self.service.bound_component(component.name(), revision)?;
        if bound.owner_id != self.owner || bound.server_id.as_js_string() != Some(&self.server) {
            bail!("Native resources belong to a replaced worker binding.");
        }
        let registration = self.service.registration();
        let principal = registration["principalId"]
            .as_js_string()
            .context("Native resource worker principal")?;
        let context = json!({
            "ownerId":bound.owner_id, "serverId":bound.server_id,
            "principalId":principal, "keyRevision":bound.component.key_revision,
        });
        if seal {
            seal_native_resources(
                &bound.component.key,
                &context,
                component,
                request,
                &request["value"],
            )
        } else {
            open_native_resources(
                &bound.component.key,
                &context,
                component,
                request,
                &request["value"],
            )
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
struct Owner {
    runner: JsString,
    version: u64,
    component: Component,
}

pub(super) struct Resources {
    grant: Option<Grant>,
    process_runner: JsString,
    owners: Mutex<HashMap<JsString, Owner>>,
}

impl Resources {
    pub fn new(grant: Option<Grant>, process_runner: JsString) -> Self {
        Self {
            grant,
            process_runner,
            owners: Mutex::default(),
        }
    }

    pub fn bind(&self, session: &Session, thread: &JsString, runner: &JsString, task: bool) {
        self.owners.lock().unwrap().insert(
            thread.clone(),
            Owner {
                runner: runner.clone(),
                version: session.thread_version(thread),
                component: if task {
                    Component::Task
                } else {
                    Component::Chat
                },
            },
        );
    }

    fn owner(
        &self,
        owners: &HashMap<JsString, Owner>,
        thread: &JsString,
        version: u64,
    ) -> Option<Owner> {
        match owners.get(thread) {
            Some(owner) if owner.version == version => Some(owner.clone()),
            Some(_) => None,
            // Codex's process-wide inference gate owns unmanaged native turns.
            None => Some(Owner {
                runner: self.process_runner.clone(),
                version,
                component: Component::Chat,
            }),
        }
    }

    pub async fn resolve(
        &self,
        generation: &str,
        session: &Session,
        request: &Value,
    ) -> Result<()> {
        if session.generation() != Some(generation) {
            return Ok(());
        }
        let thread = validate(request)?;
        let selected = {
            let owners = self.owners.lock().unwrap();
            self.owner(&owners, thread, session.thread_version(thread))
        };
        let Some(owner) = selected
            .filter(|owner| request["runnerGeneration"].as_js_string() == Some(&owner.runner))
        else {
            return Ok(());
        };
        let result = self
            .grant
            .as_ref()
            .and_then(|grant| grant.process(request, owner.component).ok())
            .unwrap_or(Value::Null);
        // Enqueue under the same owner lock used for native reattachment.
        // A transport that closed concurrently rejects the actual send.
        let reply = {
            let owners = self.owners.lock().unwrap();
            if session.generation() != Some(generation)
                || self.grant.as_ref().is_some_and(|grant| !grant.current())
                || self.owner(&owners, thread, session.thread_version(thread)).as_ref() != Some(&owner)
            {
                return Ok(());
            }
            session.request(
                RESOURCE_RESOLVE.into(),
                Some(json!({
                    "threadId":thread,"turnId":request["turnId"],"checkpointId":request["checkpointId"],
                    "runnerGeneration":owner.runner,"requestId":request["requestId"],"value":result,
                })),
                Some(Duration::from_secs(30)),
                None,
            )
        }.await?;
        if !reply.is_some_and(|reply| reply["accepted"] == true) {
            bail!("Codex did not accept the native resource response.");
        }
        Ok(())
    }
}

fn validate(request: &Value) -> Result<&JsString> {
    let keys = ["threadId", "turnId", "checkpointId", "runnerGeneration"];
    if request.as_object().is_none_or(|fields| fields.len() != 7)
        || request["seal"].as_bool().is_none()
        || request.get("value").is_none()
        || !request["requestId"]
            .as_str()
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok() && id.len() == 36)
        || keys.iter().any(|key| {
            !request[*key]
                .as_js_string()
                .is_some_and(|id| (1..=255).contains(&id.units().len()))
        })
    {
        bail!("Invalid private native resource request.");
    }
    Ok(request["threadId"].as_js_string().unwrap())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::{
        codex::{
            process_transport::Options,
            rpc_protocol::RESOURCE_REQUESTED,
            session::{Event, EventKind},
        },
        encryption::Identity,
    };
    use futures::{SinkExt, StreamExt};
    use tokio::{
        net::{TcpListener, TcpStream},
        sync::mpsc,
        time::timeout,
    };
    use tokio_tungstenite::{WebSocketStream, tungstenite::Message};

    async fn native_request(
        socket: &mut WebSocketStream<TcpStream>,
        events: &mut mpsc::UnboundedReceiver<Event>,
        params: &Value,
    ) -> Result<Event> {
        socket
            .send(Message::Text(
                json!({"method":RESOURCE_REQUESTED,"params":params})
                    .stringify()
                    .into(),
            ))
            .await?;
        events
            .recv()
            .await
            .context("The private native request did not reach its owner.")
    }

    async fn exchange(
        resources: &Resources,
        session: &Session,
        peer: &mut WebSocketStream<TcpStream>,
        events: &mut mpsc::UnboundedReceiver<Event>,
        params: &Value,
    ) -> Result<Value> {
        let event = native_request(peer, events, params).await?;
        let EventKind::Message(message) = event.kind else {
            bail!("The fixture received an unrelated runtime event.");
        };
        let worker = resources.resolve(&event.generation, session, &message["params"]);
        let native = async {
            let frame = peer.next().await.context("Missing private RPC reply.")??;
            let frame = cantrip_wire::parse_json_text(frame.to_text()?)
                .map_err(|e| anyhow::anyhow!("{}", e.lossy()))?;
            assert_eq!(frame["method"], RESOURCE_RESOLVE);
            let mut correlation = params.clone();
            correlation["value"] = frame["params"]["value"].clone();
            if let Value::Object(fields) = &mut correlation {
                fields.shift_remove(&JsString::from("seal"));
            }
            assert_eq!(frame["params"], correlation);
            peer.send(Message::Text(
                json!({"id":frame["id"],"result":json!({
                    "accepted":true,"privateFixtureDiagnostic":"fixture-plaintext",
                })})
                .stringify()
                .into(),
            ))
            .await?;
            Ok::<_, anyhow::Error>(frame["params"]["value"].clone())
        };
        let (worker, value) = tokio::join!(worker, native);
        worker?;
        value
    }

    #[tokio::test]
    async fn resource_exchange_fences_native_owner_and_hides_private_values() -> Result<()> {
        timeout(Duration::from_secs(10), async {
            let dir = tempfile::tempdir()?;
            let server_url = "http://127.0.0.1:9";
            let identity = Identity::open(dir.path(), server_url, &"worker".into(), false)?;
            let service = Service::new(identity, server_url, crate::http::client()?)?;
            let registration = service.registration();
            let owner = json!("owner");
            let server = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
            let date = "2026-11-18T00:00:00.000Z";
            let key = [17; 32];
            let wrapped = cantrip_crypto::wrap_component_key(
                &key, &registration["publicKey"], &owner,
                &json!({"workerId":"worker","component":"task-content","keyRevision":3}),
            )?;
            service.accept_bootstrap(&json!({
                "serverId":server,"ownerId":owner,
                "principal":json!({"id":registration["principalId"],"ownerId":owner,"workerId":"worker",
                    "kind":"worker","label":Value::Null,"publicKey":registration["publicKey"],"state":"approved","revision":1,
                    "approvedAt":date,"revokedAt":Value::Null,"revokedReason":Value::Null,"createdAt":date,"updatedAt":date}),
                "grants":vec![json!({"id":uuid::Uuid::new_v4().to_string(),"ownerId":owner,
                    "principalId":registration["principalId"],"component":"task-content","keyRevision":3,
                    "wrappedKey":wrapped,"state":"active","revision":1,"revokedAt":Value::Null,"revokedReason":Value::Null,
                    "createdAt":date,"updatedAt":date})],
            }))?;
            let resources = Resources::new(Some(Grant { service: service.clone(), owner: "owner".into(), server: server.into() }), "process-runner".into());
            let listener = TcpListener::bind("127.0.0.1:0").await?;
            let diagnostics = Arc::new(Mutex::new(Vec::new()));
            let mut options = Options::local(dir.path().into(), HashMap::new());
            options.record = {
                let diagnostics = diagnostics.clone();
                Arc::new(move |value, _| diagnostics.lock().unwrap().push(value))
            };
            let args = vec!["-c".into(), format!("printf 'listening on: ws://{}\\n'; exec /bin/sleep 30", listener.local_addr()?)];
            let launch = Session::launch("/bin/sh".into(), args, options);
            let peer = async {
                Ok::<_, anyhow::Error>(tokio_tungstenite::accept_async(listener.accept().await?.0).await?)
            };
            let ((session, mut events), mut peer) = tokio::try_join!(launch, peer)?;
            resources.bind(&session, &"thread".into(), &"private-task-runner".into(), true);
            let mut params = json!({
                "threadId":"thread","turnId":"turn","checkpointId":"checkpoint",
                "runnerGeneration":"private-task-runner","requestId":uuid::Uuid::new_v4().to_string(),
                "seal":true,"value":json!({"private":"fixture-plaintext"}),
            });
            let original = params["value"].clone();
            let ciphertext = exchange(&resources, &session, &mut peer, &mut events, &params).await?;
            assert_eq!(ciphertext["formatVersion"], 2);
            assert_eq!(ciphertext["component"], "task-content");
            assert!(!ciphertext.stringify().contains("fixture-plaintext"));
            params["seal"] = json!(false);
            params["value"] = ciphertext;
            params["requestId"] = json!(uuid::Uuid::new_v4().to_string());
            let opened = exchange(&resources, &session, &mut peer, &mut events, &params).await?;
            assert_eq!(opened, original);
            params["checkpointId"] = json!("replaced-checkpoint");
            params["requestId"] = json!(uuid::Uuid::new_v4().to_string());
            assert!(exchange(&resources, &session, &mut peer, &mut events, &params).await?.is_null());

            // The worker authorized this real Task scope, so the process-wide
            // fallback may not ask to open its resources.
            params["runnerGeneration"] = json!("process-runner");
            let event = native_request(&mut peer, &mut events, &params).await?;
            resources.resolve(&event.generation, &session, &params).await?;
            assert!(timeout(Duration::from_millis(60), peer.next()).await.is_err());
            assert!(diagnostics.lock().unwrap().iter().any(|item| item["payload"]["privateNativeResources"] == true));
            assert!(diagnostics.lock().unwrap().iter().all(|item| !item.stringify().contains("fixture-plaintext")));
            drop(peer);
            session.close().await?;
            service.close().await?;
            Ok(())
        }).await?
    }
}
