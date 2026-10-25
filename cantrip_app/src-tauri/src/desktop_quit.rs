//! Quit and installation wait for real renderer checkpoints. No draft bytes cross this API.
use std::{
    collections::BTreeMap,
    sync::{Condvar, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

#[derive(Default)]
struct Round {
    id: u64,
    expected: BTreeMap<String, String>,
    replies: BTreeMap<String, bool>,
    failed: bool,
}
impl Round {
    fn acknowledge(&mut self, label: &str, token: &str, id: u64, ok: bool) -> Result<(), String> {
        if self.id != id || self.expected.get(label).map(String::as_str) != Some(token) {
            return Err("Stale or foreign shutdown acknowledgement.".into());
        }
        if !ok {
            self.failed = true;
        }
        self.replies.insert(label.into(), ok);
        Ok(())
    }
    fn ready(&self) -> bool {
        !self.failed
            && self
                .expected
                .keys()
                .all(|label| self.replies.get(label) == Some(&true))
    }
}
#[derive(Default)]
struct State {
    renderers: BTreeMap<String, String>,
    sequence: u64,
    round: Option<Round>,
    committed: bool,
}
impl State {
    fn cancel(&mut self, id: u64) -> bool {
        if self.round.as_ref().is_none_or(|round| round.id != id) {
            return false;
        }
        self.round = None;
        self.committed = false;
        true
    }
}
#[derive(Default)]
pub struct DesktopQuit {
    state: Mutex<State>,
    changed: Condvar,
}

#[tauri::command]
pub fn register_desktop_quit(
    window: tauri::WebviewWindow,
    token: String,
    state: tauri::State<'_, DesktopQuit>,
) -> Result<(), String> {
    if token.is_empty() || token.len() > 64 {
        return Err("Invalid renderer identity.".into());
    }
    let mut inner = state
        .state
        .lock()
        .map_err(|_| "Shutdown state unavailable.")?;
    if inner.committed {
        return Err("Desktop shutdown has committed.".into());
    }
    if let Some(round) = inner.round.as_mut() {
        round.failed = true;
        state.changed.notify_all();
    }
    inner.renderers.insert(window.label().into(), token);
    Ok(())
}

#[tauri::command]
pub fn acknowledge_desktop_quit(
    window: tauri::WebviewWindow,
    id: u64,
    token: String,
    ok: bool,
    state: tauri::State<'_, DesktopQuit>,
) -> Result<(), String> {
    let mut inner = state
        .state
        .lock()
        .map_err(|_| "Shutdown state unavailable.")?;
    inner
        .round
        .as_mut()
        .ok_or("No shutdown is preparing.")?
        .acknowledge(window.label(), &token, id, ok)?;
    state.changed.notify_all();
    Ok(())
}

#[cfg(desktop)]
pub struct Checkpoint {
    app: tauri::AppHandle,
    id: u64,
    labels: Vec<String>,
    retained: bool,
}

#[cfg(desktop)]
impl Checkpoint {
    /// Once services stop or installation starts, keep editors frozen until exit.
    pub fn retain_until_exit(mut self) {
        self.retained = true;
    }
}

#[cfg(desktop)]
impl Drop for Checkpoint {
    fn drop(&mut self) {
        if self.retained {
            return;
        }
        let state = self.app.state::<DesktopQuit>();
        let cancelled = state
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .cancel(self.id);
        if cancelled {
            for label in &self.labels {
                let _ = self.app.emit_to(label, "cantrip-quit-cancel", self.id);
            }
        }
    }
}

/// Wait off the main thread so renderer acknowledgements can still be processed.
#[cfg(desktop)]
pub async fn checkpoint(app: tauri::AppHandle) -> Result<Checkpoint, String> {
    tauri::async_runtime::spawn_blocking(move || checkpoint_blocking(app))
        .await
        .map_err(|_| "Desktop checkpoint could not finish.".to_string())?
}

#[cfg(desktop)]
fn checkpoint_blocking(app: tauri::AppHandle) -> Result<Checkpoint, String> {
    let state = app.state::<DesktopQuit>();
    let (id, labels) = {
        let mut inner = state
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if inner.round.is_some() || inner.committed {
            return Err("Another desktop shutdown is already preparing.".into());
        }
        inner.sequence += 1;
        let id = inner.sequence;
        let expected: BTreeMap<_, _> = inner
            .renderers
            .iter()
            .filter(|(label, _)| app.get_webview_window(label).is_some())
            .map(|(label, token)| (label.clone(), token.clone()))
            .collect();
        let labels: Vec<_> = expected.keys().cloned().collect();
        inner.round = Some(Round {
            id,
            expected,
            ..Round::default()
        });
        (id, labels)
    };
    app.state::<crate::local_logs::LocalServiceLogs>().runtime_event(
        "info", "Protecting drafts before desktop quit",
        Some(serde_json::json!({"event":"desktop.quit.checkpoint-started","round":id,"windows":labels.len()})),
    );
    for label in &labels {
        if app.emit_to(label, "cantrip-quit-prepare", id).is_err() {
            if let Some(round) = state
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .round
                .as_mut()
            {
                round.failed = true;
            }
        }
    }
    let checkpoint = Checkpoint {
        app: app.clone(),
        id,
        labels: labels.clone(),
        retained: false,
    };
    let state = app.state::<DesktopQuit>();
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut inner = state
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    loop {
        let round = inner.round.as_ref().expect("quit owns its round");
        if round.failed || round.ready() {
            break;
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        let (next, _) = state
            .changed
            .wait_timeout(inner, remaining)
            .unwrap_or_else(|error| error.into_inner());
        inner = next;
    }
    let ready = inner.round.as_ref().is_some_and(Round::ready)
        && labels
            .iter()
            .all(|label| app.get_webview_window(label).is_some());
    app.state::<crate::local_logs::LocalServiceLogs>().runtime_event(
            if ready { "info" } else { "warn" }, "Desktop quit checkpoint finished",
            Some(serde_json::json!({"event":"desktop.quit.checkpoint-finished","round":id,"ready":ready,"replies":inner.round.as_ref().map(|r| r.replies.len())})),
        );
    if ready {
        // Keep the round fenced until exit; late registrations cannot become editors.
        inner.committed = true;
        drop(inner);
        Ok(checkpoint)
    } else {
        drop(inner);
        drop(checkpoint);
        Err("One or more windows could not finish protecting their drafts. Check recovery errors and retry. No files were saved or discarded.".into())
    }
}

#[cfg(desktop)]
pub fn prepare(app: tauri::AppHandle) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    tauri::async_runtime::spawn(async move {
        match checkpoint(app.clone()).await {
            Ok(checkpoint) => {
                checkpoint.retain_until_exit();
                crate::approve_desktop_exit(&app);
                app.exit(0);
            }
            Err(message) => {
                let mut dialog = app
                    .dialog()
                    .message(message)
                    .title("Cantrip stayed open")
                    .kind(MessageDialogKind::Error);
                if let Some(window) = app.get_webview_window("main") {
                    dialog = dialog.parent(&window);
                }
                dialog.show(|_| {});
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelling_a_checkpoint_releases_only_its_own_shutdown_fence() {
        let mut state = State {
            round: Some(Round {
                id: 3,
                ..Round::default()
            }),
            committed: true,
            ..State::default()
        };
        assert!(!state.cancel(2));
        assert!(state.committed);
        assert_eq!(state.round.as_ref().unwrap().id, 3);
        assert!(state.cancel(3));
        assert!(!state.committed);
        assert!(state.round.is_none());
        assert!(!state.cancel(3));
    }
    #[test]
    fn waits_for_every_exact_renderer_and_rejects_stale_replies() {
        let mut round = Round {
            id: 2,
            expected: BTreeMap::from([("main".into(), "a".into()), ("popout".into(), "b".into())]),
            ..Round::default()
        };
        assert!(!round.ready());
        assert!(round.acknowledge("main", "old", 2, true).is_err());
        assert!(round.acknowledge("main", "a", 1, true).is_err());
        assert!(round.acknowledge("foreign", "a", 2, true).is_err());
        round.acknowledge("main", "a", 2, true).unwrap();
        assert!(!round.ready());
        round.acknowledge("popout", "b", 2, true).unwrap();
        assert!(round.ready());
    }
    #[test]
    fn failure_is_not_overwritten_by_a_later_success() {
        let mut round = Round {
            id: 1,
            expected: BTreeMap::from([("main".into(), "a".into())]),
            ..Round::default()
        };
        round.acknowledge("main", "a", 1, false).unwrap();
        round.acknowledge("main", "a", 1, true).unwrap();
        assert!(!round.ready());
    }
}
