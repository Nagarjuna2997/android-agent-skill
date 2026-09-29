import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { run } from "../dist/core/index.js";
export async function fixture(t, files = {}) {
  const root = await mkdtemp(join(tmpdir(), "android-agent-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [p, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), text);
  }
  return { root, runner: run };
}
export const sample = {
  "settings.gradle.kts": 'include(":app")',
  "app/build.gradle.kts":
    'plugins { id("com.android.application") }\nandroid { compileSdk = 37\n defaultConfig { applicationId = "example.demo"; minSdk = 24; targetSdk = 34; versionCode = 1 }\n buildFeatures { compose = true } }\ndependencies { implementation("com.google.firebase:firebase-auth:23.0.0") }',
  "app/src/main/AndroidManifest.xml":
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><uses-permission android:name="android.permission.CAMERA"/><application><activity android:name=".MainActivity"><intent-filter><action android:name="android.intent.action.MAIN"/></intent-filter></activity></application></manifest>',
  "app/src/main/Main.kt": '@Composable fun Greeting() { Text("Hello") }',
  "firestore.rules":
    'rules_version = "2"; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }',
};
export function fakeRunner(stdout = "", exitCode = 0) {
  return async (command, args) => ({
    command,
    args,
    stdout,
    stderr: "",
    exitCode,
    durationMs: 1,
    timedOut: false,
    truncated: false,
    startedAt: new Date().toISOString(),
  });
}
