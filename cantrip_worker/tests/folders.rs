use cantrip_wire::value::json;
use cantrip_worker::filesystem::{Scope, folders::Manager, paths};
use std::time::{Duration, Instant};

const PROJECT: &str = "019fe8aa-a7a3-7404-8a96-d3be7f0fb338";
const JOB: &str = "019fe8aa-a7a3-7404-8a96-d3be7f0fb339";
const WORKSPACE: &str = "019fe8aa-a7a3-7404-8a96-d3be7f0fb337";

#[tokio::test]
async fn managed_folder_reuses_private_storage_and_preserves_external_attachments() {
    let temp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let manager = Manager::new(&root.join("profile"));
    let scope = Scope::default();
    let storage = json!({"kind":"managed","workspaceId":WORKSPACE});
    let mut input = json!({"projectId":PROJECT,"jobId":JOB,"attempt":1,"workspaceStorage":storage});
    let first = manager.materialize(&input, &scope).await.unwrap();
    assert_eq!(first["reused"], false);
    let target = paths::native(first["path"].as_js_string().unwrap());
    let sibling = target.with_file_name("sibling");
    std::fs::create_dir(&sibling).unwrap();
    std::fs::write(sibling.join("kept.txt"), "sibling").unwrap();
    std::fs::write(target.join("dirty.txt"), "preserved").unwrap();
    input["attempt"] = json!(2);
    let second = manager.materialize(&input, &scope).await.unwrap();
    assert_eq!(second["reused"], true);
    assert_eq!(
        std::fs::read_to_string(target.join("dirty.txt")).unwrap(),
        "preserved"
    );
    assert_eq!(
        manager
            .resolve(&PROJECT.into(), &storage, &scope)
            .await
            .unwrap()["path"],
        first["path"]
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    assert_eq!(
        manager
            .delete(&PROJECT.into(), &storage, &scope)
            .await
            .unwrap(),
        json!({"deleted":true})
    );
    assert_eq!(
        manager
            .delete(&PROJECT.into(), &storage, &scope)
            .await
            .unwrap(),
        json!({"deleted":false})
    );
    assert_eq!(
        std::fs::read_to_string(sibling.join("kept.txt")).unwrap(),
        "sibling"
    );
    input["existingPath"] = json!(paths::text(&sibling));
    assert_eq!(
        manager.materialize(&input, &scope).await.unwrap()["reused"],
        true
    );
    assert_eq!(
        manager
            .delete(&PROJECT.into(), &storage, &scope)
            .await
            .unwrap()["deleted"],
        false
    );
    assert!(sibling.join("kept.txt").is_file());
}

#[cfg(unix)]
#[tokio::test]
async fn managed_storage_rejects_symlink_boundaries_and_invalid_project_ids_without_removing_targets()
 {
    let temp = tempfile::tempdir().unwrap();
    let data = std::fs::canonicalize(temp.path()).unwrap();
    let manager = Manager::new(&data);
    let scope = Scope::default();
    let outside = data.join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("kept.txt"), "untouched").unwrap();
    let workspaces = data.join("workspaces");
    std::fs::create_dir(&workspaces).unwrap();
    std::os::unix::fs::symlink(&outside, workspaces.join(WORKSPACE)).unwrap();
    let storage = json!({"kind":"managed","workspaceId":WORKSPACE});
    let input = json!({"projectId":PROJECT,"jobId":JOB,"attempt":1,"workspaceStorage":storage});
    assert!(
        manager
            .materialize(&input, &scope)
            .await
            .unwrap_err()
            .to_string()
            .contains("unsafe directory boundary")
    );
    assert!(
        manager
            .delete(&PROJECT.into(), &storage, &scope)
            .await
            .is_err()
    );
    assert!(!outside.join("folders").exists());
    assert!(
        manager
            .delete(&"../outside".into(), &json!({"kind":"system"}), &scope)
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read_to_string(outside.join("kept.txt")).unwrap(),
        "untouched"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn no_timeout_children_still_stop_and_join_with_their_runtime() {
    let (stop, receive) = tokio::sync::watch::channel(false);
    let scope = Scope::with_stop(receive);
    let began = Instant::now();
    let job = tokio::spawn(async move {
        scope
            .run_with_timeout(
                "/bin/sh".as_ref(),
                &["-c".into(), "sleep 30".into()],
                1024,
                None,
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(25)).await;
    stop.send_replace(true);
    assert!(
        job.await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("stopped")
    );
    assert!(began.elapsed() < Duration::from_secs(2));
}
