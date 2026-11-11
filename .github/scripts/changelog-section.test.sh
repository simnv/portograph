#!/usr/bin/env bash
# Test for changelog-section.sh. Run: .github/scripts/changelog-section.test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/changelog-section.sh"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
fail=0

check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; printf 'expected:\n%s\nactual:\n%s\n' "$2" "$3"; fail=1; fi
}

cat > "$dir/log.md" <<'LOG'
# Changelog

## [Unreleased]

## [1.2.0] - 2026-01-02

### Added

- Line one.
  Continued.

### Fixed

- Line two.

## [1.2.0-rc.1] - 2026-01-01

- The candidate.

## [1.1.0] - 2025-12-01

## [1.0.0] - 2025-11-01

- First.

[Unreleased]: https://example.invalid/compare/v1.2.0...HEAD
[1.0.0]: https://example.invalid/releases/tag/v1.0.0
LOG

check "middle section" "$(printf '### Added\n\n- Line one.\n  Continued.\n\n### Fixed\n\n- Line two.')" "$("$script" 1.2.0 "$dir/log.md")"
check "pre-release is its own section" "- The candidate." "$("$script" 1.2.0-rc.1 "$dir/log.md")"
check "last section stops at the link definitions" "- First." "$("$script" 1.0.0 "$dir/log.md")"

for missing in 9.9.9 1.2 1x2x0 Unreleased; do
  if out="$("$script" "$missing" "$dir/log.md" 2>/dev/null)"; then
    echo "FAIL $missing: expected exit 1"; fail=1
  else
    check "absent $missing prints nothing" "" "$out"
  fi
done
if "$script" 1.1.0 "$dir/log.md" 2>/dev/null; then echo "FAIL empty section: expected exit 1"; fail=1; else echo "ok   empty section fails"; fi
if "$script" 1.0.0 "$dir/none.md" 2>/dev/null; then echo "FAIL no file: expected exit 1"; fail=1; else echo "ok   missing file fails"; fi

# The real changelog has a section for the version in package.json.
root="$(cd "$here/../.." && pwd)"
version="$(node -p 'require(process.argv[1]).version' "$root/package.json")"
if "$script" "$version" "$root/CHANGELOG.md" >/dev/null; then echo "ok   CHANGELOG.md has $version"; else echo "FAIL CHANGELOG.md has no section for $version"; fail=1; fi

exit "$fail"
