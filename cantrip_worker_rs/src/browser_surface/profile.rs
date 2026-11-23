use anyhow::Result;
use cantrip_browser::{Browser, Launch, Page};
use cantrip_wire::JsString;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

pub(super) struct Profiles {
    directory: PathBuf,
    candidates: Vec<PathBuf>,
    profiles: Mutex<HashMap<PathBuf, Weak<Profile>>>,
}

#[derive(Default)]
struct Profile {
    inner: tokio::sync::Mutex<Option<LiveBrowser>>,
}

struct LiveBrowser {
    browser: Browser,
    generation: Arc<()>,
}

pub(super) struct Lease {
    profile: Arc<Profile>,
    generation: Arc<()>,
    pub identity: JsString,
    pub page: Page,
}

impl Profiles {
    pub fn new(directory: &Path, environment: &cantrip_config::Environment) -> Self {
        Self {
            directory: directory.join("browser").join("profiles"),
            candidates: candidates(environment),
            profiles: Mutex::default(),
        }
    }

    pub async fn open(&self, identity: &JsString, viewport: (u32, u32)) -> Result<Lease> {
        let digest: String = Sha256::digest(identity.lossy().as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let profile_path = self.directory.join(digest);
        let profile = {
            let mut profiles = self.profiles.lock().unwrap();
            profiles.retain(|_, profile| profile.strong_count() != 0);
            if let Some(profile) = profiles.get(&profile_path).and_then(Weak::upgrade) {
                profile
            } else {
                let profile = Arc::new(Profile::default());
                profiles.insert(profile_path.clone(), Arc::downgrade(&profile));
                profile
            }
        };
        let mut live = profile.inner.lock().await;
        if live
            .as_ref()
            .is_some_and(|live| !live.browser.is_connected())
            && let Some(disconnected) = live.take()
        {
            let _ = disconnected.browser.close().await;
        }
        if live.is_none() {
            *live = Some(LiveBrowser {
                browser: self.launch(&profile_path, viewport).await?,
                generation: Arc::new(()),
            });
        }
        let current = live.as_ref().unwrap();
        let page = match current.browser.new_page(None).await {
            Ok(page) => page,
            Err(error) => {
                if (!current.browser.is_connected() || Arc::strong_count(&current.generation) == 1)
                    && let Some(failed) = live.take()
                {
                    let _ = failed.browser.close().await;
                }
                return Err(error);
            }
        };
        let generation = current.generation.clone();
        drop(live);
        Ok(Lease {
            profile,
            generation,
            identity: identity.clone(),
            page,
        })
    }

    async fn launch(&self, profile: &Path, viewport: (u32, u32)) -> Result<Browser> {
        let mut missing = None;
        for executable in &self.candidates {
            match Browser::launch(Launch {
                executable,
                profile,
                viewport,
                environment: None,
            })
            .await
            {
                Ok(browser) => return Ok(browser),
                Err(error)
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
                {
                    missing = Some(error);
                }
                Err(error) => return Err(error),
            }
        }
        Err(missing
            .unwrap_or_else(|| anyhow::anyhow!("No platform Chromium executable is configured."))
            .context("A Chromium executable is unavailable on this worker."))
    }
}

impl Lease {
    pub async fn close(self) {
        let mut live = self.profile.inner.lock().await;
        let Some(current) = live
            .as_ref()
            .filter(|current| Arc::ptr_eq(&current.generation, &self.generation))
        else {
            return;
        };
        drop(self.generation);
        let _ = tokio::time::timeout(Duration::from_secs(2), self.page.close()).await;
        if Arc::strong_count(&current.generation) == 1
            && let Some(last) = live.take()
        {
            let _ = last.browser.close().await;
        }
    }
}

pub(super) fn discover(environment: &cantrip_config::Environment) -> bool {
    // The catalog advertises discovered browser installations. Creation still
    // attempts the actual launch and reports its outcome.
    candidates(environment).iter().any(|path| {
        path.metadata().is_ok_and(|metadata| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
            }
            #[cfg(windows)]
            metadata.is_file()
        })
    })
}

fn candidates(environment: &cantrip_config::Environment) -> Vec<PathBuf> {
    if let Some(executable) = environment.get("CANTRIP_CHROMIUM_EXECUTABLE") {
        return vec![PathBuf::from(executable)];
    }
    let mut candidates = Vec::new();
    if cfg!(target_os = "macos") {
        let chrome = "Google Chrome.app/Contents/MacOS/Google Chrome";
        let brave = "Brave Browser.app/Contents/MacOS/Brave Browser";
        candidates.extend(
            [
                chrome,
                "Chromium.app/Contents/MacOS/Chromium",
                brave,
                "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                "Vivaldi.app/Contents/MacOS/Vivaldi",
            ]
            .iter()
            .map(|path| Path::new("/Applications").join(path)),
        );
        if let Some(home) = environment.get("HOME") {
            candidates.extend(
                [chrome, brave].map(|path| Path::new(home).join("Applications").join(path)),
            );
        }
    } else if cfg!(windows) {
        for root in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"]
            .iter()
            .filter_map(|key| environment.get(*key))
        {
            candidates.extend(
                [
                    "Google/Chrome/Application/chrome.exe",
                    "Chromium/Application/chrome.exe",
                    "BraveSoftware/Brave-Browser/Application/brave.exe",
                    "Microsoft/Edge/Application/msedge.exe",
                ]
                .iter()
                .map(|path| Path::new(root).join(path)),
            );
        }
    } else {
        candidates.extend(
            [
                "google-chrome",
                "google-chrome-stable",
                "chromium",
                "chromium-browser",
                "brave-browser",
                "microsoft-edge",
            ]
            .map(|path| Path::new("/usr/bin").join(path)),
        );
    }
    candidates
}
