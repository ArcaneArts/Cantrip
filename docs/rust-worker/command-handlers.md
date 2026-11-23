# Rust worker command handlers

The handlers below were traced from the authoritative [worker command schema](../../packages/protocol/src/worker-commands.ts) through the production Rust worker. Review baseline `0e5f935c263de45574ef99fe3e3b0e106fed9eec` (#3565), plus the Git inspection route added with this record. The [coverage ledger](../RUST_WORKER_PORT.md#coverage-ledger) links local behavior and recovery evidence.

## Worker control connection

The [authenticated connection](../../cantrip_worker/src/connection.rs) validates requests before the runtime dispatches them. Provider account and quota commands select the provider-specific handler. Run terminal input is rejected before the interactive shell handler when the Run manager owns the terminal.

| Production dispatch | Commands |
| --- | --- |
| [Log subscriptions](../../cantrip_worker/src/runtime.rs#L585) | `diagnostics.logs.stream.start`, `diagnostics.logs.stream.renew`, `diagnostics.logs.stream.stop` |
| [Protected Chat content and queue preparation](../../cantrip_worker/src/runtime.rs#L590) | `chat.message.protect`, `chat.messages.protect`, `chat.messages.reprotect`, `chat.turn.protect`, `chat.queue.prepare` |
| [Automation input protection](../../cantrip_worker/src/runtime.rs#L604) | `automation.dispatch.protect` |
| [Managed web runtime installation](../../cantrip_worker/src/runtime.rs#L620) | `web-runtime.action` |
| [Guest tunnel preparation](../../cantrip_worker/src/runtime.rs#L631) | `surface.tunnel.os-prepare` |
| [WorkerLink identity, sessions, and grants](../../cantrip_worker/src/runtime.rs#L648) | `worker-link.identity.resolve`, `worker-link.session.install`, `worker-link.session.renew`, `worker-link.session.route`, `worker-link.session.revoke`, `worker-link.grant.install`, `worker-link.grant.renew`, `worker-link.grant.revoke` |
| [WorkerLink peer signaling](../../cantrip_worker/src/runtime.rs#L653) | `worker-link.peer.install`, `worker-link.peer.renew`, `worker-link.peer.revoke`, `worker-link.peer.signal` |
| [Direct connection capability](../../cantrip_worker/src/runtime.rs#L664) | `direct.capability.prepare`, `direct.capability.renew`, `direct.capability.revoke` |
| [Model operation cancellation](../../cantrip_worker/src/runtime.rs#L671) | `model.operation.cancel` |
| [Provider connection test](../../cantrip_worker/src/runtime.rs#L676) | `model.provider.test` |
| [Embeddings and model decisions](../../cantrip_worker/src/runtime.rs#L691) | `model.embedding`, `model.decision` |
| [Task inference revocation](../../cantrip_worker/src/runtime.rs#L715) | `inference.task-revoke` |
| [Inference revocation](../../cantrip_worker/src/runtime.rs#L727) | `inference.revoke` |
| [Inference configuration and status](../../cantrip_worker/src/runtime.rs#L732) | `inference.configure`, `inference.status` |
| [Private label generation](../../cantrip_worker/src/runtime.rs#L737) | `label.generate` |
| [Protected Task messages](../../cantrip_worker/src/runtime.rs#L753) | `task.message.protect`, `task.operation.prepare` |
| [Goals and queue admission](../../cantrip_worker/src/runtime.rs#L767) | `chat.goal.create`, `chat.goal.get`, `chat.goal.update`, `chat.goal.clear`, `chat.queue.execute` |
| [Native logical completion and cancellation](../../cantrip_worker/src/runtime.rs#L797) | `chat.native-logical.complete`, `chat.native-logical.cancel` |
| [Suspension resume](../../cantrip_worker/src/runtime.rs#L818) | `chat.suspension.resume` |
| [Agent interaction replies](../../cantrip_worker/src/runtime.rs#L840) | `agent.interaction.respond`, `agent.interaction.respond.protected`, `agent.interaction.cancel` |
| [Runtime handoff and Goal recovery](../../cantrip_worker/src/runtime.rs#L851) | `chat.runtime.handoff`, `task.goal.source`, `task.goal.recover`, `chat.goal.recover`, `chat.goal.claim-recover` |
| [Chat turn and execution controls](../../cantrip_worker/src/runtime.rs#L871) | `chat.turn`, `chat.interrupt`, `chat.native-control`, `chat.steer`, `chat.suspension.stop`, `chat.pause.set` |
| [Queue wake-up and automation resume](../../cantrip_worker/src/runtime.rs#L922) | `chat.queue.changed`, `chat.automation.resume` |
| [Native settings and permissions](../../cantrip_worker/src/runtime.rs#L940) | `chat.settings.update`, `chat.account-defaults`, `chat.permissions.update` |
| [Native settings reads](../../cantrip_worker/src/runtime.rs#L957) | `chat.settings.read` |
| [Skills and customization](../../cantrip_worker/src/runtime.rs#L969) | `skills.list`, `customization.skill.configure`, `skills.settings.list`, `skills.settings.read`, `skills.settings.write`, `skills.settings.delete`, `skills.settings.configure`, `customization.inventory.read`, `customization.skill-roots.set`, `customization.mcp.resource.read`, `customization.mcp.reload`, `customization.mcp.oauth.start`, `customization.mcp.oauth.status`, `customization.external.preview`, `customization.external.apply`, `customization.external.status` |
| [Managed thread preparation](../../cantrip_worker/src/runtime.rs#L980) | `chat.thread.ensure` |
| [Permission profile discovery](../../cantrip_worker/src/runtime.rs#L988) | `permission-profiles.list` |
| [Chat plan state](../../cantrip_worker/src/runtime.rs#L999) | `chat.plan.get`, `chat.plan.set` |
| [Chat sync](../../cantrip_worker/src/runtime.rs#L1010) | `chat.sync` |
| [Context compaction](../../cantrip_worker/src/runtime.rs#L1018) | `chat.compact` |
| [Edit and resend](../../cantrip_worker/src/runtime.rs#L1041) | `chat.turn.rollback` |
| [Chat relocation](../../cantrip_worker/src/runtime.rs#L1053) | `chat.relocation.hydration.begin`, `chat.relocation.hydration.chunk`, `chat.relocation.hydration.complete`, `chat.relocation.thread.release` |
| [Endpoint and Ollama model discovery](../../cantrip_worker/src/runtime.rs#L1068) | `model.endpoint.catalog`, `model.ollama.catalog` |
| [ChatGPT catalog and quotas](../../cantrip_worker/src/runtime.rs#L1080) | `model.chatgpt.catalog`, `provider.quota.read`, `provider.rate-limit-reset.consume` |
| [Grok catalog and quotas](../../cantrip_worker/src/runtime.rs#L1088) | `model.grok.catalog`, `provider.quota.read` |
| [Provider credential records](../../cantrip_worker/src/runtime.rs#L1096) | `provider.auth.legacy.capture`, `provider.auth.legacy.purge`, `provider.auth.account.clear` |
| [ChatGPT account authentication](../../cantrip_worker/src/runtime.rs#L1104) | `codex.auth.status`, `codex.auth.login.start`, `codex.auth.logout` |
| [Grok account authentication](../../cantrip_worker/src/runtime.rs#L1112) | `codex.auth.status`, `codex.auth.login.start`, `codex.auth.logout` |
| [Worker encryption refresh](../../cantrip_worker/src/runtime.rs#L1120) | `worker.encryption.refresh` |
| [Standalone Chat scratch storage](../../cantrip_worker/src/runtime.rs#L1136) | `chat.scratch.provision`, `chat.scratch.resolve`, `chat.scratch.archive`, `chat.scratch.restore`, `chat.scratch.delete`, `chat.scratch.reconcile` |
| [Project file shares](../../cantrip_worker/src/runtime.rs#L1144) | `project.share.open`, `project.share.close` |
| [External MCP configuration discovery](../../cantrip_worker/src/runtime.rs#L1155) | `mcp.configurations.discover` |
| [Browser service discovery](../../cantrip_worker/src/runtime.rs#L1171) | `browser.services.discover` |
| [Computer-use preview and operations](../../cantrip_worker/src/runtime.rs#L1182) | `computer-use.preview.open`, `computer-use.preview.stop`, `computer-use.preview.revoke`, `computer-use.operation`, `computer-use.approval.respond`, `surface.desktop.os-prepare` |
| [Desktop targets and input effects](../../cantrip_worker/src/runtime.rs#L1204) | `surface.desktop.targets`, `computer-use.effects.sync`, `surface.desktop.probe` |
| [Browser and desktop surface lifecycle](../../cantrip_worker/src/runtime.rs#L1224) | `surface.attach`, `surface.detach`, `surface.configure`, `surface.suspend`, `surface.resume`, `surface.close` |
| [Managed project folders](../../cantrip_worker/src/runtime.rs#L1239) | `project.folder.materialize`, `project.folder.delete` |
| [External conversation history](../../cantrip_worker/src/runtime.rs#L1259) | `external.chat-history.discover`, `external.chat-history.read`, `external.chat-history.attachment.read`, `external.chat-history.attachments.release` |
| [Attachments](../../cantrip_worker/src/runtime.rs#L1259) | `attachment.upload.begin`, `attachment.upload.chunk`, `attachment.upload.complete`, `attachment.read`, `attachment.delete` |
| [Project Chat export](../../cantrip_worker/src/runtime.rs#L1279) | `project.export.target.inspect`, `project.export.chat.begin`, `project.export.chat.chunk`, `project.export.chat.complete` |
| [Folder conversion](../../cantrip_worker/src/runtime.rs#L1293) | `project.folder-conversion.preflight`, `project.folder-conversion.execute` |
| [Project file deletion](../../cantrip_worker/src/runtime.rs#L1306) | `project.files.delete` |
| [Project clone and replicas](../../cantrip_worker/src/runtime.rs#L1326) | `project.clone`, `project.replica.provision`, `project.replica.link.repair`, `project.replica.synchronize`, `project.replica.remove` |
| [Project script commands](../../cantrip_worker/src/runtime.rs#L1340) | `project.script-commands.inspect`, `project.script-commands` |
| [Repository and folder statistics](../../cantrip_worker/src/runtime.rs#L1356) | `project.repository-stats`, `project.folder-stats` |
| [GitHub client](../../cantrip_worker/src/runtime.rs#L1371) | `github.auth.status`, `github.repositories.cached`, `github.repositories.list`, `github.repository-owners.list`, `github.repositories.create`, `github.issues.list`, `github.pull-requests.list`, `github.issue.get`, `github.issue.create`, `github.issue.comment`, `github.issue.close`, `github.pull-request.get`, `github.pull-request.create`, `github.pull-request.comment`, `github.pull-request.review.submit`, `github.pull-request.review.comment`, `github.pull-request.review.reply`, `github.pull-request.review.mutate`, `github.pull-request.lifecycle.preview`, `github.pull-request.lifecycle.apply`, `github.pull-request.checkout.prepare`, `github.pull-request.agent-context`, `github.inbox.list`, `github.actions.overview`, `github.actions.run.get`, `github.actions.run.logs`, `github.actions.workflow.dispatch`, `github.actions.run.action`, `github.actions.run.checkout.prepare`, `github.releases.list`, `github.release.get`, `github.release.create` |
| [Cantrip OS controller](../../cantrip_worker/src/runtime.rs#L1379) | `cantrip-os.inspect`, `cantrip-os.attach`, `cantrip-os.workspaces.list`, `cantrip-os.workspaces.create`, `cantrip-os.operation.inspect`, `cantrip-os.source.inspect`, `cantrip-os.source.provision`, `cantrip-os.desktop.status`, `cantrip-os.desktop.operation`, `cantrip-os.packages.status`, `cantrip-os.packages.operation`, `cantrip-os.power.status`, `cantrip-os.power.operation`, `cantrip-os.system.status`, `cantrip-os.system.capture`, `cantrip-os.system.replace`, `cantrip-os.system.rollback`, `cantrip-os.run-definition`, `cantrip-os.backup.observe`, `cantrip-os.backup.capture`, `cantrip-os.backup.restore`, `cantrip-os.backup.rollback`, `cantrip-os.backup.reset` |
| [Host and guest Run processes](../../cantrip_worker/src/runtime.rs#L1393) | `project.run-configuration-runtime.start`, `project.run-configuration-runtime.restart`, `project.run-configuration-runtime.stop`, `project.run-configuration-runtime.status`, `project.run-configuration-runtime.output`, `project.run-configuration-runtime.reconcile`, `cantrip-os.run-runtime.start`, `cantrip-os.run-runtime.restart`, `cantrip-os.run-runtime.stop`, `cantrip-os.run-runtime.status`, `cantrip-os.run-runtime.output`, `cantrip-os.run-runtime.reconcile` |
| [Run configuration definitions](../../cantrip_worker/src/runtime.rs#L1405) | `project.run-configuration-definitions.get`, `project.run-configuration-definitions.write`, `project.run-configuration-definitions.delete`, `project.run-configuration-definitions.paths`, `project.run-configuration-definitions.capabilities`, `project.run-configuration-definitions.detect`, `project.run-configuration-definitions.validate`, `project.run-configuration-definitions.flutter-devices`, `project.run-configuration-definitions.list` |
| [Run terminal input guard](../../cantrip_worker/src/runtime.rs#L1421) | `terminal.input` |
| [Interactive PTY](../../cantrip_worker/src/runtime.rs#L1426) | `terminal.prepare-state`, `terminal.open`, `terminal.detach`, `terminal.input`, `terminal.resize`, `terminal.close`, `terminal.snapshot` |
| [Terminal service reconciliation](../../cantrip_worker/src/runtime.rs#L1439) | `terminal.services.reconcile`, `terminal.service.restart` |
| [Explorer and file documents](../../cantrip_worker/src/runtime.rs#L1447) | `explorer.operation`, `file-document.operation`, `chat.files.references`, `chat.scratch.files.operation` |
| [Encrypted repository operations](../../cantrip_worker/src/runtime.rs#L1455) | `repository.operation` |
| [Core Git reconciliation](../../cantrip_worker/src/runtime.rs#L1465) · [Native inspector](../../cantrip_worker/src/git/mod.rs#L200) | `git.operation.inspect` |
| [Worktree observation configuration](../../cantrip_worker/src/runtime.rs#L1480) | `worktree.observation.configure` |
| [CodeGraph](../../cantrip_worker/src/runtime.rs#L1494) | `codegraph.status`, `codegraph.sync`, `codegraph.rebuild`, `codegraph.update.check` |
| [Worktree lifecycle and status](../../cantrip_worker/src/runtime.rs#L1506) | `worktree.list`, `worktree.reconcile`, `worktree.create`, `worktree.remove`, `worktree.lock`, `worktree.unlock`, `worktree.prune`, `worktree.status` |
| [Repository discovery and import validation](../../cantrip_worker/src/runtime.rs#L1535) | `workspace.repositories.discover`, `workspace.repository-import.validate` |
| [Worker version, restart, credentials, and logs](../../cantrip_worker/src/runtime.rs#L1724) | `worker.version`, `worker.restart`, `worker.credential.rotate`, `diagnostics.logs.read` |

## Protected repository operations

The [encrypted repository dispatcher](../../cantrip_worker/src/repository_operations.rs#L62) validates scope, access, and routing against the opened request before it hands a Git command to the native handler. The [protected operation schema](../../packages/protocol/src/repository-operation.ts#L95) also includes GitHub requests, `worktree.status`, `git.operation.current`, `git.agent.generate`, repository metadata, and workspace-root attachment. Core's separate [observation reconciler](../../cantrip_server/src/projects/observations/git.rs#L176) sends the direct inspection command for an existing durable Git operation.

| Protected Git command | Native handler |
| --- | --- |
| `git.action` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L232) |
| `git.branch.action.apply` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L134) |
| `git.branch.action.preview` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L133) |
| `git.branch.list` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L132) |
| `git.change-summary` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L77) |
| `git.commit.action.apply` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L166) |
| `git.commit.action.preview` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L165) |
| `git.commit.get` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L225) |
| `git.commit.search` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L224) |
| `git.commit.signature.get` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L226) |
| `git.compare` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L230) |
| `git.conflicts.apply` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L180) |
| `git.conflicts.get` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L176) |
| `git.conflicts.list` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L175) |
| `git.conflicts.preview` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L179) |
| `git.diff` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L233) |
| `git.file.blame` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L223) |
| `git.file.history` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L222) |
| `git.force-push.apply` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L79) |
| `git.force-push.preview` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L78) |
| `git.graph.commit-overlay` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L84) |
| `git.graph.metrics` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L83) |
| `git.graph.snapshot` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L82) |
| `git.history` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L221) |
| `git.lfs.action.apply` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L87) |
| `git.lfs.action.preview` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L86) |
| `git.lfs.status` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L85) |
| `git.operation.amend` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L212) |
| `git.operation.control` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L203) |
| `git.operation.preview` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L189) |
| `git.operation.start` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L190) |
| `git.patch.apply` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L144) |
| `git.patch.preview` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L143) |
| `git.recovery.apply` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L75) |
| `git.recovery.list` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L73) |
| `git.recovery.preview` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L74) |
| `git.refs.list` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L229) |
| `git.remote.action.apply` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L123) |
| `git.remote.action.preview` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L122) |
| `git.remote.list` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L121) |
| `git.revision.diff` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L231) |
| `git.stash.action.apply` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L156) |
| `git.stash.action.preview` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L155) |
| `git.stash.create` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L153) |
| `git.stash.diff` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L154) |
| `git.stash.list` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L199) |
| `git.status` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L76) |
| `git.submodule.action.apply` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L100) |
| `git.submodule.action.preview` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L97) |
| `git.submodule.list` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L96) |
| `git.tag.action.apply` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L112) |
| `git.tag.action.preview` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L111) |
| `git.tag.get` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L110) |
| `git.tag.list` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L109) |
| `git.worktree.changes.apply` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L63) |
| `git.worktree.changes.preview` | [Git dispatch](../../cantrip_worker/src/git/mod.rs#L54) |
