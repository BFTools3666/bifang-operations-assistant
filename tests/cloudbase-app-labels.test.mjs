import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  checkAppLabels,
  listAppLabels,
  setAppLabel,
  validateAppLabelCoverage,
  validateObservedAppLabels,
} from "../cloudbase/app-labels.mjs";
import {
  createCloudBaseConfig,
  deriveAppResources,
} from "../cloudbase/generate-cloudbaserc.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const toolPath = fileURLToPath(
  new URL("../cloudbase/app-labels.mjs", import.meta.url),
);
const registryUrl = new URL("../cloudbase/apps.json", import.meta.url);
const labelsUrl = new URL(
  "../cloudbase/functions/operations-dashboard/src/app-labels.json",
  import.meta.url,
);
const observedAppIds = [
  "bifang-screen-recorder",
  "bifang-mouse-clicker",
  "bifang-tools",
  "bifang-ai-usage-collector",
  "bifang-vm-sync-agentless",
  "bifang-lan-file-transfer",
  "bifang-codex-skins",
  "bifang-app-launcher",
  "bifang-multi-local-proxy",
  "bifang-browser-sync",
  "bifang-browser-multi-instance",
  "bifang-multi-instance-display",
  "bifang-app-network-accelerator",
  "bifang-content-production-assistant",
  "bifang-window-layout",
  "bifang-multi-instance-display-plus",
];

function fixtureRegistry() {
  return {
    schema_version: 3,
    apps: [
      {
        app_id: "first-tool",
        release_streams: [
          {
            platform: "windows",
            architecture: "x64",
            channel: "stable",
            code: "first-tool-windows-x64",
          },
        ],
      },
    ],
  };
}

async function createFixture(t, labels = { "first-tool": "第一款工具" }) {
  const directory = await mkdtemp(join(tmpdir(), "bifang-app-labels-"));
  t.after(async () => {
    const target = resolve(directory);
    assert.ok(
      target.startsWith(`${resolve(tmpdir())}${sep}bifang-app-labels-`),
    );
    await rm(target, { recursive: true, force: true });
  });
  const registry = fixtureRegistry();
  const options = {
    registryFile: join(directory, "apps.json"),
    labelsFile: join(directory, "app-labels.json"),
  };
  const configFile = join(directory, "cloudbaserc.example.json");
  await Promise.all([
    writeFile(options.registryFile, `${JSON.stringify(registry, null, 2)}\n`),
    writeFile(options.labelsFile, `${JSON.stringify(labels, null, 2)}\n`),
    writeFile(
      configFile,
      `${JSON.stringify(createCloudBaseConfig(registry), null, 2)}\n`,
    ),
  ]);
  return { options, configFile };
}

function runCli(args, options) {
  return spawnSync(
    process.execPath,
    [
      toolPath,
      ...args,
      "--labels-file",
      options.labelsFile,
      "--registry-file",
      options.registryFile,
    ],
    { cwd: repositoryRoot, encoding: "utf8", windowsHide: true },
  );
}

test("onboarding name handoff checks exact Profile identity and Chinese name without writes", async (t) => {
  const { options, configFile } = await createFixture(t, {
    "first-tool": "第一款工具",
    "metadata-only": "额外工具",
  });
  const profileFile = join(dirname(options.registryFile), "profile.json");
  const initial = await Promise.all([
    readFile(options.registryFile, "utf8"),
    readFile(options.labelsFile, "utf8"),
    readFile(configFile, "utf8"),
  ]);
  const save = (profile) => writeFile(profileFile, JSON.stringify(profile));
  await save({
    profile_schema_version: 2,
    app_id: "first-tool",
    display_name: "第一款工具",
  });
  const result = await checkAppLabels({ ...options, profileFile });
  assert.equal(result.profileAppId, "first-tool");
  assert.equal(result.profileDisplayNameMatches, true);
  assert.equal(result.registeredCount, 1);
  for (const [profile, pattern] of [
    [
      {
        profile_schema_version: 2,
        app_id: "first-tool",
        display_name: "另一中文名称",
      },
      /does not match/,
    ],
    [
      {
        profile_schema_version: 2,
        app_id: "metadata-only",
        display_name: "额外工具",
      },
      /not registered/,
    ],
    [
      {
        profile_schema_version: 2,
        app_id: "first-tool",
        display_name: "first-tool",
      },
      /Chinese/,
    ],
    [{ profile_schema_version: 2, app_id: "first-tool" }, /safe text/],
    [
      {
        profile_schema_version: 1,
        app_id: "first-tool",
        display_name: "第一款工具",
      },
      /Profile v2/,
    ],
  ]) {
    await save(profile);
    await assert.rejects(checkAppLabels({ ...options, profileFile }), pattern);
  }
  await writeFile(profileFile, '{"display_name":"private-unparsed-value"');
  await assert.rejects(
    checkAppLabels({ ...options, profileFile }),
    (error) =>
      !error.message.includes("private-unparsed-value") &&
      /Profile JSON/.test(error.message),
  );
  assert.deepEqual(
    await Promise.all([
      readFile(options.registryFile, "utf8"),
      readFile(options.labelsFile, "utf8"),
      readFile(configFile, "utf8"),
    ]),
    initial,
  );
});

test("onboarding Profile check still rejects other registered tools with missing names", async (t) => {
  const { options } = await createFixture(t);
  const registry = fixtureRegistry();
  registry.apps.push({
    app_id: "second-tool",
    release_streams: [
      {
        platform: "windows",
        architecture: "x64",
        channel: "stable",
        code: "second-tool-windows-x64",
      },
    ],
  });
  await writeFile(options.registryFile, JSON.stringify(registry));
  const profileFile = join(dirname(options.registryFile), "profile.json");
  await writeFile(
    profileFile,
    JSON.stringify({
      profile_schema_version: 2,
      app_id: "first-tool",
      display_name: "第一款工具",
    }),
  );
  await assert.rejects(
    checkAppLabels({ ...options, profileFile }),
    /missing display name.*second-tool/,
  );
});

test("Profile CLI check is read-only and cannot be passed to the name writer", async (t) => {
  const { options } = await createFixture(t);
  const profileFile = join(dirname(options.registryFile), "profile.json");
  await writeFile(
    profileFile,
    JSON.stringify({
      profile_schema_version: 2,
      app_id: "first-tool",
      display_name: "第一款工具",
    }),
  );
  const result = runCli(["check", "--profile-file", profileFile], options);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).profileDisplayNameMatches, true);
  const before = await readFile(options.labelsFile, "utf8");
  const rejected = runCli(
    ["set", "first-tool", "其他名字", "--profile-file", profileFile],
    options,
  );
  assert.equal(rejected.status, 1);
  assert.equal(await readFile(options.labelsFile, "utf8"), before);
});

test("display metadata covers every registered app and preserves the seven confirmed names", async () => {
  const [registryText, labelsText] = await Promise.all([
    readFile(registryUrl, "utf8"),
    readFile(labelsUrl, "utf8"),
  ]);
  const registry = JSON.parse(registryText);
  const labels = JSON.parse(labelsText);
  assert.deepEqual(validateAppLabelCoverage(registry, labels), labels);
  const confirmedNames = {
    "bifang-vm-sync-agentless": "毕方VM虚拟机同步助手",
    "bifang-multi-local-proxy": "毕方本地代理多开器",
    "bifang-browser-multi-instance": "毕方浏览器多开器",
    "bifang-multi-instance-display": "毕方多窗口显示助手",
    "bifang-app-network-accelerator": "毕方多应用加速器",
    "bifang-window-layout": "毕方多窗口排布器",
    "bifang-multi-instance-display-plus": "毕方多窗口显示助手Plus",
  };
  for (const [appId, name] of Object.entries(confirmedNames)) {
    assert.equal(labels[appId], name, appId);
  }
  assert.equal(
    registry.apps.some(
      ({ app_id }) => app_id === "bifang-multi-instance-display-plus",
    ),
    true,
  );
  assert.deepEqual(await checkAppLabels(), {
    registeredCount: registry.apps.length,
    catalogCount: Object.keys(labels).length,
    metadataOnlyCount: Object.keys(labels).length - registry.apps.length,
  });
  const plus = (await listAppLabels()).find(
    ({ appId }) => appId === "bifang-multi-instance-display-plus",
  );
  assert.equal(plus.registered, true);
});

test("the observed 16-app inventory has a complete Chinese-name projection", async () => {
  const labels = JSON.parse(await readFile(labelsUrl, "utf8"));
  const observed = validateObservedAppLabels(observedAppIds, labels);
  assert.equal(Object.keys(observed).length, 16);
  assert.deepEqual(Object.keys(observed), observedAppIds);
  assert.equal(Object.isFrozen(observed), true);
  for (const appId of observedAppIds) {
    assert.equal(observed[appId], labels[appId]);
    const missing = { ...labels };
    delete missing[appId];
    assert.throws(
      () => validateObservedAppLabels(observedAppIds, missing),
      /missing display name for observed app/,
      appId,
    );
  }
});

test("observed-name auditing rejects incomplete inventory shapes and ignores unobserved metadata", () => {
  const labels = {
    "first-tool": "第一款工具",
    "metadata-only-tool": "仅维护名称",
  };
  assert.deepEqual(validateObservedAppLabels(["first-tool"], labels), {
    "first-tool": "第一款工具",
  });
  for (const appIds of [
    null,
    {},
    [],
    ["first-tool", "first-tool"],
    ["Bad-App"],
    [null],
  ]) {
    assert.throws(() => validateObservedAppLabels(appIds, labels), TypeError);
  }
  assert.throws(
    () =>
      validateObservedAppLabels(["first-tool"], { "first-tool": "first-tool" }),
    /Chinese characters/,
  );
});

test("equal display names preserve the base and Plus identities and isolated resources", () => {
  const baseId = "bifang-multi-instance-display";
  const plusId = "bifang-multi-instance-display-plus";
  const displayName = "毕方多窗口显示助手";
  assert.deepEqual(
    validateObservedAppLabels([baseId, plusId], {
      [baseId]: displayName,
      [plusId]: displayName,
    }),
    { [baseId]: displayName, [plusId]: displayName },
  );
  const base = deriveAppResources(baseId);
  const plus = deriveAppResources(plusId);
  for (const key of ["appId", "functionName", "trackPath", "collectionName"]) {
    assert.notEqual(base[key], plus[key], key);
  }
});

test("coverage refuses missing or non-Chinese registered names while permitting extra metadata", () => {
  const registry = fixtureRegistry();
  assert.throws(
    () =>
      validateAppLabelCoverage(registry, {
        "metadata-only-tool": "仅维护名称",
      }),
    /missing display name.*first-tool/,
  );
  assert.throws(() => validateAppLabelCoverage(registry, {}), TypeError);
  assert.throws(
    () => validateAppLabelCoverage(registry, { "first-tool": "first-tool" }),
    /Chinese characters.*first-tool/,
  );
  assert.doesNotThrow(() =>
    validateAppLabelCoverage(registry, {
      "first-tool": "第一款工具",
      "metadata-only-tool": "已确认名称",
    }),
  );
});

test("unsafe or malformed names fail before changing the metadata file", async (t) => {
  const { options } = await createFixture(t);
  const original = await readFile(options.labelsFile, "utf8");
  for (const displayName of [
    "",
    " ",
    " 中文名称",
    "中文名称 ",
    "中".repeat(101),
    "中文\n名称",
    "中文\u0000名称",
    "中文\u202e名称",
    "<中文名称>",
    "中文>名称",
    "English only",
    null,
  ]) {
    await assert.rejects(
      setAppLabel("first-tool", displayName, options),
      TypeError,
    );
    assert.equal(await readFile(options.labelsFile, "utf8"), original);
  }
  for (const appId of ["Bad-App", "bad_app", "../first-tool", "a".repeat(51)]) {
    await assert.rejects(setAppLabel(appId, "中文名称", options), TypeError);
    assert.equal(await readFile(options.labelsFile, "utf8"), original);
  }
  await assert.rejects(setAppLabel(undefined, "中文名称", options), TypeError);
  assert.equal(await readFile(options.labelsFile, "utf8"), original);
});

test("names preserve exact Unicode text at the one and 100 character boundaries", async (t) => {
  const { options } = await createFixture(t);
  for (const displayName of [
    "中",
    "𠀀".repeat(100),
    "毕方 多窗口显示助手Plus",
  ]) {
    await setAppLabel("first-tool", displayName, options);
    assert.equal(
      JSON.parse(await readFile(options.labelsFile, "utf8"))["first-tool"],
      displayName,
    );
    await checkAppLabels(options);
  }
});

test("renaming or naming an unregistered app changes only the metadata JSON", async (t) => {
  const { options, configFile } = await createFixture(t);
  const originalRegistry = await readFile(options.registryFile, "utf8");
  const originalConfig = await readFile(configFile, "utf8");

  assert.deepEqual(await setAppLabel("first-tool", "已确认新名称", options), {
    appId: "first-tool",
    displayName: "已确认新名称",
    registered: true,
  });
  assert.deepEqual(
    await setAppLabel("metadata-only-tool", "额外名称Plus", options),
    {
      appId: "metadata-only-tool",
      displayName: "额外名称Plus",
      registered: false,
    },
  );
  assert.deepEqual(JSON.parse(await readFile(options.labelsFile, "utf8")), {
    "first-tool": "已确认新名称",
    "metadata-only-tool": "额外名称Plus",
  });
  assert.equal(await readFile(options.registryFile, "utf8"), originalRegistry);
  assert.equal(await readFile(configFile, "utf8"), originalConfig);
  assert.equal(
    `${JSON.stringify(createCloudBaseConfig(JSON.parse(originalRegistry)), null, 2)}\n`,
    originalConfig,
  );
  assert.deepEqual(await checkAppLabels(options), {
    registeredCount: 1,
    catalogCount: 2,
    metadataOnlyCount: 1,
  });
});

test("CLI check, list and set operate on the supplied local files without registration", async (t) => {
  const { options } = await createFixture(t, {
    "metadata-only-tool": "仅维护名称",
  });
  const missing = runCli(["check"], options);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing display name/);
  const initialList = runCli(["list"], options);
  assert.equal(initialList.status, 0, initialList.stderr);
  assert.deepEqual(JSON.parse(initialList.stdout), [
    { appId: "first-tool", displayName: null, registered: true },
    {
      appId: "metadata-only-tool",
      displayName: "仅维护名称",
      registered: false,
    },
  ]);
  for (const [appId, name, registered] of [
    ["first-tool", "第一款工具", true],
    ["metadata-only-tool", "已确认名称Plus", false],
  ]) {
    const set = runCli(["set", appId, name], options);
    assert.equal(set.status, 0, set.stderr);
    assert.deepEqual(JSON.parse(set.stdout), {
      appId,
      displayName: name,
      registered,
    });
  }
  const check = runCli(["check"], options);
  assert.equal(check.status, 0, check.stderr);
  assert.deepEqual(JSON.parse(check.stdout), {
    registeredCount: 1,
    catalogCount: 2,
    metadataOnlyCount: 1,
  });
  const list = runCli(["list"], options);
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout), await listAppLabels(options));

  const before = await readFile(options.labelsFile, "utf8");
  for (const args of [
    ["set", "first-tool"],
    ["delete", "first-tool"],
    ["set", "first-tool", "<坏名称>"],
  ]) {
    const rejected = runCli(args, options);
    assert.equal(rejected.status, 1);
    assert.equal(await readFile(options.labelsFile, "utf8"), before);
  }
});

test("the standard repository check includes the naming coverage gate", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    packageJson.scripts["cloudbase:labels:check"],
    "node cloudbase/app-labels.mjs check",
  );
  assert.equal(
    packageJson.scripts["cloudbase:app:name"],
    "node cloudbase/app-labels.mjs set",
  );
  assert.ok(
    packageJson.scripts.check.includes("npm run cloudbase:labels:check"),
  );
});
