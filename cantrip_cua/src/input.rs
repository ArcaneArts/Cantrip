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

/// Choose an advertised control from this window's hierarchy, never desktop hit testing.
#[cfg(any(target_os = "macos", test))]
pub(crate) fn control_at(
    controls: &Controls,
    point: crate::target::Point,
) -> crate::error::Result<&str> {
    use crate::error::{CuaError, ErrorCode};
    let unsupported = || {
        CuaError::new(
            ErrorCode::Unsupported,
            "No unique pressable control at the agent cursor. Inspect controls or choose another position; no global click was posted.",
        )
    };
    // An omitted node could be the intended child/control at this position.
    if controls.truncated {
        return Err(unsupported());
    }
    let mut matches = controls
        .controls
        .iter()
        .filter_map(|control| {
            let bounds = control.bounds?;
            let local = crate::target::Point {
                x: point.x - bounds.x,
                y: point.y - bounds.y,
            };
            (control.actions.contains(&"press") && bounds.contains_local(local))
                .then_some((control.reference.as_str(), bounds.width * bounds.height))
        })
        .collect::<Vec<_>>();
    matches.sort_by(|a, b| a.1.total_cmp(&b.1));
    match matches.as_slice() {
        [(reference, _)] => Ok(reference),
        [(reference, area), (_, next), ..] if area < next => Ok(reference),
        _ => Err(unsupported()),
    }
}

#[cfg(test)]
mod targeted_tests {
    use super::*;
    use crate::{
        backend::{Capture, CaptureBackend, FakeBackend},
        cancellation::Cancellation,
        error::{CuaError, ErrorCode, Result},
        service::{CuaService, Operation},
        target::{Point, Target},
    };
    use serde_json::json;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };

    #[test]
    fn control_selection_uses_local_bounds_and_rejects_partial_or_ambiguous_results() {
        let control = |id: &str, width| Control {
            reference: id.into(),
            role: "AXButton".into(),
            label: None,
            bounds: Some(Bounds {
                x: 20.0,
                y: 10.0,
                width,
                height: 30.0,
            }),
            actions: vec!["press"],
        };
        let mut inspection = Controls {
            controls: vec![control("parent", 80.0), control("button", 30.0)],
            truncated: false,
        };
        assert_eq!(
            control_at(&inspection, Point { x: 25.0, y: 15.0 }).unwrap(),
            "button"
        );
        assert!(control_at(&inspection, Point { x: 5.0, y: 15.0 }).is_err());
        inspection.truncated = true;
        assert!(control_at(&inspection, Point { x: 25.0, y: 15.0 }).is_err());
        inspection.truncated = false;
        inspection.controls.push(control("overlap", 30.0));
        assert!(control_at(&inspection, Point { x: 25.0, y: 15.0 }).is_err());
    }

    struct RoutingBackend {
        calls: Arc<Mutex<Vec<(&'static str, Point)>>>,
        fail: Arc<AtomicBool>,
    }
    impl CaptureBackend for RoutingBackend {
        fn name(&self) -> &'static str {
            "unit"
        }
        fn available(&self) -> bool {
            true
        }
        fn targets(&mut self, cancel: &Cancellation) -> Result<Vec<Target>> {
            FakeBackend.targets(cancel)
        }
        fn capture(&mut self, _target: &Target, _cancel: &Cancellation) -> Result<Capture> {
            panic!("unit test must not capture")
        }
        fn click(
            &mut self,
            _session: &str,
            target: &Target,
            point: Point,
            _cancel: &Cancellation,
        ) -> Result<(Target, InputReceipt)> {
            self.calls.lock().unwrap().push(("targeted", point));
            if self.fail.load(Ordering::SeqCst) {
                return Err(CuaError::new(ErrorCode::InputUnknown, "unknown"));
            }
            Ok((
                target.clone(),
                InputReceipt {
                    method: "accessibility",
                    activation: false,
                    outcome: "dispatched",
                    position: Some(point),
                    global_position: None,
                },
            ))
        }
        fn global_click(
            &mut self,
            _session: &str,
            target: &Target,
            point: Point,
            _cancel: &Cancellation,
        ) -> Result<(Target, InputReceipt)> {
            self.calls.lock().unwrap().push(("global", point));
            Ok((
                target.clone(),
                InputReceipt {
                    method: "coordinate",
                    activation: true,
                    outcome: "dispatched",
                    position: Some(point),
                    global_position: None,
                },
            ))
        }
    }
    #[test]
    fn default_click_uses_cursor_and_never_falls_back_to_global_input() {
        let calls = Arc::new(Mutex::new(vec![]));
        let fail = Arc::new(AtomicBool::new(false));
        let mut service = CuaService::new(RoutingBackend {
            calls: calls.clone(),
            fail: fail.clone(),
        });
        let cancel = Cancellation::default();
        let request = |operation: &str| json!({"operation":operation,"binding":{"sessionId":"s","workerId":"w","chatId":"c"},"targetId":"fake-window","targetGeneration":1});
        let run = |service: &mut CuaService<RoutingBackend>, value| {
            service.execute(
                serde_json::from_value::<Operation>(value).unwrap(),
                &cancel,
                1,
            )
        };
        run(&mut service, request("target.attach")).unwrap();
        let mut movement = request("cursor.move");
        movement["position"] = json!({"x":12,"y":15});
        run(&mut service, movement).unwrap();
        let result = run(&mut service, request("input.click")).unwrap();
        assert_eq!(
            result.data["session"]["cursor"]["action"]["outcome"],
            "dispatched"
        );
        assert_eq!(
            calls.lock().unwrap()[0],
            ("targeted", Point { x: 12.0, y: 15.0 })
        );
        fail.store(true, Ordering::SeqCst);
        assert_eq!(
            run(&mut service, request("input.click"))
                .err()
                .unwrap()
                .code,
            ErrorCode::InputUnknown
        );
        assert_eq!(calls.lock().unwrap().len(), 2);
        let mut global = request("input.click");
        global["globalInput"] = json!(true);
        run(&mut service, global).unwrap();
        assert_eq!(calls.lock().unwrap()[2].0, "global");
    }
}
