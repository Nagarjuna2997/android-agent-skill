#!/usr/bin/env bash
# check-android-style.sh: fail fast on patterns this skill forbids in Android source.
#
# Usage: hooks/check-android-style.sh [PATH ...]
#   PATH defaults to app/src/main. Pass several module source roots to check them all.
#   Test source sets (src/test, src/androidTest) are skipped automatically.
#
# Checks (main source only):
#   1. GlobalScope                      unstructured coroutines
#   2. LiveData / MutableLiveData       forbidden in new Kotlin code; use StateFlow
#   3. EncryptedSharedPreferences       deprecated; use Keystore + DataStore or Tink
#   4. Thread.sleep(                    blocks a thread; use delay() or a proper wait
#   5. <activity|service|receiver|provider> without android:exported in manifests
#
# Exit code: 0 clean, 1 findings, 2 usage error. Prints each match as path:line: text.

set -euo pipefail

if [ "$#" -eq 0 ]; then
  set -- "app/src/main"
fi

for root in "$@"; do
  if [ ! -d "$root" ]; then
    echo "error: $root is not a directory" >&2
    exit 2
  fi
done

if command -v rg >/dev/null 2>&1; then
  GREP_TOOL="rg"
else
  GREP_TOOL="grep"
fi

# search PATTERN GLOB ROOTS...  -> prints path:line:text for matches, excluding test source sets
search() {
  local pattern="$1"; shift
  local glob="$1"; shift
  if [ "$GREP_TOOL" = "rg" ]; then
    rg --line-number --no-heading --color never \
      --glob "$glob" \
      --glob '!**/src/test/**' --glob '!**/src/androidTest/**' --glob '!**/build/**' \
      -e "$pattern" "$@" 2>/dev/null || true
  else
    grep -rnE --include="$glob" \
      --exclude-dir=test --exclude-dir=androidTest --exclude-dir=build \
      -e "$pattern" "$@" 2>/dev/null || true
  fi
}

failures=0

report() {
  local title="$1"
  local advice="$2"
  local matches="$3"
  if [ -n "$matches" ]; then
    echo "FAIL: $title"
    echo "      $advice"
    printf '%s\n' "$matches" | sed 's/^/      /'
    echo
    failures=$((failures + 1))
  fi
}

report "GlobalScope usage" \
  "Use viewModelScope, lifecycleScope, or an injected application CoroutineScope." \
  "$(search 'GlobalScope' '*.kt' "$@")"

report "LiveData in Kotlin source" \
  "New code exposes StateFlow and collects with collectAsStateWithLifecycle(); see docs/android/migrating-from-views.md for the bridge." \
  "$(search '\b(Mutable)?LiveData\b|\bMediatorLiveData\b|observeAsState\(' '*.kt' "$@")"

report "EncryptedSharedPreferences" \
  "Deprecated. Use Android Keystore with DataStore, or Tink." \
  "$(search 'EncryptedSharedPreferences|EncryptedFile\b' '*.kt' "$@")"

report "Thread.sleep in main source" \
  "Blocks the thread. Use delay() in a coroutine or a real wait on a condition." \
  "$(search 'Thread\.sleep\(' '*.kt' "$@")"

# Manifest check: any activity/service/receiver/provider element lacking android:exported.
# Elements can span lines, so flatten each component element before testing it.
manifest_findings=""
while IFS= read -r manifest; do
  [ -z "$manifest" ] && continue
  case "$manifest" in */src/test/*|*/src/androidTest/*|*/build/*) continue ;; esac
  # Join lines, split on element boundaries, keep component elements without exported.
  found="$(tr '\n' ' ' < "$manifest" \
    | sed 's/<\(activity\|service\|receiver\|provider\|activity-alias\)\b/\n<\1/g' \
    | grep -E '^<(activity|service|receiver|provider|activity-alias)\b' \
    | sed -E 's/>.*$/>/' \
    | grep -v 'android:exported=' || true)"
  if [ -n "$found" ]; then
    manifest_findings+="$manifest:"$'\n'"$(printf '%s\n' "$found" | sed 's/  */ /g' | cut -c1-160)"$'\n'
  fi
done < <(find "$@" -name AndroidManifest.xml -type f 2>/dev/null)

report "Component without android:exported in manifest" \
  "Every <activity>, <service>, <receiver>, <provider> must declare android:exported explicitly." \
  "$manifest_findings"

if [ "$failures" -gt 0 ]; then
  echo "check-android-style: $failures check(s) failed."
  exit 1
fi

echo "check-android-style: clean ($*)."
exit 0
