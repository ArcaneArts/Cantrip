use anyhow::Result;
use cantrip_server::profile::{
    ActivationStep, activate_profile, activate_profile_with_progress, exclusive_lease, lease,
    recover_profile_activation,
};
use std::{fs, panic::AssertUnwindSafe, path::Path, sync::mpsc, time::Duration};

fn fixture(directory: &Path, value: &[u8]) -> Result<()> {
    fs::create_dir_all(directory.join("server-db"))?;
    fs::write(directory.join("server-db/opaque-data"), value)?;
    fs::write(
        directory.join("secret-encryption-key.json"),
        b"opaque-key\0\xff",
    )?;
    Ok(())
}

#[test]
fn activation_keeps_the_old_directory_and_retries_keep_later_writes() -> Result<()> {
    let owner = tempfile::tempdir()?;
    let active = owner.path().join("active");
    let prepared = owner.path().join("prepared");
    fixture(&active, b"original-data")?;
    fixture(&prepared, b"migrated-data")?;
    let receipt = activate_profile(&prepared, &active)?;
    assert_eq!(
        fs::read(receipt.backup_directory.join("server-db/opaque-data"))?,
        b"original-data"
    );
    assert_eq!(
        fs::read(active.join("server-db/opaque-data"))?,
        b"migrated-data"
    );
    fs::write(
        active.join("server-db/opaque-data"),
        b"accepted-after-activation",
    )?;
    let retry = activate_profile(&prepared, &active)?;
    assert_eq!(receipt.activation_id, retry.activation_id);
    assert_eq!(
        fs::read(active.join("server-db/opaque-data"))?,
        b"accepted-after-activation"
    );
    // Reusing a preparation pathname for a newly prepared profile is a new
    // explicit operation, rather than an acknowledgement of the old operation.
    fixture(&prepared, b"newly-prepared-reverse-conversion")?;
    let next = activate_profile(&prepared, &active)?;
    assert_ne!(next.activation_id, receipt.activation_id);
    assert_eq!(
        fs::read(next.backup_directory.join("server-db/opaque-data"))?,
        b"accepted-after-activation"
    );
    assert_eq!(
        fs::read(active.join("server-db/opaque-data"))?,
        b"newly-prepared-reverse-conversion"
    );
    assert_eq!(
        fs::read(receipt.backup_directory.join("secret-encryption-key.json"))?,
        b"opaque-key\0\xff"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for entry in fs::read_dir(owner.path())? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                assert_eq!(entry.metadata()?.permissions().mode() & 0o777, 0o600);
            }
        }
    }
    Ok(())
}

#[test]
fn each_interrupted_rename_recovers_before_the_active_profile_is_opened() -> Result<()> {
    for pause in [
        ActivationStep::PreparedMoved,
        ActivationStep::PreviousRetained,
        ActivationStep::NewPublished,
        ActivationStep::Completed,
    ] {
        let owner = tempfile::tempdir()?;
        let active = owner.path().join("active");
        let prepared = owner.path().join("prepared");
        fixture(&active, b"original-data")?;
        fixture(&prepared, b"converted-data")?;
        let interrupted = std::panic::catch_unwind(AssertUnwindSafe(|| {
            activate_profile_with_progress(&prepared, &active, |step| {
                if step == pause {
                    panic!("interrupted after actual rename");
                }
            })
        }));
        assert!(interrupted.is_err());
        let _serving_lease = lease(&active)?;
        assert_eq!(
            fs::read(active.join("server-db/opaque-data"))?,
            b"converted-data"
        );
        drop(_serving_lease);
        let receipt = recover_profile_activation(&active)?.unwrap();
        assert_eq!(
            fs::read(receipt.backup_directory.join("server-db/opaque-data"))?,
            b"original-data"
        );
        fs::write(active.join("server-db/opaque-data"), b"new-http-write")?;
        let retry = activate_profile(&prepared, &active)?;
        assert_eq!(retry.activation_id, receipt.activation_id);
        assert_eq!(
            fs::read(active.join("server-db/opaque-data"))?,
            b"new-http-write"
        );
    }
    Ok(())
}

#[test]
fn an_actual_invalid_source_operation_preserves_the_usable_original() -> Result<()> {
    let owner = tempfile::tempdir()?;
    let active = owner.path().join("active");
    let prepared = owner.path().join("not-a-directory");
    fixture(&active, b"original-data")?;
    fs::write(&prepared, b"private-invalid-source")?;
    let error = activate_profile(&prepared, &active).err().unwrap();
    assert!(!format!("{error:?}").contains("private-invalid-source"));
    let _lease = lease(&active)?;
    assert_eq!(
        fs::read(active.join("server-db/opaque-data"))?,
        b"original-data"
    );
    assert_eq!(fs::read(prepared)?, b"private-invalid-source");
    Ok(())
}

#[test]
fn multiple_serving_readers_exclude_the_directory_switch_until_they_stop() -> Result<()> {
    let owner = tempfile::tempdir()?;
    let active = owner.path().join("active");
    let prepared = owner.path().join("prepared");
    fixture(&active, b"original-data")?;
    fixture(&prepared, b"converted-data")?;
    let first = lease(&active)?;
    let second = lease(&active)?;
    let (began_tx, began_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let next_active = active.clone();
    let next = std::thread::spawn(move || {
        began_tx.send(()).unwrap();
        done_tx
            .send(activate_profile(&prepared, &next_active))
            .unwrap();
    });
    began_rx.recv_timeout(Duration::from_secs(5))?;
    assert!(done_rx.recv_timeout(Duration::from_millis(50)).is_err());
    drop(first);
    assert!(done_rx.recv_timeout(Duration::from_millis(50)).is_err());
    assert_eq!(
        fs::read(active.join("server-db/opaque-data"))?,
        b"original-data"
    );
    drop(second);
    let receipt = done_rx.recv_timeout(Duration::from_secs(5))??;
    next.join().unwrap();
    assert_eq!(
        fs::read(receipt.backup_directory.join("server-db/opaque-data"))?,
        b"original-data"
    );
    assert_eq!(
        fs::read(active.join("server-db/opaque-data"))?,
        b"converted-data"
    );
    Ok(())
}

#[test]
fn a_missing_uncommitted_candidate_does_not_gate_the_healthy_active_profile() -> Result<()> {
    let owner = tempfile::tempdir()?;
    let active = owner.path().join("active");
    let prepared = owner.path().join("prepared");
    fixture(&active, b"current-accepted-writes")?;
    fixture(&prepared, b"uncommitted-candidate")?;
    let interrupted = std::panic::catch_unwind(AssertUnwindSafe(|| {
        activate_profile_with_progress(&prepared, &active, |step| {
            if step == ActivationStep::PreparedMoved {
                for entry in fs::read_dir(owner.path()).unwrap() {
                    let entry = entry.unwrap();
                    if entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".cantrip-activation-incoming-")
                    {
                        fs::remove_dir_all(entry.path()).unwrap();
                    }
                }
                panic!("candidate disappeared before old directory retention");
            }
        })
    }));
    assert!(interrupted.is_err());
    let _serving = lease(&active)?;
    assert_eq!(
        fs::read(active.join("server-db/opaque-data"))?,
        b"current-accepted-writes"
    );
    drop(_serving);
    assert!(recover_profile_activation(&active)?.is_none());
    Ok(())
}

#[test]
fn loss_of_both_profiles_never_recovers_by_creating_a_fresh_active_directory() -> Result<()> {
    let owner = tempfile::tempdir()?;
    let active = owner.path().join("active");
    let prepared = owner.path().join("prepared");
    fixture(&active, b"current-accepted-writes")?;
    fixture(&prepared, b"candidate")?;
    let interrupted = std::panic::catch_unwind(AssertUnwindSafe(|| {
        activate_profile_with_progress(&prepared, &active, |step| {
            if step == ActivationStep::PreparedMoved {
                fs::remove_dir_all(&active).unwrap();
                for entry in fs::read_dir(owner.path()).unwrap() {
                    let entry = entry.unwrap();
                    if entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".cantrip-activation-incoming-")
                    {
                        fs::remove_dir_all(entry.path()).unwrap();
                    }
                }
                panic!("both profiles disappeared");
            }
        })
    }));
    assert!(interrupted.is_err());
    assert!(lease(&active).is_err());
    assert!(!active.exists());
    assert!(recover_profile_activation(&active).is_err());
    assert!(!active.exists());
    Ok(())
}

#[test]
fn a_completed_record_does_not_turn_missing_data_into_a_new_installation() -> Result<()> {
    let owner = tempfile::tempdir()?;
    let active = owner.path().join("active");
    let prepared = owner.path().join("prepared");
    fixture(&active, b"previous-data")?;
    fixture(&prepared, b"converted-data")?;
    let receipt = activate_profile(&prepared, &active)?;
    fs::remove_dir_all(&active)?;
    assert!(lease(&active).is_err());
    assert!(recover_profile_activation(&active).is_err());
    assert!(activate_profile(&prepared, &active).is_err());
    assert!(!active.exists());
    assert_eq!(
        fs::read(receipt.backup_directory.join("server-db/opaque-data"))?,
        b"previous-data"
    );
    // An explicit logical restore into the missing destination is a real repair
    // operation; its exclusive lease must allow the importer to do that work.
    let _restore = exclusive_lease(&active)?;
    assert!(!active.exists());
    Ok(())
}
