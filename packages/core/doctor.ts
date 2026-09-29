import { access, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { type Context } from "./index.js";
import { tool, parseDevices } from "../adb/index.js";
export async function doctor(ctx: Context) {
  const checks: any[] = [];
  const list: [string, string[], boolean][] = [
    ["java", ["-version"], true],
    ["adb", ["version"], true],
    ["emulator", ["-version"], false],
    ["sdkmanager", ["--version"], false],
    ["avdmanager", ["list", "avd"], false],
    ["gradle", ["--version"], false],
    ["kotlinc", ["-version"], false],
    ["node", ["--version"], true],
    ["npm", ["--version"], false],
    ["firebase", ["--version"], false],
    ["gcloud", ["--version"], false],
    ["bundletool", ["version"], false],
  ];
  await Promise.all(
    list.map(async ([name, args, required]) => {
      try {
        const r = await ctx.runner(tool(name), args, { timeout: 10000 });
        checks.push({
          name,
          status: r.exitCode === 0 ? "PASS" : required ? "FAIL" : "WARNING",
          detail: (r.stdout || r.stderr).slice(0, 600),
          remediation:
            r.exitCode === 0
              ? null
              : `Install/configure ${name} and expose it on PATH.`,
        });
      } catch {
        checks.push({
          name,
          status: required ? "FAIL" : "WARNING",
          detail: "Not available",
          remediation: `Install/configure ${name}; optional tools are only needed for their commands.`,
        });
      }
    }),
  );
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  checks.push({
    name: "Android SDK",
    status: sdk ? "PASS" : "WARNING",
    detail: sdk ?? "No SDK environment configured",
    remediation: "Set ANDROID_HOME to the SDK directory.",
  });
  for (const variable of ["JAVA_HOME", "ANDROID_HOME"])
    checks.push({
      name: variable,
      status: process.env[variable] ? "PASS" : "WARNING",
      detail: process.env[variable] ?? "Not set",
    });
  try {
    await access(
      join(ctx.root, process.platform === "win32" ? "gradlew.bat" : "gradlew"),
    );
    checks.push({ name: "Gradle wrapper", status: "PASS" });
  } catch {
    checks.push({
      name: "Gradle wrapper",
      status: "WARNING",
      detail: "No wrapper in selected project",
    });
  }
  if (sdk)
    for (const component of ["platforms", "build-tools", "platform-tools"])
      try {
        checks.push({
          name: component,
          status: "PASS",
          installed: await readdir(join(sdk, component)),
        });
      } catch {
        checks.push({
          name: component,
          status: "WARNING",
          detail: "SDK component directory missing",
        });
      }
  try {
    const r = await ctx.runner(tool("adb"), ["devices", "-l"], {
      timeout: 10000,
    });
    checks.push({
      name: "connected devices",
      status: r.exitCode === 0 ? "PASS" : "WARNING",
      devices: parseDevices(r.stdout),
    });
  } catch {
    /* adb check already explains */
  }
  try {
    const s = await statfs(ctx.root);
    checks.push({
      name: "disk space",
      status: s.bavail * s.bsize > 5e9 ? "PASS" : "WARNING",
      availableBytes: s.bavail * s.bsize,
    });
  } catch {
    /* unsupported filesystem */
  }
  return {
    checks: checks.sort((a, b) => a.name.localeCompare(b.name)),
    ready: !checks.some((c) => c.status === "FAIL"),
  };
}
