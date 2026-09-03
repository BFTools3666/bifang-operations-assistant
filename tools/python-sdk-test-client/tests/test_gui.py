import concurrent.futures
import importlib.util
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path


TOOL_DIRECTORY = Path(__file__).resolve().parents[1]
GUI_PATH = TOOL_DIRECTORY / "gui.py"

# Importing the module must never create a Tk root. Patching before exec catches
# accidental top-level window creation while still allowing headless CI imports.
import tkinter


ORIGINAL_TK = tkinter.Tk
TK_CALLS = []


def forbidden_tk(*args, **kwargs):
    TK_CALLS.append((args, kwargs))
    raise AssertionError("gui.py created a Tk root during import")


tkinter.Tk = forbidden_tk
sys.path.insert(0, str(TOOL_DIRECTORY))
try:
    SPEC = importlib.util.spec_from_file_location("bifang_sdk_gui", GUI_PATH)
    assert SPEC is not None and SPEC.loader is not None
    GUI = importlib.util.module_from_spec(SPEC)
    sys.modules[SPEC.name] = GUI
    SPEC.loader.exec_module(GUI)
finally:
    sys.path.pop(0)
    tkinter.Tk = ORIGINAL_TK


class ImmediateExecutor:
    def submit(self, function):
        future = concurrent.futures.Future()
        try:
            future.set_result(function())
        except BaseException as error:
            future.set_exception(error)
        return future

    def shutdown(self, wait=False, cancel_futures=False):
        return None


class FakeBridge:
    def __init__(self):
        self.calls = []
        self.closed = False
        self.fail_action = None
        self.fail_code = "fake_failure"
        self.block_action = None
        self.block_started = threading.Event()
        self.block_release = threading.Event()

    def request(self, action, timeout=15, **payload):
        self.calls.append((action, timeout, payload, threading.get_ident()))
        if action == self.block_action:
            self.block_started.set()
            self.block_release.wait(timeout=2)
        if action == self.fail_action:
            raise GUI.BridgeError(self.fail_code, "controlled bridge failure")
        responses = {
            "ping": {"sdk_version": "1.0.0", "network_performed": False},
            "reset_sessions": {"reset": True, "network_performed": False},
            "init_capture": {
                "client": {
                    "enabled": True,
                    "install_id": "11111111-1111-4111-8111-111111111111",
                    "session_id": "22222222-2222-4222-8222-222222222222",
                },
                "events": [],
                "network_performed": False,
            },
            "track_capture": {
                "accepted_by_sdk": True,
                "events": [],
                "network_performed": False,
            },
            "preview_update": {
                "decision": {"kind": "none", "reason": "up_to_date"},
                "network_performed": False,
            },
            "init_live": {
                "client": {
                    "enabled": True,
                    "install_id": "33333333-3333-4333-8333-333333333333",
                    "session_id": "44444444-4444-4444-8444-444444444444",
                },
                "transport_records": [],
                "network_performed": True,
            },
            "track_live": {
                "accepted_by_sdk": True,
                "transport_records": [],
                "network_performed": True,
            },
            "build_update_url": {
                "request_url": "https://updates.example.com/base/example-tool/windows.json",
                "network_performed": False,
            },
            "check_update_live": {
                "decision": {"kind": "none", "reason": "up_to_date"},
                "request_url": "https://updates.example.com/base/example-tool/windows.json",
                "network_authorized": True,
            },
            "status": {
                "sdk_version": "1.0.0",
                "capture": None,
                "live": {
                    "enabled": True,
                    "install_id": "33333333-3333-4333-8333-333333333333",
                    "session_id": "44444444-4444-4444-8444-444444444444",
                    "endpoint": "https://secret.example.com/track?credential=value",
                },
                "network_performed": False,
            },
        }
        return responses[action]

    def close(self):
        self.closed = True
        self.block_release.set()


def connected_controller(confirm_network=lambda _intent: True, executor=None):
    records = []
    states = []
    busy_changes = []
    bridge = FakeBridge()
    runner = GUI.AsyncOperationRunner(
        lambda busy, label: busy_changes.append((busy, label)),
        executor=executor or ImmediateExecutor(),
    )
    controller = GUI.GuiController(
        runner=runner,
        state_root=GUI.DEFAULT_STATE_ROOT,
        confirm_network=confirm_network,
        on_record=records.append,
        on_state_change=states.append,
    )
    self_thread = threading.get_ident()
    controller.connect(lambda: bridge)
    runner.poll()
    assert controller.bridge_status == "ready"
    assert all(call[3] == self_thread for call in bridge.calls)
    bridge.calls.clear()
    records.clear()
    busy_changes.clear()
    return controller, runner, bridge, records, states, busy_changes


class ImportAndPureLogicTests(unittest.TestCase):
    def test_import_does_not_create_a_window(self):
        self.assertEqual(TK_CALLS, [])

    def test_gui_defaults_are_offline_and_six_presets_match_cli_examples(self):
        self.assertEqual(GUI.LIVE_TELEMETRY_ENDPOINT_DEFAULT, "")
        self.assertEqual(GUI.LIVE_UPDATE_BASE_URL_DEFAULT, "")
        self.assertEqual(GUI.GUI_EVENT_EXAMPLES, tuple(GUI.EVENT_EXAMPLES[:6]))
        self.assertEqual(
            [event for event, _properties in GUI.GUI_EVENT_EXAMPLES],
            [
                "feature_used",
                "task_started",
                "task_succeeded",
                "task_failed",
                "update_prompt_shown",
                "update_clicked",
            ],
        )

    def test_json_parser_only_requires_json_object_shape(self):
        value = {"unexpected_protocol_key": ["left for the SDK to reject"]}
        self.assertEqual(GUI.parse_json_object(json.dumps(value), "input"), value)
        with self.assertRaisesRegex(ValueError, "不是有效 JSON"):
            GUI.parse_json_object("{", "input")
        with self.assertRaisesRegex(ValueError, "JSON object"):
            GUI.parse_json_object("[]", "input")
        for non_json_number in ("NaN", "Infinity", "-Infinity"):
            with self.assertRaisesRegex(ValueError, "非标准 JSON"):
                GUI.parse_json_object(
                    f'{{"value":{non_json_number}}}', "input"
                )

    def test_network_confirmation_is_exact_and_case_sensitive(self):
        intent = GUI.NetworkIntent("POST", "https://example.com/v1", "effect")
        self.assertTrue(
            GUI.network_confirmation_matches(
                intent, "https://example.com/v1", "POST"
            )
        )
        self.assertFalse(
            GUI.network_confirmation_matches(
                intent, "https://example.com/v1/", "POST"
            )
        )
        self.assertFalse(
            GUI.network_confirmation_matches(
                intent, "https://example.com/v1", "post"
            )
        )

    def test_source_has_no_link_opener_or_automatic_window_creation(self):
        source = GUI_PATH.read_text(encoding="utf-8")
        self.assertNotIn("webbrowser", source)
        self.assertNotIn("os.startfile(", source)
        self.assertNotIn('bind("<Return>"', source)
        self.assertEqual(source.count("tk.Tk()"), 1)
        self.assertIn('if __name__ == "__main__":', source)


class OfflineControllerTests(unittest.TestCase):
    def test_capture_and_update_requests_reuse_config_and_tool_state_directory(self):
        controller, runner, bridge, _records, _states, _busy = connected_controller()
        controller.init_capture()
        runner.poll()
        action, timeout, payload, _thread_id = bridge.calls.pop(0)
        self.assertEqual(action, "init_capture")
        self.assertEqual(timeout, 15)
        self.assertEqual(payload["app_id"], "example-tool")
        self.assertEqual(payload["app_version"], "0.1.0")
        self.assertEqual(payload["channel"], "official")
        self.assertNotIn("allow_network", payload)
        self.assertNotIn("endpoint", payload)
        self.assertEqual(
            Path(payload["state_dir"]),
            GUI.state_directory_for_app(
                GUI.DEFAULT_STATE_ROOT, "capture", "example-tool"
            ),
        )

        controller.track_capture("feature_used", {"feature_id": "export_csv"})
        runner.poll()
        action, _timeout, payload, _thread_id = bridge.calls.pop(0)
        self.assertEqual(action, "track_capture")
        self.assertEqual(
            payload,
            {"event": "feature_used", "properties": {"feature_id": "export_csv"}},
        )

        manifest = {"deliberately": "left for real SDK validation"}
        controller.preview_update(manifest)
        runner.poll()
        action, _timeout, payload, _thread_id = bridge.calls.pop(0)
        self.assertEqual(action, "preview_update")
        self.assertIs(payload["manifest"], manifest)
        self.assertNotIn("allow_network", payload)

    def test_config_reset_clears_identity_only_after_bridge_success(self):
        controller, runner, bridge, _records, _states, _busy = connected_controller()
        controller.init_capture()
        runner.poll()
        self.assertTrue(controller.capture.initialized)
        replacement = GUI.ClientConfig(app_id="app-b", app_version="2.0.0")
        controller.apply_config(replacement)
        self.assertTrue(controller.capture.initialized)
        runner.poll()
        self.assertFalse(controller.capture.initialized)
        self.assertEqual(controller.config.app_id, "app-b")
        self.assertEqual(bridge.calls[-1][0], "reset_sessions")

    def test_bridge_failure_becomes_structured_record_and_clears_busy(self):
        controller, runner, bridge, records, _states, _busy = connected_controller()
        controller.capture = GUI.IdentityState(
            initialized=True,
            enabled=True,
            install_id="install",
            session_id="session",
        )
        bridge.fail_action = "track_capture"
        controller.track_capture("feature_used", {"feature_id": "export_csv"})
        runner.poll()
        self.assertFalse(runner.busy)
        self.assertEqual(records[-1].level, "error")
        self.assertEqual(records[-1].data["error"]["code"], "fake_failure")

    def test_fatal_bridge_failure_marks_bridge_unavailable(self):
        controller, runner, bridge, _records, _states, _busy = connected_controller()
        controller.capture = GUI.IdentityState(
            initialized=True,
            enabled=True,
            install_id="install",
            session_id="session",
        )
        bridge.fail_action = "track_capture"
        bridge.fail_code = "bridge_unavailable"
        controller.track_capture("feature_used", {"feature_id": "export_csv"})
        runner.poll()
        self.assertEqual(controller.bridge_status, "error")
        self.assertFalse(
            controller.track_capture("feature_used", {"feature_id": "again"})
        )
        self.assertEqual(len(bridge.calls), 1)

    def test_refresh_status_never_copies_live_endpoint_into_records(self):
        controller, runner, _bridge, records, _states, _busy = connected_controller()
        controller.refresh_status()
        runner.poll()
        rendered = json.dumps(records[-1].data, ensure_ascii=False)
        self.assertNotIn("secret.example.com", rendered)
        self.assertNotIn("endpoint", rendered)
        self.assertTrue(controller.live.initialized)


class LiveConsentTests(unittest.TestCase):
    def test_empty_or_cancelled_post_never_reaches_bridge(self):
        intents = []
        controller, runner, bridge, records, _states, _busy = connected_controller(
            lambda intent: intents.append(intent) or False
        )
        self.assertFalse(controller.init_live(""))
        self.assertEqual(intents, [])
        self.assertEqual(bridge.calls, [])
        self.assertFalse(controller.init_live("https://telemetry.example.com/v1/track"))
        self.assertEqual(len(intents), 1)
        self.assertIn("app_install", intents[0].side_effect)
        self.assertEqual(bridge.calls, [])
        self.assertFalse(runner.busy)
        self.assertFalse(records[-1].data["network_performed"])

    def test_each_confirmed_post_has_bridge_second_gate(self):
        intents = []
        controller, runner, bridge, _records, _states, _busy = connected_controller(
            lambda intent: intents.append(intent) or True
        )
        endpoint = "https://telemetry.example.com/v1/track"
        controller.init_live(endpoint)
        runner.poll()
        controller.track_live(endpoint, "task_started", {"task_type": "export"})
        runner.poll()
        self.assertEqual([call[0] for call in bridge.calls], ["init_live", "track_live"])
        for action, timeout, payload, _thread_id in bridge.calls:
            self.assertEqual(timeout, 35)
            self.assertEqual(payload["endpoint"], endpoint)
            self.assertIs(payload["allow_network"], True)
            self.assertEqual(payload["confirmation"], "POST")
            if action == "track_live":
                self.assertEqual(payload["event"], "task_started")
        self.assertEqual([intent.verb for intent in intents], ["POST", "POST"])

    def test_get_confirmation_uses_sdk_built_request_url_and_cancel_skips_live_get(self):
        intents = []
        controller, runner, bridge, _records, _states, _busy = connected_controller(
            lambda intent: intents.append(intent) or False
        )
        controller.capture = GUI.IdentityState(
            initialized=True,
            enabled=True,
            install_id="install",
            session_id="session",
        )
        controller.prepare_live_update_check("https://updates.example.com/base")
        runner.poll()
        self.assertEqual([call[0] for call in bridge.calls], ["build_update_url"])
        self.assertEqual(
            intents[0].target_url,
            "https://updates.example.com/base/example-tool/windows.json",
        )
        self.assertEqual(intents[0].verb, "GET")

    def test_confirmed_get_uses_original_base_and_exact_bridge_consent(self):
        intents = []
        controller, runner, bridge, _records, _states, _busy = connected_controller(
            lambda intent: intents.append(intent) or True
        )
        controller.capture = GUI.IdentityState(
            initialized=True,
            enabled=True,
            install_id="install",
            session_id="session",
        )
        base_url = "https://updates.example.com/base"
        controller.prepare_live_update_check(base_url)
        runner.poll()
        self.assertEqual(
            [call[0] for call in bridge.calls],
            ["build_update_url", "check_update_live"],
        )
        _action, timeout, payload, _thread_id = bridge.calls[-1]
        self.assertEqual(timeout, 35)
        self.assertEqual(payload["base_url"], base_url)
        self.assertIs(payload["allow_network"], True)
        self.assertEqual(payload["confirmation"], "GET")
        self.assertEqual(len(intents), 1)


class AsyncRunnerTests(unittest.TestCase):
    def test_slow_bridge_call_returns_immediately_and_completes_on_owner_poll(self):
        owner_thread = threading.get_ident()
        callback_threads = []
        records = []
        states = []
        busy_changes = []
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        bridge = FakeBridge()
        bridge.block_action = "track_capture"
        runner = GUI.AsyncOperationRunner(
            lambda busy, label: busy_changes.append((busy, label)), executor=executor
        )
        controller = GUI.GuiController(
            runner=runner,
            state_root=GUI.DEFAULT_STATE_ROOT,
            confirm_network=lambda _intent: True,
            on_record=lambda record: (
                callback_threads.append(threading.get_ident()), records.append(record)
            ),
            on_state_change=states.append,
        )
        controller._bridge = bridge
        controller.bridge_status = "ready"
        controller.capture = GUI.IdentityState(
            initialized=True,
            enabled=True,
            install_id="install",
            session_id="session",
        )

        before = time.monotonic()
        submitted = controller.track_capture(
            "feature_used", {"feature_id": "export_csv"}
        )
        elapsed = time.monotonic() - before
        self.assertTrue(submitted)
        self.assertLess(elapsed, 0.5)
        self.assertTrue(bridge.block_started.wait(timeout=1))
        self.assertTrue(runner.busy)
        self.assertFalse(
            controller.track_capture("feature_used", {"feature_id": "second"})
        )
        self.assertEqual(len(bridge.calls), 1)

        bridge.block_release.set()
        deadline = time.monotonic() + 2
        while runner.busy and time.monotonic() < deadline:
            runner.poll()
            time.sleep(0.01)
        self.assertFalse(runner.busy)
        self.assertTrue(callback_threads)
        self.assertTrue(all(thread_id == owner_thread for thread_id in callback_threads))
        self.assertNotEqual(bridge.calls[0][3], owner_thread)
        self.assertEqual(records[-1].level, "success")
        runner.stop_accepting()
        executor.shutdown(wait=True, cancel_futures=True)

    def test_close_unblocks_a_running_bridge_request_without_result_callback(self):
        records = []
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        bridge = FakeBridge()
        bridge.block_action = "track_capture"
        runner = GUI.AsyncOperationRunner(lambda _busy, _label: None, executor=executor)
        controller = GUI.GuiController(
            runner=runner,
            state_root=GUI.DEFAULT_STATE_ROOT,
            confirm_network=lambda _intent: True,
            on_record=records.append,
            on_state_change=lambda _snapshot: None,
        )
        controller._bridge = bridge
        controller.bridge_status = "ready"
        controller.capture = GUI.IdentityState(
            initialized=True,
            enabled=True,
            install_id="install",
            session_id="session",
        )
        controller.track_capture("feature_used", {"feature_id": "export_csv"})
        self.assertTrue(bridge.block_started.wait(timeout=1))
        closer = controller.begin_close()
        self.assertIsNotNone(closer)
        closer.join(timeout=1)
        self.assertFalse(closer.is_alive())
        deadline = time.monotonic() + 1
        while runner.busy and time.monotonic() < deadline:
            runner.poll()
            time.sleep(0.01)
        self.assertFalse(runner.busy)
        self.assertTrue(bridge.closed)
        self.assertEqual(records, [])
        executor.shutdown(wait=True, cancel_futures=True)


if __name__ == "__main__":
    unittest.main()
