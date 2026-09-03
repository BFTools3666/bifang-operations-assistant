"""CloudBase deployment acceptance wizard for non-technical operators.

The Tkinter view only presents a guided workflow. The long-lived Node process
loads the real TypeScript SDK, creates every telemetry envelope, validates it,
performs explicitly requested network calls, and returns per-event delivery
receipts. Importing this module is always headless and never starts networking.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import ctypes
import json
import os
import queue
import re
import sys
import tempfile
import threading
import time
import uuid
import webbrowser
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import urlparse

try:
    import tkinter as tk
    from tkinter import ttk
except ImportError:  # pragma: no cover - only Python builds without Tk.
    tk = None
    ttk = None

from client import (
    BridgeError,
    BridgeProcess,
    detect_sdk_architecture,
    detect_sdk_platform,
)


WINDOW_TITLE = "CloudBase 功能验证助手"
CLOUD_CONSOLE_URL = "https://tcb.cloud.tencent.com/"
DATABASE_PATH = (
    "云开发统一工作台 → 选择环境 → 文档型数据库 → 集合管理 → "
    "telemetry_events（匿名统计数据表）→ 文档列表 → 筛选"
)
DEFAULT_STATE_ROOT = Path(tempfile.gettempdir()) / "bifang-cloudbase-validator"
LIVE_TELEMETRY_ENDPOINT_DEFAULT = ""
LIVE_UPDATE_URL_DEFAULT = ""

EXAMPLE_APPLICATION_ID = "example-tool"
EXAMPLE_CURRENT_VERSION = "0.1.0"
EXAMPLE_TELEMETRY_URL = (
    "https://bifang-telemetry-prod-d8efa6a8d3-1251031333."
    "ap-shanghai.app.tcloudbase.com/v1/track"
)
EXAMPLE_UPDATE_URL = (
    "https://bifang-telemetry-prod-d8efa6a8d3-1251031333."
    "ap-shanghai.app.tcloudbase.com/updates/example-tool/windows.json"
)

STEP_TITLES = (
    "第一步：完成云端准备",
    "第二步：填写你的 CloudBase 信息",
    "第三步：发送测试数据",
    "第四步：验证版本更新",
)

RESOURCE_GUIDE: Tuple[Tuple[str, str], ...] = (
    (
        "telemetry 云函数",
        "这是接收测试数据的小程序。按本项目模板部署，函数入口使用 index.main。",
    ),
    (
        "POST /v1/track",
        "这是数据进入云函数的固定通道。把它指向上面的云函数，并允许匿名调用。",
    ),
    (
        "telemetry_events",
        "这是保存测试结果的数据库集合。收到成功回执前，云函数会先把记录写进这里。",
    ),
    (
        "ALLOWED_APP_IDS",
        "这是云函数的“允许应用名单”环境变量。把准备验证的应用编号填进去。",
    ),
    (
        "更新 JSON",
        "这是云端版本说明文件。发布为 updates/<应用编号>/windows.json。",
    ),
)

EVENT_CARD_DEFINITIONS: Tuple[Tuple[str, str, str], ...] = (
    ("app_install", "安装记录", "安装记录 +1"),
    ("app_start", "启动记录", "启动记录 +1"),
    ("feature_used", "核心功能使用", "核心功能使用 +1"),
    ("task_started", "任务开始", "任务开始 +1"),
    ("task_succeeded", "任务成功", "任务成功 +1"),
    ("task_failed", "任务失败", "任务失败 +1"),
    ("update_prompt_shown", "更新提示展示", "更新提示展示 +1"),
    ("update_clicked", "更新按钮点击", "更新按钮点击 +1"),
)
EXPECTED_EVENT_ORDER = tuple(item[0] for item in EVENT_CARD_DEFINITIONS)
EVENT_NAMES = {item[0]: item[1] for item in EVENT_CARD_DEFINITIONS}
EVENT_DELTAS = {item[0]: item[2] for item in EVENT_CARD_DEFINITIONS}

PROGRESS_STAGES = (
    "正在检查填写内容",
    "正在连接 CloudBase",
    "正在发送匿名测试数据",
    "CloudBase 已确认接收",
)
UPDATE_DOWNLOAD_ERROR = "没有打开下载页面，请检查默认浏览器。"

# All ordinary static copy is assembled from these Chinese product concepts.
# Necessary CloudBase names live only in RESOURCE_GUIDE, directly beside an
# explanation. Protocol fields remain in the collapsed troubleshooting area.
PRIMARY_UI_TEXT = "\n".join(
    (
        WINDOW_TITLE,
        *STEP_TITLES,
        "打开新手部署文档",
        "打开 CloudBase 控制台",
        "应用编号",
        "当前版本",
        "数据接收地址",
        "更新文件地址",
        "载入本项目示例",
        "发送一组测试数据到 CloudBase",
        "模拟 10 台设备使用",
        "本次云端数据预览",
        "复制本次测试查询条件",
        "复制本次模拟的筛选条件",
        "复制数据库查询条件",
        "打开 CloudBase 数据表",
        "检查有没有新版本",
        "立即更新",
        "稍后提醒",
        "退出软件",
        "显示高级排错信息",
        *PROGRESS_STAGES,
        *(item[1] for item in EVENT_CARD_DEFINITIONS),
        *(item[2] for item in EVENT_CARD_DEFINITIONS),
    )
)

APP_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
SEMVER_PATTERN = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)


@dataclass(frozen=True)
class ConnectionSettings:
    application_id: str
    current_version: str
    telemetry_url: str
    update_url: str
    platform: str = "windows"
    architecture: str = "x64"

    def normalized(self) -> "ConnectionSettings":
        return ConnectionSettings(
            application_id=self.application_id.strip(),
            current_version=self.current_version.strip(),
            telemetry_url=self.telemetry_url.strip(),
            update_url=self.update_url.strip(),
            platform=self.platform,
            architecture=self.architecture,
        )

    def bridge_fields(self) -> Dict[str, Any]:
        return {
            "app_id": self.application_id,
            "app_version": self.current_version,
            "platform": self.platform,
            "arch": self.architecture,
            "channel": "official",
        }


@dataclass(frozen=True)
class SendConfirmation:
    host: str
    target_url: str
    record_names: Tuple[str, ...]
    explanation: str


@dataclass(frozen=True)
class DeliveryCard:
    event_name: str
    title: str
    delta: str
    acknowledged: bool
    status_text: str
    detail: str
    event_id: Optional[str]
    query_text: Optional[str]


@dataclass(frozen=True)
class BatchFeedback:
    summary: str
    detail: str
    tone: str
    confirmed_count: int
    expected_count: int
    cards: Tuple[DeliveryCard, ...]
    batch_query_text: Optional[str]
    advanced: Any


@dataclass(frozen=True)
class SimulationFeedback:
    summary: str
    detail: str
    tone: str
    device_count: int
    planned_device_count: int
    acknowledged_record_count: int
    planned_record_count: int
    failed_record_count: int
    install_count: int
    start_count: int
    version_distribution: Tuple[Tuple[str, int], ...]
    channel_distribution: Tuple[Tuple[str, int], ...]
    feature_count: int
    task_success_count: int
    task_failure_count: int
    task_success_rate: int
    filter_text: Optional[str]
    advanced: Any


@dataclass(frozen=True)
class UpdateFeedback:
    state: str
    summary: str
    detail: str
    tone: str
    current_version: str
    latest_version: Optional[str] = None
    remote_message: Optional[str] = None
    download_url: Optional[str] = None
    dialog_mode: Optional[str] = None
    primary_button: Optional[str] = None
    secondary_button: Optional[str] = None
    advanced: Any = None


@dataclass(frozen=True)
class ControllerState:
    helper_status: str
    busy: bool
    busy_label: Optional[str]


def complete_https_url(value: str) -> bool:
    """Accept only a complete HTTPS URL with a host and no credentials."""
    try:
        parsed = urlparse(value)
        return (
            parsed.scheme == "https"
            and bool(parsed.hostname)
            and parsed.username is None
            and parsed.password is None
        )
    except (TypeError, ValueError):
        return False


def validate_settings(
    settings: ConnectionSettings,
    *,
    require_telemetry: bool,
    require_update: bool,
) -> Optional[str]:
    value = settings.normalized()
    if not APP_ID_PATTERN.fullmatch(value.application_id):
        return (
            "请检查“应用编号”：只能使用小写字母、数字、点、短横线或下划线，"
            "并以小写字母或数字开头。"
        )
    if not SEMVER_PATTERN.fullmatch(value.current_version):
        return "请把“当前版本”填写成类似 1.2.3 的完整版本号。"
    if require_telemetry and not complete_https_url(value.telemetry_url):
        return "请填写以 https:// 开头的完整“数据接收地址”，并包含 /v1/track。"
    if require_telemetry and not urlparse(value.telemetry_url).path.endswith(
        "/v1/track"
    ):
        return "“数据接收地址”应以 /v1/track 结尾，请回到 CloudBase 复制完整地址。"
    if require_update and not complete_https_url(value.update_url):
        return "请填写以 https:// 开头的完整“更新文件地址”。"
    if require_update and not urlparse(value.update_url).path.endswith(
        "/windows.json"
    ):
        return "“更新文件地址”应指向完整的 windows.json 文件。"
    return None


def compact_query(field: str, value: str) -> str:
    return json.dumps({field: value}, ensure_ascii=False, separators=(",", ":"))


def _error_parts(error: Any) -> Tuple[str, str, Optional[int], Optional[str]]:
    if isinstance(error, BridgeError):
        return error.code, error.message, None, None
    if isinstance(error, dict):
        nested = error.get("error")
        if isinstance(nested, dict):
            merged = {**error, **nested}
        else:
            merged = error
        raw_status = merged.get("http_status", merged.get("status"))
        status = raw_status if isinstance(raw_status, int) else None
        server_error = merged.get("server_error")
        return (
            str(merged.get("code", merged.get("type", ""))),
            str(merged.get("message", "")),
            status,
            str(server_error) if server_error is not None else None,
        )
    return type(error).__name__, str(error), None, None


def friendly_error(error: Any) -> str:
    """Translate transport, bridge, and CloudBase failures into next actions."""
    code, message, status, server_error = _error_parts(error)
    lowered = f"{code} {message} {server_error or ''}".lower()
    if status == 400:
        return (
            "CloudBase 认为这条数据格式不完整（400）。请核对应用编号和当前版本，"
            "再重新发送。"
        )
    if status == 403 or "app_not_allowed" in lowered or "forbidden" in lowered:
        return (
            "CloudBase 还不允许这个应用编号（403）。请把它加入云函数的允许名单"
            "（环境变量 ALLOWED_APP_IDS），保存并重新部署后再试。"
        )
    if status == 404 or "not_found" in lowered:
        return (
            "没有找到接收通道（404）。请在 CloudBase 核对 HTTP 路由 /v1/track，"
            "并确认粘贴的是完整数据接收地址。"
        )
    if status == 429 or "rate" in lowered:
        return "发送太频繁（429）。请等待一分钟，再点击一次发送。"
    if status is not None and status >= 500:
        return (
            f"CloudBase 服务暂时出错（{status}）。请先确认云函数已部署且状态正常，"
            "稍后再试。"
        )
    if "unsafe" in lowered or "invalid_url" in lowered or "url" in lowered and (
        "invalid" in lowered or "must" in lowered
    ):
        return "地址不合法。请从 CloudBase 复制以 https:// 开头的完整地址。"
    if "bridge" in lowered or "closed" in lowered:
        return "本地检查组件没有准备好。请关闭本窗口后重新打开再试。"
    if (
        "timeout" in lowered
        or "timed out" in lowered
        or "network" in lowered
        or "fetch" in lowered
        or "unavailable" in lowered
    ):
        return (
            "连接超时或网络不可用。请检查云端资源是否已部署、地址是否能在浏览器中"
            "打开，以及本机网络是否正常。"
        )
    if (
        "ack" in lowered
        or "response" in lowered
        or "rejected" in lowered
        or "server" in lowered
    ):
        return (
            "CloudBase 没有确认保存这条数据。请检查应用允许名单和云函数字段配置，"
            "然后重新发送。"
        )
    return "这一步没有完成。请先核对填写内容和 CloudBase 部署状态，再重试。"


def friendly_update_error(error: Any) -> str:
    """Translate update-file failures without suggesting telemetry fixes."""
    code, message, status, server_error = _error_parts(error)
    lowered = f"{code} {message} {server_error or ''}".lower()
    if status == 404 or "not_found" in lowered:
        return (
            "静态托管中没有找到这个更新文件（404）。请确认已发布到"
            " updates/<应用编号>/windows.json，并重新复制完整更新文件地址。"
        )
    if status == 403 or "forbidden" in lowered:
        return (
            "更新文件当前不能公开读取（403）。请检查 CloudBase 静态托管权限，"
            "确认无需登录也能在浏览器中打开。"
        )
    if status is not None and status >= 500:
        return (
            f"CloudBase 静态托管暂时不可用（{status}）。请在控制台确认服务状态，"
            "稍后再检查。"
        )
    if "unsafe" in lowered or "invalid_url" in lowered:
        return (
            "更新文件地址不正确。请填写以 https:// 开头、以"
            " /<应用编号>/windows.json 结尾的完整地址。"
        )
    if "bridge" in lowered or "closed" in lowered:
        return "本地检查组件没有准备好。请关闭本窗口后重新打开再试。"
    if (
        "timeout" in lowered
        or "network" in lowered
        or "fetch" in lowered
        or "unavailable" in lowered
    ):
        return (
            "暂时无法读取更新文件。请核对完整更新文件地址能否在浏览器中打开，"
            "并检查本机网络。"
        )
    return "没有读到可用的云端更新文件。请按新手部署文档重新核对并发布。"


def _delivery_success(item: Dict[str, Any]) -> bool:
    # Do not accept the old http_ok/accepted-by-SDK signals. Only the explicit
    # receipt means the response was 2xx and its JSON body contained ok:true.
    return item.get("acknowledged") is True


def build_batch_feedback(result: Any) -> BatchFeedback:
    raw_deliveries = result.get("deliveries") if isinstance(result, dict) else None
    deliveries = raw_deliveries if isinstance(raw_deliveries, list) else []
    by_event: Dict[str, List[Dict[str, Any]]] = {}
    for item in deliveries:
        if isinstance(item, dict) and isinstance(item.get("event"), str):
            by_event.setdefault(item["event"], []).append(item)

    cards: List[DeliveryCard] = []
    confirmed_count = 0
    for event_name in EXPECTED_EVENT_ORDER:
        candidates = by_event.get(event_name, [])
        item = candidates.pop(0) if candidates else {}
        acknowledged = _delivery_success(item)
        event_id = item.get("event_id")
        if not isinstance(event_id, str):
            event_id = None
        if acknowledged:
            confirmed_count += 1
            status_text = "已成功，CloudBase 已确认保存"
            detail = (
                "这条匿名样例已保存。可复制查询条件，到数据库中核对对应记录。"
            )
        else:
            status_text = "没有收到"
            detail = friendly_error(item.get("error", item))
        cards.append(
            DeliveryCard(
                event_name=event_name,
                title=EVENT_NAMES[event_name],
                delta=EVENT_DELTAS[event_name],
                acknowledged=acknowledged,
                status_text=status_text,
                detail=detail,
                event_id=event_id,
                query_text=compact_query("event_id", event_id) if event_id else None,
            )
        )

    expected_count = len(EXPECTED_EVENT_ORDER)
    missing_count = expected_count - confirmed_count
    if confirmed_count == expected_count:
        summary = f"CloudBase 已成功收到 {confirmed_count} 条测试数据"
        detail = "八类匿名样例都已得到云端保存确认。下一步可复制整批查询条件去数据库核对。"
        tone = "success"
    elif confirmed_count:
        summary = (
            f"CloudBase 已确认收到 {confirmed_count} 条，"
            f"另有 {missing_count} 条需要处理"
        )
        detail = "已成功的结果会保留；请按失败卡片的提示处理后，再发送一组新的测试数据。"
        tone = "warning"
    else:
        summary = "CloudBase 还没有确认收到测试数据"
        detail = "请按下方每张卡片的提示检查，修正后再发送。"
        tone = "error"

    session_id = result.get("session_id") if isinstance(result, dict) else None
    batch_query = (
        compact_query("session_id", session_id)
        if isinstance(session_id, str) and session_id
        else None
    )
    return BatchFeedback(
        summary=summary,
        detail=detail,
        tone=tone,
        confirmed_count=confirmed_count,
        expected_count=expected_count,
        cards=tuple(cards),
        batch_query_text=batch_query,
        advanced=result,
    )


def failed_batch_feedback(error: Any) -> BatchFeedback:
    hint = friendly_error(error)
    cards = tuple(
        DeliveryCard(
            event_name=event_name,
            title=EVENT_NAMES[event_name],
            delta=EVENT_DELTAS[event_name],
            acknowledged=False,
            status_text="没有收到",
            detail=hint,
            event_id=None,
            query_text=None,
        )
        for event_name in EXPECTED_EVENT_ORDER
    )
    return BatchFeedback(
        summary="CloudBase 还没有确认收到测试数据",
        detail=hint,
        tone="error",
        confirmed_count=0,
        expected_count=len(EXPECTED_EVENT_ORDER),
        cards=cards,
        batch_query_text=None,
        advanced={
            "error": {
                "code": _error_parts(error)[0],
                "message": _error_parts(error)[1],
            }
        },
    )


CHANNEL_NAMES = {
    "official": "官方渠道",
    "wechat": "微信渠道",
    "bilibili": "哔哩哔哩渠道",
}


def _simulation_deliveries(device: Dict[str, Any]) -> List[Dict[str, Any]]:
    value = device.get("deliveries")
    return [item for item in value if isinstance(item, dict)] if isinstance(
        value, list
    ) else []


def build_simulation_feedback(result: Any) -> SimulationFeedback:
    """Summarize only acknowledged receipts from the ten-device SDK run."""
    raw_devices = result.get("devices") if isinstance(result, dict) else None
    devices = [item for item in raw_devices if isinstance(item, dict)] if isinstance(
        raw_devices, list
    ) else []
    acknowledged: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
    acknowledged_devices: List[Dict[str, Any]] = []
    failed_receipts: List[Dict[str, Any]] = []
    for device in devices:
        all_receipts = _simulation_deliveries(device)
        receipts = [
            receipt
            for receipt in all_receipts
            if _delivery_success(receipt)
        ]
        failed_receipts.extend(
            receipt for receipt in all_receipts if not _delivery_success(receipt)
        )
        if receipts:
            acknowledged_devices.append(device)
            acknowledged.extend((device, receipt) for receipt in receipts)

    def event_count(name: str) -> int:
        return sum(
            1 for _device, receipt in acknowledged if receipt.get("event") == name
        )

    versions: Dict[str, int] = {}
    channels: Dict[str, int] = {}
    for device in acknowledged_devices:
        version = device.get("app_version")
        channel = device.get("channel")
        if isinstance(version, str):
            versions[version] = versions.get(version, 0) + 1
        if isinstance(channel, str):
            display = CHANNEL_NAMES.get(channel, "其他渠道")
            channels[display] = channels.get(display, 0) + 1

    successes = event_count("task_succeeded")
    failures = event_count("task_failed")
    completed_tasks = successes + failures
    success_rate = (
        round(successes * 100 / completed_tasks) if completed_tasks else 0
    )
    acknowledged_ids = [
        receipt.get("event_id")
        for _device, receipt in acknowledged
        if isinstance(receipt.get("event_id"), str)
    ]
    filter_text = (
        json.dumps(
            {"event_id": {"$in": acknowledged_ids}},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        if acknowledged_ids
        else None
    )
    device_count = len(acknowledged_devices)
    acknowledged_count = len(acknowledged)
    planned_record_count = 50
    failed_record_count = max(0, planned_record_count - acknowledged_count)
    failure_hint = (
        friendly_error(
            failed_receipts[0].get("error", failed_receipts[0])
        )
        if failed_receipts
        else "请核对填写内容和 CloudBase 部署状态后重试。"
    )
    if device_count == 10 and acknowledged_count == planned_record_count:
        summary = f"CloudBase 已确认收到 {device_count} 台匿名设备的模拟数据"
        detail = (
            f"已保存 {acknowledged_count}/{planned_record_count} 条，失败 0 条。"
            "下面所有数字都来自云端逐条确认，"
            "不是发送前的计划数。"
        )
        tone = "success"
    elif acknowledged_count:
        summary = (
            f"CloudBase 已保存 {acknowledged_count}/{planned_record_count} 条模拟数据"
        )
        detail = (
            f"失败 {failed_record_count} 条；未确认的记录没有计入下面统计。"
            f"处理建议：{failure_hint}"
        )
        tone = "warning"
    else:
        summary = "CloudBase 还没有确认收到模拟数据"
        detail = failure_hint
        tone = "error"

    return SimulationFeedback(
        summary=summary,
        detail=detail,
        tone=tone,
        device_count=device_count,
        planned_device_count=10,
        acknowledged_record_count=acknowledged_count,
        planned_record_count=planned_record_count,
        failed_record_count=failed_record_count,
        install_count=event_count("app_install"),
        start_count=event_count("app_start"),
        version_distribution=tuple(sorted(versions.items())),
        channel_distribution=tuple(sorted(channels.items())),
        feature_count=event_count("feature_used"),
        task_success_count=successes,
        task_failure_count=failures,
        task_success_rate=success_rate,
        filter_text=filter_text,
        advanced=result,
    )


def failed_simulation_feedback(error: Any) -> SimulationFeedback:
    return SimulationFeedback(
        summary="CloudBase 还没有确认收到模拟数据",
        detail=friendly_error(error),
        tone="error",
        device_count=0,
        planned_device_count=10,
        acknowledged_record_count=0,
        planned_record_count=50,
        failed_record_count=50,
        install_count=0,
        start_count=0,
        version_distribution=(),
        channel_distribution=(),
        feature_count=0,
        task_success_count=0,
        task_failure_count=0,
        task_success_rate=0,
        filter_text=None,
        advanced=_safe_error(error),
    )


def _update_config(result: Dict[str, Any], decision: Dict[str, Any]) -> Dict[str, Any]:
    direct = result.get("config")
    if isinstance(direct, dict):
        return direct
    nested = decision.get("config")
    return nested if isinstance(nested, dict) else {}


def build_update_feedback(
    result: Any, current_version: str
) -> UpdateFeedback:
    if not isinstance(result, dict):
        return UpdateFeedback(
            state="error",
            summary="暂时无法检查更新",
            detail=friendly_update_error(result),
            tone="error",
            current_version=current_version,
            advanced=result,
        )
    decision = result.get("decision")
    if not isinstance(decision, dict):
        decision = {}
    config = _update_config(result, decision)
    latest = config.get("latest_version")
    latest_version = latest if isinstance(latest, str) else None
    remote_message = config.get("message")
    if not isinstance(remote_message, str):
        remote_message = None
    download_url = config.get("download_url")
    if not isinstance(download_url, str):
        download_url = None

    kind = decision.get("kind")
    if kind == "optional" and latest_version:
        return UpdateFeedback(
            state="optional_update",
            summary=f"发现新版本 {latest_version}",
            detail=(
                f"这是普通更新。当前版本 {current_version}，"
                f"最新版本 {latest_version}。"
                + (f"\n{remote_message}" if remote_message else "")
            ),
            tone="update",
            current_version=current_version,
            latest_version=latest_version,
            remote_message=remote_message,
            download_url=download_url,
            dialog_mode="optional",
            primary_button="立即更新",
            secondary_button="稍后提醒",
            advanced=result,
        )
    if kind == "required" and latest_version:
        return UpdateFeedback(
            state="required_update",
            summary="当前版本已停止支持，请升级后继续使用",
            detail=(
                f"当前版本 {current_version}，可升级到 {latest_version}。"
                + (f"\n{remote_message}" if remote_message else "")
            ),
            tone="error",
            current_version=current_version,
            latest_version=latest_version,
            remote_message=remote_message,
            download_url=download_url,
            dialog_mode="required",
            primary_button="立即更新",
            secondary_button="退出软件",
            advanced=result,
        )

    reason = str(decision.get("reason", "unavailable"))
    if reason == "up_to_date":
        return UpdateFeedback(
            state="up_to_date",
            summary="你现在已经是最新版",
            detail=(
                f"当前版本是 {current_version}"
                + (
                    f"，云端最新版本是 {latest_version}。"
                    if latest_version
                    else "。"
                )
            ),
            tone="success",
            current_version=current_version,
            latest_version=latest_version,
            remote_message=remote_message,
            advanced=result,
        )
    if reason == "disabled":
        return UpdateFeedback(
            state="paused",
            summary="云端已暂停这次更新",
            detail=(
                f"当前版本是 {current_version}"
                + (
                    f"，云端文件中的最新版本是 {latest_version}。"
                    if latest_version
                    else "。"
                )
                + "当前不会提示用户升级。重新启用云端更新文件后，再点击检查。"
            ),
            tone="warning",
            current_version=current_version,
            latest_version=latest_version,
            remote_message=remote_message,
            advanced=result,
        )
    if reason == "rollout":
        return UpdateFeedback(
            state="not_selected",
            summary="云端已有新版，但这台电脑暂时不在本次发布范围内",
            detail=(
                f"当前版本 {current_version}"
                + (
                    f"，云端版本 {latest_version}。"
                    if latest_version
                    else "。"
                )
                + "这是正常的分批发布结果。"
            ),
            tone="warning",
            current_version=current_version,
            latest_version=latest_version,
            remote_message=remote_message,
            advanced=result,
        )
    if reason == "invalid_config":
        return UpdateFeedback(
            state="invalid_file",
            summary="云端更新文件内容需要检查",
            detail=(
                "文件可能缺少必填内容，或应用编号、系统、版本号不匹配。"
                "请按新手部署文档逐项核对。"
            ),
            tone="error",
            current_version=current_version,
            latest_version=latest_version,
            advanced=result,
        )

    diagnostic = result.get("fetch_diagnostic", result)
    return UpdateFeedback(
        state="error",
        summary="暂时无法检查更新",
        detail=friendly_update_error(diagnostic),
        tone="error",
        current_version=current_version,
        latest_version=latest_version,
        advanced=result,
    )


class AsyncOperationRunner:
    """Run one operation at a time and deliver callbacks on the UI owner thread."""

    def __init__(
        self,
        on_busy_change: Callable[[bool, Optional[str]], None],
        executor: Optional[concurrent.futures.Executor] = None,
    ) -> None:
        self._executor = executor or concurrent.futures.ThreadPoolExecutor(
            max_workers=2, thread_name_prefix="cloudbase-validator"
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
            on_error(error)
            return False
        future.add_done_callback(
            lambda completed: self._completions.put(
                (completed, on_success, on_error)
            )
        )
        return True

    def poll(self) -> int:
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
                    on_error(error)
                else:
                    on_success(result)
            delivered += 1
        return delivered

    def stop_accepting(self) -> None:
        with self._lock:
            self._closing = True

    def shutdown(self) -> None:
        self.stop_accepting()
        if self._owns_executor:
            self._executor.shutdown(wait=False, cancel_futures=True)


class CloudBaseWizardController:
    """Headless workflow controller; suitable for CI without creating Tk."""

    def __init__(
        self,
        *,
        runner: AsyncOperationRunner,
        state_root: Path,
        confirm_send: Callable[[SendConfirmation], bool],
        on_progress: Callable[[str, int], None],
        on_batch: Callable[[BatchFeedback], None],
        on_simulation: Callable[[SimulationFeedback], None],
        on_update: Callable[[UpdateFeedback], None],
        on_message: Callable[[str, str, str], None],
        on_debug: Callable[[str, Any], None],
        on_state_change: Callable[[ControllerState], None],
        url_opener: Callable[[str], Any] = webbrowser.open,
        exit_application: Callable[[], None] = lambda: None,
    ) -> None:
        self.runner = runner
        self.state_root = state_root.expanduser().resolve()
        self.confirm_send = confirm_send
        self.on_progress = on_progress
        self.on_batch = on_batch
        self.on_simulation = on_simulation
        self.on_update = on_update
        self.on_message = on_message
        self.on_debug = on_debug
        self.on_state_change = on_state_change
        self.url_opener = url_opener
        self.exit_application = exit_application
        self.helper_status = "not_ready"
        self._bridge: Optional[BridgeProcess] = None
        self._connecting_bridge: Optional[BridgeProcess] = None
        self._bridge_lock = threading.Lock()
        self._closing = False

    @property
    def bridge(self) -> Optional[BridgeProcess]:
        return self._bridge

    def snapshot(self) -> ControllerState:
        return ControllerState(
            helper_status=self.helper_status,
            busy=self.runner.busy,
            busy_label=self.runner.busy_label,
        )

    def _emit_state(self) -> None:
        self.on_state_change(self.snapshot())

    def connect(self, bridge_factory: Callable[[], BridgeProcess]) -> bool:
        """Start the local Node helper and ping it; this performs no network I/O."""
        self.helper_status = "preparing"
        self._emit_state()

        def work() -> Tuple[BridgeProcess, Any]:
            bridge = bridge_factory()
            with self._bridge_lock:
                if self._closing:
                    bridge.close()
                    raise BridgeError("bridge_closed", "closed during startup")
                self._connecting_bridge = bridge
            try:
                ping = bridge.request("ping", timeout=5)
                if (
                    not isinstance(ping, dict)
                    or ping.get("network_performed") is not False
                ):
                    raise BridgeError(
                        "invalid_bridge_output", "local readiness response invalid"
                    )
                return bridge, ping
            except BaseException:
                bridge.close()
                raise

        def success(value: Tuple[BridgeProcess, Any]) -> None:
            bridge, ping = value
            with self._bridge_lock:
                self._connecting_bridge = None
                self._bridge = bridge
            self.helper_status = "ready"
            self.on_debug("本地检查组件已就绪（没有联网）", ping)
            self._emit_state()

        def failure(error: BaseException) -> None:
            self.helper_status = "error"
            self.on_message(
                "error", "本地检查组件没有准备好", friendly_error(error)
            )
            self.on_debug("本地检查组件启动失败", _safe_error(error))
            self._emit_state()

        return self.runner.submit("正在准备本地检查组件", work, success, failure)

    def send_test_batch(self, raw_settings: ConnectionSettings) -> bool:
        settings = raw_settings.normalized()
        self.on_progress(PROGRESS_STAGES[0], 25)
        input_error = validate_settings(
            settings, require_telemetry=True, require_update=False
        )
        if input_error:
            self.on_message("error", "请先修正填写内容", input_error)
            return False
        if not self._ready():
            return False

        parsed = urlparse(settings.telemetry_url)
        confirmation = SendConfirmation(
            host=parsed.hostname or settings.telemetry_url,
            target_url=settings.telemetry_url,
            record_names=tuple(item[1] for item in EVENT_CARD_DEFINITIONS),
            explanation=(
                "将发送 8 条匿名样例，只包含随机编号、当前版本和固定测试值；"
                "不会读取个人资料、文件内容、访问凭证或其他应用数据。"
            ),
        )
        try:
            approved = self.confirm_send(confirmation)
        except BaseException as error:
            self.on_message("error", "无法显示发送确认", friendly_error(error))
            return False
        if not approved:
            self.on_message(
                "info", "已取消发送", "没有向 CloudBase 发送任何测试数据。"
            )
            return False

        self.on_progress(PROGRESS_STAGES[1], 50)
        self.on_progress(PROGRESS_STAGES[2], 75)
        unique_root = self.state_root / f"batch-{uuid.uuid4().hex}"
        payload = {
            **settings.bridge_fields(),
            "state_dir": str(unique_root),
            "endpoint": settings.telemetry_url,
            "allow_network": True,
            "confirmation": "POST",
        }

        def success(result: Any) -> None:
            feedback = build_batch_feedback(result)
            if feedback.confirmed_count:
                self.on_progress(PROGRESS_STAGES[3], 100)
            else:
                self.on_progress("CloudBase 尚未确认接收", 100)
            self.on_batch(feedback)
            self.on_debug("本次发送的高级回执", result)

        def failure(error: BaseException) -> None:
            self.on_progress("CloudBase 尚未确认接收", 100)
            self.on_batch(failed_batch_feedback(error))
            self.on_debug("本次发送失败的高级信息", _safe_error(error))

        return self._submit(
            "正在发送匿名测试数据",
            "send_test_batch",
            payload,
            success,
            failure,
            timeout=45,
        )

    def simulate_devices(self, raw_settings: ConnectionSettings) -> bool:
        settings = raw_settings.normalized()
        self.on_progress(PROGRESS_STAGES[0], 25)
        input_error = validate_settings(
            settings, require_telemetry=True, require_update=False
        )
        if input_error:
            self.on_message("error", "请先修正填写内容", input_error)
            return False
        if not self._ready():
            return False
        parsed = urlparse(settings.telemetry_url)
        confirmation = SendConfirmation(
            host=parsed.hostname or settings.telemetry_url,
            target_url=settings.telemetry_url,
            record_names=(
                "10 次匿名安装与启动",
                "分布式功能使用",
                "任务开始、成功与失败",
            ),
            explanation=(
                "将模拟 10 台设备的匿名使用，不是真实账号登录。每台身份都由"
                "本地真实校验组件随机生成，不读取这台电脑的信息，也不采集个人数据。"
            ),
        )
        try:
            approved = self.confirm_send(confirmation)
        except BaseException as error:
            self.on_message("error", "无法显示发送确认", friendly_error(error))
            return False
        if not approved:
            self.on_message(
                "info", "已取消模拟", "没有向 CloudBase 发送任何模拟数据。"
            )
            return False

        self.on_progress(PROGRESS_STAGES[1], 50)
        self.on_progress(PROGRESS_STAGES[2], 75)
        unique_root = self.state_root / f"simulation-{uuid.uuid4().hex}"
        payload = {
            **settings.bridge_fields(),
            "state_dir": str(unique_root),
            "endpoint": settings.telemetry_url,
            "device_count": 10,
            "allow_network": True,
            "confirmation": "POST",
        }

        def success(result: Any) -> None:
            feedback = build_simulation_feedback(result)
            if feedback.acknowledged_record_count:
                self.on_progress(PROGRESS_STAGES[3], 100)
            else:
                self.on_progress("CloudBase 尚未确认接收", 100)
            self.on_simulation(feedback)
            self.on_debug("十台匿名设备模拟的高级回执", result)

        def failure(error: BaseException) -> None:
            self.on_progress("CloudBase 尚未确认接收", 100)
            self.on_simulation(failed_simulation_feedback(error))
            self.on_debug("十台匿名设备模拟失败的高级信息", _safe_error(error))

        return self._submit(
            "正在模拟 10 台匿名设备",
            "simulate_devices",
            payload,
            success,
            failure,
            timeout=60,
        )

    def check_for_updates(self, raw_settings: ConnectionSettings) -> bool:
        settings = raw_settings.normalized()
        input_error = validate_settings(
            settings, require_telemetry=False, require_update=True
        )
        if input_error:
            self.on_message("error", "请先修正填写内容", input_error)
            return False
        if not self._ready():
            return False
        self.on_message(
            "info",
            "正在重新读取云端更新文件",
            "每次点击都会重新请求，不会复用上一次结果。",
        )
        payload = {
            **settings.bridge_fields(),
            "update_url": settings.update_url,
            "state_dir": str(self.state_root / "update-check-identity"),
            "allow_network": True,
            "confirmation": "GET",
        }

        def success(result: Any) -> None:
            feedback = build_update_feedback(result, settings.current_version)
            self.on_update(feedback)
            self.on_debug("本次版本检查的高级信息", result)

        def failure(error: BaseException) -> None:
            feedback = UpdateFeedback(
                state="error",
                summary="暂时无法检查更新",
                detail=friendly_update_error(error),
                tone="error",
                current_version=settings.current_version,
                advanced=_safe_error(error),
            )
            self.on_update(feedback)
            self.on_debug("版本检查失败的高级信息", _safe_error(error))

        return self._submit(
            "正在重新读取云端更新文件",
            "check_update_url",
            payload,
            success,
            failure,
            timeout=35,
        )

    def open_update_download(self, feedback: UpdateFeedback) -> bool:
        url = feedback.download_url or ""
        if not complete_https_url(url):
            self.on_message(
                "error",
                "下载页面地址不可用",
                "请检查云端更新文件中的下载页面地址是否为完整 https:// 地址。",
            )
            return False
        try:
            opened = self.url_opener(url)
        except BaseException:
            opened = False
        if opened is False:
            self.on_message(
                "error",
                "没有打开下载页面",
                "请检查默认浏览器设置，或在高级信息中复制下载页面地址。",
            )
            return False
        self.on_message(
            "success",
            "已打开下载页面",
            "本助手不会自动下载或安装，请在页面中按你的发布说明继续。",
        )
        return True

    def exit_for_required_update(self) -> None:
        self.exit_application()

    def begin_close(self) -> Optional[threading.Thread]:
        self.helper_status = "closing"
        self.runner.stop_accepting()
        self._emit_state()
        with self._bridge_lock:
            self._closing = True
            bridge = self._bridge or self._connecting_bridge
            self._bridge = None
            self._connecting_bridge = None
        if bridge is None:
            return None
        closer = threading.Thread(
            target=bridge.close,
            name="cloudbase-validator-close",
            daemon=True,
        )
        closer.start()
        return closer

    def _ready(self) -> bool:
        if self.runner.busy:
            self.on_message(
                "info", "正在处理上一项操作", "请等当前操作完成后再点击。"
            )
            return False
        if self._bridge is None or self.helper_status != "ready":
            self.on_message(
                "error",
                "本地检查组件尚未准备好",
                "请稍等片刻；如果一直没有就绪，请关闭窗口后重新打开。",
            )
            return False
        return True

    def _submit(
        self,
        label: str,
        action: str,
        payload: Dict[str, Any],
        on_success: Callable[[Any], None],
        on_error: Callable[[BaseException], None],
        *,
        timeout: float,
    ) -> bool:
        bridge = self._bridge
        if bridge is None:
            return False

        def work() -> Any:
            return bridge.request(action, timeout=timeout, **payload)

        return self.runner.submit(label, work, on_success, on_error)


def _safe_error(error: BaseException) -> Dict[str, str]:
    if isinstance(error, BridgeError):
        return {"code": error.code, "message": error.message}
    return {"code": type(error).__name__, "message": str(error)}


def handle_update_action(
    feedback: UpdateFeedback,
    action: str,
    open_download: Callable[[], bool],
    request_exit: Callable[[], None],
    show_error: Callable[[str], None] = lambda _message: None,
) -> bool:
    """Apply update-window actions without requiring a real Tk window."""
    if action == "primary":
        try:
            opened = open_download()
        except BaseException:
            opened = False
        if not opened:
            show_error(UPDATE_DOWNLOAD_ERROR)
            return False
        if feedback.dialog_mode == "required":
            request_exit()
        return True
    if action in {"secondary", "close"}:
        if feedback.dialog_mode == "required":
            request_exit()
        return True
    return False


class SendConfirmationDialog:
    def __init__(self, parent: Any, confirmation: SendConfirmation) -> None:
        if tk is None or ttk is None:  # pragma: no cover
            raise RuntimeError("当前 Python 未安装图形界面组件")
        self.parent = parent
        self.approved = False
        self.window = tk.Toplevel(parent)
        self.window.title("确认发送匿名测试数据")
        self.window.transient(parent)
        self.window.resizable(False, False)
        self.window.protocol("WM_DELETE_WINDOW", self.cancel)

        body = ttk.Frame(self.window, padding=20)
        body.grid(row=0, column=0, sticky="nsew")
        ttk.Label(
            body,
            text="确认发送匿名测试数据",
            style="DialogTitle.TLabel",
        ).grid(row=0, column=0, sticky="w")
        ttk.Label(
            body,
            text=f"目标 CloudBase 域名：{confirmation.host}",
            wraplength=580,
        ).grid(row=1, column=0, sticky="w", pady=(12, 6))
        ttk.Label(
            body,
            text=confirmation.explanation,
            wraplength=580,
        ).grid(row=2, column=0, sticky="w")
        ttk.Label(
            body,
            text="本次包含：" + "、".join(confirmation.record_names),
            wraplength=580,
        ).grid(row=3, column=0, sticky="w", pady=(8, 14))
        buttons = ttk.Frame(body)
        buttons.grid(row=4, column=0, sticky="e")
        ttk.Button(buttons, text="取消", command=self.cancel).grid(
            row=0, column=0, padx=(0, 8)
        )
        ttk.Button(
            buttons,
            text="确认发送",
            style="Primary.TButton",
            command=self.approve,
        ).grid(row=0, column=1)

    def ask(self) -> bool:
        self.window.grab_set()
        self.window.wait_visibility()
        self.window.focus_force()
        self.parent.wait_window(self.window)
        return self.approved

    def approve(self) -> None:
        self.approved = True
        self.window.destroy()

    def cancel(self) -> None:
        self.approved = False
        self.window.destroy()


class UpdateDialog:
    def __init__(
        self,
        parent: Any,
        feedback: UpdateFeedback,
        on_open: Callable[[], bool],
        on_exit: Callable[[], None],
    ) -> None:
        if tk is None or ttk is None:  # pragma: no cover
            raise RuntimeError("当前 Python 未安装图形界面组件")
        self.window = tk.Toplevel(parent)
        self.window.title("软件更新")
        self.window.transient(parent)
        self.window.resizable(False, False)
        body = ttk.Frame(self.window, padding=22)
        body.grid(row=0, column=0, sticky="nsew")
        ttk.Label(
            body, text=feedback.summary, style="DialogTitle.TLabel"
        ).grid(row=0, column=0, columnspan=2, sticky="w")
        ttk.Label(body, text=feedback.detail, wraplength=560).grid(
            row=1, column=0, columnspan=2, sticky="w", pady=(12, 8)
        )
        ttk.Label(
            body,
            text="“立即更新”只会打开下载页面，不会自动下载或安装。",
            style="Muted.TLabel",
            wraplength=560,
        ).grid(row=2, column=0, columnspan=2, sticky="w", pady=(0, 8))
        download_error_var = tk.StringVar(value="")
        ttk.Label(
            body,
            textvariable=download_error_var,
            style="Error.TLabel",
            wraplength=560,
        ).grid(row=3, column=0, columnspan=2, sticky="w", pady=(0, 12))

        def open_download() -> None:
            if handle_update_action(
                feedback,
                "primary",
                on_open,
                on_exit,
                download_error_var.set,
            ):
                self.window.destroy()

        def secondary() -> None:
            if handle_update_action(feedback, "secondary", on_open, on_exit):
                self.window.destroy()

        def close_window() -> None:
            if handle_update_action(feedback, "close", on_open, on_exit):
                self.window.destroy()

        self.window.protocol("WM_DELETE_WINDOW", close_window)
        ttk.Button(
            body,
            text=feedback.secondary_button or "稍后提醒",
            command=secondary,
        ).grid(row=4, column=0, sticky="e", padx=(0, 8))
        ttk.Button(
            body,
            text=feedback.primary_button or "立即更新",
            style="Primary.TButton",
            command=open_download,
        ).grid(row=4, column=1, sticky="e")
        self.window.grab_set()


class CloudBaseWizardApplication:
    """Single-column Tkinter view backed by CloudBaseWizardController."""

    def __init__(
        self,
        root: Any,
        state_root: Path,
        bridge_path: Path,
        node_command: str,
        resource_opener: Callable[[str], Any] = webbrowser.open,
    ) -> None:
        if tk is None or ttk is None:
            raise RuntimeError("当前 Python 未安装图形界面组件")
        self.root = root
        self.state_root = state_root
        self.bridge_path = bridge_path.expanduser().resolve()
        self.node_command = node_command
        self.resource_opener = resource_opener
        self._closing = False
        self._cleanup_complete = False
        self._poll_after_id: Optional[str] = None
        self._confirmation: Optional[SendConfirmationDialog] = None
        self._advanced_records: List[Tuple[str, Any]] = []
        self._buttons: List[Any] = []
        self._latest_update: Optional[UpdateFeedback] = None

        self._configure_window()
        self._create_variables()
        self._build_ui()
        self.runner = AsyncOperationRunner(self._on_busy_change)
        self.controller = CloudBaseWizardController(
            runner=self.runner,
            state_root=state_root,
            confirm_send=self._confirm_send,
            on_progress=self._show_progress,
            on_batch=self._show_batch,
            on_simulation=self._show_simulation,
            on_update=self._show_update,
            on_message=self._show_message,
            on_debug=self._append_debug,
            on_state_change=self._render_state,
            url_opener=webbrowser.open,
            exit_application=self._on_close,
        )
        self._render_state(self.controller.snapshot())
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self._schedule_poll()

    def start(self) -> None:
        # This starts only a local Node process and its zero-network ping.
        self.controller.connect(self._create_bridge)

    def _configure_window(self) -> None:
        self.root.title(WINDOW_TITLE)
        screen_width = int(self.root.winfo_screenwidth())
        screen_height = int(self.root.winfo_screenheight())
        width = max(700, min(900, screen_width - 80))
        height = max(650, min(920, screen_height - 80))
        self.root.geometry(f"{width}x{height}")
        self.root.minsize(min(680, width), min(620, height))
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        self.root.option_add("*Font", ("Microsoft YaHei UI", 10))
        style = ttk.Style(self.root)
        if "vista" in style.theme_names():
            style.theme_use("vista")
        style.configure("Title.TLabel", font=("Microsoft YaHei UI", 20, "bold"))
        style.configure(
            "Step.TLabel", font=("Microsoft YaHei UI", 14, "bold")
        )
        style.configure(
            "DialogTitle.TLabel", font=("Microsoft YaHei UI", 15, "bold")
        )
        style.configure(
            "Success.TLabel",
            foreground="#047857",
            font=("Microsoft YaHei UI", 12, "bold"),
        )
        style.configure(
            "Warning.TLabel",
            foreground="#9a3412",
            font=("Microsoft YaHei UI", 11, "bold"),
        )
        style.configure(
            "Error.TLabel",
            foreground="#b91c1c",
            font=("Microsoft YaHei UI", 11, "bold"),
        )
        style.configure("Muted.TLabel", foreground="#5f6b7a")
        style.configure(
            "Primary.TButton", font=("Microsoft YaHei UI", 11, "bold")
        )
        style.configure("Card.TFrame", relief="solid", borderwidth=1)

    def _create_variables(self) -> None:
        self.application_id_var = tk.StringVar(value="")
        self.current_version_var = tk.StringVar(value="")
        self.telemetry_url_var = tk.StringVar(value=LIVE_TELEMETRY_ENDPOINT_DEFAULT)
        self.update_url_var = tk.StringVar(value=LIVE_UPDATE_URL_DEFAULT)
        self.helper_status_var = tk.StringVar(value="正在准备本地检查组件…")
        self.message_title_var = tk.StringVar(value="按四步完成验证")
        self.message_detail_var = tk.StringVar(
            value="启动不会联网；只有点击发送或检查按钮后才会访问你填写的地址。"
        )
        self.progress_text_var = tk.StringVar(value="尚未发送")
        self.batch_summary_var = tk.StringVar(value="发送后，这里会显示云端实际收到的内容")
        self.batch_detail_var = tk.StringVar(value="")
        self.simulation_summary_var = tk.StringVar(
            value="也可以模拟 10 台匿名设备，查看更接近真实使用的汇总"
        )
        self.simulation_detail_var = tk.StringVar(
            value="这里模拟的是匿名安装与设备使用，不是真实账号登录。"
        )
        self.update_summary_var = tk.StringVar(value="尚未检查版本")
        self.update_detail_var = tk.StringVar(
            value="修改并发布云端更新文件后，点击按钮查看真实响应。"
        )

    def _build_ui(self) -> None:
        shell = ttk.Frame(self.root)
        shell.grid(row=0, column=0, sticky="nsew")
        shell.columnconfigure(0, weight=1)
        shell.rowconfigure(0, weight=1)
        self.canvas = tk.Canvas(shell, highlightthickness=0)
        scrollbar = ttk.Scrollbar(
            shell, orient="vertical", command=self.canvas.yview
        )
        self.canvas.configure(yscrollcommand=scrollbar.set)
        self.canvas.grid(row=0, column=0, sticky="nsew")
        scrollbar.grid(row=0, column=1, sticky="ns")
        self.content = ttk.Frame(self.canvas, padding=(20, 18, 24, 28))
        self.content.columnconfigure(0, weight=1)
        self.canvas_window = self.canvas.create_window(
            (0, 0), window=self.content, anchor="nw"
        )
        self.content.bind(
            "<Configure>",
            lambda _event: self.canvas.configure(
                scrollregion=self.canvas.bbox("all")
            ),
        )
        self.canvas.bind(
            "<Configure>",
            lambda event: self.canvas.itemconfigure(
                self.canvas_window, width=event.width
            ),
        )
        self.canvas.bind_all(
            "<MouseWheel>",
            lambda event: self.canvas.yview_scroll(
                int(-1 * (event.delta / 120)), "units"
            ),
        )

        row = 0
        ttk.Label(
            self.content, text=WINDOW_TITLE, style="Title.TLabel"
        ).grid(row=row, column=0, sticky="w")
        row += 1
        ttk.Label(
            self.content,
            text="照着四步操作，就能确认数据接收和版本更新是否真的可用。",
            style="Muted.TLabel",
            wraplength=800,
        ).grid(row=row, column=0, sticky="w", pady=(2, 4))
        row += 1
        ttk.Label(
            self.content,
            textvariable=self.helper_status_var,
            style="Muted.TLabel",
        ).grid(row=row, column=0, sticky="w", pady=(0, 12))
        row += 1
        self.message_frame = ttk.Frame(
            self.content, padding=12, style="Card.TFrame"
        )
        self.message_frame.grid(row=row, column=0, sticky="ew", pady=(0, 14))
        self.message_frame.columnconfigure(0, weight=1)
        self.message_title_label = ttk.Label(
            self.message_frame,
            textvariable=self.message_title_var,
            style="Success.TLabel",
        )
        self.message_title_label.grid(row=0, column=0, sticky="w")
        ttk.Label(
            self.message_frame,
            textvariable=self.message_detail_var,
            wraplength=760,
        ).grid(row=1, column=0, sticky="w", pady=(4, 0))
        row += 1

        step_one = self._step(
            row,
            STEP_TITLES[0],
            "先按新手文档部署并核对以下五项。每个代码名旁都写明了用途。",
        )
        row += 1
        resource_row = 2
        for name, explanation in RESOURCE_GUIDE:
            line = ttk.Frame(step_one)
            line.grid(row=resource_row, column=0, sticky="ew", pady=4)
            line.columnconfigure(1, weight=1)
            ttk.Label(
                line, text=f"✓ {name}", font=("Microsoft YaHei UI", 10, "bold")
            ).grid(row=0, column=0, sticky="nw", padx=(0, 10))
            ttk.Label(line, text=explanation, wraplength=590).grid(
                row=0, column=1, sticky="w"
            )
            resource_row += 1
        doc_button = ttk.Button(
            step_one, text="打开新手部署文档", command=self._open_quickstart
        )
        doc_button.grid(row=resource_row, column=0, sticky="ew", pady=(10, 5))
        ttk.Button(
            step_one,
            text="打开 CloudBase 控制台",
            command=self._open_cloud_console,
        ).grid(row=resource_row + 1, column=0, sticky="ew")

        step_two = self._step(
            row,
            STEP_TITLES[1],
            "只需填写四项。这里不需要、也不会保存任何密钥或口令。",
        )
        row += 1
        fields = (
            (
                "应用编号",
                self.application_id_var,
                "从上一步云函数的允许名单复制同一个值，例如 example-tool。",
            ),
            (
                "当前版本",
                self.current_version_var,
                "填写正在验证的软件版本，例如 1.2.3。",
            ),
            (
                "数据接收地址",
                self.telemetry_url_var,
                "从 CloudBase 的 HTTP 访问服务复制，必须是以 https:// 开头并以 /v1/track 结尾的完整地址。",
            ),
            (
                "更新文件地址",
                self.update_url_var,
                "复制浏览器能直接打开的完整 windows.json 地址，不要只填文件夹。",
            ),
        )
        field_row = 2
        for label, variable, help_text in fields:
            ttk.Label(
                step_two,
                text=label,
                font=("Microsoft YaHei UI", 10, "bold"),
            ).grid(row=field_row, column=0, sticky="w", pady=(8, 2))
            field_row += 1
            ttk.Entry(step_two, textvariable=variable).grid(
                row=field_row, column=0, sticky="ew"
            )
            field_row += 1
            ttk.Label(
                step_two,
                text=help_text,
                style="Muted.TLabel",
                wraplength=750,
            ).grid(row=field_row, column=0, sticky="w", pady=(2, 4))
            field_row += 1
        ttk.Button(
            step_two,
            text="载入本项目示例",
            command=self._load_project_example,
        ).grid(row=field_row, column=0, sticky="ew", pady=(10, 0))

        step_three = self._step(
            row,
            STEP_TITLES[2],
            "点击后只确认一次。程序会用固定匿名样例进行验证，并等待云端逐条确认保存。",
        )
        row += 1
        self.send_button = ttk.Button(
            step_three,
            text="发送一组测试数据到 CloudBase",
            style="Primary.TButton",
            command=self._send_batch,
        )
        self.send_button.grid(row=2, column=0, sticky="ew", pady=(8, 8))
        self._buttons.append(self.send_button)
        self.simulate_button = ttk.Button(
            step_three,
            text="模拟 10 台设备使用",
            style="Primary.TButton",
            command=self._simulate_devices,
        )
        self.simulate_button.grid(row=3, column=0, sticky="ew", pady=(0, 4))
        self._buttons.append(self.simulate_button)
        ttk.Label(
            step_three,
            text=(
                "模拟的是 10 次匿名安装与设备使用，不是真实账号登录；"
                "不会读取真实电脑信息。"
            ),
            style="Muted.TLabel",
            wraplength=750,
        ).grid(row=4, column=0, sticky="w", pady=(0, 8))
        self.progress = ttk.Progressbar(
            step_three, mode="determinate", maximum=100, value=0
        )
        self.progress.grid(row=5, column=0, sticky="ew")
        ttk.Label(
            step_three, textvariable=self.progress_text_var, style="Muted.TLabel"
        ).grid(row=6, column=0, sticky="w", pady=(4, 12))
        self.batch_summary_label = ttk.Label(
            step_three,
            textvariable=self.batch_summary_var,
            style="Success.TLabel",
            wraplength=750,
        )
        self.batch_summary_label.grid(row=7, column=0, sticky="w")
        ttk.Label(
            step_three,
            textvariable=self.batch_detail_var,
            wraplength=750,
        ).grid(row=8, column=0, sticky="w", pady=(4, 8))
        self.batch_query_button = ttk.Button(
            step_three,
            text="复制本次测试查询条件",
            command=self._copy_batch_query,
        )
        self.batch_query_button.grid(row=9, column=0, sticky="ew", pady=(0, 8))
        self.batch_query_button.grid_remove()
        ttk.Label(
            step_three,
            text=(
                "无需看懂或修改复制出的内容。按钮只会打开控制台入口，不会假装"
                "直达数据表。打开后按这条路径进入："
                + DATABASE_PATH
                + "。再把内容粘贴到筛选框。查询条件里已包含核对编号——这是每条"
                "测试数据的唯一编号，用它能找到刚发送的那一条。"
            ),
            style="Muted.TLabel",
            wraplength=750,
        ).grid(row=10, column=0, sticky="w", pady=(0, 8))
        ttk.Button(
            step_three,
            text="打开 CloudBase 数据表",
            command=self._open_cloud_console,
        ).grid(row=11, column=0, sticky="ew")
        self.cards_frame = ttk.Frame(step_three)
        self.cards_frame.grid(row=12, column=0, sticky="ew", pady=(10, 0))
        self.cards_frame.columnconfigure(0, weight=1)
        self._batch_query_text: Optional[str] = None
        self._card_queries: Dict[str, str] = {}

        ttk.Separator(step_three).grid(
            row=13, column=0, sticky="ew", pady=(14, 12)
        )
        ttk.Label(
            step_three,
            text="本次云端数据预览",
            font=("Microsoft YaHei UI", 12, "bold"),
        ).grid(row=14, column=0, sticky="w")
        self.simulation_summary_label = ttk.Label(
            step_three,
            textvariable=self.simulation_summary_var,
            style="Success.TLabel",
            wraplength=750,
        )
        self.simulation_summary_label.grid(row=15, column=0, sticky="w", pady=(5, 0))
        ttk.Label(
            step_three,
            textvariable=self.simulation_detail_var,
            wraplength=750,
        ).grid(row=16, column=0, sticky="w", pady=(4, 8))
        self.simulation_preview_frame = ttk.Frame(step_three)
        self.simulation_preview_frame.grid(row=17, column=0, sticky="ew")
        self.simulation_preview_frame.columnconfigure(0, weight=1)
        self.simulation_filter_button = ttk.Button(
            step_three,
            text="复制本次模拟的筛选条件",
            command=self._copy_simulation_filter,
        )
        self.simulation_filter_button.grid(
            row=18, column=0, sticky="ew", pady=(8, 0)
        )
        self.simulation_filter_button.grid_remove()
        self._simulation_filter_text: Optional[str] = None

        step_four = self._step(
            row,
            STEP_TITLES[3],
            "修改并发布云端更新文件后再点击。每次都会重新请求，不复用旧结果。",
        )
        row += 1
        self.update_button = ttk.Button(
            step_four,
            text="检查有没有新版本",
            style="Primary.TButton",
            command=self._check_update,
        )
        self.update_button.grid(row=2, column=0, sticky="ew", pady=(8, 10))
        self._buttons.append(self.update_button)
        self.update_summary_label = ttk.Label(
            step_four,
            textvariable=self.update_summary_var,
            style="Success.TLabel",
            wraplength=750,
        )
        self.update_summary_label.grid(row=3, column=0, sticky="w")
        ttk.Label(
            step_four,
            textvariable=self.update_detail_var,
            wraplength=750,
        ).grid(row=4, column=0, sticky="w", pady=(4, 0))

        self.advanced_button = ttk.Button(
            self.content,
            text="显示高级排错信息",
            command=self._toggle_advanced,
        )
        self.advanced_button.grid(row=row, column=0, sticky="ew", pady=(14, 6))
        row += 1
        self.advanced_frame = ttk.LabelFrame(
            self.content,
            text="高级排错信息（默认隐藏）",
            padding=10,
        )
        self.advanced_frame.grid(row=row, column=0, sticky="nsew")
        self.advanced_frame.columnconfigure(0, weight=1)
        self.advanced_text = tk.Text(
            self.advanced_frame,
            height=16,
            wrap="word",
            font=("Consolas", 9),
            state="disabled",
        )
        self.advanced_text.grid(row=0, column=0, sticky="nsew")
        self.advanced_frame.grid_remove()
        self._advanced_visible = False

    def _step(self, row: int, title: str, subtitle: str) -> Any:
        frame = ttk.Frame(self.content, padding=16, style="Card.TFrame")
        frame.grid(row=row, column=0, sticky="ew", pady=(0, 14))
        frame.columnconfigure(0, weight=1)
        ttk.Label(frame, text=title, style="Step.TLabel").grid(
            row=0, column=0, sticky="w"
        )
        ttk.Label(
            frame, text=subtitle, style="Muted.TLabel", wraplength=750
        ).grid(row=1, column=0, sticky="w", pady=(3, 4))
        return frame

    def _settings(self) -> ConnectionSettings:
        return ConnectionSettings(
            application_id=self.application_id_var.get(),
            current_version=self.current_version_var.get(),
            telemetry_url=self.telemetry_url_var.get(),
            update_url=self.update_url_var.get(),
            platform=detect_sdk_platform(),
            architecture=detect_sdk_architecture(),
        )

    def _load_project_example(self) -> None:
        self.application_id_var.set(EXAMPLE_APPLICATION_ID)
        self.current_version_var.set(EXAMPLE_CURRENT_VERSION)
        self.telemetry_url_var.set(EXAMPLE_TELEMETRY_URL)
        self.update_url_var.set(EXAMPLE_UPDATE_URL)
        self._show_message(
            "info",
            "已载入本项目示例",
            "这些地址现在才被填入；尚未联网。点击发送或检查后才会访问云端。",
        )

    def _send_batch(self) -> None:
        self.controller.send_test_batch(self._settings())

    def _simulate_devices(self) -> None:
        self.controller.simulate_devices(self._settings())

    def _check_update(self) -> None:
        self.controller.check_for_updates(self._settings())

    def _confirm_send(self, confirmation: SendConfirmation) -> bool:
        dialog = SendConfirmationDialog(self.root, confirmation)
        self._confirmation = dialog
        try:
            return dialog.ask()
        finally:
            self._confirmation = None

    def _show_progress(self, text: str, percent: int) -> None:
        if self._closing:
            return
        self.progress_text_var.set(text)
        self.progress.configure(value=max(0, min(100, percent)))

    def _show_batch(self, feedback: BatchFeedback) -> None:
        if self._closing:
            return
        self.batch_summary_var.set(feedback.summary)
        self.batch_detail_var.set(feedback.detail)
        self.batch_summary_label.configure(style=_tone_style(feedback.tone))
        self._batch_query_text = feedback.batch_query_text
        if self._batch_query_text:
            self.batch_query_button.grid()
        else:
            self.batch_query_button.grid_remove()
        for child in self.cards_frame.winfo_children():
            child.destroy()
        self._card_queries.clear()
        for row, card in enumerate(feedback.cards):
            panel = ttk.Frame(
                self.cards_frame, padding=12, style="Card.TFrame"
            )
            panel.grid(row=row, column=0, sticky="ew", pady=(0, 8))
            panel.columnconfigure(0, weight=1)
            ttk.Label(
                panel,
                text=card.delta,
                font=("Microsoft YaHei UI", 11, "bold"),
            ).grid(row=0, column=0, sticky="w")
            ttk.Label(
                panel,
                text=card.status_text,
                style="Success.TLabel" if card.acknowledged else "Error.TLabel",
            ).grid(row=1, column=0, sticky="w", pady=(3, 0))
            ttk.Label(panel, text=card.detail, wraplength=710).grid(
                row=2, column=0, sticky="w", pady=(3, 6)
            )
            if card.query_text:
                self._card_queries[card.event_name] = card.query_text
                ttk.Button(
                    panel,
                    text="复制数据库查询条件",
                    command=lambda name=card.event_name: self._copy_card_query(name),
                ).grid(row=3, column=0, sticky="w")

    def _show_update(self, feedback: UpdateFeedback) -> None:
        if self._closing:
            return
        self._latest_update = feedback
        self.update_summary_var.set(feedback.summary)
        self.update_detail_var.set(feedback.detail)
        self.update_summary_label.configure(style=_tone_style(feedback.tone))
        if feedback.dialog_mode in {"optional", "required"}:
            UpdateDialog(
                self.root,
                feedback,
                on_open=lambda: self.controller.open_update_download(feedback),
                on_exit=self.controller.exit_for_required_update,
            )

    def _show_simulation(self, feedback: SimulationFeedback) -> None:
        if self._closing:
            return
        self.simulation_summary_var.set(feedback.summary)
        self.simulation_detail_var.set(feedback.detail)
        self.simulation_summary_label.configure(style=_tone_style(feedback.tone))
        for child in self.simulation_preview_frame.winfo_children():
            child.destroy()
        rows: List[Tuple[str, str]] = [
            ("模拟设备", f"{feedback.device_count} 台"),
            (
                "云端保存结果",
                (
                    f"已保存 {feedback.acknowledged_record_count}/"
                    f"{feedback.planned_record_count} 条，"
                    f"失败 {feedback.failed_record_count} 条"
                ),
            ),
            ("安装记录", f"{feedback.install_count} 条"),
            ("启动记录", f"{feedback.start_count} 次"),
            ("核心功能使用", f"{feedback.feature_count} 次"),
            (
                "任务结果",
                (
                    f"成功 {feedback.task_success_count} 次 / "
                    f"失败 {feedback.task_failure_count} 次 / "
                    f"成功率 {feedback.task_success_rate}%"
                ),
            ),
            (
                "版本分布",
                "、".join(
                    f"{version}：{count} 台"
                    for version, count in feedback.version_distribution
                )
                or "暂无云端确认数据",
            ),
            (
                "渠道分布",
                "、".join(
                    f"{channel}：{count} 台"
                    for channel, count in feedback.channel_distribution
                )
                or "暂无云端确认数据",
            ),
        ]
        for row, (label, value) in enumerate(rows):
            line = ttk.Frame(
                self.simulation_preview_frame, padding=9, style="Card.TFrame"
            )
            line.grid(row=row, column=0, sticky="ew", pady=(0, 5))
            line.columnconfigure(1, weight=1)
            ttk.Label(
                line,
                text=label,
                font=("Microsoft YaHei UI", 10, "bold"),
            ).grid(row=0, column=0, sticky="nw", padx=(0, 12))
            ttk.Label(line, text=value, wraplength=590).grid(
                row=0, column=1, sticky="w"
            )
        ttk.Label(
            self.simulation_preview_frame,
            text=(
                "这是本次已被 CloudBase 确认保存的数据汇总；"
                "真实记录请到云端匿名统计数据表核对。"
            ),
            style="Muted.TLabel",
            wraplength=750,
        ).grid(row=len(rows), column=0, sticky="w", pady=(4, 0))
        self._simulation_filter_text = feedback.filter_text
        if self._simulation_filter_text:
            self.simulation_filter_button.grid()
        else:
            self.simulation_filter_button.grid_remove()

    def _show_message(self, tone: str, title: str, detail: str) -> None:
        if self._closing:
            return
        self.message_title_var.set(title)
        self.message_detail_var.set(detail)
        self.message_title_label.configure(style=_tone_style(tone))

    def _copy_batch_query(self) -> None:
        if self._batch_query_text:
            self._copy_text(self._batch_query_text)
            self._show_message(
                "success",
                "已复制本次测试查询条件",
                f"请按“{DATABASE_PATH}”进入，并粘贴到筛选框。",
            )

    def _copy_card_query(self, event_name: str) -> None:
        value = self._card_queries.get(event_name)
        if value:
            self._copy_text(value)
            self._show_message(
                "success",
                f"已复制“{EVENT_NAMES.get(event_name, '本条记录')}”查询条件",
                f"请按“{DATABASE_PATH}”进入，并粘贴到筛选框。",
            )

    def _copy_simulation_filter(self) -> None:
        if self._simulation_filter_text:
            self._copy_text(self._simulation_filter_text)
            self._show_message(
                "success",
                "已复制本次模拟的筛选条件",
                (
                    f"请按“{DATABASE_PATH}”进入并粘贴。若控制台不接受批量条件，"
                    "可在文档列表按接收时间由新到旧查看最新记录。"
                ),
            )

    def _copy_text(self, value: str) -> None:
        self.root.clipboard_clear()
        self.root.clipboard_append(value)

    def _append_debug(self, title: str, value: Any) -> None:
        if self._closing:
            return
        self._advanced_records.append((title, value))
        rendered_parts = []
        for record_title, record in self._advanced_records:
            rendered_parts.append(
                f"{record_title}\n"
                + json.dumps(
                    record,
                    ensure_ascii=False,
                    indent=2,
                    sort_keys=True,
                    default=str,
                )
            )
        self.advanced_text.configure(state="normal")
        self.advanced_text.delete("1.0", "end")
        self.advanced_text.insert("1.0", "\n\n".join(rendered_parts))
        self.advanced_text.configure(state="disabled")

    def _toggle_advanced(self) -> None:
        self._advanced_visible = not self._advanced_visible
        if self._advanced_visible:
            self.advanced_frame.grid()
            self.advanced_button.configure(text="隐藏高级排错信息")
        else:
            self.advanced_frame.grid_remove()
            self.advanced_button.configure(text="显示高级排错信息")

    def _open_quickstart(self) -> None:
        root = self.bridge_path.parents[2]
        document = root / "docs" / "cloudbase-quickstart.md"
        if not document.is_file():
            self._show_message(
                "error",
                "没有找到新手部署文档",
                "请确认当前工具仍放在完整项目目录中。",
            )
            return
        try:
            opened = self.resource_opener(document.resolve().as_uri())
        except BaseException:
            opened = False
        if opened is False:
            self._show_message(
                "error",
                "没有打开新手部署文档",
                f"请手动打开：{document}",
            )

    def _open_cloud_console(self) -> None:
        try:
            opened = self.resource_opener(CLOUD_CONSOLE_URL)
        except BaseException:
            opened = False
        if opened is False:
            self._show_message(
                "error",
                "没有打开 CloudBase 控制台",
                "请检查默认浏览器设置后再试。",
            )

    def _create_bridge(self) -> BridgeProcess:
        if not self.bridge_path.is_file():
            raise BridgeError(
                "bridge_unavailable", "local Node helper file is missing"
            )
        return BridgeProcess(self.bridge_path, node_command=self.node_command)

    def _render_state(self, state: ControllerState) -> None:
        labels = {
            "not_ready": "本地检查组件：等待准备",
            "preparing": "本地检查组件：正在准备（不会联网）",
            "ready": "本地检查组件：已就绪",
            "error": "本地检查组件：不可用，请关闭窗口后重试",
            "closing": "正在安全关闭…",
        }
        self.helper_status_var.set(labels.get(state.helper_status, ""))
        enabled = (
            state.helper_status == "ready" and not state.busy and not self._closing
        )
        for button in self._buttons:
            button.configure(state="normal" if enabled else "disabled")

    def _on_busy_change(self, busy: bool, label: Optional[str]) -> None:
        if busy and label:
            self.helper_status_var.set(label + "…")
        if hasattr(self, "controller"):
            self._render_state(self.controller.snapshot())

    def _schedule_poll(self) -> None:
        if self._closing:
            return
        try:
            self.runner.poll()
        except BaseException as error:
            self._show_message(
                "error", "页面处理出现问题", friendly_error(error)
            )
        if not self._closing and bool(self.root.winfo_exists()):
            self._poll_after_id = self.root.after(50, self._schedule_poll)

    def _on_close(self) -> None:
        if self._closing:
            return
        self._closing = True
        if self._confirmation is not None:
            self._confirmation.cancel()
        if self._poll_after_id is not None:
            try:
                self.root.after_cancel(self._poll_after_id)
            except Exception:
                pass
            self._poll_after_id = None
        closer = self.controller.begin_close()
        deadline = time.monotonic() + 6

        def finish() -> None:
            self.runner.poll()
            done = closer is None or not closer.is_alive()
            if (done and not self.runner.busy) or time.monotonic() >= deadline:
                self.runner.shutdown()
                self._cleanup_complete = True
                self.root.destroy()
                return
            self.root.after(50, finish)

        self.root.after(0, finish)

    def ensure_closed(self) -> None:
        if self._cleanup_complete:
            return
        self._closing = True
        closer = self.controller.begin_close()
        if closer is not None:
            closer.join(timeout=5)
        self.runner.shutdown()
        self._cleanup_complete = True


def _tone_style(tone: str) -> str:
    return {
        "success": "Success.TLabel",
        "warning": "Warning.TLabel",
        "error": "Error.TLabel",
        "update": "Success.TLabel",
        "info": "Success.TLabel",
    }.get(tone, "Success.TLabel")


# Compatibility for code that imported the Task13 class name. The visible
# product and its workflow no longer expose the old developer workbench.
SdkGuiApplication = CloudBaseWizardApplication


def parse_gui_arguments(argv: Optional[Iterable[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Open the CloudBase deployment acceptance wizard."
    )
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=DEFAULT_STATE_ROOT,
        help="temporary anonymous test identity directory",
    )
    parser.add_argument(
        "--bridge",
        type=Path,
        default=Path(__file__).with_name("bridge.mjs"),
        help="path to the local Node helper",
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
            "当前 Python 未包含图形界面组件。请安装带 Tk/ttk 的标准 Python 3.9+。",
            file=sys.stderr,
        )
        return 2
    enable_windows_dpi_awareness()
    root = tk.Tk()
    application = CloudBaseWizardApplication(
        root=root,
        state_root=arguments.state_dir,
        bridge_path=arguments.bridge,
        node_command=arguments.node,
    )
    try:
        application.start()
        root.mainloop()
    finally:
        application.ensure_closed()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
