import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  writeFile,
  chmod,
  realpath,
} from "node:fs/promises";
import { dirname, resolve, parse, join, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export function check(condition, code) {
  if (!condition) throw new Error(code);
}
export const privateRoot = () =>
  resolve(
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || join(homedir(), "AppData/Local")
      : join(homedir(), ".config"),
    "Bifang/PersonalCloudBase/intake",
  );
export async function noLinks(path) {
  let p = resolve(path);
  for (;;) {
    try {
      check(!(await lstat(p)).isSymbolicLink(), "UNSAFE_PATH");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (p === parse(p).root) break;
    p = dirname(p);
  }
}
function windowsAcl(path, mode) {
  const command =
    mode === "set"
      ? "$p=$env:BIFANG_PRIVATE_PATH;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);foreach($s in @($sid,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))){$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))};Set-Acl -LiteralPath $p -AclObject $a"
      : "$p=$env:BIFANG_PRIVATE_PATH;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$a=Get-Acl -LiteralPath $p;foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -notin @($sid,'S-1-5-18')){exit 3}}";
  try {
    const environment = { ...process.env, BIFANG_PRIVATE_PATH: path };
    // PowerShell 7's inherited module path can prevent Windows PowerShell 5
    // from loading its built-in ACL cmdlets.
    for (const key of Object.keys(environment)) {
      if (key.toUpperCase() === "PSMODULEPATH") delete environment[key];
    }
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop';" + command,
      ],
      {
        env: environment,
        stdio: "ignore",
        windowsHide: true,
      },
    );
  } catch {
    throw new Error("PRIVATE_PERMISSIONS_REQUIRED");
  }
}
export async function assertPrivate(path, { directory = false } = {}) {
  const p = resolve(path),
    base = privateRoot();
  check(p.startsWith(base + sep), "PRIVATE_INTAKE_PATH_REQUIRED");
  await noLinks(p);
  const s = await lstat(p);
  check(directory ? s.isDirectory() : s.isFile(), "PRIVATE_FILE_REQUIRED");
  if (!directory) check(s.nlink === 1, "UNSAFE_PATH");
  let parent = directory ? p : dirname(p);
  for (;;) {
    try {
      await lstat(join(parent, ".git"));
      throw new Error("PRIVATE_FILE_INSIDE_GIT");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (parent === parse(parent).root) break;
    parent = dirname(parent);
  }
  check(
    resolve(await realpath(p)).toLowerCase() === p.toLowerCase(),
    "UNSAFE_PATH",
  );
  if (process.platform === "win32") windowsAcl(p, "check");
  else
    check(
      (s.mode & 0o077) === 0 && s.uid === process.getuid(),
      "PRIVATE_PERMISSIONS_REQUIRED",
    );
  return p;
}
export async function createIntake(template, fileName = "resource-input.json") {
  check(
    ["resource-input.json", "integration-input.json"].includes(fileName),
    "PRIVATE_FILE_REQUIRED",
  );
  const folder = join(privateRoot(), randomUUID());
  await noLinks(folder);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") windowsAcl(folder, "set");
  else await chmod(folder, 0o700);
  await assertPrivate(folder, { directory: true });
  const file = join(folder, fileName);
  await writePrivate(file, template);
  return file;
}
export async function writePrivate(path, value) {
  return writePrivateBytes(path, JSON.stringify(value, null, 2) + "\n");
}
export async function writePrivateBytes(path, value) {
  await assertPrivate(dirname(path), { directory: true });
  await noLinks(path);
  await writeFile(path, value, {
    flag: "wx",
    mode: 0o600,
  });
  await assertPrivate(path);
}
export async function readPrivate(path) {
  await assertPrivate(dirname(path), { directory: true });
  await assertPrivate(path);
  const s = await lstat(path);
  check(s.size <= 131072, "INPUT_TOO_LARGE");
  try {
    return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/u, ""));
  } catch {
    throw new Error("INVALID_PRIVATE_JSON");
  }
}
