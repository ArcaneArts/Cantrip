import { TaskSchedulingConflictError } from "../../cantrip_server/src/db/task-scheduling.ts";
import * as protocol from "../../packages/protocol/dist/task-scheduling.js";
export async function taskWorkersFixture(repository, input) {
  const task = repository.taskScheduling;
  let data = input.input;
  if (!input.raw) {
    const schema = {
      create: "taskWorkerCreateSchema",
      update: "taskWorkerUpdateSchema",
      order: "taskWorkerOrderUpdateSchema",
      pause: "projectTaskPauseUpdateSchema",
    }[input.action];
    if (schema) data = protocol[schema].parse(data);
  }
  try {
    let value;
    switch (input.action) {
      case "list":
        value = await task.listTaskWorkers(input.owner);
        break;
      case "create":
        value = await task.createTaskWorker(input.owner, data);
        break;
      case "update":
        value = await task.updateTaskWorker(input.owner, input.worker, data);
        break;
      case "delete":
        value = await task.deleteTaskWorker(
          input.owner,
          input.worker,
          input.rowVersion,
        );
        break;
      case "order":
        value = await task.reorderTaskWorkers(input.owner, data);
        break;
      case "get-pause":
        value = await task.getProjectTaskPauseState(input.owner, input.project);
        break;
      case "pause":
        value = await task.setProjectTaskPauseState(
          input.owner,
          input.project,
          data,
        );
        break;
      default:
        throw new Error("Task Worker fixture action");
    }
    return { value };
  } catch (error) {
    if (!(error instanceof TaskSchedulingConflictError)) throw error;
    return { error: { code: error.code, message: error.message } };
  }
}
