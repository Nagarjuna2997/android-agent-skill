import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { audit } from "../dist/analysis/index.js";
import { hash } from "../dist/core/index.js";
const cases = [
  {
    id: "firebase-public",
    file: "firestore.rules",
    broken: "allow read, write: if true;",
    fixed: "allow read, write: if request.auth != null;",
    rule: "FIREBASE_PUBLIC_RULE",
    category: "firebase",
  },
  {
    id: "compose-global",
    file: "Main.kt",
    broken: "fun work() { GlobalScope.launch { doWork() } }",
    fixed: "fun work(scope: CoroutineScope) { scope.launch { doWork() } }",
    rule: "KOTLIN_GLOBAL_SCOPE",
    category: "compose",
  },
  {
    id: "cleartext",
    file: "Main.kt",
    broken: 'val endpoint = "http://example.com/api"',
    fixed: 'val endpoint = "https://example.com/api"',
    rule: "INSECURE_HTTP",
    category: "security",
  },
  {
    id: "play-target",
    file: "app/build.gradle.kts",
    broken:
      'plugins { id("com.android.application") }; android { targetSdk = 34 }',
    fixed:
      'plugins { id("com.android.application") }; android { targetSdk = 37 }',
    rule: "PLAY_TARGET_SDK",
    category: "play",
  },
  {
    id: "exported",
    file: "app/src/main/AndroidManifest.xml",
    broken:
      '<manifest><application><activity android:name=".Main"><intent-filter><action android:name="android.intent.action.MAIN"/></intent-filter></activity></application></manifest>',
    fixed:
      '<manifest><application><activity android:name=".Main" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/></intent-filter></activity></application></manifest>',
    rule: "MANIFEST_EXPORTED",
    category: "play",
  },
];
const results = [];
for (const c of cases) {
  const root = await mkdtemp(join(tmpdir(), "android-bench-"));
  try {
    await mkdir(dirname(join(root, c.file)), { recursive: true });
    const start = performance.now();
    await writeFile(join(root, c.file), c.broken);
    const before = await audit(root, c.category);
    await writeFile(join(root, c.file), c.fixed);
    const after = await audit(root, c.category);
    results.push({
      id: c.id,
      validated:
        before.findings.some((f) => f.rule === c.rule) &&
        !after.findings.some((f) => f.rule === c.rule),
      durationMs: Math.round((performance.now() - start) * 100) / 100,
      inputHash: hash(c.broken),
      repairHash: hash(c.fixed),
      toolCalls: 2,
      build: null,
      tests: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const report = {
  schemaVersion: 1,
  purpose: "fixture-validation-NOT-agent-comparison",
  comparisonRun: false,
  model: null,
  client: null,
  node: process.version,
  platform: process.platform,
  at: new Date().toISOString(),
  results,
};
await writeFile(
  "benchmarks/results.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (results.some((r) => !r.validated)) process.exitCode = 1;
