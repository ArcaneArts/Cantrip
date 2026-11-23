export function settingsOperationsWireFixtures() {
  const response = {
    ok: true,
    stage: "completed",
    message: " Connected. ",
    workerId: "worker",
    modelName: "glm-5.3",
    durationMs: 0,
  };
  return {
    desktopUpdateActiveWorkSummarySchema: [
      {
        activeChats: 0,
        queuedPrompts: 1,
        terminalServices: 2,
        backgroundJobs: 3,
      },
      {
        activeChats: 4294967295,
        queuedPrompts: 4294967295,
        terminalServices: 4294967295,
        backgroundJobs: 4294967295,
      },
    ],
    providerConnectionTestResultSchema: [
      response,
      {
        ...response,
        ok: false,
        stage: "worker-placement",
        workerId: null,
        modelName: null,
      },
    ],
    workerProviderConnectionTestResultSchema: [
      { accepted: true, durationMs: 0 },
      { accepted: true, durationMs: 9007199254740991, future: "stripped" },
    ],
  };
}
