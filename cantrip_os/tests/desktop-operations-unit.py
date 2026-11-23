#!/usr/bin/env python3
"""Durable desktop admissions: run on the host without launching desktops."""
import copy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import sys
import unittest
import uuid

LIB = Path(__file__).resolve().parents[1] / "packages/workspaces/root/usr/lib/cantrip-os-workspaces"
sys.dont_write_bytecode = True
sys.path.insert(0, str(LIB))
from desktop_operations import DesktopOperations, public_target
from service import atomic_json


class Crash(BaseException):
    pass


class Desktops:
    def __init__(self, state):
        self.store = SimpleNamespace(state=state)
        self.calls = []
        self.after_mutation = lambda: None
        self.records = {
            name: {"id": name, "user": "ctw-" + name, "uid": 20000 + index,
                   "gid": 20000 + index, "home": str(state / name), "display": 100 + index,
                   "generation": 1, "status": "running", "view_token": uuid.uuid4().hex}
            for index, name in enumerate(("alpha", "beta"))
        }

    def info(self, name):
        return copy.deepcopy(self.records[name])

    def dispatch(self, action, name):
        self.calls.append((action, name))
        record = self.records[name]
        if action in ("stop", "restart"):
            record["status"] = "stopped"
        if action in ("open", "restart") and record["status"] == "stopped":
            record.update(status="running", generation=record["generation"] + 1, view_token=uuid.uuid4().hex)
        self.after_mutation()
        return self.info(name)


class OperationsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.sessions = Desktops(Path(self.temporary.name))
        self.operations = DesktopOperations(self.sessions, atomic_json)

    def request(self, action="restart"):
        return {"operation_id": str(uuid.uuid4()), "scope_key": "a" * 64,
                "action": action, "target": self.operations.target("alpha")}

    def test_completed_restart_and_lost_client_reply_do_not_restart_again(self):
        request = self.request()
        beta = self.sessions.info("beta")
        first = self.operations.execute(request)
        self.assertEqual(first["state"], "ready")
        self.assertEqual(first["receipt"]["completion"], "acknowledged-and-observed")
        reader = DesktopOperations(self.sessions, atomic_json)
        self.assertEqual(reader.execute(request)["receipt"], first["receipt"])
        self.assertEqual(reader.observe(request)["receipt"], first["receipt"])
        self.assertEqual(self.sessions.calls, [("restart", "alpha")])
        self.assertEqual(self.sessions.info("beta"), beta)
        self.assertEqual(self.operations.file(request).stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.operations.root.stat().st_mode & 0o777, 0o700)
        self.assertNotIn("view_token", json.dumps(first))

    def test_crash_after_actual_restart_recovers_by_observation_only(self):
        request = self.request()
        self.sessions.after_mutation = lambda: (_ for _ in ()).throw(Crash())
        with self.assertRaises(Crash):
            self.operations.execute(request)
        self.sessions.after_mutation = lambda: None
        self.assertEqual(json.loads(self.operations.file(request).read_text())["state"], "dispatched")
        result = DesktopOperations(self.sessions, atomic_json).execute(request)
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["receipt"]["completion"], "observed-state")
        self.assertEqual(self.sessions.calls, [("restart", "alpha")])

    def test_reserved_admission_never_dispatches_on_recovery(self):
        request = self.request()
        def crash_after_reservation(path, value, exclusive=False):
            atomic_json(path, value, exclusive=exclusive)
            if exclusive:
                raise Crash()
        operations = DesktopOperations(self.sessions, crash_after_reservation)
        with self.assertRaises(Crash):
            operations.execute(request)
        recovered = self.operations.execute(request)
        self.assertEqual(recovered["state"], "failed")
        self.assertIn("before dispatch", recovered["error"])
        self.assertEqual(self.sessions.calls, [])

    def test_dispatched_but_unobserved_admission_stays_unknown_without_replay(self):
        request = self.request()
        def crash_after_dispatch_record(path, value, exclusive=False):
            atomic_json(path, value, exclusive=exclusive)
            if value["state"] == "dispatched":
                raise Crash()
        with self.assertRaises(Crash):
            DesktopOperations(self.sessions, crash_after_dispatch_record).execute(request)
        for _ in range(2):
            self.assertEqual(self.operations.execute(request)["state"], "unknown")
        self.assertEqual(self.sessions.calls, [])

    def test_changed_admission_is_rejected_even_when_completion_exists(self):
        request = self.request()
        self.operations.execute(request)
        for change in ({"action": "stop"}, {"scope_key": "b" * 64},
                       {"target": self.operations.target("beta")},
                       {"target": self.operations.target("alpha")}):
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "another admission"):
                self.operations.execute({**request, **change})
        self.assertEqual(len(self.sessions.calls), 1)

    def test_missing_and_corrupt_journals_cannot_start_a_replacement(self):
        request = self.request()
        self.assertIsNone(self.operations.observe(request))
        path = self.operations.file(request)
        for value in ("{", "{}", json.dumps({"version": 9})):
            path.write_text(value)
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.operations.execute(request)
            self.assertEqual(path.read_text(), value)
        self.assertEqual(self.sessions.calls, [])

    def test_stale_desktop_or_account_cannot_be_mutated(self):
        for field, value in (("generation", 99), ("uid", 42), ("home", "/another"), ("desktop_generation", "f" * 64)):
            request = self.request()
            request["target"][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "target changed"):
                self.operations.execute(request)
        self.assertEqual(self.sessions.calls, [])
        self.assertEqual(list(self.operations.root.glob("*.json")), [])

    def test_history_keeps_completion_separate_from_current_or_replaced_account(self):
        request = self.request("stop")
        completed = self.operations.execute(request)
        self.sessions.dispatch("open", "alpha")
        current = self.operations.observe(request)
        self.assertEqual(current["state"], "ready")
        self.assertEqual(current["receipt"], completed["receipt"])
        self.assertEqual(current["current"]["status"], "running")
        self.sessions.records["alpha"]["uid"] += 100
        self.assertIn("account", self.operations.observe(request)["current_error"])
        self.assertEqual(self.operations.observe(request)["receipt"], completed["receipt"])

    def test_start_does_not_replace_an_already_running_desktop(self):
        request = self.request("start")
        result = self.operations.execute(request)
        self.assertEqual(result["receipt"]["after"], request["target"])
        self.assertEqual(result["state"], "ready")

    def test_failed_start_reports_actual_error_without_mutation_retry(self):
        request = self.request()
        def failure():
            self.sessions.records["alpha"]["status"] = "stopped"
            raise RuntimeError("Actual X display is occupied")
        self.sessions.after_mutation = failure
        result = self.operations.execute(request)
        self.assertEqual(result["state"], "unknown")
        self.assertIn("Actual X display", result["error"])
        self.operations.execute(request)
        self.assertEqual(len(self.sessions.calls), 1)

    def test_corrupt_ready_receipt_and_non_string_state_are_preserved(self):
        request = self.request()
        self.operations.execute(request)
        original = json.loads(self.operations.file(request).read_text())
        malformed_before = copy.deepcopy(original)
        malformed_before["receipt"]["before"]["generation"] = True
        for record in ({**original, "state": []}, {**original, "receipt": None}, malformed_before,
                       {**original, "error": "contradictory failure"}):
            atomic_json(self.operations.file(request), record)
            with self.assertRaises(ValueError):
                self.operations.observe(request)
            self.assertEqual(json.loads(self.operations.file(request).read_text()), record)
        self.assertEqual(len(self.sessions.calls), 1)


if __name__ == "__main__":
    unittest.main()
