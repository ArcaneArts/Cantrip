use super::*;
/// Display is lexical, never an authorization or filesystem lookup.
pub(super) fn display(cwd: &Value, path: &Value) -> Result<Value> {
    let cwd = text(cwd)?;
    let path = text(path)?;
    #[cfg(not(windows))]
    {
        if path.units().first() != Some(&47) {
            return Ok(s(path.clone()));
        }
        fn resolve(value: &JsString) -> Vec<Vec<u16>> {
            let mut parts = Vec::new();
            for part in value.units().split(|&u| u == 47) {
                if part.is_empty() || part == [46] {
                    continue;
                }
                if part == [46, 46] {
                    parts.pop();
                } else {
                    parts.push(part.to_vec());
                }
            }
            parts
        }
        let cwd = if cwd.units().first() == Some(&47) {
            cwd.clone()
        } else {
            concat(&[
                crate::filesystem::paths::text(&std::env::current_dir()?),
                "/".into(),
                cwd.clone(),
            ])
        };
        let root = resolve(&cwd);
        let file = resolve(path);
        if root == file {
            return Ok(s("."));
        }
        if file.starts_with(&root) {
            let relative = join(
                file[root.len()..].iter().map(|p| JsString::new(p.clone())),
                "/",
            );
            if !relative.units().starts_with(&[46, 46]) {
                return Ok(s(relative));
            }
        }
        Ok(s(path.clone()))
    }
    #[cfg(windows)]
    {
        use crate::filesystem::paths;
        let file = paths::native(path);
        if !paths::absolute(&file) {
            return Ok(s(path.clone()));
        }
        let cwd = paths::resolve(&paths::native(cwd))?;
        let file = paths::resolve(&file)?;
        let root = paths::text(&cwd);
        let target = paths::text(&file);
        if root == target {
            return Ok(s("."));
        }
        let root: Vec<_> = cwd.components().collect();
        let target: Vec<_> = file.components().collect();
        if target.len() > root.len()
            && root.iter().zip(&target).all(|(a, b)| {
                paths::text(std::path::Path::new(a.as_os_str())).lowercase()
                    == paths::text(std::path::Path::new(b.as_os_str())).lowercase()
            })
        {
            let relative = target[root.len()..]
                .iter()
                .map(|c| c.as_os_str())
                .collect::<std::path::PathBuf>();
            let relative = paths::text(&relative);
            if !relative.units().starts_with(&[46, 46]) {
                return Ok(s(relative));
            }
        }
        Ok(s(path.clone()))
    }
}
