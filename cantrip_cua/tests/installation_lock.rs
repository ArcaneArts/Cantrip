use std::{
    fs,
    io::Read,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver},
    },
    time::Duration,
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "cantrip-cua-lock-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn lock_path(&self) -> PathBuf {
        self.0.join("installation.lock")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

struct Process(Child, Receiver<u8>);
impl Process {
    fn start(args: &[&std::ffi::OsStr]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_cantrip-cua"))
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut byte = [0];
            while stdout.read_exact(&mut byte).is_ok() {
                if sender.send(byte[0]).is_err() {
                    break;
                }
            }
        });
        Self(child, receiver)
    }
    fn lock(fixture: &Fixture) -> Self {
        Self::start(&[
            "--installation-lock".as_ref(),
            fixture.lock_path().as_os_str(),
        ])
    }
    fn acquired(&self) {
        assert_eq!(self.1.recv_timeout(Duration::from_secs(5)).unwrap(), 1);
    }
    fn finished(&mut self, code: Option<i32>) -> String {
        assert_eq!(
            self.1.recv_timeout(Duration::from_secs(5)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
        assert_eq!(self.0.wait().unwrap().code(), code);
        let mut stderr = String::new();
        self.0
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        stderr
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn contention_fails_without_waiting_and_eof_releases_without_removing_the_file() {
    let fixture = Fixture::new();
    fs::write(fixture.lock_path(), "retained contents").unwrap();
    let mut first = Process::lock(&fixture);
    first.acquired();
    let mut contender = Process::lock(&fixture);
    assert_eq!(
        contender.finished(Some(1)),
        "{\"event\":\"cua.installation.failed\",\"reason\":\"installation-lock-busy\"}\n"
    );
    first.0.stdin.take();
    assert!(first.finished(Some(0)).is_empty());
    let mut replacement = Process::lock(&fixture);
    replacement.acquired();
    replacement.0.stdin.take();
    assert!(replacement.finished(Some(0)).is_empty());
    assert_eq!(fs::read(fixture.lock_path()).unwrap(), b"retained contents");
}

#[test]
fn process_termination_releases_lock_even_while_parent_keeps_stdin_open() {
    let fixture = Fixture::new();
    let mut first = Process::lock(&fixture);
    first.acquired();
    first.0.kill().unwrap();
    assert!(!first.0.wait().unwrap().success());
    let mut replacement = Process::lock(&fixture);
    replacement.acquired();
    replacement.0.stdin.take();
    assert!(replacement.finished(Some(0)).is_empty());
}

#[test]
fn invalid_arguments_and_inaccessible_path_fail_without_echoing_input() {
    for args in [vec!["--installation-lock"], vec!["--installation-lock", ""]] {
        let mut child = Process::start(&args.iter().map(std::ffi::OsStr::new).collect::<Vec<_>>());
        assert!(child.finished(Some(2)).starts_with("Usage: cantrip-cua"));
    }
    let fixture = Fixture::new();
    let missing = fixture.0.join("private-missing-parent").join("lock");
    let mut child = Process::start(&["--installation-lock".as_ref(), missing.as_os_str()]);
    assert_eq!(
        child.finished(Some(1)),
        "{\"event\":\"cua.installation.failed\",\"reason\":\"installation-lock-failure\"}\n"
    );
    assert!(!missing.exists());
}
