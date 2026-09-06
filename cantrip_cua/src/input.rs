//! Bounded input metadata. Native handles never leave the backend.
use crate::target::Bounds;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClickDelivery {
    Process,
    Background,
}

pub(crate) fn error_outcome(code: crate::error::ErrorCode) -> &'static str {
    use crate::error::ErrorCode;
    match code {
        ErrorCode::InputUnknown => "unknown",
        ErrorCode::Unsupported
        | ErrorCode::ControlNotFound
        | ErrorCode::ControlAmbiguous
        | ErrorCode::ControlInspectionIncomplete => "unsupported",
        ErrorCode::Cancelled => "cancelled",
        _ => "failed",
    }
}

#[derive(Clone, Serialize)]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control: Option<Control>,
    pub method: &'static str,
    pub activation: bool,
    // AX confirms action dispatch, never the user's intended application result.
    pub outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<crate::target::Point>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub global_position: Option<crate::target::Point>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effects: Option<InputEffects>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_delivery: Option<&'static str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObservedChange {
    Unchanged,
    Changed,
    Unknown,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputEffects {
    pub sampling: &'static str,
    pub before_at_ms: u64,
    pub after_at_ms: u64,
    pub pointer: ObservedChange,
    pub foreground_application: ObservedChange,
    pub foreground_window: ObservedChange,
    pub window_order: ObservedChange,
}
#[cfg(any(target_os = "macos", test))]
pub(crate) fn observed_change<T: PartialEq>(
    before: Option<&T>,
    after: Option<&T>,
) -> ObservedChange {
    match (before, after) {
        (Some(before), Some(after)) if before == after => ObservedChange::Unchanged,
        (Some(_), Some(_)) => ObservedChange::Changed,
        _ => ObservedChange::Unknown,
    }
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
                value["delivery"] = json!("process");
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
    // An omitted node could be the intended child/control at this position.
    if controls.truncated {
        return Err(CuaError::new(
            ErrorCode::ControlInspectionIncomplete,
            "The bounded window inspection was incomplete; no Accessibility action was dispatched.",
        ));
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
        [] => Err(CuaError::new(
            ErrorCode::ControlNotFound,
            "The inspected window hierarchy contains no pressable control at this point; no Accessibility action was dispatched.",
        )),
        _ => Err(CuaError::new(
            ErrorCode::ControlAmbiguous,
            "The inspected window hierarchy contains equally specific pressable controls at this point; no Accessibility action was dispatched.",
        )),
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
    use std::sync::{Arc, Mutex};

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
        assert_eq!(
            control_at(&inspection, Point { x: 5.0, y: 15.0 })
                .unwrap_err()
                .code,
            ErrorCode::ControlNotFound
        );
        inspection.truncated = true;
        assert_eq!(
            control_at(&inspection, Point { x: 25.0, y: 15.0 })
                .unwrap_err()
                .code,
            ErrorCode::ControlInspectionIncomplete
        );
        inspection.truncated = false;
        inspection.controls.push(control("overlap", 30.0));
        assert_eq!(
            control_at(&inspection, Point { x: 25.0, y: 15.0 })
                .unwrap_err()
                .code,
            ErrorCode::ControlAmbiguous
        );
    }

    struct RoutingBackend {
        calls: Arc<Mutex<Vec<(&'static str, Point)>>>,
        fail: Arc<Mutex<Option<ErrorCode>>>,
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
        fn controls_at(
            &mut self,
            _session: &str,
            _target: &Target,
            point: Point,
            _cancel: &Cancellation,
        ) -> Result<Controls> {
            self.calls.lock().unwrap().push(("inspect", point));
            Ok(Controls {
                controls: vec![],
                truncated: false,
            })
        }
        fn click(
            &mut self,
            _session: &str,
            target: &Target,
            point: Point,
            _cancel: &Cancellation,
        ) -> Result<(Target, InputReceipt)> {
            self.calls.lock().unwrap().push(("targeted", point));
            if let Some(code) = *self.fail.lock().unwrap() {
                return Err(CuaError::new(code, "input did not confirm dispatch"));
            }
            Ok((
                target.clone(),
                InputReceipt {
                    control: None,
                    method: "accessibility",
                    activation: false,
                    outcome: "dispatched",
                    position: Some(point),
                    global_position: None,
                    effects: None,
                    window_delivery: None,
                },
            ))
        }
        fn process_click(
            &mut self,
            _session: &str,
            target: &Target,
            point: Point,
            _cancel: &Cancellation,
        ) -> Result<(Target, InputReceipt)> {
            self.calls.lock().unwrap().push(("process", point));
            Ok((
                target.clone(),
                InputReceipt {
                    control: None,
                    method: "process-coordinate",
                    activation: false,
                    outcome: "unknown",
                    position: Some(point),
                    global_position: None,
                    effects: None,
                    window_delivery: Some("unverified"),
                },
            ))
        }
        fn background_click(
            &mut self,
            _session: &str,
            target: &Target,
            point: Point,
            _cancel: &Cancellation,
        ) -> Result<(Target, InputReceipt)> {
            self.calls.lock().unwrap().push(("background", point));
            Ok((
                target.clone(),
                InputReceipt {
                    control: None,
                    method: "background-coordinate",
                    activation: false,
                    outcome: "unknown",
                    position: Some(point),
                    global_position: None,
                    effects: None,
                    window_delivery: Some("unverified"),
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
                    control: None,
                    method: "coordinate",
                    activation: true,
                    outcome: "dispatched",
                    position: Some(point),
                    global_position: None,
                    effects: None,
                    window_delivery: None,
                },
            ))
        }
    }
    #[test]
    fn point_inspection_routes_without_input_or_cursor_movement() {
        let calls = Arc::new(Mutex::new(vec![]));
        let mut service = CuaService::new(RoutingBackend {
            calls: calls.clone(),
            fail: Arc::new(Mutex::new(None)),
        });
        let cancel = Cancellation::default();
        let mut request = json!({"operation":"target.attach","binding":{"sessionId":"s","workerId":"w","chatId":"c"},"targetId":"fake-window","targetGeneration":1});
        let before = service
            .execute(serde_json::from_value(request.clone()).unwrap(), &cancel, 1)
            .unwrap();
        request["operation"] = json!("controls.inspect");
        request["position"] = json!({"x":54,"y":95});
        let after = service
            .execute(serde_json::from_value(request).unwrap(), &cancel, 2)
            .unwrap();
        assert_eq!(
            after.data["session"]["cursor"],
            before.data["session"]["cursor"]
        );
        assert_eq!(
            *calls.lock().unwrap(),
            vec![("inspect", Point { x: 54.0, y: 95.0 })]
        );
        assert_eq!(after.data["inspection"]["truncated"], false);
    }
    #[test]
    fn default_click_uses_cursor_and_never_falls_back_to_global_input() {
        let calls = Arc::new(Mutex::new(vec![]));
        let fail = Arc::new(Mutex::new(None));
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
        for (code, expected) in [
            (ErrorCode::InputUnknown, "unknown"),
            (ErrorCode::InputFailed, "failed"),
            (ErrorCode::Unsupported, "unsupported"),
            (ErrorCode::Cancelled, "cancelled"),
        ] {
            *fail.lock().unwrap() = Some(code);
            assert_eq!(
                run(&mut service, request("input.click"))
                    .err()
                    .unwrap()
                    .code,
                code
            );
            // Configuration reads the current native session without another
            // input or capture. Outcome survives the failed request.
            let mut state = request("cursor.configure");
            state["appearance"] =
                serde_json::to_value(crate::cursor::CursorAppearance::default()).unwrap();
            let state = run(&mut service, state).unwrap();
            assert_eq!(
                state.data["session"]["cursor"]["action"]["outcome"],
                expected
            );
            assert_eq!(
                state.data["session"]["cursor"]["position"],
                json!({"x":12.0,"y":15.0})
            );
        }
        assert_eq!(calls.lock().unwrap().len(), 5);
        let mut global = request("input.click");
        global["globalInput"] = json!(true);
        run(&mut service, global).unwrap();
        assert_eq!(calls.lock().unwrap()[5].0, "global");
        let mut process = request("input.click");
        process["delivery"] = json!("process");
        let result = run(&mut service, process.clone()).unwrap();
        assert_eq!(result.data["input"]["method"], "process-coordinate");
        assert_eq!(result.data["input"]["windowDelivery"], "unverified");
        assert_eq!(
            result.data["session"]["cursor"]["action"]["outcome"],
            "unknown"
        );
        assert_eq!(calls.lock().unwrap().len(), 7); // Exactly one attempt; no fallback.
        assert_eq!(
            calls.lock().unwrap()[6],
            ("process", Point { x: 12.0, y: 15.0 })
        );
        process["globalInput"] = json!(true);
        assert!(run(&mut service, process).is_err());
        assert_eq!(calls.lock().unwrap().len(), 7);
        let mut background = request("input.click");
        background["delivery"] = json!("background");
        let result = run(&mut service, background.clone()).unwrap();
        assert_eq!(result.data["input"]["method"], "background-coordinate");
        assert_eq!(result.data["input"]["windowDelivery"], "unverified");
        assert_eq!(
            result.data["session"]["cursor"]["action"]["method"],
            "background-coordinate"
        );
        assert_eq!(
            result.data["session"]["cursor"]["action"]["outcome"],
            "unknown"
        );
        assert_eq!(calls.lock().unwrap().len(), 8);
        assert_eq!(
            calls.lock().unwrap()[7],
            ("background", Point { x: 12.0, y: 15.0 })
        );
        background["globalInput"] = json!(true);
        assert!(run(&mut service, background).is_err());
        assert_eq!(calls.lock().unwrap().len(), 8);
        let mut reference = request("input.press");
        reference["reference"] = json!("unknown-control");
        assert!(run(&mut service, reference).is_err());
        let mut state = request("cursor.configure");
        state["appearance"] =
            serde_json::to_value(crate::cursor::CursorAppearance::default()).unwrap();
        let state = run(&mut service, state).unwrap();
        assert!(state.data["session"]["cursor"]["action"].is_null());
    }
}

#[cfg(test)]
mod effects_tests {
    use super::{ObservedChange::*, observed_change};
    #[test]
    fn absent_samples_never_claim_unchanged() {
        assert_eq!(observed_change::<u32>(None, None), Unknown);
        assert_eq!(observed_change(None, Some(&3)), Unknown);
        assert_eq!(observed_change(Some(&3), None), Unknown);
        assert_eq!(observed_change(Some(&3), Some(&3)), Unchanged);
        assert_eq!(observed_change(Some(&3), Some(&4)), Changed);
    }
}
