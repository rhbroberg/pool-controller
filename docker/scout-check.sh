#!/bin/sh
# Builds every image docker-compose.yml builds, from the working tree and on freshly pulled base
# images, and fails if Docker Scout finds a critical or high CVE with a fix available in any of
# them. Images the compose file only pulls, like mongo, aren't checked. Accepted exceptions are
# OpenVEX statements in scout/. See README.md.

cd "$(dirname "$0")" || exit 1

fail() {
    echo "scout-check: $*" >&2
    exit 1
}

docker info >/dev/null 2>&1 || fail "Docker isn't running"
docker scout version >/dev/null 2>&1 ||
    fail "the Docker Scout plugin isn't installed; see https://github.com/docker/scout-cli"
command -v jq >/dev/null 2>&1 || fail "jq isn't installed"

POOL_GIT_COMMIT=${POOL_GIT_COMMIT:-$(git describe --always --dirty 2>/dev/null || echo unknown)}
export POOL_GIT_COMMIT
# building doesn't use the secrets; set, even if empty, compose doesn't warn about them
export POOL_JWT_SECRET="${POOL_JWT_SECRET-}" POOL_HE_DDNS_KEY="${POOL_HE_DDNS_KEY-}"

images=$(docker compose config --format json | jq -r '.services[] | select(.build) | .image') ||
    fail "couldn't read the images from docker-compose.yml"
[ -n "$images" ] || fail "docker-compose.yml builds no images"

echo "scout-check: building" $images
docker compose build --pull --quiet || fail "the images didn't build"

vex=
if ls scout/*.json >/dev/null 2>&1; then
    # without --only-vex-affected Scout shows the statements but still counts their CVEs
    vex="--vex-location scout --only-vex-affected"
fi

status=0
for image in $images; do
    # exit code 2 means Scout found CVEs; anything else nonzero means it couldn't scan
    report=$(docker scout cves "local://$image" --only-severity critical,high --only-fixed \
        --exit-code $vex 2>&1)
    case $? in
        0)
            echo "scout-check: $image has no fixable critical or high CVEs"
            ;;
        2)
            echo "$report"
            echo "scout-check: $image has fixable critical or high CVEs, above" >&2
            status=1
            ;;
        *)
            echo "$report"
            echo "scout-check: Docker Scout couldn't scan $image; is Docker signed in to Docker Hub (docker login)?" >&2
            status=1
            ;;
    esac
done
exit $status
