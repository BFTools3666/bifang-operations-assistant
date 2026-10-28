#!/usr/bin/env python3
"""Verify published onboarding source, install its Skill, and scan one client.

The production path is deliberately fail closed: the script must be executed
from the root of the canonical, clean Git checkout at the commit currently
advertised by the remote default branch. It then scans only the Git repository
that owns the caller's original working directory. The scan runs before the
global Skill installation so a scan failure cannot leave a new installation.

This entrypoint never clones, builds, deploys, publishes, or changes the client
project. A hidden fixed-ref switch exists only so the supply-chain checks can
be tested without publishing a fixture commit; the normal one-line flow never
uses it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit, urlunsplit


RAW_BOOTSTRAP_PATH = Path(__file__).absolute()
REPOSITORY_ROOT = RAW_BOOTSTRAP_PATH.parents[1].resolve()
MANIFEST_PATH = REPOSITORY_ROOT / "bifang-onboarding.json"
BOOTSTRAP_PATH = REPOSITORY_ROOT / "tools" / "bootstrap_bifang_onboarding.py"
CANONICAL_REPOSITORY_URL = (
    "https://github.com/BFTools366/bifang-operations-assistant.git"
)
CANONICAL_ONE_LINE_REQUEST = f"{CANONICAL_REPOSITORY_URL} 帮我接入"
APPLICATION_VERSION_BASELINE_COMMIT = (
    "92b0c599a42c3a094c99787e6928c30c2d2ea3af"
)
MAX_MANIFEST_BYTES = 64 * 1024
MAX_ERROR_DETAIL_CHARS = 4_000
GIT_TIMEOUT_SECONDS = 30
SCRIPT_TIMEOUT_SECONDS = 60
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
REMOTE_BRANCH_PATTERN = re.compile(r"^refs/heads/[A-Za-z0-9._/-]+$")
SKILL_NAME = "bifang-public-services-onboarding"
PROHIBITED_PYTHON_CACHE_NAME = "__pycache__"
TARGET_SCAN_SKIPPED_DIRECTORIES = frozenset(
    (
        ".git",
        ".hg",
        ".svn",
        ".venv",
        "build",
        "coverage",
        "dist",
        "node_modules",
        "out",
        "target",
        "vendor",
        "venv",
    )
)
_TRUSTED_GIT_EXECUTABLE: str | None = None


class BootstrapError(RuntimeError):
    """An expected verification or bootstrap failure."""


@dataclass(frozen=True)
class GitSnapshot:
    branch: str
    head: str
    status_porcelain: str
    index_sha256: str
    content_sha256: str

    def as_json(self) -> dict[str, Any]:
        return {
            "branch": self.branch,
            "head": self.head,
            "dirty": bool(self.status_porcelain),
            "status_porcelain": self.status_porcelain.splitlines(),
            "status_sha256": hashlib.sha256(
                self.status_porcelain.encode("utf-8")
            ).hexdigest(),
            "index_sha256": self.index_sha256,
            "content_sha256": self.content_sha256,
        }


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise BootstrapError(f"duplicate JSON field: {key}")
        result[key] = value
    return result


def _read_manifest() -> dict[str, Any]:
    raw = MANIFEST_PATH.read_bytes()
    if len(raw) > MAX_MANIFEST_BYTES:
        raise BootstrapError("bootstrap manifest is unexpectedly large")
    try:
        value = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BootstrapError(f"invalid bootstrap manifest: {error}") from error
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise BootstrapError("unsupported bootstrap manifest schema")
    return value


def _minimal_environment(
    *, codex_home: Path | None = None, for_git: bool = False
) -> dict[str, str]:
    """Return only OS/runtime variables needed by trusted Git/Python children."""

    allowed = (
        "APPDATA",
        "COMSPEC",
        "HOME",
        "LOCALAPPDATA",
        "PATH",
        "PATHEXT",
        "PROGRAMDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "PROGRAMW6432",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "USERPROFILE",
        "WINDIR",
    )
    git_only = (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "ALL_PROXY",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "GIT_SSL_CAINFO",
    )
    by_casefold = {key.casefold(): (key, value) for key, value in os.environ.items()}
    environment: dict[str, str] = {}
    for requested in allowed:
        existing = by_casefold.get(requested.casefold())
        if existing is not None:
            environment[existing[0]] = existing[1]
    if for_git:
        for requested in git_only:
            existing = by_casefold.get(requested.casefold())
            if existing is not None:
                environment[existing[0]] = existing[1]
    environment.update(
        {
            "GCM_INTERACTIVE": "Never",
            "GIT_TERMINAL_PROMPT": "0",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
        }
    )
    if codex_home is not None:
        environment["CODEX_HOME"] = str(codex_home)
    return environment


def _trim_detail(value: str) -> str:
    value = value.strip()
    if len(value) <= MAX_ERROR_DETAIL_CHARS:
        return value
    return f"{value[:MAX_ERROR_DETAIL_CHARS]}...<truncated>"


def _run_command(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    timeout: float,
    label: str,
    allowed_returncodes: Iterable[int] = (0,),
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            command,
            cwd=cwd,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        raise BootstrapError(f"{label} timed out after {timeout:g} seconds") from error
    except OSError as error:
        raise BootstrapError(f"could not start {label}: {error}") from error
    if result.returncode not in set(allowed_returncodes):
        detail = _trim_detail(result.stderr or result.stdout)
        suffix = f": {detail}" if detail else ""
        raise BootstrapError(f"{label} failed{suffix}")
    return result


def _resolve_git_executable(excluded_paths: Iterable[Path]) -> str:
    """Resolve Git only from explicit absolute PATH entries.

    Python's Windows executable lookup may search the current directory before
    PATH.  That is unacceptable here because both the untrusted client cwd and
    the downloaded source checkout can contain an attacker-controlled git.exe.
    """

    excluded = tuple(path.resolve() for path in excluded_paths)
    executable_names = ("git.exe",) if os.name == "nt" else ("git",)
    for raw_entry in os.environ.get("PATH", "").split(os.pathsep):
        entry = raw_entry.strip().strip('"')
        if not entry:
            continue
        directory = Path(os.path.expandvars(entry)).expanduser()
        if not directory.is_absolute():
            continue
        for name in executable_names:
            candidate = directory / name
            try:
                if not candidate.is_file() or not os.access(candidate, os.X_OK):
                    continue
                resolved = candidate.resolve(strict=True)
            except OSError:
                continue
            if any(_paths_overlap(resolved, blocked) for blocked in excluded):
                continue
            return str(resolved)
    raise BootstrapError(
        "git executable was not found in a safe absolute PATH entry outside "
        "the invocation cwd, source, and target"
    )


def _initialize_git_executable(excluded_paths: Iterable[Path]) -> None:
    global _TRUSTED_GIT_EXECUTABLE
    _TRUSTED_GIT_EXECUTABLE = _resolve_git_executable(excluded_paths)


def _git_executable() -> str:
    if _TRUSTED_GIT_EXECUTABLE is None:
        raise BootstrapError("trusted git executable was not initialized")
    return _TRUSTED_GIT_EXECUTABLE


def _run_git(
    *arguments: str,
    cwd: Path = REPOSITORY_ROOT,
    timeout: float = GIT_TIMEOUT_SECONDS,
    strip_output: bool = True,
) -> str:
    result = _run_command(
        [_git_executable(), *arguments],
        cwd=cwd,
        env=_minimal_environment(for_git=True),
        timeout=timeout,
        label=f"git {arguments[0] if arguments else 'command'}",
    )
    if strip_output:
        return result.stdout.strip()
    return result.stdout.rstrip("\r\n")


def _normalized_repository_url(value: str) -> str:
    try:
        parsed = urlsplit(value.strip())
    except ValueError as error:
        raise BootstrapError(f"invalid repository URL: {error}") from error
    if (
        parsed.scheme.casefold() != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise BootstrapError("repository URL must be credential-free HTTPS")
    host = parsed.hostname.casefold()
    port = f":{parsed.port}" if parsed.port is not None else ""
    path = parsed.path.rstrip("/")
    if not path.endswith(".git"):
        path = f"{path}.git"
    return urlunsplit(("https", f"{host}{port}", path, "", ""))


def _require_string(container: dict[str, Any], key: str) -> str:
    value = container.get(key)
    if not isinstance(value, str) or not value:
        raise BootstrapError(f"manifest field {key!r} must be a non-empty string")
    return value


def _paths_overlap(first: Path, second: Path) -> bool:
    first = first.resolve()
    second = second.resolve()
    return first == second or first in second.parents or second in first.parents


def _is_link_or_reparse(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
        is_junction = getattr(path, "is_junction", None)
        if callable(is_junction) and is_junction():
            return True
        attributes = getattr(path.lstat(), "st_file_attributes", 0)
    except OSError as error:
        raise BootstrapError(f"could not inspect path safety for {path}: {error}") from error
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_flag)


def _require_safe_existing_path(path: Path, *, kind: str) -> None:
    if not path.exists():
        raise BootstrapError(f"required {kind} is missing: {path}")
    if _is_link_or_reparse(path):
        raise BootstrapError(f"required {kind} must not be a symlink or junction: {path}")
    if kind == "directory" and not path.is_dir():
        raise BootstrapError(f"required directory is not a directory: {path}")
    if kind == "file" and not path.is_file():
        raise BootstrapError(f"required file is not a regular file: {path}")


def _require_no_reparse_components(path: Path) -> None:
    try:
        relative = path.absolute().relative_to(REPOSITORY_ROOT)
    except ValueError as error:
        raise BootstrapError(f"required path escapes the repository: {path}") from error
    current = REPOSITORY_ROOT
    _require_safe_existing_path(current, kind="directory")
    for index, part in enumerate(relative.parts):
        current = current / part
        kind = "file" if index == len(relative.parts) - 1 and path.is_file() else "directory"
        _require_safe_existing_path(current, kind=kind)


def _relative_repository_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPOSITORY_ROOT.resolve()).as_posix()
    except ValueError as error:
        raise BootstrapError(f"required path escapes the repository: {path}") from error


def _manifest_path(relative: str, *, kind: str) -> Path:
    raw = Path(relative)
    if raw.is_absolute() or any(part in ("", ".", "..") for part in raw.parts):
        raise BootstrapError(f"manifest {kind} path must be a normalized relative path")
    candidate = REPOSITORY_ROOT.joinpath(*raw.parts)
    _require_no_reparse_components(candidate)
    _require_safe_existing_path(candidate, kind=kind)
    _relative_repository_path(candidate)
    return candidate.resolve()


def _collect_installed_skill_files(skill_directory: Path) -> list[Path]:
    files: list[Path] = []

    def visit(directory: Path) -> None:
        _require_safe_existing_path(directory, kind="directory")
        try:
            entries = sorted(
                os.scandir(directory), key=lambda entry: entry.name.casefold()
            )
        except OSError as error:
            raise BootstrapError(
                f"could not inspect Skill directory {directory}: {error}"
            ) from error
        for entry in entries:
            path = Path(entry.path)
            if (
                entry.name.casefold() == PROHIBITED_PYTHON_CACHE_NAME
                or entry.name.casefold().endswith(".pyc")
            ):
                raise BootstrapError(
                    f"Skill source must not contain Python bytecode/cache entries: {path}"
                )
            if _is_link_or_reparse(path):
                raise BootstrapError(
                    f"Skill source must not contain a symlink or junction: {path}"
                )
            try:
                if entry.is_dir(follow_symlinks=False):
                    visit(path)
                elif entry.is_file(follow_symlinks=False):
                    files.append(path.resolve())
                else:
                    raise BootstrapError(
                        f"Skill source contains a non-regular entry: {path}"
                    )
            except OSError as error:
                raise BootstrapError(f"could not inspect Skill entry {path}: {error}") from error

    visit(skill_directory)
    return files


def _require_clean_repository() -> None:
    status = _run_git(
        "-c",
        "core.quotepath=false",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
    )
    if status:
        raise BootstrapError(
            "bootstrap source repository differs from HEAD; use a fully clean "
            "published checkout"
        )
    tracked_flags = _run_git("ls-files", "-v")
    flagged = [line for line in tracked_flags.splitlines() if not line.startswith("H ")]
    if flagged:
        raise BootstrapError(
            "bootstrap source repository must not use skip-worktree, "
            "assume-unchanged, or non-ordinary index states"
        )


def _require_tracked_clean_source(files: Iterable[Path], scopes: Iterable[Path]) -> None:
    relative_files = sorted({_relative_repository_path(path) for path in files})
    relative_scopes = sorted({_relative_repository_path(path) for path in scopes})
    if not relative_files:
        raise BootstrapError("no trusted source files were selected")
    _run_git("ls-files", "--error-unmatch", "--", *relative_files)
    tracked_flags = _run_git("ls-files", "-v", "--", *relative_files)
    flagged = [
        line
        for line in tracked_flags.splitlines()
        if not line.startswith("H ")
    ]
    if flagged:
        raise BootstrapError(
            "onboarding source paths must not use skip-worktree, "
            "assume-unchanged, or non-ordinary index states"
        )
    status = _run_git(
        "-c",
        "core.quotepath=false",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        *relative_scopes,
    )
    if status:
        raise BootstrapError(
            "onboarding source paths differ from HEAD; use a clean published checkout"
        )


def _parse_advertised_head(output: str) -> tuple[str, str]:
    remote_ref: str | None = None
    remote_head: str | None = None
    for line in output.splitlines():
        if line.startswith("ref: ") and line.endswith("\tHEAD"):
            remote_ref = line[len("ref: ") : -len("\tHEAD")]
        else:
            fields = line.split("\t", 1)
            if len(fields) == 2 and fields[1] == "HEAD":
                remote_head = fields[0]
    if remote_ref is None or REMOTE_BRANCH_PATTERN.fullmatch(remote_ref) is None:
        raise BootstrapError("canonical origin did not advertise a default branch")
    if remote_head is None or COMMIT_PATTERN.fullmatch(remote_head) is None:
        raise BootstrapError("canonical origin did not advertise a full lowercase HEAD commit")
    return remote_ref, remote_head


def _verify_repository_identity(
    *,
    test_only_fixed_source_head: str | None,
    test_only_fixed_source_ref: str | None,
) -> tuple[str, str, bool]:
    _require_safe_existing_path(REPOSITORY_ROOT, kind="directory")
    git_root = Path(_run_git("rev-parse", "--show-toplevel")).resolve()
    if git_root != REPOSITORY_ROOT.resolve():
        raise BootstrapError(
            f"bootstrap source must be the Git top-level: {REPOSITORY_ROOT}"
        )
    _require_clean_repository()

    actual = _normalized_repository_url(_run_git("remote", "get-url", "origin"))
    canonical = _normalized_repository_url(CANONICAL_REPOSITORY_URL)
    if actual != canonical:
        raise BootstrapError(
            f"origin mismatch: expected {canonical!r}, found {actual!r}"
        )

    _require_safe_existing_path(MANIFEST_PATH, kind="file")
    _require_safe_existing_path(BOOTSTRAP_PATH, kind="file")
    _require_no_reparse_components(MANIFEST_PATH)
    _require_no_reparse_components(BOOTSTRAP_PATH)
    if _is_link_or_reparse(RAW_BOOTSTRAP_PATH):
        raise BootstrapError("bootstrap invocation path must not be a symlink or junction")
    if RAW_BOOTSTRAP_PATH.resolve() != BOOTSTRAP_PATH.resolve():
        raise BootstrapError("bootstrap must run from its canonical tracked path")
    _require_tracked_clean_source(
        (MANIFEST_PATH, BOOTSTRAP_PATH), (MANIFEST_PATH, BOOTSTRAP_PATH)
    )

    if (test_only_fixed_source_head is None) != (test_only_fixed_source_ref is None):
        raise BootstrapError(
            "test-only fixed source head and ref must be supplied together"
        )
    if test_only_fixed_source_head is not None:
        if COMMIT_PATTERN.fullmatch(test_only_fixed_source_head) is None:
            raise BootstrapError("test-only fixed source head must be a full lowercase commit")
        if (
            test_only_fixed_source_ref is None
            or REMOTE_BRANCH_PATTERN.fullmatch(test_only_fixed_source_ref) is None
        ):
            raise BootstrapError("test-only fixed source ref must be refs/heads/<branch>")
        remote_ref = test_only_fixed_source_ref
        remote_head = test_only_fixed_source_head
        matches_advertised_remote = False
    else:
        advertised = _run_git(
            "ls-remote",
            "--symref",
            "--exit-code",
            canonical,
            "HEAD",
            timeout=GIT_TIMEOUT_SECONDS,
        )
        remote_ref, remote_head = _parse_advertised_head(advertised)
        matches_advertised_remote = True

    head = _run_git("rev-parse", "HEAD")
    if COMMIT_PATTERN.fullmatch(head) is None:
        raise BootstrapError("source HEAD must be a full lowercase Git commit")
    if head != remote_head:
        raise BootstrapError(
            f"source HEAD is not the published {remote_ref} commit; fetch a fresh checkout"
        )
    return head, remote_ref, matches_advertised_remote


def _commit_is_ancestor(ancestor: str, descendant: str) -> bool:
    result = _run_command(
        [_git_executable(), "merge-base", "--is-ancestor", ancestor, descendant],
        cwd=REPOSITORY_ROOT,
        env=_minimal_environment(for_git=True),
        timeout=GIT_TIMEOUT_SECONDS,
        label="git merge-base",
        allowed_returncodes=(0, 1),
    )
    return result.returncode == 0


def _skill_metadata_value(skill_text: str, key: str) -> str:
    matches = re.findall(
        rf"(?m)^  {re.escape(key)}:\s*[\"']([^\"']+)[\"']\s*$",
        skill_text,
    )
    if len(matches) != 1:
        raise BootstrapError(f"SKILL.md must contain exactly one {key}")
    return matches[0]


def _package_version_at_commit(commit: str) -> str:
    raw = _run_git("show", f"{commit}:package.json", strip_output=False)
    try:
        package = json.loads(raw, object_pairs_hook=_reject_duplicate_keys)
    except json.JSONDecodeError as error:
        raise BootstrapError(
            f"package.json at infrastructure-source-commit is invalid: {error}"
        ) from error
    if not isinstance(package, dict):
        raise BootstrapError(
            "package.json at infrastructure-source-commit must contain an object"
        )
    version = package.get("version")
    if not isinstance(version, str) or not version:
        raise BootstrapError(
            "package.json at infrastructure-source-commit has no package version"
        )
    return version


def _verify_manifest_and_source(
    manifest: dict[str, Any], head: str
) -> dict[str, str]:
    _require_clean_repository()
    if _run_git("rev-parse", "HEAD") != head:
        raise BootstrapError("source HEAD changed during bootstrap verification")
    if _normalized_repository_url(
        _require_string(manifest, "canonicalRepositoryUrl")
    ) != _normalized_repository_url(CANONICAL_REPOSITORY_URL):
        raise BootstrapError("manifest canonicalRepositoryUrl is not the approved URL")
    if _require_string(manifest, "repositoryIdentity") != "bifang-operations-assistant":
        raise BootstrapError("manifest repositoryIdentity is not approved")
    if _require_string(manifest, "oneLineRequest") != CANONICAL_ONE_LINE_REQUEST:
        raise BootstrapError("manifest oneLineRequest is not the canonical request")
    if _require_string(manifest, "updateTransport") != "client-update-center-v1":
        raise BootstrapError("manifest updateTransport must select client-update-center-v1")

    minimum = _require_string(manifest, "minimumInfrastructureCommit")
    if COMMIT_PATTERN.fullmatch(minimum) is None:
        raise BootstrapError("minimum infrastructure commit must be a full lowercase hash")
    if not _commit_is_ancestor(minimum, head):
        raise BootstrapError(
            "repository HEAD does not contain the minimum application-version API baseline"
        )

    skill = manifest.get("skill")
    if not isinstance(skill, dict):
        raise BootstrapError("manifest skill section is missing")
    if _require_string(skill, "name") != SKILL_NAME:
        raise BootstrapError("manifest Skill name is not approved")
    paths = {
        "skill": _require_string(skill, "path"),
        "installer": _require_string(skill, "installer"),
        "scanner": _require_string(skill, "scanner"),
    }
    skill_path = _manifest_path(paths["skill"], kind="directory")
    installer_path = _manifest_path(paths["installer"], kind="file")
    scanner_path = _manifest_path(paths["scanner"], kind="file")
    skill_files = _collect_installed_skill_files(skill_path)
    _require_tracked_clean_source(
        [MANIFEST_PATH, BOOTSTRAP_PATH, installer_path, scanner_path, *skill_files],
        [MANIFEST_PATH, BOOTSTRAP_PATH, skill_path, installer_path, scanner_path],
    )

    try:
        skill_text = (skill_path / "SKILL.md").read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise BootstrapError(f"could not read Skill metadata: {error}") from error
    for key, expected in (
        ("version", _require_string(skill, "version")),
        ("infrastructure-version", _require_string(manifest, "infrastructureVersion")),
        (
            "application-version-contract-version",
            _require_string(manifest, "applicationVersionContractVersion"),
        ),
    ):
        if _skill_metadata_value(skill_text, key) != expected:
            raise BootstrapError(f"SKILL.md {key} does not match the bootstrap manifest")

    infrastructure_source_commit = _skill_metadata_value(
        skill_text, "infrastructure-source-commit"
    )
    if COMMIT_PATTERN.fullmatch(infrastructure_source_commit) is None:
        raise BootstrapError(
            "SKILL.md infrastructure-source-commit must be a full lowercase hash"
        )
    if not _commit_is_ancestor(minimum, infrastructure_source_commit):
        raise BootstrapError(
            "SKILL.md infrastructure-source-commit does not contain the minimum "
            "infrastructure commit"
        )
    if not _commit_is_ancestor(infrastructure_source_commit, head):
        raise BootstrapError(
            "SKILL.md infrastructure-source-commit is not an ancestor of source HEAD"
        )
    expected_infrastructure_version = _require_string(
        manifest, "infrastructureVersion"
    )
    if _package_version_at_commit(infrastructure_source_commit) != expected_infrastructure_version:
        raise BootstrapError(
            "SKILL.md infrastructure-source-commit does not contain the declared "
            "infrastructure version"
        )
    application_version_baseline = _require_string(
        manifest, "applicationVersionBaselineCommit"
    )
    if application_version_baseline != APPLICATION_VERSION_BASELINE_COMMIT:
        raise BootstrapError(
            "manifest applicationVersionBaselineCommit is not the frozen v1 baseline"
        )
    if (
        _skill_metadata_value(skill_text, "application-version-baseline-commit")
        != application_version_baseline
    ):
        raise BootstrapError(
            "SKILL.md application-version-baseline-commit does not match the manifest"
        )
    if not _commit_is_ancestor(
        application_version_baseline, infrastructure_source_commit
    ):
        raise BootstrapError(
            "infrastructure source does not contain the application-version v1 baseline"
        )
    return paths


def _git_root(path: Path, *, label: str) -> Path:
    try:
        value = _run_git("rev-parse", "--show-toplevel", cwd=path)
    except BootstrapError as error:
        raise BootstrapError(f"{label} must belong to a Git repository") from error
    return Path(value).resolve()


def _resolve_target(path: Path, invocation_cwd: Path) -> Path:
    target = path.expanduser().resolve()
    if not target.is_dir():
        raise BootstrapError(f"target project directory not found: {target}")
    target_root = _git_root(target, label="target project")
    invocation_root = _git_root(invocation_cwd.resolve(), label="invocation cwd")
    if target != target_root:
        raise BootstrapError(f"target project must be its Git top-level: {target_root}")
    if target != invocation_root:
        raise BootstrapError(
            "target project must equal the Git root that owns the invocation cwd"
        )
    return target


def _resolve_codex_home(explicit: Path | None) -> Path:
    if explicit is not None:
        return explicit.expanduser().resolve()
    configured = os.environ.get("CODEX_HOME")
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path.home() / ".codex").resolve()


def _require_isolated_paths(source: Path, target: Path, codex_home: Path) -> None:
    installation = codex_home / "skills" / SKILL_NAME
    if _paths_overlap(source, target):
        raise BootstrapError("source and target must be separate, non-nested paths")
    if _paths_overlap(source, installation):
        raise BootstrapError(
            "source must not overlap the actual Skill installation directory"
        )
    if _paths_overlap(target, installation):
        raise BootstrapError(
            "target must not overlap the actual Skill installation directory"
        )


def _digest_field(digest: Any, marker: bytes, relative: str, data: bytes = b"") -> None:
    encoded_relative = relative.encode("utf-8")
    digest.update(marker)
    digest.update(len(encoded_relative).to_bytes(4, "big"))
    digest.update(encoded_relative)
    digest.update(len(data).to_bytes(8, "big"))
    digest.update(data)


def _target_content_digest(target: Path) -> str:
    """Hash every entry that the scanner is permitted to traverse."""

    digest = hashlib.sha256()

    def visit(directory: Path) -> None:
        try:
            entries = sorted(os.scandir(directory), key=lambda item: item.name.casefold())
        except OSError as error:
            raise BootstrapError(
                f"could not snapshot target directory {directory}: {error}"
            ) from error
        for entry in entries:
            path = Path(entry.path)
            relative = path.relative_to(target).as_posix()
            if entry.name.casefold() in TARGET_SCAN_SKIPPED_DIRECTORIES:
                continue
            if _is_link_or_reparse(path):
                try:
                    link_value = os.readlink(path).encode("utf-8")
                except OSError:
                    try:
                        link_value = repr(path.lstat()).encode("utf-8")
                    except OSError as error:
                        raise BootstrapError(
                            f"could not snapshot target link {path}: {error}"
                        ) from error
                _digest_field(digest, b"L", relative, link_value)
                continue
            try:
                if entry.is_dir(follow_symlinks=False):
                    _digest_field(digest, b"D", relative)
                    visit(path)
                elif entry.is_file(follow_symlinks=False):
                    file_digest = hashlib.sha256()
                    with path.open("rb") as handle:
                        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                            file_digest.update(chunk)
                    _digest_field(digest, b"F", relative, file_digest.digest())
                else:
                    raise BootstrapError(
                        f"target contains an unsupported filesystem entry: {path}"
                    )
            except OSError as error:
                raise BootstrapError(
                    f"could not snapshot target entry {path}: {error}"
                ) from error

    visit(target)
    return digest.hexdigest()


def _target_snapshot(target: Path) -> GitSnapshot:
    branch = _run_git("rev-parse", "--abbrev-ref", "HEAD", cwd=target)
    head = _run_git("rev-parse", "HEAD", cwd=target)
    if COMMIT_PATTERN.fullmatch(head) is None:
        raise BootstrapError("target HEAD must be a full lowercase Git commit")
    status = _run_git(
        "-c",
        "core.quotepath=false",
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        cwd=target,
        strip_output=False,
    )
    index = _run_git("ls-files", "--stage", "-z", cwd=target, strip_output=False)
    return GitSnapshot(
        branch=branch,
        head=head,
        status_porcelain=status,
        index_sha256=hashlib.sha256(index.encode("utf-8")).hexdigest(),
        content_sha256=_target_content_digest(target),
    )


def _run_python(script: Path, arguments: list[str], env: dict[str, str]) -> str:
    result = _run_command(
        [sys.executable, "-I", "-X", "utf8", "-B", str(script), *arguments],
        cwd=REPOSITORY_ROOT,
        env=env,
        timeout=SCRIPT_TIMEOUT_SECONDS,
        label=script.name,
    )
    return result.stdout.strip()


def _require_unchanged(
    before: GitSnapshot, after: GitSnapshot, *, operation: str
) -> None:
    if before != after:
        raise BootstrapError(
            f"target Git branch, HEAD, index, status, or content changed during {operation}; "
            "installation was not continued"
        )


def _parse_scan_output(scan_output: str) -> dict[str, Any]:
    try:
        scan = json.loads(scan_output, object_pairs_hook=_reject_duplicate_keys)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise BootstrapError(f"scanner returned invalid JSON: {error}") from error
    if not isinstance(scan, dict):
        raise BootstrapError("scanner result must be an object")
    if scan.get("scan_version") != 3:
        raise BootstrapError("scanner result has an unsupported scan_version")
    if not isinstance(scan.get("scan_incomplete"), bool):
        raise BootstrapError("scanner result is missing scan_incomplete")
    if not isinstance(scan.get("skipped_files"), list):
        raise BootstrapError("scanner result is missing skipped_files")
    return scan


def bootstrap(
    target_project: Path,
    codex_home_argument: Path | None,
    *,
    invocation_cwd: Path,
    test_only_fixed_source_head: str | None = None,
    test_only_fixed_source_ref: str | None = None,
) -> dict[str, Any]:
    target_hint = target_project.expanduser().resolve()
    invocation_cwd = invocation_cwd.resolve()
    codex_home = _resolve_codex_home(codex_home_argument)
    _initialize_git_executable(
        (REPOSITORY_ROOT.resolve(), target_hint, invocation_cwd)
    )
    head, remote_ref, matches_advertised_remote = _verify_repository_identity(
        test_only_fixed_source_head=test_only_fixed_source_head,
        test_only_fixed_source_ref=test_only_fixed_source_ref,
    )
    manifest = _read_manifest()
    paths = _verify_manifest_and_source(manifest, head)
    target = _resolve_target(target_project, invocation_cwd)
    _require_isolated_paths(REPOSITORY_ROOT.resolve(), target, codex_home)
    environment = _minimal_environment(codex_home=codex_home)

    before = _target_snapshot(target)
    scan_error: BootstrapError | None = None
    scan_output = ""
    try:
        scan_output = _run_python(
            (REPOSITORY_ROOT / paths["scanner"]).resolve(),
            [str(target)],
            environment,
        )
    except BootstrapError as error:
        scan_error = error
    after_scan = _target_snapshot(target)
    _require_unchanged(before, after_scan, operation="the read-only scan")
    if scan_error is not None:
        raise scan_error
    scan = _parse_scan_output(scan_output)

    current_manifest = _read_manifest()
    if current_manifest != manifest:
        raise BootstrapError("bootstrap manifest changed after the read-only scan")
    current_paths = _verify_manifest_and_source(current_manifest, head)
    if current_paths != paths:
        raise BootstrapError("onboarding source paths changed after the read-only scan")

    install_error: BootstrapError | None = None
    install_output = ""
    try:
        install_output = _run_python(
            (REPOSITORY_ROOT / paths["installer"]).resolve(),
            [
                "--source",
                str((REPOSITORY_ROOT / paths["skill"]).resolve()),
                "--skip-external-quick-validate",
            ],
            environment,
        )
    except BootstrapError as error:
        install_error = error
    after_install = _target_snapshot(target)
    _require_unchanged(before, after_install, operation="Skill installation")
    if install_error is not None:
        raise install_error

    return {
        "ok": True,
        "authorization": "one-line-client-integration; bootstrap-output-is-stage-0-only",
        "canonical_repository_url": manifest["canonicalRepositoryUrl"],
        "source_head": head,
        "source_remote_ref": remote_ref,
        "source_is_clean_checkout": True,
        "source_matches_advertised_remote": matches_advertised_remote,
        "source_verification_mode": (
            "remote-advertised-head"
            if matches_advertised_remote
            else "test-only-fixed-ref"
        ),
        "infrastructure_version": manifest["infrastructureVersion"],
        "application_version_contract_version": manifest[
            "applicationVersionContractVersion"
        ],
        "skill": {
            "name": manifest["skill"]["name"],
            "version": manifest["skill"]["version"],
            "installer_result": install_output,
        },
        "target_project": str(target),
        "target_git_before": before.as_json(),
        "target_git_after": after_install.as_json(),
        "target_git_unchanged": before == after_install,
        "stage_0_scan": scan,
        "writes_to_target_project": False,
        "next_step": (
            "Read the installed SKILL.md completely and continue the one-line "
            "client integration within its explicit local-only boundary."
        ),
    }


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Install the verified Bifang onboarding Skill and scan one client project."
        )
    )
    parser.add_argument(
        "--target-project",
        type=Path,
        required=True,
        help="current client Git root to inspect without modifying",
    )
    parser.add_argument(
        "--codex-home",
        type=Path,
        help="optional explicit Codex home (primarily for isolated verification)",
    )
    parser.add_argument("--test-only-fixed-source-head", help=argparse.SUPPRESS)
    parser.add_argument("--test-only-fixed-source-ref", help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    invocation_cwd = Path.cwd()
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    try:
        result = bootstrap(
            args.target_project,
            args.codex_home,
            invocation_cwd=invocation_cwd,
            test_only_fixed_source_head=args.test_only_fixed_source_head,
            test_only_fixed_source_ref=args.test_only_fixed_source_ref,
        )
    except (BootstrapError, OSError, KeyError, ValueError) as error:
        print(f"[ERROR] {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
