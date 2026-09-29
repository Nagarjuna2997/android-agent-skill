import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { operations, execute } from "../core/registry.js";
import { AgentError, redact, type Context } from "../core/index.js";
export function createServer(ctx: Context, allowMutations = false) {
  const server = new McpServer({
    name: "android-agent-skill",
    version: "0.1.0",
  });
  for (const op of operations.filter(
    (o) =>
      !o.command.startsWith("confirm") &&
      !o.command.startsWith("models set") &&
      o.command !== "init",
  )) {
    server.registerTool(
      op.name,
      {
        description:
          op.description + (op.mutates ? " Changes local/device state." : ""),
        inputSchema: {
          ...op.schema.shape,
          device: z.string().optional(),
          dryRun: z.boolean().optional(),
          confirmation: z.string().optional(),
        },
        annotations: {
          readOnlyHint: !op.mutates,
          destructiveHint: op.destructive,
          idempotentHint: !op.mutates,
          openWorldHint:
            op.command.startsWith("agent ") || op.command.startsWith("docs "),
        },
      },
      async (args: any) => {
        const { device, dryRun, confirmation, ...params } = args;
        try {
          if (op.mutates && !allowMutations && !dryRun)
            throw new AgentError(
              "MUTATION_DISABLED",
              "Restart server with --allow-mutations after reviewing its command scope",
            );
          const result = await execute(
            {
              ...ctx,
              device: device ?? ctx.device,
              dryRun,
              confirm: confirmation,
            },
            op.name,
            params,
          );
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: { result },
          };
        } catch (e) {
          const error = {
            code: e instanceof AgentError ? e.code : "ERROR",
            message: redact((e as Error).message),
            details: e instanceof AgentError ? e.details : null,
          };
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(error) }],
          };
        }
      },
    );
  }
  return server;
}
export async function serve(ctx: Context, allowMutations = false) {
  await createServer(ctx, allowMutations).connect(new StdioServerTransport());
}
