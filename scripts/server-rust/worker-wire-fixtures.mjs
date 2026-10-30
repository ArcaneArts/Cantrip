// Accepted complete worker envelopes; the oracle parses each fixture against
// the current authoritative protocol before generating mutation cases.
import refinementFixtures from "./worker-wire-refinement-fixtures.json" with { type: "json" };
export const workerIngressFixtures = [
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "computer-use.approval.request",
      operationId: "00000000-0000-4000-8000-000000000001",
      request: {
        requestKey: "fixture",
        projectId: null,
        provenance: {
          chatId: null,
          threadId: "fixture",
          turnId: null,
          itemId: null,
          executionLaneId: null,
          workerId: "fixture",
        },
        classification: {
          kind: "commandExecution",
        },
        protectedPayload: {
          formatVersion: 1,
          keyRevision: 1,
          envelope: {
            version: 1,
            algorithm: "AES-256-GCM",
            keyRevision: 1,
            nonce: "AAAAAAAAAAAAAAAA",
            ciphertext: "00000000-0000-4000-8000-000000000001",
          },
        },
        expiresAt: null,
      },
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "computer-use.approval.terminal",
      chatId: "fixture",
      requestKey: "00000000-0000-4000-8000-000000000001",
      status: "expired",
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "computer-use.snapshot.chunk",
      operationId: "00000000-0000-4000-8000-000000000001",
      sequence: 0,
      protectedContent: {
        formatVersion: 1,
        domain: "client-control-content",
        keyRevision: 1,
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: "00000000-0000-4000-8000-000000000001",
        },
      },
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "workspace.repositories.discovery-progress",
      jobId: "00000000-0000-4000-8000-000000000001",
      attempt: 1,
      progress: {
        counts: {
          candidates: 0,
          collapsedRepositories: 0,
          rejectedRepositories: 0,
          scannedDirectories: 0,
          scannedEntries: 0,
          skippedSymlinks: 0,
          unreadableDirectories: 0,
        },
        diagnosticCode: null,
        truncated: false,
      },
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "project.replica.progress",
      jobId: "00000000-0000-4000-8000-000000000001",
      attempt: 1,
      progress: {
        stage: "queued",
        percent: 0,
      },
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "agent.activity",
      activity: {
        id: "fixture",
        status: "running",
        type: "instructionContext",
        provenance: "exact",
        text: null,
        sources: [],
        model: null,
        provider: null,
        reasoningEffort: null,
        collaborationMode: null,
        permissionProfile: null,
        runtimeVersion: null,
      },
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "agent.message",
      message: {
        id: "fixture",
        text: "fixture",
        phase: null,
      },
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "agent.inference-progress",
      progress: {
        kind: "clear",
        requestId: "fixture",
        cycle: 1,
        sequence: 0,
        observedAt: "2026-10-26T00:00:00.000Z",
      },
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "agent.protected-message",
      message: {
        id: "00000000-0000-4000-8000-000000000001",
        classification: {
          role: "user",
          mode: "default",
          attachmentIds: [],
        },
        protectedContent: {
          formatVersion: 1,
          keyRevision: 1,
          envelope: {
            version: 1,
            algorithm: "AES-256-GCM",
            keyRevision: 1,
            nonce: "AAAAAAAAAAAAAAAA",
            ciphertext: "00000000-0000-4000-8000-000000000001",
          },
        },
        reasoningEffort: null,
        idempotencyKey: "fixture",
      },
      telemetry: {
        kind: "message",
        phase: null,
        turnId: null,
      },
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "agent.protected-task-message",
      message: {
        id: "00000000-0000-4000-8000-000000000001",
        classification: {
          role: "user",
          mode: "default",
          attachmentIds: [],
        },
        protectedContent: {
          formatVersion: 1,
          keyRevision: 1,
          envelope: {
            version: 1,
            algorithm: "AES-256-GCM",
            keyRevision: 1,
            nonce: "AAAAAAAAAAAAAAAA",
            ciphertext: "00000000-0000-4000-8000-000000000001",
          },
        },
        reasoningEffort: null,
        idempotencyKey: "fixture",
      },
      telemetry: {
        kind: "message",
        phase: null,
        turnId: null,
      },
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "computer-use.activity",
      operationId: "00000000-0000-4000-8000-000000000001",
      event: {
        type: "agent.protected-message",
        message: {
          id: "00000000-0000-4000-8000-000000000001",
          classification: {
            role: "user",
            mode: "default",
            attachmentIds: [],
          },
          protectedContent: {
            formatVersion: 1,
            keyRevision: 1,
            envelope: {
              version: 1,
              algorithm: "AES-256-GCM",
              keyRevision: 1,
              nonce: "AAAAAAAAAAAAAAAA",
              ciphertext: "00000000-0000-4000-8000-000000000001",
            },
          },
          reasoningEffort: null,
          idempotencyKey: "fixture",
        },
        telemetry: {
          kind: "activity",
          activityType: "computerUse",
          turnId: null,
        },
      },
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "terminal.ready",
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "agent.checkpoint",
      turnId: "fixture",
      text: "fixture",
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "agent.plan.updated",
      turnId: "fixture",
      explanation: null,
      steps: [],
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "agent.plan.question",
      question: {
        id: "fixture",
        threadId: "fixture",
        turnId: "fixture",
        itemId: "fixture",
        questions: [
          {
            id: "fixture",
            header: "fixture",
            question: "fixture",
            isOther: false,
            isSecret: false,
            options: null,
          },
        ],
        createdAt: "2026-10-26T00:00:00.000Z",
      },
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "agent.plan.question-resolved",
      questionId: "fixture",
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "agent.plan.protected",
      turnId: null,
      state: {
        classification: {
          hasQuestion: false,
        },
        protectedContent: {
          formatVersion: 1,
          keyRevision: 1,
          envelope: {
            version: 1,
            algorithm: "AES-256-GCM",
            keyRevision: 1,
            nonce: "AAAAAAAAAAAAAAAA",
            ciphertext: "00000000-0000-4000-8000-000000000001",
          },
        },
      },
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "agent.interaction.requested",
      request: {
        requestKey: "fixture",
        threadId: "fixture",
        turnId: null,
        itemId: null,
        payload: {
          kind: "commandExecution",
          startedAtMs: 0,
          approvalId: null,
          environmentId: null,
          reason: null,
          command: null,
          cwd: null,
          networkApprovalContext: null,
          additionalPermissions: null,
          proposedExecpolicyAmendment: null,
          proposedNetworkPolicyAmendments: null,
          availableDecisions: null,
        },
        expiresAt: "2026-10-26T00:00:00.000Z",
      },
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "agent.interaction.requested.protected",
      request: {
        requestKey: "fixture",
        threadId: "fixture",
        turnId: null,
        itemId: null,
        classification: {
          kind: "commandExecution",
        },
        protectedPayload: {
          formatVersion: 1,
          keyRevision: 1,
          envelope: {
            version: 1,
            algorithm: "AES-256-GCM",
            keyRevision: 1,
            nonce: "AAAAAAAAAAAAAAAA",
            ciphertext: "00000000-0000-4000-8000-000000000001",
          },
        },
        expiresAt: "2026-10-26T00:00:00.000Z",
      },
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "agent.interaction.cleared",
      requestKey: "fixture",
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "agent.interaction.expired",
      requestKey: "fixture",
    },
  },
  {
    kind: "event",
    requestId: "fixture-request",
    event: {
      type: "terminal.output",
      operationId: "fixture",
      sequence: 0,
      protectedData: {
        formatVersion: 1,
        keyRevision: 1,
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: "00000000-0000-4000-8000-000000000001",
        },
      },
    },
  },
  {
    kind: "notification",
    notification: {
      type: "computer-use.approval.terminal",
      chatId: "fixture",
      requestKey: "00000000-0000-4000-8000-000000000001",
      status: "expired",
    },
  },
  {
    kind: "notification",
    notification: {
      type: "worker-link.peer.signal",
      envelope: {
        peerSessionId: "00000000-0000-4000-8000-000000000001",
        sessionId: "00000000-0000-4000-8000-000000000001",
        routeGeneration: 1,
        route: "lan",
        sender: "worker",
        signalSequence: 0,
        signal: {
          type: "offer",
          sdp: "fixture",
        },
      },
    },
  },
  {
    kind: "notification",
    notification: {
      type: "worker-link.peer.candidates",
      advertisement: {
        peerSessionId: "00000000-0000-4000-8000-000000000001",
        sessionId: "00000000-0000-4000-8000-000000000001",
        routeGeneration: 1,
        route: "lan",
        advertisementSequence: 0,
        candidates: [],
        complete: true,
      },
    },
  },
  {
    kind: "notification",
    notification: {
      type: "chat.turn.outcome",
      chatId: "fixture",
      clientMessageId: "fixture",
      executionLaneId: "fixture",
      contextKind: "project",
      worktreeId: "fixture-worktree",
      scratchRootId: null,
      outcome: {
        ok: true,
        result: {
          threadId: "fixture",
          text: "fixture",
          status: "completed",
        },
      },
    },
  },
  {
    kind: "notification",
    notification: {
      type: "chat.thread.changed",
      threadId: "fixture",
      revision: 1,
      changes: ["turn"],
    },
  },
  {
    kind: "notification",
    notification: {
      type: "terminal.runtime.observed",
      terminalId: "fixture",
      workerProcessGeneration: "fixture",
      status: "exited",
      exitCode: 0,
      signal: null,
    },
  },
  {
    kind: "notification",
    notification: {
      records: [],
      nextCursor: 0,
      oldestCursor: null,
      latestCursor: 0,
      truncated: false,
      type: "diagnostics.logs.observed",
      subscriptionId: "00000000-0000-4000-8000-000000000001",
    },
  },
  {
    kind: "notification",
    notification: {
      type: "worktree.inventory.observed",
      sourcePath: "fixture",
      inventory: {
        sourcePath: "fixture",
        primaryPath: "fixture",
        gitCommonDir: "fixture",
        managedRoot: "fixture",
        repositoryFingerprint:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        worktrees: [],
      },
    },
  },
  {
    kind: "notification",
    notification: {
      type: "worktree.status.observed",
      sourcePath: "fixture",
      worktreePath: "fixture",
      result: {
        worktree: {
          path: "fixture",
          head: null,
          branch: null,
          detached: false,
          isPrimary: false,
          managed: false,
          locked: false,
          lockReason: null,
          prunable: false,
          pruneReason: null,
          missing: false,
        },
        status: {
          branch: "fixture",
          head: null,
          upstream: null,
          ahead: 0,
          behind: 0,
          files: [],
          branches: [],
        },
      },
    },
  },
  {
    kind: "notification",
    notification: {
      type: "worktree.filesystem.changed",
      sourcePath: "fixture",
      worktreePath: "fixture",
    },
  },
  {
    kind: "notification",
    notification: {
      type: "git.operation.observed",
      projectId: "00000000-0000-4000-8000-000000000001",
      worktreeId: "fixture",
      operationId: "00000000-0000-4000-8000-000000000001",
      sourcePath: "fixture",
      worktreePath: "fixture",
      fingerprint:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      observedAt: "2026-10-26T00:00:00.000Z",
      state: {
        state: "queued",
        currentHead:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        currentStep: 0,
        totalSteps: 1,
        pendingCommitCount: 0,
        conflictedPathCount: 0,
        pausedAction: null,
      },
      conflicts: {
        files: [],
        truncated: false,
      },
    },
  },
  {
    kind: "notification",
    notification: {
      type: "codegraph.status.observed",
      status: {
        projectId: "00000000-0000-4000-8000-000000000001",
        worktreeId: "fixture",
        state: "degraded",
        lastIndexedAt: null,
        lastSuccessfulSyncAt: null,
        fileCount: null,
        nodeCount: null,
        edgeCount: null,
        pendingChanges: null,
        statusMessage: null,
        job: null,
      },
    },
  },
  {
    kind: "notification",
    notification: {
      type: "project.run-configuration-runtime.observed",
      observation: {
        runtimeId: "00000000-0000-4000-8000-000000000001",
        projectId: "00000000-0000-4000-8000-000000000001",
        configurationId: "00000000-0000-4000-8000-000000000001",
        worktreeId: "00000000-0000-4000-8000-000000000001",
        workerId: "fixture",
        definitionRevision:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        codexEnvironmentRevision: null,
        generation: 0,
        operationId: "00000000-0000-4000-8000-000000000001",
        terminalId: null,
        state: "idle",
        startedAt: null,
        endedAt: "2026-10-26T00:00:00.000Z",
        exitCode: null,
        signal: null,
        failure: null,
      },
    },
  },
  {
    kind: "notification",
    notification: {
      type: "project.run-configuration-definitions.changed",
      projectId: "00000000-0000-4000-8000-000000000001",
      sourcePath: "fixture",
      change: {
        kind: "created",
        id: null,
        relativePath: null,
        revision: null,
      },
    },
  },
  {
    kind: "notification",
    notification: {
      type: "provider.auth.status.observed",
      observationId: "00000000-0000-4000-8000-000000000001",
      providerId: "fixture",
      providerAccountId: "fixture",
      providerKind: "chatgpt",
      sequence: 1,
      observedAt: "2026-10-26T00:00:00.000Z",
      expiresAt: "2026-10-26T00:00:00.000Z",
      status: {
        state: "pending",
        authMode: null,
        email: null,
        planType: null,
        weeklyUsage: null,
        failureCode: null,
      },
    },
  },
  {
    kind: "response",
    requestId: "fixture-request",
    ok: true,
    result: null,
  },
  {
    kind: "response",
    requestId: "fixture-request",
    ok: false,
    error: { message: "Fixture command failed.", code: "fixture-failure" },
  },
  ...refinementFixtures.fixtures,
];
