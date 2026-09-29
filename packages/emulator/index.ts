import { spawn } from "node:child_process";
import { tool, adb, selectDevice } from "../adb/index.js";
import {
  AgentError,
  checked,
  authorize,
  evidence,
  type Context,
} from "../core/index.js";
const name = (s: string) => {
  if (!/^[\w.-]{1,100}$/.test(s))
    throw new AgentError("INPUT", "Invalid AVD/snapshot name");
  return s;
};
export async function emulator(
  ctx: Context,
  action: string,
  p: any = {},
): Promise<any> {
  if (action === "list")
    return {
      avds: checked(
        await ctx.runner(tool("emulator"), ["-list-avds"], {
          timeout: ctx.timeout,
        }),
      )
        .stdout.trim()
        .split(/\r?\n/)
        .filter(Boolean),
    };
  if (action === "profiles")
    return checked(
      await ctx.runner("avdmanager", ["list", "device"], {
        timeout: ctx.timeout,
      }),
    );
  if (action === "create") {
    const avd = name(p.name);
    if (!/^system-images;android-\d+;[\w_-]+;[\w_-]+$/.test(p.image))
      throw new AgentError(
        "INPUT",
        "Specify installed system image: system-images;android-API;TAG;ABI",
      );
    const args = [
      "create",
      "avd",
      "--name",
      avd,
      "--package",
      p.image,
      "--device",
      name(p.profile),
    ];
    if (ctx.dryRun) return { planned: true, args };
    return checked(
      await ctx.runner("avdmanager", args, {
        timeout: ctx.timeout,
        input: "no\n",
      }),
    );
  }
  if (action === "launch" || action === "wipe") {
    const avd = name(p.name);
    const list = await emulator(ctx, "list");
    if (!list.avds?.includes(avd)) throw new AgentError("AVD", "AVD not found");
    if (action === "wipe") await authorize(ctx, "emulator.wipe", { name: avd });
    const args = [
      "-avd",
      avd,
      ...(p.headless ? ["-no-window", "-no-audio"] : []),
      ...(action === "wipe" ? ["-wipe-data"] : []),
    ];
    if (ctx.dryRun) return { planned: true, args };
    const child = spawn(tool("emulator"), args, {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    await new Promise<void>((ok, no) => {
      child.once("spawn", () => ok());
      child.once("error", no);
    });
    child.unref();
    return {
      pid: child.pid,
      status: "launch-requested",
      note: "Use boot-wait to verify boot; process creation alone is not boot success",
      evidence: await evidence(ctx, "emulator.launch", {
        pid: child.pid,
        avd,
        args,
      }),
    };
  }
  const serial = await selectDevice(ctx);
  if (!serial.startsWith("emulator-"))
    throw new AgentError("DEVICE", "Select an emulator serial");
  if (action === "stop") return adb(ctx, ["emu", "kill"]);
  if (action === "snapshot") {
    if (!["save", "load", "delete", "list"].includes(p.operation))
      throw new AgentError("INPUT", "Snapshot operation required");
    if (p.operation === "delete" || p.operation === "load")
      await authorize(ctx, `snapshot.${p.operation}`, {
        device: serial,
        name: name(p.name),
      });
    return adb(ctx, [
      "emu",
      "avd",
      "snapshot",
      p.operation,
      ...(p.operation === "list" ? [] : [name(p.name)]),
    ]);
  }
  if (action === "boot-wait") {
    if (ctx.dryRun) return { planned: true };
    const end = Date.now() + (ctx.timeout ?? 120000);
    while (Date.now() < end) {
      const r = await adb(
        { ...ctx, timeout: Math.min(5000, end - Date.now()) },
        ["shell", "getprop", "sys.boot_completed"],
      );
      if (r.result && r.result.stdout.trim() === "1")
        return {
          device: serial,
          booted: true,
          evidence: await evidence(ctx, "emulator.boot", {
            device: serial,
            booted: true,
          }),
        };
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new AgentError(
      "BOOT_TIMEOUT",
      "Emulator did not finish booting before deadline",
    );
  }
  throw new AgentError("ACTION", "Unknown emulator action");
}
