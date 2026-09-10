#!/usr/bin/env python3
"""Verify an SDK distribution locally, deterministically, and without writes."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tarfile
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any, Mapping


# Support both direct execution and import-by-path in callers that do not put this
# scripts directory on sys.path. validate_profile imports this module only lazily
# after its own definitions are loaded, so this dependency does not form a cycle.
try:
    from validate_profile import (  # type: ignore[import-not-found]
        MAX_PROFILE_BYTES,
        _scan_sensitive_content,
        read_json_file,
    )
except ModuleNotFoundError as error:
    if error.name != "validate_profile":
        raise
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from validate_profile import (  # type: ignore[no-redef]
        MAX_PROFILE_BYTES,
        _scan_sensitive_content,
        read_json_file,
    )


PACKAGE_NAME = "@bifang/telemetry-update-sdk"
SDK_COMPATIBLE_VERSION = "3.0.0"
SUPPORTED_KINDS = frozenset(
    ("versioned_tarball", "private_package", "repository_copy", "workspace")
)
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
SEMVER_PATTERN = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)
IMMUTABLE_REFERENCE_PATTERN = re.compile(
    r"^(?:sha256:[0-9a-f]{64}|git:[0-9a-f]{40})$"
)
TREE_HASH_ALGORITHM = "bifang-relative-content-v1"
_TREE_HASH_DOMAIN = b"bifang-relative-content-v1\x00"
_CHUNK_SIZE = 1024 * 1024
_REQUIRED_RUNTIME_EXPORTS = frozenset(
    (
        "ApplicationVersionChecker",
        "buildApplicationVersionCheckUrl",
        "decideApplicationVersion",
        "isCanonicalApplicationVersionBaseUrl",
        "parseApplicationVersionData",
        "runApplicationVersionHostHooks",
    )
)
_REQUIRED_DECLARATION_EXPORTS = frozenset(
    (
        *_REQUIRED_RUNTIME_EXPORTS,
        "ApplicationVersionCheckerConfig",
        "ApplicationVersionData",
        "ApplicationVersionDecision",
        "ApplicationVersionHostHooks",
    )
)
_STATIC_MANIFEST_PUBLIC_MARKERS = frozenset(
    (
        "UpdateChecker",
        "UpdateCheckerConfig",
        "UpdateConfig",
        "UpdateDecision",
        "UpdateFetch",
        "UpdateFetchResponse",
        "UpdateHostHooks",
        "NoUpdateDecision",
        "NoUpdateReason",
        "OptionalUpdateDecision",
        "RequiredUpdateDecision",
        "AvailableUpdateDecision",
        "UPDATE_SCHEMA_VERSION",
        "DEFAULT_UPDATE_TIMEOUT_MS",
        "buildUpdateUrl",
        "decideUpdate",
        "parseUpdateConfig",
        "rolloutBucket",
        "runUpdateHostHooks",
        "isRfc3339Date",
        "isSha256",
        "latest_version",
        "min_supported_version",
        "release_notes_url",
        "force_update",
        "rollout",
    )
)
_TYPESCRIPT_COMPILER_VERSION = "5.9.3"
_TYPESCRIPT_COMPILER_SHA256 = (
    "3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675"
)
_TYPESCRIPT_AST_TIMEOUT_SECONDS = 5
_TYPESCRIPT_AST_INSPECTOR = r"""
"use strict";
const fs = require("node:fs");
const ts = require(process.argv[1]);

function modifiers(node) {
  return ts.canHaveModifiers(node) ? ts.getModifiers(node) || [] : [];
}

function hasModifier(node, kind) {
  return modifiers(node).some((modifier) => modifier.kind === kind);
}

function bindingNames(name, output) {
  if (ts.isIdentifier(name)) {
    output.add(name.text);
    return;
  }
  for (const element of name.elements || []) {
    if (!ts.isOmittedExpression(element)) bindingNames(element.name, output);
  }
}

function declarationNames(statement) {
  const names = new Set();
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      bindingNames(declaration.name, names);
    }
  } else if (statement.name && ts.isIdentifier(statement.name)) {
    names.add(statement.name.text);
  }
  return names;
}

function collectIdentifiers(node, output) {
  if (ts.isIdentifier(node)) output.add(node.text);
  if (ts.isStringLiteral(node)) output.add(node.text);
  ts.forEachChild(node, (child) => collectIdentifiers(child, output));
}

function analyze(source, fileName, scriptKind, includePublicIdentifiers) {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKind,
  );
  if (file.parseDiagnostics.length !== 0) throw new Error("source syntax is invalid");

  const declarations = new Map();
  for (const statement of file.statements) {
    for (const name of declarationNames(statement)) declarations.set(name, statement);
  }

  const exportedNames = new Set();
  const publicIdentifiers = new Set();
  let unresolvedExport = false;
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) {
        unresolvedExport = true;
        continue;
      }
      for (const element of statement.exportClause.elements) {
        if (ts.isIdentifier(element.name)) {
          exportedNames.add(element.name.text);
          publicIdentifiers.add(element.name.text);
        }
        const local = element.propertyName || element.name;
        if (ts.isIdentifier(local)) {
          publicIdentifiers.add(local.text);
          if (!statement.moduleSpecifier && declarations.has(local.text)) {
            collectIdentifiers(declarations.get(local.text), publicIdentifiers);
          }
        }
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      exportedNames.add("default");
      publicIdentifiers.add("default");
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;

    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      exportedNames.add("default");
    } else {
      for (const name of declarationNames(statement)) exportedNames.add(name);
    }
    if (includePublicIdentifiers) collectIdentifiers(statement, publicIdentifiers);
  }

  if (exportedNames.size > 2048 || publicIdentifiers.size > 8192) {
    throw new Error("public API is too large to inspect");
  }
  return {
    exportedNames: [...exportedNames].sort(),
    publicIdentifiers: [...publicIdentifiers].sort(),
    unresolvedExport,
  };
}

const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const result = {
  compilerVersion: ts.version,
  runtime: analyze(payload.runtime, "index.js", ts.ScriptKind.JS, false),
  declarations: analyze(payload.declarations, "index.d.ts", ts.ScriptKind.TS, true),
};
process.stdout.write(JSON.stringify(result));
"""


class SDKDistributionVerificationError(ValueError):
    """Raised when SDK distribution evidence is missing, unsafe, or inconsistent."""


def sha256_file(path: Path) -> str:
    """Return the SHA-256 of a regular, non-symlink file."""

    candidate = Path(path)
    _reject_link(candidate, "artifact")
    try:
        file_stat = candidate.stat()
    except FileNotFoundError as error:
        raise SDKDistributionVerificationError("artifact does not exist") from error
    except OSError as error:
        raise SDKDistributionVerificationError("artifact could not be inspected") from error
    if not stat.S_ISREG(file_stat.st_mode):
        raise SDKDistributionVerificationError("artifact must be a regular file")

    digest = hashlib.sha256()
    try:
        with candidate.open("rb") as stream:
            while chunk := stream.read(_CHUNK_SIZE):
                digest.update(chunk)
    except OSError as error:
        raise SDKDistributionVerificationError("artifact could not be read") from error
    return digest.hexdigest()


def stable_tree_sha256(root: Path) -> str:
    """Hash a directory with the ``bifang-relative-content-v1`` algorithm.

    Files are sorted by their POSIX relative path.  The digest begins with the
    algorithm name and NUL byte, then for each ordinary file receives the UTF-8
    path length (unsigned 8-byte big-endian), path bytes, content length in the
    same format, and file bytes.  Directory names and filesystem metadata are
    intentionally excluded.  Symlinks and other special entries are rejected.
    """

    directory = Path(root)
    _reject_link(directory, "SDK directory")
    try:
        root_stat = directory.stat()
    except FileNotFoundError as error:
        raise SDKDistributionVerificationError("SDK directory does not exist") from error
    except OSError as error:
        raise SDKDistributionVerificationError(
            "SDK directory could not be inspected"
        ) from error
    if not stat.S_ISDIR(root_stat.st_mode):
        raise SDKDistributionVerificationError("SDK distribution must be a directory")

    files = _collect_tree_files(directory)
    digest = hashlib.sha256(_TREE_HASH_DOMAIN)
    for relative_path, file_path, size in files:
        encoded_path = relative_path.encode("utf-8")
        digest.update(len(encoded_path).to_bytes(8, "big"))
        digest.update(encoded_path)
        digest.update(size.to_bytes(8, "big"))
        bytes_read = 0
        try:
            with file_path.open("rb") as stream:
                while chunk := stream.read(_CHUNK_SIZE):
                    bytes_read += len(chunk)
                    digest.update(chunk)
        except OSError as error:
            raise SDKDistributionVerificationError(
                f"SDK file could not be read: {relative_path}"
            ) from error
        if bytes_read != size:
            raise SDKDistributionVerificationError(
                f"SDK file changed while hashing: {relative_path}"
            )
    return digest.hexdigest()


def verify_sdk_distribution(
    profile: Mapping[str, Any], project_root: Path
) -> dict[str, Any]:
    """Verify one profile's SDK distribution and return JSON-safe evidence."""

    if not isinstance(profile, Mapping):
        raise SDKDistributionVerificationError("profile must contain a JSON object")
    root = _prepare_project_root(Path(project_root))
    distribution = profile.get("sdk_distribution")
    if not isinstance(distribution, Mapping):
        raise SDKDistributionVerificationError(
            "$.sdk_distribution must contain an object"
        )

    kind = distribution.get("kind")
    source = distribution.get("source")
    version = distribution.get("version")
    expected_hash = profile.get("sdk_artifact_sha256")
    if not isinstance(kind, str) or kind not in SUPPORTED_KINDS:
        raise SDKDistributionVerificationError(
            "$.sdk_distribution.kind must be one of: private_package, "
            "repository_copy, versioned_tarball, workspace"
        )
    if not isinstance(source, str) or not source:
        raise SDKDistributionVerificationError(
            "$.sdk_distribution.source must be a non-empty string"
        )
    if not isinstance(version, str) or SEMVER_PATTERN.fullmatch(version) is None:
        raise SDKDistributionVerificationError(
            "$.sdk_distribution.version must be a SemVer"
        )
    if version != SDK_COMPATIBLE_VERSION:
        raise SDKDistributionVerificationError(
            "$.sdk_distribution.version must be exactly "
            f"{SDK_COMPATIBLE_VERSION} for the current Node/Electron SDK contract"
        )
    if (
        not isinstance(expected_hash, str)
        or SHA256_PATTERN.fullmatch(expected_hash) is None
    ):
        raise SDKDistributionVerificationError(
            "$.sdk_artifact_sha256 must be 64 lowercase hexadecimal characters"
        )

    if kind == "private_package":
        return _verify_private_package(
            distribution,
            source,
            version,
            expected_hash,
            root,
            profile.get("owner"),
        )

    artifact_path, normalized_source = resolve_project_relative_path(
        root, source, field="$.sdk_distribution.source"
    )
    if kind == "versioned_tarball":
        if artifact_path.suffix != ".tgz":
            raise SDKDistributionVerificationError(
                "versioned_tarball source must end with .tgz"
            )
        actual_hash = sha256_file(artifact_path)
        _require_matching_hash(actual_hash, expected_hash)
        package_json = _read_npm_tgz_package_json(artifact_path)
        verification_mode = "npm_tgz"
        hash_algorithm = "sha256-file-v1"
    else:
        package_json = _read_directory_package_json(artifact_path)
        actual_hash = stable_tree_sha256(artifact_path)
        _require_matching_hash(actual_hash, expected_hash)
        verification_mode = "stable_tree_hash"
        hash_algorithm = TREE_HASH_ALGORITHM

    _validate_package_identity(package_json, version)
    if kind == "versioned_tarball":
        _validate_npm_tgz_public_api(artifact_path, package_json)
    else:
        _validate_directory_public_api(artifact_path, package_json)
    return {
        "artifact_sha256": actual_hash,
        "distribution_kind": kind,
        "hash_algorithm": hash_algorithm,
        "package": PACKAGE_NAME,
        "source": normalized_source,
        "verification_mode": verification_mode,
        "artifact_bytes_verified": True,
        "artifact_contract_verified": True,
        "verification_status": "artifact_verified",
        "version": version,
    }


def verify_profile_file(
    profile_path: Path, project_root: Path | None = None
) -> dict[str, Any]:
    """Read and verify a profile, applying the documented project-root default."""

    path = Path(profile_path)
    try:
        profile = read_json_file(path)
    except FileNotFoundError as error:
        raise SDKDistributionVerificationError("profile does not exist") from error
    except OSError as error:
        raise SDKDistributionVerificationError("profile could not be read") from error
    except ValueError as error:
        raise SDKDistributionVerificationError(f"profile is invalid: {error}") from error
    if not isinstance(profile, dict):
        raise SDKDistributionVerificationError("profile must contain a JSON object")

    selected_root = (
        Path(project_root)
        if project_root is not None
        else default_project_root(path)
    )
    return verify_sdk_distribution(profile, selected_root)


def default_project_root(profile_path: Path) -> Path:
    """Return the profile's project root without requiring a conventional filename."""

    parent = Path(profile_path).parent
    return parent.parent if parent.name == ".bifang" else parent


def resolve_project_relative_path(
    project_root: Path, source: str, *, field: str
) -> tuple[Path, str]:
    """Resolve a fixed project-relative path and reject links and escapes."""

    normalized = _validate_relative_path_text(source, field)
    parts = PurePosixPath(normalized).parts
    candidate = Path(project_root).joinpath(*parts)
    _reject_link_components(Path(project_root), parts, field)
    try:
        resolved = candidate.resolve(strict=True)
    except FileNotFoundError as error:
        raise SDKDistributionVerificationError(f"{field} does not exist") from error
    except OSError as error:
        raise SDKDistributionVerificationError(f"{field} could not be resolved") from error
    try:
        resolved.relative_to(Path(project_root).resolve(strict=True))
    except ValueError as error:
        raise SDKDistributionVerificationError(
            f"{field} escapes the project root"
        ) from error
    return resolved, normalized


def _prepare_project_root(project_root: Path) -> Path:
    _reject_link(project_root, "project root")
    try:
        resolved = project_root.resolve(strict=True)
    except FileNotFoundError as error:
        raise SDKDistributionVerificationError("project root does not exist") from error
    except OSError as error:
        raise SDKDistributionVerificationError("project root could not be resolved") from error
    try:
        root_stat = resolved.stat()
    except OSError as error:
        raise SDKDistributionVerificationError("project root could not be inspected") from error
    if not stat.S_ISDIR(root_stat.st_mode):
        raise SDKDistributionVerificationError("project root must be a directory")
    return resolved


def _validate_relative_path_text(source: str, field: str) -> str:
    if not source or "\x00" in source or any(ord(char) < 32 for char in source):
        raise SDKDistributionVerificationError(f"{field} is not a safe relative path")
    if (
        source.startswith(("/", "\\", "~"))
        or re.match(r"^[A-Za-z]:", source)
        or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", source)
        or re.search(r"%[^%]+%|\$\{[^}]+\}|\$\([^)]*\)|\$[A-Za-z_]", source)
        or ":" in source
        or any(character in source for character in "*?[]")
    ):
        raise SDKDistributionVerificationError(
            f"{field} must be a fixed project-relative path without environment variables"
        )
    normalized = source.replace("\\", "/")
    parts = PurePosixPath(normalized).parts
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise SDKDistributionVerificationError(
            f"{field} must not contain empty, current, or parent path segments"
        )
    return PurePosixPath(*parts).as_posix()


def _reject_link_components(root: Path, parts: tuple[str, ...], field: str) -> None:
    current = root
    for part in parts:
        current = current / part
        if current.is_symlink() or _is_junction(current):
            raise SDKDistributionVerificationError(f"{field} must not use a symlink")
        if not current.exists():
            raise SDKDistributionVerificationError(f"{field} does not exist")


def _reject_link(path: Path, label: str) -> None:
    if path.is_symlink() or _is_junction(path):
        raise SDKDistributionVerificationError(f"{label} must not be a symlink")


def _is_junction(path: Path) -> bool:
    checker = getattr(path, "is_junction", None)
    return bool(checker is not None and checker())


def _collect_tree_files(root: Path) -> list[tuple[str, Path, int]]:
    collected: list[tuple[str, Path, int]] = []
    pending = [root]
    while pending:
        directory = pending.pop()
        try:
            entries = sorted(os.scandir(directory), key=lambda item: item.name)
        except OSError as error:
            relative = directory.relative_to(root).as_posix() or "."
            raise SDKDistributionVerificationError(
                f"SDK directory could not be read: {relative}"
            ) from error
        for entry in entries:
            entry_path = Path(entry.path)
            relative = entry_path.relative_to(root).as_posix()
            try:
                entry_stat = entry.stat(follow_symlinks=False)
            except OSError as error:
                raise SDKDistributionVerificationError(
                    f"SDK entry could not be inspected: {relative}"
                ) from error
            if entry.is_symlink() or _is_junction(entry_path):
                raise SDKDistributionVerificationError(
                    f"SDK directory contains a symlink: {relative}"
                )
            if stat.S_ISDIR(entry_stat.st_mode):
                pending.append(entry_path)
            elif stat.S_ISREG(entry_stat.st_mode):
                collected.append((relative, entry_path, entry_stat.st_size))
            else:
                raise SDKDistributionVerificationError(
                    f"SDK directory contains a non-regular entry: {relative}"
                )
    return sorted(collected, key=lambda item: item[0])


def _read_directory_package_json(root: Path) -> dict[str, Any]:
    _reject_link(root, "SDK directory")
    try:
        root_stat = root.stat()
    except FileNotFoundError as error:
        raise SDKDistributionVerificationError("SDK directory does not exist") from error
    except OSError as error:
        raise SDKDistributionVerificationError(
            "SDK directory could not be inspected"
        ) from error
    if not stat.S_ISDIR(root_stat.st_mode):
        raise SDKDistributionVerificationError("SDK distribution must be a directory")
    package_path = root / "package.json"
    _reject_link(package_path, "SDK package.json")
    try:
        package_json = read_json_file(package_path)
    except FileNotFoundError as error:
        raise SDKDistributionVerificationError(
            "SDK directory must contain root package.json"
        ) from error
    except OSError as error:
        raise SDKDistributionVerificationError("SDK package.json could not be read") from error
    except ValueError as error:
        raise SDKDistributionVerificationError(
            f"SDK package.json is invalid: {error}"
        ) from error
    if not isinstance(package_json, dict):
        raise SDKDistributionVerificationError("SDK package.json must contain an object")
    return package_json


def _read_npm_tgz_package_json(path: Path) -> dict[str, Any]:
    try:
        with path.open("rb") as raw:
            if raw.read(2) != b"\x1f\x8b":
                raise SDKDistributionVerificationError(
                    "versioned_tarball must be a gzip-compressed npm tgz"
                )
        with tarfile.open(path, mode="r:gz") as archive:
            members = archive.getmembers()
            seen_names: set[str] = set()
            package_member: tarfile.TarInfo | None = None
            for member in members:
                name = member.name
                member_path = PurePosixPath(name)
                member_parts = member_path.parts
                if (
                    not name
                    or "\\" in name
                    or member_path.is_absolute()
                    or not member_parts
                    or ".." in member_parts
                    or member_parts[0] != "package"
                ):
                    raise SDKDistributionVerificationError(
                        "npm tgz contains an unsafe or non-package member"
                    )
                normalized = member_path.as_posix()
                if normalized in seen_names:
                    raise SDKDistributionVerificationError(
                        f"npm tgz contains a duplicate member: {normalized}"
                    )
                seen_names.add(normalized)
                if member.issym() or member.islnk():
                    raise SDKDistributionVerificationError(
                        f"npm tgz contains a link: {normalized}"
                    )
                if not (member.isdir() or member.isfile()):
                    raise SDKDistributionVerificationError(
                        f"npm tgz contains a non-regular member: {normalized}"
                    )
                if normalized == "package/package.json":
                    if not member.isfile():
                        raise SDKDistributionVerificationError(
                            "npm tgz package/package.json must be a regular file"
                        )
                    package_member = member
            if package_member is None:
                raise SDKDistributionVerificationError(
                    "npm tgz must contain package/package.json"
                )
            if package_member.size > MAX_PROFILE_BYTES:
                raise SDKDistributionVerificationError(
                    f"npm package.json exceeds {MAX_PROFILE_BYTES} bytes"
                )
            extracted = archive.extractfile(package_member)
            if extracted is None:
                raise SDKDistributionVerificationError(
                    "npm tgz package/package.json could not be read"
                )
            raw_json = extracted.read(MAX_PROFILE_BYTES + 1)
    except SDKDistributionVerificationError:
        raise
    except (OSError, EOFError, tarfile.TarError) as error:
        raise SDKDistributionVerificationError("versioned_tarball is not a valid npm tgz") from error

    return _decode_json_object(raw_json, "npm package/package.json")


def _decode_json_object(raw: bytes, label: str) -> dict[str, Any]:
    if len(raw) > MAX_PROFILE_BYTES:
        raise SDKDistributionVerificationError(
            f"{label} exceeds {MAX_PROFILE_BYTES} bytes"
        )
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise SDKDistributionVerificationError(f"{label} must be UTF-8 JSON") from error

    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise SDKDistributionVerificationError(
                    f"{label} contains duplicate JSON field: {key}"
                )
            result[key] = value
        return result

    try:
        value = json.loads(text, object_pairs_hook=reject_duplicates)
    except SDKDistributionVerificationError:
        raise
    except json.JSONDecodeError as error:
        raise SDKDistributionVerificationError(
            f"{label} is invalid JSON at line {error.lineno}, column {error.colno}"
        ) from error
    if not isinstance(value, dict):
        raise SDKDistributionVerificationError(f"{label} must contain an object")
    return value


def _validate_package_identity(package_json: Mapping[str, Any], version: str) -> None:
    if package_json.get("name") != PACKAGE_NAME:
        raise SDKDistributionVerificationError(
            f"package name must be exactly {PACKAGE_NAME}"
        )
    if package_json.get("version") != version:
        raise SDKDistributionVerificationError(
            "package version does not match $.sdk_distribution.version"
        )


def _validate_directory_public_api(
    root: Path, package_json: Mapping[str, Any]
) -> None:
    runtime_entry, declaration_entry = _package_public_entries(package_json)
    runtime_text = _read_directory_text_entry(
        root, runtime_entry, "SDK public runtime entry"
    )
    declaration_text = _read_directory_text_entry(
        root, declaration_entry, "SDK public declaration entry"
    )
    _validate_public_api(runtime_text, declaration_text)


def _validate_npm_tgz_public_api(
    path: Path, package_json: Mapping[str, Any]
) -> None:
    runtime_entry, declaration_entry = _package_public_entries(package_json)
    expected_members = {
        f"package/{runtime_entry}": "SDK public runtime entry",
        f"package/{declaration_entry}": "SDK public declaration entry",
    }
    try:
        with tarfile.open(path, mode="r:gz") as archive:
            members = {
                PurePosixPath(member.name).as_posix(): member
                for member in archive.getmembers()
            }
            loaded: dict[str, str] = {}
            for member_name, label in expected_members.items():
                member = members.get(member_name)
                if member is None or not member.isfile():
                    raise SDKDistributionVerificationError(
                        f"npm tgz is missing {label}: {member_name}"
                    )
                loaded[label] = _read_tar_text_member(archive, member, label)
    except SDKDistributionVerificationError:
        raise
    except (OSError, EOFError, tarfile.TarError) as error:
        raise SDKDistributionVerificationError(
            "versioned_tarball public API could not be inspected"
        ) from error

    _validate_public_api(
        loaded["SDK public runtime entry"],
        loaded["SDK public declaration entry"],
    )


def _package_public_entries(package_json: Mapping[str, Any]) -> tuple[str, str]:
    exports = package_json.get("exports")
    root_export: Any = None
    if exports is not None:
        if not isinstance(exports, Mapping) or "." not in exports:
            raise SDKDistributionVerificationError(
                "package exports must expose the package root"
            )
        root_export = exports.get(".")

    runtime_value: Any = None
    declaration_value: Any = None
    if isinstance(root_export, str):
        runtime_value = root_export
    elif isinstance(root_export, Mapping):
        runtime_value = root_export.get("import")
        declaration_value = root_export.get("types")
    elif root_export is not None:
        raise SDKDistributionVerificationError(
            "package root export must be a string or condition object"
        )

    if runtime_value is None:
        runtime_value = package_json.get("module", package_json.get("main"))
    if declaration_value is None:
        declaration_value = package_json.get("types", package_json.get("typings"))

    runtime_entry = _normalize_package_entry(
        runtime_value,
        "package public runtime entry",
        (".js", ".mjs", ".cjs"),
    )
    declaration_entry = _normalize_package_entry(
        declaration_value,
        "package public declaration entry",
        (".d.ts", ".d.mts", ".d.cts"),
    )
    return runtime_entry, declaration_entry


def _normalize_package_entry(
    value: Any, label: str, allowed_suffixes: tuple[str, ...]
) -> str:
    if not isinstance(value, str) or not value.startswith("./"):
        raise SDKDistributionVerificationError(
            f"{label} must be an explicit package-relative path"
        )
    normalized = _validate_relative_path_text(value[2:], label)
    if not normalized.endswith(allowed_suffixes):
        raise SDKDistributionVerificationError(
            f"{label} must use one of: {', '.join(allowed_suffixes)}"
        )
    return normalized


def _read_directory_text_entry(root: Path, relative: str, label: str) -> str:
    path, _normalized = resolve_project_relative_path(root, relative, field=label)
    _reject_link(path, label)
    try:
        file_stat = path.stat()
    except OSError as error:
        raise SDKDistributionVerificationError(f"{label} could not be inspected") from error
    if not stat.S_ISREG(file_stat.st_mode):
        raise SDKDistributionVerificationError(f"{label} must be a regular file")
    if file_stat.st_size > MAX_PROFILE_BYTES:
        raise SDKDistributionVerificationError(
            f"{label} exceeds {MAX_PROFILE_BYTES} bytes"
        )
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise SDKDistributionVerificationError(f"{label} could not be read") from error
    return _decode_utf8_text(raw, label)


def _read_tar_text_member(
    archive: tarfile.TarFile, member: tarfile.TarInfo, label: str
) -> str:
    if member.size > MAX_PROFILE_BYTES:
        raise SDKDistributionVerificationError(
            f"{label} exceeds {MAX_PROFILE_BYTES} bytes"
        )
    extracted = archive.extractfile(member)
    if extracted is None:
        raise SDKDistributionVerificationError(f"{label} could not be read")
    raw = extracted.read(MAX_PROFILE_BYTES + 1)
    return _decode_utf8_text(raw, label)


def _decode_utf8_text(raw: bytes, label: str) -> str:
    if len(raw) > MAX_PROFILE_BYTES:
        raise SDKDistributionVerificationError(
            f"{label} exceeds {MAX_PROFILE_BYTES} bytes"
        )
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise SDKDistributionVerificationError(f"{label} must be UTF-8") from error


def _validate_public_api(runtime_text: str, declaration_text: str) -> None:
    inspection = _inspect_public_api_ast(runtime_text, declaration_text)
    runtime = inspection["runtime"]
    declarations = inspection["declarations"]
    if runtime["unresolved_export"] or declarations["unresolved_export"]:
        raise SDKDistributionVerificationError(
            "SDK public entries contain an export-star or namespace export that "
            "cannot be verified from the package entry"
        )
    runtime_exports = runtime["exported_names"]
    declaration_exports = declarations["exported_names"]

    missing_runtime = sorted(_REQUIRED_RUNTIME_EXPORTS - runtime_exports)
    if missing_runtime:
        raise SDKDistributionVerificationError(
            "SDK public runtime entry is missing application-version exports: "
            + ", ".join(missing_runtime)
        )
    missing_declarations = sorted(
        _REQUIRED_DECLARATION_EXPORTS - declaration_exports
    )
    if missing_declarations:
        raise SDKDistributionVerificationError(
            "SDK public declaration entry is missing application-version declarations: "
            + ", ".join(missing_declarations)
        )

    legacy_markers = sorted(
        _STATIC_MANIFEST_PUBLIC_MARKERS
        & (runtime_exports | declarations["public_identifiers"])
    )
    if legacy_markers:
        raise SDKDistributionVerificationError(
            "SDK public surface still exposes obsolete static-manifest API: "
            + ", ".join(legacy_markers)
        )


def _inspect_public_api_ast(
    runtime_text: str, declaration_text: str
) -> dict[str, dict[str, set[str] | bool]]:
    if not isinstance(runtime_text, str) or not isinstance(declaration_text, str):
        raise SDKDistributionVerificationError("SDK public entries must contain text")
    if (
        len(runtime_text.encode("utf-8")) > MAX_PROFILE_BYTES
        or len(declaration_text.encode("utf-8")) > MAX_PROFILE_BYTES
    ):
        raise SDKDistributionVerificationError(
            "SDK public entries exceed the static inspection limit"
        )

    compiler_path = _find_trusted_typescript_compiler()
    payload = json.dumps(
        {"runtime": runtime_text, "declarations": declaration_text},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    environment = dict(os.environ)
    environment.pop("NODE_OPTIONS", None)
    environment.pop("NODE_PATH", None)
    try:
        completed = subprocess.run(
            [
                "node",
                "--max-old-space-size=96",
                "-e",
                _TYPESCRIPT_AST_INSPECTOR,
                str(compiler_path),
            ],
            input=payload,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="strict",
            timeout=_TYPESCRIPT_AST_TIMEOUT_SECONDS,
            check=False,
            env=environment,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired as error:
        raise SDKDistributionVerificationError(
            "SDK public API static inspection timed out"
        ) from error
    except (OSError, UnicodeError) as error:
        raise SDKDistributionVerificationError(
            "SDK public API static inspector could not run"
        ) from error
    if completed.returncode != 0 or len(completed.stdout) > 256 * 1024:
        raise SDKDistributionVerificationError(
            "SDK public API could not be parsed safely"
        )
    try:
        parsed = json.loads(completed.stdout)
    except (json.JSONDecodeError, TypeError) as error:
        raise SDKDistributionVerificationError(
            "SDK public API inspector returned an invalid result"
        ) from error
    if (
        not isinstance(parsed, dict)
        or parsed.get("compilerVersion") != _TYPESCRIPT_COMPILER_VERSION
    ):
        raise SDKDistributionVerificationError(
            "SDK public API inspector used an unexpected compiler"
        )

    normalized: dict[str, dict[str, set[str] | bool]] = {}
    for label in ("runtime", "declarations"):
        value = parsed.get(label)
        if not isinstance(value, dict) or set(value) != {
            "exportedNames",
            "publicIdentifiers",
            "unresolvedExport",
        }:
            raise SDKDistributionVerificationError(
                "SDK public API inspector returned an invalid result"
            )
        exported_names = value.get("exportedNames")
        public_identifiers = value.get("publicIdentifiers")
        unresolved_export = value.get("unresolvedExport")
        if (
            not isinstance(exported_names, list)
            or not isinstance(public_identifiers, list)
            or not isinstance(unresolved_export, bool)
            or any(not isinstance(name, str) for name in exported_names)
            or any(not isinstance(name, str) for name in public_identifiers)
            or len(set(exported_names)) != len(exported_names)
            or len(set(public_identifiers)) != len(public_identifiers)
        ):
            raise SDKDistributionVerificationError(
                "SDK public API inspector returned an invalid result"
            )
        normalized[label] = {
            "exported_names": set(exported_names),
            "public_identifiers": set(public_identifiers),
            "unresolved_export": unresolved_export,
        }
    return normalized


def _find_trusted_typescript_compiler() -> Path:
    roots: list[Path] = []
    for start in (Path(__file__).resolve().parent, Path.cwd().resolve()):
        roots.extend((start, *start.parents))
    seen: set[Path] = set()
    for root in roots:
        candidate = root / "node_modules" / "typescript" / "lib" / "typescript.js"
        if candidate in seen:
            continue
        seen.add(candidate)
        try:
            if not candidate.is_file() or candidate.is_symlink():
                continue
            if sha256_file(candidate) != _TYPESCRIPT_COMPILER_SHA256:
                continue
            package_json = read_json_file(candidate.parent.parent / "package.json")
        except (OSError, ValueError, SDKDistributionVerificationError):
            continue
        if (
            isinstance(package_json, dict)
            and package_json.get("name") == "typescript"
            and package_json.get("version") == _TYPESCRIPT_COMPILER_VERSION
        ):
            return candidate
    raise SDKDistributionVerificationError(
        "trusted TypeScript 5.9.3 parser is unavailable; install the locked "
        "workspace dependencies before verifying the SDK public API"
    )


def _require_matching_hash(actual: str, expected: str) -> None:
    if actual != expected:
        raise SDKDistributionVerificationError(
            f"artifact SHA-256 mismatch: expected {expected}, calculated {actual}"
        )


def _verify_private_package(
    distribution: Mapping[str, Any],
    source: str,
    version: str,
    expected_hash: str,
    project_root: Path,
    profile_owner: Any,
) -> dict[str, Any]:
    expected_source = f"{PACKAGE_NAME}@{version}"
    if source != expected_source:
        raise SDKDistributionVerificationError(
            f"private_package source must be exactly {expected_source}"
        )
    evidence_source = distribution.get("verification_evidence")
    immutable_reference = distribution.get("immutable_reference")
    if not isinstance(evidence_source, str) or not evidence_source:
        raise SDKDistributionVerificationError(
            "$.sdk_distribution.verification_evidence must be a project-relative JSON path"
        )
    if (
        not isinstance(immutable_reference, str)
        or IMMUTABLE_REFERENCE_PATTERN.fullmatch(immutable_reference) is None
    ):
        raise SDKDistributionVerificationError(
            "$.sdk_distribution.immutable_reference must be sha256:<64hex> or git:<40hex>"
        )
    if immutable_reference.startswith("sha256:") and immutable_reference[7:] != expected_hash:
        raise SDKDistributionVerificationError(
            "sha256 immutable_reference must match $.sdk_artifact_sha256"
        )

    evidence_path, normalized_evidence = resolve_project_relative_path(
        project_root,
        evidence_source,
        field="$.sdk_distribution.verification_evidence",
    )
    if evidence_path.suffix != ".json":
        raise SDKDistributionVerificationError(
            "$.sdk_distribution.verification_evidence must name a JSON file"
        )
    _reject_link(evidence_path, "verification evidence")
    try:
        evidence = read_json_file(evidence_path)
    except OSError as error:
        raise SDKDistributionVerificationError(
            "verification evidence could not be read"
        ) from error
    except ValueError as error:
        raise SDKDistributionVerificationError(
            f"verification evidence is invalid: {error}"
        ) from error
    if not isinstance(evidence, dict):
        raise SDKDistributionVerificationError(
            "verification evidence must contain a JSON object"
        )
    sensitive_errors: list[str] = []
    _scan_sensitive_content(evidence, "$", sensitive_errors)
    if sensitive_errors:
        raise SDKDistributionVerificationError(
            "verification evidence must be non-sensitive: "
            + "; ".join(sorted(set(sensitive_errors)))
        )

    expected_fields = {
        "package": PACKAGE_NAME,
        "version": version,
        "artifact_sha256": expected_hash,
        "immutable_reference": immutable_reference,
    }
    for field, expected in expected_fields.items():
        if evidence.get(field) != expected:
            raise SDKDistributionVerificationError(
                f"verification evidence {field} does not match the profile"
            )

    verified_by = evidence.get("verified_by")
    if not isinstance(verified_by, str) or not verified_by.strip():
        raise SDKDistributionVerificationError(
            "verification evidence verified_by must name the responsible reviewer"
        )
    if isinstance(profile_owner, str) and verified_by != profile_owner:
        raise SDKDistributionVerificationError(
            "verification evidence verified_by must match the profile owner"
        )
    verified_at = evidence.get("verified_at")
    if not isinstance(verified_at, str):
        raise SDKDistributionVerificationError(
            "verification evidence verified_at must be an ISO timestamp with timezone"
        )
    try:
        parsed_verified_at = datetime.fromisoformat(
            verified_at[:-1] + "+00:00" if verified_at.endswith("Z") else verified_at
        )
    except ValueError as error:
        raise SDKDistributionVerificationError(
            "verification evidence verified_at must be an ISO timestamp with timezone"
        ) from error
    if parsed_verified_at.tzinfo is None or parsed_verified_at.utcoffset() is None:
        raise SDKDistributionVerificationError(
            "verification evidence verified_at must include a timezone"
        )

    return {
        "artifact_sha256": expected_hash,
        "artifact_bytes_verified": False,
        "artifact_contract_verified": False,
        "distribution_kind": "private_package",
        "immutable_reference": immutable_reference,
        "package": PACKAGE_NAME,
        "source": source,
        "verification_evidence": normalized_evidence,
        "verification_mode": "manual_evidence",
        "verification_status": "manual_evidence_verified",
        "verified_at": verified_at,
        "verified_by": verified_by,
        "version": version,
    }


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Verify a Bifang SDK distribution locally without network access."
    )
    parser.add_argument("profile", type=Path, help="path to the profile JSON file")
    parser.add_argument(
        "--project-root",
        type=Path,
        help=(
            "project root; defaults to the parent of .bifang when the profile is "
            "inside .bifang, otherwise the profile parent"
        ),
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    try:
        result = verify_profile_file(args.profile, args.project_root)
    except SDKDistributionVerificationError as error:
        print(f"SDK distribution verification failed: {error}", file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
