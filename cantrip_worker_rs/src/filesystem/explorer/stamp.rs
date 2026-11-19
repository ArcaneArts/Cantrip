//! Match the file identity fields the existing Node readers hash. Use the
//! open descriptor so a path replacement can't substitute the next stat.
use sha2::{Digest, Sha256};
use std::{
    fs::{File, Metadata},
    io,
};

#[derive(Clone, Copy)]
pub(super) struct Stamp {
    device: i64,
    inode: i64,
    pub size: u64,
    pub modified_ns: i128,
    changed_ns: i128,
    created_ns: i128,
}

impl Stamp {
    pub fn read(file: &File, metadata: &Metadata) -> io::Result<Self> {
        platform_stamp(file, metadata)
    }

    pub fn binary_version(self) -> String {
        let snapshot = format!(
            "{}:{}:{}:{}:{}:{}",
            self.device, self.inode, self.size, self.modified_ns, self.changed_ns, self.created_ns
        );
        format!("binary-v1:{}", hash(snapshot.as_bytes()))
    }

    pub fn preview_version(self) -> String {
        let snapshot = format!(
            "{}:{}:{}:{}:{}",
            self.device, self.inode, self.size, self.modified_ns, self.changed_ns
        );
        hash(snapshot.as_bytes())
    }

    pub fn log_identity(self) -> String {
        let identity = format!("{}:{}:{}", self.device, self.inode, self.created_ns);
        hash(identity.as_bytes())
    }
}

pub(super) fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(unix)]
fn platform_stamp(file: &File, metadata: &Metadata) -> io::Result<Stamp> {
    use std::os::unix::fs::MetadataExt;
    const BILLION: i128 = 1_000_000_000;
    let changed = i128::from(metadata.ctime()) * BILLION + i128::from(metadata.ctime_nsec());
    Ok(Stamp {
        // Node's BigInt stat array interprets these fields as signed 64-bit.
        device: metadata.dev() as i64,
        inode: metadata.ino() as i64,
        size: metadata.len(),
        modified_ns: i128::from(metadata.mtime()) * BILLION + i128::from(metadata.mtime_nsec()),
        changed_ns: changed,
        created_ns: creation_time(file, metadata, changed)?,
    })
}

#[cfg(unix)]
pub(super) fn epoch_nanos(time: std::time::SystemTime) -> i128 {
    match time.duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_nanos() as i128,
        Err(error) => -(error.duration().as_nanos() as i128),
    }
}

#[cfg(target_os = "linux")]
fn creation_time(file: &File, metadata: &Metadata, changed: i128) -> io::Result<i128> {
    use std::os::fd::AsRawFd;
    if let Ok(time) = metadata.created() {
        return Ok(epoch_nanos(time));
    }
    // libuv reports zero for a filesystem without btime when statx succeeds.
    // Its older fstat fallback instead uses ctime. The raw syscall also keeps
    // this path available to builds targeting older glibc.
    let mut stat = std::mem::MaybeUninit::<libc::statx>::zeroed();
    let result = unsafe {
        libc::syscall(
            libc::SYS_statx,
            file.as_raw_fd(),
            c"".as_ptr(),
            libc::AT_EMPTY_PATH,
            libc::STATX_BASIC_STATS | libc::STATX_BTIME,
            stat.as_mut_ptr(),
        )
    };
    if result == 0 {
        let birth = unsafe { stat.assume_init() }.stx_btime;
        return Ok(i128::from(birth.tv_sec) * 1_000_000_000 + i128::from(birth.tv_nsec));
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::EINVAL | libc::EPERM | libc::ENOSYS | libc::EOPNOTSUPP) => Ok(changed),
        _ => Err(error),
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
fn creation_time(_file: &File, metadata: &Metadata, changed: i128) -> io::Result<i128> {
    Ok(metadata.created().map(epoch_nanos).unwrap_or(changed))
}

#[cfg(windows)]
fn platform_stamp(file: &File, metadata: &Metadata) -> io::Result<Stamp> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, FileBasicInfo, GetFileInformationByHandle,
        GetFileInformationByHandleEx,
    };
    let handle = file.as_raw_handle();
    let mut identity = BY_HANDLE_FILE_INFORMATION::default();
    let mut basic = FILE_BASIC_INFO::default();
    unsafe {
        if GetFileInformationByHandle(handle, &mut identity) == 0
            || GetFileInformationByHandleEx(
                handle,
                FileBasicInfo,
                (&mut basic as *mut FILE_BASIC_INFO).cast(),
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            ) == 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    let inode = (u64::from(identity.nFileIndexHigh) << 32) | u64::from(identity.nFileIndexLow);
    Ok(Stamp {
        device: i64::from(identity.dwVolumeSerialNumber),
        inode: inode as i64,
        size: metadata.len(),
        modified_ns: windows_nanos(basic.LastWriteTime),
        changed_ns: windows_nanos(basic.ChangeTime),
        created_ns: windows_nanos(basic.CreationTime),
    })
}

#[cfg(windows)]
pub(super) fn windows_nanos(ticks: i64) -> i128 {
    const TICKS_PER_SECOND: i128 = 10_000_000;
    const WINDOWS_EPOCH: i128 = 116_444_736_000_000_000;
    let from_epoch = i128::from(ticks) - WINDOWS_EPOCH;
    // Node interprets libuv's Windows seconds as unsigned 32-bit.
    let seconds = from_epoch.div_euclid(TICKS_PER_SECOND) as u32;
    i128::from(seconds) * 1_000_000_000 + from_epoch.rem_euclid(TICKS_PER_SECOND) * 100
}
