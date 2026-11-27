use super::*;
use crate::codex::{discovery, process_transport, provider_errors::Policy};
use crate::provider_access::Account;

#[derive(Clone)]
pub struct GrokAccount {
    pub account: Account,
    pub credential_home_key: JsString,
    pub provider_name: JsString,
}

/// Provider resolution, account leases and native host placement belong to the
/// command owner. This is the resulting local app-server launch profile.
pub struct Profile {
    pub id: JsString,
    pub codex_home: PathBuf,
    pub account_scope: Option<(JsString, JsString)>,
    pub configuration_home: Option<PathBuf>,
    pub model: Option<JsString>,
    pub model_catalog: Option<PathBuf>,
    pub(in crate::codex) managed_catalog: Option<model_catalog::Seed>,
    pub provider_arguments: Vec<String>,
    pub provider_environment: HashMap<String, String>,
    pub external_login: Option<Value>,
    pub extra_skill_roots: Vec<PathBuf>,
    pub isolate_user_skills: bool,
    pub native_host: bool,
    pub diagnostic_policy: Policy,
    pub grok: Option<GrokAccount>,
    pub(in crate::codex) claude: Option<Account>,
    pub(super) claude_gateway: Option<crate::claude_code::gateway::Gateway>,
}

impl Profile {
    pub fn new(id: JsString, codex_home: PathBuf) -> Self {
        Self {
            id,
            codex_home,
            account_scope: None,
            configuration_home: None,
            model: None,
            model_catalog: None,
            managed_catalog: None,
            provider_arguments: Vec::new(),
            provider_environment: HashMap::new(),
            external_login: None,
            extra_skill_roots: Vec::new(),
            isolate_user_skills: false,
            native_host: false,
            diagnostic_policy: Policy::default(),
            grok: None,
            claude: None,
            claude_gateway: None,
        }
    }

    pub(super) fn configure_loopback(&mut self, name: &JsString, local: &str) {
        self.provider_arguments.extend([
            "web_search=\"disabled\"".into(),
            "features.fast_mode=false".into(),
            "agents.enabled=true".into(),
            "features.multi_agent=true".into(),
            "model_provider=\"cantrip_runtime\"".into(),
            format!(
                "model_providers.cantrip_runtime.name={}",
                json!(name).stringify()
            ),
            format!(
                "model_providers.cantrip_runtime.base_url={}",
                json!(local).stringify()
            ),
            "model_providers.cantrip_runtime.wire_api=\"responses\"".into(),
        ]);
        self.diagnostic_policy.secrets.push(local.into());
        if let Some(capability) = local.split('/').nth(3) {
            self.diagnostic_policy.secrets.push(capability.into());
        }
    }
}

#[derive(Clone)]
pub struct Host {
    pub binary: PathBuf,
    pub cwd: PathBuf,
    pub environment: HashMap<String, String>,
    pub compatibility: Value,
    pub logs: Option<Arc<Logs>>,
}

impl Host {
    pub(super) fn process(
        &self,
        profile: &Profile,
        inference_environment: HashMap<String, String>,
    ) -> Result<(Vec<String>, process_transport::Options)> {
        let mut options =
            process_transport::Options::local(self.cwd.clone(), self.environment.clone());
        options.logs = self.logs.clone();
        options.runtime_id = Some(profile.id.lossy().into_owned());
        options.policy = profile.diagnostic_policy.clone();
        if let Some(secret) = profile
            .external_login
            .as_ref()
            .and_then(|input| input["accessToken"].as_js_string())
        {
            options.policy.secrets.push(secret.clone());
        }
        set_env(
            &mut options.environment,
            "CODEX_HOME",
            Some(path_text(&self.cwd, &profile.codex_home)?),
        );
        set_env(
            &mut options.environment,
            "CANTRIP_CODEX_USER_CONFIG_FILE",
            profile
                .configuration_home
                .as_ref()
                .map(|home| path_text(&self.cwd, &home.join("config.toml")))
                .transpose()?,
        );
        set_env(
            &mut options.environment,
            "CANTRIP_CODEX_ISOLATE_USER_SKILLS",
            profile.isolate_user_skills.then(|| "1".into()),
        );
        for (key, value) in &profile.provider_environment {
            set_env(&mut options.environment, key, Some(value.clone()));
        }
        // Never inherit authority for a previous process from the caller's
        // environment, spelling included on Windows.
        for key in [
            "CANTRIP_INFERENCE_SCOPE",
            "CANTRIP_INFERENCE_GENERATION",
            "CANTRIP_INFERENCE_RUNTIME",
        ] {
            set_env(&mut options.environment, key, None);
        }
        for (key, value) in inference_environment {
            set_env(&mut options.environment, &key, Some(value));
        }

        let mut arguments = vec!["app-server".into()];
        let mut config = |setting: String| {
            arguments.extend(["-c".into(), setting]);
        };
        config("cli_auth_credentials_store=\"file\"".into());
        if profile.native_host {
            for feature in [
                "computer_use",
                "browser_use",
                "browser_use_external",
                "in_app_browser",
            ] {
                config(format!("features.{feature}=false"));
            }
        }
        if self.feature_method("thread/goal/get") {
            config("features.goals=true".into());
        }
        for value in &profile.provider_arguments {
            config(value.clone());
        }
        if let Some(path) = &profile.model_catalog {
            config(format!(
                "model_catalog_json={}",
                json!(path_text(&self.cwd, path)?).stringify()
            ));
        }
        if let Some(model) = &profile.model {
            config(format!("model={}", json!(model).stringify()));
        }
        arguments.extend(["--listen".into(), "ws://127.0.0.1:0".into()]);
        Ok((arguments, options))
    }

    pub(super) async fn initialize(&self, session: &Session, profile: &Profile) -> Result<()> {
        let experimental = profile.external_login.is_some()
            || self.compatibility["initialize"]["experimentalApi"] == true;
        session
            .initialize("cantrip", "Cantrip", "0.0.0", experimental)
            .await?;
        if !profile.extra_skill_roots.is_empty() && self.feature_method("skills/extraRoots/set") {
            let roots = profile
                .extra_skill_roots
                .iter()
                .map(|path| path_text(&self.cwd, path))
                .collect::<Result<Vec<_>>>()?;
            session
                .request(
                    "skills/extraRoots/set".into(),
                    Some(json!({"extraRoots": roots})),
                    Some(RPC_TIMEOUT),
                    None,
                )
                .await?;
        }
        if let Some(login) = &profile.external_login {
            let receipt = session
                .request(
                    "account/login/start".into(),
                    Some(login.clone()),
                    Some(RPC_TIMEOUT),
                    None,
                )
                .await?;
            if !receipt.is_some_and(|value| value["type"] == "chatgptAuthTokens") {
                bail!("Codex rejected portable ChatGPT authentication.");
            }
        }
        Ok(())
    }

    fn feature_method(&self, method: &str) -> bool {
        discovery::methods_available(&self.compatibility, &[json!(method)])
    }
}

fn set_env(environment: &mut HashMap<String, String>, key: &str, value: Option<String>) {
    if cfg!(windows) {
        environment.retain(|name, _| !name.eq_ignore_ascii_case(key));
    } else {
        environment.remove(key);
    }
    if let Some(value) = value {
        environment.insert(key.into(), value);
    }
}

fn path_text(cwd: &Path, path: &Path) -> Result<String> {
    cantrip_config::resolve(cwd, path)
        .into_os_string()
        .into_string()
        .map_err(|_| {
            anyhow!(
                "The Codex launch profile contains a path that cannot be represented as Unicode."
            )
        })
}
