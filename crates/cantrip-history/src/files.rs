//! Durable, exclusive publication. IO runs on the caller-owned blocking job.
use crate::parse;
use anyhow::Result;
use cantrip_wire::Value;
#[cfg(not(windows))]
use std::fs::File;
use std::future::Future;
use std::{
    collections::HashMap,
    fs::{self},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};
use tokio::sync::oneshot;
use uuid::Uuid;

pub fn flush_directory(directory: &Path) -> Result<()> {
    #[cfg(not(windows))]
    File::open(directory)?.sync_all()?;
    #[cfg(windows)]
    let _ = directory;
    Ok(())
}
/// Used by later outbox/checkpoint writers too. Flush newly created directory
/// links and their parent; Windows retains the source's file-only flushing.
pub fn ensure_directory(directory: &Path) -> Result<()> {
    if let Some(first) = create_directory(directory)? {
        let parent = first
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let mut current = directory;
        loop {
            flush_directory(current)?;
            if current == parent {
                break;
            }
            current = current
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
        }
    }
    Ok(())
}
// Recursive mkdir returns the first actually created component, as Node does.
// Attempt the real operation before handling its concrete missing-parent error.
fn create_directory(directory: &Path) -> std::io::Result<Option<PathBuf>> {
    let create = || {
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(directory)
    };
    let existing = |error: std::io::Error| -> std::io::Result<Option<PathBuf>> {
        if error.kind() == std::io::ErrorKind::AlreadyExists
            && fs::metadata(directory).is_ok_and(|m| m.is_dir())
        {
            Ok(None)
        } else {
            Err(error)
        }
    };
    match create() {
        Ok(()) => Ok(Some(directory.to_path_buf())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let Some(parent) = directory.parent() else {
                return Err(error);
            };
            let parent = if parent.as_os_str().is_empty() {
                Path::new(".")
            } else {
                parent
            };
            let first = create_directory(parent)?;
            match create() {
                Ok(()) => Ok(first.or_else(|| Some(directory.to_path_buf()))),
                Err(error) => existing(error).map(|_| first),
            }
        }
        Err(error) => existing(error),
    }
}
struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
pub fn write_immutable(destination: &Path, content: &str) -> Result<bool> {
    write_immutable_bytes(destination, content.as_bytes())
}

pub fn write_immutable_bytes(destination: &Path, content: &[u8]) -> Result<bool> {
    let mut temporary = destination.as_os_str().to_os_string();
    temporary.push(format!(".{}.tmp", Uuid::new_v4()));
    let temporary = Temporary(temporary.into());
    let mut file = cantrip_host::files::open_private(&temporary.0)?;
    file.write_all(content)?;
    file.sync_all()?;
    drop(file);
    let published = match fs::hard_link(&temporary.0, destination) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(error) => return Err(error.into()),
    };
    flush_directory(destination.parent().expect("history file parent"))?;
    fs::remove_file(&temporary.0)?;
    Ok(published)
}
pub fn read_json(filename: &Path) -> Result<Value> {
    // Node readFile(..., 'utf8') replaces malformed file bytes before JSON.parse.
    parse(&String::from_utf8_lossy(&fs::read(filename)?))
}
/// A synchronous enqueue point, like the source Promise tail. Callers may drop
/// their result future without cancelling accepted disk IO or releasing the next
/// operation before publication has finished. Workers must drain before shutdown.
#[derive(Default)]
pub struct Queue {
    tail: Mutex<Option<oneshot::Receiver<()>>>,
}
impl Queue {
    pub fn run<T: Send + 'static, F: FnOnce() -> Result<T> + Send + 'static>(
        self: &Arc<Self>,
        operation: F,
    ) -> impl Future<Output = Result<T>> + Send + use<T, F> {
        self.run_async(async move {
            tokio::task::spawn_blocking(operation)
                .await
                .map_err(anyhow::Error::from)
                .and_then(|v| v)
        })
    }
    pub fn run_async<T: Send + 'static, F: Future<Output = Result<T>> + Send + 'static>(
        self: &Arc<Self>,
        operation: F,
    ) -> impl Future<Output = Result<T>> + Send + use<T, F> {
        let (finished, next) = oneshot::channel();
        let previous = self.tail.lock().unwrap().replace(next);
        let (answer, result) = oneshot::channel();
        let keep = self.clone();
        tokio::spawn(async move {
            if let Some(previous) = previous {
                let _ = previous.await;
            }
            let outcome = operation.await;
            let _ = answer.send(outcome);
            let _ = finished.send(());
            drop(keep);
        });
        async move { result.await? }
    }
}
/// Process-local serialization by a caller-selected lexical absolute path.
/// This does not authorize that path or establish cross-process ownership.
pub fn queue(directory: &Path) -> Arc<Queue> {
    static QUEUES: OnceLock<Mutex<HashMap<PathBuf, Weak<Queue>>>> = OnceLock::new();
    let mut queues = QUEUES.get_or_init(Default::default).lock().unwrap();
    queues.retain(|_, value| value.strong_count() != 0);
    if let Some(queue) = queues.get(directory).and_then(Weak::upgrade) {
        return queue;
    }
    let queue = Arc::new(Queue::default());
    queues.insert(directory.to_path_buf(), Arc::downgrade(&queue));
    queue
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn async_recovery_keeps_its_queue_slot_after_response_abandonment() -> Result<()> {
        let root = tempfile::tempdir()?;
        let queue = queue(root.path());
        let state = Arc::new(Mutex::new(Vec::new()));
        let (began, started) = oneshot::channel();
        let (release, blocked) = oneshot::channel();
        let first_state = state.clone();
        let first = queue.run_async(async move {
            let _ = began.send(());
            blocked.await?;
            first_state.lock().unwrap().push(1);
            Err::<(), _>(anyhow::anyhow!("actual asynchronous recovery failed"))
        });
        started.await?;
        drop(first);
        let next_state = state.clone();
        let next = queue.run(move || {
            next_state.lock().unwrap().push(2);
            Ok(())
        });
        assert!(state.lock().unwrap().is_empty());
        release.send(()).unwrap();
        next.await?;
        assert_eq!(*state.lock().unwrap(), vec![1, 2]);
        Ok(())
    }

    #[test]
    fn exclusive_publication_keeps_committed_bytes_and_cleans_temporaries() -> Result<()> {
        let root = tempfile::tempdir()?;
        let nested = root.path().join("a/b");
        ensure_directory(&nested)?;
        let filename = nested.join("committed.json");
        assert!(write_immutable(&filename, "first")?);
        assert!(!write_immutable(&filename, "second")?);
        assert_eq!(fs::read_to_string(&filename)?, "first");
        assert_eq!(fs::read_dir(&nested)?.count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&nested)?.permissions().mode() & 0o777, 0o700);
            assert_eq!(fs::metadata(&filename)?.permissions().mode() & 0o777, 0o600);
        }
        Ok(())
    }

    #[tokio::test]
    async fn enqueue_is_fifo_and_response_abandonment_and_errors_do_not_release_io_early()
    -> Result<()> {
        let root = tempfile::tempdir()?;
        let queue = queue(root.path());
        let state = Arc::new(Mutex::new(Vec::new()));
        let (began, started) = oneshot::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        let first_state = state.clone();
        let first = queue.run(move || -> Result<()> {
            let _ = began.send(());
            blocked.recv()?;
            first_state.lock().unwrap().push(1);
            anyhow::bail!("actual first operation failed after IO");
        });
        started.await?;
        drop(first);
        let next_state = state.clone();
        let second = queue.run(move || {
            next_state.lock().unwrap().push(2);
            Ok(())
        });
        assert!(state.lock().unwrap().is_empty());
        release.send(())?;
        second.await?;
        assert_eq!(*state.lock().unwrap(), vec![1, 2]);
        Ok(())
    }
}
