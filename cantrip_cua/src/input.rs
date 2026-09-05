//! Bounded input metadata. Native handles never leave the backend.
use crate::target::Bounds;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Control {
    pub reference: String,
    pub role: String,
    pub label: Option<String>,
    pub bounds: Option<Bounds>,
    pub actions: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Controls {
    pub controls: Vec<Control>,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputReceipt {
    pub method: &'static str,
    pub activation: bool,
    // AX confirms action dispatch, never the user's intended application result.
    pub outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<crate::target::Point>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub global_position: Option<crate::target::Point>,
}

#[cfg(test)]
mod tests {
    use crate::service::Operation;
    use serde_json::json;
    #[test]
    fn input_contract_uses_worker_camel_case_fields() {
        for operation in ["controls.inspect", "input.press", "input.click"] {
            let mut value = json!({"operation":operation, "binding":{"sessionId":"s","workerId":"w","chatId":"c","taskId":null,"threadId":null,"turnId":null}, "targetId":"window", "targetGeneration":1});
            if operation == "input.press" {
                value["reference"] = json!("control-1");
            }
            if operation == "input.click" {
                value["position"] = json!({"x":12.25,"y":5.0});
            }
            let parsed: Operation = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), value);
        }
    }
}

/// Dispatch the pair exactly once. Once down is attempted, unwinding or
/// cancellation must not skip the corresponding up cleanup.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn dispatch_single_click(
    cancel: &crate::cancellation::Cancellation,
    down: impl FnOnce(),
    up: impl FnOnce(),
) -> crate::error::Result<()> {
    struct Release<F: FnOnce()>(Option<F>);
    impl<F: FnOnce()> Drop for Release<F> {
        fn drop(&mut self) {
            if let Some(up) = self.0.take() {
                up();
            }
        }
    }
    cancel.check()?;
    let release = Release(Some(up));
    down();
    drop(release);
    Ok(())
}

#[cfg(test)]
mod dispatch_tests {
    use super::dispatch_single_click;
    use crate::cancellation::Cancellation;
    use std::cell::RefCell;
    #[test]
    fn stop_after_down_still_releases_without_replaying_down() {
        let cancel = Cancellation::default();
        let events = RefCell::new(vec![]);
        dispatch_single_click(
            &cancel,
            || {
                events.borrow_mut().push("down");
                cancel.cancel();
            },
            || events.borrow_mut().push("up"),
        )
        .unwrap();
        assert_eq!(*events.borrow(), ["down", "up"]);
    }
    #[test]
    fn stop_before_dispatch_posts_neither_event() {
        let cancel = Cancellation::default();
        cancel.cancel();
        let events = RefCell::new(vec![]);
        assert!(
            dispatch_single_click(
                &cancel,
                || events.borrow_mut().push("down"),
                || events.borrow_mut().push("up")
            )
            .is_err()
        );
        assert!(events.borrow().is_empty());
    }
}
