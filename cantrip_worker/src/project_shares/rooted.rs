//! Perform file I/O through the opened share directory.
use bytes::{Buf, Bytes};
use cap_std::fs::{Dir, Metadata as CapMetadata, OpenOptions as CapOptions};
use dav_server::fs::{
    DavDirEntry, DavFile, DavMetaData, FsError, FsFuture, FsResult, FsStream, OpenOptions,
    ReadDirMeta,
};
use futures::{FutureExt, stream};
use std::{
    io::{self, ErrorKind, SeekFrom},
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};
use tokio::{
    fs::File as TokioFile,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::mpsc,
    task::spawn_blocking,
};

pub(super) async fn perform<T: Send + 'static>(
    directory: Arc<Dir>,
    operation: impl FnOnce(&Dir) -> io::Result<T> + Send + 'static,
) -> FsResult<T> {
    spawn_blocking(move || operation(&directory))
        .await
        .map_err(|_| FsError::GeneralFailure)?
        .map_err(map_io)
}

pub(super) async fn open(
    directory: Arc<Dir>,
    path: PathBuf,
    options: OpenOptions,
) -> FsResult<Box<dyn DavFile>> {
    let file = perform(directory, move |root| {
        let mut cfg = CapOptions::new();
        cfg.read(options.read)
            .write(options.write)
            .append(options.append)
            .truncate(options.truncate)
            .create(options.create)
            .create_new(options.create_new);
        nonblocking(&mut cfg);
        let file = root.open_with(path, &cfg)?;
        if !file.metadata()?.is_file() {
            return Err(ErrorKind::PermissionDenied.into());
        }
        Ok(file.into_std())
    })
    .await?;
    Ok(Box::new(File(TokioFile::from_std(file))))
}

pub(super) async fn entries(
    directory: Arc<Dir>,
    path: PathBuf,
    mode: ReadDirMeta,
) -> FsResult<FsStream<Box<dyn DavDirEntry>>> {
    let opened = path.clone();
    let entries = perform(directory.clone(), move |root| root.read_dir(opened)).await?;
    let (send, receive) = mpsc::channel(32);
    spawn_blocking(move || {
        for candidate in entries {
            let entry = candidate.map_err(map_io).and_then(|entry| {
                let file_name = entry.file_name();
                let name = file_name
                    .to_str()
                    .ok_or(FsError::NotFound)?
                    .as_bytes()
                    .to_vec();
                let path = path.join(file_name);
                let metadata = if matches!(mode, ReadDirMeta::DataSymlink) {
                    directory.symlink_metadata(path).map_err(map_io)?
                } else {
                    directory.metadata(path).map_err(map_io)?
                };
                Ok(Box::new(Entry {
                    name,
                    metadata: Metadata::from(metadata),
                }) as Box<dyn DavDirEntry>)
            });
            if matches!(entry, Err(FsError::NotFound | FsError::Forbidden)) {
                continue;
            }
            if send.blocking_send(entry).is_err() {
                break;
            }
        }
    });
    Ok(Box::pin(stream::unfold(receive, |mut receive| async {
        receive.recv().await.map(|entry| (entry, receive))
    })))
}

pub(super) async fn metadata(
    directory: Arc<Dir>,
    path: PathBuf,
    follow: bool,
) -> FsResult<Box<dyn DavMetaData>> {
    let meta = perform(directory, move |root| {
        if follow {
            root.metadata(path)
        } else {
            root.symlink_metadata(path)
        }
    })
    .await?;
    Ok(Box::new(Metadata::from(meta)))
}

pub(super) fn set_modified(root: &Dir, path: &Path, modified: SystemTime) -> io::Result<()> {
    let mut options = CapOptions::new();
    options.read(true);
    nonblocking(&mut options);
    let file = root.open_with(path, &options)?;
    let meta = file.metadata()?;
    if !meta.is_dir() && !meta.is_file() {
        return Err(ErrorKind::PermissionDenied.into());
    }
    file.into_std()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
}

fn nonblocking(_options: &mut CapOptions) {
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        _options.custom_flags(libc::O_NONBLOCK);
    }
}

fn map_io(error: io::Error) -> FsError {
    match error.kind() {
        ErrorKind::NotFound => FsError::NotFound,
        ErrorKind::AlreadyExists | ErrorKind::DirectoryNotEmpty => FsError::Exists,
        ErrorKind::PermissionDenied | ErrorKind::NotADirectory | ErrorKind::IsADirectory => {
            FsError::Forbidden
        }
        ErrorKind::StorageFull | ErrorKind::QuotaExceeded => FsError::InsufficientStorage,
        ErrorKind::FileTooLarge => FsError::TooLarge,
        ErrorKind::Unsupported => FsError::NotImplemented,
        _ => FsError::GeneralFailure,
    }
}

struct Entry {
    name: Vec<u8>,
    metadata: Metadata,
}

impl DavDirEntry for Entry {
    fn name(&self) -> Vec<u8> {
        self.name.clone()
    }

    fn metadata(&self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        futures::future::ready(Ok(Box::new(self.metadata.clone()) as Box<dyn DavMetaData>)).boxed()
    }
}

#[derive(Debug)]
struct File(TokioFile);

impl DavFile for File {
    fn metadata(&mut self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        async move {
            let meta = self.0.metadata().await.map_err(map_io)?;
            Ok(Box::new(Metadata::from(meta)) as Box<dyn DavMetaData>)
        }
        .boxed()
    }

    fn write_buf(&mut self, mut buffer: Box<dyn Buf + Send>) -> FsFuture<'_, ()> {
        async move {
            while buffer.has_remaining() {
                let chunk = buffer.chunk();
                let len = chunk.len();
                self.0.write_all(chunk).await.map_err(map_io)?;
                buffer.advance(len);
            }
            Ok(())
        }
        .boxed()
    }

    fn write_bytes(&mut self, buffer: Bytes) -> FsFuture<'_, ()> {
        async move { self.0.write_all(&buffer).await.map_err(map_io) }.boxed()
    }

    fn read_bytes(&mut self, count: usize) -> FsFuture<'_, Bytes> {
        async move {
            let mut bytes = vec![0; count];
            let read = self.0.read(&mut bytes).await.map_err(map_io)?;
            bytes.truncate(read);
            Ok(bytes.into())
        }
        .boxed()
    }

    fn seek(&mut self, pos: SeekFrom) -> FsFuture<'_, u64> {
        async move { self.0.seek(pos).await.map_err(map_io) }.boxed()
    }

    fn flush(&mut self) -> FsFuture<'_, ()> {
        async move { self.0.flush().await.map_err(map_io) }.boxed()
    }
}

#[derive(Clone, Debug)]
struct Metadata {
    len: u64,
    dir: bool,
    file: bool,
    symlink: bool,
    modified: FsResult<SystemTime>,
    accessed: FsResult<SystemTime>,
    created: FsResult<SystemTime>,
}

impl From<CapMetadata> for Metadata {
    fn from(meta: CapMetadata) -> Self {
        Self {
            len: meta.len(),
            dir: meta.is_dir(),
            file: meta.is_file(),
            symlink: meta.file_type().is_symlink(),
            modified: meta
                .modified()
                .map(cap_std::time::SystemTime::into_std)
                .map_err(map_io),
            accessed: meta
                .accessed()
                .map(cap_std::time::SystemTime::into_std)
                .map_err(map_io),
            created: meta
                .created()
                .map(cap_std::time::SystemTime::into_std)
                .map_err(map_io),
        }
    }
}

impl From<std::fs::Metadata> for Metadata {
    fn from(meta: std::fs::Metadata) -> Self {
        Self {
            len: meta.len(),
            dir: meta.is_dir(),
            file: meta.is_file(),
            symlink: meta.file_type().is_symlink(),
            modified: meta.modified().map_err(map_io),
            accessed: meta.accessed().map_err(map_io),
            created: meta.created().map_err(map_io),
        }
    }
}

impl DavMetaData for Metadata {
    fn len(&self) -> u64 {
        self.len
    }

    fn modified(&self) -> FsResult<SystemTime> {
        self.modified
    }

    fn is_dir(&self) -> bool {
        self.dir
    }

    fn is_file(&self) -> bool {
        self.file
    }

    fn is_symlink(&self) -> bool {
        self.symlink
    }

    fn accessed(&self) -> FsResult<SystemTime> {
        self.accessed
    }

    fn created(&self) -> FsResult<SystemTime> {
        self.created
    }
}
