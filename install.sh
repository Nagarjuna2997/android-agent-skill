#!/usr/bin/env bash
# Installs the source skill (SKILL.md plus patterns, capabilities, checklists,
# docs and templates) into a coding agent's skills directory. MCP/CLI tooling
# is installed separately with npm; see README.md.
set -euo pipefail
REPO_URL="${ANDROID_AGENT_SKILL_REPO_URL:-https://github.com/Nagarjuna2997/android-agent-skill.git}"
usage() {
  cat <<'HELP'
Usage: bash install.sh --client claude|codex|cursor [--dir PATH]
       bash install.sh --client gemini

claude  -> ./.claude/skills/android-agent-skill   (project-local; also readable as CLAUDE.md)
codex   -> ~/.codex/skills/android-agent-skill
cursor  -> ./.cursor/skills/android-agent-skill
gemini  -> prints the Gemini CLI setup (GEMINI.md context file) without changing files

The installer clones or fast-forwards a checkout of this repository. It does not
install the Android SDK, Java or the android-agent CLI. For the CLI/MCP server:
  git clone https://github.com/Nagarjuna2997/android-agent-skill.git && cd android-agent-skill
  npm ci && npm run build && npm link
HELP
}
client=''; target=''
while (($#)); do
  case "$1" in
    --client|--dir)
      (($# >= 2)) || { usage >&2; exit 1; }
      if [[ "$1" == --client ]]; then client="$2"; else target="$2"; fi
      shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done
case "$client" in
  claude) target="${target:-$PWD/.claude/skills/android-agent-skill}" ;;
  codex)  target="${target:-$HOME/.codex/skills/android-agent-skill}" ;;
  cursor) target="${target:-$PWD/.cursor/skills/android-agent-skill}" ;;
  gemini)
    [[ -z "$target" ]] || { echo '--dir is only for source-skill installation.' >&2; exit 1; }
    echo 'Gemini CLI reads GEMINI.md from the project root or ~/.gemini/GEMINI.md.'
    echo 'Clone the repository next to your project and reference its GEMINI.md, or copy it:'
    echo "  git clone $REPO_URL"
    echo '  cp android-agent-skill/GEMINI.md ./GEMINI.md'
    echo 'MCP: add android-agent to ~/.gemini/settings.json (see templates/clients/gemini-settings.json).'
    exit 0 ;;
  *) usage >&2; exit 1 ;;
esac
command -v git >/dev/null || { echo 'Git is required.' >&2; exit 1; }
[[ "$target" != -* ]] || target="$PWD/$target"
[[ ! -L "$target" ]] || { echo 'Refusing a symlink installation target.' >&2; exit 1; }
if [[ -e "$target" ]]; then
  [[ -d "$target/.git" ]] || { echo 'Refusing an existing directory that is not this skill checkout.' >&2; exit 1; }
  [[ "$(git -C "$target" remote get-url origin)" == "$REPO_URL" ]] || { echo 'Refusing a checkout with another origin.' >&2; exit 1; }
  [[ -z "$(git -C "$target" status --porcelain)" ]] || { echo 'Local changes found. Preserve or commit them before updating.' >&2; exit 1; }
  [[ "$(git -C "$target" branch --show-current)" == main ]] || { echo 'Refusing to update a branch other than main.' >&2; exit 1; }
  git -C "$target" pull --ff-only origin main || { echo "Update failed. The checkout at $target was left unchanged." >&2; exit 1; }
else
  mkdir -p "$(dirname "$target")"
  git clone --branch main --single-branch --depth 1 "$REPO_URL" "$target" || { echo "Clone failed. Check your network and that $REPO_URL is reachable." >&2; exit 1; }
fi
printf '\nSource skill installed at: %s\n' "$target"
echo 'Entry file: SKILL.md. Keep patterns/, capabilities/, checklists/, docs/ and templates/ beside it.'
echo 'The CLI/MCP server is a separate npm build; see README.md.'
