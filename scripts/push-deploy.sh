#!/bin/bash
# ============================================
# push-deploy.sh
# ============================================
# Pushes the current branch to BOTH `origin` (GitHub) AND `vps` (the VPS bare
# repo). The vps push triggers a post-receive hook on the VPS that runs
# `git checkout`, `npm install`, `npx vite build`, and `pm2 restart`.
#
# Pushing to origin alone does NOT deploy — origin is just a backup/audit
# trail. Many "fix didn't take effect" incidents came from one-remote pushes.
#
# After both pushes, this script waits for the API to come back online and
# verifies the deployed git SHA matches the just-pushed SHA.
#
# Usage:
#   bash scripts/push-deploy.sh                     # push current branch
#   bash scripts/push-deploy.sh master              # push specified branch
#   bash scripts/push-deploy.sh master --no-verify  # skip post-deploy check
#
# Equivalent to (long form):
#   git push origin master && git push vps master
#   ssh root@<vps> "until curl -fs http://127.0.0.1:3033/api/v2/status; do sleep 2; done"
# ============================================

set -e

BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"
NO_VERIFY=0
[ "$2" = "--no-verify" ] && NO_VERIFY=1

# Pre-flight: any uncommitted changes are a mistake — refuse to push past them.
if ! git diff --quiet HEAD -- || ! git diff --cached --quiet -- ; then
  echo "ERROR: uncommitted changes in working tree. Commit first." >&2
  git status -s | head -10 >&2
  exit 2
fi

EXPECTED_SHA=$(git rev-parse HEAD)
echo "[push-deploy] Pushing $BRANCH (HEAD $EXPECTED_SHA) to origin + vps"

echo "[push-deploy] -> origin"
git push origin "$BRANCH"

echo "[push-deploy] -> vps (this triggers the deploy hook)"
git push vps "$BRANCH"

if [ "$NO_VERIFY" = "1" ]; then
  echo "[push-deploy] Skipping post-deploy verification (--no-verify)"
  exit 0
fi

# Are we running on the VPS itself, or remotely?
# - Local dev: VPS is at 31.97.7.138 over SSH, vps remote is a path on remote host
# - On-VPS: vps remote is a local file path /opt/trading-bot.git
VPS_REMOTE_URL=$(git remote get-url vps 2>/dev/null || true)
ON_VPS=0
if [[ "$VPS_REMOTE_URL" =~ ^/ ]] && [ -d "$VPS_REMOTE_URL" ]; then
  ON_VPS=1
fi

echo "[push-deploy] Waiting for API to come back online..."
if [ "$ON_VPS" = "1" ]; then
  ENDPOINT="http://127.0.0.1:3033/api/v2/status"
  until curl -fs "$ENDPOINT" > /dev/null 2>&1; do sleep 2; done
else
  ssh root@31.97.7.138 "until curl -fs http://127.0.0.1:3033/api/v2/status > /dev/null 2>&1; do sleep 2; done"
fi
echo "[push-deploy] API online"

# Verify the BARE repo (deploy target) received the push.
# NOTE: /opt/trading-bot/ has its OWN /opt/trading-bot/.git/ directory (stale —
# created by an earlier `git pull origin` that didn't get cleaned up). That
# local .git is NOT what serves the running code; the bare repo's hook checks
# out master into the working tree via GIT_WORK_TREE. So the working tree's
# `git rev-parse HEAD` is stale by design and not a useful health check.
# The bare repo's master ref is the source of truth for "what was deployed."
if [ "$ON_VPS" = "1" ]; then
  DEPLOYED_SHA=$(cd /opt/trading-bot.git && git rev-parse master)
else
  DEPLOYED_SHA=$(ssh root@31.97.7.138 "cd /opt/trading-bot.git && git rev-parse master")
fi

if [ "$DEPLOYED_SHA" != "$EXPECTED_SHA" ]; then
  echo "ERROR: deployed bare-repo SHA ($DEPLOYED_SHA) != expected ($EXPECTED_SHA)" >&2
  echo "       The post-receive hook may have failed; check deploy.log on VPS." >&2
  exit 3
fi

echo "[push-deploy] OK — deployed SHA matches: $EXPECTED_SHA"
