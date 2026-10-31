// Bounded legacy conversion only. Native request serving never loads this module.
import { readFile } from "node:fs/promises";
import PgDumpFactory from "./third-party/pglite-pg-dump/pg_dump.mjs";

class DumpFailure extends Error {
  #details;
  constructor(phase, details) {
    super("Legacy SQL export failed during " + phase);
    this.#details = details;
  }
  // SQL diagnostics may contain private values. Ordinary Error rendering must
  // not print them; a diagnostic caller must explicitly request them.
  privateDiagnostics() {
    return this.#details;
  }
}

export async function pgDumpRaw({ pg, args = [] }) {
  let path, module, primary, output;
  let status = 0;
  let stderr = "",
    stdout = "";
  let pending = new Uint8Array();
  const priorExitCode = process.exitCode;
  try {
    path = (await pg.query("SHOW SEARCH_PATH")).rows[0].search_path;
    module = await PgDumpFactory({
      wasmBinary: await readFile(
        new URL(
          "./pg_dump.wasm",
          import.meta.resolve("@electric-sql/pglite-tools/pg_dump"),
        ),
      ),
      noExitRuntime: false,
      print: (value) => (stdout += value + "\n"),
      printErr: (value) => (stderr += value + "\n"),
      onExit: (value) => (status = value),
      preRun: [
        (mod) => {
          mod.ENV.HOME = "/home/postgres";
          mod.ENV.USER = "postgres";
          mod.ENV.LOGNAME = "postgres";
          mod.onRuntimeInitialized = () => {
            const write = mod.addFunction((pointer, length) => {
              pg.execProtocolRawStream(
                mod.HEAPU8.subarray(pointer, pointer + length),
                {
                  onRawData: (bytes) => {
                    const next = new Uint8Array(
                      pending.byteLength + bytes.byteLength,
                    );
                    next.set(pending);
                    next.set(new Uint8Array(bytes), pending.byteLength);
                    pending = next;
                  },
                },
              );
              return length;
            }, "iii");
            const read = mod.addFunction((pointer, maximum) => {
              const length = Math.min(pending.byteLength, maximum);
              mod.HEAP8.set(pending.subarray(0, length), pointer);
              pending = pending.subarray(length);
              return length;
            }, "iii");
            mod._pgl_set_rw_cbs(read, write);
            mod.FS.chmod("/home/postgres/.pgpass", 0o600);
          };
        },
      ],
    });
    module.callMain([
      ...args,
      "-U",
      "postgres",
      "--inserts",
      "-j",
      "1",
      "-f",
      "/tmp/out.sql",
    ]);
    if (status !== 0)
      throw new DumpFailure("pg_dump (exit " + status + ")", {
        stderr,
        stdout,
      });
    output = module.FS.readFile("/tmp/out.sql", { encoding: "utf8" });
  } catch (error) {
    primary =
      error instanceof DumpFailure
        ? error
        : new DumpFailure(
            status === 0
              ? "pg_dump execution"
              : "pg_dump (exit " + status + ")",
            { stderr, stdout, cause: error },
          );
  } finally {
    try {
      if (path !== undefined) {
        await pg.exec("DEALLOCATE ALL");
        await pg.query("SELECT pg_catalog.set_config('search_path',$1,false)", [
          path,
        ]);
      }
    } catch (error) {
      primary ??= new DumpFailure("session cleanup", error);
    }
    process.exitCode = priorExitCode;
  }
  if (primary) throw primary;
  return output;
}

// Match only the generated command before SQL starts and its matching command
// at the end. Identical lines inside row values or function bodies stay intact.
export function removeDumpGuards(sql) {
  const leading = /^((?:--[^\n]*\n|\r?\n)*)\\restrict ([A-Za-z0-9]+)\r?\n/.exec(
    sql,
  );
  if (!leading) return { sql, guardsRemoved: 0 };
  const trailing = new RegExp(
    "\\r?\\n\\\\unrestrict " + leading[2] + "[\\t \\r\\n]*$",
  );
  const end = trailing.exec(sql);
  if (!end) return { sql, guardsRemoved: 0 };
  return {
    sql: leading[1] + sql.slice(leading[0].length, end.index) + "\n",
    guardsRemoved: 2,
  };
}
