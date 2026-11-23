import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const image = process.env.CANTRIP_OS_IDENTITY_TEST_IMAGE;
const docker = async (...args) =>
  (await execute("docker", args, { maxBuffer: 1024 * 1024 })).stdout.trim();

test(
  "fresh machine identity, retained reboot and offline clone initialization",
  {
    skip: !image,
    timeout: 120_000,
  },
  async (t) => {
    const prefix = `cantrip-identity-${randomUUID()}`;
    const owned = [];
    let passed = false;
    t.after(async () => {
      const cleanup = await Promise.allSettled(
        owned.map(async (name) => {
          if (!passed) {
            try {
              t.diagnostic(
                `${name}: ${await docker("logs", "--tail", "15", name)}`,
              );
            } catch {
              /* The primary operation retains its actual error. */
            }
          }
          try {
            await docker("rm", "-fv", name);
          } catch (error) {
            if (!error.stderr?.includes("No such container")) throw error;
          }
        }),
      );
      const failure = cleanup.find((entry) => entry.status === "rejected");
      if (failure) throw failure.reason;
    });
    const run = async (suffix, script) => {
      const name = `${prefix}-${suffix}`;
      const prepared = script?.replace(
        "exec sleep infinity",
        "printf ready > /run/cantrip-identity-test-ready\nexec sleep infinity",
      );
      owned.push(name);
      await docker(
        "run",
        "-d",
        "--name",
        name,
        "--shm-size=256m",
        ...(script ? ["--entrypoint", "sh"] : []),
        image,
        ...(prepared ? ["-c", prepared] : []),
      );
      // Seeded clone scenarios briefly contain the original ID. Read the
      // command's completion receipt before asserting its resulting identity.
      if (prepared) {
        for (let attempt = 0; ; attempt++) {
          try {
            assert.equal(
              await docker(
                "exec",
                name,
                "cat",
                "/run/cantrip-identity-test-ready",
              ),
              "ready",
            );
            break;
          } catch (error) {
            if (attempt === 49) throw error;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      }
      return name;
    };
    const identity = async (name) => {
      let result;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          result = await docker(
            "exec",
            name,
            "dbus-uuidgen",
            "--get=/etc/machine-id",
          );
          break;
        } catch (error) {
          if (attempt === 49) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      assert.match(result, /^[a-f0-9]{32}$/);
      assert.equal(
        await docker(
          "exec",
          name,
          "dbus-uuidgen",
          "--get=/var/lib/dbus/machine-id",
        ),
        result,
      );
      return result;
    };

    const template = JSON.parse(
      await docker(
        "run",
        "--rm",
        "--entrypoint",
        "python3",
        image,
        "-c",
        "import json; from pathlib import Path; print(json.dumps([Path(p).exists() for p in ['/etc/machine-id','/var/lib/dbus/machine-id']]))",
      ),
    );
    assert.deepEqual(template, [false, false]);
    const first = await run("first"),
      second = await run("second");
    const firstId = await identity(first),
      secondId = await identity(second);
    assert.notEqual(firstId, secondId);
    await docker("restart", first);
    assert.equal(await identity(first), firstId);

    const legacyId = "11223344556677889900aabbccddeeff";
    const legacy = await run(
      "legacy",
      `rm -f /etc/machine-id /var/lib/dbus/machine-id
printf '%s\\n' '${legacyId}' > /var/lib/dbus/machine-id
/usr/local/sbin/cantrip-os-identity initialize
exec sleep infinity`,
    );
    assert.equal(await identity(legacy), legacyId);

    const clone = await run(
      "clone",
      `set -eu
dbus-uuidgen --ensure=/etc/machine-id
python3 - <<'PY'
from pathlib import Path
import json
for component in ('executor','remote'):
    config=json.loads(Path('/etc/cantrip-os/'+component+'.json').read_text())
    state=Path(config['state_dir']);state.mkdir(parents=True,exist_ok=True)
    if component=='executor':
        (state/'instance.json').write_text('copied enrollment')
        (state/'preferences.json').write_text('retained preference')
    else:
        (state/'ssh_host_ed25519_key').write_text('copied private key')
        (state/'ssh_host_ed25519_key.pub').write_text('copied public key')
Path('/home/cantrip/retained-clone.txt').write_text('workspace data')
PY
/usr/local/sbin/cantrip-os-identity prepare-clone
python3 - <<'PY'
from pathlib import Path
import json
assert not Path('/etc/machine-id').exists()
for component in ('executor','remote'):
    state=Path(json.loads(Path('/etc/cantrip-os/'+component+'.json').read_text())['state_dir'])
    names=('instance.json',) if component=='executor' else ('ssh_host_ed25519_key','ssh_host_ed25519_key.pub')
    assert all(not (state/name).exists() for name in names)
    if component=='executor': assert (state/'preferences.json').read_text()=='retained preference'
assert Path('/home/cantrip/retained-clone.txt').read_text()=='workspace data'
PY
/usr/local/sbin/cantrip-os-identity initialize
exec sleep infinity`,
    );
    const cloneId = await identity(clone);
    assert.notEqual(cloneId, firstId);
    assert.notEqual(cloneId, secondId);
    assert.notEqual(cloneId, legacyId);
    assert.equal(
      await docker("exec", clone, "cat", "/home/cantrip/retained-clone.txt"),
      "workspace data",
    );
    t.diagnostic(
      JSON.stringify({ firstId, secondId, cloneId, legacyPreserved: true }),
    );
    passed = true;
  },
);
