import concurrent.futures
import copy
import importlib.util
import json
import sys
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace


TOOL_DIRECTORY = Path(__file__).resolve().parents[1]
GUI_PATH = TOOL_DIRECTORY / "gui.py"

# Importing gui.py must remain safe in headless CI. Patch before module execution
# so an accidental top-level Tk root is caught without opening a real window.
import tkinter


ORIGINAL_TK = tkinter.Tk
TK_CALLS = []


def forbidden_tk(*args, **kwargs):
    TK_CALLS.append((args, kwargs))
    raise AssertionError("gui.py created a Tk root during import")


tkinter.Tk = forbidden_tk
sys.path.insert(0, str(TOOL_DIRECTORY))
try:
    SPEC = importlib.util.spec_from_file_location("bifang_cloudbase_gui", GUI_PATH)
    assert SPEC is not None and SPEC.loader is not None
    GUI = importlib.util.module_from_spec(SPEC)
    sys.modules[SPEC.name] = GUI
    SPEC.loader.exec_module(GUI)
finally:
    sys.path.pop(0)
    tkinter.Tk = ORIGINAL_TK


VALID_SETTINGS = GUI.ConnectionSettings(
    application_id="example-tool",
    current_version="0.1.0",
    telemetry_url="https://cloud.example.com/v1/track",
    update_url="https://cloud.example.com/updates/example-tool/windows.json",
    platform="windows",
    architecture="x64",
)


def event_id(number):
    return f"00000000-0000-4000-8000-{number:012d}"


def identity_id(number):
    return f"10000000-0000-4000-8000-{number:012d}"


def delivery(event_name, number, *, acknowledged=True, error=None):
    value = {
        "event": event_name,
        "event_id": event_id(number),
        "acknowledged": acknowledged,
        "http_status": 202 if acknowledged else None,
    }
    if error is not None:
        value["error"] = error
    return value


def batch_result(*, failures=None, reverse=False):
    failures = failures or {}
    deliveries = []
    for index, event_name in enumerate(GUI.EXPECTED_EVENT_ORDER, start=1):
        error = failures.get(event_name)
        deliveries.append(
            delivery(
                event_name,
                index,
                acknowledged=error is None,
                error=error,
            )
        )
    if reverse:
        deliveries.reverse()
    return {
        "session_id": "20000000-0000-4000-8000-000000000001",
        "install_id": "30000000-0000-4000-8000-000000000001",
        "deliveries": deliveries,
    }


def update_config(**overrides):
    value = {
        "schema_version": 1,
        "app_id": "example-tool",
        "platform": "windows",
        "enabled": True,
        "latest_version": "0.2.0",
        "min_supported_version": "0.1.0",
        "force_update": False,
        "rollout": 100,
        "title": "Example Tool 0.2.0",
        "message": "A tested update is available.",
        "download_url": "https://downloads.example.com/example-tool-0.2.0.exe",
        "release_notes_url": "https://releases.example.com/example-tool/0.2.0",
        "sha256": "",
        "published_at": "2026-09-03T00:00:00Z",
    }
    value.update(overrides)
    return value


def update_result(kind="optional", *, reason=None, config=None, diagnostic=None):
    config = update_config() if config is None else config
    decision = {"kind": kind}
    if kind in {"optional", "required"}:
        decision["config"] = config
    elif reason is not None:
        decision["reason"] = reason
    value = {"decision": decision, "config": config}
    if diagnostic is not None:
        value["fetch_diagnostic"] = diagnostic
    return value


def simulation_devices():
    """Ten bridge-shaped anonymous devices with 50 acknowledged records."""
    devices = []
    next_event_id = 100
    channels = ("official", "wechat", "bilibili")
    for index in range(10):
        task_event = "task_succeeded" if index < 7 else "task_failed"
        events = (
            "app_install",
            "app_start",
            "feature_used",
            "task_started",
            task_event,
        )
        deliveries = []
        for event_name in events:
            deliveries.append(delivery(event_name, next_event_id))
            next_event_id += 1
        devices.append(
            {
                "install_id": identity_id(index + 1),
                "session_id": identity_id(index + 101),
                "app_version": "0.1.0" if index < 5 else "0.2.0",
                "channel": channels[index % len(channels)],
                "arch": "x64" if index < 8 else "arm64",
                "deliveries": deliveries,
            }
        )
    return devices


def simulation_result(devices=None):
    return {"devices": simulation_devices() if devices is None else devices}


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
        self.fail_message = "controlled bridge failure"
        self.block_action = None
        self.block_started = threading.Event()
        self.block_release = threading.Event()
        self.responses = {
            "ping": {"sdk_version": "1.0.0", "network_performed": False},
            "send_test_batch": batch_result(),
            "simulate_devices": simulation_result(),
            "check_update_url": update_result(),
        }

    def request(self, action, timeout=15, **payload):
        self.calls.append((action, timeout, payload, threading.get_ident()))
        if action == self.block_action:
            self.block_started.set()
            self.block_release.wait(timeout=3)
        if action == self.fail_action:
            raise GUI.BridgeError(self.fail_code, self.fail_message)
        if action not in self.responses:
            raise AssertionError(f"unexpected bridge action: {action}")
        return copy.deepcopy(self.responses[action])

    def close(self):
        self.closed = True
        self.block_release.set()


def controller_harness(
    *,
    confirm=lambda _confirmation: True,
    executor=None,
    connect=True,
    url_opener=lambda _url: True,
    exit_application=lambda: None,
):
    callbacks = SimpleNamespace(
        progress=[],
        batches=[],
        simulations=[],
        updates=[],
        messages=[],
        debug=[],
        states=[],
        busy=[],
    )
    bridge = FakeBridge()
    runner = GUI.AsyncOperationRunner(
        lambda busy, label: callbacks.busy.append((busy, label)),
        executor=executor or ImmediateExecutor(),
    )
    controller = GUI.CloudBaseWizardController(
        runner=runner,
        state_root=GUI.DEFAULT_STATE_ROOT,
        confirm_send=confirm,
        on_progress=lambda text, percent: callbacks.progress.append((text, percent)),
        on_batch=callbacks.batches.append,
        on_simulation=callbacks.simulations.append,
        on_update=callbacks.updates.append,
        on_message=lambda tone, title, detail: callbacks.messages.append(
            (tone, title, detail)
        ),
        on_debug=lambda title, value: callbacks.debug.append((title, value)),
        on_state_change=callbacks.states.append,
        url_opener=url_opener,
        exit_application=exit_application,
    )
    if connect:
        controller.connect(lambda: bridge)
        runner.poll()
        assert controller.helper_status == "ready"
        bridge.calls.clear()
        callbacks.progress.clear()
        callbacks.batches.clear()
        callbacks.simulations.clear()
        callbacks.updates.clear()
        callbacks.messages.clear()
        callbacks.debug.clear()
        callbacks.states.clear()
        callbacks.busy.clear()
    return SimpleNamespace(
        controller=controller,
        runner=runner,
        bridge=bridge,
        callbacks=callbacks,
    )


class ImportAndCopyTests(unittest.TestCase):
    def test_import_does_not_create_a_window(self):
        self.assertEqual(TK_CALLS, [])

    def test_defaults_are_empty_and_import_has_no_network_side_effect(self):
        confirmations = []
        opened_urls = []
        exits = []
        harness = controller_harness(
            confirm=confirmations.append,
            connect=False,
            url_opener=lambda url: opened_urls.append(url) or True,
            exit_application=lambda: exits.append(True),
        )

        self.assertEqual(GUI.LIVE_TELEMETRY_ENDPOINT_DEFAULT, "")
        self.assertEqual(GUI.LIVE_UPDATE_URL_DEFAULT, "")
        self.assertEqual(harness.bridge.calls, [])
        self.assertEqual(confirmations, [])
        self.assertEqual(opened_urls, [])
        self.assertEqual(exits, [])

        harness.controller.connect(lambda: harness.bridge)
        harness.runner.poll()
        self.assertEqual([call[0] for call in harness.bridge.calls], ["ping"])
        self.assertNotIn("allow_network", harness.bridge.calls[0][2])
        self.assertEqual(confirmations, [])
        self.assertEqual(opened_urls, [])
        self.assertEqual(exits, [])

    def test_wizard_has_four_steps_and_every_resource_name_has_an_explanation(self):
        self.assertEqual(len(GUI.STEP_TITLES), 4)
        self.assertEqual(
            GUI.STEP_TITLES,
            (
                "第一步：完成云端准备",
                "第二步：填写你的 CloudBase 信息",
                "第三步：发送测试数据",
                "第四步：验证版本更新",
            ),
        )
        self.assertEqual(
            [name for name, _explanation in GUI.RESOURCE_GUIDE],
            [
                "telemetry 云函数",
                "POST /v1/track",
                "telemetry_events",
                "ALLOWED_APP_IDS",
                "更新 JSON",
            ],
        )
        for name, explanation in GUI.RESOURCE_GUIDE:
            self.assertTrue(name.strip())
            self.assertGreater(len(explanation.strip()), 10)

    def test_primary_copy_uses_novice_terms_and_hides_protocol_vocabulary(self):
        primary = GUI.PRIMARY_UI_TEXT.lower()
        for forbidden in (
            "capture",
            "live",
            "transport",
            "bridge",
            "properties",
            "session_id",
            "schema",
            "semver",
            "endpoint",
            "event_id",
            "app_id",
            "rollout",
            "force_update",
        ):
            self.assertNotIn(forbidden, primary)
        for expected in (
            "应用编号",
            "当前版本",
            "数据接收地址",
            "更新文件地址",
            "发送一组测试数据到 cloudbase",
            "复制数据库查询条件",
        ):
            self.assertIn(expected, primary)

    def test_visible_settings_are_credential_free_and_examples_are_explicit(self):
        self.assertNotEqual(GUI.EXAMPLE_TELEMETRY_URL, "")
        self.assertNotEqual(GUI.EXAMPLE_UPDATE_URL, "")
        self.assertEqual(GUI.LIVE_TELEMETRY_ENDPOINT_DEFAULT, "")
        self.assertEqual(GUI.LIVE_UPDATE_URL_DEFAULT, "")
        primary = GUI.PRIMARY_UI_TEXT.lower()
        for forbidden in ("secret", "token", "password", "密钥输入", "口令输入"):
            self.assertNotIn(forbidden, primary)


class SettingsAndErrorTests(unittest.TestCase):
    def test_settings_are_trimmed_and_bridge_fields_do_not_contain_urls_or_credentials(self):
        settings = GUI.ConnectionSettings(
            " example-tool ",
            " 0.1.0 ",
            " https://cloud.example.com/v1/track ",
            " https://cloud.example.com/updates/example-tool/windows.json ",
        ).normalized()
        self.assertEqual(settings, VALID_SETTINGS)
        self.assertEqual(
            settings.bridge_fields(),
            {
                "app_id": "example-tool",
                "app_version": "0.1.0",
                "platform": "windows",
                "arch": "x64",
                "channel": "official",
            },
        )

    def test_validation_requires_complete_https_addresses(self):
        cases = (
            (GUI.ConnectionSettings("Bad App", "0.1.0", VALID_SETTINGS.telemetry_url, VALID_SETTINGS.update_url), "应用编号"),
            (GUI.ConnectionSettings("example-tool", "v1", VALID_SETTINGS.telemetry_url, VALID_SETTINGS.update_url), "当前版本"),
            (GUI.ConnectionSettings("example-tool", "0.1.0", "http://cloud.example.com/v1/track", VALID_SETTINGS.update_url), "https://"),
            (GUI.ConnectionSettings("example-tool", "0.1.0", "https://cloud.example.com/track", VALID_SETTINGS.update_url), "/v1/track"),
            (GUI.ConnectionSettings("example-tool", "0.1.0", VALID_SETTINGS.telemetry_url, "updates/windows.json"), "https://"),
            (GUI.ConnectionSettings("example-tool", "0.1.0", VALID_SETTINGS.telemetry_url, "https://cloud.example.com/updates/folder"), "windows.json"),
        )
        for settings, expected in cases:
            with self.subTest(expected=expected):
                message = GUI.validate_settings(
                    settings, require_telemetry=True, require_update=True
                )
                self.assertIsNotNone(message)
                self.assertIn(expected, message)

    def test_friendly_errors_cover_cloudbase_400_through_500(self):
        cases = (
            ({"http_status": 400, "code": "server_rejected"}, "格式不完整"),
            ({"http_status": 403, "server_error": "unknown_app"}, "ALLOWED_APP_IDS"),
            ({"http_status": 404, "server_error": "not_found"}, "/v1/track"),
            ({"http_status": 429, "server_error": "rate_limited"}, "发送太频繁"),
            ({"http_status": 500, "server_error": "internal_error"}, "暂时出错"),
            ({"code": "unsafe_endpoint"}, "https://"),
            ({"code": "timeout"}, "网络不可用"),
            ({"code": "invalid_response"}, "没有确认保存"),
        )
        for error, expected in cases:
            with self.subTest(error=error):
                self.assertIn(expected, GUI.friendly_error(error))


class BatchFeedbackTests(unittest.TestCase):
    def test_eight_acknowledged_receipts_make_eight_human_cards_and_queries(self):
        raw = batch_result(reverse=True)
        feedback = GUI.build_batch_feedback(raw)

        self.assertEqual(feedback.confirmed_count, 8)
        self.assertEqual(feedback.expected_count, 8)
        self.assertEqual(feedback.tone, "success")
        self.assertIn("8 条", feedback.summary)
        self.assertEqual(
            [card.event_name for card in feedback.cards],
            list(GUI.EXPECTED_EVENT_ORDER),
        )
        self.assertEqual(
            [card.title for card in feedback.cards],
            [GUI.EVENT_NAMES[name] for name in GUI.EXPECTED_EVENT_ORDER],
        )
        for index, card in enumerate(feedback.cards, start=1):
            self.assertTrue(card.acknowledged)
            self.assertNotIn(card.event_name, card.title)
            self.assertEqual(card.event_id, event_id(index))
            self.assertEqual(
                json.loads(card.query_text), {"event_id": event_id(index)}
            )
        self.assertEqual(
            json.loads(feedback.batch_query_text),
            {"session_id": raw["session_id"]},
        )
        self.assertIs(feedback.advanced, raw)

    def test_partial_failures_keep_successes_and_translate_each_failed_card(self):
        raw = batch_result(
            failures={
                "task_failed": {
                    "code": "server_rejected",
                    "http_status": 403,
                    "server_error": "unknown_app",
                },
                "update_clicked": {
                    "code": "server_rejected",
                    "http_status": 404,
                    "server_error": "not_found",
                },
            }
        )
        feedback = GUI.build_batch_feedback(raw)

        self.assertEqual(feedback.confirmed_count, 6)
        self.assertEqual(feedback.expected_count, 8)
        self.assertEqual(feedback.tone, "warning")
        self.assertIn("6 条", feedback.summary)
        cards = {card.event_name: card for card in feedback.cards}
        self.assertIn("ALLOWED_APP_IDS", cards["task_failed"].detail)
        self.assertIn("/v1/track", cards["update_clicked"].detail)
        self.assertFalse(cards["task_failed"].acknowledged)
        self.assertTrue(cards["feature_used"].acknowledged)
        self.assertEqual(
            json.loads(cards["task_failed"].query_text),
            {"event_id": cards["task_failed"].event_id},
        )

    def test_old_http_or_sdk_acceptance_signals_never_count_as_database_success(self):
        raw = batch_result()
        for item in raw["deliveries"]:
            item.pop("acknowledged")
            item["accepted_by_sdk"] = True
            item["transport_result"] = "http_ok"
        feedback = GUI.build_batch_feedback(raw)
        self.assertEqual(feedback.confirmed_count, 0)
        self.assertEqual(feedback.tone, "error")
        self.assertTrue(all(not card.acknowledged for card in feedback.cards))

    def test_bridge_level_failure_returns_all_eight_failed_cards(self):
        feedback = GUI.failed_batch_feedback(
            GUI.BridgeError("bridge_unavailable", "helper closed")
        )
        self.assertEqual(feedback.confirmed_count, 0)
        self.assertEqual(len(feedback.cards), 8)
        self.assertTrue(all(card.query_text is None for card in feedback.cards))
        self.assertTrue(all("重新打开" in card.detail for card in feedback.cards))


class ControllerBatchTests(unittest.TestCase):
    def test_invalid_or_cancelled_send_never_reaches_network_action(self):
        confirmations = []
        harness = controller_harness(
            confirm=lambda value: confirmations.append(value) or False
        )
        invalid = GUI.ConnectionSettings(
            "example-tool", "0.1.0", "", VALID_SETTINGS.update_url
        )
        self.assertFalse(harness.controller.send_test_batch(invalid))
        self.assertEqual(confirmations, [])
        self.assertEqual(harness.bridge.calls, [])

        self.assertFalse(harness.controller.send_test_batch(VALID_SETTINGS))
        self.assertEqual(len(confirmations), 1)
        self.assertEqual(confirmations[0].host, "cloud.example.com")
        self.assertEqual(len(confirmations[0].record_names), 8)
        self.assertIn("8 条匿名样例", confirmations[0].explanation)
        self.assertEqual(harness.bridge.calls, [])
        self.assertIn("没有向 CloudBase 发送", harness.callbacks.messages[-1][2])

    def test_one_approval_submits_one_batch_with_a_fresh_state_directory(self):
        confirmations = []
        harness = controller_harness(
            confirm=lambda value: confirmations.append(value) or True
        )

        self.assertTrue(harness.controller.send_test_batch(VALID_SETTINGS))
        harness.runner.poll()
        self.assertEqual(len(confirmations), 1)
        self.assertEqual([call[0] for call in harness.bridge.calls], ["send_test_batch"])
        _action, timeout, payload, _thread = harness.bridge.calls[0]
        self.assertEqual(timeout, 45)
        self.assertEqual(payload["endpoint"], VALID_SETTINGS.telemetry_url)
        self.assertIs(payload["allow_network"], True)
        self.assertEqual(payload["confirmation"], "POST")
        self.assertNotIn("secret", payload)
        self.assertNotIn("token", payload)
        first_state = Path(payload["state_dir"])
        self.assertEqual(first_state.parent, GUI.DEFAULT_STATE_ROOT.resolve())
        self.assertTrue(first_state.name.startswith("batch-"))
        self.assertEqual(
            harness.callbacks.progress,
            list(zip(GUI.PROGRESS_STAGES, (25, 50, 75, 100))),
        )
        self.assertEqual(harness.callbacks.batches[-1].confirmed_count, 8)

        harness.controller.send_test_batch(VALID_SETTINGS)
        harness.runner.poll()
        second_state = Path(harness.bridge.calls[1][2]["state_dir"])
        self.assertNotEqual(first_state, second_state)
        self.assertEqual(len(confirmations), 2)

    def test_slow_batch_returns_without_freezing_and_delivers_on_owner_poll(self):
        owner_thread = threading.get_ident()
        callback_threads = []
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        harness = controller_harness(
            executor=executor,
            connect=False,
            confirm=lambda _value: True,
        )
        harness.controller._bridge = harness.bridge
        harness.controller.helper_status = "ready"
        harness.bridge.block_action = "send_test_batch"
        harness.controller.on_batch = lambda feedback: (
            callback_threads.append(threading.get_ident()),
            harness.callbacks.batches.append(feedback),
        )
        try:
            before = time.monotonic()
            submitted = harness.controller.send_test_batch(VALID_SETTINGS)
            elapsed = time.monotonic() - before
            self.assertTrue(submitted)
            self.assertLess(elapsed, 0.5)
            self.assertTrue(harness.bridge.block_started.wait(timeout=1))
            self.assertTrue(harness.runner.busy)
            self.assertNotEqual(harness.bridge.calls[0][3], owner_thread)

            harness.bridge.block_release.set()
            deadline = time.monotonic() + 2
            while harness.runner.busy and time.monotonic() < deadline:
                harness.runner.poll()
                time.sleep(0.01)
            self.assertFalse(harness.runner.busy)
            self.assertEqual(callback_threads, [owner_thread])
            self.assertEqual(harness.callbacks.batches[-1].confirmed_count, 8)
        finally:
            harness.runner.stop_accepting()
            executor.shutdown(wait=True, cancel_futures=True)


class SimulationFeedbackTests(unittest.TestCase):
    def test_ten_unique_bridge_identities_drive_acknowledged_statistics(self):
        raw = simulation_result()
        installs = [device["install_id"] for device in raw["devices"]]
        sessions = [device["session_id"] for device in raw["devices"]]
        self.assertEqual(len(set(installs)), 10)
        self.assertEqual(len(set(sessions)), 10)
        self.assertTrue(set(installs).isdisjoint(sessions))

        feedback = GUI.build_simulation_feedback(raw)
        self.assertEqual(feedback.device_count, 10)
        self.assertEqual(feedback.planned_device_count, 10)
        self.assertEqual(feedback.acknowledged_record_count, 50)
        self.assertEqual(feedback.planned_record_count, 50)
        self.assertEqual(feedback.failed_record_count, 0)
        self.assertEqual(feedback.install_count, 10)
        self.assertEqual(feedback.start_count, 10)
        self.assertEqual(feedback.feature_count, 10)
        self.assertEqual(feedback.task_success_count, 7)
        self.assertEqual(feedback.task_failure_count, 3)
        self.assertEqual(feedback.task_success_rate, 70)
        self.assertEqual(
            feedback.version_distribution, (("0.1.0", 5), ("0.2.0", 5))
        )
        self.assertEqual(
            feedback.channel_distribution,
            (("哔哩哔哩渠道", 3), ("官方渠道", 4), ("微信渠道", 3)),
        )
        expected_ids = [
            receipt["event_id"]
            for device in raw["devices"]
            for receipt in device["deliveries"]
        ]
        self.assertEqual(
            json.loads(feedback.filter_text),
            {"event_id": {"$in": expected_ids}},
        )
        self.assertIs(feedback.advanced, raw)

    def test_simulation_ignores_old_http_success_without_explicit_ack(self):
        devices = simulation_devices()
        for device in devices:
            for receipt in device["deliveries"]:
                receipt.pop("acknowledged")
                receipt["accepted_by_sdk"] = True
                receipt["transport_result"] = "http_ok"
        feedback = GUI.build_simulation_feedback(simulation_result(devices))
        self.assertEqual(feedback.device_count, 0)
        self.assertEqual(feedback.acknowledged_record_count, 0)
        self.assertEqual(feedback.failed_record_count, 50)
        self.assertIsNone(feedback.filter_text)
        self.assertEqual(feedback.tone, "error")

    def test_all_failed_simulations_surface_the_first_receipt_action(self):
        cases = (
            (
                {"http_status": 403, "server_error": "unknown_app"},
                ("允许名单", "ALLOWED_APP_IDS"),
            ),
            (
                {"http_status": 404, "server_error": "not_found"},
                ("/v1/track", "HTTP 路由"),
            ),
            (
                {"http_status": 429, "server_error": "rate_limited"},
                ("等待一分钟",),
            ),
            (
                {"code": "network_error"},
                ("部署", "网络"),
            ),
        )
        for error, expected_fragments in cases:
            with self.subTest(error=error):
                devices = simulation_devices()
                for device in devices:
                    for receipt in device["deliveries"]:
                        receipt["acknowledged"] = False
                        receipt["error"] = dict(error)
                feedback = GUI.build_simulation_feedback(
                    simulation_result(devices)
                )
                self.assertEqual(feedback.device_count, 0)
                self.assertEqual(feedback.acknowledged_record_count, 0)
                self.assertEqual(feedback.failed_record_count, 50)
                self.assertEqual(feedback.tone, "error")
                self.assertIsNone(feedback.filter_text)
                for fragment in expected_fragments:
                    self.assertIn(fragment, feedback.detail)

    def test_partial_simulation_excludes_every_unacknowledged_record(self):
        devices = simulation_devices()
        for receipt in devices[9]["deliveries"]:
            receipt["acknowledged"] = False
            receipt["error"] = {"http_status": 500, "code": "server_rejected"}
        failed_task = next(
            receipt
            for receipt in devices[0]["deliveries"]
            if receipt["event"] == "task_succeeded"
        )
        failed_task["acknowledged"] = False
        failed_task["error"] = {"http_status": 403, "server_error": "unknown_app"}

        feedback = GUI.build_simulation_feedback(simulation_result(devices))
        self.assertEqual(feedback.device_count, 9)
        self.assertEqual(feedback.acknowledged_record_count, 44)
        self.assertEqual(feedback.planned_record_count, 50)
        self.assertEqual(feedback.failed_record_count, 6)
        self.assertEqual(feedback.install_count, 9)
        self.assertEqual(feedback.start_count, 9)
        self.assertEqual(feedback.task_success_count, 6)
        self.assertEqual(feedback.task_failure_count, 2)
        self.assertEqual(feedback.task_success_rate, 75)
        self.assertEqual(
            feedback.version_distribution, (("0.1.0", 5), ("0.2.0", 4))
        )
        filtered_ids = json.loads(feedback.filter_text)["event_id"]["$in"]
        self.assertNotIn(failed_task["event_id"], filtered_ids)
        for receipt in devices[9]["deliveries"]:
            self.assertNotIn(receipt["event_id"], filtered_ids)
        self.assertEqual(len(filtered_ids), 44)
        self.assertEqual(feedback.tone, "warning")
        self.assertIn("44/50", feedback.summary)
        self.assertIn("失败 6 条", feedback.detail)
        self.assertIn("处理建议", feedback.detail)
        self.assertIn("ALLOWED_APP_IDS", feedback.detail)

    def test_simulation_model_contains_no_account_or_real_device_fields(self):
        raw = simulation_result()
        allowed_device_keys = {
            "install_id",
            "session_id",
            "app_version",
            "channel",
            "arch",
            "deliveries",
        }
        for device in raw["devices"]:
            self.assertEqual(set(device), allowed_device_keys)
        serialized = json.dumps(raw, ensure_ascii=False).lower()
        for forbidden in (
            "username",
            "account_id",
            "email",
            "phone",
            "hostname",
            "machine_id",
            "hardware",
            "mac_address",
            "file_path",
            "url_content",
            "credential",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_controller_simulation_confirms_once_and_leaves_identity_to_bridge(self):
        confirmations = []
        harness = controller_harness(
            confirm=lambda value: confirmations.append(value) or True
        )
        self.assertTrue(harness.controller.simulate_devices(VALID_SETTINGS))
        harness.runner.poll()

        self.assertEqual(len(confirmations), 1)
        confirmation = confirmations[0]
        self.assertEqual(confirmation.host, "cloud.example.com")
        self.assertIn("10 台设备", confirmation.explanation)
        self.assertIn("不是真实账号", confirmation.explanation)
        self.assertEqual([call[0] for call in harness.bridge.calls], ["simulate_devices"])
        _action, timeout, payload, _thread = harness.bridge.calls[0]
        self.assertEqual(timeout, 60)
        self.assertEqual(payload["device_count"], 10)
        self.assertIs(payload["allow_network"], True)
        self.assertEqual(payload["confirmation"], "POST")
        self.assertNotIn("install_id", payload)
        self.assertNotIn("session_id", payload)
        self.assertTrue(Path(payload["state_dir"]).name.startswith("simulation-"))
        self.assertEqual(harness.callbacks.simulations[-1].device_count, 10)
        self.assertEqual(
            harness.callbacks.progress,
            list(zip(GUI.PROGRESS_STAGES, (25, 50, 75, 100))),
        )

    def test_cancelled_simulation_does_not_call_bridge(self):
        confirmations = []
        harness = controller_harness(
            confirm=lambda value: confirmations.append(value) or False
        )
        self.assertFalse(harness.controller.simulate_devices(VALID_SETTINGS))
        self.assertEqual(len(confirmations), 1)
        self.assertEqual(harness.bridge.calls, [])
        self.assertEqual(harness.callbacks.simulations, [])
        self.assertIn("没有向 CloudBase 发送", harness.callbacks.messages[-1][2])


class UpdateFeedbackTests(unittest.TestCase):
    def test_update_errors_explain_static_hosting_without_telemetry_advice(self):
        cases = (
            (
                {"http_status": 404, "server_error": "not_found"},
                ("静态托管", "windows.json"),
            ),
            (
                {"http_status": 403, "server_error": "forbidden"},
                ("公开", "权限"),
            ),
            ({"code": "network_error"}, ("完整更新文件地址", "网络")),
            ({"code": "timeout"}, ("完整更新文件地址", "网络")),
            (
                {"http_status": 500, "server_error": "internal_error"},
                ("静态托管暂时不可用",),
            ),
        )
        for error, expected_fragments in cases:
            with self.subTest(error=error):
                translated = GUI.friendly_update_error(error)
                for fragment in expected_fragments:
                    self.assertIn(fragment, translated)
                self.assertNotIn("/v1/track", translated)
                self.assertNotIn("ALLOWED_APP_IDS", translated)

                feedback = GUI.build_update_feedback(
                    update_result(
                        "none", reason="unavailable", diagnostic=error
                    ),
                    "0.1.0",
                )
                self.assertEqual(feedback.state, "error")
                self.assertEqual(feedback.detail, translated)
                self.assertNotIn("/v1/track", feedback.detail)
                self.assertNotIn("ALLOWED_APP_IDS", feedback.detail)

    def test_controller_update_failures_use_update_file_error_translation(self):
        cases = (
            ("not_found", "静态托管", "windows.json"),
            ("forbidden", "公开", "权限"),
            ("network_error", "完整更新文件地址", "网络"),
        )
        for code, first_fragment, second_fragment in cases:
            with self.subTest(code=code):
                harness = controller_harness()
                harness.bridge.fail_action = "check_update_url"
                harness.bridge.fail_code = code
                harness.bridge.fail_message = "controlled request failure"

                self.assertTrue(
                    harness.controller.check_for_updates(VALID_SETTINGS)
                )
                harness.runner.poll()

                self.assertEqual(len(harness.callbacks.updates), 1)
                feedback = harness.callbacks.updates[0]
                self.assertEqual(feedback.state, "error")
                self.assertIn(first_fragment, feedback.detail)
                self.assertIn(second_fragment, feedback.detail)
                self.assertNotIn("/v1/track", feedback.detail)
                self.assertNotIn("ALLOWED_APP_IDS", feedback.detail)

    def test_update_states_are_presented_in_plain_chinese(self):
        cases = (
            (update_result("optional"), "optional_update", "发现新版本", "optional"),
            (update_result("required", config=update_config(force_update=True)), "required_update", "停止支持", "required"),
            (update_result("none", reason="up_to_date", config=update_config(latest_version="0.1.0", min_supported_version="0.1.0")), "up_to_date", "已经是最新版", None),
            (update_result("none", reason="disabled", config=update_config(enabled=False)), "paused", "已暂停", None),
            (update_result("none", reason="rollout", config=update_config(rollout=0)), "not_selected", "发布范围", None),
            (update_result("none", reason="invalid_config"), "invalid_file", "内容需要检查", None),
            (update_result("none", reason="unavailable", diagnostic={"code": "network_error"}), "error", "无法检查更新", None),
        )
        for raw, state, summary, dialog_mode in cases:
            with self.subTest(state=state):
                feedback = GUI.build_update_feedback(raw, "0.1.0")
                self.assertEqual(feedback.state, state)
                self.assertIn(summary, feedback.summary)
                self.assertEqual(feedback.current_version, "0.1.0")
                self.assertEqual(feedback.dialog_mode, dialog_mode)
                self.assertIs(feedback.advanced, raw)

    def test_available_updates_expose_download_and_required_exit_copy(self):
        optional = GUI.build_update_feedback(update_result("optional"), "0.1.0")
        required = GUI.build_update_feedback(
            update_result("required", config=update_config(force_update=True)),
            "0.1.0",
        )
        self.assertEqual(optional.latest_version, "0.2.0")
        self.assertEqual(optional.primary_button, "立即更新")
        self.assertEqual(optional.secondary_button, "稍后提醒")
        self.assertTrue(optional.download_url.startswith("https://"))
        self.assertEqual(required.latest_version, "0.2.0")
        self.assertEqual(required.primary_button, "立即更新")
        self.assertEqual(required.secondary_button, "退出软件")

    def test_each_update_click_makes_a_fresh_request_without_opening_download(self):
        opened = []
        harness = controller_harness(url_opener=lambda url: opened.append(url) or True)

        for _ in range(2):
            self.assertTrue(harness.controller.check_for_updates(VALID_SETTINGS))
            harness.runner.poll()
        self.assertEqual(
            [call[0] for call in harness.bridge.calls],
            ["check_update_url", "check_update_url"],
        )
        for _action, timeout, payload, _thread in harness.bridge.calls:
            self.assertEqual(timeout, 35)
            self.assertEqual(payload["update_url"], VALID_SETTINGS.update_url)
            self.assertIs(payload["allow_network"], True)
            self.assertEqual(payload["confirmation"], "GET")
            self.assertEqual(
                Path(payload["state_dir"]),
                GUI.DEFAULT_STATE_ROOT.resolve() / "update-check-identity",
            )
        self.assertEqual(opened, [])
        self.assertEqual(len(harness.callbacks.updates), 2)
        self.assertTrue(
            all("每次点击都会重新请求" in message[2] for message in harness.callbacks.messages)
        )

    def test_download_and_required_exit_are_explicit_injected_actions(self):
        opened = []
        exits = []
        harness = controller_harness(
            url_opener=lambda url: opened.append(url) or True,
            exit_application=lambda: exits.append("exit"),
        )
        optional = GUI.build_update_feedback(update_result("optional"), "0.1.0")

        self.assertEqual(opened, [])
        self.assertEqual(exits, [])
        self.assertTrue(harness.controller.open_update_download(optional))
        self.assertEqual(opened, [optional.download_url])
        self.assertEqual(exits, [])
        harness.controller.exit_for_required_update()
        self.assertEqual(exits, ["exit"])

        no_update = GUI.build_update_feedback(
            update_result("none", reason="up_to_date"), "0.1.0"
        )
        self.assertFalse(harness.controller.open_update_download(no_update))
        self.assertEqual(opened, [optional.download_url])

    def test_optional_update_actions_open_only_for_primary(self):
        feedback = GUI.build_update_feedback(update_result("optional"), "0.1.0")
        for action, expected_open_count in (
            ("primary", 1),
            ("secondary", 0),
            ("close", 0),
        ):
            with self.subTest(action=action):
                opens = []
                exits = []
                handled = GUI.handle_update_action(
                    feedback,
                    action,
                    lambda: opens.append("open") or True,
                    lambda: exits.append("exit"),
                )
                self.assertTrue(handled)
                self.assertEqual(len(opens), expected_open_count)
                self.assertEqual(exits, [])

    def test_required_update_action_keeps_window_when_download_cannot_open(self):
        feedback = GUI.build_update_feedback(
            update_result("required", config=update_config(force_update=True)),
            "0.1.0",
        )
        openers = (
            ("returns false", lambda: False),
            (
                "raises",
                lambda: (_ for _ in ()).throw(RuntimeError("browser unavailable")),
            ),
        )
        for label, opener in openers:
            with self.subTest(opener=label):
                exits = []
                errors = []
                self.assertFalse(
                    GUI.handle_update_action(
                        feedback,
                        "primary",
                        opener,
                        lambda: exits.append("exit"),
                        errors.append,
                    )
                )
                self.assertEqual(errors, [GUI.UPDATE_DOWNLOAD_ERROR])
                self.assertEqual(
                    errors,
                    ["没有打开下载页面，请检查默认浏览器。"],
                )
                self.assertEqual(exits, [])

    def test_required_update_primary_opens_then_exits_and_other_closes_exit(self):
        feedback = GUI.build_update_feedback(
            update_result("required", config=update_config(force_update=True)),
            "0.1.0",
        )
        for action, expected_opens in (
            ("primary", ["open"]),
            ("secondary", []),
            ("close", []),
        ):
            with self.subTest(action=action):
                opens = []
                exits = []
                handled = GUI.handle_update_action(
                    feedback,
                    action,
                    lambda: opens.append("open") or True,
                    lambda: exits.append("exit"),
                )
                self.assertTrue(handled)
                self.assertEqual(opens, expected_opens)
                self.assertEqual(exits, ["exit"])


class CloseTests(unittest.TestCase):
    def test_close_unblocks_a_running_request_without_delivering_result(self):
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        harness = controller_harness(
            executor=executor,
            connect=False,
            confirm=lambda _value: True,
        )
        harness.controller._bridge = harness.bridge
        harness.controller.helper_status = "ready"
        harness.bridge.block_action = "send_test_batch"
        try:
            harness.controller.send_test_batch(VALID_SETTINGS)
            self.assertTrue(harness.bridge.block_started.wait(timeout=1))
            closer = harness.controller.begin_close()
            self.assertIsNotNone(closer)
            closer.join(timeout=1)
            self.assertFalse(closer.is_alive())
            deadline = time.monotonic() + 1
            while harness.runner.busy and time.monotonic() < deadline:
                harness.runner.poll()
                time.sleep(0.01)
            self.assertFalse(harness.runner.busy)
            self.assertTrue(harness.bridge.closed)
            self.assertEqual(harness.callbacks.batches, [])
        finally:
            executor.shutdown(wait=True, cancel_futures=True)


if __name__ == "__main__":
    unittest.main()
