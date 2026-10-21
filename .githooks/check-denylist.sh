#!/bin/sh
# Scan the staged diff (added lines only) for denylist terms.
# Prints file and line number of each hit, never the term. Exit 1 on a hit.
list="${PORTOGRAPH_DENYLIST:-$HOME/.config/portograph/denylist}"
if [ ! -f "$list" ]; then
  echo "pre-commit: denylist not found, check skipped"
  exit 0
fi
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
grep -v '^[[:space:]]*#' "$list" | grep -v '^[[:space:]]*$' > "$tmp/terms"
[ -s "$tmp/terms" ] || exit 0
git diff --cached -U0 --no-color | awk '
  /^\+\+\+ / { file = substr($0, 7); next }
  /^@@ /     { split($3, a, ","); n = substr(a[1], 2) + 0; next }
  /^\+/      { print file "\t" n "\t" substr($0, 2); n++ }
' | while IFS="$(printf '\t')" read -r file n text; do
  if printf '%s\n' "$text" | grep -qiFf "$tmp/terms"; then
    echo "$file:$n"
  fi
done > "$tmp/hits"
if [ -s "$tmp/hits" ]; then
  echo "pre-commit: denylist term in staged added line at:"
  sed 's/^/  /' "$tmp/hits"
  exit 1
fi
exit 0
