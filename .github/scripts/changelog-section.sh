#!/usr/bin/env bash
# Print the body of the section "## [$1] - <date>" of the changelog $2 (default CHANGELOG.md): the lines after the
# heading, up to the next "## " heading or the link definitions at the end, without blank lines at both ends.
# Exit 1, and print nothing, when the section is absent or has no text. The version is matched as a literal string.
set -euo pipefail
version="${1:?usage: changelog-section.sh <version> [file]}"
file="${2:-CHANGELOG.md}"
body="$(awk -v version="$version" '
  /^## / { if (inside) exit; inside = (index($0, "## [" version "] - ") == 1); next }
  inside && /^\[[^]]+\]: / { exit }
  inside { print }
' "$file")"
body="$(printf '%s\n' "$body" | awk 'NF { started = 1 } started { lines[++n] = $0 } END { while (n > 0 && lines[n] !~ /[^[:space:]]/) n--; for (i = 1; i <= n; i++) print lines[i] }')"
if [ -z "$body" ]; then
  echo "changelog-section: $file has no text in a section for version $version" >&2
  exit 1
fi
printf '%s\n' "$body"
