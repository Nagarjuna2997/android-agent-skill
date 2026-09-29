import test from "node:test";
import assert from "node:assert/strict";
import { symlink, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, sample } from "./helpers.mjs";
import {
  scan,
  safePath,
  run,
  checked,
  redact,
  authorize,
  save,
} from "../dist/core/index.js";
import { inspect, xml } from "../dist/android/inspect.js";
import { audit } from "../dist/analysis/index.js";
import { execute } from "../dist/core/registry.js";
import { createRun, resumeRun } from "../dist/core/runs.js";
test("project graph detects Android, manifests, dependencies and SDK", async (t) => {
  const c = await fixture(t, sample),
    g = await inspect(c.root);
  assert.equal(g.projectType, "android-application");
  assert.equal(g.modules[0].sdk.target, 34);
  assert.equal(g.manifests[0].components[0].exported, null);
  assert.equal(g.dependencies[0].group, "com.google.firebase");
});
test("version catalog aliases resolve plugin identity and versions", async (t) => {
  const c = await fixture(t, {
    "gradle/libs.versions.toml":
      '[versions]\nfirebase="34.18.0"\n[plugins]\nandroid-application={ id="com.android.application",version="9.4.0" }\n[libraries]\nfirebase-bom={module="com.google.firebase:firebase-bom",version.ref="firebase"}',
    "app/build.gradle.kts":
      "plugins { alias(libs.plugins.android.application) }",
  });
  const g = await inspect(c.root);
  assert.equal(g.modules[0].kind, "application");
  assert.equal(g.dependencies[0].version, "34.18.0");
});
test("unknown computed SDK is null, never a false policy pass", async (t) => {
  const c = await fixture(t, {
    "build.gradle.kts":
      'plugins { id("com.android.application") }; android { targetSdk = libs.versions.target.get().toInt() }',
  });
  assert.equal((await inspect(c.root)).modules[0].sdk.target, null);
  assert.ok(
    (await audit(c.root, "play")).findings.some(
      (f) => f.rule === "SDK_UNRESOLVED",
    ),
  );
});
test(
  "scanner honors ignore rules and never follows symlinks",
  { skip: process.platform === "win32" },
  async (t) => {
    const c = await fixture(t, {
      "keep.kt": "ok",
      "secret.kt": "secret",
      ".androidagentignore": "secret.kt\n",
    });
    await symlink(join(c.root, "keep.kt"), join(c.root, "link.kt"));
    const s = await scan(c.root);
    assert.deepEqual(
      s.files.map((f) => f.path),
      ["keep.kt"],
    );
    assert.ok(s.limits.includes("symlinks skipped"));
  },
);
test(
  "managed files reject traversal and symlink ancestors",
  { skip: process.platform === "win32" },
  async (t) => {
    const c = await fixture(t, { "real/file.txt": "ok" });
    await assert.rejects(safePath(c.root, "../escape"));
    await symlink(join(c.root, "real"), join(c.root, "link"));
    await assert.rejects(safePath(c.root, "link/file.txt"));
  },
);
test("XML rejects entities and malformed input", () => {
  assert.throws(() => xml('<!DOCTYPE a [<!ENTITY x "bad">]><a>&x;</a>'));
  assert.throws(() => xml("<a>"));
});
test("audit detects unsafe Firebase rule with location", async (t) => {
  const c = await fixture(t, sample);
  const r = await audit(c.root, "firebase");
  assert.ok(
    r.findings.some(
      (f) =>
        f.rule === "FIREBASE_PUBLIC_RULE" &&
        f.severity === "critical" &&
        f.line === 1,
    ),
  );
});
test("commented insecure rules do not produce critical finding", async (t) => {
  const c = await fixture(t, {
    "firestore.rules":
      "// allow read, write: if true;\nallow read: if request.auth != null;",
  });
  assert.ok(
    !(await audit(c.root, "firebase")).findings.some(
      (f) => f.severity === "critical",
    ),
  );
});
test("policy thresholds differ by platform", async (t) => {
  const c = await fixture(t, sample);
  assert.ok(
    (await audit(c.root, "play", "phone")).findings.some(
      (f) => f.rule === "PLAY_TARGET_SDK",
    ),
  );
  assert.ok(
    !(await audit(c.root, "play", "tv")).findings.some(
      (f) => f.rule === "PLAY_TARGET_SDK",
    ),
  );
});
test("process runner preserves argv without shell expansion", async () => {
  const r = await run(process.execPath, [
    "-e",
    "console.log(process.argv[1])",
    "$(echo hacked); weird",
  ]);
  assert.equal(r.stdout.trim(), "$(echo hacked); weird");
});
test("failed subprocess never becomes successful evidence", async () => {
  const r = await run(process.execPath, ["-e", "process.exit(7)"]);
  assert.equal(r.exitCode, 7);
  assert.throws(() => checked(r));
});
test("timeouts terminate subprocess", async () => {
  const r = await run(process.execPath, ["-e", "setTimeout(()=>{},10000)"], {
    timeout: 50,
  });
  assert.equal(r.timedOut, true);
  assert.throws(() => checked(r));
});
test("process output cap reports truncation", async () => {
  const r = await run(process.execPath, [
    "-e",
    'process.stdout.write("x".repeat(3000000))',
  ]);
  assert.equal(r.truncated, true);
  assert.throws(() => checked(r));
});
test("redaction removes environment secrets and private keys", () => {
  process.env.TEST_SECRET = "private-example-value";
  assert.ok(
    !redact("key=private-example-value").includes("private-example-value"),
  );
  delete process.env.TEST_SECRET;
  assert.ok(
    !redact(
      "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    ).includes("abc"),
  );
});
test("confirmation is action-bound and consumed", async (t) => {
  const c = await fixture(t);
  let fingerprint;
  try {
    await authorize(c, "wipe", { name: "a" });
  } catch (e) {
    fingerprint = e.details.fingerprint;
  }
  await save(c.root, ".android-agent/confirmations.json", {
    [fingerprint]: { expiresAt: Date.now() + 10000 },
  });
  await assert.rejects(
    authorize({ ...c, confirm: fingerprint }, "wipe", { name: "b" }),
  );
  await authorize({ ...c, confirm: fingerprint }, "wipe", { name: "a" });
  await assert.rejects(
    authorize({ ...c, confirm: fingerprint }, "wipe", { name: "a" }),
  );
});
test("init refuses overwriting existing config", async (t) => {
  const c = await fixture(t);
  await execute(c, "init");
  await assert.rejects(execute(c, "init"));
});
test("dry-run init creates no file", async (t) => {
  const c = await fixture(t);
  assert.equal((await execute({ ...c, dryRun: true }, "init")).planned, true);
  await assert.rejects(readFile(join(c.root, ".android-agent.json")));
});
test("schema rejects unknown operation parameters", async (t) => {
  const c = await fixture(t);
  await assert.rejects(execute(c, "inspect", { unexpected: true }));
});
test("resumable run validates evidence and source fingerprint", async (t) => {
  const plan = {
    title: "Inspect",
    steps: [{ id: "inspect", operation: "inspect" }],
  };
  const c = await fixture(t, { "plan.json": JSON.stringify(plan), ...sample });
  const r = await createRun(c, "plan.json");
  assert.equal((await resumeRun(c, r.id)).status, "complete");
  assert.equal((await resumeRun(c, r.id)).status, "complete");
  await writeFile(join(c.root, "app/src/main/Main.kt"), "changed");
  await assert.rejects(resumeRun(c, r.id), /changed/);
});
test("run rejects tampered completed evidence", async (t) => {
  const c = await fixture(t, {
    "plan.json": JSON.stringify({
      title: "Inspect",
      steps: [{ id: "a", operation: "inspect" }],
    }),
  });
  const r = await createRun(c, "plan.json");
  const done = await resumeRun(c, r.id);
  await writeFile(join(c.root, done.steps[0].evidence.path), "tampered");
  await assert.rejects(resumeRun(c, r.id), /evidence changed/);
});
