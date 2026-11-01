//! Concrete Task collaborators for the shared queue/worktree coordinator.
use super::*;
use crate::chats::{goals, task_recovery};
pub struct TaskServices {
    goals: Arc<goals::Service>,
    recovery: Arc<task_recovery::Service>,
}
impl TaskServices {
    pub fn new(goals: Arc<goals::Service>, recovery: Arc<task_recovery::Service>) -> Arc<Self> {
        Arc::new(Self { goals, recovery })
    }
}
impl TaskTransitions for TaskServices {
    fn recover(&self, owner: String, chat: String) -> BoxFuture<'static, Result<bool>> {
        self.recovery.recover(&owner, &chat, false, false)
    }
    fn continue_goal(
        &self,
        owner: String,
        context: Value,
        input: Value,
    ) -> BoxFuture<'static, Result<bool>> {
        self.goals.continue_worktree(&owner, &context, &input, None)
    }
    fn reconcile(&self, owner: String) -> BoxFuture<'static, Result<()>> {
        self.recovery.reconcile(&owner)
    }
}
