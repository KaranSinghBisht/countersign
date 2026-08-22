#!/usr/bin/env bash
#
# Fail if a live Razorpay credential is present in tracked files or in git
# history. This project is test-mode only; a live key here is a real incident.
#
# Two scopes, because they catch different mistakes:
#   --tracked  what is committed right now (the common case: a paste into .env
#              that got `git add -A`'d)
#   --history  anything ever committed, including a key added and later
#              deleted. Deletion does not unpublish it — the object is still in
#              the pack and still in every clone.
#
# Exit 0 clean, 1 on a finding.

set -euo pipefail

PATTERN='rzp_live_[A-Za-z0-9]{10,}'
ALLOWLIST="$(dirname "$0")/../.github/allowed-test-credentials.txt"

# Values that are known-synthetic and must not fail the build. These are test
# fixtures asserting that the config validator and the log redactor REJECT a
# live key — the assertion cannot be written without a live-shaped string.
#
# Kept in a file rather than inline because history is immutable: two of these
# were committed before the inline pragma existed, so no amount of fixing the
# working tree removes them from `git log`.
build_filter() {
	if [[ -f "$ALLOWLIST" ]]; then
		grep -vE '^\s*(#|$)' "$ALLOWLIST" || true
	fi
}

filter_known() {
	local known
	known="$(build_filter)"

	# Always drop lines carrying the inline pragma, then drop lines containing
	# any allowlisted literal.
	grep -v 'pragma: allow-live-key' \
		| { if [[ -n "$known" ]]; then grep -vFf <(echo "$known"); else cat; fi; }
}

scan_tracked() {
	local matches
	matches="$(git grep -nIE -e "$PATTERN" -- . | filter_known || true)"

	if [[ -n "$matches" ]]; then
		echo "$matches"
		echo "FAIL: a live Razorpay key is present in tracked files."
		echo "This project is test-mode only. Rotate the key, then remove it."
		return 1
	fi
	echo "ok: no live keys in tracked files"
}

scan_history() {
	local matches
	matches="$(git log -p --all | grep -E "^\+.*$PATTERN" | filter_known || true)"

	if [[ -n "$matches" ]]; then
		echo "$matches"
		echo "FAIL: a live Razorpay key appears in git history."
		echo "Rotate it now — deleting the line does not remove it from the repo."
		echo "If this is a deliberate test fixture, add it to:"
		echo "  .github/allowed-test-credentials.txt"
		return 1
	fi
	echo "ok: no live keys in history"
}

case "${1:---tracked}" in
--tracked) scan_tracked ;;
--history) scan_history ;;
--all) scan_tracked && scan_history ;;
*)
	echo "usage: $0 [--tracked|--history|--all]" >&2
	exit 2
	;;
esac
