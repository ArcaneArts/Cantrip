use crate::cantrip_os::terminal::Pty;
use anyhow::Result;
use cantrip_wire::{Value, value::json};
use codex_utils_pty::{ProcessHandle, TerminalSize};
use std::{
    future::{Future, ready},
    time::Duration,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Recovery {
    Requested,
    NoLiveProcess,
    ResizeFailed,
}

impl Recovery {
    pub(super) fn describe(self, metadata: &mut Value) {
        metadata["recovery"] = json!(if self == Self::Requested {
            "redraw-requested"
        } else {
            "redraw-failed"
        });
        match self {
            Self::Requested => {}
            Self::NoLiveProcess => metadata["recoveryReason"] = json!("no-live-process"),
            Self::ResizeFailed => metadata["recoveryReason"] = json!("resize-failed"),
        }
    }
}

pub(super) trait Resizable {
    fn resize_terminal(&mut self, size: TerminalSize) -> impl Future<Output = Result<()>> + Send;
}

impl Resizable for ProcessHandle {
    fn resize_terminal(&mut self, size: TerminalSize) -> impl Future<Output = Result<()>> + Send {
        ready(self.resize(size))
    }
}

impl Resizable for Pty {
    async fn resize_terminal(&mut self, size: TerminalSize) -> Result<()> {
        self.resize(size).await
    }
}

pub(super) async fn redraw(size: TerminalSize, terminal: &mut impl Resizable) -> Recovery {
    let temporary = TerminalSize {
        cols: if size.cols == 1 { 2 } else { size.cols - 1 },
        rows: size.rows,
    };
    if terminal.resize_terminal(temporary).await.is_err() {
        return Recovery::ResizeFailed;
    }
    tokio::time::sleep(Duration::from_millis(25)).await;
    if terminal.resize_terminal(size).await.is_err() {
        return Recovery::ResizeFailed;
    }
    Recovery::Requested
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Terminal {
        attempts: Vec<TerminalSize>,
        fail_on: usize,
    }

    impl Resizable for Terminal {
        fn resize_terminal(
            &mut self,
            size: TerminalSize,
        ) -> impl Future<Output = Result<()>> + Send {
            self.attempts.push(size);
            ready(if self.attempts.len() == self.fail_on {
                Err(anyhow::anyhow!("Resize failed in the fixture."))
            } else {
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn redraw_restores_even_a_one_column_terminal() {
        let size = TerminalSize { rows: 12, cols: 1 };
        let mut terminal = Terminal::default();
        assert_eq!(redraw(size, &mut terminal).await, Recovery::Requested);
        assert_eq!(
            terminal.attempts,
            [TerminalSize { rows: 12, cols: 2 }, size]
        );
    }

    #[tokio::test]
    async fn both_resize_failures_are_reported() {
        let size = TerminalSize { rows: 12, cols: 80 };
        for fail_on in [1, 2] {
            let mut terminal = Terminal {
                fail_on,
                ..Terminal::default()
            };
            assert_eq!(redraw(size, &mut terminal).await, Recovery::ResizeFailed);
            assert_eq!(terminal.attempts.len(), fail_on);
        }
    }
}
