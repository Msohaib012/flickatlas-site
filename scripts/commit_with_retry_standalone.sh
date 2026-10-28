#!/usr/bin/env bash
# commit_with_retry_standalone.sh — commit+push retry for the STANDALONE
# workflows (episode-guides, title-seed, auto-pipeline, news-refresh,
# stats-health, stats-pipeline, stats-traffic). The hourly pipeline has its
# own scripts/commit_with_retry.sh with a file->generator map; this one is
# generic and driven by env, so every standalone workflow gets the same
# "never lose a run to a rebase conflict" guarantee:
#
#   RETRY_ADD       space-separated pathspecs to stage (e.g.
#                   "js/articles-data.js api-news.json out/episodes.json").
#                   A missing pathspec is skipped, never fatal.
#   RETRY_REGEN     command to re-run when a conflicted data file needs
#                   regeneration (e.g. "python3 scripts/episode-guides.py").
#                   Empty = no regeneration; conflicted files take
#                   origin/main's version.
#   RETRY_MESSAGE   commit message prefix (a UTC timestamp is appended).
#   RETRY_HTML_BUMP "1" = the workflow bumps ?v= in *.html when its data
#                   file changes, so re-apply the bump after a conflict
#                   (mirrors the hourly script); "0" = no HTML handling.
#
# Conflict resolution DURING the rebase (never abort-and-lose):
#   *.html      — take origin/main's version, re-apply the ?v= bump.
#   data files  — take origin/main's version, then REGENERATE with
#                 RETRY_REGEN (the generator reads this run's inputs from
#                 the working tree: out/* staging/batch/queue), so BOTH
#                 sides' changes survive. A regenerator that fails leaves
#                 the file at origin/main's version (warning logged,
#                 rebase continues) — one file's regen failure must not
#                 drop the rest of the run.
#   everything else — take origin/main's version, no regeneration (it
#                 regenerates next run).
#
# The calling workflow must export the same secrets the generator step
# used (TMDB_API_KEY, GEMINI_API_KEY_1..6, ...) so the regen can run.
#
# Exit 0: nothing to commit, or commit+push succeeded.
# Exit 1: 3 attempts failed. The commit stays local on the runner; the
# next run retries from fresh main (its generator re-detects the same
# work — episode tracker 48h lookback, seeder from TMDB, stats from
# APIs — so a triple failure delays work, it does not silently lose it).
set -u

MAX_ATTEMPTS=3

git config user.name "Msohaib012"
git config user.email "200891737+Msohaib012@users.noreply.github.com"

stage_all() {
  # Add each pathspec only if it exists: a grouped `git add a b c`
  # fails ENTIRELY when one pathspec is missing, which would leave
  # other files unstaged and break the pull --rebase below.
  local f
  for f in ${RETRY_ADD:-}; do
    [ -e "$f" ] && git add -- "$f"
  done
  if [ "${RETRY_HTML_BUMP:-0}" = "1" ]; then
    git add -A -- '*.html'
  fi
}

resolve_conflicts() {
  # Called while a rebase is in progress. Returns 0 when the rebase
  # can continue (GIT_EDITOR=true avoids the editor prompt).
  local f html_conflict=""
  for f in $(git diff --name-only --diff-filter=U); do
    case "$f" in *.html) html_conflict=1 ;; esac
    git checkout --ours -- "$f"
  done
  if [ -n "${RETRY_REGEN:-}" ]; then
    echo "commit-retry: regenerating via $RETRY_REGEN"
    if ! bash -c "$RETRY_REGEN"; then
      echo "commit-retry: WARNING regen failed — conflicted files stay at origin/main's version"
    fi
  fi
  stage_all
  if [ -n "$html_conflict" ] && [ "${RETRY_HTML_BUMP:-0}" = "1" ]; then
    NEWV="fa-$(date -u +%Y%m%d%H%M)"
    echo "commit-retry: re-bumping ?v= to $NEWV"
    find . -name '*.html' -not -path './.git/*' -exec sed -i -E "s/\?v=[A-Za-z0-9_-]+/?v=$NEWV/g" {} +
    git add -A -- '*.html'
  fi
  GIT_EDITOR=true git rebase --continue
}

rebase_in_progress() {
  local d
  d="$(git rev-parse --git-dir 2>/dev/null)" || return 1
  [ -d "$d/rebase-merge" ] || [ -d "$d/rebase-apply" ]
}

stage_all
if git diff --cached --quiet; then
  echo "commit-retry: nothing to commit"
  exit 0
fi
git commit -m "${RETRY_MESSAGE:-auto: standalone run} $(date -u +%Y-%m-%dT%H:%M:%SZ)"

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  echo "commit-retry: attempt $attempt/$MAX_ATTEMPTS"
  # Explicit remote + current branch (not bare `git pull --rebase`): the
  # pull must not depend on upstream tracking being configured.
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

echo "commit-retry: FAILED after $MAX_ATTEMPTS attempts — commit stays local; next run retries from fresh main"
exit 1
