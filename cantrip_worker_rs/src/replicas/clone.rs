//! Owned streaming clone, preserving the existing progress/heartbeat/watchdog
//! rules. No response lifetime or persisted PID grants cancellation authority.
use super::Progress;
use crate::{
    error::WireError,
    filesystem::{Scope, paths},
};
use anyhow::{Result, anyhow};
use cantrip_wire::{JsString, value::json};
use std::{path::Path, sync::OnceLock, time::Duration};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
    time::Instant,
};

pub fn parse_clone_progress(output: &JsString) -> Option<u8> {
    // Every supported progress record contains these literal ASCII units.
    // Skip the regexp VM on arbitrary output without changing match semantics.
    if !output.units().contains(&37) || !output.units().contains(&58) {
        return None;
    }
    static REGEXES: OnceLock<Vec<(regress::Regex, u8, u8)>> = OnceLock::new();
    let mut latest = None;
    for (regex, offset, range) in REGEXES.get_or_init(|| {
        [
            (r"Receiving objects:\s+(\d+)%", 30, 42),
            (r"Resolving deltas:\s+(\d+)%", 72, 12),
            (r"Updating files:\s+(\d+)%", 84, 4),
        ]
        .into_iter()
        .map(|(pattern, offset, range)| {
            (
                regress::Regex::with_flags(pattern, "giu").unwrap(),
                offset,
                range,
            )
        })
        .collect()
    }) {
        for found in regex.find_from_utf16(output.units(), 0) {
            if latest.is_none_or(|(index, _)| found.range.start >= index) {
                let number = JsString::new(output.units()[found.group(1).unwrap()].to_vec())
                    .lossy()
                    .parse::<f64>()
                    .unwrap_or(f64::INFINITY)
                    .clamp(0., 100.);
                latest = Some((
                    found.range.start,
                    offset + (number * f64::from(*range) / 100.).floor() as u8,
                ));
            }
        }
    }
    latest.map(|(_, percent)| percent)
}
pub fn summarize_clone_failure(output: &JsString) -> JsString {
    static DIAGNOSTIC: OnceLock<regress::Regex> = OnceLock::new();
    let regex =
        DIAGNOSTIC.get_or_init(|| regress::Regex::with_flags(r"\b(?:error|fatal):", "iu").unwrap());
    let lines = output
        .units()
        .split(|u| *u == 10 || *u == 13)
        .map(|line| JsString::new(line.to_vec()).trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let diagnostics = lines
        .iter()
        .filter(|line| regex.find_from_utf16(line.units(), 0).next().is_some())
        .collect::<Vec<_>>();
    let (lines, count) = if diagnostics.is_empty() {
        (lines.iter().collect::<Vec<_>>(), 20)
    } else {
        (diagnostics, 8)
    };
    let mut joined = Vec::new();
    for (i, line) in lines[lines.len().saturating_sub(count)..]
        .iter()
        .enumerate()
    {
        if i != 0 {
            joined.push(10)
        }
        joined.extend_from_slice(line.units());
    }
    JsString::new(joined[joined.len().saturating_sub(4000)..].to_vec())
}
pub fn clone_failure(detail: &JsString, windows: bool) -> (&'static str, JsString) {
    static LONG: OnceLock<regress::Regex> = OnceLock::new();
    if windows
        && LONG
            .get_or_init(|| {
                regress::Regex::with_flags(
                    r"\b(?:filename|file name|path)(?: or extension)?(?: is)? too long\b",
                    "iu",
                )
                .unwrap()
            })
            .find_from_utf16(detail.units(), 0)
            .next()
            .is_some()
    {
        ("windows-long-paths-disabled","Git for Windows rejected Cantrip's managed repository path because long-path support is disabled. Enable Git long paths on this worker, then retry setup.".into())
    } else {
        (
            "remote-unavailable",
            JsString::new(
                "Could not clone the repository: "
                    .encode_utf16()
                    .chain(detail.units().iter().copied())
                    .collect(),
            ),
        )
    }
}
#[derive(Clone, Copy)]
struct Timing {
    heartbeat: Duration,
    inactivity: Duration,
    maximum: Duration,
    grace: Duration,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            heartbeat: Duration::from_secs(10),
            inactivity: Duration::from_secs(300),
            maximum: Duration::from_secs(7200),
            grace: Duration::from_secs(5),
        }
    }
}
fn signal(child: &mut Child, force: bool) {
    #[cfg(unix)]
    let _ = cantrip_host::process::signal_owned(
        child,
        if force { libc::SIGKILL } else { libc::SIGTERM },
        true,
        "Owned replica clone",
    );
    #[cfg(windows)]
    {
        let _ = force;
        let _ = child.start_kill();
    }
}
pub(super) async fn repository(
    name: &JsString,
    target: &Path,
    scope: &Scope,
    progress: &Progress<'_>,
) -> Result<()> {
    let mut command = Command::new("gh");
    command
        .args(["repo", "clone"])
        .arg(paths::native(name))
        .arg(target)
        .args(["--", "--progress"]);
    run(command, scope, progress, Timing::default()).await
}
fn inactive(last: i64, now: i64, limit: Duration) -> bool {
    i128::from(now) - i128::from(last) >= limit.as_millis() as i128
}
#[test]
fn inactivity_uses_signed_wall_clock_elapsed() {
    assert!(!inactive(1000, 900, Duration::from_millis(500)));
    assert!(!inactive(1000, 1499, Duration::from_millis(500)));
    assert!(inactive(1000, 1500, Duration::from_millis(500)));
    assert!(inactive(1000, 100000, Duration::from_millis(500)));
}
async fn until(deadline: Option<Instant>) {
    if let Some(deadline) = deadline {
        tokio::time::sleep_until(deadline).await
    } else {
        std::future::pending::<()>().await
    }
}
#[cfg(unix)]
fn signal_name(signal: i32) -> String {
    [
        (libc::SIGHUP, "SIGHUP"),
        (libc::SIGINT, "SIGINT"),
        (libc::SIGQUIT, "SIGQUIT"),
        (libc::SIGILL, "SIGILL"),
        (libc::SIGTRAP, "SIGTRAP"),
        (libc::SIGABRT, "SIGABRT"),
        (libc::SIGBUS, "SIGBUS"),
        (libc::SIGFPE, "SIGFPE"),
        (libc::SIGKILL, "SIGKILL"),
        (libc::SIGUSR1, "SIGUSR1"),
        (libc::SIGSEGV, "SIGSEGV"),
        (libc::SIGUSR2, "SIGUSR2"),
        (libc::SIGPIPE, "SIGPIPE"),
        (libc::SIGALRM, "SIGALRM"),
        (libc::SIGTERM, "SIGTERM"),
        (libc::SIGCHLD, "SIGCHLD"),
        (libc::SIGCONT, "SIGCONT"),
        (libc::SIGSTOP, "SIGSTOP"),
        (libc::SIGTSTP, "SIGTSTP"),
        (libc::SIGTTIN, "SIGTTIN"),
        (libc::SIGTTOU, "SIGTTOU"),
        (libc::SIGURG, "SIGURG"),
        (libc::SIGXCPU, "SIGXCPU"),
        (libc::SIGXFSZ, "SIGXFSZ"),
        (libc::SIGVTALRM, "SIGVTALRM"),
        (libc::SIGPROF, "SIGPROF"),
        (libc::SIGWINCH, "SIGWINCH"),
        (libc::SIGIO, "SIGIO"),
        (libc::SIGSYS, "SIGSYS"),
        #[cfg(target_os = "macos")]
        (libc::SIGEMT, "SIGEMT"),
        #[cfg(target_os = "macos")]
        (libc::SIGINFO, "SIGINFO"),
        #[cfg(target_os = "linux")]
        (libc::SIGPWR, "SIGPWR"),
    ]
    .iter()
    .find(|(number, _)| *number == signal)
    .map_or_else(|| signal.to_string(), |(_, name)| (*name).to_owned())
}
async fn run(
    mut command: Command,
    scope: &Scope,
    progress: &Progress<'_>,
    timing: Timing,
) -> Result<()> {
    scope.check()?;
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => anyhow!("spawn gh ENOENT"),
        std::io::ErrorKind::PermissionDenied => anyhow!("spawn gh EACCES"),
        _ => error.into(),
    })?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let mut out_open = true;
    let mut err_open = true;
    let mut out_chunk = [0; 8192];
    let mut err_chunk = [0; 8192];
    let mut output = JsString::new(Vec::new());
    let mut output_bytes = 0usize;
    let mut current = 30;
    let started = Instant::now();
    let mut last_activity = chrono::Utc::now().timestamp_millis();
    let mut heartbeat = tokio::time::interval_at(started + timing.heartbeat, timing.heartbeat);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut maximum = Some(started + timing.maximum);
    let mut force_kill = None;
    let mut termination: Option<&'static str> = None;
    let result=async {
        loop {
            let chunk=tokio::select! {
                biased;
                _=scope.stopped()=>{scope.check()?;unreachable!()},
                _=until(force_kill)=>{signal(&mut child,true);force_kill=None;continue},
                _=until(maximum)=>{
                    maximum=None;
                    if termination.is_none() {
                        termination=Some("Repository clone exceeded the two-hour safety limit.");
                        signal(&mut child,false);force_kill=Some(Instant::now()+timing.grace);
                    }
                    continue;
                },
                _=heartbeat.tick()=>{
                    progress(json!({"stage":"materializing","percent":current}));
                    if termination.is_none()&&inactive(last_activity,chrono::Utc::now().timestamp_millis(),timing.inactivity) {
                        termination=Some("Repository clone stopped after five minutes without network or Git progress.");
                        signal(&mut child,false);force_kill=Some(Instant::now()+timing.grace);
                    }
                    continue;
                },
                status=child.wait(),if !out_open&&!err_open=>{
                    let status=status?;
                    if let Some(error)=termination {return Err(anyhow!(error))}
                    if status.success(){return Ok(())}
                    let detail=summarize_clone_failure(&output);
                    if !detail.is_empty(){return Err(WireError(detail).into())}
                    #[cfg(unix)]
                    let ending={use std::os::unix::process::ExitStatusExt; match status.signal(){
                        Some(signal)=>format!("signal {}",signal_name(signal)),
                        None=>format!("code {}",status.code().map_or("unknown".to_owned(),|v|v.to_string())),
                    }};
                    #[cfg(windows)]
                    let ending=format!("code {}",status.code().map_or("unknown".to_owned(),|v|v.to_string()));
                    return Err(anyhow!("GitHub clone exited with {ending}."));
                },
                count=stdout.read(&mut out_chunk),if out_open=>{
                    let count=count?;out_open=count!=0;out_chunk[..count].to_vec()
                },
                count=stderr.read(&mut err_chunk),if err_open=>{
                    let count=count?;err_open=count!=0;err_chunk[..count].to_vec()
                },
            };
            if chunk.is_empty(){continue}
            last_activity=chrono::Utc::now().timestamp_millis();
            output_bytes=output_bytes.saturating_add(chunk.len());
            if output_bytes>32*1024*1024 {
                if termination.is_none() {
                    termination=Some("Repository clone output exceeded the 32 MiB safety limit.");
                    signal(&mut child,false);force_kill=Some(Instant::now()+timing.grace);
                }
                continue;
            }
            let units=output.units().iter().copied().chain(String::from_utf8_lossy(&chunk).encode_utf16()).collect::<Vec<_>>();
            output=JsString::new(units[units.len().saturating_sub(16384)..].to_vec());
            if let Some(percent)=parse_clone_progress(&output).filter(|percent|*percent>=current) {
                current=percent;progress(json!({"stage":"materializing","percent":percent}));
            }
        }
    }.await;
    if result.is_err() && child.id().is_some() {
        signal(&mut child, true);
        let _ = child.wait().await;
    }
    result
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::Mutex;
    fn sleeping(marker: &Path, closed: bool) -> Command {
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                if closed {
                    "printf '%s' $$ > \"$1\"; exec 1>&- 2>&-; trap '' TERM; /bin/sleep 30"
                } else {
                    "printf '%s' $$ > \"$1\"; trap '' TERM; /bin/sleep 30"
                },
                "clone-fixture",
            ])
            .arg(marker);
        command
    }
    async fn reaped(marker: &Path) {
        let pid = tokio::fs::read_to_string(marker)
            .await
            .unwrap()
            .parse::<libc::pid_t>()
            .unwrap();
        // Observation only; the actual owned Child, never this persisted PID,
        // is what the implementation signals and waits.
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "owned clone child is still alive"
        );
    }
    #[tokio::test]
    async fn heartbeat_and_watchdogs_reap_owned_clones() {
        for inactivity in [true, false] {
            let directory = tempfile::tempdir().unwrap();
            let marker = directory.path().join("child");
            let events = Mutex::new(Vec::new());
            let timing = Timing {
                heartbeat: Duration::from_millis(10),
                inactivity: Duration::from_millis(if inactivity { 35 } else { 1000 }),
                maximum: Duration::from_millis(if inactivity { 1000 } else { 35 }),
                grace: Duration::from_millis(15),
            };
            let error = tokio::time::timeout(
                Duration::from_secs(3),
                run(
                    sleeping(&marker, false),
                    &Scope::default(),
                    &|event| events.lock().unwrap().push(event),
                    timing,
                ),
            )
            .await
            .unwrap()
            .unwrap_err();
            assert_eq!(
                error.to_string(),
                if inactivity {
                    "Repository clone stopped after five minutes without network or Git progress."
                } else {
                    "Repository clone exceeded the two-hour safety limit."
                }
            );
            assert!(!events.lock().unwrap().is_empty());
            reaped(&marker).await;
        }
    }
    #[tokio::test]
    async fn explicit_runtime_stop_reaps_clones_with_open_or_closed_pipes() {
        for closed in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let marker = directory.path().join("child");
            let (stop, receiver) = tokio::sync::watch::channel(false);
            let scope = Scope::with_stop(receiver);
            let stopping = async {
                tokio::time::timeout(Duration::from_secs(2), async {
                    while !marker.exists() {
                        tokio::time::sleep(Duration::from_millis(5)).await
                    }
                })
                .await
                .unwrap();
                stop.send(true).unwrap();
            };
            let (result, ()) = tokio::join!(
                run(
                    sleeping(&marker, closed),
                    &scope,
                    &|_| {},
                    Timing::default()
                ),
                stopping
            );
            assert_eq!(
                result.unwrap_err().to_string(),
                "Worker workspace operation stopped."
            );
            reaped(&marker).await;
        }
    }
    #[tokio::test]
    async fn combined_clone_output_is_bounded() {
        let mut command = Command::new("/usr/bin/head");
        command.args(["-c", "33554433", "/dev/zero"]);
        let error = tokio::time::timeout(
            Duration::from_secs(15),
            run(command, &Scope::default(), &|_| {}, Timing::default()),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Repository clone output exceeded the 32 MiB safety limit."
        );
    }
}
