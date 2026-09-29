import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture, sample } from "./helpers.mjs";
import { run } from "../dist/core/index.js";
import {
  generate,
  ProviderConfig,
  orchestrate,
} from "../dist/providers/index.js";
import {
  renderScreenshot,
  validateScreenshot,
} from "../dist/screenshots/index.js";
import { docsSearch } from "../dist/docs/index.js";
const cli = resolve("dist/cli/index.js");
test("CLI help exits successfully", async () => {
  const r = await run(process.execPath, [cli, "--help"]);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /inspect/);
});
test("CLI inspect emits one machine readable document", async (t) => {
  const c = await fixture(t, sample);
  const r = await run(process.execPath, [
    cli,
    "inspect",
    "--project",
    c.root,
    "--json",
  ]);
  assert.equal(r.exitCode, 0, r.stderr);
  const value = JSON.parse(r.stdout);
  assert.equal(value.ok, true);
  assert.equal(value.result.projectType, "android-application");
});
test("CLI unknown command fails", async () => {
  const r = await run(process.execPath, [cli, "fake-command", "--json"]);
  assert.equal(r.exitCode, 1);
  assert.equal(JSON.parse(r.stdout).ok, false);
});
test("MCP stdio handshake, list and call inspection", async (t) => {
  const c = await fixture(t, sample);
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "--project", c.root, "mcp"],
    stderr: "pipe",
  });
  await client.connect(transport);
  t.after(() => client.close());
  const listing = await client.listTools();
  assert.ok(listing.tools.some((t) => t.name === "android_project_inspect"));
  assert.ok(!listing.tools.some((t) => t.name === "android_confirm"));
  const result = await client.callTool({
    name: "android_project_inspect",
    arguments: {},
  });
  assert.equal(result.isError, undefined);
  assert.equal(
    JSON.parse(result.content[0].text).projectType,
    "android-application",
  );
  const denied = await client.callTool({
    name: "android_device_home",
    arguments: {},
  });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /MUTATION_DISABLED/);
});
test("external provider is disabled before network", async () => {
  await assert.rejects(
    generate(
      "gemini",
      { model: "test", prompt: "secret" },
      ProviderConfig.parse({}),
      () => {
        throw Error("must not fetch");
      },
    ),
    /enable external/,
  );
});
test("local provider refuses a non-loopback endpoint", async () => {
  await assert.rejects(
    generate(
      "local",
      { model: "test", prompt: "a" },
      ProviderConfig.parse({
        localUrl: "https://example.com/v1/chat/completions",
      }),
    ),
    /loopback/,
  );
});
test("Gemini sends structured request and parses tool calls", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  try {
    const r = await generate(
      "gemini",
      {
        model: "test",
        prompt: "inspect",
        tools: [
          {
            name: "inspect",
            description: "Read project",
            parameters: { type: "object" },
          },
        ],
      },
      ProviderConfig.parse({ externalEnabled: true }),
      async (url, options) => {
        assert.match(url, /generateContent/);
        assert.equal(options.headers["x-goog-api-key"], "test-key");
        assert.equal(
          JSON.parse(options.body).tools[0].functionDeclarations[0].name,
          "inspect",
        );
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ functionCall: { name: "inspect", args: {} } }],
                },
              },
            ],
          }),
        );
      },
    );
    assert.equal(r.toolCalls[0].name, "inspect");
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});
test("OpenAI request disables response storage", async () => {
  process.env.OPENAI_API_KEY = "test-key";
  try {
    const r = await generate(
      "openai",
      { model: "test", prompt: "inspect" },
      ProviderConfig.parse({ externalEnabled: true }),
      async (_url, options) => {
        assert.equal(JSON.parse(options.body).store, false);
        return new Response(
          JSON.stringify({
            model: "observed",
            output: [{ content: [{ text: "ok" }] }],
          }),
        );
      },
    );
    assert.equal(r.model, "observed");
    assert.equal(r.text, "ok");
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});
test("fallback is explicit and records unavailable provider", async () => {
  const c = ProviderConfig.parse({
    provider: "gemini",
    models: { local: "test" },
    fallback: ["local"],
  });
  const r = await orchestrate(
    c,
    "analysis",
    { prompt: "a" },
    async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "local" } }] }),
      ),
  );
  assert.equal(r.attempts.length, 1);
  assert.equal(r.result.provider, "local");
});
test("local SSE streaming handles split chunks", async () => {
  const content =
    'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n';
  const r = await generate(
    "local",
    { model: "test", prompt: "a", stream: true },
    ProviderConfig.parse({}),
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(content.slice(0, 12)));
            c.enqueue(new TextEncoder().encode(content.slice(12)));
            c.close();
          },
        }),
      ),
  );
  assert.equal(r.text, "hello");
});
test("screenshots render opaque PNG without replacing source", async (t) => {
  const c = await fixture(t, {
    "template.json": JSON.stringify({
      width: 1080,
      height: 1920,
      caption: "A clearer day",
      layout: "stack",
    }),
  });
  const source = await sharp({
    create: { width: 360, height: 640, channels: 3, background: "#334455" },
  })
    .png()
    .toBuffer();
  await writeFile(join(c.root, "source.png"), source);
  const r = await renderScreenshot(c, {
    file: "source.png",
    template: "template.json",
    output: "result.png",
  });
  assert.equal(r.width, 1080);
  assert.equal((await validateScreenshot(c, "result.png")).valid, true);
  assert.deepEqual(await readFile(join(c.root, "source.png")), source);
  await assert.rejects(
    renderScreenshot(c, {
      file: "source.png",
      template: "template.json",
      output: "result.png",
    }),
    /exist/,
  );
});
test("offline documentation search returns source and unknown retrieval date", async (t) => {
  const c = await fixture(t);
  const r = await docsSearch(c, "Credential Manager passkeys");
  assert.ok(r.results[0].url.startsWith("https://developer.android.com/"));
  assert.equal(r.results[0].retrievedAt, null);
});
test("provider structured result is schema-validated", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  try {
    await assert.rejects(
      generate(
        "gemini",
        {
          model: "test",
          prompt: "a",
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        },
        ProviderConfig.parse({ externalEnabled: true }),
        async () =>
          new Response(
            JSON.stringify({
              candidates: [
                { content: { parts: [{ text: '{"ok":"not boolean"}' }] } },
              ],
            }),
          ),
      ),
      /does not match/,
    );
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});
test("unsupported stream tool mode fails before network", async () => {
  await assert.rejects(
    generate(
      "local",
      { model: "test", prompt: "a", stream: true, tools: [] },
      ProviderConfig.parse({}),
      () => {
        throw Error("must not fetch");
      },
    ),
    /not supported/,
  );
});
