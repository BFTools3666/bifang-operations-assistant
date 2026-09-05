#!/usr/bin/env python3
"""Read-only project scan for legacy Bifang routes and architecture evidence."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any


SKIPPED_DIRECTORIES = frozenset(
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
TEXT_EXTENSIONS = frozenset(
    (
        ".bash",
        ".bat",
        ".c",
        ".cc",
        ".cfg",
        ".cjs",
        ".cmd",
        ".conf",
        ".cpp",
        ".cs",
        ".css",
        ".env",
        ".fish",
        ".go",
        ".h",
        ".hpp",
        ".html",
        ".ini",
        ".java",
        ".js",
        ".json",
        ".jsx",
        ".kt",
        ".kts",
        ".lua",
        ".md",
        ".mjs",
        ".properties",
        ".py",
        ".ps1",
        ".ps1xml",
        ".psd1",
        ".psm1",
        ".rb",
        ".rs",
        ".rst",
        ".sh",
        ".svelte",
        ".swift",
        ".toml",
        ".ts",
        ".tsx",
        ".txt",
        ".vue",
        ".xml",
        ".yaml",
        ".yml",
        ".pl",
        ".php",
        ".zsh",
    )
)
TEXT_FILE_NAMES = frozenset(
    ("dockerfile", "makefile", "procfile", "justfile", ".env")
)
TEST_COMPONENTS = frozenset(
    (
        "__fixtures__",
        "__mocks__",
        "__snapshots__",
        "__tests__",
        "example",
        "examples",
        "fixture",
        "fixtures",
        "mock",
        "mocks",
        "sample",
        "samples",
        "spec",
        "specs",
        "test",
        "testdata",
        "tests",
    )
)
DOC_COMPONENTS = frozenset(("doc", "docs", "documentation", "skills"))
GENERATED_METADATA_FILE_NAMES = frozenset(
    (
        "cargo.lock",
        "composer.lock",
        "package-lock.json",
        "pipfile.lock",
        "pnpm-lock.yaml",
        "poetry.lock",
        "yarn.lock",
    )
)
MAX_TEXT_FILE_BYTES = 2_097_152
APP_ID_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$")

MODERN_TRACK_PATTERN = re.compile(
    r"/apps/(?P<app_id>[A-Za-z0-9_-]{1,100}|<app_id>)/v1/track",
)
UPDATE_MANIFEST_PATTERN = re.compile(
    r"/updates/(?P<app_id>[A-Za-z0-9_-]{1,100})"
    r"/(?P<platform>windows|macos|linux)\.json",
)
APP_ID_DECLARATION_PATTERN = re.compile(
    r"(?:\b(?i:APP_ID)\b|[\"']?(?i:app[_-]?id)[\"']?)\s*[:=]\s*"
    r"(?P<quote>[\"'`])(?P<app_id>[^\"'`\r\n]{1,100})(?P=quote)"
)
APP_ID_ASSIGNMENT_LOCATION_PATTERN = re.compile(
    r"(?:\b(?i:APP_ID)\b|[\"']?(?i:app[_-]?id)[\"']?)\s*[:=]"
)
ENV_APP_ID_PATTERN = re.compile(
    r"^\s*(?i:APP_ID)\s*=\s*(?P<app_id>[A-Za-z0-9_-]{1,100})"
    r"\s*(?:#.*)?$"
)
LEGACY_TRACK_PATTERN = re.compile(
    r"(?:^|[\s\"'`=:(]|https?://[^/\s\"'`]+)(/v1/track)"
    r"(?=$|[\s\"'`?/#,)])",
    re.IGNORECASE,
)
OTHER_LEGACY_PATTERNS = {
    "legacy_app_id": re.compile(r"(?<![A-Za-z0-9_-])example-tool(?![A-Za-z0-9_-])"),
    "legacy_collection": re.compile(
        r"(?<![A-Za-z0-9_])telemetry_events(?![A-Za-z0-9_])"
    ),
}
ARCHITECTURE_PATTERN = re.compile(
    r"(?<![A-Za-z0-9_])"
    r"(x86_64|x86-64|amd64|x64|aarch64|arm64|i[3-6]86|ia32)"
    r"(?![A-Za-z0-9_])",
    re.IGNORECASE,
)
ARCHITECTURE_ORDER = ("x64", "arm64", "ia32")
NON_ACTIVE_WARNING_CUES = re.compile(
    r"(?i)(?:do not|don't|must not|avoid|forbidden|deprecated|historical|legacy|"
    r"不要|不得|禁止|避免|历史|旧路由|旧链路|共享)"
)
ACTIVE_LEGACY_USAGE_PATTERN = re.compile(
    r"(?i)(?:"
    r"https?://[^\s\"'`]+/v1/track|"
    r"(?:endpoint|url|route|path|telemetry|track)[^:=\n]{0,40}[:=][^\n]{0,200}/v1/track|"
    r"(?:fetch|axios|request|post|get)\s*\([^\n)]{0,200}/v1/track"
    r")"
)


def scan_project(root: Path) -> dict[str, Any]:
    """Scan a local tree without executing code, changing files, or using a network."""

    resolved_root = root.resolve(strict=True)
    if not resolved_root.is_dir():
        raise ValueError("project root must be a directory")

    runtime_hits: list[dict[str, Any]] = []
    non_runtime_hits: list[dict[str, Any]] = []
    modern_track_hits: list[dict[str, Any]] = []
    update_manifest_hits: list[dict[str, Any]] = []
    app_id_candidates: list[dict[str, Any]] = []
    invalid_app_id_evidence: list[dict[str, Any]] = []
    unresolved_app_id_evidence: list[dict[str, Any]] = []
    runtime_app_ids: set[str] = set()
    architecture_candidates: list[dict[str, Any]] = []
    configured_architectures: set[str] = set()
    skipped_files: list[dict[str, str]] = []
    scanned_files = 0

    for path in _iter_text_files(resolved_root, skipped_files):
        text, skip_reason = _read_text(path)
        if text is None:
            skipped_files.append(
                {
                    "path": path.relative_to(resolved_root).as_posix(),
                    "reason": skip_reason or "unreadable",
                }
            )
            continue
        scanned_files += 1
        relative = path.relative_to(resolved_root)
        relative_path = relative.as_posix()
        evidence_kind = _classify_path(relative)
        for line_number, line in enumerate(text.splitlines(), start=1):
            for match in MODERN_TRACK_PATTERN.finditer(line):
                candidate = match.group("app_id")
                valid = candidate == "<app_id>" or APP_ID_PATTERN.fullmatch(candidate) is not None
                modern_track_hits.append(
                    {
                        "app_id": candidate,
                        "kind": evidence_kind,
                        "line": line_number,
                        "path": relative_path,
                        "valid": valid,
                    }
                )
                if candidate != "<app_id>":
                    _record_app_id_evidence(
                        candidate,
                        evidence_kind,
                        line_number,
                        relative_path,
                        "modern_track_route",
                        app_id_candidates,
                        invalid_app_id_evidence,
                        runtime_app_ids,
                    )
            for match in UPDATE_MANIFEST_PATTERN.finditer(line):
                candidate = match.group("app_id")
                platform = match.group("platform")
                valid = APP_ID_PATTERN.fullmatch(candidate) is not None
                update_manifest_hits.append(
                    {
                        "app_id": candidate,
                        "kind": evidence_kind,
                        "line": line_number,
                        "path": relative_path,
                        "platform": platform,
                        "valid": valid,
                    }
                )
                _record_app_id_evidence(
                    candidate,
                    evidence_kind,
                    line_number,
                    relative_path,
                    "update_manifest_path",
                    app_id_candidates,
                    invalid_app_id_evidence,
                    runtime_app_ids,
                )
            literal_declarations = list(APP_ID_DECLARATION_PATTERN.finditer(line))
            for match in literal_declarations:
                _record_app_id_evidence(
                    match.group("app_id"),
                    evidence_kind,
                    line_number,
                    relative_path,
                    "app_id_declaration",
                    app_id_candidates,
                    invalid_app_id_evidence,
                    runtime_app_ids,
                )
            env_match = None
            if _is_environment_file(relative):
                env_match = ENV_APP_ID_PATTERN.fullmatch(line)
                if env_match is not None:
                    _record_app_id_evidence(
                        env_match.group("app_id"),
                        evidence_kind,
                        line_number,
                        relative_path,
                        "environment_declaration",
                        app_id_candidates,
                        invalid_app_id_evidence,
                        runtime_app_ids,
                    )
            if (
                APP_ID_ASSIGNMENT_LOCATION_PATTERN.search(line) is not None
                and not literal_declarations
                and env_match is None
            ):
                unresolved_app_id_evidence.append(
                    {
                        "kind": evidence_kind,
                        "line": line_number,
                        "path": relative_path,
                        "source": "unresolved_assignment",
                    }
                )
            sanitized_line = MODERN_TRACK_PATTERN.sub("", line)
            markers: list[str] = []
            if LEGACY_TRACK_PATTERN.search(sanitized_line):
                markers.append("legacy_track_path")
            for marker, pattern in OTHER_LEGACY_PATTERNS.items():
                if pattern.search(line):
                    markers.append(marker)
            line_kind = evidence_kind
            if (
                evidence_kind == "runtime"
                and markers
                and NON_ACTIVE_WARNING_CUES.search(line)
                and ACTIVE_LEGACY_USAGE_PATTERN.search(line) is None
            ):
                line_kind = "runtime_text"
            target = runtime_hits if line_kind == "runtime" else non_runtime_hits
            for marker in sorted(markers):
                target.append(
                    {
                        "kind": line_kind,
                        "line": line_number,
                        "marker": marker,
                        "path": relative_path,
                    }
                )

            if evidence_kind == "runtime":
                build_configuration = _is_build_configuration(relative)
                for match in ARCHITECTURE_PATTERN.finditer(line):
                    raw_architecture = match.group(1)
                    normalized_architecture = _normalize_architecture(raw_architecture)
                    architecture_candidates.append(
                        {
                            "confidence": (
                                "build_configuration"
                                if build_configuration
                                else "runtime_token"
                            ),
                            "line": line_number,
                            "normalized": normalized_architecture,
                            "path": relative_path,
                            "raw": raw_architecture,
                        }
                    )
                    if build_configuration:
                        configured_architectures.add(normalized_architecture)

    runtime_hits.sort(key=_hit_sort_key)
    non_runtime_hits.sort(key=_hit_sort_key)
    app_id_candidates = _deduplicate_and_sort_evidence(app_id_candidates)
    invalid_app_id_evidence = _deduplicate_and_sort_evidence(
        invalid_app_id_evidence
    )
    architecture_candidates = _deduplicate_and_sort_evidence(
        architecture_candidates
    )
    modern_track_hits = _deduplicate_and_sort_evidence(modern_track_hits)
    update_manifest_hits = _deduplicate_and_sort_evidence(update_manifest_hits)
    unresolved_app_id_evidence = _deduplicate_and_sort_evidence(
        unresolved_app_id_evidence
    )
    skipped_files = sorted(
        {json.dumps(item, sort_keys=True): item for item in skipped_files}.values(),
        key=lambda item: (item["path"].casefold(), item["reason"]),
    )
    scan_incomplete = bool(skipped_files)
    if runtime_hits:
        classification = "runtime_reference"
        legacy_track_status = "migration_required"
        migration_gate = "blocked"
    elif scan_incomplete:
        classification = "incomplete"
        legacy_track_status = "unknown"
        migration_gate = "blocked"
    elif non_runtime_hits:
        classification = "non_runtime_only"
        legacy_track_status = "found"
        migration_gate = "review"
    else:
        classification = "not_found"
        legacy_track_status = "not_found"
        migration_gate = "clear"

    return {
        "classification": classification,
        "app_id_candidates": app_id_candidates,
        "architecture_candidates": architecture_candidates,
        "detected_app_ids": sorted(runtime_app_ids),
        "detected_architectures": [
            architecture
            for architecture in ARCHITECTURE_ORDER
            if architecture in configured_architectures
        ],
        "invalid_app_id_evidence": invalid_app_id_evidence,
        "legacy_track_status": legacy_track_status,
        "migration_gate": migration_gate,
        "modern_track_hits": modern_track_hits,
        "non_runtime_hits": non_runtime_hits,
        "runtime_hits": runtime_hits,
        "scan_incomplete": scan_incomplete,
        "scan_version": 2,
        "scanned_files": scanned_files,
        "skipped_files": skipped_files,
        "update_manifest_hits": update_manifest_hits,
        "unresolved_app_id_evidence": unresolved_app_id_evidence,
    }


def _iter_text_files(root: Path, skipped_files: list[dict[str, str]]):
    def record_walk_error(error: OSError) -> None:
        filename = getattr(error, "filename", None)
        if filename:
            try:
                relative = Path(filename).resolve().relative_to(root).as_posix()
            except (OSError, ValueError):
                relative = "<unresolved-directory>"
        else:
            relative = "<unknown-directory>"
        skipped_files.append({"path": relative, "reason": "unreadable_directory"})

    for current_root, directory_names, file_names in os.walk(
        root, topdown=True, onerror=record_walk_error, followlinks=False
    ):
        kept_directories: list[str] = []
        for name in sorted(directory_names, key=str.casefold):
            candidate = Path(current_root) / name
            if name.casefold() in SKIPPED_DIRECTORIES:
                continue
            if candidate.is_symlink():
                skipped_files.append(
                    {
                        "path": candidate.relative_to(root).as_posix(),
                        "reason": "symlink_directory",
                    }
                )
                continue
            kept_directories.append(name)
        directory_names[:] = kept_directories
        for file_name in sorted(file_names, key=str.casefold):
            path = Path(current_root) / file_name
            if not _is_text_candidate(path):
                continue
            if path.is_symlink():
                skipped_files.append(
                    {
                        "path": path.relative_to(root).as_posix(),
                        "reason": "symlink_file",
                    }
                )
                continue
            yield path


def _is_text_candidate(path: Path) -> bool:
    name = path.name.casefold()
    return (
        path.suffix.casefold() in TEXT_EXTENSIONS
        or name in TEXT_FILE_NAMES
        or name.startswith(".env.")
    )


def _read_text(path: Path) -> tuple[str | None, str | None]:
    try:
        size = path.stat().st_size
        if size > MAX_TEXT_FILE_BYTES:
            return None, "too_large"
        raw = path.read_bytes()
    except OSError:
        return None, "unreadable"
    if b"\0" in raw:
        return None, "binary_content"
    try:
        return raw.decode("utf-8-sig"), None
    except UnicodeDecodeError:
        return None, "non_utf8"


def _is_environment_file(relative_path: Path) -> bool:
    name = relative_path.name.casefold()
    return name == ".env" or name.startswith(".env.")


def _is_build_configuration(relative_path: Path) -> bool:
    name = relative_path.name.casefold()
    parts = {part.casefold() for part in relative_path.parts[:-1]}
    return (
        name
        in {
            "cargo.toml",
            "electron-builder.json",
            "electron-builder.yml",
            "electron-builder.yaml",
            "forge.config.js",
            "forge.config.mjs",
            "forge.config.ts",
            "package.json",
            "pyproject.toml",
            "tauri.conf.json",
            "tauri.conf.json5",
        }
        or name.startswith("electron-builder.")
        or bool(parts & {".github", "installer", "packaging", "release", "workflows"})
    )


def _classify_path(relative_path: Path) -> str:
    parts = [part.casefold() for part in relative_path.parts]
    file_name = parts[-1]
    stem = relative_path.stem.casefold()
    if file_name in GENERATED_METADATA_FILE_NAMES:
        return "generated_metadata"
    if any(part in TEST_COMPONENTS for part in parts[:-1]) or any(
        marker in file_name
        for marker in (".test.", ".spec.", "_test.", "_spec.", ".snap")
    ) or stem.startswith(("test_", "spec_")):
        return "test_fixture"
    if (
        any(part in DOC_COMPONENTS for part in parts[:-1])
        or relative_path.suffix.casefold() in (".md", ".rst")
        or file_name.startswith(("readme", "changelog", "history"))
    ):
        return "documentation"
    return "runtime"


def _normalize_architecture(value: str) -> str:
    normalized = value.casefold()
    if normalized in ("x86_64", "x86-64", "amd64", "x64"):
        return "x64"
    if normalized in ("aarch64", "arm64"):
        return "arm64"
    return "ia32"


def _record_app_id_evidence(
    candidate: str,
    kind: str,
    line: int,
    path: str,
    source: str,
    valid_evidence: list[dict[str, Any]],
    invalid_evidence: list[dict[str, Any]],
    runtime_app_ids: set[str],
) -> None:
    evidence = {
        "app_id": candidate,
        "kind": kind,
        "line": line,
        "path": path,
        "source": source,
    }
    if APP_ID_PATTERN.fullmatch(candidate) is None:
        invalid_evidence.append(evidence)
        return
    valid_evidence.append(evidence)
    if kind == "runtime":
        runtime_app_ids.add(candidate)


def _hit_sort_key(hit: dict[str, Any]) -> tuple[str, int, str, str]:
    return (hit["path"].casefold(), hit["line"], hit["marker"], hit["kind"])


def _deduplicate_and_sort_evidence(
    evidence: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    unique = {
        json.dumps(item, ensure_ascii=False, sort_keys=True): item for item in evidence
    }
    return sorted(
        unique.values(),
        key=lambda item: (
            item["path"].casefold(),
            item["line"],
            item.get("source", ""),
            item.get("app_id", ""),
            item.get("platform", ""),
            item.get("normalized", ""),
            item.get("raw", ""),
            item.get("kind", ""),
        ),
    )


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Read-only scan for historical Bifang service references."
    )
    parser.add_argument("project_root", type=Path, help="project directory to scan")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    try:
        result = scan_project(args.project_root)
    except (OSError, ValueError) as error:
        print(f"project scan failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
