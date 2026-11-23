use super::*;
use cantrip_wire::parse_json_text;
use std::time::Duration;
use tokio::{sync::oneshot, time::timeout};

fn input(thread: Option<&str>, prepare: Prepare) -> Input {
    Input {
        identity: Identity {
            server_id: "server".into(),
            owner_id: "owner".into(),
            worker_id: "worker".into(),
            chat_id: "chat".into(),
            placement_id: "worktree".into(),
            project_id: Some("project".into()),
            context_kind: "project",
        },
        target: Target {
            thread_id: thread.map(Into::into),
            cwd: "/workspace/project".into(),
            execution_profile: "ide",
            model_route_id: "route".into(),
            provider_id: "provider".into(),
            provider_kind: "openai-compatible".into(),
            provider_account_id: Some("account".into()),
            credential_home_key: Some("home".into()),
            intent: Intent::Preserve,
        },
        unbound_reuse_key: None,
        replacement_settings: None,
        prepare,
        on_identified: None,
        on_prepared: None,
    }
}

fn selected(expected: Option<&str>, intent: Intent, result: &'static str) -> Prepare {
    let expected = expected.map(JsString::from);
    Box::new(move |selection, identify| {
        Box::pin(async move {
            assert_eq!(selection.thread_id, expected);
            assert_eq!(selection.intent, intent);
            identify(result.into()).await?;
            Ok(result.into())
        })
    })
}

fn journal(data: &Path) -> std::path::PathBuf {
    // SHA-256 of Node JSON.stringify(["server","owner","worker","chat"]).
    data.join("managed-chat-sessions")
        .join("9a458221909a44aeba376342ebc55585a60d6c0fd23a905e3b22028ce02fb815.json")
}

#[tokio::test]
async fn adopts_a_matching_node_v1_record_before_a_same_account_route_change() -> Result<()> {
    let data = tempfile::tempdir()?;
    let path = journal(data.path());
    tokio::fs::create_dir_all(path.parent().unwrap()).await?;
    tokio::fs::write(
        &path,
        br#"{"version":1,"identity":"4d6d423af696ffe091233aae917da4dc8e46f9b4b3510ccb1eff7b70c38ed0db","threadId":"native","prepared":true}"#,
    )
    .await?;
    assert_eq!(
        Coordinator::new(data.path())
            .prepare(input(
                None,
                selected(Some("native"), Intent::Preserve, "native")
            ))
            .await?,
        JsString::from("native")
    );
    let upgraded = tokio::fs::read_to_string(&path).await?;
    let upgraded = parse_json_text(&upgraded).unwrap();
    assert_eq!(upgraded["version"], 2);
    assert_eq!(
        upgraded["identity"],
        "a7468179dd224ffc6bbf04472f7af6873badf655cb1ae5699327b24d5faaeffb"
    );
    let mut reroute = input(None, selected(Some("native"), Intent::Preserve, "native"));
    reroute.target.model_route_id = "another-route".into();
    Coordinator::new(data.path()).prepare(reroute).await?;
    let mut another_account = input(None, selected(None, Intent::Configure, "separate"));
    another_account.target.provider_account_id = Some("other-account".into());
    Coordinator::new(data.path())
        .prepare(another_account)
        .await?;
    let overridden = input(
        Some("committed"),
        selected(Some("committed"), Intent::Preserve, "committed"),
    );
    Coordinator::new(data.path()).prepare(overridden).await?;
    Ok(())
}

#[tokio::test]
async fn serializes_creation_even_when_the_original_caller_abandons_its_response() -> Result<()> {
    let data = tempfile::tempdir()?;
    let coordinator = Coordinator::new(data.path());
    let (identified, received) = oneshot::channel();
    let (release, wait) = oneshot::channel();
    let prepare = Box::new(
        move |selection: Selection, identify: Identify| -> Work<JsString> {
            Box::pin(async move {
                assert!(selection.thread_id.is_none());
                identify("native".into()).await?;
                identified.send(()).unwrap();
                wait.await?;
                Ok("native".into())
            })
        },
    );
    let first = coordinator.prepare(input(None, prepare));
    timeout(Duration::from_secs(3), received).await??;
    drop(first);
    let view = coordinator.prepare(input(
        None,
        selected(Some("native"), Intent::Preserve, "native"),
    ));
    release.send(()).unwrap();
    assert_eq!(
        timeout(Duration::from_secs(3), view).await??,
        JsString::from("native")
    );
    Ok(())
}

#[tokio::test]
async fn only_a_committed_replacement_redirects_an_old_canonical_view() -> Result<()> {
    let data = tempfile::tempdir()?;
    let coordinator = Coordinator::new(data.path());
    coordinator
        .prepare(input(None, selected(None, Intent::Configure, "source")))
        .await?;
    let mut replacement = input(Some("source"), selected(None, Intent::Configure, "target"));
    replacement.on_prepared = Some(Box::new(|_| {
        Box::pin(async { bail!("Fixture canonical commit failed.") })
    }));
    assert_eq!(
        coordinator
            .replace(
                replacement,
                Replacement {
                    previous_thread: "source".into(),
                    capture_settings: None,
                }
            )
            .await
            .unwrap_err()
            .to_string(),
        "Fixture canonical commit failed."
    );
    coordinator
        .prepare(input(
            Some("source"),
            selected(Some("source"), Intent::Preserve, "source"),
        ))
        .await?;
    let restored = Coordinator::new(data.path());
    let mut complete = input(
        Some("source"),
        selected(Some("target"), Intent::Preserve, "target"),
    );
    complete.on_prepared = Some(Box::new(|_| Box::pin(async { Ok(()) })));
    restored
        .replace(
            complete,
            Replacement {
                previous_thread: "source".into(),
                capture_settings: Some(Box::new(|| {
                    panic!("A prepared replacement never recaptures old settings.")
                })),
            },
        )
        .await?;
    restored
        .prepare(input(
            Some("source"),
            selected(Some("target"), Intent::Preserve, "target"),
        ))
        .await?;
    Ok(())
}
