import { inflateRawSync } from "node:zlib";
import { check } from "./private-files.mjs";

// SCF can repackage the uploaded sources with installed dependencies.
function directory(zip) {
  const start = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  check(
    start >= 0 && start + 22 + zip.readUInt16LE(start + 20) === zip.length,
    "UNSUPPORTED_DEPLOYED_ZIP",
  );
  const count = zip.readUInt16LE(start + 10);
  let offset = zip.readUInt32LE(start + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    check(zip.readUInt32LE(offset) === 0x02014b50, "INVALID_DEPLOYED_ZIP");
    const len = zip.readUInt16LE(offset + 28),
      name = zip
        .toString("utf8", offset + 46, offset + 46 + len)
        .replace(/^\.\//, "");
    check(
      !entries.has(name) &&
        !name.includes("\\") &&
        !name.split("/").includes("..") &&
        !name.startsWith("/"),
      "AMBIGUOUS_DEPLOYED_ZIP",
    );
    entries.set(name, {
      method: zip.readUInt16LE(offset + 10),
      size: zip.readUInt32LE(offset + 24),
      packed: zip.readUInt32LE(offset + 20),
      local: zip.readUInt32LE(offset + 42),
      type: zip.readUInt32LE(offset + 38) >>> 28,
    });
    offset +=
      46 + len + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  check(offset === start, "INVALID_DEPLOYED_ZIP");
  return entries;
}
function contents(zip, entry) {
  const { local, method, size, packed, type } = entry;
  check(
    (type === 0 || type === 8) &&
      size <= 1000000 &&
      zip.readUInt32LE(local) === 0x04034b50 &&
      [0, 8].includes(method),
    "UNSUPPORTED_SOURCE_ENTRY",
  );
  const pos =
    local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const bytes = zip.subarray(pos, pos + packed);
  return method === 0
    ? bytes
    : inflateRawSync(bytes, { maxOutputLength: Math.max(1, size) });
}
export function matchesUploadedSource(upload, actual) {
  const expected = directory(upload),
    found = directory(actual);
  for (const [name, original] of expected) {
    const entry = found.get(name);
    if (
      !entry ||
      entry.size !== original.size ||
      !contents(upload, original).equals(contents(actual, entry))
    )
      return false;
  }
  return [...found.keys()].every(
    (name) =>
      expected.has(name) ||
      name.endsWith("/") ||
      name.startsWith("node_modules/") ||
      name === "package-lock.json",
  );
}
