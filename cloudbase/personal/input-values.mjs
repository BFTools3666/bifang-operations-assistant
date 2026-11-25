import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import {
  assertPrivate,
  check,
  readPrivate,
  writePrivate,
} from "./private-files.mjs";

// Only customer input documents are editable. Evidence, plans and receipts stay immutable.
const resourceKeys = [
  /^cloudbase\.(env_id|region|http_origin)$/,
  /^credentials\.(Token|expires_at)$/,
  /^resources\.(update|telemetry|dashboard)$/,
  /^applications\[\d+\]\.(app_id|display_name)$/,
  /^applications\[\d+\]\.release_streams\[\d+\]\.(platform|architecture|channel|code)$/,
];
const integrationKeys = [
  /^services\.(update|telemetry)$/,
  /^app\.(app_id|display_name)$/,
  /^targets\[\d+\]\.(platform|arch|channel|app_version|update_code|runtime_credential_id)$/,
  /^update\.(base_url|credentials_file)$/,
  /^update\.credentials\[\d+\]\.(credential_id|app_id|role|app_key|app_secret|codes\[0\])$/,
  /^telemetry\.url$/,
];
const releaseKeys = [
  /^release\.(name|codeVersion|downloadUrl|promptContent|updateContent|forcedUpdate|promptUpdate|stopUpdate|updateCriteria|versionCriteria)$/,
];
function allowedKeys(name) {
  if (name === "resource-input.json") return resourceKeys;
  if (name === "integration-input.json") return integrationKeys;
  if (/^[\w-]+-release-handoff\.json$/.test(name))
    return [...releaseKeys, /^expected_scenario$/];
  if (/^release-settings-[\da-f-]+\.json$/i.test(name)) return releaseKeys;
  throw new Error("EDITABLE_INPUT_REQUIRED");
}
function updateField(document, key, value) {
  const parts = key.replace(/\[(\d+)\]/g, ".$1").split(".");
  let parent = document;
  for (const [i, part] of parts.entries()) {
    const isIndex = /^\d+$/.test(part);
    check(
      parent && typeof parent === "object" && Array.isArray(parent) === isIndex,
      "INPUT_SHAPE_CHANGED",
    );
    if (isIndex)
      check(
        String(Number(part)) === part && Number(part) <= parent.length,
        "INVALID_INPUT_INDEX",
      );
    if (i === parts.length - 1) {
      if (value === null) delete parent[part];
      else parent[part] = value;
    } else {
      if (!Object.hasOwn(parent, part))
        parent[part] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      parent = parent[part];
    }
  }
}
export async function saveInputValues(file, values) {
  const keys = allowedKeys(basename(file));
  check(
    values && typeof values === "object" && !Array.isArray(values),
    "EXPECTED_KEY_VALUE_OBJECT",
  );
  const entries = Object.entries(values);
  check(entries.length > 0, "EMPTY_INPUT");
  for (const [key, value] of entries) {
    check(
      keys.some((rule) => rule.test(key)),
      "FIELD_NOT_EDITABLE",
    );
    const flag =
      key.startsWith("services.") ||
      /^release\.(forcedUpdate|promptUpdate|stopUpdate)$/.test(key);
    const remove =
      value === null &&
      ["release.updateCriteria", "release.versionCriteria"].includes(key) &&
      Object.hasOwn(values, "release.updateCriteria") &&
      values["release.updateCriteria"] === null &&
      Object.hasOwn(values, "release.versionCriteria") &&
      values["release.versionCriteria"] === null;
    check(
      remove || typeof value === (flag ? "boolean" : "string"),
      "INVALID_FIELD_TYPE",
    );
  }
  const target = await assertPrivate(file);
  await assertPrivate(dirname(target), { directory: true });
  const lockPath = target + ".edit-lock";
  const lock = await open(lockPath, "wx", 0o600);
  const temp = join(dirname(target), ".input-" + randomUUID() + ".tmp");
  try {
    const previous = await readPrivate(target);
    const updated = structuredClone(previous);
    for (const [key, value] of entries) updateField(updated, key, value);
    if (!isDeepStrictEqual(previous, updated)) {
      check(
        Buffer.byteLength(JSON.stringify(updated, null, 2) + "\n") <= 131072,
        "INPUT_TOO_LARGE",
      );
      await writePrivate(temp, updated);
      check(
        isDeepStrictEqual(await readPrivate(target), previous),
        "INPUT_CHANGED",
      );
      await rename(temp, target);
    }
    check(
      isDeepStrictEqual(await readPrivate(target), updated),
      "INPUT_READBACK_MISMATCH",
    );
    return {
      status: "saved-and-read-back",
      fields: entries.map(([key]) => key),
    };
  } finally {
    try {
      await unlink(temp);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    check(
      process.argv.length === 4 && process.argv[2] === "--file",
      "EXPECTED_INPUT_FILE",
    );
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      check(size <= 131072, "INPUT_TOO_LARGE");
      chunks.push(chunk);
    }
    const values = JSON.parse(
      Buffer.concat(chunks)
        .toString("utf8")
        .replace(/^\uFEFF/, ""),
    );
    console.log(JSON.stringify(await saveInputValues(process.argv[3], values)));
  } catch (error) {
    console.error(
      /^[A-Z_]+$/.test(error.message)
        ? error.message
        : error.code === "EEXIST"
          ? "INPUT_BUSY"
          : "INPUT_SAVE_FAILED",
    );
    process.exitCode = 1;
  }
}
