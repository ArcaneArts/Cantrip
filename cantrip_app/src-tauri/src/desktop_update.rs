#![cfg_attr(debug_assertions, allow(dead_code))]

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
#[cfg(all(
    desktop,
    not(debug_assertions),
    any(target_os = "macos", target_os = "windows")
))]
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
#[cfg(all(
    desktop,
    not(debug_assertions),
    any(target_os = "macos", target_os = "windows")
))]
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_updater::{Error as UpdaterError, Update};
use tokio::sync::Notify;

const UPDATE_EVENT: &str = "cantrip-desktop-update-progress";
const RELEASE_NOTES_LIMIT: usize = 100_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum UpdatePhase {
    #[default]
    Idle,
    Checking,
    Ready,
    Downloading,
    Verifying,
    Installing,
    Restarting,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateRelease {
    current_version: String,
    version: String,
    published_at: Option<String>,
    release_notes: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateCapability {
    available: bool,
    installed_version: String,
    reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateCheck {
    status: UpdateCheckStatus,
    installed_version: String,
    release: Option<DesktopUpdateRelease>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum UpdateCheckStatus {
    Current,
    Available,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateStatus {
    phase: UpdatePhase,
    release: Option<DesktopUpdateRelease>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActiveWorkSummary {
    active_chats: u32,
    queued_prompts: u32,
    terminal_services: u32,
    background_jobs: u32,
}

impl ActiveWorkSummary {
    fn total(&self) -> u32 {
        self.active_chats
            .saturating_add(self.queued_prompts)
            .saturating_add(self.terminal_services)
            .saturating_add(self.background_jobs)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallDesktopUpdateRequest {
    active_work: ActiveWorkSummary,
    confirm_active_work: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateInstallResult {
    version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateError {
    code: &'static str,
    message: String,
    retryable: bool,
}

impl DesktopUpdateError {
    fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }

    fn unavailable() -> Self {
        Self::new("update_unavailable", updater_unavailable_reason(), false)
    }

    fn busy() -> Self {
        Self::new(
            "update_busy",
            "Another desktop update operation is already in progress.",
            true,
        )
    }
}

struct CoordinatorState {
    phase: UpdatePhase,
    release: Option<DesktopUpdateRelease>,
    update: Option<Update>,
}

impl Default for CoordinatorState {
    fn default() -> Self {
        Self {
            phase: UpdatePhase::Idle,
            release: None,
            update: None,
        }
    }
}

pub struct DesktopUpdateCoordinator {
    cancel_notify: Notify,
    cancel_requested: AtomicBool,
    state: Mutex<CoordinatorState>,
}

impl Default for DesktopUpdateCoordinator {
    fn default() -> Self {
        Self {
            cancel_notify: Notify::new(),
            cancel_requested: AtomicBool::new(false),
            state: Mutex::new(CoordinatorState::default()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateProgress {
    phase: UpdatePhase,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
    message: Option<String>,
    restarting_current_version: bool,
}

fn updater_is_available(desktop: bool, debug: bool, supported_platform: bool) -> bool {
    desktop && !debug && supported_platform
}

fn updater_available() -> bool {
    updater_is_available(
        cfg!(desktop),
        cfg!(debug_assertions),
        cfg!(any(target_os = "macos", target_os = "windows")),
    )
}

fn updater_unavailable_reason() -> String {
    if cfg!(debug_assertions) {
        "Desktop updates are available only in packaged Cantrip builds.".into()
    } else if !cfg!(desktop) {
        "Desktop updates are unavailable on this Cantrip client.".into()
    } else {
        "Desktop updates are supported only on macOS and Windows.".into()
    }
}

fn sanitize_release_notes(value: Option<&str>) -> Option<String> {
    value
        .map(|value| {
            value
                .chars()
                .filter(|character| {
                    !character.is_control() || matches!(character, '\n' | '\r' | '\t')
                })
                .take(RELEASE_NOTES_LIMIT)
                .collect::<String>()
        })
        .filter(|value| !value.trim().is_empty())
}

fn release_from_update(update: &Update) -> DesktopUpdateRelease {
    DesktopUpdateRelease {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        published_at: update.date.map(|date| date.to_string()),
        release_notes: sanitize_release_notes(update.body.as_deref()),
    }
}

fn validate_download_fields(
    download_url: &url::Url,
    signature: &str,
) -> Result<(), DesktopUpdateError> {
    if download_url.scheme() != "https" {
        return Err(DesktopUpdateError::new(
            "update_insecure_download",
            "The update package did not use HTTPS.",
            false,
        ));
    }
    if signature.trim().is_empty() {
        return Err(DesktopUpdateError::new(
            "update_signature_invalid",
            "The update package did not include a signature.",
            false,
        ));
    }
    Ok(())
}

fn validate_download(update: &Update) -> Result<(), DesktopUpdateError> {
    validate_download_fields(&update.download_url, &update.signature)
}

fn map_updater_error(error: UpdaterError, operation: UpdateOperation) -> DesktopUpdateError {
    let message = error.to_string();
    match error {
        UpdaterError::Minisign(_) | UpdaterError::Base64(_) | UpdaterError::SignatureUtf8(_) => {
            DesktopUpdateError::new(
                "update_signature_invalid",
                "The downloaded update failed signature verification.",
                false,
            )
        }
        UpdaterError::InsecureTransportProtocol => DesktopUpdateError::new(
            "update_insecure_transport",
            "The update service did not use HTTPS.",
            false,
        ),
        _ => match operation {
            UpdateOperation::Check => DesktopUpdateError::new(
                "update_check_failed",
                format!("Could not check for a desktop update: {message}"),
                true,
            ),
            UpdateOperation::Download => DesktopUpdateError::new(
                "update_download_failed",
                format!("Could not download the desktop update: {message}"),
                true,
            ),
            UpdateOperation::Install => DesktopUpdateError::new(
                "update_install_failed",
                format!("Could not install the desktop update: {message}"),
                true,
            ),
        },
    }
}

#[derive(Clone, Copy)]
enum UpdateOperation {
    Check,
    Download,
    Install,
}

fn emit_progress(
    app: &AppHandle,
    phase: UpdatePhase,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
    message: Option<String>,
    restarting_current_version: bool,
) {
    let _ = app.emit(
        UPDATE_EVENT,
        DesktopUpdateProgress {
            phase,
            downloaded_bytes,
            total_bytes,
            message,
            restarting_current_version,
        },
    );
}

fn set_failed(
    coordinator: &DesktopUpdateCoordinator,
    app: &AppHandle,
    error: &DesktopUpdateError,
    restarting_current_version: bool,
) {
    if let Ok(mut state) = coordinator.state.lock() {
        state.phase = UpdatePhase::Failed;
    }
    emit_progress(
        app,
        UpdatePhase::Failed,
        None,
        None,
        Some(error.message.clone()),
        restarting_current_version,
    );
}

fn begin_check(coordinator: &DesktopUpdateCoordinator) -> Result<(), DesktopUpdateError> {
    let mut state = coordinator
        .state
        .lock()
        .map_err(|_| DesktopUpdateError::busy())?;
    if matches!(
        state.phase,
        UpdatePhase::Checking
            | UpdatePhase::Downloading
            | UpdatePhase::Verifying
            | UpdatePhase::Installing
            | UpdatePhase::Restarting
    ) {
        return Err(DesktopUpdateError::busy());
    }
    state.phase = UpdatePhase::Checking;
    state.release = None;
    state.update = None;
    Ok(())
}

fn active_work_requires_confirmation(active_work: &ActiveWorkSummary, confirmed: bool) -> bool {
    active_work.total() > 0 && !confirmed
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PostInstallAction {
    RestartUpdatedVersion,
    InstallerOwnsRelaunch,
}

fn post_install_action(windows: bool) -> PostInstallAction {
    if windows {
        PostInstallAction::InstallerOwnsRelaunch
    } else {
        PostInstallAction::RestartUpdatedVersion
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FailedInstallAction {
    RestartCurrentVersion,
}

fn failed_install_action() -> FailedInstallAction {
    FailedInstallAction::RestartCurrentVersion
}

async fn cancellation_requested(coordinator: &DesktopUpdateCoordinator) {
    if coordinator.cancel_requested.load(Ordering::SeqCst) {
        return;
    }
    coordinator.cancel_notify.notified().await;
}

fn request_cancellation(
    coordinator: &DesktopUpdateCoordinator,
) -> Result<bool, DesktopUpdateError> {
    let state = coordinator
        .state
        .lock()
        .map_err(|_| DesktopUpdateError::busy())?;
    if state.phase != UpdatePhase::Downloading {
        return Ok(false);
    }
    drop(state);
    coordinator.cancel_requested.store(true, Ordering::SeqCst);
    coordinator.cancel_notify.notify_waiters();
    Ok(true)
}

#[tauri::command]
pub fn desktop_update_capability(app: AppHandle) -> DesktopUpdateCapability {
    DesktopUpdateCapability {
        available: updater_available(),
        installed_version: app.package_info().version.to_string(),
        reason: (!updater_available()).then(updater_unavailable_reason),
    }
}

#[tauri::command]
pub fn desktop_update_status(
    coordinator: State<'_, DesktopUpdateCoordinator>,
) -> Result<DesktopUpdateStatus, DesktopUpdateError> {
    let state = coordinator
        .state
        .lock()
        .map_err(|_| DesktopUpdateError::busy())?;
    Ok(DesktopUpdateStatus {
        phase: state.phase,
        release: state.release.clone(),
    })
}

#[tauri::command]
pub async fn check_desktop_update(
    app: AppHandle,
    coordinator: State<'_, DesktopUpdateCoordinator>,
) -> Result<DesktopUpdateCheck, DesktopUpdateError> {
    if !updater_available() {
        return Err(DesktopUpdateError::unavailable());
    }
    begin_check(&coordinator)?;
    emit_progress(&app, UpdatePhase::Checking, None, None, None, false);

    #[cfg(all(
        desktop,
        not(debug_assertions),
        any(target_os = "macos", target_os = "windows")
    ))]
    {
        let before_exit = app.clone();
        let updater = app
            .updater_builder()
            .timeout(Duration::from_secs(30 * 60))
            .on_before_exit(move || {
                crate::shutdown_owned_runtime(&before_exit);
                before_exit.cleanup_before_exit();
            })
            .build()
            .map_err(|error| map_updater_error(error, UpdateOperation::Check));
        let updater = match updater {
            Ok(updater) => updater,
            Err(error) => {
                set_failed(&coordinator, &app, &error, false);
                return Err(error);
            }
        };
        let checked = updater.check().await;
        let checked = match checked {
            Ok(checked) => checked,
            Err(error) => {
                let error = map_updater_error(error, UpdateOperation::Check);
                set_failed(&coordinator, &app, &error, false);
                return Err(error);
            }
        };
        let installed_version = app.package_info().version.to_string();
        if let Some(update) = checked {
            if let Err(error) = validate_download(&update) {
                set_failed(&coordinator, &app, &error, false);
                return Err(error);
            }
            let release = release_from_update(&update);
            if let Ok(mut state) = coordinator.state.lock() {
                state.phase = UpdatePhase::Ready;
                state.release = Some(release.clone());
                state.update = Some(update);
            }
            emit_progress(&app, UpdatePhase::Ready, None, None, None, false);
            return Ok(DesktopUpdateCheck {
                status: UpdateCheckStatus::Available,
                installed_version,
                release: Some(release),
            });
        }
        if let Ok(mut state) = coordinator.state.lock() {
            state.phase = UpdatePhase::Idle;
            state.release = None;
            state.update = None;
        }
        emit_progress(&app, UpdatePhase::Idle, None, None, None, false);
        Ok(DesktopUpdateCheck {
            status: UpdateCheckStatus::Current,
            installed_version,
            release: None,
        })
    }
    #[cfg(not(all(
        desktop,
        not(debug_assertions),
        any(target_os = "macos", target_os = "windows")
    )))]
    unreachable!("availability is false outside packaged macOS and Windows builds")
}

#[tauri::command]
pub async fn install_desktop_update(
    app: AppHandle,
    coordinator: State<'_, DesktopUpdateCoordinator>,
    request: InstallDesktopUpdateRequest,
) -> Result<DesktopUpdateInstallResult, DesktopUpdateError> {
    if !updater_available() {
        return Err(DesktopUpdateError::unavailable());
    }
    if active_work_requires_confirmation(&request.active_work, request.confirm_active_work) {
        return Err(DesktopUpdateError::new(
            "update_active_work_confirmation_required",
            format!(
                "Updating will stop {} active Cantrip operation(s). Confirm before continuing.",
                request.active_work.total()
            ),
            true,
        ));
    }

    #[cfg(not(all(
        desktop,
        not(debug_assertions),
        any(target_os = "macos", target_os = "windows")
    )))]
    let _ = (&app, &coordinator);

    #[cfg(all(
        desktop,
        not(debug_assertions),
        any(target_os = "macos", target_os = "windows")
    ))]
    {
        let (update, release) = {
            let mut state = coordinator
                .state
                .lock()
                .map_err(|_| DesktopUpdateError::busy())?;
            if state.phase != UpdatePhase::Ready {
                return Err(
                    if matches!(
                        state.phase,
                        UpdatePhase::Checking
                            | UpdatePhase::Downloading
                            | UpdatePhase::Verifying
                            | UpdatePhase::Installing
                            | UpdatePhase::Restarting
                    ) {
                        DesktopUpdateError::busy()
                    } else {
                        DesktopUpdateError::new(
                            "update_not_ready",
                            "Check for an update before installing it.",
                            true,
                        )
                    },
                );
            }
            let update = state.update.clone().ok_or_else(|| {
                DesktopUpdateError::new(
                    "update_not_ready",
                    "Check for an update before installing it.",
                    true,
                )
            })?;
            let release = state.release.clone().ok_or_else(|| {
                DesktopUpdateError::new(
                    "update_not_ready",
                    "The checked update metadata is unavailable.",
                    true,
                )
            })?;
            state.phase = UpdatePhase::Downloading;
            (update, release)
        };

        coordinator.cancel_requested.store(false, Ordering::SeqCst);
        emit_progress(&app, UpdatePhase::Downloading, Some(0), None, None, false);
        let chunk_app = app.clone();
        let verify_app = app.clone();
        let verify_coordinator = &*coordinator;
        let mut downloaded = 0_u64;
        let download = update.download(
            move |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                emit_progress(
                    &chunk_app,
                    UpdatePhase::Downloading,
                    Some(downloaded),
                    total,
                    None,
                    false,
                );
            },
            move || {
                if let Ok(mut state) = verify_coordinator.state.lock() {
                    state.phase = UpdatePhase::Verifying;
                }
                emit_progress(&verify_app, UpdatePhase::Verifying, None, None, None, false);
            },
        );
        let bytes = tokio::select! {
            result = download => match result {
                Ok(bytes) => bytes,
                Err(error) => {
                    let error = map_updater_error(error, UpdateOperation::Download);
                    set_failed(&coordinator, &app, &error, false);
                    return Err(error);
                }
            },
            _ = cancellation_requested(&coordinator) => {
                if let Ok(mut state) = coordinator.state.lock() {
                    state.phase = UpdatePhase::Ready;
                }
                coordinator.cancel_requested.store(false, Ordering::SeqCst);
                emit_progress(&app, UpdatePhase::Ready, None, None, None, false);
                return Err(DesktopUpdateError::new(
                    "update_cancelled",
                    "The desktop update download was cancelled.",
                    true,
                ));
            }
        };

        if let Ok(mut state) = coordinator.state.lock() {
            state.phase = UpdatePhase::Installing;
        }
        emit_progress(&app, UpdatePhase::Installing, None, None, None, false);
        crate::shutdown_owned_runtime(&app);
        if let Err(error) = update.install(bytes) {
            let error = map_updater_error(error, UpdateOperation::Install);
            let _ = failed_install_action();
            set_failed(&coordinator, &app, &error, true);
            let restart_app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(750)).await;
                restart_app.request_restart();
            });
            return Err(error);
        }

        if post_install_action(cfg!(windows)) == PostInstallAction::RestartUpdatedVersion {
            if let Ok(mut state) = coordinator.state.lock() {
                state.phase = UpdatePhase::Restarting;
            }
            emit_progress(&app, UpdatePhase::Restarting, None, None, None, false);
            app.request_restart();
        }
        Ok(DesktopUpdateInstallResult {
            version: release.version,
        })
    }
    #[cfg(not(all(
        desktop,
        not(debug_assertions),
        any(target_os = "macos", target_os = "windows")
    )))]
    unreachable!("availability is false outside packaged macOS and Windows builds")
}

#[tauri::command]
pub fn cancel_desktop_update(
    coordinator: State<'_, DesktopUpdateCoordinator>,
) -> Result<bool, DesktopUpdateError> {
    request_cancellation(&coordinator)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_packaged_supported_desktop_builds_offer_updates() {
        assert!(updater_is_available(true, false, true));
        assert!(!updater_is_available(false, false, true));
        assert!(!updater_is_available(true, true, true));
        assert!(!updater_is_available(true, false, false));
    }

    #[test]
    fn concurrent_update_operations_are_rejected() {
        let coordinator = DesktopUpdateCoordinator::default();
        assert_eq!(begin_check(&coordinator), Ok(()));
        assert_eq!(begin_check(&coordinator), Err(DesktopUpdateError::busy()));
    }

    #[test]
    fn active_work_requires_explicit_confirmation() {
        let active = ActiveWorkSummary {
            active_chats: 1,
            queued_prompts: 2,
            terminal_services: 1,
            background_jobs: 0,
        };
        assert!(active_work_requires_confirmation(&active, false));
        assert!(!active_work_requires_confirmation(&active, true));
        assert!(!active_work_requires_confirmation(
            &ActiveWorkSummary::default(),
            false
        ));
    }

    #[test]
    fn failed_verification_is_non_retryable_without_a_new_release() {
        let error = map_updater_error(
            UpdaterError::SignatureUtf8("not utf8".into()),
            UpdateOperation::Download,
        );
        assert_eq!(error.code, "update_signature_invalid");
        assert!(!error.retryable);
    }

    #[test]
    fn cancellation_is_accepted_only_during_download() {
        let coordinator = DesktopUpdateCoordinator::default();
        assert_eq!(request_cancellation(&coordinator), Ok(false));
        coordinator.state.lock().unwrap().phase = UpdatePhase::Downloading;
        assert_eq!(request_cancellation(&coordinator), Ok(true));
        assert!(coordinator.cancel_requested.load(Ordering::SeqCst));
    }

    #[test]
    fn install_behavior_matches_each_desktop_platform() {
        assert_eq!(
            post_install_action(false),
            PostInstallAction::RestartUpdatedVersion
        );
        assert_eq!(
            post_install_action(true),
            PostInstallAction::InstallerOwnsRelaunch
        );
    }

    #[test]
    fn failed_installation_restarts_the_current_version() {
        assert_eq!(
            failed_install_action(),
            FailedInstallAction::RestartCurrentVersion
        );
    }

    #[test]
    fn downloads_require_https_and_a_signature() {
        let https = url::Url::parse("https://example.com/Cantrip.tar.gz").unwrap();
        let http = url::Url::parse("http://example.com/Cantrip.tar.gz").unwrap();
        assert_eq!(validate_download_fields(&https, "signature"), Ok(()));
        assert_eq!(
            validate_download_fields(&http, "signature")
                .unwrap_err()
                .code,
            "update_insecure_download"
        );
        assert_eq!(
            validate_download_fields(&https, " ").unwrap_err().code,
            "update_signature_invalid"
        );
    }

    #[test]
    fn release_notes_are_bounded_and_strip_control_characters() {
        let notes = sanitize_release_notes(Some("# Notes\0\nSafe\u{7}")).unwrap();
        assert_eq!(notes, "# Notes\nSafe");
        assert_eq!(
            sanitize_release_notes(Some(&"x".repeat(RELEASE_NOTES_LIMIT + 10)))
                .unwrap()
                .len(),
            RELEASE_NOTES_LIMIT
        );
    }
}
