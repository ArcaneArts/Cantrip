"""Explicit GUI commands use the caller's workspace, never an inherited display."""
import json
import os
import subprocess
import sys


def desktop_context(workspaces, uid):
    matches = [record for record in workspaces if record["uid"] == uid]
    if len(matches) != 1:
        raise ValueError("Run cantrip-desktop as an assigned workspace account (sudo -u ctw-<workspace> if administering as root)")
    record = matches[0]
    return {"workspace_id": record["id"], "uid": uid,
            "environment": {"HOME": record["home"], "USER": record["user"], "LOGNAME": record["user"],
                            "DISPLAY": ":" + str(record["display"]), "XDG_RUNTIME_DIR": "/run/user/" + str(uid),
                            "XDG_SESSION_TYPE": "x11", "XDG_CURRENT_DESKTOP": "ICEWM"}}


def main():
    command = sys.argv[1:]
    if command[:1] == ["--"]:
        command = command[1:]
    if not command or command == ["--help"]:
        print("Usage: cantrip-desktop [--] command [argument ...]\n"
              "Run as the workspace account. Open its desktop in the workspace selector first.\n"
              "The command keeps its current directory and normal executor cancellation lifecycle.")
        return 0 if command else 2
    uid = os.getuid()
    result = subprocess.run(["sudo", "-n", "/usr/bin/cantrip-executor", "desktop-context", str(uid)],
                            check=True, capture_output=True, text=True)
    context = json.loads(result.stdout)
    if context["uid"] != uid:
        raise ValueError("The desktop context does not match this workspace account")
    env = dict(os.environ)
    for key in ("XAUTHORITY", "WAYLAND_DISPLAY", "SESSION_MANAGER", "DBUS_SESSION_BUS_ADDRESS",
                "DBUS_SESSION_BUS_PID", "DBUS_STARTER_ADDRESS", "DBUS_STARTER_BUS_TYPE", "AT_SPI_BUS_ADDRESS", "IBUS_ADDRESS"):
        env.pop(key, None)
    env.update(context["environment"])
    # A private bus avoids inheriting the personal console or another workspace's
    # session bus. No desktop is started here; the actual GUI command reports a
    # missing X server through its ordinary exit status.
    os.execvpe("dbus-run-session", ["dbus-run-session", "--", *command], env)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as error:
        print(error.stderr.strip() or str(error), file=sys.stderr)
        sys.exit(error.returncode)
    except (OSError, ValueError, KeyError) as error:
        print(f"cantrip-desktop: {error}", file=sys.stderr)
        sys.exit(1)
