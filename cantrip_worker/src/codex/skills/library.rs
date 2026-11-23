//! Skill discovery and legacy IDs shared by settings and Standalone Chat.
use crate::{codex::catalog::account_home, filesystem::paths};
use anyhow::Result;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use cantrip_wire::JsString;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashSet, VecDeque},
    fs, io,
    path::{Path, PathBuf},
};

const MAX_DIRECTORIES: usize = 2_000;
const MAX_SKILLS: usize = 1_000;
const MAX_DEPTH: usize = 6;
pub(super) const MAX_SKILL_BYTES: u64 = 1_000_000;

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum Location {
    Project,
    Account,
    User,
    CodexUser,
    System,
    Admin,
}

impl Location {
    pub fn name(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Account => "account",
            Self::User => "user",
            Self::CodexUser => "codexUser",
            Self::System => "system",
            Self::Admin => "admin",
        }
    }

    pub fn scope(self) -> &'static str {
        match self {
            Self::Project => "repo",
            Self::System => "system",
            Self::Admin => "admin",
            _ => "user",
        }
    }

    pub fn chat(self) -> bool {
        matches!(self, Self::Account | Self::User | Self::CodexUser)
    }

    fn skips_bundled(self) -> bool {
        matches!(self, Self::Account | Self::CodexUser)
    }

    fn editable(self) -> bool {
        !matches!(self, Self::System | Self::Admin)
    }
}

pub(super) struct Root {
    pub path: PathBuf,
    pub location: Location,
}

pub(super) fn roots(
    data: &Path,
    global: Option<&Path>,
    provider_id: &JsString,
    provider_kind: &str,
) -> Vec<Root> {
    let home = if matches!(provider_kind, "chatgpt" | "grok") {
        account_home(data, provider_id)
    } else {
        data.join("codex-home")
    };
    let skills = home.join("skills");
    [
        (Location::Account, Some(skills.clone())),
        (
            Location::User,
            std::env::home_dir().map(|home| home.join(".agents/skills")),
        ),
        (Location::CodexUser, global.map(Path::to_owned)),
        (Location::System, Some(skills.join(".system"))),
        (Location::Admin, Some(PathBuf::from("/etc/codex/skills"))),
    ]
    .into_iter()
    .filter_map(|(location, path)| {
        Some(Root {
            location,
            path: path?,
        })
    })
    .collect()
}

pub(super) struct Skill {
    pub directory: PathBuf,
    pub canonical: PathBuf,
    pub editable: bool,
    pub relative: String,
}

pub(super) fn relative_text(relative: &Path) -> String {
    relative
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

pub(super) fn optional_canonical(path: &Path) -> io::Result<Option<PathBuf>> {
    match paths::canonical_sync(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub(super) fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    metadata.is_symlink()
}

impl Root {
    pub fn skill_id(&self, skill: &Skill) -> String {
        format!(
            "{}:{}",
            self.location.name(),
            URL_SAFE_NO_PAD.encode(&skill.relative)
        )
    }

    pub fn audience_key(&self, skill: &Skill) -> Result<String> {
        let root = paths::text(&paths::resolve(&self.path)?);
        Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(format!(
            "cantrip-skill-audience:v1\0{}\0{}\0{}",
            self.location.name(),
            root.lossy(),
            skill.relative,
        ))))
    }

    pub fn scan(&self) -> Result<Vec<Skill>> {
        let Some(root) = optional_canonical(&self.path)? else {
            return Ok(Vec::new());
        };
        let mut pending = VecDeque::from([(self.path.clone(), 0)]);
        let mut visited = HashSet::new();
        let mut skills = Vec::new();
        while let Some((directory, depth)) = pending.pop_front() {
            if visited.len() >= MAX_DIRECTORIES || skills.len() >= MAX_SKILLS {
                break;
            }
            let Some(canonical) = optional_canonical(&directory)? else {
                continue;
            };
            if !visited.insert(canonical.clone()) || !fs::metadata(&canonical)?.is_dir() {
                continue;
            }
            let mut document = None;
            let mut children = Vec::new();
            for entry in fs::read_dir(&directory)? {
                let entry = entry?;
                let name = entry.file_name();
                let kind = entry.file_type()?;
                if name == "SKILL.md"
                    && kind.is_file()
                    && !is_link(&entry.path().symlink_metadata()?)
                {
                    document = Some(entry.path());
                    break;
                }
                if depth < MAX_DEPTH
                    && (kind.is_dir() || kind.is_symlink())
                    && !(depth == 0 && self.location.skips_bundled() && name == ".system")
                {
                    children.push((entry.path(), depth + 1));
                }
            }
            if let Some(document) = document {
                if depth != 0 && fs::metadata(document)?.len() <= MAX_SKILL_BYTES {
                    let relative = relative_text(directory.strip_prefix(&self.path)?);
                    let editable = self.location.editable()
                        && paths::within(&root, &canonical)
                        && !is_link(&directory.symlink_metadata()?);
                    skills.push(Skill {
                        directory,
                        canonical,
                        editable,
                        relative,
                    });
                }
                continue;
            }
            pending.extend(children);
        }
        Ok(skills)
    }
}
