//! Child-process tests. Native X11 coverage requires an explicit disposable display.
#[cfg(windows)]
#[path = "fixtures/windows_monitor.rs"]
mod windows_monitor;

use cantrip_cua::protocol::{
    Frame, Header, Message, Outcome, PROTOCOL_VERSION, read_frame, write_frame,
};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Mutex,
        mpsc::{self, Receiver},
    },
    time::Duration,
};

struct Process {
    child: Child,
    input: Option<ChildStdin>,
    frames: Receiver<std::io::Result<Frame>>,
    next_id: u64,
}

// Concurrent pipe creation/spawn can leak another helper's stdin descriptors
// into a sibling on macOS. A retained writer prevents EOF in the owning test.
// Serialize only launches; all helper execution and protocol work stays concurrent.
static PROCESS_SPAWN: Mutex<()> = Mutex::new(());

impl Process {
    fn start(fake: bool) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_cantrip-cua"));
        #[cfg(target_os = "linux")]
        command
            .env_remove("DISPLAY")
            .env_remove("WAYLAND_DISPLAY")
            .env_remove("WAYLAND_SOCKET")
            .env_remove("XDG_SESSION_TYPE");
        if fake {
            command.args(["--backend", "fake"]);
        }
        Self::spawn(command)
    }

    fn spawn(mut command: Command) -> Self {
        let spawn_guard = PROCESS_SPAWN.lock().unwrap();
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        drop(spawn_guard);
        let input = child.stdin.take();
        let mut output = child.stdout.take().unwrap();
        let (tx, frames) = mpsc::channel();
        std::thread::spawn(move || {
            loop {
                match read_frame(&mut output) {
                    Ok(Some(frame)) => {
                        if tx.send(Ok(frame)).is_err() {
                            return;
                        }
                    }
                    Ok(None) => return,
                    Err(error) => {
                        let _ = tx.send(Err(error));
                        return;
                    }
                }
            }
        });
        Self {
            child,
            input,
            frames,
            next_id: 0,
        }
    }

    fn send(&mut self, operation: Value) -> u64 {
        self.next_id += 1;
        let id = self.next_id;
        let frame = Frame {
            header: Header {
                version: PROTOCOL_VERSION,
                message: Message::Request {
                    request_id: id,
                    operation,
                },
            },
            payload: vec![],
        };
        write_frame(self.input.as_mut().unwrap(), &frame).unwrap();
        self.input.as_mut().unwrap().flush().unwrap();
        id
    }

    fn response(&mut self, id: u64) -> (Outcome, Vec<u8>) {
        self.response_with_timeout(id, Duration::from_secs(5))
    }
    fn response_with_timeout(&mut self, id: u64, timeout: Duration) -> (Outcome, Vec<u8>) {
        loop {
            let result = self
                .frames
                .recv_timeout(timeout)
                .expect("child must produce a bounded response")
                .unwrap();
            if let Message::Response {
                request_id,
                result: outcome,
            } = result.header.message
            {
                assert_eq!(request_id, id);
                return (outcome, result.payload);
            }
        }
    }

    fn call(&mut self, operation: Value) -> (Value, Vec<u8>) {
        let id = self.send(operation);
        let (outcome, bytes) = self.response(id);
        let Outcome::Ok { data } = outcome else {
            panic!("operation failed: {outcome:?}")
        };
        (data, bytes)
    }

    fn stop(&mut self, success: bool) {
        self.input.take();
        // stdout reader sees EOF only when all inherited process handles close.
        loop {
            match self.frames.recv_timeout(Duration::from_secs(5)) {
                Ok(_) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    panic!(
                        "child stdout did not close before shutdown deadline; pid={}, status={:?}",
                        self.child.id(),
                        self.child.try_wait().unwrap()
                    )
                }
            }
        }
        let status = self.child.try_wait().unwrap();
        // Receiving stdout EOF and then wait does not race a blocked output pipe.
        let status = status.unwrap_or_else(|| self.child.wait().unwrap());
        assert_eq!(status.success(), success);
        if success {
            let mut diagnostic = String::new();
            self.child
                .stderr
                .take()
                .unwrap()
                .read_to_string(&mut diagnostic)
                .unwrap();
            assert!(
                diagnostic.is_empty(),
                "successful process must not log target data"
            );
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn binding() -> Value {
    json!({ "sessionId":"session-fixture", "workerId":"worker-fixture", "chatId":"chat-fixture" })
}

fn evaluate(scope: Value, source: &str) -> Value {
    json!({"operation":"javascript.evaluate", "binding":scope, "source":source})
}

fn host_call(child: &mut Process, evaluation: u64, expected_call: u64) -> Value {
    let frame = child
        .frames
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    assert!(frame.payload.is_empty());
    let Message::HostCall {
        evaluation_request_id,
        call_id,
        action,
    } = frame.header.message
    else {
        panic!("expected host call, got {:?}", frame.header.message);
    };
    assert_eq!(
        (evaluation_request_id, call_id),
        (evaluation, expected_call)
    );
    action
}

fn host_result(child: &mut Process, evaluation: u64, call: u64, data: Value) {
    let frame = Frame {
        header: Header {
            version: PROTOCOL_VERSION,
            message: Message::HostResult {
                evaluation_request_id: evaluation,
                call_id: call,
                result: Outcome::Ok { data },
            },
        },
        payload: vec![],
    };
    write_frame(child.input.as_mut().unwrap(), &frame).unwrap();
    child.input.as_mut().unwrap().flush().unwrap();
}

#[test]
fn javascript_global_lexicals_await_completion_and_reset_are_real_engine_behavior() {
    let mut child = Process::start(true);
    let (first, _) = child.call(evaluate(
        binding(),
        "let answer = 40; const increment = 2; await Promise.resolve(answer + increment)",
    ));
    assert_eq!(first, json!({"value":42}));
    let (second, _) = child.call(evaluate(binding(), "answer += increment; answer"));
    assert_eq!(second, json!({"value":42}));
    let (undefined, _) = child.call(evaluate(binding(), "undefined"));
    assert_eq!(undefined, json!({"value":null}));
    child.call(json!({"operation":"javascript.reset", "binding":binding()}));
    let (reset, _) = child.call(evaluate(binding(), "typeof answer"));
    assert_eq!(reset, json!({"value":"undefined"}));
    child.stop(true);
}

#[test]
fn javascript_host_rendezvous_leaves_native_executor_available() {
    let mut child = Process::start(true);
    let evaluation = child.send(evaluate(
        binding(),
        "const state = await cua.getState(); state.count + (await cua.targets()).targets.length",
    ));
    assert_eq!(
        host_call(&mut child, evaluation, 1),
        json!({"operation":"state"})
    );
    // The script waits while the same sidecar executes an ordinary native job.
    let (inventory, _) = child.call(json!({"operation":"targets.list"}));
    host_result(&mut child, evaluation, 1, json!({"count":40}));
    assert_eq!(
        host_call(&mut child, evaluation, 2),
        json!({"operation":"targets"})
    );
    host_result(&mut child, evaluation, 2, inventory);
    let (result, _) = child.response(evaluation);
    assert_eq!(
        result,
        Outcome::Ok {
            data: json!({"value":42})
        }
    );
    child.stop(true);
}

#[test]
fn javascript_reset_interrupts_busy_code_and_late_host_reply_cannot_resume_it() {
    let mut child = Process::start(true);
    let evaluation = child.send(evaluate(
        binding(),
        "globalThis.oldValue = true; cua.getState(); for (;;) {}",
    ));
    host_call(&mut child, evaluation, 1);
    let (capabilities, _) = child.call(json!({"operation":"capabilities.get"}));
    assert_eq!(capabilities["javascript"], true);
    let reset = child.send(json!({"operation":"javascript.reset", "binding":binding()}));
    let (result, _) = child.response(evaluation);
    assert!(
        matches!(result, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Cancelled)
    );
    assert!(matches!(child.response(reset).0, Outcome::Ok { .. }));
    host_result(
        &mut child,
        evaluation,
        1,
        json!({"secret":"must not resume"}),
    );
    let (fresh, _) = child.call(evaluate(binding(), "typeof oldValue"));
    assert_eq!(fresh, json!({"value":"undefined"}));
    child.stop(true);
}

#[test]
fn javascript_scope_isolation_and_capacity_do_not_replace_contexts() {
    let mut child = Process::start(true);
    for number in 0..4 {
        let mut scope = binding();
        scope["sessionId"] = json!(format!("scope-{number}"));
        assert_eq!(
            child
                .call(evaluate(
                    scope,
                    &format!("let retained = {number}; retained")
                ))
                .0,
            json!({"value":number})
        );
    }
    let id = child.send(evaluate(binding(), "1"));
    assert!(
        matches!(child.response(id).0, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Capacity)
    );
    let mut scope = binding();
    scope["sessionId"] = json!("scope-0");
    let mut stranger = scope.clone();
    stranger["workerId"] = json!("other-worker");
    let id = child.send(evaluate(stranger, "retained"));
    assert!(
        matches!(child.response(id).0, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::OwnershipMismatch)
    );
    assert_eq!(
        child.call(evaluate(scope, "retained")).0,
        json!({"value":0})
    );
    child.stop(true);
}

#[test]
fn javascript_no_ambient_io_frozen_api_and_errors_dispose_background_jobs() {
    let mut child = Process::start(true);
    let source = "['process','require','fetch','std','io','os','Deno','Bun','WebSocket','XMLHttpRequest','Worker','setTimeout','setInterval','SharedArrayBuffer','Atomics','WeakRef','FinalizationRegistry'].every(key => typeof globalThis[key] === 'undefined') && Object.isFrozen(cua) && typeof __cuaHost === 'undefined'";
    assert_eq!(
        child.call(evaluate(binding(), source)).0,
        json!({"value":true})
    );
    assert_eq!(child.call(evaluate(binding(), "['SharedArrayBuffer','Atomics','WeakRef','FinalizationRegistry'].every(key => { const d = Object.getOwnPropertyDescriptor(globalThis,key); return d.value === undefined && !d.writable && !d.configurable; }) && Function('return typeof SharedArrayBuffer')() === 'undefined' && cua.getState.constructor('return typeof Atomics')() === 'undefined' && new Uint8Array(8).buffer.constructor === ArrayBuffer")).0, json!({"value":true}));
    for source in [
        "globalThis.poison = true; Promise.resolve().then(() => globalThis.background = true); 1",
        "globalThis.poison = true; throw new Error('PRIVATE SCRIPT CONTENT')",
        "globalThis.poison = true; new ArrayBuffer(256 * 1024 * 1024)",
        "globalThis.poison = true; 'a'.repeat(32769)",
        "({toJSON(){ Promise.resolve().then(() => {globalThis.background = true;}); return 42;}})",
        "({toJSON(){ cua.getState(); return 42;}})",
    ] {
        let id = child.send(evaluate(binding(), source));
        assert!(
            matches!(child.response(id).0, Outcome::Error { error } if !error.message.contains("PRIVATE"))
        );
        assert_eq!(
            child
                .call(evaluate(
                    binding(),
                    "typeof poison === 'undefined' && typeof background === 'undefined'"
                ))
                .0,
            json!({"value":true})
        );
    }
    child.stop(true);
}

#[test]
fn javascript_host_call_and_promise_job_limits_are_enforced() {
    let mut child = Process::start(true);
    let evaluation = child.send(evaluate(
        binding(),
        "for (let i=0; i<16385; i++) { await cua.cursor(); }",
    ));
    for call in 1..=16384 {
        assert_eq!(
            host_call(&mut child, evaluation, call),
            json!({"operation":"cursor"})
        );
        host_result(&mut child, evaluation, call, Value::Null);
    }
    assert!(
        matches!(child.response(evaluation).0, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Capacity)
    );
    let evaluation = child.send(evaluate(
        binding(),
        "const first = cua.getState(); cua.targets(); await first",
    ));
    assert_eq!(
        host_call(&mut child, evaluation, 1),
        json!({"operation":"state"})
    );
    assert!(
        matches!(child.response(evaluation).0, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Capacity)
    );
    host_result(&mut child, evaluation, 1, json!({"late":true}));
    let evaluation = child.send(evaluate(
        binding(),
        "await new Promise(() => { const again = () => Promise.resolve().then(again); again(); });",
    ));
    assert!(
        matches!(child.response(evaluation).0, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Capacity)
    );
    let evaluation = child.send(evaluate(binding(), "for (;;) {}"));
    assert!(
        matches!(child.response_with_timeout(evaluation, Duration::from_secs(15)).0, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Capacity)
    );
    child.stop(true);
}

#[test]
fn javascript_four_waiting_contexts_still_admit_reset_and_native_work() {
    let mut child = Process::start(true);
    let mut evaluations = Vec::new();
    for number in 0..4 {
        let mut scope = binding();
        scope["sessionId"] = json!(format!("waiting-{number}"));
        let id = child.send(evaluate(scope.clone(), "await cua.getState()"));
        host_call(&mut child, id, 1);
        evaluations.push((scope, id));
    }
    child.call(json!({"operation":"targets.list"}));
    let blocked = child.send(evaluate(evaluations[0].0.clone(), "1"));
    assert!(
        matches!(child.response(blocked).0, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Capacity)
    );
    let extra = child.send(evaluate(binding(), "1"));
    assert!(
        matches!(child.response(extra).0, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Capacity)
    );
    let reset = child.send(json!({"operation":"javascript.reset", "binding":evaluations[0].0}));
    assert!(
        matches!(child.response(evaluations[0].1).0, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Cancelled)
    );
    assert!(matches!(child.response(reset).0, Outcome::Ok { .. }));
    assert_eq!(child.call(evaluate(binding(), "42")).0, json!({"value":42}));
    for (_, id) in evaluations.into_iter().skip(1) {
        host_result(&mut child, id, 1, json!(id));
        assert!(matches!(child.response(id).0, Outcome::Ok { .. }));
    }
    child.stop(true);
}

#[test]
fn javascript_cancel_and_eof_drop_pending_host_roots_without_aborting_process() {
    let mut child = Process::start(true);
    let evaluation = child.send(evaluate(binding(), "await cua.snapshot()"));
    host_call(&mut child, evaluation, 1);
    let cancel = Frame {
        header: Header {
            version: PROTOCOL_VERSION,
            message: Message::Cancel {
                request_id: evaluation,
            },
        },
        payload: vec![],
    };
    write_frame(child.input.as_mut().unwrap(), &cancel).unwrap();
    child.input.as_mut().unwrap().flush().unwrap();
    assert!(
        matches!(child.response(evaluation).0, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Cancelled)
    );
    let fresh = child.send(evaluate(binding(), "await cua.snapshot()"));
    host_call(&mut child, fresh, 1);
    host_result(&mut child, evaluation, 1, json!({"old":true}));
    child.input.take();
    assert!(
        matches!(child.response(fresh).0, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Cancelled)
    );
    child.stop(true);
}

#[test]
fn native_session_close_also_disposes_its_matching_javascript_context() {
    let mut child = Process::start(true);
    child.call(json!({"operation":"target.attach", "binding":binding(), "targetId":"fake-window", "targetGeneration":1}));
    child.call(evaluate(binding(), "let retained = 42; retained"));
    child.call(json!({"operation":"session.close", "binding":binding()}));
    assert_eq!(
        child.call(evaluate(binding(), "typeof retained")).0,
        json!({"value":"undefined"})
    );
    child.stop(true);
}

#[test]
fn javascript_trusted_wall_timeout_uses_camel_case_and_validates_bounds() {
    let mut child = Process::start(true);
    let mut operation = evaluate(binding(), "42");
    operation["wallTimeoutMs"] = json!(345_000);
    assert_eq!(child.call(operation.clone()).0, json!({"value":42}));
    operation["wallTimeoutMs"] = json!(0);
    assert_eq!(child.call(operation.clone()).0, json!({"value":42}));
    for limit in [7_500_001, u64::MAX] {
        operation["wallTimeoutMs"] = json!(limit);
        let id = child.send(operation.clone());
        assert!(
            matches!(child.response(id).0, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Capacity)
        );
    }
    for limit in [json!(-1), json!(1.5), json!("345000"), Value::Null] {
        operation["wallTimeoutMs"] = limit;
        let id = child.send(operation.clone());
        assert!(
            matches!(child.response(id).0, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::InvalidRequest)
        );
    }
    // Optional field preserves the ordinary deadline and persistent protocol.
    assert_eq!(child.call(evaluate(binding(), "42")).0, json!({"value":42}));
    child.stop(true);
}

#[test]
fn javascript_pending_host_deadline_is_per_evaluation_and_wakes_without_a_reply() {
    let mut child = Process::start(true);
    let mut long = evaluate(binding(), "await cua.getState()");
    long["wallTimeoutMs"] = json!(345_000);
    let long_id = child.send(long);
    host_call(&mut child, long_id, 1);
    let mut short_binding = binding();
    short_binding["sessionId"] = json!("short-deadline");
    let mut short = evaluate(
        short_binding.clone(),
        "let expired = true; await cua.getState()",
    );
    short["wallTimeoutMs"] = json!(100);
    let short_id = child.send(short);
    host_call(&mut child, short_id, 1);
    // A real receive timeout must wake the engine; no host reply or extra
    // request is sent to force the expired context to be examined.
    assert!(
        matches!(child.response(short_id).0, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Capacity)
    );
    host_result(&mut child, short_id, 1, json!({"late":true}));
    host_result(&mut child, long_id, 1, json!({"live":true}));
    assert!(
        matches!(child.response(long_id).0, Outcome::Ok { data } if data == json!({"value":{"live":true}}))
    );
    assert_eq!(
        child.call(evaluate(short_binding, "typeof expired")).0,
        json!({"value":"undefined"})
    );
    child.stop(true);
}

#[test]
fn javascript_extended_approval_deadline_does_not_extend_busy_code_budget() {
    let mut child = Process::start(true);
    let mut operation = evaluate(binding(), "while (true) {}");
    operation["wallTimeoutMs"] = json!(345_000);
    let id = child.send(operation);
    // The ten-second active execution budget settles this before the wall deadline.
    assert!(
        matches!(child.response_with_timeout(id, Duration::from_secs(15)).0, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Capacity)
    );
    assert_eq!(child.call(evaluate(binding(), "42")).0, json!({"value":42}));
    child.stop(true);
}

#[test]
fn javascript_output_and_source_boundaries_include_the_response_envelope() {
    let mut child = Process::start(true);
    let (value, _) = child.call(evaluate(binding(), "'x'.repeat(32756)"));
    assert_eq!(serde_json::to_vec(&value).unwrap().len(), 32768);
    let id = child.send(evaluate(binding(), "'x'.repeat(32757)"));
    assert!(
        matches!(child.response(id).0, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Capacity)
    );
    let source = format!("{}42", " ".repeat(2 * 1024 * 1024 - 2));
    assert_eq!(
        child.call(evaluate(binding(), &source)).0,
        json!({"value":42})
    );
    let id = child.send(evaluate(binding(), &(source + " ")));
    assert!(
        matches!(child.response(id).0, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Capacity)
    );
    assert_eq!(
        child.call(evaluate(binding(), "({value:42})")).0,
        json!({"value":{"value":42}})
    );
    child.stop(true);
}

#[test]
fn real_executable_handshake_cursor_png_and_shutdown() {
    let mut child = Process::start(true);
    let (capabilities, _) = child.call(json!({"operation":"capabilities.get"}));
    assert_eq!(capabilities["backend"], "fake");
    assert_eq!(capabilities["nativeInput"], false);
    assert_eq!(capabilities["javascript"], true);
    let (inventory, _) = child.call(json!({"operation":"targets.list"}));
    assert_eq!(inventory["targets"].as_array().unwrap().len(), 2);
    child.call(json!({"operation":"target.attach", "binding":binding(), "targetId":"fake-window", "targetGeneration":1}));
    child.call(json!({"operation":"cursor.configure", "binding":binding(), "targetId":"fake-window", "targetGeneration":1,
        "appearance":{"style":"crosshair", "color":"#FF0000", "size":24, "label":"Agent", "trail":true}}));
    let (moved, _) = child.call(json!({"operation":"cursor.move", "binding":binding(), "targetId":"fake-window", "targetGeneration":1, "position":{"x":60,"y":40}}));
    assert_eq!(
        moved["session"]["cursor"]["position"],
        json!({"x":60.0,"y":40.0})
    );
    let (snapshot, bytes) = child.call(
        json!({"operation":"observation.snapshot", "binding":binding(), "targetId":"fake-window", "targetGeneration":1}),
    );
    assert_eq!(snapshot["image"]["byteCount"], bytes.len());
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    let mut decoder = png::Decoder::new(std::io::Cursor::new(&bytes))
        .read_info()
        .unwrap();
    let mut rgba = vec![0; decoder.output_buffer_size().unwrap()];
    let info = decoder.next_frame(&mut rgba).unwrap();
    assert_eq!((info.width, info.height), (320, 200));
    let hotspot = (80 * 320 + 120) * 4;
    assert_eq!(&rgba[hotspot..hotspot + 4], &[255, 0, 0, 255]);
    let (closed, _) = child.call(json!({"operation":"session.close", "binding":binding()}));
    assert_eq!(closed["closed"], true);
    child.stop(true);
}

#[test]
fn framed_cursor_move_and_snapshot_preserve_fractional_coordinates_exactly() {
    let mut child = Process::start(true);
    child.call(json!({"operation":"target.attach", "binding":binding(), "targetId":"fake-window", "targetGeneration":1}));
    // These IEEE-754 values changed by one ULP under the default JSON parser.
    // Construct them without parsing JSON so the expected values are independent
    // of the protocol decoder under test.
    let position = json!({"x":95.39999999999999_f64,"y":39.699999999999996_f64});
    let (moved, _) = child.call(json!({"operation":"cursor.move", "binding":binding(), "targetId":"fake-window", "targetGeneration":1, "position":position}));
    let (snapshot, bytes) = child.call(json!({"operation":"observation.snapshot", "binding":binding(), "targetId":"fake-window", "targetGeneration":1}));
    assert!(!bytes.is_empty());
    for result in [&moved, &snapshot] {
        for axis in ["x", "y"] {
            assert_eq!(
                result["session"]["cursor"]["position"][axis]
                    .as_f64()
                    .unwrap()
                    .to_bits(),
                position[axis].as_f64().unwrap().to_bits(),
                "framed cursor {axis} must retain the exact supplied coordinate"
            );
        }
    }
    child.stop(true);
}

#[test]
fn default_binary_never_silently_uses_fake_capture() {
    let mut child = Process::start(false);
    let (capabilities, _) = child.call(json!({"operation":"capabilities.get"}));
    assert_ne!(capabilities["backend"], "fake");
    assert_eq!(capabilities["nativeInput"], capabilities["capture"]);
    #[cfg(target_os = "macos")]
    {
        let supported = cantrip_cua::macos::available();
        assert_eq!(capabilities["capture"], supported);
        assert_eq!(
            capabilities["backend"],
            if supported {
                "macos-screencapturekit"
            } else {
                "unavailable"
            }
        );
    }
    #[cfg(windows)]
    assert_eq!(
        capabilities["backend"],
        if capabilities["capture"] == true {
            "windows-win32"
        } else {
            "unavailable"
        }
    );
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        assert_eq!(capabilities["backend"], "unavailable");
        assert_eq!(capabilities["capture"], false);
        let id = child.send(json!({"operation":"targets.list"}));
        let (outcome, _) = child.response(id);
        assert!(
            matches!(outcome, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Unsupported)
        );
    }
    // On macOS and Windows this is deliberately handshake-only: ordinary CI/tests must
    // never enumerate private windows or request Screen Recording permission.
    child.stop(true);
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires an explicitly selected disposable Xvfb display"]
fn linux_host_x11_isolates_window_pixels_input_and_lifetimes() {
    use x11rb::{
        connection::Connection,
        protocol::{
            Event,
            xproto::{
                AtomEnum, ConnectionExt, CreateWindowAux, EventMask, InputFocus, WindowClass,
            },
        },
        wrapper::ConnectionExt as _,
    };
    let display = std::env::var("CANTRIP_CUA_HOST_X11_TEST_DISPLAY").unwrap();
    let (x11, screen) = x11rb::connect(Some(&display)).unwrap();
    let root = &x11.setup().roots[screen];
    let first = x11.generate_id().unwrap();
    let second = x11.generate_id().unwrap();
    let create = |id, x, y, rgb, name: &str| {
        x11.create_window(
            root.root_depth,
            id,
            root.root,
            x,
            y,
            160,
            120,
            0,
            WindowClass::INPUT_OUTPUT,
            root.root_visual,
            &CreateWindowAux::new().background_pixel(rgb).event_mask(
                EventMask::KEY_PRESS
                    | EventMask::KEY_RELEASE
                    | EventMask::BUTTON_PRESS
                    | EventMask::BUTTON_RELEASE
                    | EventMask::POINTER_MOTION,
            ),
        )
        .unwrap()
        .check()
        .unwrap();
        x11.change_property8(
            x11rb::protocol::xproto::PropMode::REPLACE,
            id,
            AtomEnum::WM_NAME,
            AtomEnum::STRING,
            name.as_bytes(),
        )
        .unwrap()
        .check()
        .unwrap();
        x11.change_property8(
            x11rb::protocol::xproto::PropMode::REPLACE,
            id,
            AtomEnum::WM_CLASS,
            AtomEnum::STRING,
            if id == second {
                b"cantrip\0Cantrip\0"
            } else {
                b"fixture\0Fixture\0"
            },
        )
        .unwrap()
        .check()
        .unwrap();
        x11.map_window(id).unwrap().check().unwrap();
        x11.clear_area(false, id, 0, 0, 0, 0)
            .unwrap()
            .check()
            .unwrap();
    };
    create(first, 20, 30, 0x00_00_ff, "native blue fixture");
    create(second, 80, 55, 0xff_00_00, "covered area fixture");
    x11.set_input_focus(InputFocus::PARENT, second, x11rb::CURRENT_TIME)
        .unwrap()
        .check()
        .unwrap();
    x11.warp_pointer(x11rb::NONE, root.root, 0, 0, 0, 0, 100, 90)
        .unwrap()
        .check()
        .unwrap();
    x11.get_input_focus().unwrap().reply().unwrap();
    while x11.poll_for_event().unwrap().is_some() {}

    let mut command = Command::new(env!("CARGO_BIN_EXE_cantrip-cua"));
    command
        .env("DISPLAY", display)
        .env("XDG_SESSION_TYPE", "x11")
        .env("PATH", "");
    let mut child = Process::spawn(command);
    let (caps, _) = child.call(json!({"operation":"capabilities.get"}));
    assert_eq!(caps["backend"], "linux-x11");
    assert_eq!(caps["capture"], true);
    assert_eq!(caps["nativeInput"], true);
    let (inventory, _) = child.call(json!({"operation":"targets.list"}));
    let targets = inventory["targets"].as_array().unwrap();
    let target = |id| {
        targets
            .iter()
            .find(|t| t["id"] == format!("x11-window-{id}"))
            .unwrap()
    };
    let selected = target(first);
    assert_eq!(selected["title"], "native blue fixture");
    assert_eq!(target(second)["access"]["reason"], "cantrip-app-protected");
    assert!(targets.iter().any(|t| t["kind"] == "monitor"));

    let scope = json!({"workerId":"worker","surfaceId":"desktop","attachmentId":"view","participantId":"viewer"});
    let open = |operation: &str, target: &Value| json!({"operation":operation,"request":{"type":"open","binding":scope,"targetId":target["id"],"targetGeneration":target["generation"]}});
    let (lease, _) = child.call(open("capture.request", selected));
    let frame = json!({"operation":"capture.request","request":{"type":"frame","binding":scope,"handle":lease["handle"]}});
    let (_, pixels) = child.call(frame.clone());
    let mut reader = png::Decoder::new(std::io::Cursor::new(pixels))
        .read_info()
        .unwrap();
    let mut raster = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut raster).unwrap();
    assert_eq!((info.width, info.height), (160, 120));
    assert_eq!(
        &raster[(70 * 160 + 90) * 4..(70 * 160 + 90) * 4 + 4],
        &[0, 0, 255, 255]
    );

    let (participant, _) = child.call(open("interaction.request", selected));
    let send = |child: &mut Process, sequence, event| {
        child.call(json!({"operation":"interaction.request","request":{"type":"input","binding":scope,"handle":participant["handle"],"sequence":sequence,"event":event}}));
    };
    send(
        &mut child,
        1,
        json!({"type":"pointerDown","data":{"point":{"x":90,"y":70},"button":"left","modifiers":[]}}),
    );
    send(
        &mut child,
        2,
        json!({"type":"keyDown","data":{"key":"a","modifiers":[],"repeat":false}}),
    );
    child.call(json!({"operation":"interaction.request","request":{"type":"close","binding":scope,"handle":participant["handle"]}}));
    assert_eq!(
        x11.get_input_focus().unwrap().reply().unwrap().focus,
        second
    );
    let pointer = x11.query_pointer(root.root).unwrap().reply().unwrap();
    assert_eq!((pointer.root_x, pointer.root_y), (100, 90));
    let mut received = Vec::new();
    while let Some(event) = x11.poll_for_event().unwrap() {
        match event {
            Event::ButtonPress(e) | Event::ButtonRelease(e) => {
                assert_eq!(e.event, first);
                assert_eq!((e.event_x, e.event_y), (90, 70));
                received.push(e.response_type & 0x7f);
            }
            Event::KeyPress(e) | Event::KeyRelease(e) => {
                assert_eq!(e.event, first);
                received.push(e.response_type & 0x7f);
            }
            _ => {}
        }
    }
    received.sort_unstable();
    assert_eq!(received, [2, 3, 4, 5]);

    x11.destroy_window(first).unwrap().check().unwrap();
    create(first, 20, 30, 0x00_ff_00, "native blue fixture");
    let id = child.send(frame);
    assert!(
        matches!(child.response(id).0, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::StaleTarget)
    );
    child.stop(true);
}

#[test]
fn invalid_operation_is_bounded_and_does_not_poison_connection() {
    let mut child = Process::start(true);
    let id = child.send(json!({"operation":"input.click", "text":"private-canary"}));
    let (outcome, bytes) = child.response(id);
    let Outcome::Error { error } = outcome else {
        panic!("unknown operation accepted")
    };
    assert!(!error.message.contains("private-canary"));
    assert!(bytes.is_empty());
    child.call(json!({"operation":"capabilities.get"}));
    child.stop(true);
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires an explicitly selected disposable Xvfb display"]
fn linux_host_x11_monitor_input_is_exclusive_and_follows_the_selected_layout() {
    use cantrip_cua::error::ErrorCode;
    use x11rb::{
        CURRENT_TIME,
        connection::Connection,
        protocol::{
            Event,
            randr::{ConnectionExt as _, MonitorInfo},
            xproto::{
                ConnectionExt, CreateWindowAux, EventMask, InputFocus, KeyButMask, PropMode,
                SELECTION_NOTIFY_EVENT, SelectionNotifyEvent, WindowClass,
            },
        },
        wrapper::ConnectionExt as _,
    };
    let display = std::env::var("CANTRIP_CUA_HOST_X11_TEST_DISPLAY").unwrap();
    let (x11, screen) = x11rb::connect(Some(&display)).unwrap();
    let root = &x11.setup().roots[screen];
    let atom = |name| x11.intern_atom(false, name).unwrap().reply().unwrap().atom;
    let left_name = atom(b"Cantrip test left display");
    let right_name = atom(b"Cantrip test right display");
    let output = x11
        .randr_get_screen_resources_current(root.root)
        .unwrap()
        .reply()
        .unwrap()
        .outputs[0];
    let configure = |name, x, outputs: Vec<u32>| {
        x11.randr_set_monitor(
            root.root,
            MonitorInfo {
                name,
                primary: x == 0,
                automatic: false,
                x,
                y: 0,
                width: 400,
                height: 600,
                width_in_millimeters: 100,
                height_in_millimeters: 150,
                outputs,
            },
        )
        .unwrap()
        .check()
        .unwrap();
    };
    configure(right_name, 400, vec![]);
    configure(left_name, 0, vec![output]);
    let window = |x| {
        let id = x11.generate_id().unwrap();
        x11.create_window(
            root.root_depth,
            id,
            root.root,
            x,
            10,
            180,
            140,
            0,
            WindowClass::INPUT_OUTPUT,
            root.root_visual,
            &CreateWindowAux::new().event_mask(EventMask::KEY_PRESS | EventMask::KEY_RELEASE),
        )
        .unwrap()
        .check()
        .unwrap();
        x11.map_window(id).unwrap().check().unwrap();
        id
    };
    let other = window(20);
    let selected = window(430);
    let focus = |id| {
        x11.set_input_focus(InputFocus::PARENT, id, CURRENT_TIME)
            .unwrap()
            .check()
            .unwrap()
    };
    focus(other);

    let mut command = Command::new(env!("CARGO_BIN_EXE_cantrip-cua"));
    command
        .env("DISPLAY", &display)
        .env("XDG_SESSION_TYPE", "x11")
        .env("PATH", "");
    let mut child = Process::spawn(command);
    assert_eq!(
        child.call(json!({"operation":"capabilities.get"})).0["hostMonitorInput"],
        true
    );
    let (inventory, _) = child.call(json!({"operation":"targets.list"}));
    let target = |x: i32| {
        inventory["targets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|target| {
                target["kind"] == "monitor" && target["bounds"]["x"].as_f64() == Some(f64::from(x))
            })
            .unwrap()
    };
    let right = target(400);
    let left = target(0);
    let binding = |viewer| json!({"workerId":"worker","surfaceId":"display","attachmentId":viewer,"participantId":viewer});
    let viewer = binding("viewer");
    let waiting = binding("waiting");
    let operation = |request| json!({"operation":"interaction.request","request":request});
    let open = |binding: &Value, target: &Value| {
        operation(
            json!({"type":"open","binding":binding,"targetId":target["id"],"targetGeneration":target["generation"]}),
        )
    };
    let first = child.call(open(&viewer, right)).0;
    let request = child.send(open(&waiting, left));
    assert!(
        matches!(child.response(request).0, Outcome::Error { error } if error.code == ErrorCode::OwnershipMismatch)
    );
    let input = |binding: &Value, participant: &Value, sequence, event| {
        operation(
            json!({"type":"input","binding":binding,"handle":participant["handle"],"sequence":sequence,"event":event}),
        )
    };
    let key = |name| json!({"type":"keyDown","data":{"key":name,"modifiers":[],"repeat":false}});
    let movement = |x| json!({"type":"pointerMove","data":{"point":{"x":x,"y":60},"modifiers":[]}});
    child.call(input(&viewer, &first, 1, movement(399.9)));
    let pointer = x11.query_pointer(root.root).unwrap().reply().unwrap();
    assert_eq!((pointer.root_x, pointer.root_y), (799, 60));
    let request = child.send(input(&viewer, &first, 2, key("A")));
    assert!(
        matches!(child.response(request).0, Outcome::Error { error } if error.code == ErrorCode::PermissionDenied)
    );
    let empty_keys = || {
        x11.query_keymap()
            .unwrap()
            .reply()
            .unwrap()
            .keys
            .iter()
            .all(|key| *key == 0)
    };
    assert!(empty_keys());

    focus(selected);
    let participant = child.call(open(&viewer, right)).0;
    child.call(input(
        &viewer,
        &participant,
        1,
        json!({"type":"keyDown","data":{"key":"Control","modifiers":["Control"],"repeat":false}}),
    ));
    let clipboard = atom(b"CLIPBOARD");
    let copy = child.send(operation(json!({"type":"clipboardCopy","binding":viewer,"handle":participant["handle"],"sequence":3})));
    let copy_outcome = std::thread::scope(|scope| {
        let reply = scope.spawn(|| child.response(copy).0);
        while !reply.is_finished() {
            while let Some(event) = x11.poll_for_event().unwrap() {
                match event {
                    Event::KeyPress(e) if e.state.contains(KeyButMask::CONTROL) => {
                        assert_eq!(e.event, selected);
                        x11.set_selection_owner(selected, clipboard, CURRENT_TIME)
                            .unwrap()
                            .check()
                            .unwrap();
                    }
                    Event::SelectionRequest(e) => {
                        assert_eq!(e.owner, selected);
                        x11.change_property8(
                            PropMode::REPLACE,
                            e.requestor,
                            e.property,
                            e.target,
                            "selected λ\n".as_bytes(),
                        )
                        .unwrap()
                        .check()
                        .unwrap();
                        x11.send_event(
                            false,
                            e.requestor,
                            EventMask::NO_EVENT,
                            SelectionNotifyEvent {
                                response_type: SELECTION_NOTIFY_EVENT,
                                sequence: 0,
                                time: e.time,
                                requestor: e.requestor,
                                selection: e.selection,
                                target: e.target,
                                property: e.property,
                            },
                        )
                        .unwrap()
                        .check()
                        .unwrap();
                    }
                    _ => {}
                }
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        reply.join().unwrap()
    });
    assert_eq!(
        copy_outcome,
        Outcome::Ok {
            data: json!({"handle":participant["handle"], "sequence":3, "text":"selected λ\n"})
        }
    );
    assert!(
        !empty_keys(),
        "copy preserves the viewer's held Control key"
    );
    child.call(input(
        &viewer,
        &participant,
        4,
        json!({"type":"keyUp","data":{"key":"Control"}}),
    ));
    assert!(empty_keys());
    let down = json!({"type":"pointerDown","data":{"point":{"x":75,"y":60},"button":"left","modifiers":[]}});
    child.call(input(&viewer, &participant, 5, down.clone()));
    child.call(input(&viewer, &participant, 6, key("A")));
    let pointer = x11.query_pointer(root.root).unwrap().reply().unwrap();
    assert_eq!(
        (pointer.root_x, pointer.root_y, pointer.child),
        (475, 60, selected)
    );
    assert!(pointer.mask.contains(KeyButMask::BUTTON1));
    assert!(!empty_keys());
    child.call(operation(json!({"type":"closeBinding","binding":viewer})));
    let released = || {
        !x11.query_pointer(root.root)
            .unwrap()
            .reply()
            .unwrap()
            .mask
            .contains(KeyButMask::BUTTON1)
            && empty_keys()
    };
    assert!(released());

    let controller = child.call(open(&waiting, right)).0;
    child.call(input(&waiting, &controller, 1, down));
    x11.randr_delete_monitor(root.root, right_name)
        .unwrap()
        .check()
        .unwrap();
    configure(right_name, 399, vec![]);
    let request = child.send(input(&waiting, &controller, 2, movement(10.0)));
    assert!(
        matches!(child.response(request).0, Outcome::Error { error } if error.code == ErrorCode::StaleTarget)
    );
    assert!(
        released(),
        "reconfiguring the monitor releases the physical button"
    );
    child.stop(true);
    x11.randr_delete_monitor(root.root, right_name)
        .unwrap()
        .check()
        .unwrap();
    x11.randr_delete_monitor(root.root, left_name)
        .unwrap()
        .check()
        .unwrap();
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires an explicitly selected disposable Xvfb display"]
fn linux_host_x11_clipboard_accepts_only_a_fresh_copy_from_the_selected_client() {
    use cantrip_cua::error::ErrorCode;
    use x11rb::{
        CURRENT_TIME, NONE,
        connection::Connection,
        protocol::{
            Event,
            xproto::{
                ConnectionExt, CreateWindowAux, EventMask, InputFocus, KeyButMask, PropMode,
                Property, SELECTION_NOTIFY_EVENT, SelectionNotifyEvent, WindowClass,
            },
        },
        rust_connection::RustConnection,
        wrapper::ConnectionExt as _,
    };
    let display = std::env::var("CANTRIP_CUA_HOST_X11_TEST_DISPLAY").unwrap();
    let (selected, screen) = x11rb::connect(Some(&display)).unwrap();
    let (foreign, _) = x11rb::connect(Some(&display)).unwrap();
    let root = &selected.setup().roots[screen];
    let create = |connection: &RustConnection, events| {
        let window = connection.generate_id().unwrap();
        connection
            .create_window(
                root.root_depth,
                window,
                root.root,
                0,
                0,
                100,
                100,
                0,
                WindowClass::INPUT_OUTPUT,
                root.root_visual,
                &CreateWindowAux::new().event_mask(events),
            )
            .unwrap()
            .check()
            .unwrap();
        window
    };
    let window = create(&selected, EventMask::KEY_PRESS | EventMask::KEY_RELEASE);
    let owner = create(&selected, EventMask::NO_EVENT);
    let other = create(&foreign, EventMask::KEY_PRESS);
    selected.map_window(window).unwrap().check().unwrap();
    foreign.map_window(other).unwrap().check().unwrap();
    foreign
        .set_input_focus(InputFocus::PARENT, other, CURRENT_TIME)
        .unwrap()
        .check()
        .unwrap();
    let atom = |name| {
        selected
            .intern_atom(false, name)
            .unwrap()
            .reply()
            .unwrap()
            .atom
    };
    let clipboard = atom(b"CLIPBOARD");
    let incr = atom(b"INCR");
    let own = |connection: &RustConnection, owner| {
        connection
            .set_selection_owner(owner, clipboard, CURRENT_TIME)
            .unwrap()
            .check()
            .unwrap();
    };
    own(&foreign, other);

    let mut command = Command::new(env!("CARGO_BIN_EXE_cantrip-cua"));
    command
        .env("DISPLAY", &display)
        .env("XDG_SESSION_TYPE", "x11")
        .env("PATH", "");
    let mut child = Process::spawn(command);
    let (inventory, _) = child.call(json!({"operation":"targets.list"}));
    let id = format!("x11-window-{window}");
    let target = inventory["targets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|target| target["id"] == id)
        .unwrap();
    let binding = json!({"workerId":"w","surfaceId":"s","attachmentId":"a","participantId":"p"});
    let (participant, _) = child.call(json!({"operation":"interaction.request","request":{"type":"open","binding":binding,"targetId":id,"targetGeneration":target["generation"]}}));
    let copy = |sequence| json!({"operation":"interaction.request","request":{"type":"clipboardCopy","binding":binding,"handle":participant["handle"],"sequence":sequence}});
    let mut forged = copy(2);
    forged["request"]["binding"]["attachmentId"] = json!("other");
    let request = child.send(forged);
    assert!(matches!(child.response(request).0, Outcome::Error { .. }));
    let request = child.send(json!({"operation":"interaction.request","request":{"type":"clipboardRead","binding":binding,"handle":participant["handle"]}}));
    assert!(
        matches!(child.response(request).0, Outcome::Error { error } if error.code == ErrorCode::Unsupported)
    );

    let chunks = [" first ", "λ🚋\n", ""];
    for (sequence, expected) in [(2, None), (4, Some(chunks.concat())), (6, None)] {
        let request = child.send(copy(sequence));
        let (result, presses, releases, conversions) = std::thread::scope(|scope| {
            let reply = scope.spawn(|| child.response(request).0);
            let mut presses = 0;
            let mut releases = 0;
            let mut copied_key = None;
            let mut conversions = 0;
            let mut transfer = None;
            let mut chunks = chunks.into_iter();
            while !reply.is_finished() {
                while let Some(event) = selected.poll_for_event().unwrap() {
                    match event {
                        Event::KeyPress(e) if e.state.contains(KeyButMask::CONTROL) => {
                            assert_eq!(e.event, window);
                            presses += 1;
                            copied_key = Some(e.detail);
                            if sequence == 2 {
                                own(&foreign, other);
                            } else if sequence == 4 {
                                own(&selected, owner);
                            }
                        }
                        Event::KeyRelease(e) if Some(e.detail) == copied_key => {
                            assert_eq!(e.event, window);
                            releases += 1;
                        }
                        Event::SelectionRequest(e) => {
                            assert_eq!(e.owner, owner);
                            assert_eq!(e.selection, clipboard);
                            conversions += 1;
                            selected
                                .change_window_attributes(
                                    e.requestor,
                                    &x11rb::protocol::xproto::ChangeWindowAttributesAux::new()
                                        .event_mask(EventMask::PROPERTY_CHANGE),
                                )
                                .unwrap()
                                .check()
                                .unwrap();
                            selected
                                .change_property32(
                                    PropMode::REPLACE,
                                    e.requestor,
                                    e.property,
                                    incr,
                                    &[14],
                                )
                                .unwrap()
                                .check()
                                .unwrap();
                            selected
                                .send_event(
                                    false,
                                    e.requestor,
                                    EventMask::NO_EVENT,
                                    SelectionNotifyEvent {
                                        response_type: SELECTION_NOTIFY_EVENT,
                                        sequence: 0,
                                        time: e.time,
                                        requestor: e.requestor,
                                        selection: e.selection,
                                        target: e.target,
                                        property: e.property,
                                    },
                                )
                                .unwrap()
                                .check()
                                .unwrap();
                            transfer = Some(e);
                        }
                        Event::PropertyNotify(e) if e.state == Property::DELETE => {
                            if let Some(transfer) = transfer.filter(|request| {
                                (e.window, e.atom) == (request.requestor, request.property)
                            }) && let Some(chunk) = chunks.next()
                            {
                                selected
                                    .change_property8(
                                        PropMode::REPLACE,
                                        e.window,
                                        e.atom,
                                        transfer.target,
                                        chunk.as_bytes(),
                                    )
                                    .unwrap()
                                    .check()
                                    .unwrap();
                            }
                        }
                        _ => {}
                    }
                }
                while let Some(event) = foreign.poll_for_event().unwrap() {
                    assert!(!matches!(
                        event,
                        Event::SelectionRequest(_) | Event::KeyPress(_)
                    ));
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            (reply.join().unwrap(), presses, releases, conversions)
        });
        assert_eq!((presses, releases), (1, 1));
        assert_eq!(conversions, usize::from(expected.is_some()));
        assert_eq!(
            result,
            Outcome::Ok {
                data: json!({"handle":participant["handle"],"sequence":sequence,"text":expected})
            }
        );
    }
    let request = child.send(copy(6));
    assert!(
        matches!(child.response(request).0, Outcome::Error { error } if error.code == ErrorCode::InvalidRequest)
    );
    assert_eq!(
        selected.get_input_focus().unwrap().reply().unwrap().focus,
        other
    );
    // Drop the fixture's selection before the display is used by another test.
    own(&selected, NONE);
    child.stop(true);
}

#[test]
fn unknown_cancellation_does_not_cancel_a_future_request() {
    let mut child = Process::start(true);
    let cancellation = Frame {
        header: Header {
            version: PROTOCOL_VERSION,
            message: Message::Cancel { request_id: 1 },
        },
        payload: vec![],
    };
    write_frame(child.input.as_mut().unwrap(), &cancellation).unwrap();
    child.call(json!({"operation":"capabilities.get"}));
    child.stop(true);
}

#[test]
fn truncated_frame_terminates_without_a_false_success() {
    let mut child = Process::start(true);
    child.input.as_mut().unwrap().write_all(&[0, 0, 1]).unwrap();
    child.stop(false);
}

#[test]
fn duplicate_request_ids_close_the_ambiguous_connection() {
    let mut child = Process::start(true);
    child.call(json!({"operation":"capabilities.get"}));
    child.next_id = 0;
    child.send(json!({"operation":"capabilities.get"}));
    child.stop(false);
}

#[test]
fn javascript_target_page_options_cross_actual_framed_host_bridge_and_remain_persistent() {
    let mut child = Process::start(true);
    let evaluation = child.send(evaluate(
        binding(),
        "const page = await cua.targets({after:'fake-monitor'}); page.targets[0].id",
    ));
    assert_eq!(
        host_call(&mut child, evaluation, 1),
        json!({"operation":"targets","after":"fake-monitor"})
    );
    let (inventory, _) = child.call(json!({"operation":"targets.list","after":"fake-monitor"}));
    assert_eq!(inventory["targets"].as_array().unwrap().len(), 1);
    assert!(inventory.get("nextCursor").is_none());
    host_result(&mut child, evaluation, 1, inventory);
    assert_eq!(
        child.response(evaluation).0,
        Outcome::Ok {
            data: json!({"value":"fake-window"})
        }
    );
    assert_eq!(
        child.call(evaluate(binding(), "page.targets[0].id")).0,
        json!({"value":"fake-window"})
    );
    for options in [
        "null",
        "[]",
        "{after:null}",
        "{after:3}",
        "{binding:{}}",
        "{after:'bad\\nline'}",
    ] {
        let id = child.send(evaluate(
            binding(),
            &format!("await cua.targets({options})"),
        ));
        assert!(matches!(child.response(id).0, Outcome::Error { .. }));
    }
    child.stop(true);
}

#[test]
fn full_worst_escaped_inventory_page_returns_through_unchanged_javascript_output_limit() {
    use cantrip_cua::{
        backend::{CaptureBackend, FakeBackend},
        cancellation::Cancellation,
    };
    let mut target = FakeBackend
        .targets(&Cancellation::default())
        .unwrap()
        .remove(0);
    target.id = "macos-window-4294967295".into();
    target.title = Some("\u{0001}".repeat(4096));
    target.application = Some("\u{0001}".repeat(1024));
    let mut last = target.clone();
    last.id = "z".into();
    let page = cantrip_cua::inventory::page(vec![last, target], None, false).unwrap();
    let inventory =
        json!({"targets":page.targets,"truncated":page.truncated,"nextCursor":page.next_cursor});
    assert_eq!(inventory["targets"].as_array().unwrap().len(), 1);
    assert!(
        serde_json::to_vec(&json!({"value":inventory}))
            .unwrap()
            .len()
            <= 32 * 1024
    );
    let mut child = Process::start(true);
    let evaluation = child.send(evaluate(binding(), "await cua.targets()"));
    assert_eq!(
        host_call(&mut child, evaluation, 1),
        json!({"operation":"targets"})
    );
    host_result(&mut child, evaluation, 1, inventory.clone());
    let Outcome::Ok { data } = child.response(evaluation).0 else {
        panic!("Full page must fit the existing JavaScript result bound.");
    };
    assert_eq!(data["value"]["nextCursor"], inventory["nextCursor"]);
    assert_eq!(data["value"]["truncated"], inventory["truncated"]);
    // JS has one Number type, so integer-valued native floats serialize as integers.
    let actual: Vec<cantrip_cua::target::Target> =
        serde_json::from_value(data["value"]["targets"].clone()).unwrap();
    let expected: Vec<cantrip_cua::target::Target> =
        serde_json::from_value(inventory["targets"].clone()).unwrap();
    assert_eq!(actual, expected);
    child.stop(true);
}

#[cfg(windows)]
#[path = "fixtures/windows_host.rs"]
mod windows_host;

#[cfg(target_os = "linux")]
#[path = "fixtures/wayland_host.rs"]
mod wayland_host;
