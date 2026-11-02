import {
  associateTaskPullRequests,
  taskAdvisoryWarnings,
} from "../../cantrip_server/src/tasks/dashboard.ts";
import { taskDashboardCases } from "./task-dashboard-fixtures.mjs";

const cases = [...taskDashboardCases()].map((input) => {
  const pullRequests = associateTaskPullRequests(input);
  return {
    input,
    expected: {
      pullRequests,
      warnings: taskAdvisoryWarnings({ ...input, pullRequests }),
    },
  };
});
console.log(JSON.stringify(cases));
