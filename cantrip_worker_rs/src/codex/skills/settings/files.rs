use super::{Root, Skill, compare, item, library, sorting};
use crate::filesystem::paths;
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use cantrip_wire::{JsString, Value, text::trim, value::json};
use regress::Regex;
use std::{
    collections::VecDeque,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::LazyLock,
};

const MAX_FILES: usize = 500;

pub(super) fn select<'a>(
    roots: &'a [Root],
    id: &Value,
    editable: bool,
) -> Result<(&'a Root, Skill)> {
    let id = id.as_str().context("The requested skill id is invalid.")?;
    let (location, encoded) = id
        .split_once(':')
        .filter(|(location, _)| !location.is_empty())
        .context("The requested skill id is invalid.")?;
    ensure!(
        ["project", "account", "user", "codexUser", "system", "admin"].contains(&location),
        "The requested skill location is invalid."
    );
    let relative = URL_SAFE_NO_PAD
        .decode(encoded)
        .context("The requested skill path is invalid.")?;
    let relative = String::from_utf8_lossy(&relative);
    ensure!(
        !Path::new(relative.as_ref()).is_absolute()
            && relative
                .split(['\\', '/'])
                .all(|part| !matches!(part, "" | "." | "..")),
        "The requested skill path is invalid."
    );
    let root = roots
        .iter()
        .find(|root| root.location.name() == location)
        .context("The requested skill is unavailable in this context.")?;
    let skill = root
        .scan()?
        .into_iter()
        .find(|skill| root.skill_id(skill) == id)
        .context("The requested skill was not found.")?;
    ensure!(
        !editable || skill.editable,
        "Bundled and administrator-managed skills are read-only."
    );
    Ok((root, skill))
}

pub(super) fn file_path(directory: &Path, name: &Value) -> Result<PathBuf> {
    let name = name
        .as_js_string()
        .context("The requested skill file path is invalid.")?;
    let relative = paths::native(name);
    ensure!(
        !name.is_empty()
            && !relative.has_root()
            && !matches!(
                relative.components().next(),
                Some(std::path::Component::Prefix(_))
            ),
        "The requested skill file path is invalid."
    );
    let target = paths::canonical_sync(&directory.join(relative))?;
    ensure!(
        paths::within(directory, &target),
        "The requested file is outside the selected skill."
    );
    Ok(target)
}

pub(super) fn read(roots: Vec<Root>, request: &Value) -> Result<Value> {
    let (root, skill) = select(&roots, &request["skillId"], false)?;
    let files = list_files(&skill.canonical)?;
    let requested = &request["file"];
    let file = files
        .iter()
        .find(|file| file["path"] == *requested)
        .context("The requested skill file was not found.")?;
    let target = file_path(&skill.canonical, requested)?;
    let content = read_text(&target)?;
    ensure!(
        !content.contains('\0'),
        "Binary skill files cannot be displayed in the editor."
    );
    Ok(json!({"skill":item(root, &skill, true)?,"file":file,"files":files,"content":content}))
}

fn list_files(root: &Path) -> Result<Vec<Value>> {
    let mut pending = VecDeque::from([root.to_owned()]);
    let mut files = Vec::new();
    while let Some(directory) = pending.pop_front() {
        for entry in fs::read_dir(directory)? {
            let path = entry?.path();
            let metadata = path.symlink_metadata()?;
            if library::is_link(&metadata) {
                continue;
            }
            if metadata.is_dir() {
                pending.push_back(path);
            } else if metadata.is_file() {
                let canonical = paths::canonical_sync(&path)?;
                if paths::within(root, &canonical) {
                    files.push(json!({"path":library::relative_text(path.strip_prefix(root)?),"sizeBytes":metadata.len()}));
                    if files.len() == MAX_FILES {
                        break;
                    }
                }
            }
        }
        if files.len() == MAX_FILES {
            break;
        }
    }
    let collator = sorting()?;
    files.sort_by(|left, right| {
        (right["path"] == "SKILL.md")
            .cmp(&(left["path"] == "SKILL.md"))
            .then_with(|| compare(&collator, left, right, "path"))
    });
    Ok(files)
}

pub(super) fn open_regular(path: &Path) -> Result<(fs::File, fs::Metadata)> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && !library::is_link(&metadata),
        "The requested skill file was not found."
    );
    Ok((file, metadata))
}

pub(super) fn read_text(path: &Path) -> Result<String> {
    let (file, metadata) = open_regular(path)?;
    ensure!(
        metadata.len() <= library::MAX_SKILL_BYTES,
        "The requested skill file is too large to browse."
    );
    let mut content = Vec::new();
    file.take(library::MAX_SKILL_BYTES + 1)
        .read_to_end(&mut content)?;
    ensure!(
        content.len() as u64 <= library::MAX_SKILL_BYTES,
        "The requested skill file is too large to browse."
    );
    Ok(String::from_utf8_lossy(&content).into_owned())
}

fn strip_yaml_string(value: &str) -> Option<String> {
    let value = trim(value);
    let normalized = if value.len() >= 2
        && matches!(
            (value.as_bytes()[0], value.as_bytes()[value.len() - 1]),
            (b'\'', b'\'') | (b'"', b'"')
        ) {
        trim(&value[1..value.len() - 1])
    } else {
        value
    };
    (!normalized.is_empty()).then(|| normalized.to_owned())
}

pub(super) fn frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let normalized = content
        .strip_prefix('\u{feff}')
        .unwrap_or(content)
        .replace("\r\n", "\n");
    let Some((frontmatter, _)) = normalized
        .strip_prefix("---\n")
        .and_then(|text| text.split_once("\n---\n"))
    else {
        return (None, None);
    };
    let (mut name, mut description) = (None, None);
    for (key, value) in frontmatter.lines().filter_map(|line| line.split_once(':')) {
        if key.eq_ignore_ascii_case("name") {
            name = strip_yaml_string(value);
        } else if key.eq_ignore_ascii_case("description") {
            description = strip_yaml_string(value);
        }
    }
    (name, description)
}

pub(super) fn display_name(root: &Path) -> Option<String> {
    static DISPLAY: LazyLock<Regex> =
        LazyLock::new(|| Regex::with_flags(r"^\s*display_name:\s*(.*?)\s*$", "mu").unwrap());
    let path = paths::canonical_sync(&root.join("agents/openai.yaml")).ok()?;
    if !paths::within(root, &path) {
        return None;
    }
    let content = JsString::from(read_text(&path).ok()?.as_str());
    let range = DISPLAY
        .find_from_utf16(content.units(), 0)
        .next()?
        .group(1)?;
    let value = JsString::new(content.units()[range].to_vec());
    strip_yaml_string(&value.lossy())
}
