use crate::{
    backend::CaptureBackend,
    cancellation::Cancellation,
    cursor::{CursorAppearance, CursorState},
    error::{CuaError, ErrorCode, Result},
    protocol::{MAX_PAYLOAD_BYTES, PROTOCOL_VERSION},
    target::{MAX_SEQUENCE, Point, Target, validate_id},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{self, Write},
};

pub const MAX_SESSIONS: usize = 16;
pub use crate::inventory::MAX_TARGETS;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionBinding {
    pub session_id: String,
    pub worker_id: String,
    pub chat_id: String,
    pub task_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
}

impl SessionBinding {
    pub fn validate(&self) -> Result<()> {
        for id in [&self.session_id, &self.worker_id, &self.chat_id]
            .into_iter()
            .chain(
                [
                    self.task_id.as_ref(),
                    self.thread_id.as_ref(),
                    self.turn_id.as_ref(),
                ]
                .into_iter()
                .flatten(),
            )
        {
            validate_id(id)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionState {
    pub binding: SessionBinding,
    pub target: Option<Target>,
    pub cursor: CursorState,
    pub observation_revision: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "operation", deny_unknown_fields)]
pub enum Operation {
    #[serde(rename = "capabilities.get")]
    CapabilitiesGet {},
    #[serde(rename = "targets.list")]
    TargetsList {
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::inventory::deserialize_cursor"
        )]
        after: Option<String>,
    },
    #[serde(rename = "target.attach", rename_all = "camelCase")]
    TargetAttach {
        binding: SessionBinding,
        target_id: String,
        target_generation: u64,
    },
    #[serde(rename = "target.detach")]
    TargetDetach { binding: SessionBinding },
    #[serde(rename = "observation.snapshot", rename_all = "camelCase")]
    Snapshot {
        binding: SessionBinding,
        target_id: String,
        target_generation: u64,
    },
    #[serde(rename = "cursor.configure", rename_all = "camelCase")]
    CursorConfigure {
        binding: SessionBinding,
        target_id: String,
        target_generation: u64,
        appearance: CursorAppearance,
    },
    #[serde(rename = "cursor.move", rename_all = "camelCase")]
    CursorMove {
        binding: SessionBinding,
        target_id: String,
        target_generation: u64,
        position: Point,
    },
    #[serde(rename = "controls.inspect", rename_all = "camelCase")]
    ControlsInspect {
        binding: SessionBinding,
        target_id: String,
        target_generation: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        position: Option<Point>,
    },
    #[serde(rename = "input.press", rename_all = "camelCase")]
    InputPress {
        binding: SessionBinding,
        target_id: String,
        target_generation: u64,
        reference: String,
    },
    #[serde(rename = "input.click", rename_all = "camelCase")]
    InputClick {
        binding: SessionBinding,
        target_id: String,
        target_generation: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        position: Option<Point>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        global_input: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delivery: Option<crate::input::ClickDelivery>,
    },
    #[serde(rename = "input.perform", rename_all = "camelCase")]
    InputPerform {
        binding: SessionBinding,
        target_id: String,
        target_generation: u64,
        command: crate::gesture::InputCommand,
    },
    #[serde(rename = "session.close")]
    SessionClose { binding: SessionBinding },
    #[serde(rename = "javascript.evaluate", rename_all = "camelCase")]
    JavascriptEvaluate {
        binding: SessionBinding,
        source: String,
        #[serde(default = "crate::javascript::default_wall_timeout_ms")]
        wall_timeout_ms: u64,
    },
    #[serde(rename = "javascript.reset")]
    JavascriptReset { binding: SessionBinding },
}

pub struct OperationResult {
    pub data: Value,
    pub payload: Vec<u8>,
    pub event: Option<(&'static str, String)>,
}

impl OperationResult {
    fn json(data: Value) -> Self {
        Self {
            data,
            payload: vec![],
            event: None,
        }
    }
    fn session(state: &SessionState, event: &'static str) -> Self {
        Self {
            data: json!({ "session": state }),
            payload: vec![],
            event: Some((event, state.binding.session_id.clone())),
        }
    }
}

pub struct CuaService<B: CaptureBackend> {
    backend: B,
    sessions: HashMap<String, SessionState>,
    javascript: bool,
}

impl<B: CaptureBackend> CuaService<B> {
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            sessions: HashMap::new(),
            javascript: false,
        }
    }
    pub(crate) fn enable_javascript(&mut self) {
        self.javascript = true;
    }
    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    fn inventory(
        &mut self,
        after: Option<&str>,
        cancellation: &Cancellation,
    ) -> Result<crate::inventory::TargetPage> {
        if let Some(after) = after {
            validate_id(after)?;
        }
        let page = self.backend.target_page(after, cancellation)?;
        let targets = &page.targets;
        if targets.len() > MAX_TARGETS {
            return Err(CuaError::new(
                ErrorCode::Capacity,
                "Native target inventory exceeds the bound.",
            ));
        }
        let mut ids = std::collections::HashSet::new();
        for target in targets {
            target.validate()?;
            if !ids.insert(&target.id) {
                return Err(CuaError::invalid("Duplicate native target identity."));
            }
        }
        Ok(page)
    }

    fn session(&self, binding: &SessionBinding) -> Result<&SessionState> {
        binding.validate()?;
        let state = self
            .sessions
            .get(&binding.session_id)
            .ok_or_else(|| CuaError::new(ErrorCode::SessionNotFound, "CUA session not found."))?;
        if state.binding != *binding {
            return Err(CuaError::new(
                ErrorCode::OwnershipMismatch,
                "CUA session belongs to another execution context.",
            ));
        }
        Ok(state)
    }

    fn attached(
        &self,
        binding: &SessionBinding,
        target_id: &str,
        generation: u64,
    ) -> Result<SessionState> {
        let state = self.session(binding)?;
        let target = state
            .target
            .as_ref()
            .ok_or_else(|| CuaError::new(ErrorCode::TargetNotFound, "No CUA target attached."))?;
        if target.id != target_id || target.generation != generation {
            return Err(CuaError::new(
                ErrorCode::StaleTarget,
                "CUA target generation changed.",
            ));
        }
        Ok(state.clone())
    }

    pub fn execute(
        &mut self,
        operation: Operation,
        cancel: &Cancellation,
        now_ms: u64,
    ) -> Result<OperationResult> {
        let result = self.execute_inner(operation, cancel, now_ms);
        self.backend
            .present_cursors(self.sessions.values().cloned().collect());
        result
    }

    fn execute_inner(
        &mut self,
        operation: Operation,
        cancel: &Cancellation,
        now_ms: u64,
    ) -> Result<OperationResult> {
        cancel.check()?;
        match operation {
            Operation::CapabilitiesGet {} => {
                let mut operations = vec![
                    "capabilities.get",
                    "targets.list",
                    "target.attach",
                    "target.detach",
                    "observation.snapshot",
                    "cursor.configure",
                    "cursor.move",
                    "session.close",
                ];
                if self.backend.native_input() {
                    operations.extend([
                        "controls.inspect",
                        "input.press",
                        "input.click",
                        "input.perform",
                    ]);
                }
                if self.javascript {
                    operations.extend(["javascript.evaluate", "javascript.reset"]);
                }
                Ok(OperationResult::json(json!({
                    "protocolVersion": PROTOCOL_VERSION, "runtimeVersion": env!("CARGO_PKG_VERSION"),
                    "backend": self.backend.name(), "capture": self.backend.available(),
                    "nativeInput": self.backend.native_input(), "javascript": self.javascript, "cursorAppearanceVersion": 1,
                    "operations": operations,
                    "maxSessions": MAX_SESSIONS, "maxImageBytes": MAX_PAYLOAD_BYTES,
                })))
            }
            Operation::JavascriptEvaluate { .. } | Operation::JavascriptReset { .. } => {
                Err(CuaError::new(
                    ErrorCode::Unsupported,
                    "JavaScript requires the framed runtime owner.",
                ))
            }
            Operation::TargetsList { after } => {
                let page = self.inventory(after.as_deref(), cancel)?;
                cancel.check()?;
                let mut data = json!({ "targets": page.targets });
                if page.truncated {
                    data["truncated"] = json!(true);
                }
                if let Some(cursor) = page.next_cursor {
                    data["nextCursor"] = json!(cursor);
                }
                Ok(OperationResult::json(data))
            }
            Operation::TargetAttach {
                binding,
                target_id,
                target_generation,
            } => {
                binding.validate()?;
                if self.sessions.contains_key(&binding.session_id) {
                    self.session(&binding)?;
                } else if self.sessions.len() >= MAX_SESSIONS {
                    return Err(CuaError::new(
                        ErrorCode::Capacity,
                        "CUA session limit reached.",
                    ));
                }
                validate_id(&target_id)?;
                let target = self
                    .backend
                    .resolve_target(&target_id, target_generation, cancel)?;
                target.validate()?;
                if target.generation != target_generation {
                    return Err(CuaError::new(
                        ErrorCode::StaleTarget,
                        "CUA target was replaced.",
                    ));
                }
                let mut state =
                    self.sessions
                        .get(&binding.session_id)
                        .cloned()
                        .unwrap_or(SessionState {
                            binding: binding.clone(),
                            target: None,
                            cursor: CursorState::default(),
                            observation_revision: 0,
                        });
                // A second observer attaching to the same native generation must
                // not reset the shared cursor. Switching targets resets geometry.
                if state.target.as_ref().is_none_or(|previous| {
                    previous.id != target.id || previous.generation != target.generation
                }) {
                    self.backend.clear_controls(&binding.session_id);
                    let appearance = state.cursor.appearance.clone();
                    state.cursor = CursorState::default();
                    state.cursor.configure(appearance, now_ms)?;
                }
                state.target = Some(target);
                cancel.check()?;
                self.sessions.insert(binding.session_id, state.clone());
                Ok(OperationResult::session(&state, "targetAttached"))
            }
            Operation::TargetDetach { binding } => {
                let mut state = self.session(&binding)?.clone();
                self.backend.clear_controls(&binding.session_id);
                state.target = None;
                state.cursor.trail_points.clear();
                cancel.check()?;
                self.sessions.insert(binding.session_id, state.clone());
                Ok(OperationResult::session(&state, "targetDetached"))
            }
            Operation::CursorConfigure {
                binding,
                target_id,
                target_generation,
                appearance,
            } => {
                let mut state = self.attached(&binding, &target_id, target_generation)?;
                state.cursor.configure(appearance, now_ms)?;
                cancel.check()?;
                self.sessions.insert(binding.session_id, state.clone());
                Ok(OperationResult::session(&state, "cursorChanged"))
            }
            Operation::CursorMove {
                binding,
                target_id,
                target_generation,
                position,
            } => {
                let mut state = self.attached(&binding, &target_id, target_generation)?;
                state
                    .cursor
                    .move_to(position, &state.target.as_ref().unwrap().bounds, now_ms)?;
                cancel.check()?;
                self.sessions.insert(binding.session_id, state.clone());
                Ok(OperationResult::session(&state, "cursorChanged"))
            }
            Operation::Snapshot {
                binding,
                target_id,
                target_generation,
            } => {
                let mut state = self.attached(&binding, &target_id, target_generation)?;
                let selected = state.target.as_ref().unwrap();
                // Capture is authoritative. Do not gate it with an extra inventory
                // round trip; the backend returns current geometry with its pixels.
                let capture = self.backend.capture(selected, cancel)?;
                let current = capture.target;
                current.validate()?;
                if current.id != selected.id || current.generation != selected.generation {
                    return Err(CuaError::new(
                        ErrorCode::StaleTarget,
                        "CUA target was replaced.",
                    ));
                }
                let mut raster = capture.raster;
                raster.validate()?;
                cancel.check()?;
                if !current.bounds.contains_local(state.cursor.position)
                    || state
                        .cursor
                        .trail_points
                        .iter()
                        .any(|point| !current.bounds.contains_local(*point))
                {
                    // Resizing can remove the previous cursor position. Keep it inside
                    // the still-selected target and discard its now-invalid trail.
                    state.cursor.trail_points.clear();
                    let position = if current.bounds.contains_local(state.cursor.position) {
                        state.cursor.position
                    } else {
                        Point::default()
                    };
                    state.cursor.move_to(position, &current.bounds, now_ms)?;
                    state.cursor.trail_points.clear();
                }
                state.cursor.render(
                    &mut raster.rgba,
                    raster.width,
                    raster.height,
                    &current.bounds,
                )?;
                cancel.check()?;
                let mut encoded = BoundedImage(Vec::new());
                {
                    let mut encoder = png::Encoder::new(&mut encoded, raster.width, raster.height);
                    encoder.set_color(png::ColorType::Rgba);
                    encoder.set_depth(png::BitDepth::Eight);
                    let mut writer = encoder.write_header().map_err(|_| {
                        CuaError::new(ErrorCode::CaptureFailed, "PNG header encoding failed.")
                    })?;
                    writer.write_image_data(&raster.rgba).map_err(|_| {
                        CuaError::new(
                            ErrorCode::CaptureFailed,
                            "PNG encoding failed or exceeded image limit.",
                        )
                    })?;
                    writer.finish().map_err(|_| {
                        CuaError::new(ErrorCode::CaptureFailed, "PNG finalization failed.")
                    })?;
                }
                cancel.check()?;
                state.target = Some(current);
                state.observation_revision = state
                    .observation_revision
                    .checked_add(1)
                    .filter(|value| *value <= MAX_SEQUENCE)
                    .ok_or_else(|| {
                        CuaError::new(ErrorCode::Capacity, "Observation sequence exhausted.")
                    })?;
                let data = json!({ "session": &state, "image": {
                    "mediaType": "image/png", "width": raster.width, "height": raster.height,
                    "byteCount": encoded.0.len(), "sha256": format!("{:x}", Sha256::digest(&encoded.0)),
                    "cursorIncluded": true,
                }});
                self.sessions.insert(binding.session_id.clone(), state);
                Ok(OperationResult {
                    data,
                    payload: encoded.0,
                    event: Some(("snapshotCompleted", binding.session_id)),
                })
            }
            Operation::ControlsInspect {
                binding,
                target_id,
                target_generation,
                position,
            } => {
                let mut state = self.attached(&binding, &target_id, target_generation)?;
                let target = self
                    .backend
                    .resolve_target(&target_id, target_generation, cancel)?;
                let controls = match position {
                    Some(point) => {
                        self.backend
                            .controls_at(&binding.session_id, &target, point, cancel)?
                    }
                    None => self
                        .backend
                        .controls(&binding.session_id, &target, cancel)?,
                };
                cancel.check()?;
                state.target = Some(target);
                self.sessions
                    .insert(binding.session_id.clone(), state.clone());
                Ok(OperationResult::json(
                    json!({"session": state, "inspection": controls}),
                ))
            }
            Operation::InputPress {
                binding,
                target_id,
                target_generation,
                reference,
            } => {
                validate_id(&reference)?;
                let mut state = self.attached(&binding, &target_id, target_generation)?;
                let target = self
                    .backend
                    .resolve_target(&target_id, target_generation, cancel)?;
                // A reference may have no usable geometry. Clear the previous
                // marker rather than associate this attempt with its location.
                state.cursor.clear_action(now_ms);
                self.sessions
                    .insert(binding.session_id.clone(), state.clone());
                let input = self
                    .backend
                    .press(&binding.session_id, &target, &reference, cancel)?;
                // A presentation limit must not turn an already-dispatched
                // action into a retryable failure.
                if let Some(position) = input.position
                    && state
                        .cursor
                        .move_to(position, &target.bounds, now_ms)
                        .is_ok()
                {
                    state
                        .cursor
                        .mark_action(input.method, input.outcome, now_ms);
                }
                state.target = Some(target);
                self.sessions
                    .insert(binding.session_id.clone(), state.clone());
                Ok(OperationResult::json(
                    json!({"session": state, "input": input}),
                ))
            }
            Operation::InputClick {
                binding,
                target_id,
                target_generation,
                position,
                global_input,
                delivery,
            } => {
                if global_input && delivery.is_some() {
                    return Err(CuaError::invalid(
                        "Global input and process delivery are mutually exclusive.",
                    ));
                }
                let mut state = self.attached(&binding, &target_id, target_generation)?;
                let target = self
                    .backend
                    .resolve_target(&target_id, target_generation, cancel)?;
                let position = position.unwrap_or(state.cursor.position);
                state.cursor.move_to(position, &target.bounds, now_ms)?;
                state.target = Some(target.clone());
                self.sessions
                    .insert(binding.session_id.clone(), state.clone());
                let attempt = if matches!(delivery, Some(crate::input::ClickDelivery::Background)) {
                    self.backend
                        .background_click(&binding.session_id, &target, position, cancel)
                } else if delivery.is_some() {
                    self.backend
                        .process_click(&binding.session_id, &target, position, cancel)
                } else if global_input {
                    self.backend
                        .global_click(&binding.session_id, &target, position, cancel)
                } else {
                    self.backend
                        .click(&binding.session_id, &target, position, cancel)
                };
                let (current, input) = match attempt {
                    Ok(receipt) => receipt,
                    Err(error) => {
                        state.cursor.mark_action(
                            if matches!(delivery, Some(crate::input::ClickDelivery::Background)) {
                                "background-coordinate"
                            } else if delivery.is_some() {
                                "process-coordinate"
                            } else if global_input {
                                "coordinate"
                            } else {
                                "accessibility"
                            },
                            crate::input::error_outcome(error.code),
                            now_ms,
                        );
                        self.sessions.insert(binding.session_id.clone(), state);
                        return Err(error);
                    }
                };
                state
                    .cursor
                    .mark_action(input.method, input.outcome, now_ms);
                state.target = Some(current);
                self.sessions
                    .insert(binding.session_id.clone(), state.clone());
                Ok(OperationResult::json(
                    json!({"session":state, "input":input}),
                ))
            }
            Operation::InputPerform {
                binding,
                target_id,
                target_generation,
                command,
            } => {
                command.validate()?;
                let mut state = self.attached(&binding, &target_id, target_generation)?;
                let target = self
                    .backend
                    .resolve_target(&target_id, target_generation, cancel)?;
                let position = match &command {
                    crate::gesture::InputCommand::Drag { start, end, .. } => {
                        target.bounds.to_global(*end)?;
                        *start
                    }
                    crate::gesture::InputCommand::Scroll { point, .. } => {
                        point.unwrap_or(state.cursor.position)
                    }
                    _ => state.cursor.position,
                };
                state.cursor.move_to(position, &target.bounds, now_ms)?;
                state.target = Some(target.clone());
                self.sessions
                    .insert(binding.session_id.clone(), state.clone());
                self.backend
                    .present_cursors(self.sessions.values().cloned().collect());
                let started = std::time::Instant::now();
                let result = self.backend.perform(
                    &binding.session_id,
                    &target,
                    &command,
                    position,
                    cancel,
                    &mut |point| {
                        let _ = state.cursor.move_to(
                            point,
                            &target.bounds,
                            now_ms + started.elapsed().as_millis() as u64,
                        );
                    },
                );
                let completed = now_ms + started.elapsed().as_millis() as u64;
                match result {
                    Ok((current, input)) => {
                        state
                            .cursor
                            .mark_action(input.method, input.outcome, completed);
                        state.target = Some(current);
                        self.sessions
                            .insert(binding.session_id.clone(), state.clone());
                        Ok(OperationResult::json(
                            json!({"session":state,"input":input}),
                        ))
                    }
                    Err(error) => {
                        state.cursor.mark_action(
                            command.method(),
                            crate::input::error_outcome(error.code),
                            completed,
                        );
                        self.sessions.insert(binding.session_id.clone(), state);
                        Err(error)
                    }
                }
            }
            Operation::SessionClose { binding } => {
                self.session(&binding)?;
                cancel.check()?;
                self.backend.clear_controls(&binding.session_id);
                self.sessions.remove(&binding.session_id);
                Ok(OperationResult {
                    data: json!({ "closed": true }),
                    payload: vec![],
                    event: Some(("sessionClosed", binding.session_id)),
                })
            }
        }
    }
}

struct BoundedImage(Vec<u8>);
impl Write for BoundedImage {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_PAYLOAD_BYTES - self.0.len() {
            return Err(io::Error::other("Encoded image limit exceeded."));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
