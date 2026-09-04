//! Real reader/executor/writer threads with deterministic channel handshakes.
//! These tests never capture the native desktop or rely on scheduling sleeps.
use cantrip_cua::{
    backend::{Capture, CaptureBackend, FakeBackend},
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    protocol::{Frame, Header, Message, Outcome, PROTOCOL_VERSION, read_frame, write_frame},
    runtime,
    target::Target,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{self, Cursor, Read, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread::JoinHandle,
    time::Duration,
};

const TEST_DEADLINE: Duration = Duration::from_secs(5);

struct ChannelReader {
    input: Receiver<Vec<u8>>,
    current: Cursor<Vec<u8>>,
}

impl Read for ChannelReader {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        while self.current.position() == self.current.get_ref().len() as u64 {
            match self.input.recv_timeout(TEST_DEADLINE) {
                Ok(next) => self.current = Cursor::new(next),
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(0),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "test input deadline",
                    ));
                }
            }
        }
        // Exercise read_exact with fragmented prefixes and JSON headers.
        let amount = bytes.len().min(7);
        self.current.read(&mut bytes[..amount])
    }
}

struct ChannelWriter {
    output: Sender<Frame>,
    bytes: Vec<u8>,
    failed: Arc<AtomicBool>,
}

impl Write for ChannelWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.failed.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "test pipe closed",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        let bytes = std::mem::take(&mut self.bytes);
        let mut input = Cursor::new(bytes);
        let frame =
            read_frame(&mut input)?.ok_or_else(|| io::Error::other("empty output frame"))?;
        if input.position() != input.get_ref().len() as u64 {
            return Err(io::Error::other("interleaved output frames"));
        }
        self.output
            .send(frame)
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "test receiver closed"))
    }
}

struct BlockingCapture {
    entered: Sender<()>,
    exited: Sender<bool>,
}

impl CaptureBackend for BlockingCapture {
    fn name(&self) -> &'static str {
        "blocking-fixture"
    }
    fn available(&self) -> bool {
        true
    }
    fn targets(&mut self, cancellation: &Cancellation) -> Result<Vec<Target>> {
        FakeBackend.targets(cancellation)
    }
    fn capture(&mut self, _target: &Target, cancellation: &Cancellation) -> Result<Capture> {
        cancellation.check()?;
        self.entered.send(()).expect("test is waiting for capture");
        let cancelled = cancellation.wait_cancelled(Duration::from_secs(2));
        let _ = self.exited.send(cancelled);
        if !cancelled {
            return Err(CuaError::new(
                ErrorCode::CaptureFailed,
                "test cancellation was not delivered",
            ));
        }
        cancellation.check()?;
        Err(CuaError::new(
            ErrorCode::CaptureFailed,
            "cancelled token unexpectedly cleared",
        ))
    }
}

struct Harness {
    input: Option<Sender<Vec<u8>>>,
    frames: Receiver<Frame>,
    entered: Receiver<()>,
    exited: Receiver<bool>,
    done: Receiver<io::Result<()>>,
    thread: Option<JoinHandle<()>>,
    fail_output: Arc<AtomicBool>,
    next_id: u64,
    seen_responses: BTreeSet<u64>,
    waiting: BTreeMap<u64, Outcome>,
}

impl Harness {
    fn new() -> Self {
        let (input_tx, input_rx) = mpsc::channel();
        let (output_tx, frames) = mpsc::channel();
        let (entered_tx, entered) = mpsc::channel();
        let (exited_tx, exited) = mpsc::channel();
        let (done_tx, done) = mpsc::sync_channel(1);
        let fail_output = Arc::new(AtomicBool::new(false));
        let writer = ChannelWriter {
            output: output_tx,
            bytes: vec![],
            failed: fail_output.clone(),
        };
        let thread = std::thread::spawn(move || {
            let result = runtime::run(
                BlockingCapture {
                    entered: entered_tx,
                    exited: exited_tx,
                },
                ChannelReader {
                    input: input_rx,
                    current: Cursor::new(vec![]),
                },
                writer,
            );
            let _ = done_tx.send(result);
        });
        Self {
            input: Some(input_tx),
            frames,
            entered,
            exited,
            done,
            thread: Some(thread),
            fail_output,
            next_id: 0,
            seen_responses: BTreeSet::new(),
            waiting: BTreeMap::new(),
        }
    }

    fn send_message(&self, message: Message) {
        let frame = Frame {
            header: Header {
                version: PROTOCOL_VERSION,
                message,
            },
            payload: vec![],
        };
        let mut bytes = vec![];
        write_frame(&mut bytes, &frame).unwrap();
        self.input.as_ref().unwrap().send(bytes).unwrap();
    }

    fn request(&mut self, operation: Value) -> u64 {
        self.next_id += 1;
        self.send_message(Message::Request {
            request_id: self.next_id,
            operation,
        });
        self.next_id
    }

    fn cancel(&self, request_id: u64) {
        self.send_message(Message::Cancel { request_id });
    }

    fn accept_frame(&mut self, frame: Frame) {
        match frame.header.message {
            Message::Response { request_id, result } => {
                assert!(
                    self.seen_responses.insert(request_id),
                    "duplicate terminal response for {request_id}"
                );
                assert!(
                    frame.payload.is_empty(),
                    "cancelled capture must not emit pixels"
                );
                self.waiting.insert(request_id, result);
            }
            Message::Event { .. } => assert!(frame.payload.is_empty()),
            other => panic!("unexpected output message {other:?}"),
        }
    }

    fn response(&mut self, id: u64) -> Outcome {
        loop {
            if let Some(result) = self.waiting.remove(&id) {
                return result;
            }
            let frame = self
                .frames
                .recv_timeout(TEST_DEADLINE)
                .expect("runtime response deadline");
            self.accept_frame(frame);
        }
    }

    fn attach(&mut self) {
        let id = self.request(json!({
            "operation":"target.attach", "binding":binding(),
            "targetId":"fake-window", "targetGeneration":1,
        }));
        assert!(matches!(self.response(id), Outcome::Ok { .. }));
        // Drain the attachment event too: later output-failure tests must
        // trigger their own write, not race this earlier event.
        let event = self
            .frames
            .recv_timeout(TEST_DEADLINE)
            .expect("attachment event deadline");
        assert!(
            matches!(event.header.message, Message::Event { event, .. } if event["kind"] == "targetAttached")
        );
    }

    fn capture_and_wait_until_entered(&mut self) -> u64 {
        let id = self.request(json!({
            "operation":"observation.snapshot", "binding":binding(),
            "targetId":"fake-window", "targetGeneration":1,
        }));
        self.entered
            .recv_timeout(TEST_DEADLINE)
            .expect("native capture entry deadline");
        id
    }

    fn assert_capture_was_cancelled(&self) {
        assert!(
            self.exited
                .recv_timeout(TEST_DEADLINE)
                .expect("native cancellation deadline")
        );
    }

    fn finish(&mut self) -> io::Result<()> {
        self.input.take();
        let result = self
            .done
            .recv_timeout(TEST_DEADLINE)
            .expect("runtime shutdown deadline");
        self.thread
            .take()
            .unwrap()
            .join()
            .expect("runtime panicked");
        while let Ok(frame) = self.frames.try_recv() {
            self.accept_frame(frame);
        }
        result
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.input.take();
        if self.thread.is_some() && self.done.recv_timeout(TEST_DEADLINE).is_ok() {
            let _ = self.thread.take().unwrap().join();
        }
    }
}

fn binding() -> Value {
    json!({ "sessionId":"runtime-session", "workerId":"runtime-worker", "chatId":"runtime-chat" })
}

fn assert_error(outcome: Outcome, expected: ErrorCode) {
    let Outcome::Error { error } = outcome else {
        panic!("expected {expected:?}, got {outcome:?}")
    };
    assert_eq!(error.code, expected);
}

#[test]
fn reader_cancels_capture_that_is_actually_in_flight_and_runtime_remains_usable() {
    let mut harness = Harness::new();
    harness.attach();
    let capture = harness.capture_and_wait_until_entered();
    harness.cancel(capture);
    harness.assert_capture_was_cancelled();
    assert_error(harness.response(capture), ErrorCode::Cancelled);
    let capability = harness.request(json!({"operation":"capabilities.get"}));
    assert!(matches!(harness.response(capability), Outcome::Ok { .. }));
    harness.finish().unwrap();
    assert_eq!(harness.seen_responses, BTreeSet::from([1, 2, 3]));
    assert!(harness.waiting.is_empty());
}

#[test]
fn queued_cancellation_prevents_cursor_mutation_and_has_one_terminal_response() {
    let mut harness = Harness::new();
    harness.attach();
    let capture = harness.capture_and_wait_until_entered();
    let queued = harness.request(json!({
        "operation":"cursor.move", "binding":binding(), "targetId":"fake-window",
        "targetGeneration":1, "position":{"x":50,"y":30},
    }));
    harness.cancel(queued);
    harness.cancel(capture);
    harness.assert_capture_was_cancelled();
    assert_error(harness.response(capture), ErrorCode::Cancelled);
    assert_error(harness.response(queued), ErrorCode::Cancelled);
    let attached = harness.request(json!({
        "operation":"target.attach", "binding":binding(),
        "targetId":"fake-window", "targetGeneration":1,
    }));
    let Outcome::Ok { data } = harness.response(attached) else {
        panic!("reattach failed")
    };
    assert_eq!(
        data["session"]["cursor"]["position"],
        json!({"x":0.0,"y":0.0})
    );
    harness.finish().unwrap();
    assert_eq!(harness.seen_responses, BTreeSet::from([1, 2, 3, 4]));
}

#[test]
fn eof_cancels_in_flight_capture_and_flushes_its_terminal_response_before_exit() {
    let mut harness = Harness::new();
    harness.attach();
    let capture = harness.capture_and_wait_until_entered();
    let queued = harness.request(json!({"operation":"capabilities.get"}));
    harness.input.take();
    harness.assert_capture_was_cancelled();
    harness.finish().unwrap();
    assert_error(harness.response(capture), ErrorCode::Cancelled);
    assert_error(harness.response(queued), ErrorCode::Cancelled);
    assert_eq!(harness.seen_responses, BTreeSet::from([1, 2, 3]));
}

#[test]
fn saturated_request_queue_still_reads_cancellation_and_replies_once_per_request() {
    let mut harness = Harness::new();
    harness.attach();
    let capture = harness.capture_and_wait_until_entered();
    // One executing capture plus 31 queued jobs fills the 32 pending slots.
    let queued: Vec<_> = (0..31)
        .map(|_| harness.request(json!({"operation":"capabilities.get"})))
        .collect();
    let rejected = harness.request(json!({"operation":"capabilities.get"}));
    assert_error(harness.response(rejected), ErrorCode::Capacity);
    harness.cancel(capture);
    harness.assert_capture_was_cancelled();
    assert_error(harness.response(capture), ErrorCode::Cancelled);
    for id in queued {
        assert!(matches!(harness.response(id), Outcome::Ok { .. }));
    }
    harness.finish().unwrap();
    assert_eq!(harness.seen_responses, (1..=34).collect());
    assert!(harness.waiting.is_empty());
}

#[test]
fn failed_output_pipe_cancels_native_capture_without_waiting_for_input_eof() {
    let mut harness = Harness::new();
    harness.attach();
    let _capture = harness.capture_and_wait_until_entered();
    harness.fail_output.store(true, Ordering::Release);
    // Capacity rejection causes a write while the service is still in capture.
    for _ in 0..32 {
        harness.request(json!({"operation":"capabilities.get"}));
    }
    // Keep input open until cancellation was observed, proving EOF did not cause it.
    harness.assert_capture_was_cancelled();
    assert!(harness.input.is_some());
    assert!(harness.finish().is_err());
}
