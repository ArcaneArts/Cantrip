//! DAV operations under the selected project or scratch directory.
use super::rooted;
use cap_std::{ambient_authority, fs::Dir};
use dav_server::{
    davpath::DavPath,
    fs::{
        DavDirEntry, DavFile, DavFileSystem, DavMetaData, DavProp, FsError, FsFuture, FsResult,
        FsStream, OpenOptions, ReadDirMeta,
    },
};
use futures::FutureExt;
use hyper::StatusCode;
use std::{
    collections::{BTreeMap, HashMap},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::SystemTime,
};

type Properties = BTreeMap<(Option<String>, String), DavProp>;

#[derive(Clone)]
pub(super) struct ShareFs {
    root: Arc<Dir>,
    properties: Arc<Mutex<HashMap<PathBuf, Properties>>>,
}

impl ShareFs {
    pub fn new(root: &Path) -> std::io::Result<Self> {
        Ok(Self {
            root: Arc::new(Dir::open_ambient_dir(root, ambient_authority())?),
            properties: Arc::default(),
        })
    }

    fn path(path: &DavPath) -> FsResult<PathBuf> {
        let raw = path.as_bytes();
        if cfg!(windows)
            && (std::str::from_utf8(raw).is_err() || raw.contains(&b'\\') || raw.contains(&b':'))
        {
            return Err(FsError::Forbidden);
        }
        let relative = path.as_rel_ospath();
        if relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(FsError::Forbidden);
        }
        Ok(if relative.as_os_str().is_empty() {
            PathBuf::from(".")
        } else {
            relative.to_owned()
        })
    }
}

impl DavFileSystem for ShareFs {
    fn open<'a>(
        &'a self,
        path: &'a DavPath,
        options: OpenOptions,
    ) -> FsFuture<'a, Box<dyn DavFile>> {
        async move { rooted::open(self.root.clone(), Self::path(path)?, options).await }.boxed()
    }

    fn read_dir<'a>(
        &'a self,
        path: &'a DavPath,
        meta: ReadDirMeta,
    ) -> FsFuture<'a, FsStream<Box<dyn DavDirEntry>>> {
        async move { rooted::entries(self.root.clone(), Self::path(path)?, meta).await }.boxed()
    }

    fn metadata<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, Box<dyn DavMetaData>> {
        async move { rooted::metadata(self.root.clone(), Self::path(path)?, true).await }.boxed()
    }

    fn symlink_metadata<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, Box<dyn DavMetaData>> {
        async move { rooted::metadata(self.root.clone(), Self::path(path)?, false).await }.boxed()
    }

    fn create_dir<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        async move {
            let path = Self::path(path)?;
            rooted::perform(self.root.clone(), move |root| root.create_dir(path)).await
        }
        .boxed()
    }

    fn remove_dir<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        async move {
            let path_key = Self::path(path)?;
            let remove = path_key.clone();
            rooted::perform(self.root.clone(), move |root| root.remove_dir(remove)).await?;
            self.properties
                .lock()
                .unwrap()
                .retain(|entry, _| !entry.starts_with(&path_key));
            Ok(())
        }
        .boxed()
    }

    fn remove_file<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        async move {
            let path_key = Self::path(path)?;
            let remove = path_key.clone();
            rooted::perform(self.root.clone(), move |root| root.remove_file(remove)).await?;
            self.properties.lock().unwrap().remove(&path_key);
            Ok(())
        }
        .boxed()
    }

    fn rename<'a>(&'a self, from: &'a DavPath, to: &'a DavPath) -> FsFuture<'a, ()> {
        async move {
            let source = Self::path(from)?;
            let target = Self::path(to)?;
            let (from, to) = (source.clone(), target.clone());
            rooted::perform(self.root.clone(), move |root| root.rename(from, root, to)).await?;
            let mut properties = self.properties.lock().unwrap();
            let moved: Vec<_> = properties
                .keys()
                .filter(|entry| entry.starts_with(&source))
                .cloned()
                .collect();
            properties.retain(|entry, _| !entry.starts_with(&target));
            for entry in moved {
                if let Some(value) = properties.remove(&entry) {
                    let relative = entry
                        .strip_prefix(&source)
                        .expect("selected moved property");
                    properties.insert(target.join(relative), value);
                }
            }
            Ok(())
        }
        .boxed()
    }

    fn copy<'a>(&'a self, from: &'a DavPath, to: &'a DavPath) -> FsFuture<'a, ()> {
        async move {
            let source = Self::path(from)?;
            let target = Self::path(to)?;
            let (from, to) = (source.clone(), target.clone());
            rooted::perform(self.root.clone(), move |root| root.copy(from, root, to)).await?;
            let mut properties = self.properties.lock().unwrap();
            if let Some(value) = properties.get(&source).cloned() {
                properties.insert(target, value);
            } else {
                properties.remove(&target);
            }
            Ok(())
        }
        .boxed()
    }

    fn set_modified<'a>(&'a self, path: &'a DavPath, time: SystemTime) -> FsFuture<'a, ()> {
        async move {
            let path = Self::path(path)?;
            rooted::perform(self.root.clone(), move |root| {
                rooted::set_modified(root, &path, time)
            })
            .await
        }
        .boxed()
    }

    fn have_props<'a>(&'a self, _path: &'a DavPath) -> futures::future::BoxFuture<'a, bool> {
        futures::future::ready(true).boxed()
    }

    fn patch_props<'a>(
        &'a self,
        path: &'a DavPath,
        patch: Vec<(bool, DavProp)>,
    ) -> FsFuture<'a, Vec<(StatusCode, DavProp)>> {
        async move {
            let path = Self::path(path)?;
            let result = patch
                .iter()
                .map(|(_, property)| (StatusCode::OK, property.clone()))
                .collect();
            let mut properties = self.properties.lock().unwrap();
            let entry = properties.entry(path.clone()).or_default();
            for (set, property) in patch {
                let key = property_key(&property);
                if set {
                    entry.insert(key, property);
                } else {
                    entry.remove(&key);
                }
            }
            if entry.is_empty() {
                properties.remove(&path);
            }
            Ok(result)
        }
        .boxed()
    }

    fn get_props<'a>(&'a self, path: &'a DavPath, content: bool) -> FsFuture<'a, Vec<DavProp>> {
        async move {
            let path = Self::path(path)?;
            let properties = self.properties.lock().unwrap();
            Ok(properties
                .get(&path)
                .into_iter()
                .flat_map(|entry| entry.values())
                .cloned()
                .map(|mut property| {
                    if !content {
                        property.xml = None;
                    }
                    property
                })
                .collect())
        }
        .boxed()
    }

    fn get_prop<'a>(&'a self, path: &'a DavPath, property: DavProp) -> FsFuture<'a, Vec<u8>> {
        async move {
            let path = Self::path(path)?;
            self.properties
                .lock()
                .unwrap()
                .get(&path)
                .and_then(|entry| entry.get(&property_key(&property)))
                .and_then(|stored| stored.xml.clone())
                .ok_or(FsError::NotFound)
        }
        .boxed()
    }
}

fn property_key(property: &DavProp) -> (Option<String>, String) {
    (property.namespace.clone(), property.name.clone())
}

pub(super) fn metadata_name(segment: &[u8]) -> bool {
    let segment = segment.to_ascii_lowercase();
    segment == b".ds_store"
        || segment.starts_with(b".ds_store.")
        || segment.starts_with(b"._")
        || matches!(
            segment.as_slice(),
            b".appledouble"
                | b".documentrevisions-v100"
                | b".fseventsd"
                | b".lsoverride"
                | b".spotlight-v100"
                | b".temporaryitems"
                | b".trashes"
                | b"desktop.ini"
                | b"ehthumbs.db"
                | b"icon\r"
                | b"thumbs.db"
        )
}
