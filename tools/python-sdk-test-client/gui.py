"""CloudBase deployment acceptance wizard for non-technical operators.

The Tkinter view only presents a guided workflow. The long-lived Node process
loads the real TypeScript SDK, creates the daily-active envelope, validates it,
performs explicitly requested network calls, and returns delivery
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
from dataclasses import dataclass, field
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
QUICKSTART_DOCUMENT_URL = (
    "https://my.feishu.cn/docx/CQEsdn73moXxM1xKvT9cDnZKnRg"
)
DATABASE_PATH = (
    "云开发统一工作台 → 选择环境 → 文档型数据库 → 集合管理 → "
    "telemetry_<目标工具编号；短横线改下划线> → 文档列表 → 筛选"
)
DEFAULT_STATE_ROOT = Path(tempfile.gettempdir()) / "bifang-cloudbase-validator"
LIVE_TELEMETRY_ENDPOINT_DEFAULT = ""
LIVE_VERSION_BASE_URL_DEFAULT = ""

EXAMPLE_APPLICATION_ID = "bifang-tools"
EXAMPLE_APPLICATION_CODE = "bifang-tools-windows-x64"
EXAMPLE_CURRENT_VERSION = "0.1.0"
EXAMPLE_TELEMETRY_URL = (
    "https://bifang-telemetry-prod-d8efa6a8d3-1251031333."
    "ap-shanghai.app.tcloudbase.com/apps/bifang-tools/v1/track"
)
EXAMPLE_VERSION_BASE_URL = (
    "https://bifang-telemetry-prod-d8efa6a8d3-1251031333."
    "ap-shanghai.app.tcloudbase.com/tools/version-control/v1"
)

STEP_TITLES = (
    "第一步：完成云端准备",
    "第二步：填写你的 CloudBase 信息",
    "第三步：发送测试数据",
    "第四步：验证版本更新",
)

RESOURCE_GUIDE: Tuple[Tuple[str, str], ...] = (
    (
        "telemetry-<应用编号> 云函数",
        "每个工具单独部署一份。比如 bifang-tools 使用 telemetry-bifang-tools。",
    ),
    (
        "POST /apps/<应用编号>/v1/track",
        "每个工具使用自己的通道，并且只指向同名工具的云函数。",
    ),
    (
        "telemetry_<规范化应用编号>",
        "每个工具使用自己的数据表；把应用编号里的短横线改为下划线。",
    ),
    (
        "三个独立函数参数",
        "允许应用编号只填当前工具一个值，并核对独立数据表与独立通道。",
    ),
    (
        "application-version API v1",
        "共享函数与 /tools/version-control/v1 路由；每个发布流使用独立 code 和凭据绑定。",
    ),
)

EVENT_CARD_DEFINITIONS: Tuple[Tuple[str, str, str], ...] = (
    ("daily_active", "启动使用记录", "今日使用设备 +1"),
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

# User-visible copy keeps each CloudBase/API term beside a plain-language
# explanation. Secret values are never part of this constant or diagnostics.
PRIMARY_UI_TEXT = "\n".join(
    (
        WINDOW_TITLE,
        *STEP_TITLES,
        "打开飞书新手部署文档",
        "打开 CloudBase 控制台",
        "应用编号",
        "发布流 code",
        "当前版本",
        "数据接收地址",
        "版本 API Base URL",
        "x-app-key",
        "x-app-secret",
        "载入本项目示例",
        "发送 1 条启动使用测试到 CloudBase",
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

APP_ID_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$")
APPLICATION_CODE_PATTERN = re.compile(
    r"^(?!\.{1,2}$)[^\s\\/?#\x00-\x1f\x7f-\x9f\u00ad\u061c\u180e"
    r"\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]{1,100}$"
)
SEMVER_PATTERN = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
APPLICATION_VERSION_PATTERN = re.compile(r"^[0-9]+(?:\.[0-9]+)*$")


def telemetry_collection_name(app_id: str) -> str:
    """Derive the collision-free collection name used by deployment config."""
    normalized = app_id.strip()
    if not APP_ID_PATTERN.fullmatch(normalized):
        raise ValueError("invalid deployment app_id")
    return f"telemetry_{normalized.replace('-', '_')}"


def database_path_for_app(app_id: str) -> str:
    try:
        collection = telemetry_collection_name(app_id)
    except ValueError:
        collection = "telemetry_<目标工具编号；短横线改下划线>"
    return (
        "云开发统一工作台 → 选择环境 → 文档型数据库 → 集合管理 → "
        f"{collection} → 文档列表 → 筛选"
    )


@dataclass(frozen=True)
class ConnectionSettings:
    application_id: str
    application_code: str
    current_version: str
    telemetry_url: str
    version_base_url: str
    app_key: str = field(repr=False)
    app_secret: str = field(repr=False)
    platform: str = "windows"
    architecture: str = "x64"

    def normalized(self) -> "ConnectionSettings":
        return ConnectionSettings(
            application_id=self.application_id.strip(),
            application_code=self.application_code.strip(),
            current_version=self.current_version.strip(),
            telemetry_url=self.telemetry_url.strip(),
            version_base_url=self.version_base_url.strip(),
            app_key=self.app_key,
            app_secret=self.app_secret,
            platform=self.platform,
            architecture=self.architecture,
        )

    def bridge_fields(self) -> Dict[str, Any]:
        return {
            "app_id": self.application_id,
            "app_version": self.current_version,
            "platform": self.platform,
            "arch": self.architecture,
        }

    def application_version_fields(self) -> Dict[str, Any]:
        return {
            "application_code": self.application_code,
            "current_version": self.current_version,
            "version_base_url": self.version_base_url,
            "app_key": self.app_key,
            "app_secret": self.app_secret,
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
class DailyActiveFeedback:
    summary: str
    detail: str
    tone: str
    confirmed_count: int
    expected_count: int
    cards: Tuple[DeliveryCard, ...]
    record_query_text: Optional[str]
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
    daily_active_count: int
    system_distribution: Tuple[Tuple[str, int], ...]
    architecture_distribution: Tuple[Tuple[str, int], ...]
    device_details: Tuple[Tuple[int, str, str, str, bool], ...]
    filter_text: Optional[str]
    advanced: Any


@dataclass(frozen=True)
class UpdateFeedback:
    state: str
    summary: str
    detail: str
    tone: str
    current_version: str
    remote_message: Optional[str] = None
    update_content: Optional[str] = None
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
    require_version: bool,
) -> Optional[str]:
    value = settings.normalized()
    if require_telemetry and not APP_ID_PATTERN.fullmatch(value.application_id):
        return (
            "请检查“应用编号”：长度应为 1–50，只能使用小写字母、数字或短横线，"
            "并以小写字母或数字开头和结尾。每个工具必须使用唯一编号。"
        )
    if require_telemetry and not SEMVER_PATTERN.fullmatch(value.current_version):
        return "请把 telemetry 的“当前版本”填写成类似 1.2.3 的完整版本号。"
    if (
        require_version
        and (
            len(value.current_version) > 50
            or not APPLICATION_VERSION_PATTERN.fullmatch(value.current_version)
        )
    ):
        return "请把版本 API 的“当前版本”填写成数字点分格式，例如 1、1.2 或 1.2.3.4。"
    if require_telemetry and not complete_https_url(value.telemetry_url):
        return (
            "请填写以 https:// 开头的完整“数据接收地址”，并使用当前工具的 "
            "/apps/<应用编号>/v1/track 独立通道。"
        )
    expected_track_path = f"/apps/{value.application_id}/v1/track"
    if (
        require_telemetry
        and urlparse(value.telemetry_url).path != expected_track_path
    ):
        return (
            "“数据接收地址”必须使用当前工具的独立通道，并以 "
            f"{expected_track_path} 结尾。不要使用历史共享 /v1/track 或其他工具的地址。"
        )
    if require_version and not APPLICATION_CODE_PATTERN.fullmatch(
        value.application_code
    ):
        return (
            "请检查“发布流 code”：长度应为 1–100，不能使用空白、斜杠、反斜杠、"
            "问号、井号或控制字符。"
        )
    if require_version and not complete_https_url(value.version_base_url):
        return "请填写以 https:// 开头的完整“版本 API Base URL”。"
    if require_version:
        parsed_version_url = urlparse(value.version_base_url)
        if (
            parsed_version_url.path != "/tools/version-control/v1"
            or parsed_version_url.query
            or parsed_version_url.fragment
        ):
            return (
                "“版本 API Base URL”必须精确以 /tools/version-control/v1 结尾；"
                "v1 只能出现一次，且不能带查询参数或片段。"
            )
        for label, credential in (
            ("x-app-key", value.app_key),
            ("x-app-secret", value.app_secret),
        ):
            if (
                not credential
                or credential != credential.strip()
                or len(credential) > 512
                or any(ord(character) < 32 or ord(character) == 127 for character in credential)
            ):
                return f"请在本机填写有效的“{label}”；值不会保存或写入日志。"
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
            "CloudBase 还不允许这个应用编号（403）。请打开当前工具自己的云函数，"
            "确认允许名单环境变量 ALLOWED_APP_IDS 只填写这个应用编号，保存并重新部署后再试。"
        )
    if status == 404 or "not_found" in lowered:
        return (
            "没有找到接收通道（404）。请在 CloudBase 核对独立 HTTP 路由 "
            "/apps/<应用编号>/v1/track，并确认它指向当前工具自己的云函数。"
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


def friendly_application_version_error(error: Any) -> str:
    """Translate application-version API failures without exposing credentials."""
    code, message, status, server_error = _error_parts(error)
    lowered = f"{code} {message} {server_error or ''}".lower()
    if status == 400:
        return "版本 API 拒绝了请求格式（400）。请核对发布流 code 和当前版本。"
    if status == 401 or "auth.invalid" in lowered or "unauthorized" in lowered:
        return "版本 API 凭据无效（401）。请重新输入 x-app-key 和 x-app-secret。"
    if status == 404 or "not_found" in lowered:
        return (
            "版本 API 没有找到这个发布流（404）。请核对 code 是否已经登记并有版本记录。"
        )
    if status == 403 or "forbidden" in lowered:
        return (
            "当前凭据无权访问这个发布流（403）。请核对凭据绑定的 code 与读取权限。"
        )
    if status == 429 or "rate" in lowered:
        return "版本检查过于频繁（429）。请按 Retry-After 等待后再试。"
    if status is not None and status >= 500:
        return (
            f"版本 API 暂时不可用（{status}）。请在控制台确认函数和路由状态，"
            "稍后再检查。"
        )
    if "unsafe" in lowered or "invalid" in lowered and "config" in lowered:
        return (
            "版本 API 配置不正确。Base URL 必须精确以"
            " /tools/version-control/v1 结尾，v1 只出现一次。"
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
            "暂时无法访问版本 API。请核对函数、路由、本机网络和脱敏后的请求诊断。"
        )
    if "response" in lowered:
        return "版本 API 返回内容不符合裸七字段契约，请检查服务端记录。"
    return "没有取得可用的版本决策。请按新手部署文档核对 API 和凭据绑定。"


def _delivery_success(item: Dict[str, Any]) -> bool:
    # Do not accept the old http_ok/accepted-by-SDK signals. Only the explicit
    # receipt means the response was 2xx and its JSON body contained ok:true.
    return item.get("acknowledged") is True


def build_daily_active_feedback(result: Any) -> DailyActiveFeedback:
    raw_deliveries = result.get("deliveries") if isinstance(result, dict) else None
    deliveries = raw_deliveries if isinstance(raw_deliveries, list) else []
    item = next(
        (
            value
            for value in deliveries
            if isinstance(value, dict) and value.get("event") == "daily_active"
        ),
        {},
    )
    acknowledged = _delivery_success(item)
    event_id = item.get("event_id")
    if not isinstance(event_id, str):
        event_id = None
    if acknowledged:
        summary = "CloudBase 已成功收到 1 条启动使用测试数据"
        detail = (
            "本次只发送了 1 个 POST。设备、操作系统和架构可在下方核对；"
            "来源 IP 由服务端记录，请到数据库查看。"
        )
        status_text = "已成功，CloudBase 已确认保存"
        card_detail = "这条启动使用记录已保存，可复制查询条件到数据库核对来源 IP。"
        tone = "success"
    else:
        summary = "CloudBase 还没有确认收到启动使用记录"
        detail = friendly_error(item.get("error", item))
        status_text = "没有收到"
        card_detail = detail
        tone = "error"
    card = DeliveryCard(
        event_name="daily_active",
        title=EVENT_NAMES["daily_active"],
        delta=EVENT_DELTAS["daily_active"],
        acknowledged=acknowledged,
        status_text=status_text,
        detail=card_detail,
        event_id=event_id,
        query_text=compact_query("event_id", event_id) if event_id else None,
    )
    record_query = compact_query("event_id", event_id) if event_id else None
    return DailyActiveFeedback(
        summary=summary,
        detail=detail,
        tone=tone,
        confirmed_count=1 if acknowledged else 0,
        expected_count=1,
        cards=(card,),
        record_query_text=record_query,
        advanced=result,
    )


def failed_daily_active_feedback(error: Any) -> DailyActiveFeedback:
    hint = friendly_error(error)
    card = DeliveryCard(
        event_name="daily_active",
        title=EVENT_NAMES["daily_active"],
        delta=EVENT_DELTAS["daily_active"],
        acknowledged=False,
        status_text="没有收到",
        detail=hint,
        event_id=None,
        query_text=None,
    )
    return DailyActiveFeedback(
        summary="CloudBase 还没有确认收到启动使用记录",
        detail=hint,
        tone="error",
        confirmed_count=0,
        expected_count=1,
        cards=(card,),
        record_query_text=None,
        advanced={
            "error": {
                "code": _error_parts(error)[0],
                "message": _error_parts(error)[1],
            }
        },
    )


def _simulation_deliveries(device: Dict[str, Any]) -> List[Dict[str, Any]]:
    value = device.get("deliveries")
    return [item for item in value if isinstance(item, dict)] if isinstance(
        value, list
    ) else []


def build_simulation_feedback(result: Any) -> SimulationFeedback:
    """Summarize one acknowledged daily-active receipt per simulated device."""
    raw_devices = result.get("devices") if isinstance(result, dict) else None
    devices = [item for item in raw_devices if isinstance(item, dict)] if isinstance(
        raw_devices, list
    ) else []
    acknowledged: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
    failed_receipts: List[Dict[str, Any]] = []
    device_details: List[Tuple[int, str, str, str, bool]] = []
    for device in devices:
        all_receipts = _simulation_deliveries(device)
        receipts = [receipt for receipt in all_receipts if _delivery_success(receipt)]
        failed_receipts.extend(
            receipt for receipt in all_receipts if not _delivery_success(receipt)
        )
        daily_receipt = next(
            (receipt for receipt in receipts if receipt.get("event") == "daily_active"),
            None,
        )
        is_acknowledged = daily_receipt is not None
        if daily_receipt is not None:
            acknowledged.append((device, daily_receipt))
        number = device.get("device_number")
        install_id = device.get("install_id")
        platform = device.get("platform")
        arch = device.get("arch")
        device_details.append(
            (
                number if isinstance(number, int) else len(device_details) + 1,
                install_id if isinstance(install_id, str) else "未知设备",
                platform if isinstance(platform, str) else "未知系统",
                arch if isinstance(arch, str) else "未知架构",
                is_acknowledged,
            )
        )

    systems: Dict[str, int] = {}
    architectures: Dict[str, int] = {}
    for device, _receipt in acknowledged:
        platform = device.get("platform")
        arch = device.get("arch")
        if isinstance(platform, str):
            systems[platform] = systems.get(platform, 0) + 1
        if isinstance(arch, str):
            architectures[arch] = architectures.get(arch, 0) + 1
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
    device_count = len(acknowledged)
    acknowledged_count = len(acknowledged)
    planned_record_count = 10
    failed_record_count = max(0, planned_record_count - acknowledged_count)
    failure_hint = (
        friendly_error(
            failed_receipts[0].get("error", failed_receipts[0])
        )
        if failed_receipts
        else "请核对填写内容和 CloudBase 部署状态后重试。"
    )
    if device_count == 10 and acknowledged_count == planned_record_count:
        summary = f"CloudBase 已确认收到 {device_count} 台设备的启动使用记录"
        detail = (
            f"已保存 {acknowledged_count}/{planned_record_count} 条，失败 0 条。"
            "每台设备只有 1 个 POST；因为都从本机发出，服务端看到的来源 IP 通常相同。"
        )
        tone = "success"
    elif acknowledged_count:
        summary = (
            f"CloudBase 已保存 {acknowledged_count}/{planned_record_count} 条启动使用记录"
        )
        detail = (
            f"失败 {failed_record_count} 条；未确认的记录没有计入下面统计。"
            f"处理建议：{failure_hint}"
        )
        tone = "warning"
    else:
        summary = "CloudBase 还没有确认收到模拟启动使用记录"
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
        daily_active_count=acknowledged_count,
        system_distribution=tuple(sorted(systems.items())),
        architecture_distribution=tuple(sorted(architectures.items())),
        device_details=tuple(device_details),
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
        planned_record_count=10,
        failed_record_count=10,
        daily_active_count=0,
        system_distribution=(),
        architecture_distribution=(),
        device_details=(),
        filter_text=None,
        advanced=_safe_error(error),
    )


def build_update_feedback(
    result: Any, current_version: str
) -> UpdateFeedback:
    if not isinstance(result, dict):
        return UpdateFeedback(
            state="error",
            summary="暂时无法检查更新",
            detail=friendly_application_version_error(result),
            tone="error",
            current_version=current_version,
            advanced=result,
        )
    decision = result.get("decision")
    if not isinstance(decision, dict):
        decision = {}
    data = decision.get("data")
    if not isinstance(data, dict):
        data = {}
    remote_message = data.get("promptContent")
    if not isinstance(remote_message, str):
        remote_message = None
    update_content = data.get("updateContent")
    if not isinstance(update_content, str):
        update_content = None
    download_url = data.get("downloadUrl")
    if not isinstance(download_url, str):
        download_url = None

    kind = decision.get("kind")
    if kind == "optional":
        return UpdateFeedback(
            state="optional_update",
            summary="发现新版本",
            detail=(
                f"这是普通更新。当前版本 {current_version}。"
                + (f"\n{remote_message}" if remote_message else "")
            ),
            tone="update",
            current_version=current_version,
            remote_message=remote_message,
            update_content=update_content,
            download_url=download_url,
            dialog_mode="optional",
            primary_button="立即更新",
            secondary_button="稍后提醒",
            advanced=result,
        )
    if kind == "required":
        return UpdateFeedback(
            state="required_update",
            summary="当前版本已停止支持，请升级后继续使用",
            detail=(
                f"当前版本是 {current_version}。"
                + (f"\n{remote_message}" if remote_message else "")
            ),
            tone="error",
            current_version=current_version,
            remote_message=remote_message,
            update_content=update_content,
            download_url=download_url,
            dialog_mode="required",
            primary_button="立即更新",
            secondary_button="退出软件",
            advanced=result,
        )
    if kind == "stopped":
        return UpdateFeedback(
            state="stopped",
            summary="云端已暂停分发更新",
            detail=(
                "stopUpdate 只表示暂停本次更新分发，不会退出或禁止启动软件。"
                + (f"\n{remote_message}" if remote_message else "")
            ),
            tone="warning",
            current_version=current_version,
            remote_message=remote_message,
            update_content=update_content,
            advanced=result,
        )

    reason = str(decision.get("reason", "unavailable"))
    if reason == "up_to_date":
        return UpdateFeedback(
            state="up_to_date",
            summary="你现在已经是最新版",
            detail=f"当前版本是 {current_version}。",
            tone="success",
            current_version=current_version,
            advanced=result,
        )
    if reason == "disabled":
        return UpdateFeedback(
            state="paused",
            summary="本地已关闭版本检查",
            detail=f"当前版本是 {current_version}；本次没有访问版本 API。",
            tone="warning",
            current_version=current_version,
            advanced=result,
        )
    if reason in {"invalid_config", "invalid_response"}:
        return UpdateFeedback(
            state="invalid_response",
            summary="版本 API 配置或响应需要检查",
            detail=(
                "请核对单一 /tools/version-control/v1 Base URL、发布流 code、凭据，"
                "以及服务端是否返回严格的裸七字段对象。"
            ),
            tone="error",
            current_version=current_version,
            advanced=result,
        )

    diagnostic = result.get("fetch_diagnostic", result)
    return UpdateFeedback(
        state="error",
        summary="暂时无法检查更新",
        detail=friendly_application_version_error(diagnostic),
        tone="error",
        current_version=current_version,
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
        on_daily_active: Callable[[DailyActiveFeedback], None],
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
        self.on_daily_active = on_daily_active
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

    def send_daily_active(self, raw_settings: ConnectionSettings) -> bool:
        settings = raw_settings.normalized()
        self.on_progress(PROGRESS_STAGES[0], 25)
        input_error = validate_settings(
            settings, require_telemetry=True, require_version=False
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
            record_names=("1 条启动使用记录",),
            explanation=(
                "只发送 1 个 POST，包含随机设备编号、当前版本、操作系统和架构。"
                "CloudBase 会从请求连接记录来源 IP；不会读取姓名、账号、文件或密钥。"
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
        unique_root = self.state_root / f"daily-active-{uuid.uuid4().hex}"
        payload = {
            **settings.bridge_fields(),
            "state_dir": str(unique_root),
            "endpoint": settings.telemetry_url,
            "allow_network": True,
            "confirmation": "POST",
        }

        def success(result: Any) -> None:
            feedback = build_daily_active_feedback(result)
            if feedback.confirmed_count:
                self.on_progress(PROGRESS_STAGES[3], 100)
            else:
                self.on_progress("CloudBase 尚未确认接收", 100)
            self.on_daily_active(feedback)
            self.on_debug("本次发送的高级回执", result)

        def failure(error: BaseException) -> None:
            self.on_progress("CloudBase 尚未确认接收", 100)
            self.on_daily_active(failed_daily_active_feedback(error))
            self.on_debug("本次发送失败的高级信息", _safe_error(error))

        return self._submit(
            "正在发送匿名测试数据",
            "send_daily_active",
            payload,
            success,
            failure,
            timeout=45,
        )

    def simulate_devices(self, raw_settings: ConnectionSettings) -> bool:
        settings = raw_settings.normalized()
        self.on_progress(PROGRESS_STAGES[0], 25)
        input_error = validate_settings(
            settings, require_telemetry=True, require_version=False
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
                "10 台模拟设备各 1 条启动使用记录",
            ),
            explanation=(
                "将发送最多 10 个 POST，每台模拟设备只发一次。记录仅含随机设备编号、"
                "系统和架构；它们都从本机发出，所以服务端记录的来源 IP 通常相同。"
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
            settings, require_telemetry=False, require_version=True
        )
        if input_error:
            self.on_message("error", "请先修正填写内容", input_error)
            return False
        if not self._ready():
            return False
        self.on_message(
            "info",
            "正在请求 application-version API",
            "每次点击都会重新发送 GET，不会复用上一次结果；凭据值不会写入诊断。",
        )
        payload = {
            **settings.application_version_fields(),
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
                detail=friendly_application_version_error(error),
                tone="error",
                current_version=settings.current_version,
                advanced=_safe_error(error),
            )
            self.on_update(feedback)
            self.on_debug("版本检查失败的高级信息", _safe_error(error))

        return self._submit(
            "正在请求 application-version API",
            "check_application_version",
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
                "请检查版本 API 返回的 downloadUrl 是否为完整 https:// 地址。",
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
            on_daily_active=self._show_daily_active,
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
        self.application_code_var = tk.StringVar(value="")
        self.current_version_var = tk.StringVar(value="")
        self.telemetry_url_var = tk.StringVar(value=LIVE_TELEMETRY_ENDPOINT_DEFAULT)
        self.version_base_url_var = tk.StringVar(value=LIVE_VERSION_BASE_URL_DEFAULT)
        self.app_key_var = tk.StringVar(value="")
        self.app_secret_var = tk.StringVar(value="")
        self.helper_status_var = tk.StringVar(value="正在准备本地检查组件…")
        self.message_title_var = tk.StringVar(value="按四步完成验证")
        self.message_detail_var = tk.StringVar(
            value="启动不会联网；只有点击发送或检查按钮后才会访问你填写的地址。"
        )
        self.progress_text_var = tk.StringVar(value="尚未发送")
        self.daily_active_summary_var = tk.StringVar(
            value="发送后，这里会显示云端实际收到的启动使用记录"
        )
        self.daily_active_detail_var = tk.StringVar(value="")
        self.simulation_summary_var = tk.StringVar(
            value="也可以模拟 10 台设备，每台只发送 1 条启动使用记录"
        )
        self.simulation_detail_var = tk.StringVar(
            value="同一台电脑发出的模拟请求，服务端记录的来源 IP 通常相同。"
        )
        self.update_summary_var = tk.StringVar(value="尚未检查版本")
        self.update_detail_var = tk.StringVar(
            value="准备好版本记录和只读运行时凭据后，点击按钮查看真实响应。"
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
            "先按新手文档为当前工具部署并核对以下五项。其他工具必须使用另一套资源。",
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
            step_one, text="打开飞书新手部署文档", command=self._open_quickstart
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
            "凭据输入不回显，只保存在当前进程内；不会写文件、复制到高级信息或日志。",
        )
        row += 1
        fields = (
            (
                "应用编号",
                self.application_id_var,
                "从当前工具独立云函数复制唯一允许值，例如 bifang-tools；不要复用其他工具编号。",
                False,
            ),
            (
                "发布流 code",
                self.application_code_var,
                "版本 API 用这个 code 选择唯一平台/架构发布流，例如 bifang-tools-windows-x64。",
                False,
            ),
            (
                "当前版本",
                self.current_version_var,
                "填写正在验证的软件版本，例如 1.2.3。",
                False,
            ),
            (
                "数据接收地址",
                self.telemetry_url_var,
                "必须使用当前工具的独立地址：https://.../apps/<同一应用编号>/v1/track。",
                False,
            ),
            (
                "版本 API Base URL",
                self.version_base_url_var,
                "必须精确到 https://<host>/tools/version-control/v1；不要再拼第二个 /v1。",
                False,
            ),
            (
                "x-app-key",
                self.app_key_var,
                "填写只读运行时凭据；只允许访问绑定的发布流。",
                True,
            ),
            (
                "x-app-secret",
                self.app_secret_var,
                "输入不回显，关闭窗口即从内存清除。不要粘贴到日志或截图。",
                True,
            ),
        )
        field_row = 2
        for label, variable, help_text, is_secret in fields:
            ttk.Label(
                step_two,
                text=label,
                font=("Microsoft YaHei UI", 10, "bold"),
            ).grid(row=field_row, column=0, sticky="w", pady=(8, 2))
            field_row += 1
            ttk.Entry(
                step_two,
                textvariable=variable,
                show="●" if is_secret else "",
            ).grid(
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
            "单设备测试只发 1 个 POST：记录本次启动使用，不统计功能点击或操作过程。",
        )
        row += 1
        self.send_button = ttk.Button(
            step_three,
            text="发送 1 条启动使用测试到 CloudBase",
            style="Primary.TButton",
            command=self._send_daily_active,
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
                "模拟 10 台设备时最多发送 10 个 POST，每台一次。所有请求来自本机，"
                "所以数据库里的来源 IP 通常相同；IP 由服务端识别。"
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
        self.daily_active_summary_label = ttk.Label(
            step_three,
            textvariable=self.daily_active_summary_var,
            style="Success.TLabel",
            wraplength=750,
        )
        self.daily_active_summary_label.grid(row=7, column=0, sticky="w")
        ttk.Label(
            step_three,
            textvariable=self.daily_active_detail_var,
            wraplength=750,
        ).grid(row=8, column=0, sticky="w", pady=(4, 8))
        self.daily_active_query_button = ttk.Button(
            step_three,
            text="复制本次测试查询条件",
            command=self._copy_daily_active_query,
        )
        self.daily_active_query_button.grid(
            row=9, column=0, sticky="ew", pady=(0, 8)
        )
        self.daily_active_query_button.grid_remove()
        ttk.Label(
            step_three,
            text=(
                "无需看懂或修改复制出的内容。按钮只会打开控制台入口，不会假装"
                "直达数据表。打开后按这条路径进入："
                + DATABASE_PATH
                + "。例如 bifang-tools 的表是 telemetry_bifang_tools。再把内容粘贴到筛选框。"
                "查询条件里已包含本次记录的核对编号；"
                "来源 IP 也只能在服务端数据库中查看。"
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
        self._daily_active_query_text: Optional[str] = None
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
            "每次都会请求 /tools/version-control/v1/versions/{code}/{version}，不复用旧结果。",
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
            application_code=self.application_code_var.get(),
            current_version=self.current_version_var.get(),
            telemetry_url=self.telemetry_url_var.get(),
            version_base_url=self.version_base_url_var.get(),
            app_key=self.app_key_var.get(),
            app_secret=self.app_secret_var.get(),
            platform=detect_sdk_platform(),
            architecture=detect_sdk_architecture(),
        )

    def _database_path(self) -> str:
        return database_path_for_app(self.application_id_var.get())

    def _load_project_example(self) -> None:
        self.application_id_var.set(EXAMPLE_APPLICATION_ID)
        self.application_code_var.set(EXAMPLE_APPLICATION_CODE)
        self.current_version_var.set(EXAMPLE_CURRENT_VERSION)
        self.telemetry_url_var.set(EXAMPLE_TELEMETRY_URL)
        self.version_base_url_var.set(EXAMPLE_VERSION_BASE_URL)
        self.app_key_var.set("")
        self.app_secret_var.set("")
        self._show_message(
            "info",
            "已载入本项目示例",
            "这些非敏感示例现在才被填入；尚未联网。凭据必须在本机另行输入，"
            "点击发送或检查后才会访问云端。",
        )

    def _send_daily_active(self) -> None:
        self.controller.send_daily_active(self._settings())

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

    def _show_daily_active(self, feedback: DailyActiveFeedback) -> None:
        if self._closing:
            return
        self.daily_active_summary_var.set(feedback.summary)
        self.daily_active_detail_var.set(feedback.detail)
        self.daily_active_summary_label.configure(style=_tone_style(feedback.tone))
        self._daily_active_query_text = feedback.record_query_text
        if self._daily_active_query_text:
            self.daily_active_query_button.grid()
        else:
            self.daily_active_query_button.grid_remove()
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
            ("启动使用记录", f"{feedback.daily_active_count} 条"),
            (
                "操作系统",
                "、".join(
                    f"{system}：{count} 台"
                    for system, count in feedback.system_distribution
                )
                or "暂无云端确认数据",
            ),
            (
                "系统架构",
                "、".join(
                    f"{arch}：{count} 台"
                    for arch, count in feedback.architecture_distribution
                )
                or "暂无云端确认数据",
            ),
        ]
        rows.extend(
            (
                f"设备 {number}",
                f"{install_id[:8]}… · {system} · {arch} · "
                + ("已保存" if acknowledged else "未确认"),
            )
            for number, install_id, system, arch, acknowledged in feedback.device_details
        )
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
                "设备编号是匿名设备标识，仅用来区分每天实际启动使用的软件。"
                "来源 IP 由服务端从连接中写入，请到云端数据表核对。"
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

    def _copy_daily_active_query(self) -> None:
        if self._daily_active_query_text:
            self._copy_text(self._daily_active_query_text)
            self._show_message(
                "success",
                "已复制本次测试查询条件",
                f"请按“{self._database_path()}”进入，并粘贴到筛选框。",
            )

    def _copy_card_query(self, event_name: str) -> None:
        value = self._card_queries.get(event_name)
        if value:
            self._copy_text(value)
            self._show_message(
                "success",
                f"已复制“{EVENT_NAMES.get(event_name, '本条记录')}”查询条件",
                f"请按“{self._database_path()}”进入，并粘贴到筛选框。",
            )

    def _copy_simulation_filter(self) -> None:
        if self._simulation_filter_text:
            self._copy_text(self._simulation_filter_text)
            self._show_message(
                "success",
                "已复制本次模拟的筛选条件",
                (
                    f"请按“{self._database_path()}”进入并粘贴。若控制台不接受批量条件，"
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
        try:
            opened = self.resource_opener(QUICKSTART_DOCUMENT_URL)
        except BaseException:
            opened = False
        if opened is False:
            self._show_message(
                "error",
                "没有打开飞书新手部署文档",
                f"请复制到浏览器打开：{QUICKSTART_DOCUMENT_URL}",
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
        self.app_key_var.set("")
        self.app_secret_var.set("")
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
