#![cfg(unix)]
use cantrip_config::Environment;
use cantrip_wire::JsString;
use cantrip_worker::{
    logging::Logs,
    terminal_services::{Configuration, Manager},
};
use std::{collections::HashMap, path::Path, sync::Arc, time::Duration};
async fn manager(root: &Path, delay: Duration) -> (Manager, Arc<Logs>) {
    let environment = Environment::from([("CANTRIP_LOG_LEVEL".into(), "off".into())]);
    let logs = Arc::new(Logs::initialize(&root.join("profile"), &environment, root).await);
    let mut child: HashMap<_, _> = std::env::vars().collect();
    child.insert("SHELL".into(), "/bin/sh".into());
    (
        Manager::with_restart_delay(child, logs.clone(), delay),
        logs,
    )
}
async fn until(mut condition: impl AsyncFnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !condition().await {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
fn configuration(root: &Path, command: &str) -> Configuration {
    Configuration {
        terminal_id: "service".into(),
        cwd: root.to_owned(),
        command: command.into(),
    }
}
async fn starts(root: &Path) -> usize {
    tokio::fs::read_to_string(root.join("starts"))
        .await
        .unwrap_or_default()
        .lines()
        .count()
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_pty_reconciles_restarts_hangs_up_and_closes_owned_processes() {
    let temp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let (manager, logs) = manager(&root, Duration::from_secs(5)).await;
    let command = "printf '%s\\n' started >> starts; printf '%s\\n' \"$$\" > pid; stty size; printf '😀 %s %s\\n' \"$TERM\" \"$CANTRIP_TERMINAL_ID\"; trap 'printf h >> hung-up; exit 0' HUP; while :; do /bin/sleep 0.05; done";
    let config = configuration(&root, command);
    manager.reconcile(vec![config.clone()]).await.unwrap();
    until(async || {
        manager
            .output(&JsString::from("service"))
            .await
            .is_some_and(|v| {
                v["buffer"]
                    .as_str()
                    .is_some_and(|v| v.contains("24 80") && v.contains("😀 xterm-256color service"))
            })
    })
    .await;
    manager.reconcile(vec![config.clone()]).await.unwrap();
    assert_eq!(starts(&root).await, 1);
    let first_pid = tokio::fs::read_to_string(root.join("pid"))
        .await
        .unwrap()
        .trim()
        .parse::<i32>()
        .unwrap();
    manager.restart(&"service".into()).await.unwrap();
    until(async || starts(&root).await >= 2).await;
    assert_eq!(
        tokio::fs::read_to_string(root.join("hung-up"))
            .await
            .unwrap(),
        "h"
    );
    // Probe only: termination used the live PTY handle, never this marker PID.
    assert_eq!(unsafe { libc::kill(first_pid, 0) }, -1);
    manager.reconcile(vec![]).await.unwrap();
    manager.reconcile(vec![config]).await.unwrap();
    until(async || starts(&root).await >= 3).await;
    manager
        .reconcile(vec![configuration(
            &root,
            "printf changed > changed; exec /bin/sleep 30",
        )])
        .await
        .unwrap();
    until(async || root.join("changed").exists()).await;
    manager.reconcile(vec![]).await.unwrap();
    until(async || {
        manager
            .output(&"service".into())
            .await
            .is_some_and(|v| v["phase"] == "exited")
    })
    .await;
    assert!(
        manager
            .restart(&"service".into())
            .await
            .unwrap_err()
            .to_string()
            .contains("disabled")
    );
    manager.close().await.unwrap();
    logs.close().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exited_and_failed_starts_retry_and_shutdown_cancels_pending_restarts() {
    let temp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let (manager, logs) = manager(&root, Duration::from_millis(50)).await;
    manager
        .reconcile(vec![configuration(
            &root,
            "printf 'started\\n' >> starts; exit 7",
        )])
        .await
        .unwrap();
    until(async || starts(&root).await >= 3).await;
    manager.close().await.unwrap();
    let count = starts(&root).await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(starts(&root).await, count);
    logs.close().await;
    let (manager, logs) = self::manager(&root, Duration::from_millis(50)).await;
    let missing = root.join("missing");
    // Even a cwd regression must only attempt writes in this owned fixture.
    let marker = missing.join("recovered");
    let command = format!(
        "printf recovered > '{}'; exec /bin/sleep 30",
        marker.to_string_lossy().replace('\'', "'\\''")
    );
    manager
        .reconcile(vec![configuration(&missing, &command)])
        .await
        .unwrap();
    until(async || {
        manager
            .output(&"service".into())
            .await
            .is_some_and(|v| v["phase"] == "restarting")
    })
    .await;
    tokio::fs::create_dir(&missing).await.unwrap();
    until(async || missing.join("recovered").exists()).await;
    manager.close().await.unwrap();
    logs.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_reaps_an_owned_service_that_ignores_hangup() {
    let temp = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(temp.path()).unwrap();
    let (manager, logs) = manager(&root, Duration::from_secs(5)).await;
    manager
        .reconcile(vec![configuration(
            &root,
            "trap '' HUP; printf '%s\\n' \"$$\" > pid; exec /bin/sleep 30",
        )])
        .await
        .unwrap();
    until(async || {
        tokio::fs::read_to_string(root.join("pid"))
            .await
            .is_ok_and(|value| value.trim().parse::<i32>().is_ok())
    })
    .await;
    let pid = tokio::fs::read_to_string(root.join("pid"))
        .await
        .unwrap()
        .trim()
        .parse::<i32>()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), manager.close())
        .await
        .unwrap()
        .unwrap();
    // Probe only; escalation and reaping used the actual owned process handle.
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    logs.close().await;
}
