use super::*;
use crate::{computer_use::Javascript, encryption::Identity, http};
use cantrip_crypto::content::{Communication, decrypt_communication, encrypt_communication};
use std::{path::Path, time::Duration};
use tokio::{sync::mpsc, time::timeout};

const OWNER: &str = "fixture-owner";
const SERVER: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY: &[u8; 32] = &[57; 32];

fn service(data: &Path) -> Result<Arc<Service>> {
    let url = "https://fixture.invalid";
    let encryption = Service::new(
        Identity::open(data, url, &"worker".into(), false)?,
        url,
        http::client()?,
    )?;
    let registration = encryption.registration();
    let wrapped = cantrip_crypto::wrap_component_key(
        KEY,
        &registration["publicKey"],
        &json!(OWNER),
        &json!({"workerId":"worker","component":"interaction-content","keyRevision":1}),
    )?;
    let at = "2026-11-20T00:00:00.000Z";
    encryption.accept_bootstrap(&json!({
        "serverId":SERVER,"ownerId":OWNER,
        "principal":json!({"id":registration["principalId"],"ownerId":OWNER,"kind":"worker","workerId":"worker",
            "label":Value::Null,"publicKey":registration["publicKey"],"state":"approved","revision":1,
            "approvedAt":at,"revokedAt":Value::Null,"revokedReason":Value::Null,"createdAt":at,"updatedAt":at}),
        "grants":vec![json!({"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","ownerId":OWNER,"principalId":registration["principalId"],
            "component":"interaction-content","keyRevision":1,"wrappedKey":wrapped,"state":"active","revision":1,
            "revokedAt":Value::Null,"revokedReason":Value::Null,"createdAt":at,"updatedAt":at})],
    }))?;
    Ok(encryption)
}

fn answer(authority: &Value, key: &Value, permissions: &Value) -> Result<Value> {
    let classification = json!({"kind":"permissions"});
    let protected = encrypt_communication(
        Communication::InteractionResponse,
        KEY,
        &json!({"ownerId":OWNER,"requestKey":key,"keyRevision":1}),
        &json!({"version":1,"classification":classification,"response":json!({
            "kind":"permissions","permissions":permissions,"scope":"turn","strictAutoReview":false,
        })}),
    )?;
    Ok(
        json!({"type":"computer-use.approval.respond","ownerId":OWNER,"chatId":"chat",
            "executionLaneId":"lane","requestKey":key,"agentAuthority":authority,
            "response":json!({"classification":classification,"protectedResponse":protected}),
        }),
    )
}

#[tokio::test]
async fn protected_agent_approval_resumes_only_the_matching_live_action() -> Result<()> {
    let data = tempfile::tempdir()?;
    let encryption = service(data.path())?;
    let outgoing = Arc::new(Outbound::default());
    outgoing.ready_for_test();
    let epoch = *outgoing.stream_epoch().borrow();
    let (queue, _messages) = mpsc::channel(1);
    let (desktop, _retirements) =
        super::super::Previews::new(data.path().into(), encryption.clone(), outgoing, queue);
    let authority = json!({
        "serverId":SERVER,"ownerId":OWNER,"workerId":"worker","chatId":"chat",
        "projectId":Value::Null,"contextKind":"standalone","placementId":"scratch",
        "executionLaneId":"lane","generation":5,"cantripAppAllowed":false,
        "profile":json!({"selectedId":":workspace","effectiveId":":workspace","forcedByWorktreePolicy":false,"usesDefault":true}),
    });
    let (_retire, turn) = Abort::new();
    let (_, call) = Abort::new();
    let javascript = Javascript::new(
        data.path().join("unused-helper"),
        Vec::new(),
        json!({
            "workerId":"worker","chatId":"chat","sessionId":"session","threadId":"thread","turnId":"turn","taskId":Value::Null,
        }),
        turn,
    )?;
    let bound = desktop.bind_turn(&authority, &javascript, epoch)?;
    let (send, mut events) = mpsc::unbounded_channel();
    let publish = |event| send.send(event).context("Approval fixture stream closed.");
    let target = json!({"targetId":"window","targetGeneration":2});
    let capture = || HostAction {
        operation: Some("observation.snapshot"),
        target: target.clone(),
    };
    let press = || HostAction {
        operation: Some("input.press"),
        target: target.clone(),
    };
    let request_id = uuid::Uuid::new_v4();
    let wait = bound.approve_action(capture(), request_id, call.clone(), publish);
    let serve = async {
        let event: Value = events.recv().await.unwrap();
        assert_eq!(event["operationId"], request_id.to_string());
        let request = &event["request"];
        let key = &request["requestKey"];
        assert_eq!(request["provenance"]["threadId"], "thread");
        assert_eq!(request["provenance"]["turnId"], "turn");
        assert_eq!(request["provenance"]["executionLaneId"], "lane");
        let opened = decrypt_communication(
            Communication::InteractionRequest,
            KEY,
            &json!({"ownerId":OWNER,"requestKey":key,"keyRevision":1}),
            &request["protectedPayload"],
            Some(&request["classification"]),
        )?;
        let permissions = &opened["payload"]["requestedPermissions"];
        assert_eq!(
            *permissions,
            json!({"computerUse":json!({"version":1,"classes":["capture"],"target":target})})
        );
        let reply = answer(&authority, key, permissions)?;
        let mut wrong_lane = reply.clone();
        wrong_lane["agentAuthority"]["executionLaneId"] = json!("another-lane");
        wrong_lane["executionLaneId"] = json!("another-lane");
        assert!(
            desktop
                .execute(&wrong_lane, epoch, |_| Ok(()))
                .await
                .is_err()
        );
        let mut wrong_target = permissions.clone();
        wrong_target["computerUse"]["target"]["targetGeneration"] = json!(1);
        assert!(
            desktop
                .execute(&answer(&authority, key, &wrong_target)?, epoch, |_| Ok(()))
                .await
                .is_err()
        );
        assert_eq!(
            desktop.execute(&reply, epoch, |_| Ok(())).await?,
            json!({"accepted":true})
        );
        assert_eq!(
            desktop.execute(&reply, epoch, |_| Ok(())).await?,
            json!({"accepted":true})
        );
        Ok::<_, anyhow::Error>(reply)
    };
    let (approval, reply) =
        timeout(Duration::from_secs(5), async { tokio::join!(wait, serve) }).await?;
    let reply = reply?;
    assert!(approval.is_ok());
    let reuse = bound
        .approve_action(capture(), uuid::Uuid::new_v4(), call.clone(), |_| {
            panic!("Exact turn grant prompts again")
        })
        .await;
    assert!(reuse.is_ok());

    let (cancel, pending_call) = Abort::new();
    let waiting = bound.approve_action(press(), uuid::Uuid::new_v4(), pending_call, publish);
    let interrupted = async {
        let event: Value = events.recv().await.unwrap();
        let request = &event["request"];
        let key = &request["requestKey"];
        let opened = decrypt_communication(
            Communication::InteractionRequest,
            KEY,
            &json!({"ownerId":OWNER,"requestKey":key,"keyRevision":1}),
            &request["protectedPayload"],
            Some(&request["classification"]),
        )?;
        assert_eq!(
            opened["payload"]["requestedPermissions"]["computerUse"]["classes"],
            json!(["native-input"])
        );
        cancel.abort(anyhow::anyhow!("Fixture abandoned the host call."));
        let terminal: Value = events.recv().await.unwrap();
        assert_eq!(
            terminal,
            json!({"type":"computer-use.approval.terminal","chatId":"chat","requestKey":key,"status":"interrupted"})
        );
        let late = answer(&authority, key, &opened["payload"]["requestedPermissions"])?;
        assert!(desktop.execute(&late, epoch, |_| Ok(())).await.is_err());
        Ok::<_, anyhow::Error>(())
    };
    let (approval, terminal) = timeout(Duration::from_secs(5), async {
        tokio::join!(waiting, interrupted)
    })
    .await?;
    terminal?;
    assert!(matches!(approval, Err(error) if error.code() == "cancelled"));
    desktop.cancel_chat(&json!("chat"));
    assert!(desktop.execute(&reply, epoch, |_| Ok(())).await.is_err());
    encryption.close().await?;
    Ok(())
}
