import importlib.util
import io
import sys
import threading
import time
import unittest
from pathlib import Path


CLIENT_PATH = Path(__file__).resolve().parents[1] / "client.py"
SPEC = importlib.util.spec_from_file_location("bifang_sdk_manual_client", CLIENT_PATH)
assert SPEC is not None and SPEC.loader is not None
CLIENT = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CLIENT
SPEC.loader.exec_module(CLIENT)


class BridgeProcessTests(unittest.TestCase):
    def test_python_ipc_calls_real_bridge_and_sdk_capture(self):
        import tempfile

        with tempfile.TemporaryDirectory(prefix="毕方-sdk-python-") as state_directory:
            with CLIENT.BridgeProcess(CLIENT_PATH.with_name("bridge.mjs")) as bridge:
                ping = bridge.request("ping", timeout=5)
                self.assertEqual(ping["sdk_version"], "1.0.0")
                initialized = bridge.request(
                    "init_capture",
                    timeout=10,
                    state_dir=state_directory,
                    app_id="example-tool",
                    app_version="0.1.0",
                    platform="windows",
                    arch="x64",
                    channel="official",
                )
                self.assertFalse(initialized["network_performed"])
                self.assertEqual(
                    [event["event"] for event in initialized["events"]],
                    ["app_install", "app_start"],
                )


class BackgroundJobTests(unittest.TestCase):
    def test_submit_returns_before_slow_check_finishes(self):
        release = threading.Event()
        started = threading.Event()
        jobs = CLIENT.BackgroundJobs(max_workers=1)

        def slow_check():
            started.set()
            release.wait(timeout=2)
            return {"decision": {"kind": "none", "reason": "up_to_date"}}

        before = time.monotonic()
        job_id = jobs.submit("delayed GET", slow_check)
        elapsed = time.monotonic() - before
        self.assertEqual(job_id, 1)
        self.assertLess(elapsed, 0.5)
        self.assertTrue(started.wait(timeout=1))
        job = next(iter(jobs.jobs()))
        self.assertFalse(job.future.done())
        release.set()
        self.assertEqual(job.future.result(timeout=1)["decision"]["kind"], "none")
        jobs.close()


class SafetyPromptTests(unittest.TestCase):
    def test_empty_url_and_wrong_confirmation_never_authorize_network(self):
        class NoopBridge:
            def close(self):
                return None

        answers = iter(["NO"])
        output = io.StringIO()
        client = CLIENT.InteractiveClient(
            NoopBridge(),
            Path.cwd(),
            input_function=lambda _prompt: next(answers),
            output=output,
        )
        try:
            self.assertFalse(client._confirm_network("POST", ""))
            self.assertFalse(client._confirm_network("POST", "https://example.com"))
        finally:
            client.jobs.close()
        self.assertIn("未调用 Node 桥接", output.getvalue())
        self.assertIn("确认词不匹配", output.getvalue())

    def test_live_entry_points_do_not_call_bridge_after_failed_confirmation(self):
        class RecordingBridge:
            def __init__(self):
                self.calls = []

            def request(self, *args, **kwargs):
                self.calls.append((args, kwargs))

            def close(self):
                return None

        bridge = RecordingBridge()
        output = io.StringIO()
        answers = iter(
            [
                "https://telemetry.example.com/track",
                "NO",
                "1",
                "",
                "https://telemetry.example.com/track",
                "NO",
                "https://updates.example.com/base",
                "NO",
            ]
        )
        client = CLIENT.InteractiveClient(
            bridge,
            Path.cwd(),
            input_function=lambda _prompt: next(answers),
            output=output,
        )
        client.capture_initialized = True
        client.live_endpoint = "https://telemetry.example.com/track"
        try:
            client.init_live()
            client.track_live()
            client.start_live_update_check()
        finally:
            client.jobs.close()
        self.assertEqual(bridge.calls, [])

    def test_app_identity_directories_are_isolated_and_config_resets_sessions(self):
        class RecordingBridge:
            def __init__(self):
                self.calls = []

            def request(self, *args, **kwargs):
                self.calls.append((args, kwargs))
                return {"reset": True}

            def close(self):
                return None

        bridge = RecordingBridge()
        answers = iter(["app-b", "", "", "", ""])
        client = CLIENT.InteractiveClient(
            bridge,
            Path.cwd(),
            input_function=lambda _prompt: next(answers),
            output=io.StringIO(),
        )
        first_directory = client._state_directory("capture")
        client.capture_initialized = True
        client.live_endpoint = "https://telemetry.example.com/track"
        try:
            client.configure()
            second_directory = client._state_directory("capture")
        finally:
            client.jobs.close()

        self.assertNotEqual(first_directory, second_directory)
        self.assertFalse(client.capture_initialized)
        self.assertIsNone(client.live_endpoint)
        self.assertEqual(bridge.calls[0][0], ("reset_sessions",))


if __name__ == "__main__":
    unittest.main()
