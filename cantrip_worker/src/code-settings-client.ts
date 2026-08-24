import {
  codeSettingsRevisionConflictSchema,
  codeSettingsStoredProfileSchema,
  codeSettingsUploadSchema,
  type CodeSettingsStoredProfile,
  type CodeSettingsUpload,
} from "@cantrip/protocol/code-settings";

export class CodeSettingsClientError extends Error {
  constructor(
    readonly code: "offline" | "rejected" | "invalid-response",
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "CodeSettingsClientError";
  }
}

export class CodeSettingsClientConflictError extends Error {
  constructor(readonly currentRevision: number | null) {
    super("Global Code settings changed during synchronization.");
    this.name = "CodeSettingsClientConflictError";
  }
}

export class CodeSettingsClient {
  constructor(
    private readonly input: {
      credential: () => string;
      fetch?: typeof fetch;
      profileId: string;
      serverUrl: string;
      timeoutMs?: number;
      workerId: string;
    },
  ) {}

  async get(): Promise<CodeSettingsStoredProfile | null> {
    const response = await this.request("GET");
    if (response.status === 404) return null;
    if (!response.ok) throw this.rejected(response.status);
    try {
      return codeSettingsStoredProfileSchema.parse(await response.json());
    } catch {
      throw new CodeSettingsClientError(
        "invalid-response",
        "Cantrip Server returned invalid Code settings metadata.",
        response.status,
      );
    }
  }

  async put(upload: CodeSettingsUpload): Promise<CodeSettingsStoredProfile> {
    const response = await this.request(
      "PUT",
      JSON.stringify(codeSettingsUploadSchema.parse(upload)),
    );
    if (response.status === 409) {
      try {
        const conflict = codeSettingsRevisionConflictSchema.parse(
          await response.json(),
        );
        throw new CodeSettingsClientConflictError(conflict.currentRevision);
      } catch (error) {
        if (error instanceof CodeSettingsClientConflictError) throw error;
        throw new CodeSettingsClientError(
          "invalid-response",
          "Cantrip Server returned invalid Code settings conflict metadata.",
          response.status,
        );
      }
    }
    if (!response.ok) throw this.rejected(response.status);
    try {
      return codeSettingsStoredProfileSchema.parse(await response.json());
    } catch {
      throw new CodeSettingsClientError(
        "invalid-response",
        "Cantrip Server returned invalid Code settings metadata.",
        response.status,
      );
    }
  }

  private async request(
    method: "GET" | "PUT",
    body?: string,
  ): Promise<Response> {
    const fetcher = this.input.fetch ?? fetch;
    try {
      return await fetcher(
        `${this.input.serverUrl}/api/internal/workers/${encodeURIComponent(this.input.workerId)}/code-settings/profiles/${encodeURIComponent(this.input.profileId)}`,
        {
          body,
          headers: {
            authorization: `Bearer ${this.input.credential()}`,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          method,
          signal: AbortSignal.timeout(this.input.timeoutMs ?? 15_000),
        },
      );
    } catch {
      throw new CodeSettingsClientError(
        "offline",
        "Cantrip Server is unavailable for Code settings synchronization.",
      );
    }
  }

  private rejected(status: number): CodeSettingsClientError {
    return new CodeSettingsClientError(
      "rejected",
      `Cantrip Server rejected Code settings synchronization with HTTP ${status}.`,
      status,
    );
  }
}
