use super::*;

const SESSION: &str = "772890cf-0396-4da0-8d4d-8f11269f8a50";
const GRANT: &str = "e08958c9-35aa-46b8-9cb2-bc60d791b114";

fn fixture() -> (i64, Value, Value) {
    let lease = json!({
        "issuedAt":"2026-01-01T00:00:00.000Z",
        "expiresAt":"2026-01-01T00:01:00.000Z",
        "absoluteExpiresAt":"2026-01-01T00:04:00.000Z",
    });
    let identity = json!({
        "serverId":"server","serverGeneration":"server-process","ownerId":"owner",
        "accountSessionId":"account","clientInstanceId":"client","workerId":"worker",
        "workerProcessGeneration":"worker-process",
    });
    let session = checked(
        "workerLinkSessionSchema",
        &json!({
            "sessionId":SESSION,"identity":identity,"lease":lease,"routeGeneration":1,
            "routePolicy":json!({"priority":["local","lan","wan","relay"],"enabled":["local","relay"]}),
            "preferredRoute":"local",
        }),
    )
    .unwrap();
    let subscription = "3a706a56-4f23-4f66-a870-ad3faa7d22b8";
    let mut grant_lease = lease.clone();
    grant_lease["expiresAt"] = json!("2026-01-01T00:00:30.000Z");
    let grant = checked(
        "installedWorkerLinkGrantSchema",
        &json!({
            "binding":json!({
                "grantId":GRANT,"grantGeneration":1,"sessionId":SESSION,"identity":identity,
                "resource":json!({"kind":"observations","resourceId":"worker","attachmentId":subscription}),
                "lanes":["events"],"operations":["events:subscribe"],"maxChannels":1,"lease":grant_lease,
            }),
            "tokenHash":"a".repeat(64),
            "observation":json!({"subscriptionId":subscription,"topics":["filesystem"]}),
        }),
    )
    .unwrap();
    (
        timestamp(&lease, "issuedAt").unwrap() + 1000,
        session,
        grant,
    )
}

#[test]
fn session_replacement_fences_prior_grant_generation() {
    let (now, session, grant) = fixture();
    let mut state = State::default();
    state.install_session(&session, now).unwrap();
    state.install_session(&session, now).unwrap();
    state.install_grant(&SESSION.into(), &grant, now).unwrap();

    let mut next = session.clone();
    let next_id = "449a3f3b-31b7-44b1-a52c-6a90c496fb10";
    next["sessionId"] = json!(next_id);
    state.install_session(&next, now).unwrap();
    assert!(!state.sessions.contains_key(&JsString::from(SESSION)));
    let mut replay = grant.clone();
    replay["binding"]["sessionId"] = json!(next_id);
    assert_eq!(
        state
            .install_grant(&next_id.into(), &replay, now)
            .unwrap_err()
            .to_string(),
        "WorkerLink grant generation was already revoked."
    );
    replay["binding"]["grantGeneration"] = json!(2);
    state.install_grant(&next_id.into(), &replay, now).unwrap();
    assert!(!state.revoke_grant(&next_id.into(), &GRANT.into(), 1, "revoked"));
    assert!(state.revoke_grant(&next_id.into(), &GRANT.into(), 2, "revoked"));
}

#[test]
fn grant_deadlines_and_disconnect_grace_retire_authority() {
    let (now, session, grant) = fixture();
    let mut state = State::default();
    state.install_session(&session, now).unwrap();

    let mut overlong = grant.clone();
    overlong["binding"]["lease"]["expiresAt"] = json!("2026-01-01T00:02:00.000Z");
    assert!(
        state
            .install_grant(&SESSION.into(), &overlong, now)
            .is_err()
    );
    state.install_grant(&SESSION.into(), &grant, now).unwrap();

    state.disconnect = Some(Instant::now() + GRACE);
    let identity = ("owner".into(), json!("server"));
    state.sweep(now, Some(&identity));
    assert_eq!(state.sessions.len(), 1);
    // A grant can expire while the session and its disconnect grace still live.
    state.sweep(
        expiration(&grant["binding"]["lease"]).unwrap(),
        Some(&identity),
    );
    assert!(
        state
            .session_mut(&SESSION.into())
            .unwrap()
            .grants
            .is_empty()
    );
    assert_eq!(state.tombstones.get(&JsString::from(GRANT)), Some(&1));

    state.disconnect = Some(Instant::now());
    state.sweep(now, Some(&identity));
    assert!(state.sessions.is_empty());
    assert!(state.disconnect.is_none());
}

#[test]
fn filesystem_relay_carries_invalidation_without_private_filenames() {
    let source = "ctrr_route";
    let observation = Observation::from_notification(&json!({
        "type":"worktree.filesystem.changed",
        "projectId":"772890cf-0396-4da0-8d4d-8f11269f8a50",
        "worktreeId":"worktree","sourcePath":source,"worktreePath":source,
        "changes":[json!({"kind":"modified","path":"private-file.txt"})],
    }))
    .unwrap();
    let subscription = json!("3a706a56-4f23-4f66-a870-ad3faa7d22b8");
    let bytes = observation.envelope(&subscription, 4, 9).unwrap();
    let value = cantrip_wire::parse_json_text(std::str::from_utf8(&bytes).unwrap()).unwrap();
    assert_eq!(value["payload"]["topic"], "filesystem");
    assert_eq!(value["payload"]["notification"]["worktreePath"], source);
    assert!(value["payload"]["notification"].get("changes").is_none());
    assert_eq!(value["continuitySequence"], 4);
    assert_eq!(value["identity"]["sequence"], 9);
}
