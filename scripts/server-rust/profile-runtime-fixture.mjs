// Production runtime changes with offline, data-preserving profile conversion.
// The full worker, native execution and browser client remain outside this class.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { SingleProductFixture } from "./single-product-fixture.mjs";
import { snapshot, assertImportedProfile } from "./profile-snapshots.mjs";

const execute = promisify(execFile);
const { PGlite } = createRequire(
  import.meta.resolve("@electric-sql/pglite-tools/pg_dump"),
)("@electric-sql/pglite");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export class ProfileRuntimeFixture extends SingleProductFixture {
  constructor(options) {
    super(options);
    this.nativeDatabaseMode = options.databaseMode;
    this.nativeExecutable = options.executable;
    this.nativeAssets = path.resolve(options.nativeAssets);
    this.converter = path.join(
      path.resolve(options.profileConverter),
      "dist/index.mjs",
    );
    this.snapshotProbe = path.resolve(options.profileSnapshotProbe);
    this.createProfileDatabase = options.createProfileDatabase;
    this.samePostgres = options.samePostgres ?? false;
    this.transferDirectory = path.join(
      options.root,
      "profile-runtime-transfers",
      options.kind,
    );
    this.transfers = [];
  }
  async start(options) {
    await super.start(options);
    const response = await fetch(this.server.origin + "/api/bootstrap", {
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200);
    const bootstrap = await response.json();
    this.profileServerIdentity ??= bootstrap.server.id;
    assert.equal(
      bootstrap.server.id,
      this.profileServerIdentity,
      "the replacement serves the original durable server identity",
    );
    this.generations.at(-1).server = {
      id: bootstrap.server.id,
      version: bootstrap.server.version.version,
    };
  }
  async run(command, args, environment) {
    const result = await execute(command, args, {
      env: environment,
      maxBuffer: 32 * 1024 * 1024,
    });
    return {
      ...result,
      events: result.stdout.split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      }),
    };
  }
  async native(data, mode, args, environment) {
    const manifest = JSON.parse(
      await readFile(
        path.join(this.nativeAssets, "native-server.json"),
        "utf8",
      ),
    );
    return this.run(
      this.nativeExecutable,
      [
        "--bundled-pglite-runtime-dir",
        path.join(this.nativeAssets, "pglite"),
        "--bundled-postgres-bin-dir",
        path.join(this.nativeAssets, manifest.postgres.bin),
        "--data-dir",
        data,
        "--database",
        mode,
        "--shutdown-on-stdin-close",
        ...args,
      ],
      environment,
    );
  }
  async databaseSnapshot(kind, mode, data, environment) {
    if (kind === "node" && mode === "pglite") {
      const database = await PGlite.create(path.join(data, "server-db"));
      try {
        return await snapshot(database);
      } finally {
        await database.close();
      }
    }
    const directory =
      mode === "pglite"
        ? path.join(data, "server-db")
        : mode === "bundled-postgres"
          ? path.join(data, "postgres")
          : data;
    const result = await this.run(
      this.snapshotProbe,
      ["--directory", directory, "--database", mode, "--no-migrate"],
      {
        ...environment,
        CANTRIP_TEST_POSTGRES_BIN_DIR:
          process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
      },
    );
    const value = result.events.find((e) => e.tables && e.sequences);
    assert.ok(value, "the native probe returns the actual stopped database");
    assert.equal(value.migrationsApplied, 0);
    return {
      tables: value.tables,
      sequences: value.sequences,
      probe: value.probe,
    };
  }
  async verifyFiles(data, manifest, { allowLogAppend = false } = {}) {
    const logPrefixes = [];
    for (const entry of manifest.files) {
      const file = path.join(data, entry.path);
      if (entry.directory) assert.equal((await stat(file)).isDirectory(), true);
      else {
        const bytes = await readFile(file);
        const appendableLog =
          allowLogAppend &&
          entry.path.startsWith("logs/") &&
          entry.path.endsWith(".jsonl");
        if (appendableLog)
          assert.ok(
            bytes.length >= entry.bytes,
            entry.path + " retains every original log byte",
          );
        const original = appendableLog ? bytes.subarray(0, entry.bytes) : bytes;
        assert.equal(original.length, entry.bytes, entry.path + " length");
        assert.equal(hash(original), entry.sha256, entry.path + " bytes");
        if (appendableLog)
          logPrefixes.push({
            path: entry.path,
            originalBytes: entry.bytes,
            currentBytes: bytes.length,
            originalSha256: entry.sha256,
          });
      }
    }
    return logPrefixes;
  }
  async restart({ crash = false } = {}) {
    const server = this.server;
    const sourceKind = this.kind;
    const sourceMode =
      sourceKind === "node"
        ? this.environment.DATABASE_URL
          ? "postgres"
          : "pglite"
        : this.databaseMode;
    const sourceData = this.environment.CANTRIP_DATA_DIR;
    const sourceEnvironment = { ...this.environment };
    const targetKind = sourceKind === "rust" ? "node" : "rust";
    const samePostgres = this.samePostgres && sourceMode === "postgres";
    const targetMode = samePostgres
      ? "postgres"
      : targetKind === "node"
        ? "pglite"
        : this.nativeDatabaseMode;
    const directory = path.join(
      this.transferDirectory,
      String(this.transfers.length + 1),
    );
    await mkdir(directory, { recursive: true });
    const transfer = {
      sourceKind,
      sourceMode,
      sourceData,
      targetKind,
      targetMode,
      samePostgres,
      directory,
      before: {
        pid: server.child.pid,
        origin: server.origin,
        instanceId: this.environment.CANTRIP_SERVER_INSTANCE_ID,
      },
    };
    this.transfers.push(transfer);
    const save = (name, value) =>
      writeFile(
        path.join(directory, name + ".json"),
        JSON.stringify(value, null, 2) + "\n",
        { mode: 0o600 },
      );
    try {
      if (crash) {
        const completion = once(server.child, "close");
        assert.equal(server.child.kill("SIGKILL"), true);
        const [code, signal] = await completion;
        assert.equal(code, null);
        assert.equal(signal, "SIGKILL");
        this.server = undefined;
        this.recordExit(server, { intentionalInterruption: "SIGKILL" });
      } else await this.close();
      transfer.exit = {
        code: server.child.exitCode,
        signal: server.child.signalCode,
      };
      const expected = await this.databaseSnapshot(
        sourceKind,
        sourceMode,
        sourceData,
        sourceEnvironment,
      );
      await save("source-database", expected);
      const bundle = path.join(directory, "bundle");
      if (sourceKind === "node" && sourceMode === "pglite") {
        transfer.export = await this.run(
          process.execPath,
          [this.converter, sourceData, bundle, this.nativeExecutable],
          sourceEnvironment,
        );
      } else
        transfer.export = await this.native(
          sourceData,
          sourceMode,
          ["--migrate-only", "--export-profile", bundle],
          sourceEnvironment,
        );
      const manifest = JSON.parse(
        await readFile(path.join(bundle, "manifest.json"), "utf8"),
      );
      assert.deepEqual(
        await this.databaseSnapshot(
          sourceKind,
          sourceMode,
          sourceData,
          sourceEnvironment,
        ),
        expected,
        "export leaves every source table and sequence unchanged",
      );
      const targetData = samePostgres
        ? sourceData
        : path.join(directory, "target-profile");
      const environment = {
        ...sourceEnvironment,
        CANTRIP_DATA_DIR: targetData,
        CANTRIP_SERVER_INSTANCE_ID: randomUUID(),
      };
      if (!samePostgres) {
        delete environment.DATABASE_URL;
        if (targetMode === "postgres")
          environment.DATABASE_URL = await this.createProfileDatabase();
      } else {
        transfer.sameDatabaseUrl =
          environment.DATABASE_URL === sourceEnvironment.DATABASE_URL;
        transfer.databaseUrlSha256 = hash(
          Buffer.from(environment.DATABASE_URL),
        );
        assert.equal(transfer.sameDatabaseUrl, true);
      }
      const before = Date.now();
      if (samePostgres) transfer.import = null;
      else if (targetKind === "node")
        transfer.import = await this.run(
          process.execPath,
          [
            this.converter,
            "--restore",
            bundle,
            targetData,
            this.nativeExecutable,
          ],
          environment,
        );
      else
        transfer.import = await this.native(
          targetData,
          targetMode,
          ["--migrate-only", "--restore-profile", bundle],
          environment,
        );
      const after = Date.now();
      const actual = await this.databaseSnapshot(
        targetKind,
        targetMode,
        targetData,
        environment,
      );
      await save("target-database", actual);
      if (samePostgres || targetKind === "node")
        assert.deepEqual(
          actual,
          expected,
          "reverse conversion preserves every committed row and sequence",
        );
      else {
        const receipt = transfer.import.events.find(
          (e) => e.event === "profile.restore.completed",
        )?.receipt;
        assert.ok(receipt);
        assert.equal(receipt.databaseMode, targetMode);
        assertImportedProfile(
          expected,
          actual,
          receipt,
          manifest,
          before,
          after,
        );
      }
      await this.verifyFiles(targetData, manifest);
      Object.assign(transfer, {
        targetData,
        tables: Object.keys(expected.tables).length,
        sequences: Object.keys(expected.sequences).length,
        allRowsAndSequencesPreserved: true,
        profileFilesPreserved: true,
      });
      this.kind = targetKind;
      this.databaseMode = targetMode;
      this.environment = environment;
      await this.start({ port: Number(new URL(transfer.before.origin).port) });
      assert.equal(this.server.origin, transfer.before.origin);
      // The running server appends startup records to its existing JSONL log.
      // Every original byte must remain as an exact prefix. Other files retain
      // their complete checksums; before startup the logs are also byte-exact.
      if (samePostgres)
        transfer.logPrefixes = await this.verifyFiles(targetData, manifest, {
          allowLogAppend: true,
        });
      transfer.after = {
        pid: this.server.child.pid,
        origin: this.server.origin,
        instanceId: this.environment.CANTRIP_SERVER_INSTANCE_ID,
      };
      transfer.status = "passed";
      return transfer;
    } catch (error) {
      transfer.status = "failed";
      transfer.failure = {
        message: error.message,
        stack: error.stack,
        stdout: error.stdout,
        stderr: error.stderr,
      };
      throw error;
    } finally {
      await save("transfer", transfer);
    }
  }
}
