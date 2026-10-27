#!/usr/bin/env bash
# Commit-with-retry for the hourly pipeline (TMDB fix package, fix 6).
#
# Wraps the old "Commit if changed" step in up to 3 attempts. A whole
# run's work must never be dropped again because a manual push landed
# mid-run and the rebase conflicted (2026-10-26 15:55 UTC: 53-file
# commit lost; 2026-10-26 18:49 UTC: seeder work lost).
#
# Conflict resolution DURING the rebase (never abort-and-lose):
#   *.html            — take origin/main's version, re-apply the ?v= bump
#   data files        — take origin/main's version, then REGENERATE the
#                       file with its owning generator (the generator
#                       reads this run's inputs from the working tree:
#                       out/* staging/batch/queue), so BOTH sides'
#                       changes survive:
#     js/published-titles.js, js/trending-data.js -> title-seed.py
#     js/articles-data.js                         -> apply-auto.py
#     api-news.json, api-trends.json              -> convert-news.py
#     js/daywise-data.js                          -> multisource engine
#     js/ott-data.js                              -> build_ott.py
#     js/reviews-data.js                          -> gemini_reviews.py
#     js/trending-topics.js                       -> trending_weekly.py
#     js/advance-data.js                          -> sacnilk --apply
#   stats/state/staging/out files — take origin/main's version, no
#                       regeneration (they regenerate next run).
# A regenerator that fails leaves the file at origin/main's version
# (warning logged, rebase continues) — one file's regen failure must
# not drop the rest of the run.
#
# Exit 0: nothing to commit, or commit+push succeeded (writes
# committed=true/false to $GITHUB_OUTPUT for the deploy gate).
# Exit 1: 3 attempts failed (the next hourly run retries from fresh
# main — the working tree is left rebased, nothing is lost locally).
set -u

MAX_ATTEMPTS=3
made_commit=0

stage_all() {
  # Add each file only if it exists: a grouped `git add a b c`
  # fails ENTIRELY when one pathspec is missing, which would leave
  # other files unstaged and break the pull --rebase below.
  local f
  for f in js/articles-data.js js/daywise-data.js js/published-titles.js js/trending-data.js js/advance-data.js js/ott-data.js js/reviews-data.js js/trending-topics.js \
           api-news.json api-trends.json \
           js/stats-pipeline.json js/stats-traffic.json js/stats-health.json \
           out/orchestrator-state.json out/step-runs.json \
           out/multisource-boxoffice.json; do
    [ -f "$f" ] && git add "$f"
  done
  # Multi-source box office: staging files must persist across runs
  # (a fresh checkout has no staging, so the engine would lose the
  # 6h-gated Sacnilk figures); the sidecar is the per-figure source
  # provenance. Both are deterministic (no timestamps), so they only
  # stage a change when data actually changed — no spurious commit.
  [ -e out/boxoffice-staging ] && git add out/boxoffice-staging || true
  # out/ files may not exist yet on the first run; add them one at a
  # time, tolerating absence.
  for f in out/gemini-batch.json out/bmr-reviews.json out/processed.json out/auto-feed.json \
           out/episodes.json out/episode-feed.json out/publish-export.json \
           out/queue.json out/seen.json out/state.json out/report.json \
           out/duplicates.json out/stories.json out/dropped.json out/ott-digital.json; do
    [ -f "$f" ] && git add "$f"
  done
  [ -e out/categories ] && git add out/categories || true
  git add -A -- '*.html'
}

# Resolve every unmerged file during a rebase, then continue it.
# Returns 0 when the rebase completed, 1 when it must be aborted.
resolve_and_continue() {
  if [ ! -d .git/rebase-merge ] && [ ! -d .git/rebase-apply ]; then
    echo "commit-retry: pull --rebase failed but no rebase is in progress — aborting this attempt"
    return 1
  fi
  local tries=0
  while [ $tries -lt 3 ]; do
    tries=$((tries + 1))
    local conflicted
    conflicted=$(git diff --name-only --diff-filter=U || true)
    if [ -z "$conflicted" ]; then
      # No unmerged files: the rebase may be stopped at a commit that
      # became empty, or waiting for a message — try to continue.
      if GIT_EDITOR=true git rebase --continue; then
        return 0
      fi
      if git diff --name-only --diff-filter=U | grep -q .; then
        echo "commit-retry: rebase stopped again with a new conflict"
        continue
      fi
      echo "commit-retry: rebase --continue failed without a conflict — aborting this attempt"
      git rebase --abort || true
      return 1
    fi
    echo "commit-retry: resolving rebase conflicts: $conflicted"
    local regen_title="" regen_apply="" regen_news="" regen_daywise=""
    local regen_ott="" regen_reviews="" regen_trending="" regen_advance=""
    local html_conflict=""
    local f
    for f in $conflicted; do
      case "$f" in
        *.html)
          git checkout --ours -- "$f"
          html_conflict=1
          ;;
        js/published-titles.js|js/trending-data.js)
          git checkout --ours -- "$f"
          regen_title=1
          ;;
        js/articles-data.js)
          git checkout --ours -- "$f"
          regen_apply=1
          ;;
        api-news.json|api-trends.json)
          git checkout --ours -- "$f"
          regen_news=1
          ;;
        js/daywise-data.js)
          git checkout --ours -- "$f"
          regen_daywise=1
          ;;
        js/ott-data.js)
          git checkout --ours -- "$f"
          regen_ott=1
          ;;
        js/reviews-data.js)
          git checkout --ours -- "$f"
          regen_reviews=1
          ;;
        js/trending-topics.js)
          git checkout --ours -- "$f"
          regen_trending=1
          ;;
        js/advance-data.js)
          git checkout --ours -- "$f"
          regen_advance=1
          ;;
        *)
          # stats / state / staging / out files: origin/main's
          # version, no regeneration (they regenerate next run).
          echo "commit-retry: $f takes origin/main's version (regenerates next run)"
          git checkout --ours -- "$f"
          ;;
      esac
    done
    # Re-apply the HTML ?v= bump (checkout --ours reverted it).
    if [ -n "$html_conflict" ]; then
      NEWV="fa-$(date -u +%Y%m%d%H%M)"
      echo "commit-retry: re-bumping ?v= to $NEWV"
      find . -name '*.html' -not -path './.git/*' -exec sed -i -E "s/\?v=[A-Za-z0-9_-]+/?v=$NEWV/g" {} +
      git add -A -- '*.html'
    fi
    # Regenerate each conflicted data file with its owning generator.
    # A failed generator restores origin/main's version for that file
    # (warning only) — the rest of the run still commits.
    if [ -n "$regen_title" ]; then
      echo "commit-retry: regenerating published-titles.js via title-seed.py"
      if ! python3 scripts/title-seed.py; then
        echo "commit-retry: WARNING title-seed.py failed — published-titles.js stays at origin/main's version"
        git checkout --ours -- js/published-titles.js js/trending-data.js 2>/dev/null || true
      fi
      git add js/published-titles.js js/trending-data.js 2>/dev/null || true
    fi
    if [ -n "$regen_apply" ]; then
      echo "commit-retry: regenerating articles-data.js via apply-auto.py"
      if ! python3 scripts/apply-auto.py; then
        echo "commit-retry: WARNING apply-auto.py failed — articles-data.js stays at origin/main's version"
        git checkout --ours -- js/articles-data.js 2>/dev/null || true
      fi
      git add js/articles-data.js 2>/dev/null || true
    fi
    if [ -n "$regen_news" ]; then
      echo "commit-retry: regenerating api-news.json via convert-news.py"
      if ! python3 scripts/convert-news.py; then
        echo "commit-retry: WARNING convert-news.py failed — api-news.json stays at origin/main's version"
        git checkout --ours -- api-news.json api-trends.json 2>/dev/null || true
      fi
      git add api-news.json api-trends.json 2>/dev/null || true
    fi
    if [ -n "$regen_daywise" ]; then
      echo "commit-retry: regenerating daywise-data.js via multisource engine"
      if ! python3 scripts/multisource_boxoffice.py; then
        echo "commit-retry: WARNING multisource engine failed — daywise-data.js stays at origin/main's version"
        git checkout --ours -- js/daywise-data.js 2>/dev/null || true
      fi
      git add js/daywise-data.js 2>/dev/null || true
    fi
    if [ -n "$regen_ott" ]; then
      echo "commit-retry: regenerating ott-data.js via build_ott.py"
      if ! python3 scripts/build_ott.py; then
        echo "commit-retry: WARNING build_ott.py failed — ott-data.js stays at origin/main's version"
        git checkout --ours -- js/ott-data.js 2>/dev/null || true
      fi
      git add js/ott-data.js 2>/dev/null || true
    fi
    if [ -n "$regen_reviews" ]; then
      echo "commit-retry: regenerating reviews-data.js via gemini_reviews.py"
      if ! python3 scripts/gemini_reviews.py --published js/published-titles.js --reviews-out js/reviews-data.js --bmr out/bmr-reviews.json; then
        echo "commit-retry: WARNING gemini_reviews.py failed — reviews-data.js stays at origin/main's version"
        git checkout --ours -- js/reviews-data.js 2>/dev/null || true
      fi
      git add js/reviews-data.js 2>/dev/null || true
    fi
    if [ -n "$regen_trending" ]; then
      echo "commit-retry: regenerating trending-topics.js via trending_weekly.py"
      if ! python3 scripts/trending_weekly.py; then
        echo "commit-retry: WARNING trending_weekly.py failed — trending-topics.js stays at origin/main's version"
        git checkout --ours -- js/trending-topics.js 2>/dev/null || true
      fi
      git add js/trending-topics.js 2>/dev/null || true
    fi
    if [ -n "$regen_advance" ]; then
      echo "commit-retry: regenerating advance-data.js via sacnilk --apply"
      if ! python3 scripts/sacnilk_boxoffice.py --apply; then
        echo "commit-retry: WARNING sacnilk --apply failed — advance-data.js stays at origin/main's version"
        git checkout --ours -- js/advance-data.js 2>/dev/null || true
      fi
      git add js/advance-data.js 2>/dev/null || true
    fi
    # Stage any remaining resolved files, then continue the rebase.
    git add -u
    if GIT_EDITOR=true git rebase --continue; then
      return 0
    fi
    # --continue stopped again (another commit to rebase, or a new
    # conflict) — loop and resolve the next stop.
    if git diff --name-only --diff-filter=U | grep -q .; then
      echo "commit-retry: rebase stopped again, resolving next conflict"
      continue
    fi
    echo "commit-retry: rebase --continue failed without a conflict — aborting this attempt"
    git rebase --abort || true
    return 1
  done
  echo "commit-retry: too many rebase stops — aborting this attempt"
  git rebase --abort || true
  return 1
}

attempt() {
  stage_all
  if ! git diff --cached --quiet; then
    git commit -m "hourly: pipeline $(date -u +%Y-%m-%dT%H:%M:%SZ)" || return 1
    made_commit=1
    echo "commit-retry: committed this run's changes"
  else
    echo "commit-retry: nothing to commit"
  fi
  # Explicit `origin main`: the rebase must not depend on the
  # checkout's upstream-tracking config.
  if ! git pull --rebase origin main; then
    echo "commit-retry: pull --rebase conflicted — resolving during the rebase"
    resolve_and_continue || return 1
  fi
  # Push with one inner retry for a push race (another push landing
  # in between). If the inner rebase conflicts, the outer loop
  # retries the whole attempt.
  git push origin main || { git pull --rebase origin main && git push origin main; } || return 1
  return 0
}

git config user.name "Msohaib012"
git config user.email "200891737+Msohaib012@users.noreply.github.com"

n=0
while [ $n -lt $MAX_ATTEMPTS ]; do
  n=$((n + 1))
  echo "commit-retry: attempt $n/$MAX_ATTEMPTS"
  if attempt; then
    if [ "$made_commit" = "1" ]; then
      echo "committed=true" >> "$GITHUB_OUTPUT"
    else
      echo "committed=false" >> "$GITHUB_OUTPUT"
    fi
    echo "commit-retry: done (attempt $n)"
    exit 0
  fi
  echo "commit-retry: attempt $n failed"
done
echo "commit-retry: all $MAX_ATTEMPTS attempts failed — next hourly run retries from fresh main"
exit 1
