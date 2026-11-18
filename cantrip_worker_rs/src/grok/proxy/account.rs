use super::{Authorize, Credential, Proxy};
use crate::{
    codex::{catalog::account_home, managed::GrokAccount},
    encryption::Service,
    grok::{Commands, Entry, catalog::lease_credential, http::Http},
    provider_access::{Access, Account, RequestError},
};
use anyhow::{Result, anyhow, bail};
use cantrip_wire::{JsString, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Weak},
};

type Binding = (JsString, Value);

pub(in crate::grok) struct AccountProxy {
    account: Account,
    binding: Binding,
    server: Proxy,
}

impl AccountProxy {
    #[cfg(test)]
    pub(in crate::grok) fn url(&self) -> &str {
        &self.server.url
    }

    pub(in crate::grok) async fn close(self) -> Result<()> {
        self.server.close().await
    }
}

impl Commands {
    pub(crate) fn install_proxy(&self, access: Access, encryption: Arc<Service>) -> Result<()> {
        let auth = Arc::downgrade(&self.0);
        self.0.codex.configure_grok(Arc::new(move |profile| {
            let auth = auth.clone();
            let access = access.clone();
            let encryption = encryption.clone();
            Box::pin(async move {
                let auth = Commands(
                    auth.upgrade()
                        .ok_or_else(|| anyhow!("Grok authentication is stopped."))?,
                );
                resolve(&auth, profile, access, encryption).await
            })
        }))
    }
}

async fn resolve(
    auth: &Commands,
    profile: GrokAccount,
    access: Access,
    encryption: Arc<Service>,
) -> Result<String> {
    let binding = encryption.bound_identity()?;
    let home = account_home(&auth.0.data, &profile.credential_home_key);
    let entry = auth.entry(&home)?;
    let mut slot = entry.proxy.lock().await;
    if entry.state.lock().await.closed {
        bail!("Grok authentication is stopped.");
    }
    if let Some(existing) = slot.as_ref()
        && existing.binding == binding
        && existing.server.is_live()
    {
        if existing.account != profile.account {
            bail!("Grok runtime received a different account for this credential home.");
        }
        verify(&encryption, &binding)?;
        return Ok(existing.server.url.clone());
    }
    if let Some(existing) = slot.take() {
        existing.close().await?;
    }

    let http = auth.0.http.clone();
    let portable = portable(
        access,
        encryption.clone(),
        binding.clone(),
        profile.account.clone(),
    );
    let attempt = Proxy::start(http.clone(), portable).await;
    let proxy = match attempt {
        Err(error)
            if error
                .chain()
                .filter_map(|cause| cause.downcast_ref::<RequestError>())
                .any(RequestError::legacy_fallback) =>
        {
            let local = local(
                Arc::downgrade(&entry),
                http.clone(),
                home,
                encryption.clone(),
                binding.clone(),
            );
            Proxy::start(http, local).await?
        }
        other => other?,
    };
    if let Err(error) = verify(&encryption, &binding) {
        proxy.close().await?;
        return Err(error);
    }
    let url = proxy.url.clone();
    *slot = Some(AccountProxy {
        account: profile.account,
        binding,
        server: proxy,
    });
    Ok(url)
}

fn portable(
    access: Access,
    encryption: Arc<Service>,
    binding: Binding,
    account: Account,
) -> Authorize {
    Arc::new(move |force| {
        let (access, encryption, binding, account) = (
            access.clone(),
            encryption.clone(),
            binding.clone(),
            account.clone(),
        );
        Box::pin(async move {
            verify(&encryption, &binding)?;
            let lease = match force {
                Some(revision) => access.force(account.clone(), revision),
                None => access.get(account.clone()),
            }
            .await?;
            verify(&encryption, &binding)?;
            Ok(Credential {
                value: lease_credential(&account, &lease)?,
                revision: lease.revision(),
            })
        })
    })
}

fn local(
    entry: Weak<Entry>,
    http: Http,
    home: PathBuf,
    encryption: Arc<Service>,
    binding: Binding,
) -> Authorize {
    Arc::new(move |force| {
        let (entry, http, home, encryption, binding) = (
            entry.clone(),
            http.clone(),
            home.clone(),
            encryption.clone(),
            binding.clone(),
        );
        Box::pin(async move {
            verify(&encryption, &binding)?;
            let entry = entry
                .upgrade()
                .ok_or_else(|| anyhow!("Grok authentication is stopped."))?;
            let mut state = entry.state.lock().await;
            if state.closed {
                bail!("Grok authentication is stopped.");
            }
            let value = state
                .credential
                .valid(&http, &home, force.is_some())
                .await?;
            verify(&encryption, &binding)?;
            Ok(Credential { value, revision: 0 })
        })
    })
}

fn verify(encryption: &Service, binding: &Binding) -> Result<()> {
    if encryption.bound_identity()? != *binding {
        bail!("The Grok proxy account binding changed.");
    }
    Ok(())
}
