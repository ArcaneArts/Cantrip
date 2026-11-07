import {
  targetStateSql,
  localOwner,
  otherOwner,
  literal,
  json,
  stamp,
} from "./project-target-state.mjs";
import { cantripOsSystemFixtures } from "./cantrip-os-system-fixtures.mjs";
import { cantripOsSystemManagementFixtures } from "./cantrip-os-system-management-fixtures.mjs";
import { cantripOsPackageFixtures } from "./cantrip-os-package-fixtures.mjs";
import { osOpaque } from "./cantrip-os-dispatch-fixtures.mjs";

export { localOwner, otherOwner, stamp };
export const id = (n) =>
  `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
export const projectIds = {
  github: id(1),
  folder: id(2),
  "local-git": id(3),
  other: id(4),
};
export const instance = id(10),
  workspace = id(11),
  foreignInstance = id(20),
  foreignWorkspace = id(21);
export const operation = (kind) =>
  id(
    30 +
      ["workspace", "power", "desktop", "package", "system", "backup"].indexOf(
        kind,
      ),
  );
export const foreignOperation = (kind) =>
  id(
    40 +
      ["workspace", "power", "desktop", "package", "system", "backup"].indexOf(
        kind,
      ),
  );
const insert = (table, fields) =>
  `INSERT INTO ${table}(${Object.keys(fields).join(",")},created_at,updated_at) VALUES(${Object.values(
    fields,
  )
    .map((v) => (v && typeof v === "object" ? json(v) : literal(v)))
    .join(",")},${literal(stamp)},${literal(stamp)})`;
export function readMethodSeed(owner = localOwner) {
  const sql = targetStateSql(owner, otherOwner, projectIds);
  // No connection is established; status routes must use the same offline path.
  sql.push("UPDATE workers SET last_seen_at='2026-10-25T00:00:00.123Z'");
  for (const [user, worker, i, w, op] of [
    [owner, "alpha", instance, workspace, operation],
    [
      otherOwner,
      "foreign",
      foreignInstance,
      foreignWorkspace,
      foreignOperation,
    ],
  ]) {
    sql.push(
      insert("cantrip_os_instances", {
        id: i,
        owner_id: user,
        worker_id: worker,
        guest_instance_id: i,
        attachment_generation: i,
        transport: { kind: "docker", container: "read-fixture" },
        name: "Read fixture 雪",
        status: "connected",
        runtime_generation: i,
      }),
    );
    sql.push(
      insert("cantrip_os_workspaces", {
        id: w,
        instance_id: i,
        guest_workspace_id: "work",
        uid: 20000,
        gid: 20000,
        home_guest_path: "/homes/work",
      }),
    );
    const common = {
      owner_id: user,
      worker_id: worker,
      instance_id: i,
      attachment_generation: i,
      state: "admitted",
      request: {},
      command: {},
    };
    sql.push(
      insert("cantrip_os_workspace_operations", {
        ...common,
        operation_id: op("workspace"),
        guest_workspace_id: "work",
        runtime_generation: i,
      }),
    );
    sql.push(
      insert("cantrip_os_power_operations", {
        ...common,
        operation_id: op("power"),
        target_generation: i,
        action: "stop",
      }),
    );
    sql.push(
      insert("cantrip_os_desktop_operations", {
        ...common,
        operation_id: op("desktop"),
        workspace_id: w,
        runtime_generation: i,
        target_generation: i,
        action: "stop",
      }),
    );
    const packageRequest =
      cantripOsPackageFixtures().cantripOsPackageCreateSchema[0];
    sql.push(
      insert("cantrip_os_package_operations", {
        ...common,
        operation_id: op("package"),
        target_generation: i,
        admission_epoch: 0,
        request: {
          ...packageRequest,
          operationId: op("package"),
          attachmentGeneration: i,
          targetGeneration: i,
        },
      }),
    );
    const systemCommand =
      cantripOsSystemFixtures().cantripOsSystemOperationCommandSchema[0];
    systemCommand.operationId = op("system");
    systemCommand.scope = {
      ...systemCommand.scope,
      ownerId: user,
      workerId: worker,
      instanceId: i,
      guestInstanceId: i,
      attachmentGeneration: i,
    };
    const systemRequest =
      cantripOsSystemManagementFixtures().cantripOsSystemCreateSchema[0];
    sql.push(
      insert("cantrip_os_system_operations", {
        ...common,
        operation_id: op("system"),
        target_generation: systemCommand.target.generation,
        fence_generation: i,
        admission_epoch: 0,
        command: systemCommand,
        request: {
          ...systemRequest,
          operationId: op("system"),
          attachmentGeneration: i,
        },
      }),
    );
    const { state, attachment_generation, ...backup } = common;
    sql.push(
      insert("cantrip_os_backup_operations", {
        ...backup,
        operation_id: op("backup"),
        workspace_id: w,
        action: "capture",
        request: {
          protectedRequest: {
            kind: "metadata",
            sequence: 1,
            envelope: osOpaque.envelope,
          },
        },
      }),
    );
  }
  // Deliberately reverse ID ordering within one millisecond. Cursor comparisons
  // must use the database timestamp, not a Date projection that loses precision.
  for (const kind of ["workspace", "package"]) {
    const table = `cantrip_os_${kind}_operations`;
    for (const [n, micros] of [
      [300, "123333"],
      [600, "123222"],
      [900, "123111"],
    ]) {
      sql.push(
        `INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},to_jsonb(o)||jsonb_build_object('operation_id',${literal(id(n))},'created_at','2026-10-25T00:00:00.${micros}Z','updated_at','2026-10-25T00:00:00.${micros}Z','state','failed'))).* FROM ${table} o WHERE operation_id=${literal(operation(kind))}`,
      );
    }
  }
  return sql;
}
export function readCases() {
  const cases = [];
  const add = (name, url, changes = false) =>
    cases.push({ name, url, changes });
  add("worktree catalog", `/api/projects/${projectIds.github}/worktrees`);
  add(
    "folder worktree catalog",
    `/api/projects/${projectIds.folder}/worktrees`,
  );
  cases.at(-1).headCapabilityDenied = true;
  add(
    "foreign worktree catalog",
    `/api/projects/${projectIds.other}/worktrees`,
  );
  add("missing worktree catalog", `/api/projects/${id(999)}/worktrees`);
  add("OS catalog", "/api/cantrip-os");
  for (const [name, p] of [
    ["owned", projectIds.github],
    ["foreign", projectIds.other],
    ["missing", id(999)],
  ])
    for (const suffix of ["bindings", "run-sources"])
      add(`${name} ${suffix}`, `/api/projects/${p}/cantrip-os/${suffix}`);
  for (const [name, i, w, op] of [
    ["owned", instance, workspace, operation],
    ["foreign", foreignInstance, foreignWorkspace, foreignOperation],
    ["missing", id(999), id(998), () => id(997)],
  ]) {
    const root = `/api/cantrip-os/${i}`;
    add(`${name} workspaces`, root + "/workspaces");
    for (const kind of ["workspace", "power", "package", "system"]) {
      const operations = root + `/${kind}-operations`;
      add(`${name} ${kind} list`, operations);
      add(`${name} ${kind} page`, operations + "?limit=1");
      add(
        `${name} ${kind} cursor page`,
        operations + "?limit=1&cursor=" + op(kind),
      );
      add(
        `${name} ${kind} unknown cursor`,
        operations + "?limit=1&cursor=" + id(999),
      );
      add(`${name} ${kind} invalid query`, operations + "?limit=0");
      add(`${name} ${kind} operation`, operations + "/" + op(kind));
      add(`${name} ${kind} missing operation`, operations + "/" + id(996));
    }
    // Status endpoints may record observations; they must preserve Source's effects.
    for (const suffix of ["power", "packages", "system"])
      add(
        `${name} ${suffix} status`,
        root + "/" + suffix,
        name === "owned" && suffix !== "power",
      );
    const desktop = `${root}/workspaces/${w}`;
    add(`${name} desktop status`, desktop + "/desktop");
    add(`${name} desktop list`, desktop + "/desktop-operations");
    add(
      `${name} desktop invalid query`,
      desktop + "/desktop-operations?limit=0",
    );
    add(
      `${name} desktop operation`,
      desktop + "/desktop-operations/" + op("desktop"),
    );
    add(
      `${name} desktop missing operation`,
      desktop + "/desktop-operations/" + id(996),
    );
  }
  for (const kind of ["workspace", "package"]) {
    const history = [id(300), id(600), id(900), operation(kind)];
    for (let index = 0; index <= history.length; index++) {
      const cursor = index ? `&cursor=${history[index - 1]}` : "";
      add(
        `owned ${kind} precise page ${index}`,
        `/api/cantrip-os/${instance}/${kind}-operations?limit=1${cursor}`,
      );
      cases.at(-1).expectedIds = history.slice(index, index + 1);
      cases.at(-1).expectedCursor =
        index < history.length - 1 ? history[index] : null;
    }
  }
  for (const suffix of ["backups", "backup-operations"]) {
    add(suffix, "/api/cantrip-os/" + suffix);
    add(suffix + " page", "/api/cantrip-os/" + suffix + "?limit=1");
    add(suffix + " invalid query", "/api/cantrip-os/" + suffix + "?limit=0");
  }
  for (const [name, op] of [
    ["owned", operation("backup")],
    ["foreign", foreignOperation("backup")],
    ["missing", id(995)],
  ])
    add(`${name} backup operation`, "/api/cantrip-os/backup-operations/" + op);
  return cases;
}
