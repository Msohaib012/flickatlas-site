#!/usr/bin/env bash
# commit_with_retry_standalone.sh — commit+push retry for standalone
# workflows. RETRY_ADD is a whitespace-separated allowlist of generated
# paths (files or directories). Set RETRY_STRICT_OUTPUTS=1 to fail closed
# if a generator leaves an unstaged or undeclared output.
#
#   RETRY_ADD       paths to stage, e.g.
#                   "js/published-titles.js js/ott-data.js out/step-runs.json"
#   RETRY_REGEN     command to regenerate allowlisted files after a rebase
#                   conflict; empty = keep origin/main's version
#   RETRY_MESSAGE   commit message prefix (a UTC timestamp is appended)
#   RETRY_HTML_BUMP "1" = *.html is an additional allowed output class
#   RETRY_STRICT_OUTPUTS "1" = validate the complete staged-output allowlist
#
# On a rebase conflict, conflicted paths first take origin/main's version;
# the configured regenerator then refreshes this run's generated outputs,
# and all allowlisted outputs are staged together before continuing.
set -u

MAX_ATTEMPTS=3

git config user.name "Msohaib012"
git config user.email "200891737+Msohaib012@users.noreply.github.com"

stage_all() {
  local f tracked
  for f in ${RETRY_ADD:-}; do
    tracked="$(git ls-files -- "$f" 2>/dev/null || true)"
    if [ -e "$f" ] || [ -n "$tracked" ]; then
      git add -A -- "$f" || return 1
    fi
  done
  if [ "${RETRY_HTML_BUMP:-0}" = "1" ]; then
    git add -A -- '*.html' || return 1
  fi
}

assert_no_unstaged_outputs() {
  local unstaged untracked
  unstaged="$(git diff --name-only)"
  untracked="$(git ls-files --others --exclude-standard)"
  if [ -n "$unstaged" ] || [ -n "$untracked" ]; then
    echo "commit-retry: refusing a partial commit; unstaged/untracked outputs remain. Add legitimate generated paths to RETRY_ADD." >&2
    git status --short >&2
    return 1
  fi
}

assert_staged_outputs_allowed() {
  local f path allowed
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    allowed=0
    for path in ${RETRY_ADD:-}; do
      if [ "$f" = "$path" ] || { [ -d "$path" ] && [[ "$f" == "$path/"* ]]; }; then
        allowed=1
        break
      fi
    done
    if [ "${RETRY_HTML_BUMP:-0}" = "1" ] && [[ "$f" == *.html ]]; then
      allowed=1
    fi
    if [ "$allowed" -ne 1 ]; then
      echo "commit-retry: refusing unexpected staged path: $f" >&2
      git status --short >&2
      return 1
    fi
  done < <(git diff --cached --name-only)
}

strict_output_check() {
  [ "${RETRY_STRICT_OUTPUTS:-0}" = "1" ] || return 0
  assert_no_unstaged_outputs && assert_staged_outputs_allowed
}

resolve_conflicts() {
  local f html_conflict=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in *.html) html_conflict=1 ;; esac
    git checkout --ours -- "$f" || return 1
    # Stage the chosen upstream version so every conflict is resolved,
    # including a path that is intentionally not regenerated this run.
    git add -- "$f" || return 1
  done < <(git diff --name-only --diff-filter=U)

  if [ -n "${RETRY_REGEN:-}" ]; then
    echo "commit-retry: regenerating via $RETRY_REGEN"
    if ! bash -c "$RETRY_REGEN"; then
      if [ "${RETRY_STRICT_OUTPUTS:-0}" = "1" ]; then
        echo "commit-retry: regen failed — aborting to avoid a partial generated-data commit" >&2
        git rebase --abort 2>/dev/null || true
        exit 1
      fi
      echo "commit-retry: WARNING regen failed — conflicted files stay at origin/main's version"
    fi
  fi

  stage_all || return 1
  if [ -n "$html_conflict" ] && [ "${RETRY_HTML_BUMP:-0}" = "1" ]; then
    NEWV="fa-$(date -u +%Y%m%d%H%M)"
    echo "commit-retry: re-bumping ?v= to $NEWV"
    find . -name '*.html' -not -path './.git/*' -exec sed -i -E "s/\?v=[A-Za-z0-9_-]+/?v=$NEWV/g" {} +
    git add -A -- '*.html' || return 1
  fi
  if [ "${RETRY_STRICT_OUTPUTS:-0}" = "1" ] && ! strict_output_check; then
    echo "commit-retry: aborting rebase to avoid a partial generated-data commit" >&2
    git rebase --abort 2>/dev/null || true
    exit 1
  fi
  GIT_EDITOR=true git rebase --continue
}

rebase_in_progress() {
  local d
  d="$(git rev-parse --git-dir 2>/dev/null)" || return 1
  [ -d "$d/rebase-merge" ] || [ -d "$d/rebase-apply" ]
}

stage_all || exit 1
strict_output_check || exit 1
if git diff --cached --quiet; then
  echo "commit-retry: nothing to commit"
  exit 0
fi
git commit -m "${RETRY_MESSAGE:-auto: standalone run} $(date -u +%Y-%m-%dT%H:%M:%SZ)" || exit 1

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  echo "commit-retry: attempt $attempt/$MAX_ATTEMPTS"
  # Explicit remote + current branch: do not depend on upstream tracking.
  if git pull --rebase origin "$(git branch --show-current)"; then
    if git push origin "$(git branch --show-current)"; then
      echo "commit-retry: pushed on attempt $attempt"
      exit 0
    fi
    echo "commit-retry: push failed (remote moved again), retrying"
  else
    if rebase_in_progress; then
      echo "commit-retry: resolving rebase conflicts"
      if resolve_conflicts; then
        if git push origin "$(git branch --show-current)"; then
          echo "commit-retry: pushed after conflict resolution (attempt $attempt)"
          exit 0
        fi
        echo "commit-retry: push failed after rebase, retrying"
      else
        echo "commit-retry: rebase --continue failed, aborting this attempt"
        git rebase --abort 2>/dev/null || true
      fi
    else
      echo "commit-retry: pull failed without a rebase in progress (fetch/network?), retrying"
    fi
  fi
  attempt=$((attempt + 1))
done

echo "commit-retry: FAILED after $MAX_ATTEMPTS attempts — local commit retained for a later safe retry"
exit 1
