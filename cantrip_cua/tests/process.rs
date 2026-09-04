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

#[test]
fn real_executable_handshake_cursor_png_and_shutdown() {
    let mut child = Process::start(true);
    let (capabilities, _) = child.call(json!({"operation":"capabilities.get"}));
    assert_eq!(capabilities["backend"], "fake");
    assert_eq!(capabilities["nativeInput"], false);
    assert_eq!(capabilities["javascript"], false);
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
    assert_eq!(capabilities["backend"], "unavailable");
    assert_eq!(capabilities["capture"], false);
    let id = child.send(json!({"operation":"targets.list"}));
    let (outcome, _) = child.response(id);
    assert!(
        matches!(outcome, Outcome::Error { error } if error.code == cantrip_cua::error::ErrorCode::Unsupported)
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
