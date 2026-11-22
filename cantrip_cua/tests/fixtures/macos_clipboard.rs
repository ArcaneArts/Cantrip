use super::{Command, Outcome, Process, Stdio, Value, json};
use cantrip_cua::error::ErrorCode;
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout},
};

struct Fixture {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Fixture {
    fn start() -> Self {
        let binary = std::env::var_os("CANTRIP_CUA_MACOS_CLIPBOARD_FIXTURE")
            .expect("build the AppKit fixture and set CANTRIP_CUA_MACOS_CLIPBOARD_FIXTURE");
        let mut child = Command::new(binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            input,
            output,
        }
    }

    fn read(&mut self, step: &str) -> Value {
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        let receipt: Value = serde_json::from_str(&line).expect("AppKit fixture reply");
        assert_eq!(receipt["foregroundUnchanged"], true, "{step}: {receipt}");
        assert_eq!(receipt["clipboardUnchanged"], true, "{step}: {receipt}");
        assert_eq!(
            receipt["customClipboardUnchanged"], true,
            "{step}: {receipt}"
        );
        receipt
    }

    fn command(&mut self, command: &str) {
        writeln!(self.input, "{command}").unwrap();
        self.input.flush().unwrap();
        self.read(command);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
#[ignore = "requires Screen Recording and Accessibility for a local AppKit fixture"]
fn copies_only_the_bound_macos_selection_without_a_focus_or_clipboard_change() {
    let mut fixture = Fixture::start();
    let owned = fixture.read("launch");
    assert_ne!(owned["window"], owned["sibling"]);
    let mut helper = Process::start(false);
    let id = format!("macos-window-{}", owned["window"].as_u64().unwrap());
    let mut request = json!({"operation":"targets.list"});
    let mut target = None;
    for _ in 0..64 {
        let (page, _) = helper.call(request.clone());
        target = page["targets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|target| target["id"] == id && target["processId"] == fixture.child.id())
            .cloned();
        if target.is_some() || page["nextCursor"].is_null() {
            break;
        }
        request["after"] = page["nextCursor"].clone();
    }
    let target = target.expect("the fixture window must appear in native inventory");
    let binding = json!({"workerId":"local","surfaceId":"fixture","attachmentId":"one","participantId":"viewer"});
    let op = |request| json!({"operation":"interaction.request","request":request});
    let handle = helper.call(op(json!({
        "type":"open","binding":binding,"targetId":target["id"],"targetGeneration":target["generation"]
    }))).0["handle"].clone();
    let copy = |sequence| {
        op(json!({"type":"clipboardCopy","binding":binding,"handle":handle,"sequence":sequence}))
    };

    assert_eq!(helper.call(copy(2)).0["text"], "selected λ🚋\n\t");
    fixture.command("range");
    assert_eq!(helper.call(copy(4)).0["text"], "selected λ🚋\n\t");
    fixture.command("attributed");
    assert_eq!(helper.call(copy(6)).0["text"], "selected λ🚋\n\t");
    fixture.command("range-and-value");
    assert_eq!(helper.call(copy(8)).0["text"], "selected λ🚋\n\t");
    fixture.command("selection-moves");
    assert!(helper.call(copy(10)).0["text"].is_null());
    fixture.command("range-moves");
    assert!(helper.call(copy(12)).0["text"].is_null());
    fixture.command("multiple");
    assert_eq!(helper.call(copy(14)).0["text"], "selected λ🚋\n\tβ \t");
    fixture.command("multiple-parameterized");
    assert_eq!(helper.call(copy(16)).0["text"], "selected λ🚋\n\tβ \t");
    fixture.command("selection-moves");
    assert!(helper.call(copy(18)).0["text"].is_null());
    fixture.command("secure");
    assert!(helper.call(copy(20)).0["text"].is_null());
    fixture.command("sibling");
    assert!(helper.call(copy(22)).0["text"].is_null());
    fixture.command("empty");
    assert!(helper.call(copy(24)).0["text"].is_null());
    fixture.command("custom-copy");
    assert!(helper.call(copy(26)).0["text"].is_null());
    let replay = helper.send(copy(26));
    assert!(
        matches!(helper.response(replay).0, Outcome::Error { error } if error.code == ErrorCode::InvalidRequest)
    );
    fixture.command("state");
    helper.call(op(
        json!({"type":"close","binding":binding,"handle":handle}),
    ));
    helper.stop(true);
    writeln!(fixture.input, "quit").unwrap();
    fixture.input.flush().unwrap();
    assert!(fixture.child.wait().unwrap().success());
}
