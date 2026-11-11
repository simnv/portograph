#!/usr/bin/env bash
# Print the commit that the tag $1 points to on origin (peeled for an annotated tag), or nothing when the tag is absent.
set -euo pipefail
tag="$1"
refs="$(git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}")"
peeled="$(printf '%s\n' "$refs" | awk '/\^\{\}$/ {print $1}')"
if [ -n "$peeled" ]; then
  printf '%s\n' "$peeled"
else
  printf '%s\n' "$refs" | awk 'NR==1 {print $1}'
fi
