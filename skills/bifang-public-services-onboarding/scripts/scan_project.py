#!/usr/bin/env python3
"""Read-only scan for telemetry, old update clients and update-center markers."""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
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
STATIC_UPDATE_BASE_PATTERN = re.compile(
    r"(?:https?://[^\s\"'`]+)?/updates(?:/|(?=$|[\s\"'`?#,)]))",
    re.IGNORECASE,
)
APPLICATION_VERSION_DOUBLE_V1_PATTERN = re.compile(
    r"/tools/version-control/v1/v1(?:/|(?=$|[\s\"'`?#,)]))",
    re.IGNORECASE,
)
APPLICATION_VERSION_CHECK_PATTERN = re.compile(
    r"/tools/version-control/v1/versions/[^/\s\"'`?#]+/[^/\s\"'`?#]+",
    re.IGNORECASE,
)
APPLICATION_VERSION_ADS_SHOW_PATTERN = re.compile(
    r"/tools/version-control/v1/app/[^/\s\"'`?#]+/ads/show",
    re.IGNORECASE,
)
APPLICATION_VERSION_BASE_PATTERN = re.compile(
    r"/tools/version-control/v1(?=$|[/\s\"'`?#,)])",
    re.IGNORECASE,
)
APPLICATION_VERSION_HEADER_PATTERNS = {
    "x_app_key_header": re.compile(r"(?<![A-Za-z0-9-])x-app-key(?![A-Za-z0-9-])", re.IGNORECASE),
    "x_app_secret_header": re.compile(
        r"(?<![A-Za-z0-9-])x-app-secret(?![A-Za-z0-9-])", re.IGNORECASE
    ),
}
IDENTIFIER_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9_-]{1,80}")
UPDATE_BASE_URL_IDENTIFIERS = frozenset(
    (
        "updatebaseurl",
        "legacyupdatebaseurl",
        "staticupdatebaseurl",
    )
)
UPDATE_SEGMENT_PATTERN = re.compile(
    r'''(?i)(?:["'`])/?updates(?:[/\\]|["'`])'''
)
RELATIVE_UPDATE_MANIFEST_PATTERN = re.compile(
    r'''(?ix)
    (?<![A-Za-z0-9/])updates[/\\]
    (?:[^\s"'`/\\]+[/\\])?
    (?:windows|macos|linux|\$\{[^}]+\}|\{[^}]+\})\.json
    '''
)
PATH_ASSEMBLY_PATTERN = re.compile(
    r"(?i)(?:\bnew\s+URL\s*\(|\b(?:path\.)?join\s*\(|\.join\s*\(|"
    r"\bconcat\s*\(|\$\{|\+\s*[A-Za-z_'\"]|(?:format|sprintf)\s*\()"
)
JSON_PATH_CONTEXT_PATTERN = re.compile(
    r"(?i)(?:\.json|windows|macos|linux|platform|app[_-]?id|manifest)"
)
LEGACY_MANIFEST_FIELDS = frozenset(
    (
        "schemaversion",
        "appid",
        "platform",
        "latestversion",
        "minsupportedversion",
        "enabled",
        "forceupdate",
        "rollout",
        "title",
        "message",
        "downloadurl",
        "releasenotesurl",
        "sha256",
        "publishedat",
    )
)
LEGACY_MANIFEST_CORE_FIELDS = frozenset(
    (
        "latestversion",
        "minsupportedversion",
        "forceupdate",
        "rollout",
        "releasenotesurl",
        "publishedat",
    )
)
LEGACY_MANIFEST_PARSER_PATTERN = re.compile(
    r"(?i)(?:parse|validate|decode|deserialize|load|read|fetch)"
    r"[A-Za-z0-9_-]{0,32}(?:update|static)[A-Za-z0-9_-]{0,24}"
    r"(?:manifest|config)|"
    r"(?:update|static)[A-Za-z0-9_-]{0,24}(?:manifest|config)"
    r"[A-Za-z0-9_-]{0,24}(?:parser|validator|decode)"
)
LEGACY_MANIFEST_TYPE_PATTERN = re.compile(
    r"(?i)\b(?:interface|type|class|struct|record)\s+"
    r"[A-Za-z0-9_-]*(?:update|static)[A-Za-z0-9_-]*(?:manifest|config)"
)
ROLLOUT_SUPPORT_PATTERN = re.compile(
    r"(?i)(?:bucket|hash|digest|percentage|percent|modulo|crc|fnv|sha(?:1|256)?|%\s*100)"
)
INSTALL_IDENTITY_PATTERN = re.compile(
    r"(?i)(?:install[_-]?id|installation[_-]?id|device[_-]?id|machine[_-]?id)"
)

APPLICATION_VERSION_RESPONSE_FIELDS = frozenset(
    (
        "update",
        "downloadurl",
        "promptcontent",
        "forcedupdate",
        "promptupdate",
        "stopupdate",
        "updatecontent",
    )
)
APPLICATION_VERSION_ROUTE_SEGMENT_PATTERN = re.compile(
    r'''(?i)/versions(?:/|["'`])'''
)
HTTP_REQUEST_CALL_PATTERN = re.compile(
    r"(?i)(?:\bfetch\s*\(|\baxios\s*\.\s*get\s*\(|"
    r"\brequests?\s*\.\s*get\s*\(|\b(?:http_?|web_?)?client\s*\.\s*get\s*\(|"
    r"\breqwest\s*::|\bureq\s*::\s*get\s*\()"
)
STRICT_OBJECT_KEYS_PATTERN = re.compile(
    r"(?i)(?:Object\s*\.\s*keys|\.keys\s*\(|expected[_-]?keys|response[_-]?keys|"
    r"deny_unknown_fields|additionalProperties\s*[:=]\s*false|unknown[_ -]?fields?)"
)
STRICT_OBJECT_REJECTION_PATTERN = re.compile(
    r"(?i)(?:hasOwn|every\s*\(|set\s*\(|length\s*[!=]==?|len\s*\(|"
    r"exact(?:ly)?[_ -]?(?:seven|7|keys?|fields?)|reject|forbid)"
)
DECISION_FLOW_PATTERN = re.compile(
    r"(?i)(?:decide[A-Za-z0-9_-]*(?:version|update)|"
    r"if\s*\([^)]*(?:stop[_-]?update|forced[_-]?update|prompt[_-]?update)|"
    r"\b(?:stopped|required|optional|up[_-]?to[_-]?date)\b)"
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


def _normalized_identifier_locations(text: str) -> dict[str, int]:
    locations: dict[str, int] = {}
    for match in IDENTIFIER_PATTERN.finditer(text):
        normalized = re.sub(r"[_-]+", "", match.group(0).casefold())
        locations.setdefault(normalized, match.start())
    return locations


def _line_number_at(text: str, offset: int) -> int:
    return text.count("\n", 0, max(0, offset)) + 1


def _detect_legacy_static_file_markers(text: str) -> list[tuple[str, int]]:
    """Return high-confidence legacy-update markers without returning source text."""

    identifiers = _normalized_identifier_locations(text)
    field_locations = {
        field: identifiers[field]
        for field in LEGACY_MANIFEST_FIELDS
        if field in identifiers
    }
    core_fields = LEGACY_MANIFEST_CORE_FIELDS.intersection(field_locations)
    markers: dict[str, int] = {}

    update_base_locations = [
        offset
        for name, offset in identifiers.items()
        if name in UPDATE_BASE_URL_IDENTIFIERS
        or (name.endswith("updatebaseurl") and "applicationversion" not in name)
    ]
    if update_base_locations:
        markers["legacy_update_base_url"] = min(update_base_locations)

    # A relative or assembled updates/<app>/<platform>.json path can avoid the
    # old literal /updates detector. Require both path construction and manifest
    # context so a generic "updates" label does not block migration.
    direct_static_path = STATIC_UPDATE_BASE_PATTERN.search(text)
    relative_manifest = RELATIVE_UPDATE_MANIFEST_PATTERN.search(text)
    update_segment = UPDATE_SEGMENT_PATTERN.search(text)
    if direct_static_path is None and (
        relative_manifest is not None
        or (
            update_segment is not None
            and PATH_ASSEMBLY_PATTERN.search(text) is not None
            and JSON_PATH_CONTEXT_PATTERN.search(text) is not None
        )
    ):
        evidence = relative_manifest or update_segment
        assert evidence is not None
        markers["dynamic_static_update_path"] = evidence.start()

    parser = LEGACY_MANIFEST_PARSER_PATTERN.search(text)
    if parser is not None and len(field_locations) >= 3 and len(core_fields) >= 2:
        markers["legacy_manifest_parser"] = parser.start()

    manifest_type = LEGACY_MANIFEST_TYPE_PATTERN.search(text)
    if (
        manifest_type is not None
        and len(field_locations) >= 5
        and len(core_fields) >= 2
    ):
        markers["legacy_manifest_type"] = manifest_type.start()

    if len(field_locations) >= 7 and len(core_fields) >= 3:
        markers["legacy_manifest_field_contract"] = min(field_locations.values())

    rollout_locations = [
        offset for name, offset in identifiers.items() if "rollout" in name
    ]
    if (
        rollout_locations
        and ROLLOUT_SUPPORT_PATTERN.search(text) is not None
        and INSTALL_IDENTITY_PATTERN.search(text) is not None
    ):
        markers["legacy_rollout_algorithm"] = min(rollout_locations)

    compatibility_locations = []
    for name, offset in identifiers.items():
        has_update_context = "update" in name and any(
            token in name for token in ("legacy", "static", "manifest")
        )
        has_switch_semantics = any(
            token in name
            for token in ("fallback", "compat", "enable", "disable", "useold")
        )
        if has_update_context and has_switch_semantics:
            compatibility_locations.append(offset)
        elif "manifest" in name and "fallback" in name and (
            field_locations or direct_static_path or relative_manifest
        ):
            compatibility_locations.append(offset)
    has_split_compatibility_identifiers = any(
        "updateprotocol" in name or "updatechecker" in name for name in identifiers
    ) and any(
        ("legacy" in name or "static" in name or "manifest" in name)
        and ("fallback" in name or "compat" in name)
        for name in identifiers
    )
    if compatibility_locations or has_split_compatibility_identifiers:
        markers["legacy_update_compatibility"] = (
            min(compatibility_locations)
            if compatibility_locations
            else min(
                offset
                for name, offset in identifiers.items()
                if "fallback" in name or "compat" in name
            )
        )

    return sorted(
        (
            (marker, _line_number_at(text, offset))
            for marker, offset in markers.items()
        ),
        key=lambda item: (item[1], item[0]),
    )


def _detect_application_version_file_markers(text: str) -> list[tuple[str, int]]:
    """Find behavioral client evidence, not just endpoint/header string markers."""

    identifiers = _normalized_identifier_locations(text)
    markers: dict[str, int] = {}
    route = APPLICATION_VERSION_ROUTE_SEGMENT_PATTERN.search(text)
    request_call = HTTP_REQUEST_CALL_PATTERN.search(text)
    if route is not None and request_call is not None:
        markers["application_version_request_construction"] = min(
            route.start(), request_call.start()
        )

    response_field_locations = {
        field: identifiers[field]
        for field in APPLICATION_VERSION_RESPONSE_FIELDS
        if field in identifiers
    }
    exact_keys = STRICT_OBJECT_KEYS_PATTERN.search(text)
    exact_rejection = STRICT_OBJECT_REJECTION_PATTERN.search(text)
    if (
        len(response_field_locations) == len(APPLICATION_VERSION_RESPONSE_FIELDS)
        and exact_keys is not None
        and exact_rejection is not None
    ):
        markers["strict_seven_field_response_parser"] = min(
            min(response_field_locations.values()),
            exact_keys.start(),
            exact_rejection.start(),
        )

    decision = DECISION_FLOW_PATTERN.search(text)
    if (
        decision is not None
        and {"update", "forcedupdate", "promptupdate", "stopupdate"}.issubset(
            response_field_locations
        )
    ):
        markers["application_version_decision"] = decision.start()

    return sorted(
        (
            (marker, _line_number_at(text, offset))
            for marker, offset in markers.items()
        ),
        key=lambda item: (item[1], item[0]),
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
    legacy_static_update_hits: list[dict[str, Any]] = []
    application_version_api_hits: list[dict[str, Any]] = []
    invalid_application_version_api_hits: list[dict[str, Any]] = []
    client_update_center_hits: list[dict[str, Any]] = []
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
            if "update.meetelf.com" in line or "/update-checks" in line:
                client_update_center_hits.append({"kind": evidence_kind, "line": line_number, "marker": "update_center_origin" if "update.meetelf.com" in line else "update_check_path", "path": relative_path})
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
            static_update_markers: set[str] = set()
            if STATIC_UPDATE_BASE_PATTERN.search(line):
                static_update_markers.add("static_update_base")
            if UPDATE_MANIFEST_PATTERN.search(line):
                static_update_markers.add("static_update_manifest")
            for marker in sorted(static_update_markers):
                legacy_static_update_hits.append(
                    {
                        "kind": evidence_kind,
                        "line": line_number,
                        "marker": marker,
                        "path": relative_path,
                    }
                )

            if APPLICATION_VERSION_DOUBLE_V1_PATTERN.search(line):
                invalid_application_version_api_hits.append(
                    {
                        "kind": evidence_kind,
                        "line": line_number,
                        "marker": "duplicate_v1_path",
                        "path": relative_path,
                    }
                )
            else:
                route_marker = None
                if APPLICATION_VERSION_CHECK_PATTERN.search(line):
                    route_marker = "version_check_path"
                elif APPLICATION_VERSION_ADS_SHOW_PATTERN.search(line):
                    route_marker = "ads_show_path"
                elif APPLICATION_VERSION_BASE_PATTERN.search(line):
                    route_marker = "application_version_base"
                if route_marker is not None:
                    application_version_api_hits.append(
                        {
                            "kind": evidence_kind,
                            "line": line_number,
                            "marker": route_marker,
                            "path": relative_path,
                        }
                    )
            for marker, pattern in APPLICATION_VERSION_HEADER_PATTERNS.items():
                if pattern.search(line):
                    application_version_api_hits.append(
                        {
                            "kind": evidence_kind,
                            "line": line_number,
                            "marker": marker,
                            "path": relative_path,
                        }
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

        for marker, line_number in _detect_legacy_static_file_markers(text):
            legacy_static_update_hits.append(
                {
                    "kind": evidence_kind,
                    "line": line_number,
                    "marker": marker,
                    "path": relative_path,
                }
            )
        for marker, line_number in _detect_application_version_file_markers(text):
            application_version_api_hits.append(
                {
                    "kind": evidence_kind,
                    "line": line_number,
                    "marker": marker,
                    "path": relative_path,
                }
            )

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
    legacy_static_update_hits = _deduplicate_and_sort_evidence(
        legacy_static_update_hits
    )
    application_version_api_hits = _deduplicate_and_sort_evidence(
        application_version_api_hits
    )
    client_update_center_hits = _deduplicate_and_sort_evidence(client_update_center_hits)
    invalid_application_version_api_hits = _deduplicate_and_sort_evidence(
        invalid_application_version_api_hits
    )
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

    runtime_static_update_hits = [
        hit for hit in legacy_static_update_hits if hit["kind"] == "runtime"
    ]
    if runtime_static_update_hits:
        legacy_update_status = "detected"
        legacy_update_removal_gate = "blocked"
    elif legacy_static_update_hits:
        legacy_update_status = "detected"
        legacy_update_removal_gate = "blocked" if scan_incomplete else "review"
    elif scan_incomplete:
        legacy_update_status = None
        legacy_update_removal_gate = "blocked"
    else:
        legacy_update_status = "not_found"
        legacy_update_removal_gate = "clear"

    runtime_application_hits = [
        hit for hit in application_version_api_hits if hit["kind"] == "runtime"
    ]
    runtime_invalid_application_hits = [
        hit
        for hit in invalid_application_version_api_hits
        if hit["kind"] == "runtime"
    ]
    runtime_application_markers = {
        hit["marker"] for hit in runtime_application_hits
    }
    application_markers_by_path: dict[str, set[str]] = {}
    for hit in runtime_application_hits:
        application_markers_by_path.setdefault(hit["path"], set()).add(
            hit["marker"]
        )
    authenticated_request_paths = {
        path
        for path, markers in application_markers_by_path.items()
        if {
            "application_version_request_construction",
            "x_app_key_header",
            "x_app_secret_header",
        }.issubset(markers)
    }
    strict_decision_paths = {
        path
        for path, markers in application_markers_by_path.items()
        if {
            "strict_seven_field_response_parser",
            "application_version_decision",
        }.issubset(markers)
    }
    has_behavioral_client_evidence = bool(
        authenticated_request_paths and strict_decision_paths
    )
    primitive_markers = {
        "application_version_base",
        "version_check_path",
        "ads_show_path",
        "x_app_key_header",
        "x_app_secret_header",
    }
    if runtime_invalid_application_hits:
        application_version_api_status = "invalid"
    elif scan_incomplete:
        # A skipped source/config file can contain either a second protocol or
        # the missing half of the new client. Do not certify a partial tree.
        application_version_api_status = "unknown"
    elif has_behavioral_client_evidence:
        application_version_api_status = "detected"
    elif runtime_application_hits:
        application_version_api_status = (
            "marker-only"
            if runtime_application_markers.issubset(primitive_markers)
            else "partial"
        )
    elif application_version_api_hits or invalid_application_version_api_hits:
        application_version_api_status = "non_runtime_only"
    else:
        application_version_api_status = "not_found"

    result = {
        "classification": classification,
        "app_id_candidates": app_id_candidates,
        "architecture_candidates": architecture_candidates,
        "application_version_api_hits": application_version_api_hits,
        "application_version_api_status": application_version_api_status,
        "client_update_center_hits": client_update_center_hits,
        "client_update_center_status": "unknown" if scan_incomplete else ("marker-only" if client_update_center_hits else "not_found"),
        "update_center_migration_gate": (
            "blocked" if scan_incomplete or runtime_static_update_hits or runtime_application_hits or runtime_invalid_application_hits
            else "review" if legacy_static_update_hits or application_version_api_hits or invalid_application_version_api_hits
            else "clear"
        ),
        "detected_app_ids": sorted(runtime_app_ids),
        "detected_architectures": [
            architecture
            for architecture in ARCHITECTURE_ORDER
            if architecture in configured_architectures
        ],
        "invalid_app_id_evidence": invalid_app_id_evidence,
        "invalid_application_version_api_hits": invalid_application_version_api_hits,
        "legacy_track_status": legacy_track_status,
        "legacy_static_update_hits": legacy_static_update_hits,
        "legacy_update_removal_gate": legacy_update_removal_gate,
        "migration_gate": migration_gate,
        "modern_track_hits": modern_track_hits,
        "non_runtime_hits": non_runtime_hits,
        "runtime_hits": runtime_hits,
        "scan_incomplete": scan_incomplete,
        "scan_version": 3,
        "scanned_files": scanned_files,
        "skipped_files": skipped_files,
        "update_manifest_hits": update_manifest_hits,
        "unresolved_app_id_evidence": unresolved_app_id_evidence,
    }
    if legacy_update_status is not None:
        result["legacy_update_status"] = legacy_update_status
    return result


def _link_or_reparse_kind(path: Path) -> str | None:
    """Classify links and Windows reparse points without requiring Python 3.12."""

    if path.is_symlink():
        return "symlink"
    is_junction = getattr(path, "is_junction", None)
    if callable(is_junction) and is_junction():
        return "junction"
    attributes = getattr(path.lstat(), "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    if attributes & reparse_flag:
        return "reparse"
    return None


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
            try:
                unsafe_kind = _link_or_reparse_kind(candidate)
            except OSError:
                skipped_files.append(
                    {
                        "path": candidate.relative_to(root).as_posix(),
                        "reason": "unreadable_directory",
                    }
                )
                continue
            if unsafe_kind is not None:
                skipped_files.append(
                    {
                        "path": candidate.relative_to(root).as_posix(),
                        "reason": f"{unsafe_kind}_directory",
                    }
                )
                continue
            kept_directories.append(name)
        directory_names[:] = kept_directories
        for file_name in sorted(file_names, key=str.casefold):
            path = Path(current_root) / file_name
            try:
                unsafe_kind = _link_or_reparse_kind(path)
            except OSError:
                skipped_files.append(
                    {
                        "path": path.relative_to(root).as_posix(),
                        "reason": "unreadable",
                    }
                )
                continue
            if unsafe_kind is not None:
                skipped_files.append(
                    {
                        "path": path.relative_to(root).as_posix(),
                        "reason": f"{unsafe_kind}_file",
                    }
                )
                continue
            if not _is_text_candidate(path):
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
