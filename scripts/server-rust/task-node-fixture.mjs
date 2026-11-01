import { TaskConflictError } from "../../cantrip_server/src/db/tasks.ts";
import { TaskStateTransitionError } from "../../cantrip_server/src/tasks/state.ts";
export async function taskFixture(repository, input) {
  const task = repository.tasks,
    { owner, chat, operation } = input;
  try {
    let value;
    switch (input.action) {
      case "get":
        value = await task.get(owner, chat);
        break;
      case "list":
        value = await task.list(owner, input.project);
        break;
      case "rounds":
        value = await task.listRounds(owner, chat);
        break;
      case "lookup":
        value = await task.getOperationContext(owner, chat, input.lookup);
        break;
      case "draft":
        value = await task.updateDraft(owner, chat, input.input);
        break;
      case "plan":
        value = await task.updatePlan(owner, chat, input.input);
        break;
      case "begin":
        value = await task.beginOperation(owner, chat, input.input);
        break;
      case "complete":
        value = await task.completeOperation(
          owner,
          chat,
          operation,
          input.input,
          input.turn ?? null,
        );
        break;
      case "finalize":
        value = await task.completeFinalizationOperation(
          owner,
          chat,
          operation,
        );
        break;
      case "fail":
        value = await task.failOperation(owner, chat, operation, input.failure);
        break;
      case "sync":
        value = await task.syncImplementationState(owner, chat, input.input);
        break;
      case "attach":
        value = await task.attachOperationExecution(
          owner,
          chat,
          operation,
          input.input,
        );
        break;
      case "assistant":
        value = await task.attachOperationAssistantMessage(
          owner,
          chat,
          operation,
          input.message,
        );
        break;
      case "reconcile":
        value = await task.reconcileInterruptedOperations();
        break;
      case "resume":
        value = await task.resumeFinalizationGoalLaunch(
          owner,
          chat,
          input.rowVersion,
        );
        break;
      case "delete":
        value = await task.deleteOwned(owner, chat);
        break;
      default:
        throw new Error("Unknown Task fixture action");
    }
    return { value };
  } catch (error) {
    if (
      !(error instanceof TaskConflictError) &&
      !(error instanceof TaskStateTransitionError)
    )
      throw error;
    return {
      error: {
        code: error.code ?? null,
        stateTransition:
          error instanceof TaskStateTransitionError
            ? { from: error.from, to: error.to }
            : null,
        message: error.message,
      },
    };
  }
}
