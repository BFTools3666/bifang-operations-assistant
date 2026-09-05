#!/usr/bin/env python3
"""Validate a resumable Bifang public-services profile without network access."""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import SplitResult, urlsplit


SCHEMA_PATH = (
    Path(__file__).resolve().parent.parent
    / "references"
    / "public-services-profile.schema.json"
)
MAX_PROFILE_BYTES = 1_048_576
APP_ID_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$")
TRACK_PATH_PATTERN = re.compile(
    r"^/apps/([a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?)/v1/track$"
)

SENSITIVE_KEY_MARKERS = (
    "secretid",
    "secretkey",
    "token",
    "cookie",
    "authorization",
    "credential",
    "password",
    "privatekey",
    "accesskey",
    "sessionkey",
    "useraccount",
    "accountid",
    "hardwareid",
    "hwid",
    "machineid",
    "deviceid",
    "数据库凭据",
    "用户账号",
    "硬件标识",
    "硬件id",
    "密钥",
    "令牌",
)
SENSITIVE_ASSIGNMENT_PATTERN = re.compile(
    r"(?i)(?:\b(?:secretid|secretkey|token|cookie|authorization|password|"
    r"private[ _-]?key|access[ _-]?key)\b|"
    r"(?:密钥|令牌|数据库凭据|用户账号|硬件(?:标识|id)))"
    r"\s*[:：=]\s*\S{4,}"
)
AUTHORIZATION_VALUE_PATTERN = re.compile(
    r"(?i)\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}"
)

PROFILE_COMPLETION_FIELDS = (
    "display_name",
    "app_id",
    "owner",
    "platforms",
    "architectures",
    "framework",
    "current_version",
    "version_source",
    "app_config_strategy",
    "startup_entry",
    "main_window_ready_hook",
    "external_link_handler",
    "exit_handler",
    "cloudbase_env_id",
    "cloudbase_origin",
    "telemetry_endpoint",
    "update_base_url",
    "infrastructure_version",
    "infrastructure_source_commit",
    "registration_status",
    "legacy_track_status",
    "deployment_gates",
    "privacy_notice",
    "current_stage",
)
STAGE_PREREQUISITE_GATES = {
    2: (
        "profile_complete",
        "app_id_confirmed",
        "uses_existing_free_environment",
        "free_environment_confirmed",
    ),
    3: ("app_registered",),
    4: ("cloudbase_config_reviewed",),
    5: ("online_e2e_passed",),
    6: ("client_integration_complete",),
    7: ("client_e2e_passed", "privacy_notice_ready"),
    8: (
        "migration_observation_complete",
        "legacy_usage_assessed",
        "owner_approved",
    ),
}


class DuplicateKeyError(ValueError):
    """Raised when a JSON object contains an ambiguous duplicate key."""


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyError(f"duplicate JSON field: {key}")
        result[key] = value
    return result


def read_json_file(path: Path, *, max_bytes: int = MAX_PROFILE_BYTES) -> Any:
    """Read bounded UTF-8 JSON while rejecting duplicate object keys."""

    raw = path.read_bytes()
    if len(raw) > max_bytes:
        raise ValueError(f"file exceeds {max_bytes} bytes")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError("file must be UTF-8 JSON") from error
    try:
        return json.loads(text, object_pairs_hook=_reject_duplicate_keys)
    except json.JSONDecodeError as error:
        raise ValueError(
            f"invalid JSON at line {error.lineno}, column {error.colno}"
        ) from error


def load_schema(path: Path = SCHEMA_PATH) -> dict[str, Any]:
    schema = read_json_file(path)
    if not isinstance(schema, dict):
        raise ValueError("profile schema must contain an object")
    return schema


def validate_profile(
    profile: Any,
    schema: dict[str, Any] | None = None,
    *,
    project_root: Path | None = None,
) -> list[str]:
    """Return deterministic validation errors; an empty list means valid."""

    active_schema = schema if schema is not None else load_schema()
    errors: list[str] = []
    _validate_schema_value(profile, active_schema, active_schema, "$", errors)
    _scan_sensitive_content(profile, "$", errors)
    if isinstance(profile, dict):
        _validate_profile_semantics(profile, errors, project_root)
    return sorted(set(errors))


def _validate_schema_value(
    value: Any,
    rule: dict[str, Any],
    root_schema: dict[str, Any],
    path: str,
    errors: list[str],
) -> None:
    if "$ref" in rule:
        reference = rule["$ref"]
        prefix = "#/$defs/"
        if not isinstance(reference, str) or not reference.startswith(prefix):
            errors.append(f"{path}: unsupported schema reference")
            return
        name = reference[len(prefix) :]
        target = root_schema.get("$defs", {}).get(name)
        if not isinstance(target, dict):
            errors.append(f"{path}: unresolved schema reference {reference}")
            return
        _validate_schema_value(value, target, root_schema, path, errors)
        return

    if "const" in rule and value != rule["const"]:
        errors.append(f"{path}: must equal {rule['const']!r}")
        return
    if "enum" in rule and value not in rule["enum"]:
        choices = ", ".join(repr(item) for item in rule["enum"])
        errors.append(f"{path}: must be one of {choices}")
        return

    expected_type = rule.get("type")
    if expected_type is not None and not _matches_json_type(value, expected_type):
        errors.append(f"{path}: must be {expected_type}")
        return

    if isinstance(value, dict):
        properties = rule.get("properties", {})
        required = rule.get("required", [])
        for name in required:
            if name not in value:
                errors.append(f"{path}.{name}: required field is missing")
        if rule.get("additionalProperties") is False:
            for name in sorted(set(value) - set(properties)):
                errors.append(f"{path}.{name}: unknown field is not allowed")
        for name in sorted(set(value) & set(properties)):
            _validate_schema_value(
                value[name],
                properties[name],
                root_schema,
                f"{path}.{name}",
                errors,
            )
        return

    if isinstance(value, list):
        if len(value) < rule.get("minItems", 0):
            errors.append(
                f"{path}: must contain at least {rule['minItems']} item(s)"
            )
        if "maxItems" in rule and len(value) > rule["maxItems"]:
            errors.append(
                f"{path}: must contain at most {rule['maxItems']} item(s)"
            )
        if rule.get("uniqueItems"):
            serialized = [
                json.dumps(item, ensure_ascii=False, sort_keys=True) for item in value
            ]
            if len(serialized) != len(set(serialized)):
                errors.append(f"{path}: items must be unique")
        item_rule = rule.get("items")
        if isinstance(item_rule, dict):
            for index, item in enumerate(value):
                _validate_schema_value(
                    item, item_rule, root_schema, f"{path}[{index}]", errors
                )
        return

    if isinstance(value, str):
        length = len(value)
        if length < rule.get("minLength", 0):
            errors.append(
                f"{path}: must contain at least {rule['minLength']} character(s)"
            )
        if "maxLength" in rule and length > rule["maxLength"]:
            errors.append(
                f"{path}: must contain at most {rule['maxLength']} character(s)"
            )
        if "pattern" in rule and re.search(rule["pattern"], value) is None:
            errors.append(f"{path}: does not match the required format")
        return

    if expected_type == "integer":
        if "minimum" in rule and value < rule["minimum"]:
            errors.append(f"{path}: must be at least {rule['minimum']}")
        if "maximum" in rule and value > rule["maximum"]:
            errors.append(f"{path}: must be at most {rule['maximum']}")


def _matches_json_type(value: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "null":
        return value is None
    return False


def _normalize_key(key: str) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", key.casefold())


def _scan_sensitive_content(value: Any, path: str, errors: list[str]) -> None:
    if isinstance(value, dict):
        for key in sorted(value):
            child_path = f"{path}.{key}"
            normalized = _normalize_key(key)
            if any(marker in normalized for marker in SENSITIVE_KEY_MARKERS):
                errors.append(f"{child_path}: sensitive field is forbidden")
            _scan_sensitive_content(value[key], child_path, errors)
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _scan_sensitive_content(item, f"{path}[{index}]", errors)
        return
    if not isinstance(value, str):
        return
    if SENSITIVE_ASSIGNMENT_PATTERN.search(value) or AUTHORIZATION_VALUE_PATTERN.search(
        value
    ):
        errors.append(f"{path}: appears to contain a sensitive value")
        return
    if value.lower().startswith(("http://", "https://")):
        try:
            parsed = urlsplit(value)
        except ValueError:
            return
        if parsed.username is not None or parsed.password is not None:
            errors.append(f"{path}: URL user information is forbidden")


def _validate_profile_semantics(
    profile: dict[str, Any], errors: list[str], project_root: Path | None
) -> None:
    app_id = profile.get("app_id")
    if isinstance(app_id, str) and not APP_ID_PATTERN.fullmatch(app_id):
        # The schema emits the user-facing format error. Avoid a duplicate here.
        app_id = None

    parsed_urls: dict[str, SplitResult] = {}
    for field in ("cloudbase_origin", "telemetry_endpoint", "update_base_url"):
        value = profile.get(field)
        if isinstance(value, str):
            parsed = _validate_https_url(value, f"$.{field}", errors)
            if parsed is not None:
                parsed_urls[field] = parsed
                hostname = (parsed.hostname or "").casefold().rstrip(".")
                if not hostname.endswith(".app.tcloudbase.com"):
                    errors.append(
                        f"$.{field}: the zero-cost path requires a confirmed "
                        "CloudBase default HTTPS gateway domain ending "
                        ".app.tcloudbase.com; custom or example domains are blocked"
                    )

    origin = parsed_urls.get("cloudbase_origin")
    if origin is not None and origin.path not in ("", "/"):
        errors.append("$.cloudbase_origin: must not contain a path")

    telemetry = parsed_urls.get("telemetry_endpoint")
    if telemetry is not None:
        match = TRACK_PATH_PATTERN.fullmatch(telemetry.path)
        if match is None:
            errors.append(
                "$.telemetry_endpoint: path must be /apps/<app_id>/v1/track"
            )
        elif app_id is None:
            errors.append("$.telemetry_endpoint: app_id is required for consistency")
        elif match.group(1) != app_id:
            errors.append("$.telemetry_endpoint: path does not match app_id")

    update_base = parsed_urls.get("update_base_url")
    if update_base is not None and update_base.path != "/updates":
        errors.append("$.update_base_url: path must be exactly /updates")

    if origin is not None:
        for field in ("telemetry_endpoint", "update_base_url"):
            candidate = parsed_urls.get(field)
            if candidate is not None and _url_origin(candidate) != _url_origin(origin):
                errors.append(f"$.{field}: origin does not match cloudbase_origin")

    gates = profile.get("deployment_gates")
    if not isinstance(gates, dict):
        gates = {}
    registration_status = profile.get("registration_status")
    app_registered = gates.get("app_registered")
    if registration_status in ("registered", "verified") and app_registered is False:
        errors.append(
            "$.deployment_gates.app_registered: conflicts with registration_status"
        )
    if registration_status == "not_registered" and app_registered is True:
        errors.append(
            "$.deployment_gates.app_registered: conflicts with registration_status"
        )

    if gates.get("profile_complete") is True:
        _require_complete_profile(profile, errors)

    _validate_gate_dependencies(gates, errors)

    sdk_distribution = profile.get("sdk_distribution")
    if isinstance(sdk_distribution, dict):
        source = sdk_distribution.get("source")
        if isinstance(source, str) and not _is_safe_relative_sdk_source(source):
            errors.append(
                "$.sdk_distribution.source: must be a fixed, project-relative "
                "source or versioned package spec, not an absolute or escaping path"
            )
        verification_evidence = sdk_distribution.get("verification_evidence")
        if isinstance(verification_evidence, str) and not _is_safe_relative_sdk_source(
            verification_evidence
        ):
            errors.append(
                "$.sdk_distribution.verification_evidence: must be a fixed, "
                "project-relative path"
            )
        if sdk_distribution.get("kind") == "private_package":
            for field in ("verification_evidence", "immutable_reference"):
                if field not in sdk_distribution:
                    errors.append(
                        f"$.sdk_distribution.{field}: required for private_package"
                    )
            version = sdk_distribution.get("version")
            if isinstance(source, str) and isinstance(version, str):
                expected_source = f"@bifang/telemetry-update-sdk@{version}"
                if source != expected_source:
                    errors.append(
                        "$.sdk_distribution.source: private_package must use the "
                        f"exact immutable package spec {expected_source}"
                    )

    stage = profile.get("current_stage")
    if isinstance(stage, int) and not isinstance(stage, bool) and 1 <= stage <= 8:
        if stage >= 2:
            _require_complete_profile(profile, errors)
        for completed_stage in range(2, stage + 1):
            for gate in STAGE_PREREQUISITE_GATES[completed_stage]:
                if gates.get(gate) is not True:
                    errors.append(
                        f"$.deployment_gates.{gate}: must be true before stage {stage}"
                    )
        if stage >= 3 and registration_status not in ("registered", "verified"):
            errors.append(
                "$.registration_status: must be registered or verified before stage 3"
            )
        framework = profile.get("framework")
        requires_node_sdk = (
            stage >= 5
            and isinstance(framework, str)
            and re.search(
                r"(?i)(?:^|[^a-z0-9])"
                r"(?:node(?:\.?js)?|electron(?:\.?js)?|nw(?:\.?js)?)"
                r"(?:$|[^a-z0-9])",
                framework,
            )
            is not None
        )
        if requires_node_sdk:
            if gates.get("sdk_distribution_ready") is not True:
                errors.append(
                    "$.deployment_gates.sdk_distribution_ready: must be true "
                    "before Node/Electron stage 5"
                )
            if not isinstance(sdk_distribution, dict):
                errors.append(
                    "$.sdk_distribution: required before Node/Electron stage 5"
                )
            if "sdk_artifact_sha256" not in profile:
                errors.append(
                    "$.sdk_artifact_sha256: required before Node/Electron stage 5"
                )
            if (
                gates.get("sdk_distribution_ready") is True
                and isinstance(sdk_distribution, dict)
                and isinstance(profile.get("sdk_artifact_sha256"), str)
            ):
                if project_root is None:
                    errors.append(
                        "$.deployment_gates.sdk_distribution_ready: offline artifact "
                        "verification requires the target project root"
                    )
                else:
                    try:
                        from verify_sdk_distribution import (
                            SDKDistributionVerificationError,
                            verify_sdk_distribution,
                        )

                        verify_sdk_distribution(profile, project_root)
                    except (SDKDistributionVerificationError, OSError, ValueError) as error:
                        errors.append(
                            "$.deployment_gates.sdk_distribution_ready: offline SDK "
                            f"distribution verification failed: {error}"
                        )


def _validate_https_url(
    value: str, path: str, errors: list[str]
) -> SplitResult | None:
    if any(character.isspace() or ord(character) < 32 for character in value):
        errors.append(f"{path}: must be a clean HTTPS URL")
        return None
    if "\\" in value:
        errors.append(f"{path}: backslashes are not allowed in a URL")
        return None
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        errors.append(f"{path}: must be a valid HTTPS URL")
        return None
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        errors.append(
            f"{path}: must be HTTPS without credentials, query, or fragment"
        )
        return None
    normalized_host = hostname.casefold().rstrip(".")
    if normalized_host in ("localhost",) or normalized_host.endswith(
        (".localhost", ".local", ".internal")
    ):
        errors.append(f"{path}: must use a public HTTPS host")
        return None
    try:
        address = ipaddress.ip_address(normalized_host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        errors.append(f"{path}: must use a public HTTPS host")
        return None
    if port not in (None, 443):
        errors.append(f"{path}: only the standard HTTPS port is allowed")
        return None
    return parsed


def _url_origin(parsed: SplitResult) -> tuple[str, str, int]:
    return (parsed.scheme, (parsed.hostname or "").casefold().rstrip("."), 443)


def _require_complete_profile(
    profile: dict[str, Any], errors: list[str]
) -> None:
    for field in PROFILE_COMPLETION_FIELDS:
        if field not in profile:
            errors.append(f"$.{field}: required for a complete onboarding profile")
    if "product_purpose" not in profile and "product_key" not in profile:
        errors.append(
            "$.product_purpose: product_purpose or product_key is required for a complete onboarding profile"
        )


def _validate_gate_dependencies(gates: dict[str, Any], errors: list[str]) -> None:
    dependencies = {
        "cloudbase_config_reviewed": ("app_registered",),
        "function_deployed": ("cloudbase_config_reviewed",),
        "collection_created": ("cloudbase_config_reviewed",),
        "collection_admin_only": ("collection_created",),
        "route_deployed": ("function_deployed",),
        "update_manifests_deployed": ("cloudbase_config_reviewed",),
        "online_e2e_passed": (
            "function_deployed",
            "collection_created",
            "collection_admin_only",
            "route_deployed",
            "update_manifests_deployed",
        ),
        "client_e2e_passed": ("client_integration_complete",),
        "migration_observation_complete": ("client_e2e_passed",),
    }
    for gate, prerequisites in dependencies.items():
        if gates.get(gate) is not True:
            continue
        for prerequisite in prerequisites:
            if gates.get(prerequisite) is not True:
                errors.append(
                    f"$.deployment_gates.{prerequisite}: must be true when {gate} is true"
                )


def _is_safe_relative_sdk_source(source: str) -> bool:
    if (
        source.startswith(("/", "\\", "~"))
        or re.match(r"^[A-Za-z]:[\\/]", source)
        or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", source)
        or re.search(r"%[^%]+%|\$\{[^}]+\}|\$\([^)]*\)|\$[A-Za-z_]", source)
        or any(character in source for character in "*?[]")
        or "\0" in source
    ):
        return False
    normalized = source.replace("\\", "/")
    return all(part != ".." for part in normalized.split("/"))


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate .bifang/public-services-profile.json locally."
    )
    parser.add_argument("profile", type=Path, help="path to the profile JSON file")
    return parser.parse_args(argv)


def _default_project_root(profile_path: Path) -> Path:
    parent = profile_path.resolve().parent
    return parent.parent if parent.name == ".bifang" else parent


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    try:
        profile = read_json_file(args.profile)
        schema = load_schema()
    except (OSError, ValueError) as error:
        print(f"profile could not be read: {error}", file=sys.stderr)
        return 2

    errors = validate_profile(
        profile,
        schema,
        project_root=_default_project_root(args.profile),
    )
    if errors:
        print("profile validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print("profile is valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
