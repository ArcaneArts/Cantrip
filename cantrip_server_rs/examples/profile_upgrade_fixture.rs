//! Deliberately corrupt one disposable migration journal after a real engine
//! open. This test-only executable is never included in a distribution.
use anyhow::{Context, Result};
use cantrip_server::database::Database;
#[tokio::main]
async fn main() -> Result<()> {
    let argument = std::env::args_os()
        .nth(1)
        .context("disposable profile root")?;
    #[cfg(windows)]
    if argument == "--processes" {
        return process_snapshot();
    }
    let root = std::path::PathBuf::from(argument);
    let database = Database::pglite(&root.join("server-db")).await?;
    database.execute("ALTER TABLE drizzle.__drizzle_migrations RENAME COLUMN created_at TO unavailable_created_at").await?;
    database.close().await?;
    println!(
        "{}",
        serde_json::json!({"event":"profile.fixture.migration-journal.corrupted"})
    );
    Ok(())
}

#[cfg(windows)]
fn process_snapshot() -> Result<()> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_NO_MORE_FILES, GetLastError, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
    };
    // Observe native process parents without the startup latency of a shell and
    // WMI provider, which can exceed the actual legacy conversion duration.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    anyhow::ensure!(
        snapshot != INVALID_HANDLE_VALUE,
        std::io::Error::last_os_error()
    );
    let result = (|| -> Result<_> {
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut processes = Vec::new();
        let mut found = unsafe { Process32FirstW(snapshot, &mut entry) };
        while found != 0 {
            let end = entry
                .szExeFile
                .iter()
                .position(|value| *value == 0)
                .unwrap_or(entry.szExeFile.len());
            processes.push(serde_json::json!([
                entry.th32ProcessID,
                entry.th32ParentProcessID,
                String::from_utf16_lossy(&entry.szExeFile[..end]),
            ]));
            found = unsafe { Process32NextW(snapshot, &mut entry) };
        }
        let error = unsafe { GetLastError() };
        anyhow::ensure!(
            error == ERROR_NO_MORE_FILES,
            std::io::Error::from_raw_os_error(error as i32)
        );
        Ok(processes)
    })();
    unsafe { CloseHandle(snapshot) };
    println!("{}", serde_json::to_string(&result?)?);
    Ok(())
}
