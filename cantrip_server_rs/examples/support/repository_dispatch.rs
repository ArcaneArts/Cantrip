use super::*;
use futures::future::BoxFuture;

pub struct Dispatcher<'a> {
    pub database: &'a Arc<Database>,
    pub repository: &'a ProjectRepository,
    pub folders: &'a cantrip_server::projects::folders::FolderRepository,
    pub placement: &'a cantrip_server::projects::placement::PlacementRepository,
    pub live: &'a cantrip_server::live::repository::LiveRepository,
    pub chats: &'a cantrip_server::chats::Repository,
}
impl Dispatcher<'_> {
    // Windows GDB measured 235232 bytes retained by the former async match.
    // Select and construct here, then unwind this frame before polling.
    pub fn run<'a>(
        &'a self,
        request: &'a Value,
        trace: Arc<std::sync::Mutex<Vec<Value>>>,
    ) -> BoxFuture<'a, Result<Value>> {
        let operation = request["op"].as_str().unwrap_or_default();
        if operation.starts_with("preparation-") {
            return managed_preparation::run(self.database.clone(), request).boxed();
        }
        if operation.starts_with("console-") {
            return async move {
                let result = chat_console::run(self.database.clone(), request, trace.clone())
                    .boxed()
                    .await?;
                Ok(Value::object([
                    ("result", result),
                    ("trace", Value::Array(trace.lock().unwrap().clone())),
                ]))
            }
            .boxed();
        }
        if operation.starts_with("fork-") {
            return chat_forks::run(self.database.clone(), request, trace).boxed();
        }
        if operation.starts_with("message-") {
            return chat_messages::run(self.database.clone(), request).boxed();
        }
        if operation.starts_with("native-command-") {
            return native_commands::run(self.database.clone(), request);
        }
        if operation.starts_with("native-history-") {
            return native_history::run(self.database.clone(), request).boxed();
        }
        if operation.starts_with("scratch-") {
            return scratch_roots::run(self.database.clone(), request).boxed();
        }
        if operation.starts_with("discovery-") {
            return discovery::run(self.database.clone(), request).boxed();
        }
        if operation.starts_with("conversion-") {
            return conversions::run(self.database.clone(), request).boxed();
        }
        if operation.starts_with("replica-") {
            return replicas::run(self.database.clone(), request).boxed();
        }
        if operation.starts_with("tunnel-") {
            return tunnels::run(self.database.clone(), request).boxed();
        }
        if operation.starts_with("browser-") {
            return browsers::run(self.database.clone(), request).boxed();
        }
        if operation.starts_with("document-") {
            return file_documents::run(self.database.clone(), request).boxed();
        }
        if operation.starts_with("layout-") {
            return pane_layouts::run(self.database.clone(), request).boxed();
        }
        if operation.starts_with("workspace-") {
            return workspaces::run(self.database.clone(), request).boxed();
        }
        if operation.starts_with("project-surface-") {
            return project_surfaces::run(self.database.clone(), request).boxed();
        }
        repository_operations::run(
            self.database,
            request,
            self.repository,
            self.folders,
            self.placement,
            self.live,
            self.chats,
        )
    }
}
