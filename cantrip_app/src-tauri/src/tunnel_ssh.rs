//! Public SSH host pins scoped to the lifetime of one managed local forward.
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Write, path::Path};
use tempfile::NamedTempFile;

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshHost {
    pub user: String,
    pub host_alias: String,
    pub host_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigureRequest {
    pub tunnel_id: String,
    pub attachment_id: String,
    pub native_forward_generation: String,
    pub ssh: SshHost,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub user: String,
    pub host_alias: String,
    pub host_key: String,
    pub fingerprint: String,
    pub known_hosts_path: String,
}

impl Connection {
    pub fn matches(&self, host: &SshHost) -> bool {
        self.user == host.user
            && self.host_alias == host.host_alias
            && self.host_key == host.host_key
    }
}

pub fn create(directory: &Path, host: SshHost) -> Result<(NamedTempFile, Connection), String> {
    let alias = host.host_alias.strip_prefix("cantrip-os-").and_then(|s| {
        uuid::Uuid::parse_str(s)
            .ok()
            .filter(|id| id.to_string() == s)
    });
    let user = host.user.as_bytes();
    if alias.is_none()
        || user.is_empty()
        || user.len() > 64
        || !(user[0].is_ascii_lowercase() || user[0] == b'_')
        || !user
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(b))
    {
        return Err("Invalid captured SSH account or host alias.".into());
    }
    let blob = host
        .host_key
        .strip_prefix("ssh-ed25519 ")
        .and_then(|s| STANDARD.decode(s).ok())
        .filter(|blob| blob.len() == 51 && blob[..19] == *b"\0\0\0\x0bssh-ed25519\0\0\0\x20")
        .ok_or("Invalid captured Ed25519 SSH host key.")?;
    if host.host_key != format!("ssh-ed25519 {}", STANDARD.encode(&blob)) {
        return Err("The SSH host key must use canonical public-key encoding.".into());
    }
    std::fs::create_dir_all(directory)
        .map_err(|e| format!("Could not create SSH pin directory: {e}"))?;
    // Exclusive creation and a retained handle prevent one route overwriting
    // another. This contains public host material, never a client private key.
    let mut file = tempfile::Builder::new()
        .prefix("known-host-")
        .tempfile_in(directory)
        .map_err(|e| format!("Could not create the SSH host pin: {e}"))?;
    writeln!(file, "{} {}", host.host_alias, host.host_key)
        .map_err(|e| format!("Could not write the SSH host pin: {e}"))?;
    file.flush()
        .map_err(|e| format!("Could not flush the SSH host pin: {e}"))?;
    let connection = Connection {
        user: host.user,
        host_alias: host.host_alias,
        host_key: host.host_key,
        fingerprint: format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(&blob))),
        known_hosts_path: file.path().to_string_lossy().into_owned(),
    };
    Ok((file, connection))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn host() -> SshHost {
        let mut blob = b"\0\0\0\x0bssh-ed25519\0\0\0\x20".to_vec();
        blob.extend([7u8; 32]);
        SshHost {
            user: "ctw-work".into(),
            host_alias: format!("cantrip-os-{}", uuid::Uuid::new_v4()),
            host_key: format!("ssh-ed25519 {}", STANDARD.encode(blob)),
        }
    }
    #[test]
    fn exact_host_pins_are_independent_and_retire_with_their_handle() {
        let root = tempfile::tempdir().unwrap();
        let host = host();
        let (first, info) = create(root.path(), host.clone()).unwrap();
        let (second, _) = create(root.path(), host.clone()).unwrap();
        assert_ne!(first.path(), second.path());
        assert_eq!(
            std::fs::read_to_string(first.path()).unwrap(),
            format!("{} {}\n", host.host_alias, host.host_key)
        );
        assert!(info.matches(&host));
        assert!(info.fingerprint.starts_with("SHA256:"));
        let path = first.path().to_owned();
        drop(first);
        assert!(!path.exists());
        assert!(second.path().exists());
    }
    #[test]
    fn pin_files_reject_ssh_options_and_line_injection() {
        let root = tempfile::tempdir().unwrap();
        for field in ["user", "alias", "key"] {
            let mut host = host();
            match field {
                "user" => host.user = "-oProxyCommand=bad".into(),
                "alias" => host.host_alias.push_str("\nother"),
                _ => host.host_key.push_str("\nother"),
            }
            assert!(create(root.path(), host).is_err());
        }
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
}
