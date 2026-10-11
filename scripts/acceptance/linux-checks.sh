#!/usr/bin/env bash
# Run on an isolated Linux checkout. Uses existing images and installed dependencies.
set -euo pipefail

if [[ "${1:-}" == "--help" ]]; then
  cat <<'HELP'
Usage (on Linux, from any directory):
  PAPERTEAM_ACCEPTANCE_IMAGE=your-local-backend-image \
  PAPERTEAM_ACCEPTANCE_OUTPUT=../PaperTeamData/M13_7/linux-checks \
  bash scripts/acceptance/linux-checks.sh

The test image must contain Node 22 and PyMuPDF. No images or dependencies are
installed. The optional PAPERTEAM_BUILD_IMAGE defaults to node:22-bookworm;
PAPERTEAM_PYTHON_BIN defaults to /opt/paperteam-venv/bin inside the test image.
The output path is resolved relative to the repository root and must be outside
it. Default output: ../PaperTeamData/M13_7/linux-checks. No additional credential/data volumes or published ports are configured. Typecheck/build and regression run serially.
HELP
  exit 0
fi
[[ $# -eq 0 ]] || { printf 'Unknown argument; use --help\n' >&2; exit 2; }
[[ "$(uname -s)" == "Linux" ]] || { printf 'Run this script on Linux.\n' >&2; exit 2; }
for command in docker flock realpath mktemp; do
  command -v "$command" >/dev/null || { printf 'Missing command: %s\n' "$command" >&2; exit 2; }
done
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repo_root"
: "${PAPERTEAM_ACCEPTANCE_IMAGE:?Set an existing local backend image with Node 22 and PyMuPDF}"
build_image="${PAPERTEAM_BUILD_IMAGE:-node:22-bookworm}"
python_bin="${PAPERTEAM_PYTHON_BIN:-/opt/paperteam-venv/bin}"
output_root="$(realpath -m -- "${PAPERTEAM_ACCEPTANCE_OUTPUT:-../PaperTeamData/M13_7/linux-checks}")"
case "$output_root" in
  "$repo_root"|"$repo_root"/*) printf 'Output must be outside the repository.\n' >&2; exit 2 ;;
esac
[[ -d backend/node_modules && -d frontend/node_modules ]] || {
  printf 'Install existing lockfile dependencies in the isolated checkout first.\n' >&2; exit 2;
}
docker image inspect "$build_image" >/dev/null
docker image inspect "$PAPERTEAM_ACCEPTANCE_IMAGE" >/dev/null
mkdir -p -- "$output_root"
exec 9> "$output_root/.checks.lock"
flock -n 9 || { printf 'Another check is using this output root.\n' >&2; exit 2; }
logdir="$(mktemp -d "$output_root/checks-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
printf 'Logs: %s\n' "$logdir"
trap 'result=$?; printf "EXIT=%s\n" "$result" > "$logdir/result.txt"; exit "$result"' EXIT

docker run --rm --cpus=2 --memory=6g --user "$(id -u):$(id -g)" \
  --entrypoint sh -e HOME=/tmp \
  -v "$repo_root:/workspace" -w /workspace/backend "$build_image" \
  -c 'npm run typecheck && npm run build' > "$logdir/build.log" 2>&1

docker run --rm --cpus=2 --memory=8g --user "$(id -u):$(id -g)" \
  --entrypoint sh -e NODE_ENV=test -e HOME=/tmp \
  -e "PATH=$python_bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  -e "PAPERTEAM_PDF_PYTHON=$python_bin/python" \
  -e PROJECTS_ROOT=/tmp/paperteam-projects -e PAPERTEAM_RUNTIME_ROOT=/tmp/paperteam-runtime \
  -v "$repo_root:/workspace" -w /workspace/backend "$PAPERTEAM_ACCEPTANCE_IMAGE" \
  -c './node_modules/.bin/vitest run --maxWorkers=2' > "$logdir/regression.log" 2>&1
printf 'PASS logs=%s\n' "$logdir"
