/** Missing setup is not a failed provider or native session. */
export class ModelSelectionRequiredError extends Error {
  constructor() {
    super("Choose a model or configure a default model in Settings.");
    this.name = "ModelSelectionRequiredError";
  }
}
