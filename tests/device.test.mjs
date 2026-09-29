import test from "node:test";
import assert from "node:assert/strict";
import { fixture, fakeRunner } from "./helpers.mjs";
import {
  selectDevice,
  deviceAction,
  uiNodes,
  uiTap,
} from "../dist/adb/index.js";
import { gradle } from "../dist/gradle/index.js";
test("multiple devices require explicit selection", async (t) => {
  const c = await fixture(t);
  c.runner = fakeRunner("List of devices attached\na\tdevice\nb\tdevice\n");
  await assert.rejects(selectDevice(c), /Specify --device/);
  assert.equal(await selectDevice({ ...c, device: "b" }), "b");
});
test("offline or unauthorized selection fails", async (t) => {
  const c = await fixture(t);
  c.runner = fakeRunner("a\tunauthorized\n");
  await assert.rejects(selectDevice({ ...c, device: "a" }), /unauthorized/);
});
test("shell metacharacters in device text are rejected before execution", async (t) => {
  const c = await fixture(t);
  c.runner = () => {
    throw Error("must not execute");
  };
  await assert.rejects(
    deviceAction(c, "type", { text: "hello;reboot" }),
    /ASCII/,
  );
});
test("device mutation uses selected serial and bounded argv", async (t) => {
  const c = await fixture(t);
  const calls = [];
  c.runner = async (cmd, args) => {
    calls.push(args);
    return fakeRunner(args[0] === "devices" ? "a\tdevice\n" : "ok")(cmd, args);
  };
  await deviceAction(c, "tap", { x: 40, y: 80 });
  assert.deepEqual(calls[1], ["-s", "a", "shell", "input", "tap", "40", "80"]);
});
test("UI parser masks password content and returns bounds", () => {
  const nodes = uiNodes(
    '<hierarchy><node text="secret" password="true" bounds="[0,0][20,40]" clickable="true" enabled="true"/></hierarchy>',
  );
  assert.equal(nodes[0].text, "[REDACTED]");
  assert.deepEqual(nodes[0].bounds, [0, 0, 20, 40]);
});
test("ambiguous UI selector refuses tap", async (t) => {
  const c = await fixture(t);
  c.runner = async (cmd, args) =>
    fakeRunner(
      args[0] === "devices"
        ? "a\tdevice\n"
        : args.includes("cat")
          ? '<hierarchy><node text="OK" enabled="true" bounds="[0,0][2,2]"/><node text="OK" enabled="true" bounds="[0,0][2,2]"/></hierarchy>'
          : "",
    )(cmd, args);
  await assert.rejects(uiTap(c, { text: "OK" }), /exactly one/);
});
test("Gradle missing wrapper is actionable failure", async (t) => {
  const c = await fixture(t);
  await assert.rejects(gradle(c, "build"), /wrapper missing/);
});
test("Gradle rejects task injection", async (t) => {
  const c = await fixture(t);
  await assert.rejects(
    gradle(c, "build", { variant: "Debug;rm" }),
    /Invalid variant/,
  );
});
