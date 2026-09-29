import { readFile } from "node:fs/promises";
import { scan, type Source } from "../core/index.js";
import { inspect, location, uncomment } from "../android/inspect.js";
export interface Finding {
  rule: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: string;
  file: string;
  line: number;
  message: string;
  remediation: string;
  confidence: "high" | "medium";
  classification: "technical" | "policy-concern" | "recommendation";
}
const catalogURL = new URL("../../data/versions.json", import.meta.url);
export async function versions() {
  return JSON.parse(await readFile(catalogURL, "utf8"));
}
export async function audit(
  root: string,
  category = "all",
  platform = "phone",
) {
  const graph = await inspect(root),
    input = await scan(root),
    findings: Finding[] = [];
  const add = (
    f: Source,
    index: number,
    rule: string,
    severity: Finding["severity"],
    cat: string,
    message: string,
    remediation: string,
    confidence: Finding["confidence"] = "medium",
    classification: Finding["classification"] = "recommendation",
  ) => {
    if (
      category !== "all" &&
      cat !== category &&
      !(
        category === "play" &&
        ["privacy", "permissions", "security"].includes(cat)
      )
    )
      return;
    findings.push({
      rule,
      severity,
      category: cat,
      ...location(f, index),
      message,
      remediation,
      confidence,
      classification,
    });
  };
  for (const f of input.files) {
    const code = uncomment(f.content);
    const checks: [
      RegExp,
      string,
      Finding["severity"],
      string,
      string,
      string,
    ][] = [
      [
        /\bGlobalScope\s*\./g,
        "KOTLIN_GLOBAL_SCOPE",
        "medium",
        "compose",
        "Unstructured coroutine scope",
        "Use a lifecycle-owned scope and preserve cancellation.",
      ],
      [
        /\bThread\s*\.\s*sleep\s*\(/g,
        "BLOCKING_SLEEP",
        "medium",
        "performance",
        "Blocking sleep found; calling thread is not inferred",
        "Use suspending delay where appropriate and verify call context.",
      ],
      [
        /\brunBlocking\s*[({]/g,
        "BLOCKING_COROUTINE",
        "medium",
        "compose",
        "Blocking coroutine boundary requires review",
        "Verify this cannot run on the UI thread.",
      ],
      [
        /\bText\s*\(\s*(?:text\s*=\s*)?"[^"\n]+"/g,
        "HARDCODED_TEXT",
        "low",
        "compose",
        "Literal UI text may prevent localization",
        "Use stringResource for user-facing copy.",
      ],
      [
        /\bmutableStateOf\s*\(/g,
        "COMPOSE_STATE_REVIEW",
        "info",
        "compose",
        "Verify state lifetime at this declaration",
        "Inside composition, retain state with remember or hoist it; static matching cannot infer lifetime.",
      ],
      [
        /\b(?:rememberCoroutineScope|LaunchedEffect)\s*\(/g,
        "COMPOSE_EFFECT_REVIEW",
        "info",
        "compose",
        "Review effect ownership and keys",
        "Check cancellation and changing captures; use lifecycle-aware collection for UI flows.",
      ],
      [
        /http:\/\/[^\s"']+/g,
        "INSECURE_HTTP",
        "medium",
        "security",
        "Cleartext URL found",
        "Use HTTPS for network traffic; verify local development exceptions.",
      ],
      [
        /\bjcenter\s*\(/g,
        "JCENTER",
        "medium",
        "security",
        "Legacy dependency repository",
        "Migrate dependencies to maintained repositories and verify coordinates.",
      ],
      [
        /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g,
        "PRIVATE_KEY",
        "critical",
        "security",
        "Private key material found (value omitted)",
        "Remove from source, rotate credentials, and review Git history.",
      ],
      [
        /"type"\s*:\s*"service_account"/g,
        "SERVICE_ACCOUNT",
        "critical",
        "firebase",
        "Service account configuration found (values omitted)",
        "Keep server credentials out of Android source; rotate if exposed.",
      ],
      [
        /\b(?:allow\s+[^;:]+:\s*if\s+true)\s*;/g,
        "FIREBASE_PUBLIC_RULE",
        "critical",
        "firebase",
        "Unconditional Firebase rule grants access",
        "Restrict access with authenticated ownership/role checks and test deny cases.",
      ],
      [
        /request\.time\s*<\s*timestamp\.date\s*\(/g,
        "FIREBASE_TEST_MODE",
        "high",
        "firebase",
        "Time-limited test-mode rule found",
        "Replace time-based public access with explicit authorization rules.",
      ],
      [
        /FirebaseAppCheck|DebugAppCheckProviderFactory/g,
        "APPCHECK_REVIEW",
        "info",
        "firebase",
        "App Check configuration requires release review",
        "Verify release provider and server enforcement; presence alone is not enforcement.",
      ],
      [
        /android:contentDescription\s*=\s*""/g,
        "EMPTY_LABEL",
        "medium",
        "accessibility",
        "Empty content description",
        "Label meaningful controls; mark decorative elements appropriately.",
      ],
      [
        /android:(?:layout_width|layout_height)\s*=\s*"(?:[1-9]|[1-3][0-9]|4[0-7])dp"/g,
        "SMALL_DIMENSION",
        "low",
        "accessibility",
        "Dimension below 48dp; touch area is unknown",
        "Verify actual clickable bounds and parent touch delegation.",
      ],
    ];
    for (const [re, rule, severity, cat, message, fix] of checks) {
      if (cat === "compose" && !f.path.endsWith(".kt")) continue;
      if (rule.startsWith("FIREBASE_") && !f.path.endsWith(".rules")) continue;
      for (const m of code.matchAll(re))
        add(
          f,
          m.index,
          rule,
          severity,
          cat,
          message,
          fix,
          rule === "FIREBASE_PUBLIC_RULE" ? "high" : "medium",
        );
    }
    if (f.path.endsWith(".rules") && !/request\.auth/.test(code))
      add(
        f,
        0,
        "FIREBASE_AUTH_REVIEW",
        "medium",
        "firebase",
        "No direct request.auth reference found",
        "Review authorization, including helper functions; absence is not proof of public access.",
      );
  }
  for (const m of graph.manifests) {
    const f = input.files.find((f) => f.path === m.file)!;
    for (const permission of m.permissions) {
      const sensitive =
        /LOCATION|CAMERA|RECORD_AUDIO|CONTACTS|AD_ID|BLUETOOTH|BODY_SENSORS|HEALTH|MANAGE_EXTERNAL_STORAGE|READ_SMS/.test(
          permission,
        );
      add(
        f,
        Math.max(0, f.content.indexOf(permission)),
        "PERMISSION_REVIEW",
        sensitive ? "medium" : "info",
        "permissions",
        `Declared permission: ${permission}`,
        "Verify necessity, runtime prompts and applicable Play declarations.",
        "high",
        "policy-concern",
      );
      if (sensitive)
        add(
          f,
          Math.max(0, f.content.indexOf(permission)),
          "DATA_SAFETY_REVIEW",
          "info",
          "privacy",
          `Review data handling associated with ${permission}`,
          "Map actual collection, sharing, retention and SDK behavior; permission alone does not prove collection.",
          "high",
          "policy-concern",
        );
    }
    for (const c of m.components) {
      if (c.intentFilters.length && c.exported === null)
        add(
          f,
          Math.max(0, f.content.indexOf(c.name)),
          "MANIFEST_EXPORTED",
          "high",
          "play",
          `${c.kind} ${c.name} has intent filters without explicit exported`,
          "Set exported deliberately; check the merged release manifest.",
          "high",
          "technical",
        );
    }
    if (m.application.debuggable === "true")
      add(
        f,
        0,
        "DEBUGGABLE",
        "high",
        "play",
        "Manifest explicitly enables debugging",
        "Ensure release merged manifest disables debugging.",
        "high",
        "technical",
      );
    if (m.application.usesCleartextTraffic === "true")
      add(
        f,
        0,
        "CLEARTEXT_ENABLED",
        "medium",
        "security",
        "Cleartext network traffic enabled",
        "Scope justified exceptions in Network Security Config.",
      );
  }
  const catalog = await versions(),
    target = catalog.policy.newAppsAndUpdates[platform];
  if (!target) throw Error("Unknown Play platform");
  for (const mod of graph.modules.filter((m) => m.kind === "application")) {
    const f = input.files.find((f) => f.path === mod.gradleFile)!;
    if (mod.sdk.target !== null && mod.sdk.target < target)
      add(
        f,
        0,
        "PLAY_TARGET_SDK",
        "high",
        "play",
        `Declared target ${mod.sdk.target} is below ${platform} submission threshold ${target}`,
        "Verify current official policy and the selected release variant; update with behavior testing.",
        "high",
        "policy-concern",
      );
    if (mod.sdk.target === null)
      add(
        f,
        0,
        "SDK_UNRESOLVED",
        "info",
        "play",
        "Target SDK could not be resolved statically",
        "Inspect effective Gradle variant; no compliance verdict is possible.",
      );
  }
  if (graph.frameworks.includes("firebase")) {
    const f = input.files.find(
      (f) =>
        f.path.endsWith("build.gradle.kts") || f.path.endsWith("build.gradle"),
    )!;
    if (f && !input.files.some((f) => f.path.endsWith("google-services.json")))
      add(
        f,
        0,
        "FIREBASE_CONFIG",
        "medium",
        "firebase",
        "No included google-services.json found",
        "Check variant-specific configuration or intentional programmatic FirebaseOptions setup.",
      );
  }
  return {
    schemaVersion: 1,
    category,
    findings,
    summary: Object.fromEntries(
      ["critical", "high", "medium", "low", "info"].map((s) => [
        s,
        findings.filter((f) => f.severity === s).length,
      ]),
    ),
    coverage: {
      files: input.files.length,
      warnings: [...graph.warnings, ...input.limits],
    },
    policy: {
      verifiedAt: catalog.verifiedAt,
      source: catalog.policy.source,
      stale: Date.now() > Date.parse(catalog.reviewAfter),
    },
    limitations: [
      "Heuristic source review, not Kotlin type analysis, merged manifest validation, deployed Firebase rules verification, legal compliance or Play approval.",
      "Runtime contrast, focus order, recomposition and performance need device measurements.",
    ],
  };
}
export function crashAnalyze(text: string) {
  const lines = text.split(/\r?\n/);
  return {
    fatal: lines
      .filter((l) =>
        /FATAL EXCEPTION|AndroidRuntime|Caused by:|ANR in |Reason:|OutOfMemoryError/.test(
          l,
        ),
      )
      .slice(0, 100),
    frames: lines
      .filter((l) => /^\s*(?:\S+\s+)*at\s+[\w.$]+\(/.test(l))
      .slice(0, 60),
    limitations: [
      "Symbolication requires matching mapping.txt/native symbols; log excerpt is not a proven root cause.",
    ],
  };
}
