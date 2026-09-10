import concurrent.futures
import copy
import importlib.util
import json
import sys
import threading
import time
import unittest
from dataclasses import replace
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
    application_id="bifang-tools",
    application_code="bifang-tools-windows-x64",
    current_version="0.1.0",
    telemetry_url="https://cloud.example.com/apps/bifang-tools/v1/track",
    version_base_url="https://cloud.example.com/tools/version-control/v1",
    app_key="runtime-key",
    app_secret="runtime-secret",
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
        "install_id": "30000000-0000-4000-8000-000000000001",
        "platform": "windows",
        "arch": "x64",
        "deliveries": deliveries,
    }


def application_version_data(**overrides):
    value = {
        "update": True,
        "downloadUrl": "https://downloads.example.com/bifang-tools-0.2.0.exe",
        "promptContent": "A tested update is available.",
        "forcedUpdate": False,
        "promptUpdate": True,
        "stopUpdate": False,
        "updateContent": "<p>Tested release notes</p>",
    }
    value.update(overrides)
    return value


def update_result(kind="optional", *, reason=None, data=None, diagnostic=None):
    data = application_version_data() if data is None else data
    decision = {"kind": kind}
    if kind in {"optional", "required", "stopped"}:
        decision["data"] = data
    elif reason is not None:
        decision["reason"] = reason
    value = {"decision": decision}
    if diagnostic is not None:
        value["fetch_diagnostic"] = diagnostic
    return value


def simulation_devices():
    """Ten bridge-shaped anonymous devices with one daily-active record each."""
    devices = []
    plans = (
        ("windows", "x64"),
        ("windows", "x64"),
        ("windows", "arm64"),
        ("windows", "ia32"),
        ("macos", "x64"),
        ("macos", "arm64"),
        ("linux", "x64"),
        ("linux", "arm64"),
        ("linux", "x64"),
        ("windows", "x64"),
    )
    for index in range(10):
        system, architecture = plans[index]
        devices.append(
            {
                "device_number": index + 1,
                "install_id": identity_id(index + 1),
                "app_version": "0.1.0",
                "platform": system,
                "arch": architecture,
                "deliveries": [delivery("daily_active", 100 + index)],
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
            "ping": {"sdk_version": "3.0.0", "network_performed": False},
            "send_daily_active": batch_result(),
            "simulate_devices": simulation_result(),
            "check_application_version": update_result(),
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
        daily_actives=[],
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
        on_daily_active=callbacks.daily_actives.append,
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
        callbacks.daily_actives.clear()
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
        self.assertEqual(GUI.LIVE_VERSION_BASE_URL_DEFAULT, "")
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

    def test_quickstart_button_opens_the_current_feishu_document_directly(self):
        opened_urls = []
        messages = []
        application = object.__new__(GUI.CloudBaseWizardApplication)
        application.resource_opener = lambda url: opened_urls.append(url) or True
        application._show_message = lambda *parts: messages.append(parts)

        application._open_quickstart()

        self.assertEqual(
            GUI.QUICKSTART_DOCUMENT_URL,
            "https://my.feishu.cn/docx/CQEsdn73moXxM1xKvT9cDnZKnRg",
        )
        self.assertEqual(opened_urls, [GUI.QUICKSTART_DOCUMENT_URL])
        self.assertEqual(messages, [])

    def test_quickstart_open_failure_shows_a_copyable_feishu_link(self):
        messages = []
        application = object.__new__(GUI.CloudBaseWizardApplication)
        application.resource_opener = lambda _url: False
        application._show_message = lambda *parts: messages.append(parts)

        application._open_quickstart()

        self.assertEqual(len(messages), 1)
        self.assertIn("飞书", messages[0][1])
        self.assertIn(GUI.QUICKSTART_DOCUMENT_URL, messages[0][2])

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
                "telemetry-<应用编号> 云函数",
                "POST /apps/<应用编号>/v1/track",
                "telemetry_<规范化应用编号>",
                "三个独立函数参数",
                "application-version API v1",
            ],
        )
        for name, explanation in GUI.RESOURCE_GUIDE:
            self.assertTrue(name.strip())
            self.assertGreater(len(explanation.strip()), 10)

    def test_primary_copy_explains_the_new_api_without_old_protocol_vocabulary(self):
        primary = GUI.PRIMARY_UI_TEXT.lower()
        for forbidden in (
            "capture",
            "live",
            "transport",
            "bridge",
            "properties",
            "session_id",
            "channel",
            "schema",
            "semver",
            "endpoint",
            "event_id",
            "app_id",
        ):
            self.assertNotIn(forbidden, primary)
        for expected in (
            "打开飞书新手部署文档",
            "应用编号",
            "发布流 code",
            "当前版本",
            "数据接收地址",
            "版本 api base url",
            "x-app-key",
            "x-app-secret",
            "发送 1 条启动使用测试到 cloudbase",
            "复制数据库查询条件",
        ):
            self.assertIn(expected, primary)

    def test_examples_are_non_sensitive_and_live_credentials_default_empty(self):
        self.assertNotEqual(GUI.EXAMPLE_TELEMETRY_URL, "")
        self.assertNotEqual(GUI.EXAMPLE_VERSION_BASE_URL, "")
        self.assertIn("/apps/bifang-tools/v1/track", GUI.EXAMPLE_TELEMETRY_URL)
        self.assertTrue(
            GUI.EXAMPLE_VERSION_BASE_URL.endswith("/tools/version-control/v1")
        )
        self.assertEqual(GUI.LIVE_TELEMETRY_ENDPOINT_DEFAULT, "")
        self.assertEqual(GUI.LIVE_VERSION_BASE_URL_DEFAULT, "")
        self.assertNotIn("runtime-key", GUI.PRIMARY_UI_TEXT)
        self.assertNotIn("runtime-secret", GUI.PRIMARY_UI_TEXT)


class SettingsAndErrorTests(unittest.TestCase):
    def test_collection_and_database_path_are_derived_per_app(self):
        self.assertEqual(
            GUI.telemetry_collection_name("bifang-tools-pdf"),
            "telemetry_bifang_tools_pdf",
        )
        self.assertIn(
            "telemetry_bifang_tools_pdf",
            GUI.database_path_for_app("bifang-tools-pdf"),
        )
        with self.assertRaises(ValueError):
            GUI.telemetry_collection_name("bifang_tools_pdf")

    def test_settings_are_trimmed_and_telemetry_fields_exclude_urls_and_credentials(self):
        settings = GUI.ConnectionSettings(
            application_id=" bifang-tools ",
            application_code=" bifang-tools-windows-x64 ",
            current_version=" 0.1.0 ",
            telemetry_url=" https://cloud.example.com/apps/bifang-tools/v1/track ",
            version_base_url=" https://cloud.example.com/tools/version-control/v1 ",
            app_key="runtime-key",
            app_secret="runtime-secret",
        ).normalized()
        self.assertEqual(settings, VALID_SETTINGS)
        self.assertEqual(
            settings.bridge_fields(),
            {
                "app_id": "bifang-tools",
                "app_version": "0.1.0",
                "platform": "windows",
                "arch": "x64",
            },
        )
        self.assertEqual(
            settings.application_version_fields(),
            {
                "application_code": "bifang-tools-windows-x64",
                "current_version": "0.1.0",
                "version_base_url": "https://cloud.example.com/tools/version-control/v1",
                "app_key": "runtime-key",
                "app_secret": "runtime-secret",
            },
        )
        self.assertNotIn("runtime-key", repr(settings))
        self.assertNotIn("runtime-secret", repr(settings))

    def test_validation_requires_complete_https_addresses(self):
        cases = (
            (replace(VALID_SETTINGS, application_id="Bad App"), "应用编号"),
            (replace(VALID_SETTINGS, application_id="bad_app"), "应用编号"),
            (replace(VALID_SETTINGS, current_version="v1"), "当前版本"),
            (replace(VALID_SETTINGS, telemetry_url="http://cloud.example.com/apps/bifang-tools/v1/track"), "https://"),
            (replace(VALID_SETTINGS, telemetry_url="https://cloud.example.com/v1/track"), "/apps/bifang-tools/v1/track"),
            (replace(VALID_SETTINGS, application_code="bad/code"), "发布流 code"),
            (replace(VALID_SETTINGS, version_base_url="tools/version-control/v1"), "https://"),
            (replace(VALID_SETTINGS, version_base_url="https://cloud.example.com/tools/version-control/v1/v1"), "v1 只能出现一次"),
            (replace(VALID_SETTINGS, version_base_url="https://cloud.example.com/tools/version-control/v1?debug=1"), "v1 只能出现一次"),
            (replace(VALID_SETTINGS, app_key=""), "x-app-key"),
            (replace(VALID_SETTINGS, app_secret=" secret"), "x-app-secret"),
        )
        for settings, expected in cases:
            with self.subTest(expected=expected):
                message = GUI.validate_settings(
                    settings, require_telemetry=True, require_version=True
                )
                self.assertIsNotNone(message)
                self.assertIn(expected, message)

        version_only = replace(VALID_SETTINGS, current_version="01.2.0.0")
        self.assertIsNone(
            GUI.validate_settings(
                version_only, require_telemetry=False, require_version=True
            )
        )

    def test_friendly_errors_cover_cloudbase_400_through_500(self):
        cases = (
            ({"http_status": 400, "code": "server_rejected"}, "格式不完整"),
            ({"http_status": 403, "server_error": "unknown_app"}, "ALLOWED_APP_IDS"),
            ({"http_status": 404, "server_error": "not_found"}, "/apps/<应用编号>/v1/track"),
            ({"http_status": 429, "server_error": "rate_limited"}, "发送太频繁"),
            ({"http_status": 500, "server_error": "internal_error"}, "暂时出错"),
            ({"code": "unsafe_endpoint"}, "https://"),
            ({"code": "timeout"}, "网络不可用"),
            ({"code": "invalid_response"}, "没有确认保存"),
        )
        for error, expected in cases:
            with self.subTest(error=error):
                self.assertIn(expected, GUI.friendly_error(error))


class DailyActiveFeedbackTests(unittest.TestCase):
    def test_one_acknowledged_receipt_makes_one_human_card_and_query(self):
        raw = batch_result()
        feedback = GUI.build_daily_active_feedback(raw)

        self.assertEqual(feedback.confirmed_count, 1)
        self.assertEqual(feedback.expected_count, 1)
        self.assertEqual(feedback.tone, "success")
        self.assertIn("1 条启动使用", feedback.summary)
        self.assertEqual(len(feedback.cards), 1)
        card = feedback.cards[0]
        self.assertEqual(card.event_name, "daily_active")
        self.assertEqual(card.title, "启动使用记录")
        self.assertTrue(card.acknowledged)
        self.assertEqual(json.loads(card.query_text), {"event_id": event_id(1)})
        self.assertEqual(
            json.loads(feedback.record_query_text), {"event_id": event_id(1)}
        )
        self.assertIn("来源 IP", feedback.detail)
        self.assertIs(feedback.advanced, raw)

    def test_old_http_signal_does_not_count_as_database_success(self):
        raw = batch_result()
        raw["deliveries"][0].pop("acknowledged")
        raw["deliveries"][0]["transport_result"] = "http_ok"
        feedback = GUI.build_daily_active_feedback(raw)
        self.assertEqual(feedback.confirmed_count, 0)
        self.assertEqual(feedback.tone, "error")

    def test_bridge_level_failure_returns_one_failed_card(self):
        feedback = GUI.failed_daily_active_feedback(
            GUI.BridgeError("bridge_unavailable", "helper closed")
        )
        self.assertEqual(feedback.confirmed_count, 0)
        self.assertEqual(feedback.expected_count, 1)
        self.assertEqual(len(feedback.cards), 1)
        self.assertIsNone(feedback.cards[0].query_text)
        self.assertIn("重新打开", feedback.cards[0].detail)


class ControllerDailyActiveTests(unittest.TestCase):
    def test_invalid_or_cancelled_send_never_reaches_network_action(self):
        confirmations = []
        harness = controller_harness(
            confirm=lambda value: confirmations.append(value) or False
        )
        invalid = replace(VALID_SETTINGS, telemetry_url="")
        self.assertFalse(harness.controller.send_daily_active(invalid))
        self.assertEqual(confirmations, [])
        self.assertEqual(harness.bridge.calls, [])

        self.assertFalse(harness.controller.send_daily_active(VALID_SETTINGS))
        self.assertEqual(len(confirmations), 1)
        self.assertEqual(confirmations[0].host, "cloud.example.com")
        self.assertEqual(confirmations[0].record_names, ("1 条启动使用记录",))
        self.assertIn("只发送 1 个 POST", confirmations[0].explanation)
        self.assertIn("来源 IP", confirmations[0].explanation)
        self.assertEqual(harness.bridge.calls, [])
        self.assertIn("没有向 CloudBase 发送", harness.callbacks.messages[-1][2])

    def test_one_approval_submits_one_post_with_a_fresh_state_directory(self):
        confirmations = []
        harness = controller_harness(
            confirm=lambda value: confirmations.append(value) or True
        )

        self.assertTrue(harness.controller.send_daily_active(VALID_SETTINGS))
        harness.runner.poll()
        self.assertEqual(len(confirmations), 1)
        self.assertEqual([call[0] for call in harness.bridge.calls], ["send_daily_active"])
        _action, timeout, payload, _thread = harness.bridge.calls[0]
        self.assertEqual(timeout, 45)
        self.assertEqual(payload["endpoint"], VALID_SETTINGS.telemetry_url)
        self.assertIs(payload["allow_network"], True)
        self.assertEqual(payload["confirmation"], "POST")
        self.assertNotIn("secret", payload)
        self.assertNotIn("token", payload)
        first_state = Path(payload["state_dir"])
        self.assertEqual(first_state.parent, GUI.DEFAULT_STATE_ROOT.resolve())
        self.assertTrue(first_state.name.startswith("daily-active-"))
        self.assertEqual(
            harness.callbacks.progress,
            list(zip(GUI.PROGRESS_STAGES, (25, 50, 75, 100))),
        )
        self.assertEqual(harness.callbacks.daily_actives[-1].confirmed_count, 1)

        harness.controller.send_daily_active(VALID_SETTINGS)
        harness.runner.poll()
        second_state = Path(harness.bridge.calls[1][2]["state_dir"])
        self.assertNotEqual(first_state, second_state)
        self.assertEqual(len(confirmations), 2)

    def test_slow_daily_active_returns_without_freezing_and_delivers_on_owner_poll(self):
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
        harness.bridge.block_action = "send_daily_active"
        harness.controller.on_daily_active = lambda feedback: (
            callback_threads.append(threading.get_ident()),
            harness.callbacks.daily_actives.append(feedback),
        )
        try:
            before = time.monotonic()
            submitted = harness.controller.send_daily_active(VALID_SETTINGS)
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
            self.assertEqual(harness.callbacks.daily_actives[-1].confirmed_count, 1)
        finally:
            harness.runner.stop_accepting()
            executor.shutdown(wait=True, cancel_futures=True)


class SimulationFeedbackTests(unittest.TestCase):
    def test_ten_unique_bridge_identities_drive_acknowledged_statistics(self):
        raw = simulation_result()
        device_ids = [device["install_id"] for device in raw["devices"]]
        self.assertEqual(len(set(device_ids)), 10)

        feedback = GUI.build_simulation_feedback(raw)
        self.assertEqual(feedback.device_count, 10)
        self.assertEqual(feedback.planned_device_count, 10)
        self.assertEqual(feedback.acknowledged_record_count, 10)
        self.assertEqual(feedback.planned_record_count, 10)
        self.assertEqual(feedback.failed_record_count, 0)
        self.assertEqual(feedback.daily_active_count, 10)
        self.assertEqual(
            feedback.system_distribution,
            (("linux", 3), ("macos", 2), ("windows", 5)),
        )
        self.assertEqual(
            feedback.architecture_distribution,
            (("arm64", 3), ("ia32", 1), ("x64", 6)),
        )
        self.assertEqual(len(feedback.device_details), 10)
        self.assertEqual(feedback.device_details[0][2:], ("windows", "x64", True))
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
        self.assertEqual(feedback.failed_record_count, 10)
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
                self.assertEqual(feedback.failed_record_count, 10)
                self.assertEqual(feedback.tone, "error")
                self.assertIsNone(feedback.filter_text)
                for fragment in expected_fragments:
                    self.assertIn(fragment, feedback.detail)

    def test_partial_simulation_excludes_every_unacknowledged_record(self):
        devices = simulation_devices()
        first_failure = devices[0]["deliveries"][0]
        first_failure["acknowledged"] = False
        first_failure["error"] = {
            "http_status": 403,
            "server_error": "unknown_app",
        }
        last_failure = devices[9]["deliveries"][0]
        last_failure["acknowledged"] = False
        last_failure["error"] = {"http_status": 500, "code": "server_rejected"}

        feedback = GUI.build_simulation_feedback(simulation_result(devices))
        self.assertEqual(feedback.device_count, 8)
        self.assertEqual(feedback.acknowledged_record_count, 8)
        self.assertEqual(feedback.planned_record_count, 10)
        self.assertEqual(feedback.failed_record_count, 2)
        self.assertEqual(feedback.daily_active_count, 8)
        filtered_ids = json.loads(feedback.filter_text)["event_id"]["$in"]
        self.assertNotIn(first_failure["event_id"], filtered_ids)
        self.assertNotIn(last_failure["event_id"], filtered_ids)
        self.assertEqual(len(filtered_ids), 8)
        self.assertEqual(feedback.tone, "warning")
        self.assertIn("8/10", feedback.summary)
        self.assertIn("失败 2 条", feedback.detail)
        self.assertIn("处理建议", feedback.detail)
        self.assertIn("ALLOWED_APP_IDS", feedback.detail)

    def test_simulation_model_contains_no_account_or_real_device_fields(self):
        raw = simulation_result()
        allowed_device_keys = {
            "device_number",
            "install_id",
            "app_version",
            "platform",
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
        self.assertIn("最多 10 个 POST", confirmation.explanation)
        self.assertIn("来源 IP 通常相同", confirmation.explanation)
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
    def test_version_api_errors_explain_auth_route_and_service_failures(self):
        cases = (
            ({"http_status": 401}, ("凭据无效", "x-app-key")),
            ({"http_status": 403}, ("无权", "code")),
            ({"http_status": 404}, ("没有找到", "发布流")),
            ({"http_status": 429}, ("过于频繁", "Retry-After")),
            ({"http_status": 500}, ("版本 API 暂时不可用",)),
            ({"code": "network_error"}, ("无法访问版本 API", "网络")),
        )
        for error, expected_fragments in cases:
            with self.subTest(error=error):
                translated = GUI.friendly_application_version_error(error)
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

    def test_controller_failures_use_version_api_error_translation(self):
        cases = (
            ("auth.invalid", "凭据无效"),
            ("forbidden", "无权"),
            ("network_error", "无法访问版本 API"),
        )
        for code, expected_fragment in cases:
            with self.subTest(code=code):
                harness = controller_harness()
                harness.bridge.fail_action = "check_application_version"
                harness.bridge.fail_code = code
                harness.bridge.fail_message = "controlled request failure"

                self.assertTrue(
                    harness.controller.check_for_updates(VALID_SETTINGS)
                )
                harness.runner.poll()

                self.assertEqual(len(harness.callbacks.updates), 1)
                feedback = harness.callbacks.updates[0]
                self.assertEqual(feedback.state, "error")
                self.assertIn(expected_fragment, feedback.detail)
                self.assertNotIn("/v1/track", feedback.detail)
                self.assertNotIn("ALLOWED_APP_IDS", feedback.detail)

    def test_application_version_states_are_presented_in_plain_chinese(self):
        cases = (
            (update_result("optional"), "optional_update", "发现新版本", "optional"),
            (update_result("required", data=application_version_data(forcedUpdate=True, promptUpdate=False)), "required_update", "停止支持", "required"),
            (update_result("stopped", data=application_version_data(update=False, promptUpdate=False, stopUpdate=True)), "stopped", "暂停分发", None),
            (update_result("none", reason="up_to_date"), "up_to_date", "已经是最新版", None),
            (update_result("none", reason="disabled"), "paused", "本地已关闭", None),
            (update_result("none", reason="invalid_response"), "invalid_response", "响应需要检查", None),
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
            update_result("required", data=application_version_data(forcedUpdate=True, promptUpdate=False)),
            "0.1.0",
        )
        self.assertEqual(optional.primary_button, "立即更新")
        self.assertEqual(optional.secondary_button, "稍后提醒")
        self.assertTrue(optional.download_url.startswith("https://"))
        self.assertEqual(required.primary_button, "立即更新")
        self.assertEqual(required.secondary_button, "退出软件")
        self.assertIn("Tested release notes", optional.update_content)

    def test_stop_update_never_creates_an_exit_dialog(self):
        stopped = GUI.build_update_feedback(
            update_result(
                "stopped",
                data=application_version_data(
                    update=False,
                    promptUpdate=False,
                    stopUpdate=True,
                ),
            ),
            "0.1.0",
        )
        self.assertEqual(stopped.state, "stopped")
        self.assertIsNone(stopped.dialog_mode)
        self.assertIsNone(stopped.primary_button)
        self.assertIn("不会退出", stopped.detail)

    def test_each_update_click_makes_a_fresh_request_without_opening_download(self):
        opened = []
        harness = controller_harness(url_opener=lambda url: opened.append(url) or True)

        for _ in range(2):
            self.assertTrue(harness.controller.check_for_updates(VALID_SETTINGS))
            harness.runner.poll()
        self.assertEqual(
            [call[0] for call in harness.bridge.calls],
            ["check_application_version", "check_application_version"],
        )
        for _action, timeout, payload, _thread in harness.bridge.calls:
            self.assertEqual(timeout, 35)
            self.assertEqual(
                payload["version_base_url"], VALID_SETTINGS.version_base_url
            )
            self.assertEqual(
                payload["application_code"], VALID_SETTINGS.application_code
            )
            self.assertEqual(payload["current_version"], "0.1.0")
            self.assertEqual(payload["app_key"], "runtime-key")
            self.assertEqual(payload["app_secret"], "runtime-secret")
            self.assertIs(payload["allow_network"], True)
            self.assertEqual(payload["confirmation"], "GET")
            self.assertNotIn("state_dir", payload)
        self.assertEqual(opened, [])
        self.assertEqual(len(harness.callbacks.updates), 2)
        self.assertTrue(
            all("每次点击都会重新发送 GET" in message[2] for message in harness.callbacks.messages)
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
            update_result("required", data=application_version_data(forcedUpdate=True, promptUpdate=False)),
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
            update_result("required", data=application_version_data(forcedUpdate=True, promptUpdate=False)),
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
        harness.bridge.block_action = "send_daily_active"
        try:
            harness.controller.send_daily_active(VALID_SETTINGS)
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
            self.assertEqual(harness.callbacks.daily_actives, [])
        finally:
            executor.shutdown(wait=True, cancel_futures=True)


if __name__ == "__main__":
    unittest.main()
