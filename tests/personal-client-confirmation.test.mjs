import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  validateConfirmation,
  prepareConfirmation,
  publicPreview,
  runConfirmation,
} from "../cloudbase/personal/client-confirmation.mjs";
import {
  readPrivate,
  writePrivate,
  privateRoot,
} from "../cloudbase/personal/private-files.mjs";
import { ROOT } from "../cloudbase/personal/spec.mjs";

const require = createRequire(import.meta.url);
const {
  createHandler: updateHandler,
} = require("../cloudbase/functions/application-version-api/src/handler.js");
const {
  hashCredential,
} = require("../cloudbase/functions/application-version-api/src/auth.js");
const {
  createHandler: telemetryHandler,
} = require("../cloudbase/functions/telemetry/src/handler.js");
const now = new Date("2026-11-18T04:00:00Z");
async function fixture() {
  const input = JSON.parse(
    await readFile(
      join(
        ROOT,
        "skills/bifang-public-services-onboarding/assets/integration-input.template.json",
      ),
      "utf8",
    ),
  );
  input.app = { app_id: "personal-test", display_name: "个人测试" };
  input.targets = [
    {
      platform: "windows",
      arch: "x64",
      channel: "stable",
      app_version: "1.2.3",
      update_code: "personal-test-windows-x64",
      runtime_credential_id: "runtime-test",
    },
  ];
  input.update.base_url =
    "https://fixture.example.invalid/tools/version-control/v1";
  input.telemetry.url =
    "https://fixture.example.invalid/apps/personal-test/v1/track";
  input.update.credentials = [
    {
      credential_id: "runtime-test",
      app_id: "personal-test",
      codes: ["personal-test-windows-x64"],
      role: "runtime",
      app_key: "fixture-runtime-key",
      app_secret: "fixture-runtime-secret",
    },
  ];
  return input;
}

test("generated requests satisfy the actual local update and telemetry handlers", async () => {
  const input = await fixture(),
    c = input.update.credentials[0];
  const result = prepareConfirmation(input, input.update.credentials, now);
  assert.equal(result.status, "awaiting-customer-confirmation");
  assert.equal(result.customer_confirmed, false);
  const updates = updateHandler({
    applications: [
      {
        appId: c.app_id,
        versionCollection: "versions_personal_test",
        adCollection: "ads_personal_test",
        auditCollection: "audit_personal_test",
      },
    ],
    credentials: {
      schema_version: 1,
      credentials: [
        {
          credential_id: c.credential_id,
          app_id: c.app_id,
          codes: c.codes,
          key_sha256: hashCredential(c.app_key),
          secret_sha256: [hashCredential(c.app_secret)],
          scopes: ["versions:check"],
        },
      ],
    },
    repository: {
      listVersionsForCode: async (appId, code) => {
        assert.equal(appId, c.app_id);
        assert.equal(code, c.codes[0]);
        return [
          {
            id: "1",
            codeVersion: "2.0.0",
            downloadUrl: "https://fixture.example.invalid/app.exe",
            promptContent: "升级提示",
            updateContent: "",
            forcedUpdate: false,
            promptUpdate: true,
            stopUpdate: false,
          },
        ];
      },
    },
    logger: { error: () => assert.fail("local handler failed") },
  });
  let stored;
  const telemetry = telemetryHandler({
    allowedAppIds: c.app_id,
    trackPath: new URL(input.telemetry.url).pathname,
    writer: async (event) => {
      stored = event;
    },
    now: () => now,
  });
  for (const req of result.requests) {
    const event = {
      httpMethod: req.method,
      path: new URL(req.url).pathname,
      headers: req.headers,
      body: req.body && JSON.stringify(req.body),
    };
    const response = await (req.service === "update" ? updates : telemetry)(
      event,
    );
    assert.equal(response.statusCode, req.expected_http_status);
    if (req.service === "update")
      assert.equal(JSON.parse(response.body).update, true);
    else assert.deepEqual(JSON.parse(response.body), { ok: true });
  }
  assert.equal(stored.app_id, input.app.app_id);
  assert.equal(stored.active_date, "2026-11-18");
});

test("missing fields and incompatible versions stop the entire combined preview", async () => {
  const input = await fixture();
  input.update.base_url = "";
  input.targets[0].app_version = "1.2.3-beta.1";
  const blocked = prepareConfirmation(input, input.update.credentials, now);
  assert.equal(blocked.status, "needs-input");
  assert.ok(blocked.fields.includes("update.base_url"));
  assert.ok(
    blocked.fields.includes("targets[0].app_version.update_numeric_dotted"),
  );
  assert.equal(blocked.requests, undefined);
  input.services.update = false;
  const telemetry = prepareConfirmation(input, [], now);
  assert.equal(telemetry.requests.length, 1);
  assert.deepEqual(telemetry.requests[0].headers, {
    "Content-Type": "application/json",
  });
});

test("single update does not require telemetry values and rejects ambiguous mappings", async () => {
  const input = await fixture();
  input.services.telemetry = false;
  input.telemetry = {};
  input.targets[0].app_version = "1.2";
  assert.equal(
    prepareConfirmation(input, input.update.credentials, now).requests.length,
    1,
  );
  input.targets.push({ ...input.targets[0], arch: "arm64" });
  assert.ok(validateConfirmation(input).includes("targets[1].update_code"));
  input.services.update = false;
  assert.deepEqual(validateConfirmation(input), ["services"]);
});

test("management, cross-app, wrong-code and duplicate credentials cannot become runtime examples", async () => {
  for (const mutate of [
    (c) => {
      c.role = "managementWrite";
    },
    (c) => {
      c.app_id = "another-app";
    },
    (c) => {
      c.codes = ["another-code"];
    },
  ]) {
    const input = await fixture();
    mutate(input.update.credentials[0]);
    const result = prepareConfirmation(input, input.update.credentials, now);
    assert.equal(result.status, "needs-input");
    assert.equal(result.requests, undefined);
  }
  const input = await fixture();
  input.update.credentials.push({ ...input.update.credentials[0] });
  assert.equal(
    prepareConfirmation(input, input.update.credentials, now).status,
    "needs-input",
  );
});

test("redacted preview hides original keys and config binding while preserving concrete request details", async () => {
  const input = await fixture(),
    result = prepareConfirmation(input, input.update.credentials, now);
  const publicResult = publicPreview(result),
    wire = JSON.stringify(publicResult);
  assert.ok(!wire.includes("fixture-runtime-key"));
  assert.ok(!wire.includes("fixture-runtime-secret"));
  assert.equal(publicResult.input_binding, undefined);
  assert.equal(
    publicResult.requests[0].url,
    input.update.base_url + "/versions/personal-test-windows-x64/1.2.3",
  );
  assert.equal(Object.keys(publicResult.requests[1].body).length, 10);
  assert.equal(result.requests[0].headers["x-app-key"], "fixture-runtime-key");
  const changed = structuredClone(input);
  changed.update.credentials[0].app_secret = "replacement-fixture-secret";
  assert.notEqual(
    prepareConfirmation(changed, changed.update.credentials, now).input_binding,
    result.input_binding,
  );
});

test("URLs cannot smuggle query credentials and unexpected input cannot reflect secret text", async () => {
  const input = await fixture();
  input.update.base_url += "?token=must-not-echo";
  const output = JSON.stringify(
    prepareConfirmation(input, input.update.credentials, now),
  );
  assert.ok(output.includes("update.base_url"));
  assert.ok(!output.includes("must-not-echo"));
  input["SecretKey-must-not-echo"] = "never-show";
  assert.deepEqual(validateConfirmation(input), ["input.schema"]);
});

test("CLI reuses private service file and writes complete private examples without requests or secret output", async (t) => {
  const prints = [];
  await runConfirmation(["init"], { print: (s) => prints.push(s) });
  const file = JSON.parse(prints.pop()).file,
    dir = resolve(dirname(file));
  t.after(async () => {
    assert.ok(dir.startsWith(privateRoot() + sep));
    await rm(dir, { recursive: true, force: true });
  });
  const input = await fixture(),
    credentialFile = join(dir, "service-credentials.json");
  await writePrivate(credentialFile, {
    schema_version: 1,
    version_credentials: input.update.credentials,
  });
  input.update.credentials_file = credentialFile;
  input.update.credentials = [];
  await writeFile(file, JSON.stringify(input), "utf8");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("Network access forbidden in confirmation");
  };
  try {
    await runConfirmation(["preview", "--file", file], {
      print: (s) => prints.push(s),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const output = prints.join(""),
    preview = JSON.parse(prints[0]);
  assert.ok(!output.includes("fixture-runtime-key"));
  assert.ok(!output.includes("fixture-runtime-secret"));
  assert.equal(preview.cloud_requests, 0);
  const artifact = await readPrivate(preview.private_request_examples_file);
  assert.equal(
    artifact.requests[0].headers["x-app-key"],
    "fixture-runtime-key",
  );
  assert.equal(artifact.confirmation_id, preview.confirmation_id);
  assert.equal(artifact.customer_confirmed, false);
});
