# MCP client configuration

Every file here launches the same executable contract from this repository's README:

```sh
android-agent --project /absolute/path/to/android/app mcp
```

The server binds to one project root, speaks MCP over stdio, and refuses a client-supplied project root. Mutation tools (build, test, install, device input) are present but denied until `--allow-mutations` is added after `mcp`. Destructive operations still need a confirmation grant issued through the CLI; that tool is not exposed over MCP. Install the CLI first (`npm install -g` from this repository or a release) so `android-agent` is on `PATH`; otherwise give the full path to the binary in `command`.

JSON does not allow comments, so the placement notes live here. Replace `/absolute/path/to/android/app` with the real project root in every file.

| File | Client | Where it goes |
|---|---|---|
| `claude-code.json` | Claude Code | Merge into `.mcp.json` at the project root (shared with the team), or into `~/.claude.json` under `mcpServers` for a user-level server. Equivalent CLI: `claude mcp add android-agent -- android-agent --project /absolute/path mcp` |
| `codex.toml` | OpenAI Codex CLI | Merge into `~/.codex/config.toml` or the project's `.codex/config.toml` under `[mcp_servers.android-agent]` |
| `gemini-settings.json` | Gemini CLI | Merge into `~/.gemini/settings.json` or the project's `.gemini/settings.json` under `mcpServers`. `timeout` is in milliseconds; Gradle tasks can run long |
| `cursor.json` | Cursor | Save as `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` globally |
| `vscode-mcp.json` | VS Code (Copilot agent mode and other MCP hosts) | Save as `.vscode/mcp.json`. Uses `${workspaceFolder}` so the project path resolves automatically; VS Code keys the list as `servers`, not `mcpServers` |

Allow mutations, for example in `claude-code.json`:

```json
"args": ["--project", "/absolute/path/to/android/app", "mcp", "--allow-mutations"]
```

Do this only when the host and the user accept that the agent can run Gradle, install to devices and send input.

Client formats are from each vendor's documentation at the time of writing and are not individually certified by this repository (see `docs/INTEGRATIONS.md`). If a client rejects the file, check its current MCP settings reference; the `command` and `args` do not change.

Verify a configuration by asking the agent to call `android_project_inspect` and comparing the output with `android-agent inspect --project /absolute/path --json` run by hand.
