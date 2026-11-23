// Invoke the current facade and its actual layout collaborator.
export async function resourceStateFixture(repository, request) {
  const { owner, project = "github", chat = "chat" } = request;
  switch (request.op) {
    case "resource-state-model-default": {
      const value = await repository.getModelReasoningDefault(
        owner,
        request.model,
      );
      return { present: value !== undefined, value: value ?? null };
    }
    case "resource-state-next-position":
      return repository.tabLayouts.nextProjectTabPosition(project);
    case "resource-state-reorder":
      return repository.reorderProjects(owner, request.input);
    case "resource-state-reorder-layout":
      return repository.tabLayouts.reorderProjects(owner, request.input);
    case "resource-state-pause":
      return repository.setChatAutomationPaused(owner, chat, request.paused);
    case "resource-state-status":
      await repository.setChatStatus(chat, request.status);
      return null;
    case "resource-state-create-task":
      return repository.createTask(
        owner,
        project,
        request.input,
        Array.isArray(request.connected)
          ? (worker) => request.connected.includes(worker)
          : undefined,
      );
    case "resource-state-surfaces":
      return repository.listRemoteSurfaces(owner, project);
    case "resource-state-surface-create":
      return repository.createRemoteSurface(owner, project, request.input);
    case "resource-state-surface-update":
      return repository.updateRemoteSurface(
        owner,
        request.surface,
        request.input,
      );
    case "resource-state-surface-delete":
      return repository.deleteRemoteSurface(owner, request.surface);
    case "resource-state-desktops":
      return repository.listRemoteDesktops(owner, project);
    case "resource-state-desktop":
      return repository.getRemoteDesktop(owner, request.surface);
    case "resource-state-desktop-create": {
      const input = request.input;
      return repository.createRemoteDesktop(
        owner,
        project,
        input.id,
        input.titleProtection,
        request.worker,
        input.stateProtection,
        input.paneId,
        input.targetRegion,
      );
    }
    default:
      throw Error("Unknown resource state fixture operation");
  }
}
