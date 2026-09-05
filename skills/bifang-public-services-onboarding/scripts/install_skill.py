#!/usr/bin/env python3
"""Safely install or update the Bifang public-services onboarding skill.

The source of truth is the skill directory containing this script.  The
destination is ``$CODEX_HOME/skills`` when CODEX_HOME is set, otherwise
``~/.codex/skills``.  Existing skills are only updated when their frontmatter
proves that they came from the same repository and are older than this source.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


SKILL_NAME = "bifang-public-services-onboarding"
SOURCE_REPOSITORY = "bifang-operations-assistant"
REQUIRED_METADATA = (
    "version",
    "infrastructure-version",
    "infrastructure-source-commit",
    "protocol-baseline-commit",
    "source-repository",
)
REQUIRED_FILES = (
    "SKILL.md",
    "agents/openai.yaml",
    "references/integration-contract.md",
    "references/cloudbase-gates.md",
    "references/framework-adapters.md",
    "references/public-services-profile.schema.json",
    "scripts/derive_resources.py",
    "scripts/install_skill.py",
    "scripts/scan_project.py",
    "scripts/validate_profile.py",
    "scripts/verify_sdk_distribution.py",
)
SEMVER_PATTERN = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
MAX_REQUIRED_TEXT_BYTES = 2 * 1024 * 1024


class InstallError(RuntimeError):
    """An expected safety or validation failure."""


def _read_required_utf8(path: Path, relative: str) -> str:
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise InstallError(f"cannot read required file {relative}: {error}") from error
    if len(raw) > MAX_REQUIRED_TEXT_BYTES:
        raise InstallError(
            f"required file {relative} exceeds {MAX_REQUIRED_TEXT_BYTES} bytes"
        )
    if b"\0" in raw:
        raise InstallError(f"required file {relative} must be UTF-8 text")
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise InstallError(f"required file {relative} must be UTF-8 text") from error


def _reject_duplicate_json_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise InstallError(f"duplicate JSON field: {key}")
        result[key] = value
    return result


def _decode_scalar(raw_value: str) -> str:
    value = raw_value.strip()
    if not value:
        raise InstallError("frontmatter values must not be empty")
    if value.startswith('"'):
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError as error:
            raise InstallError(f"invalid quoted frontmatter value: {error}") from error
        if not isinstance(decoded, str):
            raise InstallError("frontmatter metadata values must be strings")
        return decoded
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    if any(character in value for character in "{}[]#"):
        raise InstallError("complex YAML values are not supported in installation metadata")
    return value


def read_skill_metadata(skill_directory: Path) -> dict[str, str]:
    skill_md = skill_directory / "SKILL.md"
    try:
        content = skill_md.read_text(encoding="utf-8")
    except OSError as error:
        raise InstallError(f"cannot read {skill_md}: {error}") from error

    match = re.match(r"^---\r?\n(.*?)\r?\n---(?:\r?\n|$)", content, re.DOTALL)
    if not match:
        raise InstallError(f"{skill_md} has invalid YAML frontmatter")

    name: str | None = None
    metadata: dict[str, str] = {}
    in_metadata = False
    for line in match.group(1).splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line.startswith((" ", "\t")):
            in_metadata = line.strip() == "metadata:"
            if line.startswith("name:"):
                name = _decode_scalar(line.split(":", 1)[1])
            continue
        if in_metadata:
            item = re.match(r"^ {2}([a-z0-9-]+):\s*(.+?)\s*$", line)
            if item:
                metadata[item.group(1)] = _decode_scalar(item.group(2))

    if name != SKILL_NAME:
        raise InstallError(
            f"skill name must be {SKILL_NAME!r}; found {name!r} in {skill_md}"
        )
    missing = [key for key in REQUIRED_METADATA if key not in metadata]
    if missing:
        raise InstallError(
            f"{skill_md} is missing installation metadata: {', '.join(missing)}"
        )
    if metadata["source-repository"] != SOURCE_REPOSITORY:
        raise InstallError(
            "refusing a skill whose source-repository is not "
            f"{SOURCE_REPOSITORY!r}"
        )
    parse_semver(metadata["version"], "skill version")
    parse_semver(metadata["infrastructure-version"], "infrastructure version")
    for commit_key in (
        "infrastructure-source-commit",
        "protocol-baseline-commit",
    ):
        if not COMMIT_PATTERN.fullmatch(metadata[commit_key]):
            raise InstallError(f"{commit_key} must be a 40-character Git hash")
    return metadata


def parse_semver(value: str, label: str) -> tuple[int, int, int, tuple[object, ...] | None]:
    match = SEMVER_PATTERN.fullmatch(value)
    if not match:
        raise InstallError(f"{label} must be a complete SemVer value; found {value!r}")
    prerelease: tuple[object, ...] | None = None
    if match.group(4) is not None:
        prerelease = tuple(
            int(identifier) if identifier.isdigit() else identifier
            for identifier in match.group(4).split(".")
        )
    return int(match.group(1)), int(match.group(2)), int(match.group(3)), prerelease


def compare_semver(left: str, right: str) -> int:
    left_value = parse_semver(left, "version")
    right_value = parse_semver(right, "version")
    for left_part, right_part in zip(left_value[:3], right_value[:3]):
        if left_part != right_part:
            return -1 if left_part < right_part else 1
    left_pre = left_value[3]
    right_pre = right_value[3]
    if left_pre is None or right_pre is None:
        if left_pre is right_pre:
            return 0
        return 1 if left_pre is None else -1
    for index in range(max(len(left_pre), len(right_pre))):
        if index >= len(left_pre):
            return -1
        if index >= len(right_pre):
            return 1
        left_identifier = left_pre[index]
        right_identifier = right_pre[index]
        if left_identifier == right_identifier:
            continue
        if isinstance(left_identifier, int) and isinstance(right_identifier, str):
            return -1
        if isinstance(left_identifier, str) and isinstance(right_identifier, int):
            return 1
        return -1 if left_identifier < right_identifier else 1
    return 0


def _assert_no_symlinks(skill_directory: Path) -> None:
    if skill_directory.is_symlink():
        raise InstallError(f"skill source must not be a symbolic link: {skill_directory}")
    for path in skill_directory.rglob("*"):
        if path.is_symlink():
            raise InstallError(f"symbolic links are not allowed in the skill: {path}")


def validate_structure(skill_directory: Path) -> dict[str, str]:
    if not skill_directory.is_dir():
        raise InstallError(f"skill directory not found: {skill_directory}")
    _assert_no_symlinks(skill_directory)
    missing = [relative for relative in REQUIRED_FILES if not (skill_directory / relative).is_file()]
    if missing:
        raise InstallError(f"skill structure is incomplete: {', '.join(missing)}")
    required_text: dict[str, str] = {}
    for relative in REQUIRED_FILES:
        required_text[relative] = _read_required_utf8(
            skill_directory / relative, relative
        )
        if relative.endswith(".json"):
            try:
                parsed = json.loads(
                    required_text[relative],
                    object_pairs_hook=_reject_duplicate_json_keys,
                )
            except json.JSONDecodeError as error:
                raise InstallError(f"required JSON file {relative} is invalid: {error}") from error
            if not isinstance(parsed, dict):
                raise InstallError(f"required JSON file {relative} must contain an object")
    metadata = read_skill_metadata(skill_directory)
    openai_yaml = required_text["agents/openai.yaml"]
    if not re.search(
        r"(?m)^policy:\s*$[\s\S]*?^ {2}allow_implicit_invocation:\s*false\s*$",
        openai_yaml,
    ):
        raise InstallError("agents/openai.yaml must disable implicit invocation")
    return metadata


def _quick_validate_candidates(codex_home: Path) -> list[Path]:
    candidates: list[Path] = []
    explicit = os.environ.get("BIFANG_SKILL_QUICK_VALIDATE")
    if explicit:
        candidates.append(Path(explicit).expanduser())
    candidates.extend(
        [
            codex_home / "skills" / ".system" / "skill-creator" / "scripts" / "quick_validate.py",
            Path.home()
            / ".codex"
            / "skills"
            / ".system"
            / "skill-creator"
            / "scripts"
            / "quick_validate.py",
        ]
    )
    unique: list[Path] = []
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved not in unique:
            unique.append(resolved)
    return unique


def run_quick_validate_if_available(skill_directory: Path, codex_home: Path) -> str | None:
    validator = next(
        (candidate for candidate in _quick_validate_candidates(codex_home) if candidate.is_file()),
        None,
    )
    if validator is None:
        return None
    result = subprocess.run(
        [sys.executable, "-X", "utf8", "-B", str(validator), str(skill_directory)],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise InstallError(f"skill-creator quick_validate failed: {detail}")
    return str(validator)


def _tree_digest(skill_directory: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(skill_directory.rglob("*"), key=lambda item: item.as_posix()):
        if path.is_dir() or path.name.endswith(".pyc") or "__pycache__" in path.parts:
            continue
        if path.is_symlink():
            raise InstallError(f"symbolic links are not allowed in the skill: {path}")
        relative = path.relative_to(skill_directory).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        data = path.read_bytes()
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return digest.hexdigest()


def _ensure_direct_child(path: Path, parent: Path) -> None:
    resolved_path = path.resolve()
    resolved_parent = parent.resolve()
    if resolved_path.parent != resolved_parent:
        raise InstallError(f"refusing to modify path outside {resolved_parent}: {resolved_path}")


def _remove_directory(path: Path, parent: Path) -> None:
    if not path.exists():
        return
    _ensure_direct_child(path, parent)
    if path.is_symlink() or not path.is_dir():
        raise InstallError(f"refusing to recursively remove unexpected path: {path}")
    shutil.rmtree(path)


def _copy_source(source: Path, staged: Path) -> None:
    shutil.copytree(
        source,
        staged,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"),
    )


def install(source: Path, codex_home: Path) -> tuple[str, Path, str | None]:
    source = source.resolve()
    codex_home = codex_home.expanduser().resolve()
    incoming = validate_structure(source)

    skills_root = codex_home / "skills"
    destination = skills_root / SKILL_NAME
    _ensure_direct_child(destination, skills_root)

    action = "installed"
    if destination.exists():
        if destination.is_symlink() or not destination.is_dir():
            raise InstallError(f"refusing to overwrite unknown destination: {destination}")
        try:
            installed = validate_structure(destination)
        except InstallError as error:
            raise InstallError(
                f"refusing to overwrite an unknown same-name skill at {destination}: {error}"
            ) from error
        if installed["source-repository"] != incoming["source-repository"]:
            raise InstallError(f"refusing to overwrite a skill from another source: {destination}")
        if compare_semver(installed["version"], incoming["version"]) > 0:
            raise InstallError(
                "installed skill version is newer than this source; refusing a downgrade"
            )
        if compare_semver(
            installed["infrastructure-version"], incoming["infrastructure-version"]
        ) > 0:
            raise InstallError(
                "installed infrastructure version is newer than this source; refusing a downgrade"
            )
        if installed["version"] == incoming["version"]:
            if _tree_digest(destination) == _tree_digest(source):
                validator = run_quick_validate_if_available(destination, codex_home)
                return "already-current", destination, validator
            raise InstallError(
                "same skill version has different content; bump metadata.version before updating"
            )
        action = "updated"

    skills_root.mkdir(parents=True, exist_ok=True)
    stage_root = Path(
        tempfile.mkdtemp(prefix=f".{SKILL_NAME}.staging-", dir=skills_root)
    )
    staged = stage_root / SKILL_NAME
    backup = skills_root / f".{SKILL_NAME}.backup-{os.getpid()}"
    _ensure_direct_child(stage_root, skills_root)
    _ensure_direct_child(backup, skills_root)
    previous_moved = False
    promoted = False
    validator: str | None = None
    try:
        _copy_source(source, staged)
        validate_structure(staged)
        validator = run_quick_validate_if_available(staged, codex_home)

        if destination.exists():
            if backup.exists():
                raise InstallError(f"backup path already exists; refusing update: {backup}")
            destination.replace(backup)
            previous_moved = True
        staged.replace(destination)
        promoted = True
        validate_structure(destination)
        run_quick_validate_if_available(destination, codex_home)
        if previous_moved:
            validate_structure(backup)
            _remove_directory(backup, skills_root)
            previous_moved = False
        return action, destination, validator
    except Exception:
        if promoted and destination.exists():
            _remove_directory(destination, skills_root)
        if previous_moved and backup.exists():
            backup.replace(destination)
        raise
    finally:
        if backup.exists() and not previous_moved:
            _remove_directory(backup, skills_root)
        if stage_root.exists():
            _remove_directory(stage_root, skills_root)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Safely install or update the Bifang public-services onboarding skill."
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="skill source directory (defaults to the directory containing this script)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    codex_home_value = os.environ.get("CODEX_HOME")
    codex_home = (
        Path(codex_home_value) if codex_home_value else Path.home() / ".codex"
    )
    try:
        action, destination, validator = install(args.source, codex_home)
    except (InstallError, OSError) as error:
        print(f"[ERROR] {error}", file=sys.stderr)
        return 1
    validation_note = f"; quick_validate={validator}" if validator else ""
    print(f"[OK] {action}: {destination}{validation_note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
