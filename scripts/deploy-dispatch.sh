#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  [ "$#" -eq 0 ] && [ "${SSH_ORIGINAL_COMMAND:-}" = vpn-new ] || exit 64
  exec sudo -n /usr/local/bin/deploy-dispatch
fi

[ "$#" -eq 0 ] || exit 64
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
. /etc/vpn-new/deploy.conf

exec 9>/run/lock/vpn-new-deploy.lock
flock -n 9
cd "$DEPLOY_PROJECT_DIR"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo 'Deployment refused: working tree has modified tracked files' >&2
  exit 1
fi

git fetch origin "$DEPLOY_BRANCH"
git merge --ff-only "origin/$DEPLOY_BRANCH"
make build
make up

deadline=$(($(date +%s) + DEPLOY_HEALTH_TIMEOUT_SECONDS))
while [ "$(date +%s)" -lt "$deadline" ]; do
  state=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$DEPLOY_CONTAINER" 2>/dev/null || true)
  case "$state" in
    'running healthy')
      git rev-parse --short HEAD
      exit 0
      ;;
    'exited '*|'dead '*|'running unhealthy')
      echo 'Deployment failed: container is not healthy' >&2
      exit 1
      ;;
  esac
  sleep 2
done

echo 'Deployment failed: health check timed out' >&2
exit 1
