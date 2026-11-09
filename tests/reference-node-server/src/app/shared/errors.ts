export class SkillSettingsRequestError extends Error {
  readonly statusCode: 404 | 409 | 503;

  constructor(statusCode: 404 | 409 | 503, message: string) {
    super(message);
    this.name = "SkillSettingsRequestError";
    this.statusCode = statusCode;
  }
}

export class ScheduleDispatchLeaseLostError extends Error {}

export class ProviderAccountReconnectRequiredError extends Error {
  constructor() {
    super(
      "The original worker must reconnect before this provider account can be signed out globally.",
    );
    this.name = "ProviderAccountReconnectRequiredError";
  }
}
