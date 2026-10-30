// Existing workspace transport/queue, renderer lifetimes, editor model and
// encrypted BroadcastChannel. Native desktop window hosting is separate QA.
import assert from "node:assert/strict";

export async function actualWorkspaceClient({ page, document, result }) {
  const requests = [];
  const capture = (request) => {
    if (new URL(request.url()).pathname.includes("/workspace-layouts/"))
      requests.push({
        path: new URL(request.url()).pathname,
        body: request.postData(),
      });
  };
  page.on("request", capture);
  try {
    const outcome = await page.evaluate(async (document) => {
      const { connectWorkspaceCommands } =
        await import("/src/lib/api/workspace-layouts.ts");
      const { getClientSessionIdentitySnapshot } =
        await import("/src/lib/client-session.ts");
      const { workspaceRendererLifetime } =
        await import("/src/lib/workspace-renderer-lifetime.ts");
      const { createWorkspaceTransferChannel } =
        await import("/src/lib/workspace-transfer-channel.ts");
      const { startWorkspaceTransferDestination, destinationTransferBinding } =
        await import("/src/lib/workspace-transfer-destination.ts");
      const { EditorDocumentSession, editorDocumentId } =
        await import("/src/components/editor/document-session.ts");
      const docs = await import("/src/lib/api/file-documents.ts");
      const identity = getClientSessionIdentitySnapshot(),
        workspaceId = "actual-device-" + crypto.randomUUID(),
        mainWindowId = "main";
      const scope = {
        serverId: identity.serverId,
        ownerId: identity.userId,
        workspaceId,
      };
      const main = await connectWorkspaceCommands(
        document.projectId,
        workspaceId,
        mainWindowId,
        async () => ({ mainWindowId }),
        await workspaceRendererLifetime({ ...scope, windowId: mainWindowId }),
      );
      let destination, sourceChannel, destinationChannel;
      try {
        await main.controller.openResource(
          {
            kind: "entity",
            definitionId: "project.file",
            resourceId: document.id,
          },
          { preview: true },
        );
        let layout = main.controller.getSnapshot().authoritative;
        const pane = layout.windows
          .find((w) => w.id === mainWindowId)
          .panes.find((p) =>
            p.tabs.some(
              (t) =>
                t.resource.kind === "entity" &&
                t.resource.resourceId === document.id,
            ),
          );
        const tab = pane.tabs.find(
          (t) =>
            t.resource.kind === "entity" &&
            t.resource.resourceId === document.id,
        );
        if (!tab.preview) throw new Error("Actual file preview was not opened");
        const read = await docs.executeFileDocumentOperation(document.id, {
          type: "explorer.file.read",
          path: document.path,
        });
        const editorId = editorDocumentId({
          server: identity.serverId,
          account: identity.userId,
          project: document.projectId,
          worker: document.workerId,
          worktree: document.worktreeId,
          path: document.path,
        });
        const editor = new EditorDocumentSession(
          editorId,
          read.value.content,
          read.value.version,
        );
        const privateMarker = "unsaved-workspace-" + crypto.randomUUID();
        const privateDraft =
          "Unsaved workspace draft 🦀 " +
          privateMarker +
          "\n" +
          read.value.content;
        editor.editExternal(privateDraft);
        editor.selection = { start: 3, end: 19, direction: "forward" };
        editor.scrollTop = 42;
        await main.controller.pinFilePreviews(document.id);
        const receipts = await Promise.all([
          main.controller.dispatch({ type: "select", tabId: tab.id }),
          main.controller.dispatch({ type: "home" }),
        ]);
        if (
          receipts[1].appliedRevision !== receipts[0].appliedRevision + 1 ||
          main.controller.getSnapshot().pendingCount !== 0
        )
          throw new Error(
            "Actual workspace client did not serialize queued commands",
          );
        const transferId = crypto.randomUUID(),
          windowId = "actual-detached-" + crypto.randomUUID(),
          paneId = "actual-detached-pane-" + crypto.randomUUID();
        await main.controller.dispatch({
          type: "prepare-detach",
          transferId,
          paneId: pane.id,
          tabId: tab.id,
          destinationWindowId: windowId,
          destinationPaneId: paneId,
        });
        destination = await connectWorkspaceCommands(
          document.projectId,
          workspaceId,
          windowId,
          undefined,
          await workspaceRendererLifetime({ ...scope, windowId }),
        );
        layout = destination.controller.getSnapshot().authoritative;
        const target = {
          projectId: document.projectId,
          paneId,
          activeTabKey: tab.id,
          transfer: {
            id: transferId,
            workspaceId,
            windowId,
            generation: layout.windows.find((w) => w.id === windowId)
              .attachmentGeneration,
          },
        };
        const binding = destinationTransferBinding(layout, windowId, target, {
          serverId: identity.serverId,
          ownerId: identity.userId,
        });
        const signal = () => {
          let resolve, reject;
          const promise = new Promise((yes, no) => {
            resolve = yes;
            reject = no;
          });
          return { promise, resolve, reject };
        };
        const ready = signal(),
          restored = signal();
        let restoreCount = 0,
          transferred;
        const fail = (error) => {
          ready.reject(error);
          restored.reject(error);
        };
        sourceChannel = createWorkspaceTransferChannel({
          side: "source",
          binding,
          onReady: ready.resolve,
          onRestored: restored.resolve,
          onError: fail,
        });
        destinationChannel = startWorkspaceTransferDestination({
          controller: destination.controller,
          windowId,
          target,
          identity: { serverId: identity.serverId, ownerId: identity.userId },
          onError: fail,
          restore: async (bytes) => {
            const snapshot = JSON.parse(new TextDecoder().decode(bytes));
            if (snapshot.id !== editorId)
              throw new Error("Transferred editor identity changed");
            transferred = EditorDocumentSession.fromTransfer(snapshot);
            restoreCount++;
          },
        });
        await destinationChannel.ready;
        await ready.promise;
        const snapshot = await editor.captureTransfer();
        await sourceChannel.sendSnapshot(
          new TextEncoder().encode(JSON.stringify(snapshot)),
        );
        await restored.promise;
        sourceChannel.resendSnapshot();
        await destination.controller.refresh();
        await main.controller.refresh();
        const before = main.controller.getSnapshot().authoritative;
        if (
          !before.windows
            .find((w) => w.id === mainWindowId)
            .panes.some((p) => p.tabs.some((t) => t.id === tab.id))
        )
          throw new Error(
            "Source ownership moved before editor restoration commit",
          );
        const committed = await main.controller.dispatch({
          type: "commit-transfer",
          transferId,
        });
        await destination.controller.refresh();
        if (
          !transferred?.dirty ||
          transferred.text !== privateDraft ||
          JSON.stringify(transferred.captureRecovery()) !==
            JSON.stringify(snapshot) ||
          restoreCount !== 1
        )
          throw new Error(
            "Actual editor draft/history/selection transfer changed",
          );
        const owner = committed.layout.windows.find((w) => w.id === windowId),
          moved = owner.panes
            .find((p) => p.id === paneId)
            ?.tabs.find((t) => t.id === tab.id);
        if (
          !moved ||
          moved.preview ||
          committed.layout.windows
            .find((w) => w.id === mainWindowId)
            .panes.some((p) => p.tabs.some((t) => t.id === tab.id))
        )
          throw new Error("Committed file ownership or pinning changed");
        window.workspaceTransferredDraft = transferred;
        return {
          projectId: document.projectId,
          workspaceId,
          mainWindowId,
          windowId,
          paneId,
          tabId: tab.id,
          documentId: document.id,
          layout: committed.layout,
          privateDraft,
          privateMarker,
          privatePath: document.path,
          draftBytes: new TextEncoder().encode(privateDraft).length,
          restoreCount,
          queuedCommands: receipts.length,
        };
      } finally {
        sourceChannel?.dispose();
        destinationChannel?.dispose();
        destination?.dispose();
        main.dispose();
      }
    }, document);
    const pending = requests.map((request) =>
      request.body ? JSON.parse(request.body) : request.path,
    );
    const captured = [];
    while (pending.length) {
      const value = pending.pop();
      if (typeof value === "string") captured.push(value);
      else if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === "object")
        pending.push(...Object.values(value));
    }
    assert.equal(
      captured.some((value) => value.includes(outcome.privateMarker)),
      false,
      "unsaved document text stays off workspace HTTP",
    );
    assert.equal(
      captured.some((value) => value.includes(outcome.privatePath)),
      false,
      "private document path stays off workspace HTTP",
    );
    assert.equal(
      captured.some((value) => value.includes(document.directory)),
      false,
      "private worker root stays off workspace HTTP",
    );
    assert.equal(outcome.restoreCount, 1);
    result.workspaceClient = {
      requestCount: requests.length,
      draftBytes: outcome.draftBytes,
      queuedCommands: outcome.queuedCommands,
      restoreCount: outcome.restoreCount,
    };
    result.steps.push(
      "existing workspace client seeds server-owned state, attaches renderer lifetime, serializes commands and pins the dirty file preview",
      "actual encrypted BroadcastChannel transfers editor text, undo history, selection and scroll before server ownership commits; HTTP contains no document path or draft",
    );
    return outcome;
  } finally {
    page.off("request", capture);
  }
}

export async function retainedWorkspaceClient({ page, workspace, result }) {
  const retained = await page.evaluate(async (workspace) => {
    const { workspaceLayoutTransport, connectWorkspaceCommands } =
      await import("/src/lib/api/workspace-layouts.ts");
    const { getClientSessionIdentitySnapshot } =
      await import("/src/lib/client-session.ts");
    const { workspaceRendererLifetime } =
      await import("/src/lib/workspace-renderer-lifetime.ts");
    const identity = getClientSessionIdentitySnapshot(),
      transport = workspaceLayoutTransport(
        workspace.projectId,
        workspace.workspaceId,
        identity,
      );
    const layout = await transport.read();
    if (
      !window.workspaceTransferredDraft?.dirty ||
      window.workspaceTransferredDraft.text !== workspace.privateDraft
    )
      throw new Error("Server restart lost the endpoint's unsaved draft");
    const previous = layout.windows.find((w) => w.id === workspace.windowId);
    const connection = await connectWorkspaceCommands(
      workspace.projectId,
      workspace.workspaceId,
      workspace.windowId,
      undefined,
      await workspaceRendererLifetime({
        serverId: identity.serverId,
        ownerId: identity.userId,
        workspaceId: workspace.workspaceId,
        windowId: workspace.windowId,
      }),
    );
    try {
      const current = connection.controller
        .getSnapshot()
        .authoritative.windows.find((w) => w.id === workspace.windowId);
      let error;
      try {
        await transport.execute({
          operationId: crypto.randomUUID(),
          projectId: workspace.projectId,
          workspaceId: workspace.workspaceId,
          windowId: workspace.windowId,
          attachmentGeneration: previous.attachmentGeneration,
          expectedRevision: layout.revision,
          action: { type: "home" },
        });
      } catch (cause) {
        error = {
          status: cause.status,
          code: cause.code,
          classification: transport.classify(cause),
        };
      }
      return {
        layout,
        previousGeneration: previous.attachmentGeneration,
        generation: current.attachmentGeneration,
        error,
        dirty: window.workspaceTransferredDraft.dirty,
      };
    } finally {
      connection.dispose();
    }
  }, workspace);
  assert.deepEqual(
    retained.layout,
    workspace.layout,
    "actual client reads the committed layout after server restart",
  );
  assert.equal(retained.generation, retained.previousGeneration + 1);
  assert.deepEqual(retained.error, {
    status: 409,
    code: "attachment",
    classification: "rejected",
  });
  assert.equal(retained.dirty, true);
  result.workspaceClient.restartRetained = true;
  result.steps.push(
    "server restart retains detached file ownership and the endpoint's unsaved draft; a fresh renderer attachment fences the old generation",
  );
}
