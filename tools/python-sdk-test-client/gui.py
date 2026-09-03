"""Windows GUI host for manually exercising the real TypeScript SDK bridge.

The GUI owns presentation and explicit network consent only. Identity, telemetry
validation, URL safety, manifest parsing, and update decisions stay in the Node
bridge and @bifang/telemetry-update-sdk.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import ctypes
import datetime as datetime_module
import json
import os
import queue
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Optional, Tuple

try:
    import tkinter as tk
    from tkinter import filedialog, ttk
except ImportError:  # pragma: no cover - exercised only by Python builds without Tk.
    tk = None
    filedialog = None
    ttk = None

from client import (
    BridgeError,
    BridgeProcess,
    ClientConfig,
    EVENT_EXAMPLES,
    detect_sdk_architecture,
    detect_sdk_platform,
    repository_root_for_bridge,
    state_directory_for_app,
)


GUI_EVENT_EXAMPLES: Tuple[Tuple[str, Dict[str, Any]], ...] = tuple(
    EVENT_EXAMPLES[:6]
)
DEFAULT_STATE_ROOT = Path(tempfile.gettempdir()) / "bifang-python-sdk-test-client"
LIVE_TELEMETRY_ENDPOINT_DEFAULT = ""
LIVE_UPDATE_BASE_URL_DEFAULT = ""


def parse_json_object(raw_value: str, label: str) -> Dict[str, Any]:
    """Parse GUI JSON input without duplicating any SDK protocol decisions."""
    def reject_non_json_constant(value: str) -> None:
        raise ValueError(f"不允许非标准 JSON 常量 {value}")

    try:
        value = json.loads(raw_value, parse_constant=reject_non_json_constant)
    except json.JSONDecodeError as error:
        raise ValueError(
            f"{label} 不是有效 JSON：第 {error.lineno} 行第 {error.colno} 列"
        ) from error
    except ValueError as error:
        raise ValueError(f"{label} 不是有效 JSON：{error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label} 必须是 JSON object")
    return value


def event_example(event_name: str) -> Dict[str, Any]:
    """Return a copy of a display-only event preset."""
    for candidate, properties in GUI_EVENT_EXAMPLES:
        if candidate == event_name:
            return dict(properties)
    return {}


@dataclass(frozen=True)
class NetworkIntent:
    verb: str
    target_url: str
    side_effect: str


def network_confirmation_matches(
    intent: NetworkIntent, repeated_url: str, confirmation_word: str
) -> bool:
    """Require exact, case-sensitive repetition of both URL and HTTP verb."""
    return (
        bool(intent.target_url)
        and repeated_url == intent.target_url
        and confirmation_word == intent.verb
    )


@dataclass(frozen=True)
class IdentityState:
    initialized: bool = False
    enabled: Optional[bool] = None
    install_id: Optional[str] = None
    session_id: Optional[str] = None


@dataclass(frozen=True)
class ControllerSnapshot:
    bridge_status: str
    sdk_version: Optional[str]
    busy: bool
    busy_label: Optional[str]
    config: Dict[str, Any]
    state_root: str
    capture: IdentityState
    live: IdentityState


@dataclass(frozen=True)
class GuiRecord:
    timestamp: str
    level: str
    operation: str
    data: Any


def new_record(level: str, operation: str, data: Any) -> GuiRecord:
    return GuiRecord(
        timestamp=datetime_module.datetime.now().astimezone().isoformat(
            timespec="seconds"
        ),
        level=level,
        operation=operation,
        data=data,
    )


def structured_error(error: BaseException) -> Dict[str, Any]:
    details: Dict[str, Any] = {
        "type": type(error).__name__,
        "message": str(error),
    }
    if isinstance(error, BridgeError):
        details["code"] = error.code
        details["message"] = error.message
    return {"ok": False, "error": details}


class AsyncOperationRunner:
    """Run one operation at a time and deliver completions on the owner thread."""

    def __init__(
        self,
        on_busy_change: Callable[[bool, Optional[str]], None],
        executor: Optional[concurrent.futures.Executor] = None,
    ) -> None:
        self._executor = executor or concurrent.futures.ThreadPoolExecutor(
            max_workers=2, thread_name_prefix="bifang-sdk-gui"
        )
        self._owns_executor = executor is None
        self._on_busy_change = on_busy_change
        self._completions: "queue.Queue[Any]" = queue.Queue()
        self._owner_thread_id = threading.get_ident()
        self._lock = threading.Lock()
        self._busy = False
        self._busy_label: Optional[str] = None
        self._closing = False

    @property
    def busy(self) -> bool:
        with self._lock:
            return self._busy

    @property
    def busy_label(self) -> Optional[str]:
        with self._lock:
            return self._busy_label

    def submit(
        self,
        label: str,
        function: Callable[[], Any],
        on_success: Callable[[Any], None],
        on_error: Callable[[BaseException], None],
    ) -> bool:
        with self._lock:
            if self._closing or self._busy:
                return False
            self._busy = True
            self._busy_label = label
        self._on_busy_change(True, label)
        try:
            future = self._executor.submit(function)
        except BaseException as error:
            with self._lock:
                self._busy = False
                self._busy_label = None
            self._on_busy_change(False, None)
            try:
                on_error(error)
            except BaseException:
                pass
            return False
        future.add_done_callback(
            lambda completed: self._completions.put(
                (completed, on_success, on_error)
            )
        )
        return True

    def poll(self) -> int:
        """Deliver queued completions; callers must invoke this on the owner thread."""
        if threading.get_ident() != self._owner_thread_id:
            raise RuntimeError("completion polling must run on the UI owner thread")
        delivered = 0
        while True:
            try:
                future, on_success, on_error = self._completions.get_nowait()
            except queue.Empty:
                break
            with self._lock:
                self._busy = False
                self._busy_label = None
                closing = self._closing
            self._on_busy_change(False, None)
            if not closing:
                try:
                    result = future.result()
                except BaseException as error:
                    try:
                        on_error(error)
                    except BaseException:
                        pass
                else:
                    try:
                        on_success(result)
                    except BaseException as error:
                        try:
                            on_error(error)
                        except BaseException:
                            pass
            delivered += 1
        return delivered

    def stop_accepting(self) -> None:
        with self._lock:
            self._closing = True

    def shutdown(self) -> None:
        self.stop_accepting()
        if self._owns_executor:
            self._executor.shutdown(wait=False, cancel_futures=True)


class GuiController:
    """Headless controller that maps GUI intent to the existing bridge contract."""

    def __init__(
        self,
        runner: AsyncOperationRunner,
        state_root: Path,
        confirm_network: Callable[[NetworkIntent], bool],
        on_record: Callable[[GuiRecord], None],
        on_state_change: Callable[[ControllerSnapshot], None],
    ) -> None:
        self.runner = runner
        self.state_root = state_root.expanduser().resolve()
        self.confirm_network = confirm_network
        self.on_record = on_record
        self.on_state_change = on_state_change
        self.config = ClientConfig(
            platform=detect_sdk_platform(), arch=detect_sdk_architecture()
        )
        self.capture = IdentityState()
        self.live = IdentityState()
        self._bridge: Optional[BridgeProcess] = None
        self._bridge_lock = threading.Lock()
        self._connecting_bridge: Optional[BridgeProcess] = None
        self._closing = False
        self.bridge_status = "disconnected"
        self.sdk_version: Optional[str] = None

    @property
    def bridge(self) -> Optional[BridgeProcess]:
        return self._bridge

    def snapshot(self) -> ControllerSnapshot:
        return ControllerSnapshot(
            bridge_status=self.bridge_status,
            sdk_version=self.sdk_version,
            busy=self.runner.busy,
            busy_label=self.runner.busy_label,
            config=dict(self.config.bridge_fields()),
            state_root=str(self.state_root),
            capture=self.capture,
            live=self.live,
        )

    def emit_state(self) -> None:
        self.on_state_change(self.snapshot())

    def report_input_error(self, operation: str, message: str) -> None:
        self.on_record(
            new_record(
                "error",
                operation,
                {
                    "ok": False,
                    "error": {"type": "input_error", "message": message},
                },
            )
        )

    def connect(self, bridge_factory: Callable[[], BridgeProcess]) -> bool:
        self.bridge_status = "connecting"
        self.emit_state()

        def work() -> Tuple[BridgeProcess, Any]:
            bridge = bridge_factory()
            with self._bridge_lock:
                if self._closing:
                    close_immediately = True
                else:
                    self._connecting_bridge = bridge
                    close_immediately = False
            if close_immediately:
                bridge.close()
                raise BridgeError("bridge_closed", "client closed during bridge startup")
            try:
                ping = bridge.request("ping", timeout=5)
                if (
                    not isinstance(ping, dict)
                    or not isinstance(ping.get("sdk_version"), str)
                    or ping.get("network_performed") is not False
                ):
                    raise BridgeError(
                        "invalid_bridge_output", "ping returned an invalid local status"
                    )
                return bridge, ping
            except BaseException:
                bridge.close()
                with self._bridge_lock:
                    if self._connecting_bridge is bridge:
                        self._connecting_bridge = None
                raise

        def success(value: Tuple[BridgeProcess, Any]) -> None:
            bridge, ping = value
            with self._bridge_lock:
                self._connecting_bridge = None
                self._bridge = bridge
            self.sdk_version = str(ping.get("sdk_version", "unknown"))
            self.bridge_status = "ready"
            self.on_record(new_record("success", "本地桥接探活", ping))
            self.emit_state()

        def failure(error: BaseException) -> None:
            self.bridge_status = "error"
            self.on_record(new_record("error", "本地桥接启动", structured_error(error)))
            self.emit_state()

        return self.runner.submit("正在启动本地桥接…", work, success, failure)

    def apply_config(self, config: ClientConfig) -> bool:
        def success(_result: Any) -> None:
            self.config = config
            self.capture = IdentityState()
            self.live = IdentityState()
            self.emit_state()

        return self._submit_bridge(
            "应用配置并重置会话",
            "reset_sessions",
            on_success=success,
        )

    def init_capture(self) -> bool:
        fields = dict(self.config.bridge_fields())
        state_dir = state_directory_for_app(
            self.state_root, "capture", self.config.app_id
        )

        def success(result: Any) -> None:
            self.capture = self._identity_from_result(result)
            self.emit_state()

        return self._submit_bridge(
            "初始化本地捕获（零网络）",
            "init_capture",
            state_dir=str(state_dir),
            on_success=success,
            **fields,
        )

    def track_capture(self, event: str, properties: Dict[str, Any]) -> bool:
        if not self.capture.initialized:
            self.report_input_error("本地事件预览", "请先初始化本地捕获会话")
            return False
        return self._submit_bridge(
            "本地事件预览（零网络）",
            "track_capture",
            event=event,
            properties=properties,
        )

    def preview_update(self, manifest: Dict[str, Any]) -> bool:
        if not (self.capture.initialized or self.live.initialized):
            self.report_input_error("本地更新判定", "请先初始化本地捕获会话")
            return False
        return self._submit_bridge(
            "本地更新判定（零网络）",
            "preview_update",
            manifest=manifest,
            **dict(self.config.bridge_fields()),
        )

    def init_live(self, endpoint: str) -> bool:
        endpoint = endpoint.strip()
        intent = NetworkIntent(
            verb="POST",
            target_url=endpoint,
            side_effect=(
                "初始化会写入工具专用身份目录，并可能立即 POST app_install "
                "（首次有效身份）与 app_start（每次初始化）。HTTP 成功不证明后端持久化。"
            ),
        )
        if not self._authorize(intent, "初始化 Live telemetry"):
            return False
        fields = dict(self.config.bridge_fields())
        state_dir = state_directory_for_app(
            self.state_root, "live", self.config.app_id
        )

        def success(result: Any) -> None:
            self.live = self._identity_from_result(result)
            self.emit_state()

        return self._submit_bridge(
            "Live telemetry 初始化（真实 POST）",
            "init_live",
            timeout=35,
            state_dir=str(state_dir),
            endpoint=endpoint,
            allow_network=True,
            confirmation="POST",
            on_success=success,
            **fields,
        )

    def track_live(
        self, endpoint: str, event: str, properties: Dict[str, Any]
    ) -> bool:
        if not self.live.initialized:
            self.report_input_error(
                "Live telemetry 事件", "请先显式初始化 Live telemetry 会话"
            )
            return False
        endpoint = endpoint.strip()
        intent = NetworkIntent(
            verb="POST",
            target_url=endpoint,
            side_effect=(
                "所选事件及 properties 将发送到该 endpoint。endpoint 必须与初始化时逐字一致；"
                "SDK 仍会执行事件清洗，HTTP 成功不证明后端持久化。"
            ),
        )
        if not self._authorize(intent, "发送 Live telemetry 事件"):
            return False
        return self._submit_bridge(
            "Live telemetry 事件（真实 POST）",
            "track_live",
            timeout=35,
            endpoint=endpoint,
            event=event,
            properties=properties,
            allow_network=True,
            confirmation="POST",
        )

    def prepare_live_update_check(self, base_url: str) -> bool:
        if not (self.capture.initialized or self.live.initialized):
            self.report_input_error("Live 更新检查", "请先初始化本地捕获会话")
            return False
        base_url = base_url.strip()
        if not base_url:
            self.report_input_error("Live 更新检查", "更新 base URL 为空，未调用桥接")
            return False
        fields = dict(self.config.bridge_fields())

        def prepared(result: Any) -> None:
            request_url = result.get("request_url") if isinstance(result, dict) else None
            if not isinstance(request_url, str) or not request_url:
                self.report_input_error(
                    "Live 更新检查", "桥接没有返回可确认的 SDK 请求 URL"
                )
                return
            intent = NetworkIntent(
                verb="GET",
                target_url=request_url,
                side_effect=(
                    "将从该精确地址读取更新 JSON。SDK 只返回决策；本工具不会下载、"
                    "打开 download_url/release_notes_url，也不会安装更新。"
                ),
            )
            if not self._authorize(intent, "Live 更新检查"):
                return
            self._submit_bridge(
                "Live 更新检查（真实 GET）",
                "check_update_live",
                timeout=35,
                base_url=base_url,
                allow_network=True,
                confirmation="GET",
                **fields,
            )

        return self._submit_bridge(
            "生成最终 GET URL（零网络）",
            "build_update_url",
            timeout=5,
            emit_result=False,
            on_success=prepared,
            base_url=base_url,
            **fields,
        )

    def refresh_status(self) -> bool:
        def success(result: Any) -> None:
            if isinstance(result, dict):
                self.capture = self._identity_from_public_state(result.get("capture"))
                self.live = self._identity_from_public_state(result.get("live"))
                safe_result = dict(result)
                if isinstance(result.get("live"), dict):
                    safe_live = dict(result["live"])
                    safe_live.pop("endpoint", None)
                    safe_result["live"] = safe_live
                self.on_record(
                    new_record("success", "读取本地桥接状态（零网络）", safe_result)
                )
            self.emit_state()

        return self._submit_bridge(
            "读取本地桥接状态（零网络）",
            "status",
            emit_result=False,
            on_success=success,
        )

    def begin_close(self) -> Optional[threading.Thread]:
        self.bridge_status = "closing"
        self.runner.stop_accepting()
        self.emit_state()
        with self._bridge_lock:
            self._closing = True
            bridge = self._bridge or self._connecting_bridge
            self._bridge = None
            self._connecting_bridge = None
        if bridge is None:
            return None
        closer = threading.Thread(
            target=bridge.close, name="bifang-sdk-gui-close", daemon=True
        )
        closer.start()
        return closer

    def _authorize(self, intent: NetworkIntent, operation: str) -> bool:
        if not intent.target_url:
            self.report_input_error(operation, "URL 为空，未调用 live 桥接")
            return False
        try:
            approved = self.confirm_network(intent)
        except BaseException as error:
            self.on_record(new_record("error", operation, structured_error(error)))
            return False
        if not approved:
            self.on_record(
                new_record(
                    "info",
                    operation,
                    {
                        "cancelled": True,
                        "network_performed": False,
                        "message": "确认已取消或输入不精确，未提交 live 请求",
                    },
                )
            )
            return False
        return True

    def _submit_bridge(
        self,
        label: str,
        action: str,
        *,
        timeout: float = 15,
        emit_result: bool = True,
        on_success: Optional[Callable[[Any], None]] = None,
        **payload: Any,
    ) -> bool:
        bridge = self._bridge
        if bridge is None or self.bridge_status != "ready":
            self.report_input_error(label, "本地桥接尚未就绪")
            return False

        def work() -> Any:
            return bridge.request(action, timeout=timeout, **payload)

        def success(result: Any) -> None:
            if emit_result:
                self.on_record(new_record("success", label, result))
            if on_success is not None:
                on_success(result)

        def failure(error: BaseException) -> None:
            if isinstance(error, BridgeError) and error.code in {
                "bridge_unavailable",
                "bridge_closed",
            }:
                self.bridge_status = "error"
            self.on_record(new_record("error", label, structured_error(error)))
            self.emit_state()

        return self.runner.submit(label, work, success, failure)

    @staticmethod
    def _identity_from_result(result: Any) -> IdentityState:
        if not isinstance(result, dict):
            return IdentityState()
        return GuiController._identity_from_public_state(result.get("client"))

    @staticmethod
    def _identity_from_public_state(value: Any) -> IdentityState:
        if not isinstance(value, dict):
            return IdentityState()
        install_id = value.get("install_id")
        session_id = value.get("session_id")
        return IdentityState(
            initialized=isinstance(install_id, str) and isinstance(session_id, str),
            enabled=value.get("enabled") if isinstance(value.get("enabled"), bool) else None,
            install_id=install_id if isinstance(install_id, str) else None,
            session_id=session_id if isinstance(session_id, str) else None,
        )


class ExactNetworkConfirmationDialog:
    """Modal confirmation that deliberately has no Enter-key submit binding."""

    def __init__(self, parent: Any, intent: NetworkIntent) -> None:
        if tk is None or ttk is None:
            raise RuntimeError("当前 Python 未安装 Tkinter")
        self.intent = intent
        self.approved = False
        self.window = tk.Toplevel(parent)
        self.window.title("确认真实网络请求")
        self.window.transient(parent)
        self.window.resizable(True, False)
        self.window.protocol("WM_DELETE_WINDOW", self._cancel)

        frame = ttk.Frame(self.window, padding=18)
        frame.grid(row=0, column=0, sticky="nsew")
        frame.columnconfigure(0, weight=1)

        ttk.Label(
            frame,
            text=f"即将执行真实 {intent.verb} 请求",
            style="DialogTitle.TLabel",
        ).grid(row=0, column=0, sticky="w")
        ttk.Label(
            frame,
            text="目标 URL（完整、精确）：",
        ).grid(row=1, column=0, sticky="w", pady=(14, 4))
        target = tk.Text(frame, height=3, wrap="char", width=68)
        target.grid(row=2, column=0, sticky="ew")
        target.insert("1.0", intent.target_url)
        target.configure(state="disabled")

        ttk.Label(
            frame,
            text=intent.side_effect,
            wraplength=520,
            justify="left",
            style="Warning.TLabel",
        ).grid(row=3, column=0, sticky="ew", pady=(10, 12))

        ttk.Label(frame, text="重新完整输入上面的 URL：").grid(
            row=4, column=0, sticky="w"
        )
        self.repeated_url = tk.StringVar(value="")
        url_entry = ttk.Entry(frame, textvariable=self.repeated_url, width=68)
        url_entry.grid(row=5, column=0, sticky="ew", pady=(4, 10))

        ttk.Label(
            frame,
            text=f"再输入精确大写确认词 {intent.verb}：",
        ).grid(row=6, column=0, sticky="w")
        self.confirmation_word = tk.StringVar(value="")
        ttk.Entry(frame, textvariable=self.confirmation_word, width=20).grid(
            row=7, column=0, sticky="w", pady=(4, 4)
        )
        ttk.Label(
            frame,
            text="按 Enter 不会授权；只有点击“授权并执行”才会提交请求。",
            style="Muted.TLabel",
        ).grid(row=8, column=0, sticky="w", pady=(2, 12))

        buttons = ttk.Frame(frame)
        buttons.grid(row=9, column=0, sticky="e")
        ttk.Button(buttons, text="取消（不联网）", command=self._cancel).grid(
            row=0, column=0, padx=(0, 8)
        )
        self.authorize_button = ttk.Button(
            buttons,
            text="授权并执行",
            command=self._approve,
            state="disabled",
        )
        self.authorize_button.grid(row=0, column=1)

        self.repeated_url.trace_add("write", self._refresh_authorize_state)
        self.confirmation_word.trace_add("write", self._refresh_authorize_state)
        self.window.bind("<Escape>", lambda _event: self._cancel())
        self.window.grab_set()
        url_entry.focus_set()

    def ask(self) -> bool:
        self.window.wait_window()
        return self.approved

    def cancel(self) -> None:
        try:
            if self.window.winfo_exists():
                self._cancel()
        except Exception:
            self.approved = False

    def _refresh_authorize_state(self, *_args: Any) -> None:
        matches = network_confirmation_matches(
            self.intent, self.repeated_url.get(), self.confirmation_word.get()
        )
        self.authorize_button.configure(state="normal" if matches else "disabled")

    def _approve(self) -> None:
        if not network_confirmation_matches(
            self.intent, self.repeated_url.get(), self.confirmation_word.get()
        ):
            return
        self.approved = True
        self.window.destroy()

    def _cancel(self) -> None:
        self.approved = False
        self.window.destroy()


class SdkGuiApplication:
    """Tkinter/ttk view for the headless GUI controller."""

    def __init__(
        self,
        root: Any,
        state_root: Path,
        bridge_path: Path,
        node_command: str,
    ) -> None:
        if tk is None or ttk is None:
            raise RuntimeError("当前 Python 未安装 Tkinter")
        self.root = root
        self.bridge_path = bridge_path.expanduser().resolve()
        self.node_command = node_command
        self._closing = False
        self._cleanup_complete = False
        self._active_confirmation: Optional[ExactNetworkConfirmationDialog] = None
        self._poll_after_id: Optional[str] = None
        self._last_snapshot: Optional[ControllerSnapshot] = None
        self._config_dirty = False
        self._sdk_buttons: Dict[str, Any] = {}

        self._configure_window()
        self._create_variables(state_root)
        self._build_ui()

        self.runner = AsyncOperationRunner(self._on_busy_change)
        self.controller = GuiController(
            runner=self.runner,
            state_root=state_root,
            confirm_network=self._confirm_network,
            on_record=self._append_record,
            on_state_change=self._render_state,
        )
        self._render_state(self.controller.snapshot())
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self._schedule_poll()

    def start(self) -> None:
        self.controller.connect(self._create_bridge)

    def _configure_window(self) -> None:
        self.root.title("毕方 SDK GUI 手动测试客户端")
        screen_width = int(self.root.winfo_screenwidth())
        screen_height = int(self.root.winfo_screenheight())
        window_width = max(560, min(1180, screen_width - 80))
        window_height = max(480, min(820, screen_height - 100))
        self.root.geometry(f"{window_width}x{window_height}")
        self.root.minsize(min(800, window_width), min(560, window_height))
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)

        style = ttk.Style(self.root)
        if "vista" in style.theme_names():
            style.theme_use("vista")
        default_font = ("Microsoft YaHei UI", 10)
        self.root.option_add("*Font", default_font)
        style.configure("Title.TLabel", font=("Microsoft YaHei UI", 17, "bold"))
        style.configure("Subtitle.TLabel", foreground="#4b5563")
        style.configure("DialogTitle.TLabel", font=("Microsoft YaHei UI", 13, "bold"))
        style.configure(
            "Safe.TLabel",
            foreground="#047857",
            font=("Microsoft YaHei UI", 10, "bold"),
        )
        style.configure("Warning.TLabel", foreground="#9a3412")
        style.configure("Muted.TLabel", foreground="#6b7280")
        style.configure("Identity.TLabel", font=("Consolas", 9))

    def _create_variables(self, state_root: Path) -> None:
        self.bridge_status_var = tk.StringVar(value="本地桥接：等待启动")
        self.busy_var = tk.StringVar(value="就绪")
        self.capture_state_var = tk.StringVar(value="本地捕获：未初始化")
        self.live_state_var = tk.StringVar(value="Live telemetry：未初始化")
        self.state_root_var = tk.StringVar(value=str(state_root.expanduser().resolve()))

        self.app_id_var = tk.StringVar(value="example-tool")
        self.app_version_var = tk.StringVar(value="0.1.0")
        self.platform_var = tk.StringVar(value=detect_sdk_platform())
        self.arch_var = tk.StringVar(value=detect_sdk_architecture())
        self.channel_var = tk.StringVar(value="official")
        for variable in (
            self.app_id_var,
            self.app_version_var,
            self.platform_var,
            self.arch_var,
            self.channel_var,
        ):
            variable.trace_add("write", self._mark_config_dirty)

        self.local_event_var = tk.StringVar(value=GUI_EVENT_EXAMPLES[0][0])
        self.live_event_var = tk.StringVar(value=GUI_EVENT_EXAMPLES[0][0])
        self.telemetry_endpoint_var = tk.StringVar(
            value=LIVE_TELEMETRY_ENDPOINT_DEFAULT
        )
        self.update_base_url_var = tk.StringVar(value=LIVE_UPDATE_BASE_URL_DEFAULT)

    def _build_ui(self) -> None:
        outer = ttk.Frame(self.root, padding=14)
        outer.grid(row=0, column=0, sticky="nsew")
        outer.columnconfigure(0, weight=1)
        outer.rowconfigure(2, weight=1)

        header = ttk.Frame(outer)
        header.grid(row=0, column=0, sticky="ew", pady=(0, 10))
        header.columnconfigure(0, weight=1)
        ttk.Label(header, text="毕方 SDK 手动测试工作台", style="Title.TLabel").grid(
            row=0, column=0, sticky="w"
        )
        ttk.Label(
            header,
            text="本地图形测试工具 · 不是业务客户端或管理后台",
            style="Subtitle.TLabel",
        ).grid(row=1, column=0, sticky="w", pady=(2, 0))
        ttk.Label(
            header,
            text="默认离线 · URL 不预填 · Live 请求逐次精确确认",
            style="Safe.TLabel",
        ).grid(row=0, column=1, rowspan=2, sticky="e")

        overview = ttk.Frame(outer)
        overview.grid(row=1, column=0, sticky="ew", pady=(0, 10))
        overview.columnconfigure(0, weight=3)
        overview.columnconfigure(1, weight=2)
        self._build_config_panel(overview)
        self._build_identity_panel(overview)

        vertical = ttk.Panedwindow(outer, orient="vertical")
        vertical.grid(row=2, column=0, sticky="nsew")

        work_frame = ttk.Frame(vertical)
        work_frame.columnconfigure(0, weight=1)
        work_frame.rowconfigure(0, weight=1)
        self.notebook = ttk.Notebook(work_frame)
        self.notebook.grid(row=0, column=0, sticky="nsew")
        self._build_offline_tab()
        self._build_live_tab()
        vertical.add(work_frame, weight=3)

        results_frame = self._build_results_panel(vertical)
        vertical.add(results_frame, weight=2)

    def _build_config_panel(self, parent: Any) -> None:
        panel = ttk.LabelFrame(parent, text="测试配置（编辑后仅“应用配置”生效）", padding=10)
        panel.grid(row=0, column=0, sticky="nsew", padx=(0, 6))
        for column in range(3):
            panel.columnconfigure(column, weight=1)
        fields = (
            ("app_id", self.app_id_var, None),
            ("app_version", self.app_version_var, None),
            ("platform", self.platform_var, ("windows", "macos", "linux")),
            ("arch", self.arch_var, ("x64", "arm64", "ia32")),
            ("channel", self.channel_var, None),
        )
        for index, (label, variable, values) in enumerate(fields):
            column = index % 3
            row = (index // 3) * 2
            ttk.Label(panel, text=label).grid(row=row, column=column, sticky="w")
            if values is None:
                widget = ttk.Entry(panel, textvariable=variable)
            else:
                widget = ttk.Combobox(
                    panel, textvariable=variable, values=values, state="readonly"
                )
            widget.grid(row=row + 1, column=column, sticky="ew", padx=(0, 6))
        ttk.Label(panel, text="身份状态根目录：", style="Muted.TLabel").grid(
            row=4, column=0, sticky="w", pady=(9, 0)
        )
        ttk.Entry(
            panel,
            textvariable=self.state_root_var,
            state="readonly",
        ).grid(row=5, column=0, columnspan=3, sticky="ew", pady=(2, 0))
        actions = ttk.Frame(panel)
        actions.grid(row=6, column=0, columnspan=3, sticky="ew", pady=(9, 0))
        self._sdk_buttons["apply"] = ttk.Button(
            actions, text="应用配置并重置会话", command=self._apply_config
        )
        self._sdk_buttons["apply"].grid(row=0, column=0, sticky="w")
        self._sdk_buttons["status"] = ttk.Button(
            actions, text="刷新桥接状态", command=self._refresh_status
        )
        self._sdk_buttons["status"].grid(row=0, column=1, sticky="w", padx=(8, 0))
        ttk.Label(
            actions,
            textvariable=self.bridge_status_var,
            style="Muted.TLabel",
        ).grid(row=0, column=2, sticky="w", padx=(12, 0))

    def _build_identity_panel(self, parent: Any) -> None:
        panel = ttk.LabelFrame(parent, text="初始化与身份状态", padding=10)
        panel.grid(row=0, column=1, sticky="nsew", padx=(6, 0))
        panel.columnconfigure(0, weight=1)
        ttk.Label(
            panel,
            textvariable=self.capture_state_var,
            justify="left",
            style="Identity.TLabel",
        ).grid(row=0, column=0, sticky="nw")
        ttk.Separator(panel).grid(row=1, column=0, sticky="ew", pady=7)
        ttk.Label(
            panel,
            textvariable=self.live_state_var,
            justify="left",
            style="Identity.TLabel",
        ).grid(row=2, column=0, sticky="nw")
        ttk.Label(
            panel,
            text=(
                "install_id：该 app + 状态目录内持久的随机安装身份；\n"
                "session_id：每次 SDK 初始化新建的随机会话身份。二者都不是硬件指纹。"
            ),
            wraplength=310,
            justify="left",
            style="Muted.TLabel",
        ).grid(row=3, column=0, sticky="ew", pady=(8, 0))

    def _build_offline_tab(self) -> None:
        tab = ttk.Frame(self.notebook, padding=10)
        tab.columnconfigure(0, weight=1)
        tab.columnconfigure(1, weight=1)
        tab.rowconfigure(1, weight=1)
        self.notebook.add(tab, text="本地零网络")

        ttk.Label(
            tab,
            text=(
                "Capture transport 与注入式 update fetch 均由真实 TypeScript SDK 驱动；"
                "此页不会 POST/GET 公网。"
            ),
            style="Safe.TLabel",
        ).grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 8))

        event_panel = ttk.LabelFrame(tab, text="Telemetry 事件预览", padding=10)
        event_panel.grid(row=1, column=0, sticky="nsew", padx=(0, 5))
        event_panel.columnconfigure(0, weight=1)
        event_panel.rowconfigure(4, weight=1)
        ttk.Label(event_panel, text="事件（仅六个手测入口）：").grid(
            row=0, column=0, sticky="w"
        )
        event_box = ttk.Combobox(
            event_panel,
            textvariable=self.local_event_var,
            values=[name for name, _properties in GUI_EVENT_EXAMPLES],
            state="readonly",
        )
        event_box.grid(row=1, column=0, sticky="ew", pady=(4, 8))
        event_box.bind("<<ComboboxSelected>>", lambda _event: self._load_local_event_example())
        ttk.Label(event_panel, text="properties JSON：").grid(
            row=2, column=0, sticky="w"
        )
        self.local_properties_text = tk.Text(
            event_panel, height=9, width=38, wrap="word", undo=True
        )
        self.local_properties_text.grid(row=4, column=0, sticky="nsew", pady=(4, 8))
        self.local_properties_text.insert(
            "1.0",
            json.dumps(event_example(self.local_event_var.get()), ensure_ascii=False, indent=2),
        )
        ttk.Label(
            event_panel,
            text=(
                "只输入受控低熵标识。禁止姓名、Token、文件路径/正文、完整 URL、"
                "异常原文或其他用户内容。最终接受/拒绝完全由 SDK 决定。"
            ),
            wraplength=330,
            justify="left",
            style="Warning.TLabel",
        ).grid(row=5, column=0, sticky="ew")
        buttons = ttk.Frame(event_panel)
        buttons.grid(row=6, column=0, sticky="ew", pady=(9, 0))
        ttk.Button(
            buttons, text="恢复事件示例", command=self._load_local_event_example
        ).grid(row=0, column=0)
        self._sdk_buttons["capture_init"] = ttk.Button(
            buttons, text="初始化本地捕获", command=self._init_capture
        )
        self._sdk_buttons["capture_init"].grid(row=0, column=1, padx=(8, 0))
        self._sdk_buttons["capture_track"] = ttk.Button(
            buttons, text="生成并预览事件", command=self._track_capture
        )
        self._sdk_buttons["capture_track"].grid(row=0, column=2, padx=(8, 0))

        update_panel = ttk.LabelFrame(tab, text="离线更新 JSON 判定", padding=10)
        update_panel.grid(row=1, column=1, sticky="nsew", padx=(5, 0))
        update_panel.columnconfigure(0, weight=1)
        update_panel.rowconfigure(2, weight=1)
        ttk.Label(
            update_panel,
            text=(
                "粘贴或载入本地 manifest。内容只传给桥接内注入的 fetch；"
                "SemVer、灰度与清单契约由真实 UpdateChecker 判定。"
            ),
            wraplength=330,
            justify="left",
            style="Muted.TLabel",
        ).grid(row=0, column=0, sticky="ew", pady=(0, 6))
        self.manifest_text = tk.Text(
            update_panel, height=16, width=38, wrap="word", undo=True
        )
        self.manifest_text.grid(row=2, column=0, sticky="nsew")
        buttons = ttk.Frame(update_panel)
        buttons.grid(row=3, column=0, sticky="ew", pady=(9, 0))
        ttk.Button(
            buttons, text="载入本地 JSON…", command=self._load_manifest_file
        ).grid(row=0, column=0)
        self._sdk_buttons["preview_update"] = ttk.Button(
            buttons, text="运行本地更新判定", command=self._preview_update
        )
        self._sdk_buttons["preview_update"].grid(row=0, column=1, padx=(8, 0))

    def _build_live_tab(self) -> None:
        tab = ttk.Frame(self.notebook, padding=10)
        tab.columnconfigure(0, weight=1)
        tab.rowconfigure(2, weight=1)
        self.notebook.add(tab, text="显式联网")

        ttk.Label(
            tab,
            text=(
                "高风险区：URL 初始为空且不持久化。Telemetry 须重输手填 endpoint，update 须重输 "
                "SDK 构造的精确请求 URL，再输入大写 POST/GET；取消不会提交 live 桥接。"
            ),
            wraplength=700,
            justify="left",
            style="Warning.TLabel",
        ).grid(row=0, column=0, sticky="ew", pady=(0, 8))

        telemetry_panel = ttk.LabelFrame(
            tab, text="Live telemetry POST", padding=10
        )
        telemetry_panel.grid(row=1, column=0, sticky="ew")
        telemetry_panel.columnconfigure(1, weight=1)
        ttk.Label(telemetry_panel, text="HTTPS endpoint：").grid(
            row=0, column=0, sticky="w", padx=(0, 8)
        )
        ttk.Entry(
            telemetry_panel, textvariable=self.telemetry_endpoint_var
        ).grid(row=0, column=1, columnspan=3, sticky="ew")
        ttk.Label(telemetry_panel, text="事件：").grid(
            row=1, column=0, sticky="w", padx=(0, 8), pady=(8, 0)
        )
        live_event_box = ttk.Combobox(
            telemetry_panel,
            textvariable=self.live_event_var,
            values=[name for name, _properties in GUI_EVENT_EXAMPLES],
            state="readonly",
            width=28,
        )
        live_event_box.grid(row=1, column=1, sticky="w", pady=(8, 0))
        live_event_box.bind("<<ComboboxSelected>>", lambda _event: self._load_live_event_example())
        ttk.Label(telemetry_panel, text="properties JSON：").grid(
            row=2, column=0, sticky="nw", padx=(0, 8), pady=(8, 0)
        )
        self.live_properties_text = tk.Text(
            telemetry_panel, height=6, width=60, wrap="word", undo=True
        )
        self.live_properties_text.grid(
            row=2, column=1, columnspan=3, sticky="ew", pady=(8, 0)
        )
        self.live_properties_text.insert(
            "1.0",
            json.dumps(event_example(self.live_event_var.get()), ensure_ascii=False, indent=2),
        )
        self._sdk_buttons["live_init"] = ttk.Button(
            telemetry_panel,
            text="确认并初始化（POST）",
            command=self._init_live,
        )
        self._sdk_buttons["live_init"].grid(row=3, column=1, sticky="w", pady=(9, 0))
        self._sdk_buttons["live_track"] = ttk.Button(
            telemetry_panel,
            text="确认并发送事件（POST）",
            command=self._track_live,
        )
        self._sdk_buttons["live_track"].grid(
            row=3, column=2, sticky="w", padx=(8, 0), pady=(9, 0)
        )
        ttk.Label(
            telemetry_panel,
            text="提交后立即清空 URL 输入框；下一次动作必须重新输入。",
            style="Muted.TLabel",
        ).grid(row=3, column=3, sticky="e", pady=(9, 0))

        update_panel = ttk.LabelFrame(tab, text="Live update GET", padding=10)
        update_panel.grid(row=2, column=0, sticky="nsew", pady=(10, 0))
        update_panel.columnconfigure(1, weight=1)
        ttk.Label(update_panel, text="HTTPS base URL：").grid(
            row=0, column=0, sticky="w", padx=(0, 8)
        )
        ttk.Entry(update_panel, textvariable=self.update_base_url_var).grid(
            row=0, column=1, sticky="ew"
        )
        self._sdk_buttons["live_update"] = ttk.Button(
            update_panel,
            text="生成请求 URL、确认并 GET",
            command=self._check_live_update,
        )
        self._sdk_buttons["live_update"].grid(
            row=1, column=1, sticky="w", pady=(9, 0)
        )
        ttk.Label(
            update_panel,
            text=(
                "精确请求 URL 由 bridge 调用真实 SDK buildUpdateUrl() 离线生成后再确认。"
                "返回内容仅以不可信纯文本 JSON 展示；绝不打开链接。"
            ),
            wraplength=700,
            justify="left",
            style="Muted.TLabel",
        ).grid(row=2, column=0, columnspan=2, sticky="ew", pady=(10, 0))

    def _build_results_panel(self, parent: Any) -> Any:
        panel = ttk.LabelFrame(parent, text="结构化结果与日志", padding=8)
        panel.columnconfigure(0, weight=1)
        panel.rowconfigure(1, weight=1)
        toolbar = ttk.Frame(panel)
        toolbar.grid(row=0, column=0, columnspan=2, sticky="ew", pady=(0, 6))
        toolbar.columnconfigure(1, weight=1)
        self.progress = ttk.Progressbar(toolbar, mode="indeterminate", length=140)
        self.progress.grid(row=0, column=0, sticky="w")
        ttk.Label(toolbar, textvariable=self.busy_var).grid(
            row=0, column=1, sticky="w", padx=(8, 0)
        )
        ttk.Button(toolbar, text="复制全部", command=self._copy_results).grid(
            row=0, column=2, padx=(8, 0)
        )
        ttk.Button(toolbar, text="清空", command=self._clear_results).grid(
            row=0, column=3, padx=(8, 0)
        )
        self.results_text = tk.Text(
            panel, height=12, wrap="word", state="disabled", font=("Consolas", 9)
        )
        self.results_text.grid(row=1, column=0, sticky="nsew")
        results_scrollbar = ttk.Scrollbar(
            panel, orient="vertical", command=self.results_text.yview
        )
        results_scrollbar.grid(row=1, column=1, sticky="ns")
        self.results_text.configure(yscrollcommand=results_scrollbar.set)
        self.results_text.tag_configure("success", foreground="#047857")
        self.results_text.tag_configure("error", foreground="#b91c1c")
        self.results_text.tag_configure("info", foreground="#374151")
        return panel

    def _create_bridge(self) -> BridgeProcess:
        if not self.bridge_path.is_file():
            raise FileNotFoundError(f"找不到 Node 桥接：{self.bridge_path}")
        repository_root = repository_root_for_bridge(self.bridge_path)
        if repository_root is None:
            raise RuntimeError(f"无法从桥接路径定位仓库根目录：{self.bridge_path}")
        sdk_entry = (
            repository_root
            / "packages"
            / "telemetry-update-sdk"
            / "dist"
            / "index.js"
        )
        if not sdk_entry.is_file():
            raise RuntimeError(
                "SDK 尚未构建。请在仓库根目录运行：npm ci；然后运行："
                "npm run build --workspace @bifang/telemetry-update-sdk"
            )
        return BridgeProcess(self.bridge_path, node_command=self.node_command)

    def _mark_config_dirty(self, *_args: Any) -> None:
        if not hasattr(self, "runner"):
            return
        self._config_dirty = True
        self._update_controls()

    def _apply_config(self) -> None:
        values = {
            "app_id": self.app_id_var.get().strip(),
            "app_version": self.app_version_var.get().strip(),
            "platform": self.platform_var.get().strip(),
            "arch": self.arch_var.get().strip(),
            "channel": self.channel_var.get().strip(),
        }
        if any(not value for value in values.values()):
            self.controller.report_input_error("应用配置", "所有配置字段都必须非空")
            return
        submitted = self.controller.apply_config(ClientConfig(**values))
        if submitted:
            self._update_controls()

    def _require_applied_config(self, operation: str) -> bool:
        if not self._config_dirty:
            return True
        self.controller.report_input_error(
            operation, "配置有未应用更改；请先点击“应用配置并重置会话”"
        )
        return False

    def _init_capture(self) -> None:
        if self._require_applied_config("初始化本地捕获"):
            self.controller.init_capture()

    def _track_capture(self) -> None:
        if not self._require_applied_config("本地事件预览"):
            return
        try:
            properties = parse_json_object(
                self.local_properties_text.get("1.0", "end-1c"), "properties"
            )
        except ValueError as error:
            self.controller.report_input_error("本地事件预览", str(error))
            return
        self.controller.track_capture(self.local_event_var.get(), properties)

    def _preview_update(self) -> None:
        if not self._require_applied_config("本地更新判定"):
            return
        try:
            manifest = parse_json_object(
                self.manifest_text.get("1.0", "end-1c"), "更新 manifest"
            )
        except ValueError as error:
            self.controller.report_input_error("本地更新判定", str(error))
            return
        self.controller.preview_update(manifest)

    def _init_live(self) -> None:
        if not self._require_applied_config("初始化 Live telemetry"):
            return
        if self.controller.init_live(self.telemetry_endpoint_var.get()):
            self.telemetry_endpoint_var.set("")

    def _track_live(self) -> None:
        if not self._require_applied_config("Live telemetry 事件"):
            return
        try:
            properties = parse_json_object(
                self.live_properties_text.get("1.0", "end-1c"), "properties"
            )
        except ValueError as error:
            self.controller.report_input_error("Live telemetry 事件", str(error))
            return
        if self.controller.track_live(
            self.telemetry_endpoint_var.get(), self.live_event_var.get(), properties
        ):
            self.telemetry_endpoint_var.set("")

    def _check_live_update(self) -> None:
        if not self._require_applied_config("Live 更新检查"):
            return
        if self.controller.prepare_live_update_check(self.update_base_url_var.get()):
            self.update_base_url_var.set("")

    def _refresh_status(self) -> None:
        self.controller.refresh_status()

    def _load_local_event_example(self) -> None:
        self._replace_text(
            self.local_properties_text,
            json.dumps(
                event_example(self.local_event_var.get()), ensure_ascii=False, indent=2
            ),
        )

    def _load_live_event_example(self) -> None:
        self._replace_text(
            self.live_properties_text,
            json.dumps(
                event_example(self.live_event_var.get()), ensure_ascii=False, indent=2
            ),
        )

    def _load_manifest_file(self) -> None:
        if filedialog is None:
            return
        selected = filedialog.askopenfilename(
            parent=self.root,
            title="选择本地更新 manifest JSON",
            filetypes=(("JSON", "*.json"), ("所有文件", "*.*")),
        )
        if not selected:
            return
        try:
            content = Path(selected).read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            self.controller.report_input_error("载入本地 JSON", str(error))
            return
        self._replace_text(self.manifest_text, content)
        self._append_record(
            new_record(
                "info",
                "载入本地 JSON",
                {
                    "loaded": True,
                    "network_performed": False,
                    "message": "文件内容只载入当前窗口，尚未调用 SDK",
                },
            )
        )

    def _confirm_network(self, intent: NetworkIntent) -> bool:
        dialog = ExactNetworkConfirmationDialog(self.root, intent)
        self._active_confirmation = dialog
        try:
            return dialog.ask()
        finally:
            self._active_confirmation = None

    def _render_state(self, snapshot: ControllerSnapshot) -> None:
        if self._closing:
            return
        self._last_snapshot = snapshot
        visible_config = {
            "app_id": self.app_id_var.get().strip(),
            "app_version": self.app_version_var.get().strip(),
            "platform": self.platform_var.get().strip(),
            "arch": self.arch_var.get().strip(),
            "channel": self.channel_var.get().strip(),
        }
        self._config_dirty = visible_config != snapshot.config
        bridge_labels = {
            "disconnected": "本地桥接：未连接",
            "connecting": "本地桥接：正在探活（零网络）",
            "ready": f"本地桥接：就绪 · SDK {snapshot.sdk_version}",
            "error": "本地桥接：不可用或连接失败（查看结果区）",
            "closing": "本地桥接：正在后台关闭",
        }
        self.bridge_status_var.set(
            bridge_labels.get(snapshot.bridge_status, snapshot.bridge_status)
        )
        self.capture_state_var.set(self._identity_text("本地捕获", snapshot.capture))
        self.live_state_var.set(self._identity_text("Live telemetry", snapshot.live))
        self._update_controls()

    @staticmethod
    def _identity_text(label: str, identity: IdentityState) -> str:
        if not identity.initialized:
            return f"{label}：未初始化\ninstall_id：—\nsession_id：—"
        enabled = "enabled" if identity.enabled else "disabled"
        return (
            f"{label}：已初始化 · {enabled}\n"
            f"install_id：{identity.install_id}\n"
            f"session_id：{identity.session_id}"
        )

    def _on_busy_change(self, busy: bool, label: Optional[str]) -> None:
        if busy:
            self.busy_var.set(label or "处理中…")
            self.progress.start(12)
        else:
            self.busy_var.set("就绪")
            self.progress.stop()
        self._update_controls()

    def _update_controls(self) -> None:
        if not self._sdk_buttons or not hasattr(self, "runner"):
            return
        snapshot = self._last_snapshot
        ready = (
            snapshot is not None
            and snapshot.bridge_status == "ready"
            and not self.runner.busy
            and not self._closing
        )
        clean = ready and not self._config_dirty
        capture_ready = clean and snapshot is not None and snapshot.capture.initialized
        identity_ready = clean and snapshot is not None and (
            snapshot.capture.initialized or snapshot.live.initialized
        )
        live_ready = clean and snapshot is not None and snapshot.live.initialized
        states = {
            "apply": ready and self._config_dirty,
            "status": ready,
            "capture_init": clean,
            "capture_track": capture_ready,
            "preview_update": identity_ready,
            "live_init": clean,
            "live_track": live_ready,
            "live_update": identity_ready,
        }
        for name, button in self._sdk_buttons.items():
            button.configure(state="normal" if states.get(name, False) else "disabled")

    def _append_record(self, record: GuiRecord) -> None:
        if self._closing:
            return
        payload = json.dumps(record.data, ensure_ascii=False, indent=2, sort_keys=True)
        rendered = f"[{record.timestamp}] {record.operation}\n{payload}\n\n"
        self.results_text.configure(state="normal")
        self.results_text.insert("end", rendered, record.level)
        self.results_text.configure(state="disabled")
        self.results_text.see("end")

    def _clear_results(self) -> None:
        self.results_text.configure(state="normal")
        self.results_text.delete("1.0", "end")
        self.results_text.configure(state="disabled")

    def _copy_results(self) -> None:
        content = self.results_text.get("1.0", "end-1c")
        self.root.clipboard_clear()
        self.root.clipboard_append(content)

    @staticmethod
    def _replace_text(widget: Any, value: str) -> None:
        widget.delete("1.0", "end")
        widget.insert("1.0", value)

    def _schedule_poll(self) -> None:
        if self._closing:
            return
        try:
            self.runner.poll()
        except BaseException as error:
            if not self._closing:
                self._append_record(
                    new_record("error", "UI 完成队列", structured_error(error))
                )
        if self._closing:
            return
        try:
            window_exists = bool(self.root.winfo_exists())
        except Exception:
            window_exists = False
        if window_exists:
            self._poll_after_id = self.root.after(50, self._schedule_poll)

    def _on_close(self) -> None:
        if self._closing:
            return
        self._closing = True
        if self._active_confirmation is not None:
            self._active_confirmation.cancel()
        if self._poll_after_id is not None:
            try:
                self.root.after_cancel(self._poll_after_id)
            except Exception:
                pass
            self._poll_after_id = None
        self.busy_var.set("正在后台关闭 Node 桥接…")
        self.progress.start(12)
        self._update_controls()
        closer = self.controller.begin_close()
        deadline = time.monotonic() + 6

        def finish_when_closed() -> None:
            self.runner.poll()
            closer_done = closer is None or not closer.is_alive()
            if (
                (closer_done and not self.runner.busy)
                or time.monotonic() >= deadline
            ):
                self.runner.shutdown()
                self._cleanup_complete = True
                self.root.destroy()
                return
            self.root.after(50, finish_when_closed)

        self.root.after(0, finish_when_closed)

    def ensure_closed(self) -> None:
        """Best-effort non-UI cleanup if mainloop exits outside WM_DELETE_WINDOW."""
        if self._cleanup_complete:
            return
        self._closing = True
        if self._active_confirmation is not None:
            self._active_confirmation.cancel()
        closer = self.controller.begin_close()
        if closer is not None:
            closer.join(timeout=5)
        self.runner.shutdown()
        self._cleanup_complete = True


def parse_gui_arguments(argv: Optional[Iterable[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Open the Windows GUI manual client for the Bifang SDK bridge."
    )
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=DEFAULT_STATE_ROOT,
        help="tool-owned identity-state root (default: OS temp)",
    )
    parser.add_argument(
        "--bridge",
        type=Path,
        default=Path(__file__).with_name("bridge.mjs"),
        help="path to bridge.mjs",
    )
    parser.add_argument("--node", default="node", help="Node.js executable")
    return parser.parse_args(argv)


def enable_windows_dpi_awareness() -> None:
    if os.name != "nt":
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except (AttributeError, OSError):
        pass


def main(argv: Optional[Iterable[str]] = None) -> int:
    arguments = parse_gui_arguments(argv)
    if tk is None:
        print(
            "当前 Python 未包含 Tkinter。请安装带 Tk/ttk 的标准 Python 3.9+。",
            file=sys.stderr,
        )
        return 2
    enable_windows_dpi_awareness()
    try:
        root = tk.Tk()
    except Exception as error:
        print(f"无法创建 GUI 窗口：{error}", file=sys.stderr)
        return 2
    app = SdkGuiApplication(
        root,
        state_root=arguments.state_dir,
        bridge_path=arguments.bridge,
        node_command=arguments.node,
    )
    app.start()
    try:
        root.mainloop()
    finally:
        app.ensure_closed()
    return 0


if __name__ == "__main__":
    if os.name == "nt":
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
