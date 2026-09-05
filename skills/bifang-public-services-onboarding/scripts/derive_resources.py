#!/usr/bin/env python3
"""Derive isolated Bifang resource names locally and deterministically."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable

from validate_profile import APP_ID_PATTERN, read_json_file, validate_profile


SUPPORTED_PLATFORMS = frozenset(("windows", "macos", "linux"))
READY_MANIFEST_PLATFORMS = frozenset(("windows", "macos"))


def derive_resources(
    app_id: str,
    platforms: Iterable[str] = (),
    *,
    cloudbase_origin: str | None = None,
) -> dict[str, Any]:
    """Return the complete collision-free resource mapping for an app id."""

    if not isinstance(app_id, str) or APP_ID_PATTERN.fullmatch(app_id) is None:
        raise ValueError(
            "app_id must be 1-50 lowercase letters, digits, or hyphens and "
            "must start and end with a letter or digit"
        )
    platform_list = sorted(set(platforms))
    for platform in platform_list:
        if platform not in SUPPORTED_PLATFORMS:
            raise ValueError(
                "platform must be one of: windows, macos, linux"
            )

    telemetry_route = f"/apps/{app_id}/v1/track"
    update_directory = f"/updates/{app_id}"
    update_manifests = {
        platform: f"{update_directory}/{platform}.json"
        for platform in platform_list
    }
    platform_gates = {
        platform: {
            "status": (
                "ready" if platform in READY_MANIFEST_PLATFORMS else "pending"
            ),
            "reason": (
                f"authoritative infrastructure generates and validates {platform}.json"
                if platform in READY_MANIFEST_PLATFORMS
                else f"authoritative infrastructure does not generate or validate {platform}.json"
            ),
        }
        for platform in platform_list
    }
    resources: dict[str, Any] = {
        "app_id": app_id,
        "collection_name": f"telemetry_{app_id.replace('-', '_')}",
        "function_name": f"telemetry-{app_id}",
        "platform_gates": platform_gates,
        "telemetry_route": telemetry_route,
        "update_directory": update_directory,
        "update_manifests": update_manifests,
    }

    if cloudbase_origin is not None:
        origin = cloudbase_origin.rstrip("/")
        resources.update(
            {
                "telemetry_endpoint": f"{origin}{telemetry_route}",
                "update_base_url": f"{origin}/updates",
                "update_manifest_urls": {
                    platform: f"{origin}{path}"
                    for platform, path in update_manifests.items()
                },
            }
        )
    return resources


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Derive per-app CloudBase resources without writing or deploying."
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("app_id", nargs="?", help="confirmed application id")
    source.add_argument(
        "--profile",
        type=Path,
        help="validated .bifang/public-services-profile.json",
    )
    parser.add_argument(
        "--platform",
        action="append",
        default=[],
        help="platform manifest to derive; repeat for more than one platform",
    )
    return parser.parse_args(argv)


def _load_profile(path: Path) -> dict[str, Any]:
    profile = read_json_file(path)
    parent = path.resolve().parent
    project_root = parent.parent if parent.name == ".bifang" else parent
    errors = validate_profile(profile, project_root=project_root)
    if errors:
        formatted = "\n".join(f"- {error}" for error in errors)
        raise ValueError(f"profile validation failed:\n{formatted}")
    if not isinstance(profile, dict):
        raise ValueError("profile must contain an object")
    return profile


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    try:
        if args.profile is not None:
            profile = _load_profile(args.profile)
            app_id = profile.get("app_id")
            if not isinstance(app_id, str):
                raise ValueError("profile does not yet contain a confirmed app_id")
            platforms = args.platform or profile.get("platforms", [])
            cloudbase_origin = profile.get("cloudbase_origin")
        else:
            app_id = args.app_id
            platforms = args.platform
            cloudbase_origin = None

        resources = derive_resources(
            app_id,
            platforms,
            cloudbase_origin=cloudbase_origin,
        )
    except (OSError, ValueError) as error:
        print(f"resource derivation failed: {error}", file=sys.stderr)
        return 1

    print(json.dumps(resources, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
