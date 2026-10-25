//! Recover only on WebKit's actual process-death notification, never a timeout.
use std::sync::atomic::Ordering;
use tauri::Manager;

pub fn recover(webview: &tauri::Webview) {
    let app = webview.app_handle();
    if app
        .try_state::<crate::DesktopExitState>()
        .is_some_and(|state| state.approved.load(Ordering::SeqCst))
        || app
            .try_state::<crate::desktop_quit::DesktopQuit>()
            .is_some_and(|state| !state.renderer_terminated(webview.label()))
    {
        return;
    }
    // Keep the same native window, URL and workspace identity. The replacement
    // JavaScript context takes its lifetime lock, claims a new attachment
    // generation, and reconciles interrupted transfers through the usual path.
    // Reload does not close/return a pane or recreate any resource.
    let result = webview.reload();
    if let Some(logs) = app.try_state::<crate::local_logs::LocalServiceLogs>() {
        logs.runtime_event(
            if result.is_ok() { "warn" } else { "error" },
            "Web content process terminated",
            Some(serde_json::json!({
                "event": "desktop.renderer.terminated",
                "subsystem": "desktop-window",
                "operation": "reload-renderer",
                "window": webview.label(),
                "status": if result.is_ok() { "reload-requested" } else { "failed" },
                "error": result.err().map(|error| error.to_string()),
            })),
        );
    }
}

// The fault injector is absent from release builds and requires an explicitly
// opted-in, uniquely named disposable app. It never searches/kills WebKit by name.
#[cfg(debug_assertions)]
pub fn qa_enabled(app: &tauri::AppHandle) -> bool {
    qa_scope_matches(
        std::env::var("CANTRIP_QA_RENDERER_CRASH").ok().as_deref(),
        std::env::var("CANTRIP_QA_BUNDLE_ID").ok().as_deref(),
        &app.config().identifier,
    )
}

#[cfg(any(debug_assertions, test))]
fn qa_scope_matches(opt_in: Option<&str>, bundle: Option<&str>, actual: &str) -> bool {
    opt_in == Some("true")
        && bundle.is_some_and(|id| {
            id == actual
                && id
                    .strip_prefix("art.cantrip.qa.workspace")
                    .is_some_and(|suffix| {
                        suffix.len() == 32 && suffix.bytes().all(|c| c.is_ascii_hexdigit())
                    })
        })
}

#[cfg(debug_assertions)]
pub fn qa_crash_focused(app: &tauri::AppHandle) {
    if !qa_enabled(app) {
        return;
    }
    let Some(window) = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
    else {
        return;
    };
    let label = window.label().to_string();
    let result = window.with_webview(move |platform| {
        // Diagnostic-only WebKit API gives the PID for this exact native view.
        // If unavailable, fail explicitly rather than targeting shared processes.
        let view = unsafe { &*platform.inner().cast::<objc2::runtime::AnyObject>() };
        let supported: bool = unsafe { objc2::msg_send![view, respondsToSelector: objc2::sel!(_webProcessIdentifier)] };
        if !supported {
            eprintln!("QA_EVT {}", serde_json::json!({"event":"renderer.crash-injection","status":"fail","reason":"WebKit diagnostic PID API unavailable"}));
            return;
        }
        let pid: i32 = unsafe { objc2::msg_send![view, _webProcessIdentifier] };
        let valid = pid > 1 && pid != std::process::id() as i32;
        let killed = valid && unsafe { libc::kill(pid, libc::SIGKILL) } == 0;
        eprintln!("QA_EVT {}", serde_json::json!({"event":"renderer.crash-injection","status":if killed {"info"} else {"fail"},"window":label,"pid":pid,"killed":killed}));
    });
    if let Err(error) = result {
        eprintln!(
            "QA_EVT {}",
            serde_json::json!({"event":"renderer.crash-injection","status":"fail","error":error.to_string()})
        );
    }
}

#[cfg(test)]
mod tests {
    use super::qa_scope_matches;
    #[test]
    fn fault_injection_requires_explicit_opt_in_and_exact_disposable_app_identity() {
        let id = "art.cantrip.qa.workspace0123456789abcdef0123456789abcdef";
        assert!(qa_scope_matches(Some("true"), Some(id), id));
        assert!(!qa_scope_matches(None, Some(id), id));
        assert!(!qa_scope_matches(Some("false"), Some(id), id));
        assert!(!qa_scope_matches(Some("true"), None, id));
        assert!(!qa_scope_matches(Some("true"), Some(id), "art.cantrip"));
        for invalid in [
            "art.cantrip",
            "art.cantrip.qa.workspace",
            "art.cantrip.qa.workspace0123456789abcdef0123456789abcdeg",
        ] {
            assert!(!qa_scope_matches(Some("true"), Some(invalid), invalid));
        }
    }
}
