"""Root-only, generation-bound desktop operations; observation never dispatches."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import uuid


IDENTITY = ("id", "user", "uid", "gid", "home", "display")
TARGET_KEYS = {*IDENTITY, "generation", "desktop_generation", "status"}
STATES = {"reserved", "dispatched", "ready", "failed", "unknown"}


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def validate_target(value):
    if not isinstance(value, dict) or set(value) != TARGET_KEYS:
        raise ValueError("Invalid desktop target")
    if not isinstance(value["id"], str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,23}", value["id"]):
        raise ValueError("Invalid desktop workspace ID")
    if value["user"] != "ctw-" + value["id"] or not isinstance(value["home"], str) or not Path(value["home"]).is_absolute():
        raise ValueError("Invalid desktop account")
    for field, minimum in (("uid", 1), ("gid", 1), ("display", 1), ("generation", 0)):
        if type(value[field]) is not int or not minimum <= value[field] <= 9007199254740991:
            raise ValueError("Invalid desktop identity or generation")
    token = value["desktop_generation"]
    if token is not None and (not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{64}", token)):
        raise ValueError("Invalid desktop generation")
    if value["status"] not in ("running", "stopped") or (value["status"] == "running" and token is None):
        raise ValueError("Invalid desktop status")
    return value


def public_target(record):
    token = record.get("view_token")
    if token is not None and not isinstance(token, str):
        raise ValueError("Invalid stored desktop token")
    return validate_target({
        **{key: record[key] for key in IDENTITY},
        "generation": record["generation"], "status": record["status"],
        "desktop_generation": hashlib.sha256(token.encode()).hexdigest() if token else None,
    })


def validate_request(value):
    if not isinstance(value, dict) or set(value) != {"operation_id", "action", "scope_key", "target"}:
        raise ValueError("Invalid desktop operation admission")
    identifier = value["operation_id"]
    if not isinstance(identifier, str) or str(uuid.UUID(identifier)) != identifier:
        raise ValueError("Invalid desktop operation ID")
    if value["action"] not in ("start", "stop", "restart"):
        raise ValueError("Invalid desktop operation action")
    if not isinstance(value["scope_key"], str) or not re.fullmatch(r"[a-f0-9]{64}", value["scope_key"]):
        raise ValueError("Invalid desktop operation scope key")
    validate_target(value["target"])
    return value


def same_account(left, right):
    return all(left[key] == right[key] for key in IDENTITY)


def requested_state(request, actual):
    before = request["target"]
    if not same_account(before, actual):
        return False
    same_generation = all(before[key] == actual[key] for key in ("generation", "desktop_generation"))
    if request["action"] == "stop":
        return actual["status"] == "stopped" and same_generation
    if actual["status"] != "running":
        return False
    if request["action"] == "start" and before["status"] == "running":
        return same_generation
    return actual["generation"] > before["generation"] and actual["desktop_generation"] != before["desktop_generation"]


class DesktopOperations:
    def __init__(self, sessions, write_json):
        self.sessions = sessions
        self.write_json = write_json
        self.root = sessions.store.state / "desktop-operations"
        self.root.mkdir(exist_ok=True, mode=0o700)
        self.root.chmod(0o700)

    def target(self, name):
        return public_target(self.sessions.info(name))

    def file(self, request):
        return self.root / (request["operation_id"] + ".json")

    def read(self, request):
        try:
            record = json.loads(self.file(request).read_text())
        except FileNotFoundError:
            return None
        keys = {"version", "request", "state", "started_at", "updated_at", "error", "receipt"}
        if not isinstance(record, dict) or set(record) != keys or type(record["version"]) is not int or record["version"] != 1:
            raise ValueError("Unsupported or damaged desktop operation; journal preserved")
        validate_request(record["request"])
        if record["request"] != request:
            raise ValueError("The desktop operation ID belongs to another admission")
        if not isinstance(record["state"], str) or record["state"] not in STATES or \
                not all(isinstance(record[key], str) for key in ("started_at", "updated_at")):
            raise ValueError("Damaged desktop operation state; journal preserved")
        if record["error"] is not None and not isinstance(record["error"], str):
            raise ValueError("Damaged desktop operation error; journal preserved")
        receipt = record["receipt"]
        if record["state"] == "ready":
            if not isinstance(receipt, dict) or set(receipt) != {"completion", "before", "after"} or \
                    receipt["completion"] not in ("acknowledged-and-observed", "observed-state") or receipt["before"] != request["target"]:
                raise ValueError("Damaged desktop completion; journal preserved")
            validate_target(receipt["before"])
            if record["error"] is not None:
                raise ValueError("Conflicting desktop completion error; journal preserved")
            if not requested_state(request, validate_target(receipt["after"])):
                raise ValueError("Desktop completion differs from its admission")
        elif receipt is not None:
            raise ValueError("Unexpected desktop receipt; journal preserved")
        return record

    def save(self, record, exclusive=False):
        record["updated_at"] = timestamp()
        self.write_json(self.file(record["request"]), record, exclusive=exclusive)

    def current(self, request):
        try:
            actual = self.target(request["target"]["id"])
            if not same_account(request["target"], actual):
                return actual, "The workspace account or display changed"
            return actual, None
        except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as error:
            return None, str(error)

    def observe(self, value):
        request = validate_request(value)
        record = self.read(request)
        if record is None:
            return None
        current, current_error = self.current(request)
        if record["state"] == "reserved":
            record["state"] = "failed"
            record["error"] = "This admission was retained before dispatch; no desktop mutation was sent"
            self.save(record)
        elif record["state"] in ("dispatched", "unknown"):
            if current_error is None and requested_state(request, current):
                record.update(state="ready", error=None, receipt={
                    "completion": "observed-state", "before": request["target"], "after": current,
                })
            else:
                record["state"] = "unknown"
                record["error"] = record["error"] or "Desktop delivery is unknown; observation did not repeat the operation"
            self.save(record)
        # Saved completion stays historical when a later desktop replaces it.
        return {**record, "current": current, "current_error": current_error}

    def execute(self, value):
        # Detach caller-owned dictionaries from the immutable admission.
        request = validate_request(json.loads(json.dumps(value)))
        if self.read(request) is not None:
            return self.observe(request)
        if self.target(request["target"]["id"]) != request["target"]:
            raise ValueError("The captured desktop target changed before admission")
        record = {"version": 1, "request": request, "state": "reserved", "started_at": timestamp(),
                  "updated_at": timestamp(), "error": None, "receipt": None}
        try:
            self.save(record, exclusive=True)
        except FileExistsError:
            return self.observe(request)
        record["state"] = "dispatched"
        self.save(record)
        try:
            self.sessions.dispatch("open" if request["action"] == "start" else request["action"], request["target"]["id"])
            actual = self.target(request["target"]["id"])
            if not requested_state(request, actual):
                raise RuntimeError("The actual desktop did not reach its requested state")
            record.update(state="ready", receipt={
                "completion": "acknowledged-and-observed", "before": request["target"], "after": actual,
            })
        except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as error:
            record["state"] = "unknown"
            record["error"] = str(error)
        self.save(record)
        current, current_error = self.current(request)
        return {**record, "current": current, "current_error": current_error}
