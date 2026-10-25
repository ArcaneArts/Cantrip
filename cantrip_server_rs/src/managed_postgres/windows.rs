//! pg_ctl supplies PostgreSQL's supported restricted-token startup on Windows.
//! A non-inheritable, kill-on-close job owns pg_ctl and all its descendants even
//! after pg_ctl exits. Assigning the job during creation avoids a spawn race.

use std::{
    ffi::OsStr,
    fs::File,
    io,
    mem::{size_of, size_of_val},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::ExitStatusExt,
    },
    path::Path,
    process::{Command, ExitStatus},
    ptr::{null, null_mut},
    time::Duration,
};

use anyhow::{Context, Result, bail};
use tokio::time::{Instant, sleep};
use windows_sys::Win32::{
    Foundation::{HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::{
        JobObjects::{
            CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
            QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
        },
        Threading::{
            CREATE_NO_WINDOW, CreateProcessW, DeleteProcThreadAttributeList,
            EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, InitializeProcThreadAttributeList,
            LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            PROC_THREAD_ATTRIBUTE_JOB_LIST, PROCESS_INFORMATION, STARTF_USESTDHANDLES,
            STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
        },
    },
};

pub(super) struct PostgresProcess {
    launcher: OwnedHandle,
    job: OwnedHandle,
}

fn checked(success: i32) -> io::Result<()> {
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

// Windows CRT quoting, including quotes and trailing backslashes. Work in UTF-16
// so paths do not pass through lossy Unicode or a command shell.
fn argument(value: &OsStr) -> Result<Vec<u16>> {
    let mut result = vec![b'"' as u16];
    let mut backslashes = 0;
    for unit in value.encode_wide() {
        if unit == 0 {
            bail!("process argument contains a NUL");
        }
        if unit == b'\\' as u16 {
            backslashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            b'\\' as u16,
            if unit == b'"' as u16 {
                backslashes * 2 + 1
            } else {
                backslashes
            },
        ));
        result.push(unit);
        backslashes = 0;
    }
    result.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
    result.push(b'"' as u16);
    Ok(result)
}

// The allocation and attribute values outlive CreateProcessW. usize supplies
// pointer alignment; the API owns the opaque contents, not the backing storage.
struct Attributes(Vec<usize>);

impl Attributes {
    fn new() -> Result<Self> {
        let mut bytes = 0;
        unsafe { InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes) };
        let mut storage = vec![0_usize; bytes.div_ceil(size_of::<usize>())];
        // SAFETY: the documented sizing call above supplies the buffer length.
        checked(unsafe {
            InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), 2, 0, &mut bytes)
        })
        .context("initialize Windows process attributes")?;
        Ok(Self(storage))
    }

    fn pointer(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.0.as_mut_ptr().cast()
    }
}

impl Drop for Attributes {
    fn drop(&mut self) {
        // SAFETY: the initialized list remains in its original allocation.
        unsafe { DeleteProcThreadAttributeList(self.pointer()) };
    }
}

impl PostgresProcess {
    pub(super) fn start(
        binary_directory: &Path,
        data_directory: &Path,
        port: u16,
        log: File,
    ) -> Result<Self> {
        let mut command = Command::new(super::binary(binary_directory, "pg_ctl"));
        command
            .arg("-D")
            .arg(data_directory)
            // Inherit the owned append handle below. pg_ctl's -l redirection
            // would reopen that same file through cmd.exe with incompatible
            // Windows sharing semantics.
            .args(["start", "-w", "-t", "30"])
            .arg("-o")
            .arg(format!(
                "-h 127.0.0.1 -p {port} -c unix_socket_directories="
            ));

        let mut application: Vec<u16> = command.get_program().encode_wide().collect();
        application.push(0);
        let mut command_line = argument(command.get_program())?;
        for value in command.get_args() {
            command_line.push(b' ' as u16);
            command_line.extend(argument(value)?);
        }
        command_line.push(0);

        // SAFETY: no name or security attributes; the returned handle is owned
        // here and is deliberately not inheritable by PostgreSQL descendants.
        let raw_job = unsafe { CreateJobObjectW(null(), null()) };
        if raw_job.is_null() {
            return Err(io::Error::last_os_error()).context("create PostgreSQL process job");
        }
        let job = unsafe { OwnedHandle::from_raw_handle(raw_job) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        checked(unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of_val(&limits) as u32,
            )
        })
        .context("set PostgreSQL process ownership")?;

        let input = File::open(r"\\.\NUL")?;
        let handles: [HANDLE; 2] = [input.as_raw_handle(), log.as_raw_handle()];
        for handle in handles {
            checked(unsafe {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)
            })?;
        }
        let jobs = [job.as_raw_handle()];
        let mut attributes = Attributes::new()?;
        // SAFETY: both handle arrays and their owned handles live until after
        // the attribute list is destroyed. Only stdin/log are inherited; the
        // job is assigned atomically, never inherited as an open handle.
        for (key, values) in [
            (PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles.as_slice()),
            (PROC_THREAD_ATTRIBUTE_JOB_LIST, jobs.as_slice()),
        ] {
            checked(unsafe {
                UpdateProcThreadAttribute(
                    attributes.pointer(),
                    0,
                    key as usize,
                    values.as_ptr().cast(),
                    size_of_val(values),
                    null_mut(),
                    null(),
                )
            })
            .context("set Windows process attributes")?;
        }
        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = size_of_val(&startup) as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = handles[0];
        startup.StartupInfo.hStdOutput = handles[1];
        startup.StartupInfo.hStdError = handles[1];
        startup.lpAttributeList = attributes.pointer();
        let mut process = PROCESS_INFORMATION::default();
        // SAFETY: UTF-16 buffers are NUL terminated, command_line is mutable,
        // and all startup attributes remain valid throughout process creation.
        checked(unsafe {
            CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                null(),
                null(),
                &startup.StartupInfo,
                &mut process,
            )
        })
        .context("launch bundled PostgreSQL through pg_ctl")?;
        let launcher = unsafe { OwnedHandle::from_raw_handle(process.hProcess) };
        drop(unsafe { OwnedHandle::from_raw_handle(process.hThread) });
        Ok(Self { launcher, job })
    }

    pub(super) fn try_wait(&mut self) -> Result<Option<ExitStatus>> {
        let mut status = None;
        // SAFETY: launcher is an owned process handle. A zero timeout never blocks.
        match unsafe { WaitForSingleObject(self.launcher.as_raw_handle(), 0) } {
            WAIT_OBJECT_0 => {
                let mut code = 0;
                checked(unsafe { GetExitCodeProcess(self.launcher.as_raw_handle(), &mut code) })?;
                let exit = ExitStatus::from_raw(code);
                if !exit.success() {
                    return Ok(Some(exit));
                }
                status = Some(exit);
            }
            WAIT_TIMEOUT => {}
            _ => return Err(io::Error::last_os_error()).context("observe PostgreSQL launcher"),
        }
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        checked(unsafe {
            QueryInformationJobObject(
                self.job.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of_val(&accounting) as u32,
                null_mut(),
            )
        })
        .context("observe PostgreSQL process job")?;
        if accounting.ActiveProcesses == 0 {
            Ok(status)
        } else {
            Ok(None)
        }
    }

    pub(super) async fn wait(&mut self) -> Result<ExitStatus> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(status);
            }
            if Instant::now() >= deadline {
                bail!("PostgreSQL processes did not finish after shutdown");
            }
            sleep(Duration::from_millis(50)).await;
        }
    }

    pub(super) async fn kill(&mut self) -> Result<()> {
        checked(unsafe { TerminateJobObject(self.job.as_raw_handle(), 1) })?;
        self.wait().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_arguments_preserve_spaces_quotes_unicode_and_backslashes() -> Result<()> {
        for (input, expected) in [
            ("", "\"\""),
            ("a b 🦀", "\"a b 🦀\""),
            ("C:\\data dir\\", "\"C:\\data dir\\\\\""),
            ("a\\\"b", "\"a\\\\\\\"b\""),
        ] {
            assert_eq!(String::from_utf16(&argument(OsStr::new(input))?)?, expected);
        }
        assert!(argument(OsStr::new("a\0b")).is_err());
        Ok(())
    }
}
