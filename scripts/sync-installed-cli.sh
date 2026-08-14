#!/bin/sh
# post-merge hook: keep the installed CLI from silently falling behind the
# checkout it was installed from.
#
# Twice on 2026-08-14 a merge landed and `~/.noosphere/app` kept running the
# previous code. The first time it mattered: the installed CLI predated #77, so
# every repository's post-commit hook still trusted INIT_CWD and recorded
# commits against whatever directory npm had been started from. The second time
# it only wasted a command — `hooks install --infer` did not exist yet in the
# installed build — but the shape is the same, and a stale CLI does not announce
# itself.
#
# `noosphere doctor` does not cover this. Its `manager_stale` compares the
# RUNNING manager against the INSTALLED code; nothing compares installed code
# against the checkout.
#
# Deliberately narrow: this reinstalls only when the merge actually touched the
# CLI source, so an ordinary docs or test merge costs one `git diff` and exits.
# Reinstalling on every pull would be the kind of unexplained multi-second pause
# that gets a hook deleted — the same reasoning §4.4 gives for the post-commit
# hook.
#
# Never fails the merge. A pull that succeeded must not report failure because a
# convenience step did.
set -u

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -f "$root/noosphere-mcp/package.json" ] || exit 0

# ORIG_HEAD is where the merge started. Absent on some first-merge cases, and
# without it there is nothing to compare, so skip rather than guess.
git rev-parse --verify --quiet ORIG_HEAD >/dev/null 2>&1 || exit 0

changed=$(git diff --name-only ORIG_HEAD HEAD -- noosphere-mcp/ 2>/dev/null)
[ -n "$changed" ] || exit 0

printf 'noosphere: CLI source changed in this merge, reinstalling...\n'
if (cd "$root/noosphere-mcp" && npm run install:user >/dev/null 2>&1); then
  printf 'noosphere: installed CLI is now current.\n'
else
  # Loud on failure, because the failure mode this exists to prevent is a stale
  # CLI that looks fine. Silence here would reproduce it exactly.
  printf 'noosphere: reinstall FAILED. Run `npm run install:user` in noosphere-mcp.\n' >&2
fi
exit 0
