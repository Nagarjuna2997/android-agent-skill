import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  AgentError,
  checked,
  evidence,
  safePath,
  hash,
  authorize,
  type Context,
} from "../core/index.js";
import { xml, array } from "../android/inspect.js";
export function tool(name: string) {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const ext = process.platform === "win32" ? ".exe" : "";
  return sdk && (name === "adb" || name === "emulator")
    ? join(sdk, name === "adb" ? "platform-tools" : "emulator", name + ext)
    : name;
}
export function parseDevices(s: string) {
  return s
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith("List ") && !l.startsWith("*"))
    .map((l) => {
      const [serial, state, ...fields] = l.trim().split(/\s+/);
      return {
        serial,
        state,
        properties: Object.fromEntries(
          fields
            .filter((x) => x.includes(":"))
            .map((x) => x.split(/:(.*)/s).slice(0, 2)),
        ),
      };
    });
}
export async function devices(ctx: Context) {
  return parseDevices(
    checked(
      await ctx.runner(tool("adb"), ["devices", "-l"], {
        timeout: ctx.timeout,
      }),
    ).stdout,
  );
}
export async function selectDevice(ctx: Context) {
  const list = await devices(ctx);
  if (ctx.device) {
    const d = list.find((d) => d.serial === ctx.device);
    if (!d || d.state !== "device")
      throw new AgentError(
        "DEVICE_UNAVAILABLE",
        "Selected device is absent, offline or unauthorized",
        list,
      );
    return ctx.device;
  }
  if (list.length !== 1 || list[0].state !== "device")
    throw new AgentError(
      "SELECT_DEVICE",
      "Specify --device with exactly one authorized device",
      list,
    );
  return list[0].serial;
}
export const validPackage = (s: string) => {
  if (!/^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/.test(s))
    throw new AgentError("INPUT", "Invalid Android package");
  return s;
};
const int = (n: unknown, min = 0, max = 100000) => {
  const v = Number(n);
  if (!Number.isInteger(v) || v < min || v > max)
    throw new AgentError("INPUT", `Expected integer ${min}..${max}`);
  return String(v);
};
export async function adb(
  ctx: Context,
  args: string[],
  sensitive = false,
  binary = false,
) {
  const serial = await selectDevice(ctx);
  if (ctx.dryRun)
    return { planned: true, serial, args: sensitive ? ["[REDACTED]"] : args };
  const result = checked(
    await ctx.runner(tool("adb"), ["-s", serial, ...args], {
      timeout: ctx.timeout,
      binary,
      redactArgs: sensitive,
    }),
  );
  return { serial, result };
}
export function uiNodes(text: string) {
  const tree = xml(text);
  const nodes: any[] = [];
  function visit(v: any) {
    if (!v || typeof v !== "object") return;
    if (v.bounds) {
      const b = String(v.bounds).match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
      nodes.push({
        text: v.password === "true" ? "[REDACTED]" : (v.text ?? ""),
        resourceId: v["resource-id"] ?? "",
        description:
          v.password === "true" ? "[REDACTED]" : (v["content-desc"] ?? ""),
        class: v.class,
        clickable: v.clickable === "true",
        enabled: v.enabled === "true",
        bounds: b ? b.slice(1).map(Number) : null,
      });
    }
    for (const [key, value] of Object.entries(v))
      if (key === "node" || key === "hierarchy")
        for (const item of array(value)) visit(item);
  }
  visit(tree);
  return nodes;
}
export async function uiInspect(ctx: Context) {
  const remote = `/sdcard/android-agent-${randomUUID()}.xml`;
  if (ctx.dryRun) return { planned: true, operation: "UI hierarchy capture" };
  await adb(ctx, ["shell", "uiautomator", "dump", remote]);
  try {
    const r = await adb(ctx, ["exec-out", "cat", remote]);
    if (!r.result) return r;
    const nodes = uiNodes(r.result.stdout);
    return {
      device: r.serial,
      nodes,
      evidence: await evidence(ctx, "ui", { device: r.serial, nodes }),
    };
  } finally {
    await adb(ctx, ["shell", "rm", remote]);
  }
}
export async function deviceAction(ctx: Context, action: string, p: any = {}) {
  let args: string[];
  const pkg = () => validPackage(p.package);
  switch (action) {
    case "info":
      return adb(ctx, ["shell", "getprop"]);
    case "install":
      args = ["install", "-r", await safePath(ctx.root, p.file)];
      break;
    case "uninstall":
      await authorize(ctx, "device.uninstall", {
        device: await selectDevice(ctx),
        package: pkg(),
      });
      args = ["uninstall", pkg()];
      break;
    case "launch":
      args = [
        "shell",
        "monkey",
        "-p",
        pkg(),
        "-c",
        "android.intent.category.LAUNCHER",
        "1",
      ];
      break;
    case "stop":
      args = ["shell", "am", "force-stop", pkg()];
      break;
    case "tap":
      args = ["shell", "input", "tap", int(p.x), int(p.y)];
      break;
    case "swipe":
      args = [
        "shell",
        "input",
        "swipe",
        int(p.x),
        int(p.y),
        int(p.x2),
        int(p.y2),
        int(p.duration ?? 300, 1, 10000),
      ];
      break;
    case "type":
      if (
        typeof p.text !== "string" ||
        !/^[a-zA-Z0-9 ._@+-]{1,500}$/.test(p.text)
      )
        throw new AgentError(
          "INPUT",
          "ADB text accepts ASCII letters, numbers, spaces and ._@+- only; use an IME for Unicode",
        );
      args = ["shell", "input", "text", p.text.replaceAll(" ", "%s")];
      break;
    case "back":
    case "home":
      args = ["shell", "input", "keyevent", action === "back" ? "4" : "3"];
      break;
    case "rotate":
      args = ["shell", "wm", "user-rotation", "lock", int(p.rotation, 0, 3)];
      break;
    case "logs":
      args = ["logcat", "-d", "-t", int(p.lines ?? 500, 1, 10000)];
      break;
    case "activity":
      args = ["shell", "dumpsys", "activity", "activities"];
      break;
    case "screenshot": {
      const path = await safePath(
        ctx.root,
        p.output ?? `screenshot-${Date.now()}.png`,
      );
      const r = await adb(ctx, ["exec-out", "screencap", "-p"], false, true);
      if (!r.result) return r;
      const bytes = r.result.binary!;
      if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
        throw new AgentError("SCREENSHOT", "Device did not produce PNG");
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      return {
        path,
        sha256: hash(bytes),
        device: r.serial,
        evidence: await evidence(ctx, "screenshot", {
          path,
          sha256: hash(bytes),
          device: r.serial,
        }),
      };
    }
    case "record": {
      const remote = `/sdcard/android-agent-${randomUUID()}.mp4`,
        path = await safePath(ctx.root, p.output ?? `record-${Date.now()}.mp4`);
      if (ctx.dryRun) return { planned: true, path };
      await adb(ctx, [
        "shell",
        "screenrecord",
        "--time-limit",
        int(p.duration ?? 10, 1, 180),
        remote,
      ]);
      try {
        const r = await adb(ctx, ["exec-out", "cat", remote], false, true);
        if (!r.result) return r;
        await writeFile(path, r.result.binary!, { flag: "wx", mode: 0o600 });
        return { path, sha256: hash(await readFile(path)) };
      } finally {
        await adb(ctx, ["shell", "rm", remote]);
      }
    }
    default:
      throw new AgentError("ACTION", "Unknown device action");
  }
  const r = await adb(ctx, args, action === "type");
  return {
    ...r,
    ...(!ctx.dryRun
      ? { evidence: await evidence(ctx, `device.${action}`, r) }
      : {}),
  };
}
export async function uiTap(
  ctx: Context,
  p: { text?: string; resourceId?: string },
) {
  const state = await uiInspect(ctx);
  if (!("nodes" in state) || !state.nodes) return state;
  const matches = state.nodes.filter(
    (n) =>
      n.enabled &&
      (p.resourceId ? n.resourceId === p.resourceId : n.text === p.text),
  );
  if (matches.length !== 1 || !matches[0].bounds)
    throw new AgentError(
      "UI_AMBIGUOUS",
      "Selector must match exactly one enabled element",
      matches,
    );
  const [x, y, x2, y2] = matches[0].bounds;
  return deviceAction(ctx, "tap", {
    x: Math.floor((x + x2) / 2),
    y: Math.floor((y + y2) / 2),
  });
}
