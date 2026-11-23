//! Direct lifetime-pipe child: it must survive parent EOF long enough to fence
//! native leases. Model-process parent-death/job policies do not belong here.
mod actor;
use super::*;
use tokio::{
    process::Command,
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
#[derive(Clone)]
enum Ack {
    Pending,
    Ready,
    Failed(JsString),
}
#[derive(Clone, Copy)]
struct End {
    confirmed: bool,
}
enum Operation {
    Request {
        id: String,
        command: Value,
        send: oneshot::Sender<Result<Response>>,
    },
    Expired(String),
    WriteFailed {
        id: String,
        message: JsString,
        report: bool,
    },
    Close,
}
struct Core {
    operations: mpsc::UnboundedSender<Operation>,
    ack: watch::Receiver<Ack>,
    done: watch::Receiver<Option<End>>,
    task: Mutex<Option<JoinHandle<()>>>,
    close: tokio::sync::Mutex<()>,
}
impl Drop for Core {
    fn drop(&mut self) {
        let _ = self.operations.send(Operation::Close);
    }
}
#[derive(Clone)]
pub(super) struct Helper(Arc<Core>);
impl Helper {
    pub fn spawn(
        binary: &Path,
        arguments: Vec<String>,
        options: &Options,
        generation: JsString,
        control: bool,
        on_closed: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Self> {
        let mut command = Command::new(binary);
        command
            .args(arguments)
            .current_dir(&options.cwd)
            .env_clear()
            .envs(&options.environment)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(false);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let child = command.spawn().map_err(|error| {
            let code = match error.kind() {
                std::io::ErrorKind::NotFound => "ENOENT",
                std::io::ErrorKind::PermissionDenied => "EACCES",
                _ => return anyhow!("spawn {}: {error}", binary.display()),
            };
            anyhow!("spawn {} {code}", binary.display())
        })?;
        let (send, receive) = mpsc::unbounded_channel();
        let (ack, acknowledged) = watch::channel(Ack::Pending);
        let (done, closed) = watch::channel(None);
        let task = tokio::spawn(actor::run(
            child,
            receive,
            send.clone(),
            ack,
            done,
            generation,
            control,
            options.clone(),
            on_closed,
        ));
        Ok(Self(Arc::new(Core {
            operations: send,
            ack: acknowledged,
            done: closed,
            task: Mutex::new(Some(task)),
            close: tokio::sync::Mutex::new(()),
        })))
    }
    pub fn has_exited(&self) -> bool {
        self.0.done.borrow().is_some()
    }
    pub async fn acknowledged(&self) -> Result<()> {
        let mut ack = self.0.ack.clone();
        loop {
            let value = ack.borrow().clone();
            match value {
                Ack::Ready => return Ok(()),
                Ack::Failed(message) => return Err(crate::error::WireError(message).into()),
                Ack::Pending => {}
            }
            ack.changed()
                .await
                .map_err(|_| anyhow!("Native ownership helper ended without acknowledgement."))?;
        }
    }
    pub fn journal(&self, command: Value) -> Work<Response> {
        let id = uuid::Uuid::new_v4().to_string();
        let (send, receive) = oneshot::channel();
        let _ = self
            .0
            .operations
            .send(Operation::Request { id, command, send });
        cantrip_transport::lifecycle::owned(async move {
            receive
                .await
                .map_err(|_| anyhow!("Native inference journal owner exited."))?
        })
    }
    pub fn close_input(&self) {
        let _ = self.0.operations.send(Operation::Close);
    }
    pub async fn close(&self) -> Result<()> {
        let _close = self.0.close.lock().await;
        self.close_input();
        let mut done = self.0.done.clone();
        while done.borrow().is_none() {
            done.changed()
                .await
                .map_err(|_| anyhow!("Native ownership helper process observation was lost."))?;
        }
        let task = self.0.task.lock().unwrap().take();
        if let Some(task) = task {
            let _ = task.await;
        }
        if !done.borrow().unwrap().confirmed {
            bail!("Native ownership helper process exit could not be confirmed.");
        }
        Ok(())
    }
}
