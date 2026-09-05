//! Actual child-process tests: no native desktop access or private screenshots.
use cantrip_cua::protocol::{
    Frame, Header, Message, Outcome, PROTOCOL_VERSION, read_frame, write_frame,
};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::Duration,
};

struct Process {
    child: Child,
    input: Option<ChildStdin>,
    frames: Receiver<std::io::Result<Frame>>,
    next_id: u64,
}

impl Process {
    fn start(fake: bool) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_cantrip-cua"));
        if fake {
            command.args(["--backend", "fake"]);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
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
        loop {
            let result = self
                .frames
                .recv_timeout(Duration::from_secs(5))
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
                    panic!("child stdout did not close before shutdown deadline")
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
        "globalThis.poison = true; new ArrayBuffer(64 * 1024 * 1024)",
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
        "for (let i=0; i<65; i++) { await cua.cursor(); }",
    ));
    for call in 1..=64 {
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
        matches!(child.response(evaluation).0, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Capacity)
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
fn javascript_output_and_source_boundaries_include_the_response_envelope() {
    let mut child = Process::start(true);
    let (value, _) = child.call(evaluate(binding(), "'x'.repeat(32756)"));
    assert_eq!(serde_json::to_vec(&value).unwrap().len(), 32768);
    let id = child.send(evaluate(binding(), "'x'.repeat(32757)"));
    assert!(
        matches!(child.response(id).0, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Capacity)
    );
    let source = format!("{}42", " ".repeat(32766));
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
fn default_binary_never_silently_uses_fake_capture() {
    let mut child = Process::start(false);
    let (capabilities, _) = child.call(json!({"operation":"capabilities.get"}));
    assert_ne!(capabilities["backend"], "fake");
    assert_eq!(capabilities["nativeInput"], false);
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
    #[cfg(not(target_os = "macos"))]
    {
        assert_eq!(capabilities["backend"], "unavailable");
        assert_eq!(capabilities["capture"], false);
        let id = child.send(json!({"operation":"targets.list"}));
        let (outcome, _) = child.response(id);
        assert!(
            matches!(outcome, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Unsupported)
        );
    }
    // On macOS this is deliberately handshake-only: ordinary CI/tests must
    // never enumerate private windows or request Screen Recording permission.
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
