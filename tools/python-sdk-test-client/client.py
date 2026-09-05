"""Interactive Python host for the real @bifang/telemetry-update-sdk bridge."""

import argparse
import concurrent.futures
import hashlib
import json
import os
import platform as host_platform
import queue
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Optional, TextIO


class BridgeError(RuntimeError):
    """A structured bridge failure safe to show in the manual client."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class BridgeProcess:
    """Thread-safe JSON Lines client for one long-lived Node bridge process."""

    def __init__(self, bridge_path: Path, node_command: str = "node") -> None:
        self.bridge_path = bridge_path.resolve()
        self._process = subprocess.Popen(
            [node_command, str(self.bridge_path)],
            cwd=str(self.bridge_path.parent),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            shell=False,
        )
        self._pending: Dict[str, "queue.Queue[Dict[str, Any]]"] = {}
        self._pending_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._close_lock = threading.Lock()
        self._stderr_lines = deque(maxlen=20)
        self._closed = False
        self._stdout_thread = threading.Thread(
            target=self._read_stdout, name="bifang-bridge-stdout", daemon=True
        )
        self._stderr_thread = threading.Thread(
            target=self._read_stderr, name="bifang-bridge-stderr", daemon=True
        )
        self._stdout_thread.start()
        self._stderr_thread.start()

    def request(self, action: str, timeout: float = 15.0, **payload: Any) -> Any:
        request_id = str(uuid.uuid4())
        response_queue: "queue.Queue[Dict[str, Any]]" = queue.Queue(maxsize=1)
        with self._pending_lock:
            if self._closed:
                raise BridgeError("bridge_closed", "the Node bridge is closed")
            if self._process.poll() is not None:
                raise self._process_error()
            self._pending[request_id] = response_queue

        request = {**payload, "request_id": request_id, "action": action}
        try:
            encoded = json.dumps(
                request, ensure_ascii=False, allow_nan=False, separators=(",", ":")
            )
            with self._write_lock:
                if self._process.stdin is None:
                    raise BridgeError("bridge_closed", "bridge stdin is unavailable")
                self._process.stdin.write(encoded + "\n")
                self._process.stdin.flush()
            response = response_queue.get(timeout=timeout)
        except queue.Empty as error:
            raise BridgeError(
                "bridge_timeout", f"no response within {timeout:g} seconds"
            ) from error
        except (BrokenPipeError, OSError, ValueError) as error:
            raise self._process_error() from error
        finally:
            with self._pending_lock:
                self._pending.pop(request_id, None)

        if response.get("ok") is not True:
            details = response.get("error")
            if isinstance(details, dict):
                raise BridgeError(
                    str(details.get("code", "bridge_error")),
                    str(details.get("message", "unknown bridge error")),
                )
            raise BridgeError("bridge_error", "malformed error response")
        return response.get("result")

    def close(self) -> None:
        with self._close_lock:
            with self._pending_lock:
                if self._closed:
                    return
                self._closed = True
            deadline = time.monotonic() + 4.0

            def remaining(limit: float) -> float:
                return max(0.01, min(limit, deadline - time.monotonic()))

            self._fail_pending(self._process_error())
            try:
                if self._process.poll() is None:
                    try:
                        self._process.terminate()
                    except OSError:
                        pass
                if self._process.poll() is None:
                    try:
                        self._process.wait(timeout=remaining(0.75))
                    except subprocess.TimeoutExpired:
                        try:
                            self._process.kill()
                        except OSError:
                            pass
                if self._process.poll() is None:
                    try:
                        self._process.wait(timeout=remaining(1.0))
                    except (OSError, subprocess.TimeoutExpired):
                        pass
            except OSError:
                pass
            finally:
                self._stdout_thread.join(timeout=remaining(0.25))
                self._stderr_thread.join(timeout=remaining(0.25))

                def close_streams() -> None:
                    for stream in (
                        self._process.stdin,
                        self._process.stdout,
                        self._process.stderr,
                    ):
                        if stream is not None:
                            try:
                                stream.close()
                            except (OSError, ValueError):
                                pass

                stream_closer = threading.Thread(
                    target=close_streams,
                    name="bifang-bridge-stream-close",
                    daemon=True,
                )
                stream_closer.start()
                stream_closer.join(timeout=remaining(0.5))

    def _read_stdout(self) -> None:
        if self._process.stdout is None:
            return
        try:
            for line in self._process.stdout:
                try:
                    response = json.loads(line)
                except json.JSONDecodeError:
                    self._fail_pending(
                        BridgeError(
                            "invalid_bridge_output", "bridge emitted non-JSON output"
                        )
                    )
                    continue
                request_id = (
                    response.get("request_id") if isinstance(response, dict) else None
                )
                if not isinstance(request_id, str):
                    self._fail_pending(
                        BridgeError(
                            "invalid_bridge_output",
                            "bridge response is missing a request_id",
                        )
                    )
                    continue
                with self._pending_lock:
                    target = self._pending.get(request_id)
                if target is not None:
                    try:
                        target.put_nowait(response)
                    except queue.Full:
                        pass
        except (OSError, ValueError):
            pass
        if not self._closed:
            self._fail_pending(self._process_error())

    def _read_stderr(self) -> None:
        if self._process.stderr is None:
            return
        try:
            for line in self._process.stderr:
                self._stderr_lines.append(line.rstrip())
        except (OSError, ValueError):
            pass

    def _fail_pending(self, error: BridgeError) -> None:
        response = {
            "ok": False,
            "error": {"code": error.code, "message": error.message},
        }
        with self._pending_lock:
            targets = list(self._pending.values())
        for target in targets:
            try:
                target.put_nowait(response)
            except queue.Full:
                pass

    def _process_error(self) -> BridgeError:
        suffix = ""
        if self._stderr_lines:
            suffix = ": " + self._stderr_lines[-1]
        return BridgeError(
            "bridge_unavailable",
            f"Node bridge exited or is unavailable{suffix}",
        )

    def __enter__(self) -> "BridgeProcess":
        return self

    def __exit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
        self.close()


@dataclass
class ClientConfig:
    app_id: str = "bifang-tools"
    app_version: str = "0.1.0"
    platform: str = "windows"
    arch: str = "x64"

    def bridge_fields(self) -> Dict[str, Any]:
        return {
            "app_id": self.app_id,
            "app_version": self.app_version,
            "platform": self.platform,
            "arch": self.arch,
        }


def state_directory_for_app(state_root: Path, mode: str, app_id: str) -> Path:
    """Return the tool-owned identity directory for one app and session mode."""
    app_namespace = hashlib.sha256(app_id.encode("utf-8")).hexdigest()[:16]
    return state_root.expanduser().resolve() / mode / app_namespace


@dataclass
class BackgroundJob:
    job_id: int
    label: str
    future: "concurrent.futures.Future[Any]"
    reported: bool = False


class BackgroundJobs:
    def __init__(self, max_workers: int = 2) -> None:
        self._executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=max_workers, thread_name_prefix="bifang-sdk-check"
        )
        self._jobs: Dict[int, BackgroundJob] = {}
        self._next_id = 1

    def submit(self, label: str, function: Callable[[], Any]) -> int:
        job_id = self._next_id
        self._next_id += 1
        self._jobs[job_id] = BackgroundJob(
            job_id=job_id,
            label=label,
            future=self._executor.submit(function),
        )
        return job_id

    def jobs(self) -> Iterable[BackgroundJob]:
        return tuple(self._jobs.values())

    def close(self) -> None:
        self._executor.shutdown(wait=True, cancel_futures=True)


class InteractiveClient:
    def __init__(
        self,
        bridge: BridgeProcess,
        state_root: Path,
        input_function: Callable[[str], str] = input,
        output: TextIO = sys.stdout,
    ) -> None:
        self.bridge = bridge
        self.state_root = state_root.resolve()
        self.input = input_function
        self.output = output
        self.config = ClientConfig(
            platform=detect_sdk_platform(), arch=detect_sdk_architecture()
        )
        self.jobs = BackgroundJobs()
        self.capture_initialized = False
        self.live_endpoint: Optional[str] = None

    def run(self) -> None:
        self._write(
            "毕方 SDK Python 手动测试客户端\n"
            "安全默认：启动不初始化 SDK、不发 POST、不发 GET。\n"
            "多工具隔离：每个工具使用唯一 app_id、独立 /apps/<app_id>/v1/track、"
            "独立数据库集合和独立更新文件。\n"
            "只有你手填 URL 并键入 POST/GET 后才允许真实网络动作。\n"
        )
        try:
            while True:
                self._announce_completed_jobs()
                self._write(self._menu())
                choice = self.input("选择操作: ").strip().lower()
                if choice in {"q", "quit", "exit"}:
                    return
                actions = {
                    "1": self.configure,
                    "2": self.init_capture,
                    "3": self.init_live,
                    "4": self.preview_update,
                    "5": self.start_live_update_check,
                    "6": self.show_jobs,
                    "7": self.show_status,
                }
                action = actions.get(choice)
                if action is None:
                    self._write("未知选项。\n")
                    continue
                try:
                    action()
                except (BridgeError, ValueError, OSError, json.JSONDecodeError) as error:
                    self._write(f"操作失败：{error}\n")
        except EOFError:
            self._write("\n输入已结束，退出。")
        finally:
            try:
                self.bridge.close()
            finally:
                self.jobs.close()

    def configure(self) -> None:
        self._write("留空保持当前值；修改后请重新初始化对应会话。")
        self.config.app_id = self._prompt_default(
            "app_id（每个工具唯一，仅小写字母/数字/短横线）",
            self.config.app_id,
        )
        self.config.app_version = self._prompt_default(
            "app_version", self.config.app_version
        )
        self.config.platform = self._prompt_default("platform", self.config.platform)
        self.config.arch = self._prompt_default("arch", self.config.arch)
        self.capture_initialized = False
        self.live_endpoint = None
        self.bridge.request("reset_sessions")
        self._write("现有 SDK 会话已失效，请按新配置重新初始化。")
        self._write_json(self.config.bridge_fields())

    def init_capture(self) -> None:
        result = self.bridge.request(
            "init_capture",
            state_dir=str(self._state_directory("capture")),
            **self.config.bridge_fields(),
        )
        self.capture_initialized = True
        self._write(
            "本地启动使用检查已完成；同一设备同一天最多生成一条 daily_active，未联网："
        )
        self._write_json(result)

    def init_live(self) -> None:
        endpoint = self.input(
            "填写当前工具的 https://.../apps/<app_id>/v1/track: "
        ).strip()
        if not self._confirm_network("POST", endpoint):
            return
        self._write(
            "正在发送本次启动使用记录；同一设备当天最多 1 个 POST。"
            "来源 IP 由 CloudBase 从请求连接中记录，客户端不会填写 IP。"
        )
        result = self.bridge.request(
            "init_live",
            timeout=35,
            state_dir=str(self._state_directory("live")),
            endpoint=endpoint,
            allow_network=True,
            confirmation="POST",
            **self.config.bridge_fields(),
        )
        self.live_endpoint = endpoint
        self._write_json(result)

    def preview_update(self) -> None:
        if not self.capture_initialized and self.live_endpoint is None:
            self._write("请先初始化本地捕获或 live SDK 会话。")
            return
        manifest_path = Path(
            self.input("填写本地更新清单 JSON 路径（不会联网）: ").strip()
        ).expanduser()
        with manifest_path.open("r", encoding="utf-8") as manifest_file:
            manifest = json.load(manifest_file)
        result = self.bridge.request(
            "preview_update", manifest=manifest, **self.config.bridge_fields()
        )
        self._write("真实 UpdateChecker 的本地预览结果：")
        self._write_json(result)

    def start_live_update_check(self) -> None:
        if not self.capture_initialized and self.live_endpoint is None:
            self._write("请先初始化本地捕获或 live SDK 会话。")
            return
        base_url = self.input("填写更新清单公网 HTTPS base URL: ").strip()
        if not self._confirm_network("GET", base_url):
            return
        fields = self.config.bridge_fields()

        def check() -> Any:
            return self.bridge.request(
                "check_update_live",
                timeout=35,
                base_url=base_url,
                allow_network=True,
                confirmation="GET",
                **fields,
            )

        job_id = self.jobs.submit(f"GET {base_url}", check)
        self._write(f"后台更新检查 #{job_id} 已启动；菜单保持可用。")

    def show_jobs(self) -> None:
        jobs = tuple(self.jobs.jobs())
        if not jobs:
            self._write("尚无后台更新检查。")
            return
        for job in jobs:
            if not job.future.done():
                self._write(f"#{job.job_id} 运行中：{job.label}")
                continue
            self._report_job(job)

    def show_status(self) -> None:
        self._write_json(self.bridge.request("status"))

    def _announce_completed_jobs(self) -> None:
        for job in self.jobs.jobs():
            if job.future.done() and not job.reported:
                self._write(f"后台更新检查 #{job.job_id} 已完成：")
                self._report_job(job)

    def _report_job(self, job: BackgroundJob) -> None:
        try:
            self._write_json(job.future.result())
        except Exception as error:  # The worker returns a user-visible bridge error.
            self._write(f"#{job.job_id} 失败：{error}")
        job.reported = True

    def _confirm_network(self, verb: str, url: str) -> bool:
        if not url:
            self._write("URL 为空，已取消；未调用 Node 桥接。")
            return False
        entered = self.input(
            f"即将对 {url} 执行真实 {verb}。输入 {verb} 确认，其他输入取消: "
        )
        if entered != verb:
            self._write("确认词不匹配，已取消；未执行网络动作。")
            return False
        return True

    def _prompt_default(self, label: str, current: str) -> str:
        value = self.input(f"{label} [{current}]: ").strip()
        return value or current

    def _state_directory(self, mode: str) -> Path:
        return state_directory_for_app(self.state_root, mode, self.config.app_id)

    def _write_json(self, value: Any) -> None:
        self._write(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))

    def _write(self, message: str) -> None:
        print(message, file=self.output, flush=True)

    @staticmethod
    def _menu() -> str:
        return (
            "\n1. 修改测试配置\n"
            "2. 检查本次启动使用记录（本地捕获，零网络）\n"
            "3. 上报本次启动使用记录（当天最多 1 个 POST）\n"
            "4. 用本地 JSON 预览更新决策（零网络）\n"
            "5. 后台检查公网更新（显式 GET）\n"
            "6. 查看后台检查\n"
            "7. 查看桥接状态\n"
            "q. 退出\n"
        )


def detect_sdk_platform() -> str:
    if sys.platform == "win32":
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    return "linux"


def detect_sdk_architecture() -> str:
    machine = host_platform.machine().lower()
    if machine in {"amd64", "x86_64"}:
        return "x64"
    if machine in {"arm64", "aarch64"}:
        return "arm64"
    return "ia32"


def parse_arguments(argv: Optional[Iterable[str]] = None) -> argparse.Namespace:
    default_state = Path(tempfile.gettempdir()) / "bifang-python-sdk-test-client"
    default_bridge = Path(__file__).with_name("bridge.mjs")
    parser = argparse.ArgumentParser(
        description="Manually exercise @bifang/telemetry-update-sdk through Node."
    )
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=default_state,
        help="absolute or resolvable local identity-state root (default: OS temp)",
    )
    parser.add_argument(
        "--bridge", type=Path, default=default_bridge, help="path to bridge.mjs"
    )
    parser.add_argument("--node", default="node", help="Node.js executable")
    return parser.parse_args(argv)


def repository_root_for_bridge(bridge_path: Path) -> Optional[Path]:
    """Return the expected repository root without assuming path depth."""
    try:
        return bridge_path.parents[2]
    except IndexError:
        return None


def main(argv: Optional[Iterable[str]] = None) -> int:
    arguments = parse_arguments(argv)
    bridge_path = arguments.bridge.expanduser().resolve()
    if not bridge_path.is_file():
        print(f"找不到 Node 桥接：{bridge_path}", file=sys.stderr)
        return 2
    repository_root = repository_root_for_bridge(bridge_path)
    if repository_root is None:
        print(
            f"Node 桥接路径层级不足，无法定位仓库根目录：{bridge_path}",
            file=sys.stderr,
        )
        return 2
    sdk_entry = (
        repository_root
        / "packages"
        / "telemetry-update-sdk"
        / "dist"
        / "index.js"
    )
    if not sdk_entry.is_file():
        print(
            "SDK 尚未构建。请先运行：npm ci，然后运行："
            "npm run build --workspace @bifang/telemetry-update-sdk",
            file=sys.stderr,
        )
        return 2

    bridge: Optional[BridgeProcess] = None
    try:
        bridge = BridgeProcess(bridge_path, node_command=arguments.node)
        bridge.request("ping", timeout=5)
        InteractiveClient(bridge, arguments.state_dir.expanduser().resolve()).run()
        return 0
    except (BridgeError, FileNotFoundError, OSError) as error:
        print(f"无法启动客户端：{error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\n已退出。")
        return 130
    finally:
        if bridge is not None:
            bridge.close()


if __name__ == "__main__":
    if os.name == "nt":
        for stream in (sys.stdout, sys.stderr):
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
