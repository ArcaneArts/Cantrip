use anyhow::Result;
use cantrip_host::{files, process, publish};
use std::{fs, io::Write};

#[test]
fn private_writes_and_directory_publication_preserve_existing_destinations() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let stage = temp.path().join("stage 雪");
    files::private_directory(&stage)?;
    let path = stage.join("private.bin");
    files::write_private(&path, b"opaque\0\xff\r\n")?;
    assert_eq!(
        files::write_private(&path, b"replace").unwrap_err().kind(),
        std::io::ErrorKind::AlreadyExists
    );
    assert_eq!(fs::read(&path)?, b"opaque\0\xff\r\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&path)?.permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(&stage)?.permissions().mode() & 0o777, 0o700);
        fs::set_permissions(&stage, fs::Permissions::from_mode(0o755))?;
        files::private_directory(&stage)?;
        assert_eq!(
            fs::metadata(&stage)?.permissions().mode() & 0o777,
            0o755,
            "creation keeps existing-directory behavior"
        );
        files::secure_directory(&stage)?;
        assert_eq!(fs::metadata(&stage)?.permissions().mode() & 0o777, 0o700);
    }
    let destination = temp.path().join("published");
    fs::create_dir(&destination)?;
    assert_eq!(
        publish::directory(&stage, &destination).unwrap_err().kind(),
        std::io::ErrorKind::AlreadyExists
    );
    assert!(stage.is_dir());
    assert_eq!(fs::read_dir(&destination)?.count(), 0);
    fs::remove_dir(&destination)?;
    publish::directory(&stage, &destination)?;
    assert!(!stage.exists());
    assert_eq!(
        fs::read(destination.join("private.bin"))?,
        b"opaque\0\xff\r\n"
    );
    Ok(())
}

#[tokio::test]
async fn pipe_notification_waits_for_eof_after_consuming_data() -> Result<()> {
    use std::time::Duration;
    let (read, mut write) = os_pipe::pipe()?;
    let mut closed = process::pipe_closed(read, "fixture-parent-pipe")?;
    write.write_all(b"still alive")?;
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut closed)
            .await
            .is_err()
    );
    drop(write);
    tokio::time::timeout(Duration::from_secs(2), closed).await??;
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn child_signaling_uses_the_owned_unreaped_handle() -> Result<()> {
    use std::{os::unix::process::CommandExt, process::Stdio, time::Duration};
    let mut command = tokio::process::Command::new("/bin/sh");
    command
        .args(["-c", "exec sleep 30"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    command.as_std_mut().process_group(0);
    let mut child = command.spawn()?;
    process::signal_owned(&child, libc::SIGTERM, true, "fixture owned identity")?;
    let status = tokio::time::timeout(Duration::from_secs(2), child.wait()).await??;
    assert!(!status.success());
    assert!(child.id().is_none());
    assert_eq!(
        process::signal_owned(&child, libc::SIGTERM, true, "fixture owned identity")
            .unwrap_err()
            .to_string(),
        "fixture owned identity"
    );
    Ok(())
}
