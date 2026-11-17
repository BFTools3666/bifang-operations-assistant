import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  appendFile,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceBootstrap = join(
  repositoryRoot,
  "tools",
  "bootstrap_bifang_onboarding.py",
);
const sourceManifest = join(repositoryRoot, "bifang-onboarding.json");
const skillName = "bifang-public-services-onboarding";
const sourceSkill = join(repositoryRoot, "skills", skillName);
const canonicalRepositoryUrl =
  "https://github.com/BFTools3666/bifang-operations-assistant.git";
const python = process.env.PYTHON || "python";

function run(command, arguments_, options = {}) {
  return spawnSync(command, arguments_, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
}

function git(cwd, arguments_) {
  const result = run("git", arguments_, { cwd });
  assert.equal(
    result.status,
    0,
    `git ${arguments_.join(" ")} failed:\n${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "bifang-bootstrap-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function createAuthorityFixture(t, options = {}) {
  const root = await temporaryRoot(t);
  const authority = join(root, "authority");
  const clone = run(
    "git",
    ["clone", "--no-hardlinks", repositoryRoot, authority],
    { cwd: root },
  );
  assert.equal(clone.status, 0, clone.stderr || clone.stdout);
  git(authority, ["switch", "-C", "main"]);
  git(authority, ["config", "user.name", "Bifang Bootstrap Tests"]);
  git(authority, ["config", "user.email", "bootstrap-tests@example.invalid"]);

  await copyFile(
    join(repositoryRoot, "package.json"),
    join(authority, "package.json"),
  );
  git(authority, ["add", "package.json"]);
  git(authority, [
    "commit",
    "--allow-empty",
    "-m",
    "test: infrastructure 3.0 fixture",
  ]);
  const infrastructureSourceCommit = git(authority, ["rev-parse", "HEAD"]);

  const installedSkillSource = join(authority, "skills", skillName);
  await rm(installedSkillSource, { recursive: true, force: true });
  await mkdir(dirname(installedSkillSource), { recursive: true });
  await cp(sourceSkill, installedSkillSource, { recursive: true });
  await mkdir(join(authority, "tools"), { recursive: true });
  await copyFile(
    sourceBootstrap,
    join(authority, "tools", "bootstrap_bifang_onboarding.py"),
  );
  await copyFile(sourceManifest, join(authority, "bifang-onboarding.json"));
  const fixtureSkillMd = join(installedSkillSource, "SKILL.md");
  await writeFile(
    fixtureSkillMd,
    (await readFile(fixtureSkillMd, "utf8")).replace(
      /^  infrastructure-source-commit:.*$/m,
      `  infrastructure-source-commit: "${infrastructureSourceCommit}"`,
    ),
    "utf8",
  );
  if (options.scannerSource !== undefined) {
    await writeFile(
      join(installedSkillSource, "scripts", "scan_project.py"),
      options.scannerSource,
      "utf8",
    );
  }

  git(authority, [
    "add",
    "--all",
    "--",
    "bifang-onboarding.json",
    "tools/bootstrap_bifang_onboarding.py",
    `skills/${skillName}`,
  ]);
  git(authority, ["commit", "-m", "test: published onboarding fixture"]);
  git(authority, ["remote", "set-url", "origin", canonicalRepositoryUrl]);
  const head = git(authority, ["rev-parse", "HEAD"]);
  assert.match(head, /^[0-9a-f]{40}$/);
  assert.equal(git(authority, ["status", "--porcelain=v1"]), "");
  return {
    authority,
    bootstrap: join(authority, "tools", "bootstrap_bifang_onboarding.py"),
    head,
    infrastructureSourceCommit,
    root,
  };
}

async function createClient(root, name = "客户端 项目") {
  const client = join(root, name);
  await mkdir(join(client, "src"), { recursive: true });
  git(client, ["init", "-b", "main"]);
  git(client, ["config", "user.name", "Bifang Bootstrap Tests"]);
  git(client, ["config", "user.email", "bootstrap-tests@example.invalid"]);
  await writeFile(
    join(client, "src", "config.rs"),
    'const UPDATE: &str = "https://old.example.invalid/updates/bifang-tool/windows.json";\n',
    "utf8",
  );
  git(client, ["add", "src/config.rs"]);
  git(client, ["commit", "-m", "test: initial client"]);
  await appendFile(
    join(client, "src", "config.rs"),
    "// inherited user edit\n",
    "utf8",
  );
  await writeFile(join(client, "用户未跟踪.txt"), "preserve me\n", "utf8");
  return client;
}

function runBootstrap(
  fixture,
  client,
  codexHome,
  { cwd = join(client, "src"), environment = {}, arguments_: extra = [] } = {},
) {
  return run(
    python,
    [
      "-X",
      "utf8",
      "-B",
      fixture.bootstrap,
      "--target-project",
      client,
      "--codex-home",
      codexHome,
      "--test-only-fixed-source-head",
      fixture.head,
      "--test-only-fixed-source-ref",
      "refs/heads/main",
      ...extra,
    ],
    {
      cwd,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        ...environment,
      },
    },
  );
}

async function assertSkillMissing(codexHome) {
  await assert.rejects(
    access(join(codexHome, "skills", skillName, "SKILL.md")),
    { code: "ENOENT" },
  );
}

test("verified bootstrap preserves the current dirty Git client and then installs", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "isolated codex-home");
  const beforeStatus = git(client, [
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);

  const result = runBootstrap(fixture, client, codexHome);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(
    output.authorization,
    "one-line-client-integration; bootstrap-output-is-stage-0-only",
  );
  assert.equal(output.source_head, fixture.head);
  assert.equal(output.source_remote_ref, "refs/heads/main");
  assert.equal(output.source_is_clean_checkout, true);
  assert.equal(output.source_matches_advertised_remote, false);
  assert.equal(output.source_verification_mode, "test-only-fixed-ref");
  assert.equal(output.infrastructure_version, "3.0.0");
  assert.equal(output.application_version_contract_version, "1.0.0");
  assert.equal(output.skill.version, "2.1.5");
  assert.equal(output.writes_to_target_project, false);
  assert.equal(output.target_git_unchanged, true);
  assert.ok(
    output.target_git_before.status_porcelain.some((line) =>
      line.startsWith(" M "),
    ),
  );
  assert.equal(output.target_git_before.head, output.target_git_after.head);
  assert.equal(
    output.target_git_before.status_sha256,
    output.target_git_after.status_sha256,
  );
  assert.equal(
    output.target_git_before.index_sha256,
    output.target_git_after.index_sha256,
  );
  assert.equal(
    output.target_git_before.content_sha256,
    output.target_git_after.content_sha256,
  );
  assert.equal(output.stage_0_scan.scan_version, 3);
  assert.equal(output.stage_0_scan.legacy_update_status, "detected");
  assert.equal(
    git(client, [
      "-c",
      "core.quotepath=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
    beforeStatus,
  );

  const installed = await readFile(
    join(codexHome, "skills", skillName, "SKILL.md"),
    "utf8",
  );
  assert.match(installed, /^  version: "2\.1\.5"$/m);
});

test("bootstrap manifest freezes the exact request and authorization boundary", async () => {
  const manifest = JSON.parse(await readFile(sourceManifest, "utf8"));
  assert.equal(manifest.oneLineRequest, `${canonicalRepositoryUrl} 帮我接入`);
  assert.equal(manifest.updateTransport, "client-update-center-v1");
  assert.equal(manifest.firstGate.id, "integration-scope-confirmation");
  assert.equal(manifest.firstGate.required, true);
  assert.equal(manifest.firstGate.requiresExplicitAnswer, true);
  assert.equal(
    manifest.firstGate.enforcedBy,
    "skill-conversation-before-bootstrap",
  );
  assert.deepEqual(manifest.firstGate.options, [
    "仅更新",
    "仅统计",
    "更新和统计都接入",
  ]);
  assert.equal(
    manifest.firstGate.onUnanswered,
    "stop-before-source-verification-install-scan-and-mutation",
  );
  assert.equal(
    manifest.initialAuthorization.condition,
    "firstGate confirmed for discovery; secondGate requires valid authorization and selected configuration; thirdGate requires inline request details and explicit customer confirmation of a ready plan before authorized implementation; fourthGate completes scoped local implementation and acceptance only",
  );
  const gateKeys = ["firstGate", "secondGate", "thirdGate", "fourthGate"];
  const gateChain = gateKeys.map((key) => manifest[key]);
  assert.deepEqual(
    manifest.gateProgression.order,
    gateChain.map((gate) => gate.id),
  );
  for (let i = 1; i < gateChain.length; i++) {
    assert.equal(gateChain[i].dependsOn, gateChain[i - 1].id);
    assert.equal(gateChain[i].required, true);
  }
  assert.equal(
    manifest.gateProgression.requiresAllSelectedServicesToPass,
    true,
  );
  assert.equal(manifest.gateProgression.allowsPartialBranchAdvance, false);
  assert.equal(
    manifest.gateProgression.onMissingOrUnconfirmedEvidence,
    "hold-current-gate; no-next-gate-actions",
  );
  assert.deepEqual(manifest.gateProgression.fourthGateOrder, [
    "ui-review",
    "architecture-review",
    "implementation",
    "local-acceptance",
  ]);
  assert.equal(
    manifest.gateProgression.uiNotApplicableOnlyWhen,
    "telemetry-only-without-visible-ui-changes; record-reason",
  );
  assert.equal(
    manifest.gateProgression.onResume,
    "verify-evidence; resume-earliest-unpassed-gate",
  );
  assert.equal(
    manifest.gateProgression.onScopeChange,
    "return-to-first-gate; revalidate-downstream-applicability",
  );
  assert.equal(manifest.secondGate.id, "authorization-center-configuration");
  assert.equal(manifest.secondGate.dependsOn, manifest.firstGate.id);
  assert.equal(manifest.secondGate.required, true);
  assert.equal(manifest.secondGate.requiresBrowserApprovalWhenNeeded, true);
  assert.equal(manifest.secondGate.requiresCustomerParameterForm, false);
  assert.equal(
    manifest.secondGate.enforcedBy,
    "skill-device-authorization-and-selected-config-read",
  );
  assert.deepEqual(manifest.secondGate.scopes, manifest.firstGate.options);
  assert.deepEqual(manifest.secondGate.requiredEvidence, [
    "valid-device-authorization",
    "selected-configuration-read",
    "downstream-config-validated",
    "project-facts-and-defaults-resolved",
  ]);
  assert.deepEqual(manifest.secondGate.defaults, {
    project_id: "bifang_tools",
    scopesBySelection: {
      仅更新: "updater:config:read",
      仅统计: "cloudbase:config:read",
      更新和统计都接入: "cloudbase:config:read updater:config:read",
    },
    localRegisteredClientId: "woskill",
    requestTimeoutSeconds: 10,
  });
  assert.deepEqual(manifest.secondGate.scopePolicy, {
    authority: "token-response-scope",
    onMissingSelectedScope: "stop-affected-branch; reauthorize-if-needed",
    onExtraScope: "do-not-expand-integration-scope",
    refreshScope: "omit; preserve-actual-granted-set",
  });
  assert.equal(
    manifest.secondGate.onConfigurationFailure,
    "hold-second-gate-for-entire-selected-scope; preserve-valid-evidence-and-repair-failed-config",
  );
  assert.equal(
    manifest.secondGate.onUnselectedService,
    "not-applicable; do-not-expand-scope",
  );
  const [secondGateDocument, secondGateAnchor] =
    manifest.secondGate.reference.split("#");
  const secondGateText = await readFile(
    join(repositoryRoot, secondGateDocument),
    "utf8",
  );
  assert.equal(secondGateAnchor, "第二门禁授权中心授权与配置获取");
  assert.ok(secondGateText.includes("## 第二门禁：授权中心授权与配置获取"));
  assert.equal(manifest.thirdGate.id, "client-integration-plan-readiness");
  assert.equal(manifest.thirdGate.dependsOn, manifest.secondGate.id);
  assert.equal(manifest.thirdGate.required, true);
  assert.equal(manifest.thirdGate.requiresCustomerParameterForm, false);
  assert.equal(manifest.thirdGate.requiresBlanketConfirmation, false);
  assert.equal(manifest.thirdGate.requiresExplicitCustomerConfirmation, true);
  assert.equal(
    manifest.thirdGate.confirmationPresentation,
    "inline-complete-selected-service-request-details; linked-record-only-supplementary; credentials-hidden",
  );
  assert.equal(
    manifest.thirdGate.onUnconfirmed,
    "stop-before-dependent-implementation; scope-selection-and-browser-approval-do-not-count",
  );
  assert.equal(
    manifest.thirdGate.enforcedBy,
    "skill-evidence-based-plan-review-and-explicit-customer-confirmation",
  );
  assert.deepEqual(manifest.thirdGate.scopes, manifest.firstGate.options);
  assert.deepEqual(manifest.thirdGate.requiredEvidence, [
    "rust-integration-points-mapped",
    "runtime-behavior-and-defaults-resolved",
    "scoped-change-list-prepared",
    "local-and-online-validation-plan-prepared",
    "external-dependencies-recorded",
    "inline-selected-service-request-details",
    "explicit-customer-confirmation-by-branch",
  ]);
  assert.equal(
    manifest.thirdGate.onUnknownBlockingFact,
    "hold-current-gate-for-entire-selected-scope; clarify-only-unresolved-facts",
  );
  assert.equal(
    manifest.thirdGate.onKnownOnlineDependency,
    "record-separately; allow-local-work-only-after-prerequisite-gates-pass-and-authorization-exists",
  );
  assert.equal(
    manifest.thirdGate.onPartialReadiness,
    "hold-entire-selected-scope-at-current-gate-until-all-selected-services-pass",
  );
  assert.equal(
    manifest.thirdGate.onUnselectedService,
    "not-applicable; preserve-existing-behavior",
  );
  assert.equal(
    manifest.thirdGate.completionMeaning,
    "plan-ready-and-customer-confirmed; not-implementation-or-live-validation-complete",
  );
  const [thirdGateDocument, thirdGateAnchor] =
    manifest.thirdGate.reference.split("#");
  const thirdGateText = await readFile(
    join(repositoryRoot, thirdGateDocument),
    "utf8",
  );
  assert.equal(thirdGateAnchor, "第三门禁客户端接入方案与请求明细确认");
  assert.ok(
    thirdGateText.includes("## 第三门禁：客户端接入方案与请求明细确认"),
  );
  assert.equal(
    manifest.fourthGate.id,
    "client-local-implementation-acceptance",
  );
  assert.equal(manifest.fourthGate.dependsOn, manifest.thirdGate.id);
  assert.equal(manifest.fourthGate.required, true);
  assert.equal(
    manifest.fourthGate.enforcedBy,
    "skill-scoped-implementation-and-host-verification",
  );
  assert.equal(
    manifest.fourthGate.entryCondition,
    "all-selected-services-second-and-third-gates-passed-with-explicit-customer-confirmation; local-implementation-authorized",
  );
  assert.deepEqual(manifest.fourthGate.scopes, manifest.firstGate.options);
  assert.equal(manifest.fourthGate.requiresCustomerParameterForm, false);
  assert.equal(manifest.fourthGate.requiresBlanketConfirmation, false);
  assert.equal(
    manifest.fourthGate.uiReview.requiredBeforeCodingWhen,
    "updates-selected-or-visible-telemetry-ui-changes",
  );
  assert.equal(
    manifest.fourthGate.uiReview.onUnconfirmed,
    "stop-all-selected-business-implementation; design-preview-only",
  );
  assert.equal(
    manifest.fourthGate.uiReview.onThirdGateConfirmation,
    "does-not-replace-ui-confirmation",
  );
  assert.equal(
    manifest.fourthGate.uiReview.onTelemetryOnlyWithoutVisibleChanges,
    "not-applicable; proceed-with-existing-local-implementation-authorization",
  );
  assert.equal(
    manifest.fourthGate.uiReview.onConfirmed,
    "implement-and-test-within-existing-authorization; no-repeat-start-coding-question",
  );
  assert.deepEqual(manifest.fourthGate.uiReview.requiredEvidence, [
    "current-project-style-evidence",
    "visible-selected-service-ui-previews",
    "actual-trigger-and-display-locations",
    "explicit-customer-ui-confirmation",
  ]);
  const [uiDocument, uiAnchor] =
    manifest.fourthGate.uiReview.reference.split("#");
  assert.equal(uiDocument, thirdGateDocument);
  assert.equal(uiAnchor, "先展示并确认-ui再编码");
  assert.equal(manifest.fourthGate.architectureBeforeCoding.required, true);
  assert.equal(
    manifest.fourthGate.architectureBeforeCoding.requiresCustomerConfirmation,
    false,
  );
  assert.deepEqual(
    manifest.fourthGate.architectureBeforeCoding.requiredEvidence,
    [
      "applicable-project-instructions-and-conventions",
      "actual-module-boundaries-and-call-chain",
      "existing-patterns-and-reuse-map",
      "local-verification-commands-and-baseline",
    ],
  );
  assert.equal(
    manifest.fourthGate.architectureBeforeCoding.implementationPolicy,
    "preserve-target-architecture-and-stack; follow-existing-module-and-coding-conventions; no-unrelated-refactor",
  );
  assert.equal(
    manifest.fourthGate.architectureBeforeCoding.onUnresolvedConflict,
    "investigate-evidence; stop-only-dependent-changes-and-clarify-concrete-conflict",
  );
  const [architectureDocument, architectureAnchor] =
    manifest.fourthGate.architectureBeforeCoding.reference.split("#");
  assert.equal(architectureDocument, thirdGateDocument);
  assert.equal(architectureAnchor, "编码前学习当前项目架构与编码规范");
  assert.deepEqual(manifest.fourthGate.requiredEvidence, [
    "applicable-ui-preview-and-customer-confirmation-or-not-applicable-evidence",
    "target-architecture-and-coding-conventions-applied",
    "actual-scoped-changes",
    "host-request-and-state-evidence",
    "executed-local-checks-and-results",
    "implemented-capabilities-and-platform-limits",
    "unverified-items-and-online-dependencies",
  ]);
  assert.equal(
    manifest.fourthGate.localTestPolicy,
    "fake-credentials; injected-transport; fixed-clock; temporary-state; no-live-business-requests",
  );
  assert.equal(
    manifest.fourthGate.onLocalFailure,
    "repair-and-reverify-within-authorized-scope; do-not-reduce-selected-services-or-promised-capabilities",
  );
  assert.equal(
    manifest.fourthGate.onPartialAcceptance,
    "record-branch-results-independently; combined-pass-requires-both-branches-and-isolation-evidence",
  );
  assert.equal(
    manifest.fourthGate.onUnselectedService,
    "not-applicable; preserve-existing-behavior",
  );
  assert.equal(
    manifest.fourthGate.completionMeaning,
    "local-implementation-accepted; not-live-service-gui-installation-or-release-complete",
  );
  assert.equal(manifest.postLocalAcceptance.dependsOn, manifest.fourthGate.id);
  assert.equal(
    manifest.postLocalAcceptance.configurationOwner,
    "customer-manual; no-skill-admin-operation-or-audit",
  );
  assert.equal(
    manifest.postLocalAcceptance.preflight.appliesWhen,
    "updates-selected",
  );
  assert.equal(
    manifest.postLocalAcceptance.preflight.trigger,
    "customer-reports-completion-after-preflight-purpose-and-targets-disclosed",
  );
  assert.equal(
    manifest.postLocalAcceptance.preflight.onFailure,
    "hold-step-5; customer-corrects-and-reports-again-before-recheck",
  );
  assert.equal(
    manifest.postLocalAcceptance.preflight.onPass,
    "eligible-for-step-6-only-with-exe-test-authorization",
  );
  assert.deepEqual(manifest.postLocalAcceptance.preflight.excludes, [
    "admin-api-or-ui-audit",
    "backend-configuration-mutation",
    "artifact-download-or-installation",
    "exe-build-or-run",
    "daily-active-write",
  ]);
  assert.deepEqual(manifest.postLocalAcceptance.order, [
    "prompt-customer-manual-update-configuration",
    "wait-for-customer-completion",
    "simple-client-update-api-preflight",
    "preflight-pass-and-exe-test-authorization",
    "build-and-run-real-exe",
    "real-acceptance-evidence",
  ]);
  assert.equal(
    manifest.postLocalAcceptance.requiresCustomerConfigurationHandoff,
    true,
  );
  assert.equal(
    manifest.postLocalAcceptance.updateCenterAppliesWhen,
    "updates-selected",
  );
  assert.equal(
    manifest.postLocalAcceptance.telemetryOnly,
    "skip-update-center; verify-telemetry-service-readiness",
  );
  assert.equal(
    manifest.postLocalAcceptance.combinedScope,
    "update-preflight-and-existing-selected-service-prerequisites-before-exe-test",
  );
  assert.equal(
    manifest.postLocalAcceptance.onNotReady,
    "hold-dependent-real-test; no-mock-completion",
  );
  assert.equal(
    manifest.postLocalAcceptance.onUnknownAdminUrl,
    "mark-pending; do-not-derive-admin-url-from-api",
  );
  assert.equal(
    manifest.postLocalAcceptance.testAuthorization,
    "reuse-explicit-same-target-authorization; otherwise-confirm-concrete-build-run-live-request-plan",
  );
  const separatelyAuthorizedActions = [
    "run-live-update-check-or-download",
    "run-live-telemetry-or-dashboard-verification",
    "modify-operations-registration-or-update-backend",
    "build-or-install-client",
    "sign-client-artifacts",
    "run-native-gui-or-install-e2e",
    "deploy-cloudbase",
    "publish-or-push",
    "delete-or-retire-cloud-resources",
  ];
  assert.deepEqual(
    manifest.fourthGate.requiresSeparateExplicitAuthorization,
    separatelyAuthorizedActions,
  );
  for (const action of separatelyAuthorizedActions) {
    assert.ok(
      manifest.initialAuthorization.requiresSeparateExplicitAuthorization.includes(
        action,
      ),
    );
    assert.ok(!manifest.initialAuthorization.allows.includes(action));
  }
  const [fourthGateDocument, fourthGateAnchor] =
    manifest.fourthGate.reference.split("#");
  const fourthGateText = await readFile(
    join(repositoryRoot, fourthGateDocument),
    "utf8",
  );
  assert.equal(fourthGateAnchor, "第四门禁客户端本地实施与验收");
  assert.ok(fourthGateText.includes("## 第四门禁：客户端本地实施与验收"));
  assert.equal(
    manifest.applicationVersionBaselineCommit,
    "92b0c599a42c3a094c99787e6928c30c2d2ea3af",
  );
  assert.deepEqual(manifest.initialAuthorization.allows, [
    "fetch-authoritative-repository",
    "install-or-update-onboarding-skill",
    "read-only-stage-0-project-scan",
    "read-selected-configuration-via-device-authorization",
    "prepare-selected-service-integration-plan",
    "implement-selected-rust-service-integration",
    "write-or-migrate-non-sensitive-profile",
    "replace-legacy-update-protocol-in-target-client",
    "remove-legacy-update-protocol-from-target-client",
    "run-local-static-and-unit-verification",
    "run-local-host-integration-verification",
  ]);
  assert.ok(
    manifest.initialAuthorization.requiresSeparateExplicitAuthorization.includes(
      "deploy-cloudbase",
    ),
  );
});

test("dirty, staged, or untracked Skill source is rejected before scan or install", async (t) => {
  for (const mutation of ["dirty", "staged", "untracked"]) {
    const fixture = await createAuthorityFixture(t);
    const client = await createClient(fixture.root, `client-${mutation}`);
    const codexHome = join(fixture.root, `codex-${mutation}`);
    if (mutation === "dirty" || mutation === "staged") {
      await appendFile(
        join(
          fixture.authority,
          "skills",
          skillName,
          "scripts",
          "scan_project.py",
        ),
        "\n# dirty source\n",
        "utf8",
      );
      if (mutation === "staged") {
        git(fixture.authority, [
          "add",
          `skills/${skillName}/scripts/scan_project.py`,
        ]);
      }
    } else {
      await writeFile(
        join(fixture.authority, "skills", skillName, "untracked.py"),
        "raise SystemExit('must never execute')\n",
        "utf8",
      );
    }

    const result = runBootstrap(fixture, client, codexHome);

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /differs from HEAD|differ from HEAD|ls-files.*failed/is,
    );
    await assertSkillMissing(codexHome);
  }
});

test("source HEAD must equal the selected published ref commit", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-head-mismatch");

  const result = runBootstrap(
    { ...fixture, head: "a".repeat(40) },
    client,
    codexHome,
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /source HEAD is not the published refs\/heads\/main/i,
  );
  await assertSkillMissing(codexHome);
});

test("bootstrap source must itself be the canonical Git top-level", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-nested-source");
  const nestedBootstrap = join(
    fixture.authority,
    "nested",
    "tools",
    "bootstrap_bifang_onboarding.py",
  );
  await mkdir(dirname(nestedBootstrap), { recursive: true });
  await copyFile(fixture.bootstrap, nestedBootstrap);

  const result = runBootstrap(
    { ...fixture, bootstrap: nestedBootstrap },
    client,
    codexHome,
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bootstrap source must be the Git top-level/i);
  await assertSkillMissing(codexHome);
});

test("target must be the Git root that owns the invocation cwd", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const intended = await createClient(fixture.root, "intended-client");
  const other = await createClient(fixture.root, "other-client");
  const codexHome = join(fixture.root, "codex-target-boundary");

  const result = runBootstrap(fixture, intended, codexHome, {
    cwd: join(other, "src"),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /target project must equal.*invocation cwd/is);
  await assertSkillMissing(codexHome);
});

test("an unrelated dirty source file fails the full-repository clean gate", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-full-clean");
  await appendFile(join(fixture.authority, "README.md"), "\nuncommitted\n");

  const result = runBootstrap(fixture, client, codexHome);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /repository differs from HEAD.*fully clean/is);
  await assertSkillMissing(codexHome);
});

test("ignored Python bytecode in the Skill source is rejected", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-bytecode");
  const cache = join(
    fixture.authority,
    "skills",
    skillName,
    "scripts",
    "__pycache__",
  );
  await mkdir(cache, { recursive: true });
  await writeFile(
    join(cache, "scan_project.cpython-312.pyc"),
    "not bytecode\n",
  );
  assert.equal(git(fixture.authority, ["status", "--porcelain=v1"]), "");

  const result = runBootstrap(fixture, client, codexHome);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Python bytecode\/cache/i);
  await assertSkillMissing(codexHome);
});

test("Git is resolved outside the untrusted invocation cwd", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const client = await createClient(fixture.root);
  const cwd = join(client, "src");
  const codexHome = join(fixture.root, "codex-safe-git");
  const fakeGit = join(cwd, process.platform === "win32" ? "git.exe" : "git");
  await writeFile(fakeGit, "#!/bin/sh\nexit 93\n", "utf8");
  if (process.platform !== "win32") {
    await chmod(fakeGit, 0o755);
  }

  const result = runBootstrap(fixture, client, codexHome, {
    cwd,
    environment: { PATH: `${cwd}${delimiter}${process.env.PATH ?? ""}` },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).target_git_unchanged, true);
});

test("target may be a Codex worktree but cannot overlap the Skill installation", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const codexHome = join(fixture.root, "codex-home");
  const client = await createClient(
    join(codexHome, "worktrees"),
    "client-worktree",
  );

  const result = runBootstrap(fixture, client, codexHome);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).target_git_unchanged, true);

  const installationTarget = join(codexHome, "skills", skillName);
  await mkdir(join(installationTarget, "src"), { recursive: true });
  git(installationTarget, ["init", "-b", "main"]);
  git(installationTarget, ["config", "user.name", "Bifang Bootstrap Tests"]);
  git(installationTarget, [
    "config",
    "user.email",
    "bootstrap-tests@example.invalid",
  ]);
  await writeFile(join(installationTarget, "src", "main.rs"), "fn main() {}\n");
  git(installationTarget, ["add", "src/main.rs"]);
  git(installationTarget, ["commit", "-m", "test: overlapping target"]);

  const overlap = runBootstrap(fixture, installationTarget, codexHome, {
    cwd: join(installationTarget, "src"),
  });
  assert.notEqual(overlap.status, 0);
  assert.match(overlap.stderr, /target must not overlap.*installation/is);
});

test("a scanner failure leaves no new Skill installation", async (t) => {
  const fixture = await createAuthorityFixture(t, {
    scannerSource: 'raise SystemExit("intentional scanner failure")\n',
  });
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-scan-failure");
  const before = git(client, [
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);

  const result = runBootstrap(fixture, client, codexHome);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /scan_project\.py failed.*intentional scanner failure/is,
  );
  assert.equal(
    git(client, [
      "-c",
      "core.quotepath=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
    before,
  );
  await assertSkillMissing(codexHome);
});

test("content hashing detects a scanner rewrite that leaves porcelain unchanged", async (t) => {
  const fixture = await createAuthorityFixture(t, {
    scannerSource: [
      "import json, sys",
      "from pathlib import Path",
      'target = Path(sys.argv[1]) / "src" / "config.rs"',
      'target.write_text(target.read_text(encoding="utf-8") + "// scanner mutation\\n", encoding="utf-8")',
      'print(json.dumps({"scan_version": 3, "scan_incomplete": False, "skipped_files": []}))',
      "",
    ].join("\n"),
  });
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-content-digest");
  const beforeStatus = git(client, [
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);

  const result = runBootstrap(fixture, client, codexHome);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /status, or content changed during.*scan/is);
  assert.equal(
    git(client, [
      "-c",
      "core.quotepath=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
    beforeStatus,
  );
  await assertSkillMissing(codexHome);
});

test("bootstrap never executes an external quick_validate hook", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-no-hook");
  const validator = join(
    codexHome,
    "skills",
    ".system",
    "skill-creator",
    "scripts",
    "quick_validate.py",
  );
  const marker = join(fixture.root, "external-validator-ran.txt");
  await mkdir(dirname(validator), { recursive: true });
  await writeFile(
    validator,
    `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("ran")\nraise SystemExit(91)\n`,
    "utf8",
  );

  const result = runBootstrap(fixture, client, codexHome);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("infrastructure provenance must include the minimum commit", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-provenance-minimum");
  const beforeMinimum = git(fixture.authority, [
    "rev-parse",
    "92b0c599a42c3a094c99787e6928c30c2d2ea3af^",
  ]);
  const skillMd = join(fixture.authority, "skills", skillName, "SKILL.md");
  await writeFile(
    skillMd,
    (await readFile(skillMd, "utf8")).replace(
      /^  infrastructure-source-commit:.*$/m,
      `  infrastructure-source-commit: "${beforeMinimum}"`,
    ),
    "utf8",
  );
  git(fixture.authority, ["add", `skills/${skillName}/SKILL.md`]);
  git(fixture.authority, ["commit", "-m", "test: invalid early provenance"]);
  fixture.head = git(fixture.authority, ["rev-parse", "HEAD"]);

  const result = runBootstrap(fixture, client, codexHome);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source-commit does not contain the minimum/i);
  await assertSkillMissing(codexHome);
});

test("infrastructure provenance commit must carry the declared package version", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-provenance-version");
  const packagePath = join(fixture.authority, "package.json");
  const validPackage = await readFile(packagePath, "utf8");
  const wrongPackage = JSON.parse(validPackage);
  wrongPackage.version = "2.9.0";
  await writeFile(
    packagePath,
    `${JSON.stringify(wrongPackage, null, 2)}\n`,
    "utf8",
  );
  git(fixture.authority, ["add", "package.json"]);
  git(fixture.authority, ["commit", "-m", "test: wrong provenance version"]);
  const wrongVersionCommit = git(fixture.authority, ["rev-parse", "HEAD"]);

  await writeFile(packagePath, validPackage, "utf8");
  const skillMd = join(fixture.authority, "skills", skillName, "SKILL.md");
  await writeFile(
    skillMd,
    (await readFile(skillMd, "utf8")).replace(
      /^  infrastructure-source-commit:.*$/m,
      `  infrastructure-source-commit: "${wrongVersionCommit}"`,
    ),
    "utf8",
  );
  git(fixture.authority, [
    "add",
    "package.json",
    `skills/${skillName}/SKILL.md`,
  ]);
  git(fixture.authority, ["commit", "-m", "test: invalid version provenance"]);
  fixture.head = git(fixture.authority, ["rev-parse", "HEAD"]);

  const result = runBootstrap(fixture, client, codexHome);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /does not contain the declared infrastructure version/i,
  );
  await assertSkillMissing(codexHome);
});

test("application-version provenance stays pinned to the frozen v1 baseline", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-contract-baseline");
  const manifestPath = join(fixture.authority, "bifang-onboarding.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.applicationVersionBaselineCommit =
    "728fc58c276ef3725d49759b3fdf70c20fcd5e9b";
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  git(fixture.authority, ["add", "bifang-onboarding.json"]);
  git(fixture.authority, ["commit", "-m", "test: invalid contract baseline"]);
  fixture.head = git(fixture.authority, ["rev-parse", "HEAD"]);

  const result = runBootstrap(fixture, client, codexHome);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not the frozen v1 baseline/i);
  await assertSkillMissing(codexHome);
});

test("scanner receives a minimal environment without unrelated host secrets", async (t) => {
  const fixture = await createAuthorityFixture(t, {
    scannerSource: [
      "import json, os",
      "print(json.dumps({",
      '    "scan_version": 3,',
      '    "scan_incomplete": False,',
      '    "skipped_files": [],',
      '    "saw_unrelated_secret": "BIFANG_BOOTSTRAP_TEST_SECRET" in os.environ,',
      "}))",
      "",
    ].join("\n"),
  });
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-minimal-env");

  const result = runBootstrap(fixture, client, codexHome, {
    environment: { BIFANG_BOOTSTRAP_TEST_SECRET: "must-not-reach-children" },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    JSON.parse(result.stdout).stage_0_scan.saw_unrelated_secret,
    false,
  );
});

test("trusted Python children always run in isolated mode", async (t) => {
  const fixture = await createAuthorityFixture(t, {
    scannerSource: [
      "import json, sys",
      "print(json.dumps({",
      '    "scan_version": 3,',
      '    "scan_incomplete": False,',
      '    "skipped_files": [],',
      '    "python_isolated": sys.flags.isolated,',
      "}))",
      "",
    ].join("\n"),
  });
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-isolated-python");

  const result = runBootstrap(fixture, client, codexHome);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).stage_0_scan.python_isolated, 1);
});

test("malformed scan output is rejected before Skill installation", async (t) => {
  const fixture = await createAuthorityFixture(t, {
    scannerSource: 'print("{}")\n',
  });
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-invalid-scan");

  const result = runBootstrap(fixture, client, codexHome);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported scan_version/i);
  await assertSkillMissing(codexHome);
});
