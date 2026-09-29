import { Ajv } from "ajv";
import { z } from "zod";
import { AgentError, redact } from "../core/index.js";
export const providerNames = ["gemini", "openai", "claude", "local"] as const;
export type ProviderName = (typeof providerNames)[number];
export const ProviderConfig = z
  .object({
    provider: z.enum([...providerNames, "auto"]).default("local"),
    models: z.record(z.string()).default({}),
    routes: z.record(z.enum(providerNames)).default({}),
    fallback: z.array(z.enum(providerNames)).default([]),
    externalEnabled: z.boolean().default(false),
    localUrl: z.string().default("http://127.0.0.1:11434/v1/chat/completions"),
  })
  .strict();
export interface Request {
  prompt: string;
  model: string;
  image?: { base64: string; mimeType: string };
  schema?: Record<string, unknown>;
  tools?: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }[];
  stream?: boolean;
  timeout?: number;
}
export interface Response {
  provider: ProviderName;
  model: string;
  text: string;
  toolCalls: unknown[];
  usage: unknown;
  structured?: unknown;
}
const keys = {
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  claude: "ANTHROPIC_API_KEY",
  local: "",
};
export async function generate(
  provider: ProviderName,
  req: Request,
  config: z.infer<typeof ProviderConfig>,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (req.stream && (req.tools || req.schema))
    throw new AgentError(
      "CAPABILITY",
      "Streaming tools/structured output are not supported; use non-streaming mode",
    );
  const validate = req.schema
    ? new Ajv({ strict: true, allErrors: true }).compile(req.schema)
    : null;
  if (provider !== "local" && !config.externalEnabled)
    throw new AgentError(
      "EXTERNAL_DISABLED",
      "Explicitly enable external providers before sending any context",
    );
  const key = keys[provider] ? process.env[keys[provider]] : undefined;
  if (provider !== "local" && !key)
    throw new AgentError(
      "PROVIDER_UNAVAILABLE",
      `${keys[provider]} is not set`,
    );
  let url = "",
    body: any = {},
    headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider === "gemini") {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:${req.stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    headers["x-goog-api-key"] = key!;
    body = {
      contents: [
        {
          role: "user",
          parts: [
            { text: req.prompt },
            ...(req.image
              ? [
                  {
                    inlineData: {
                      mimeType: req.image.mimeType,
                      data: req.image.base64,
                    },
                  },
                ]
              : []),
          ],
        },
      ],
      ...(req.schema
        ? {
            generationConfig: {
              responseMimeType: "application/json",
              responseJsonSchema: req.schema,
            },
          }
        : {}),
      ...(req.tools ? { tools: [{ functionDeclarations: req.tools }] } : {}),
    };
  } else if (provider === "openai") {
    url = "https://api.openai.com/v1/responses";
    headers.Authorization = `Bearer ${key}`;
    body = {
      model: req.model,
      store: false,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: req.prompt },
            ...(req.image
              ? [
                  {
                    type: "input_image",
                    image_url: `data:${req.image.mimeType};base64,${req.image.base64}`,
                  },
                ]
              : []),
          ],
        },
      ],
      ...(req.schema
        ? {
            text: {
              format: {
                type: "json_schema",
                name: "result",
                schema: req.schema,
                strict: true,
              },
            },
          }
        : {}),
      ...(req.tools
        ? { tools: req.tools.map((t) => ({ ...t, type: "function" })) }
        : {}),
      stream: req.stream ?? false,
    };
  } else if (provider === "claude") {
    url = "https://api.anthropic.com/v1/messages";
    headers["x-api-key"] = key!;
    headers["anthropic-version"] = "2023-06-01";
    body = {
      model: req.model,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: req.prompt },
            ...(req.image
              ? [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: req.image.mimeType,
                      data: req.image.base64,
                    },
                  },
                ]
              : []),
          ],
        },
      ],
      ...(req.tools
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
      stream: req.stream ?? false,
    };
    if (req.schema)
      throw new AgentError(
        "CAPABILITY",
        "Claude schema output is not implemented by this adapter",
      );
  } else {
    const parsed = new URL(config.localUrl);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
      parsed.username ||
      parsed.password
    )
      throw new AgentError(
        "LOCAL_ENDPOINT",
        "Local endpoint must use loopback without credentials",
      );
    if (req.image || req.tools || req.schema)
      throw new AgentError(
        "CAPABILITY",
        "Local adapter currently supports text only",
      );
    url = parsed.href;
    body = {
      model: req.model,
      messages: [{ role: "user", content: req.prompt }],
      stream: req.stream ?? false,
    };
  }
  const response = await fetcher(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(req.timeout ?? 60000),
    redirect: "error",
  });
  if (!response.ok)
    throw new AgentError(
      response.status === 429 || response.status >= 500
        ? "PROVIDER_UNAVAILABLE"
        : "PROVIDER_REQUEST",
      `Provider returned HTTP ${response.status}; response body omitted`,
    );
  if (req.stream) {
    if (req.tools || req.schema)
      throw new AgentError(
        "CAPABILITY",
        "Streaming tools/structured output are not supported; use non-streaming mode",
      );
    let text = "",
      size = 0,
      buffer = "";
    const decoder = new TextDecoder();
    if (!response.body)
      throw new AgentError("PROVIDER_RESPONSE", "No stream body");
    for await (const chunk of response.body as any) {
      size += chunk.length;
      if (size > 4e6)
        throw new AgentError("OUTPUT_LIMIT", "Provider stream too large");
      buffer += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]")
          continue;
        const data = JSON.parse(line.slice(5));
        text +=
          provider === "gemini"
            ? (data.candidates?.[0]?.content?.parts ?? [])
                .map((p: any) => p.text ?? "")
                .join("")
            : provider === "openai"
              ? data.type === "response.output_text.delta"
                ? data.delta
                : ""
              : provider === "claude"
                ? (data.delta?.text ?? "")
                : (data.choices?.[0]?.delta?.content ?? "");
      }
    }
    return {
      provider,
      model: req.model,
      text: redact(text),
      toolCalls: [],
      usage: null,
    };
  }
  let raw = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  if (!response.body)
    throw new AgentError("PROVIDER_RESPONSE", "No response body");
  for await (const chunk of response.body as any) {
    bytes += chunk.length;
    if (bytes > 4e6)
      throw new AgentError("OUTPUT_LIMIT", "Provider output too large");
    raw += decoder.decode(chunk, { stream: true });
  }
  raw += decoder.decode();
  const data = JSON.parse(raw);
  let text = "",
    toolCalls: any[] = [];
  if (provider === "gemini") {
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    text = parts.map((p: any) => p.text ?? "").join("");
    toolCalls = parts
      .filter((p: any) => p.functionCall)
      .map((p: any) => p.functionCall);
  } else if (provider === "openai") {
    text = (data.output ?? [])
      .flatMap((o: any) => o.content ?? [])
      .map((p: any) => p.text ?? "")
      .join("");
    toolCalls = (data.output ?? []).filter(
      (o: any) => o.type === "function_call",
    );
  } else if (provider === "claude") {
    text = (data.content ?? [])
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("");
    toolCalls = (data.content ?? []).filter((p: any) => p.type === "tool_use");
  } else {
    text = data.choices?.[0]?.message?.content ?? "";
  }
  if (!text && !toolCalls.length)
    throw new AgentError("PROVIDER_RESPONSE", "No usable content");
  if (validate && !validate(JSON.parse(text)))
    throw new AgentError(
      "PROVIDER_SCHEMA",
      "Provider JSON does not match requested schema",
    );
  return {
    provider,
    model: data.model ?? req.model,
    text: redact(text),
    toolCalls,
    usage: data.usage ?? data.usageMetadata ?? null,
    ...(req.schema ? { structured: JSON.parse(text) } : {}),
  };
}
export async function orchestrate(
  config: z.infer<typeof ProviderConfig>,
  task: string,
  request: Omit<Request, "model">,
  fetcher: typeof fetch = fetch,
) {
  const first =
    config.provider === "auto"
      ? (config.routes[task] ?? "local")
      : config.provider;
  const attempts: any[] = [];
  for (const provider of [...new Set([first, ...config.fallback])]) {
    try {
      const model =
        config.models[provider] ??
        process.env[`${provider.toUpperCase()}_MODEL`];
      if (!model)
        throw new AgentError(
          "PROVIDER_UNAVAILABLE",
          `No model configured for ${provider}`,
        );
      return {
        result: await generate(
          provider,
          { ...request, model },
          config,
          fetcher,
        ),
        attempts,
      };
    } catch (e) {
      attempts.push({ provider, error: (e as Error).message });
      if (!(e instanceof AgentError) || e.code !== "PROVIDER_UNAVAILABLE")
        throw e;
    }
  }
  throw new AgentError(
    "PROVIDERS_FAILED",
    "No configured provider succeeded",
    attempts,
  );
}
