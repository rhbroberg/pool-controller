#!/bin/bash
# Runs the iOS tests with coverage and writes ios/coverage/lcov.info for Cursor: the unit tests,
# which live in the PoolStatusCore package, and the UI tests, which drive the app against its
# pretend server. --unit skips the UI tests, which take a minute or two.
#
# The tests run on a simulator of their own, "PoolStatus Tests", created on first use, so the
# app installed on your everyday simulator, its settings and its sign-in are left alone.
set -uo pipefail
cd "$(dirname "$0")/.."

DEVICE_NAME="PoolStatus Tests"
RESULT=build/TestResults.xcresult
skip=()
if [ "${1:-}" = "--unit" ]; then
    skip=(-skip-testing:PoolStatusUITests)
fi

udid=$(xcrun simctl list devices available -j | node -e '
    const { devices } = JSON.parse(require("fs").readFileSync(0));
    const found = Object.values(devices).flat().find((d) => d.name === process.argv[1]);
    if (found) console.log(found.udid);
' "$DEVICE_NAME")

if [ -z "$udid" ]; then
    read -r runtime devicetype < <(xcrun simctl list -j runtimes | node -e '
        const { runtimes } = JSON.parse(require("fs").readFileSync(0));
        const ios = runtimes.filter((r) => r.platform === "iOS" && r.isAvailable).pop();
        if (!ios) process.exit(1);
        // the newest plain or Pro iPhone, such as "iPhone 17 Pro"
        const generation = (t) => Number((t.name.match(/^iPhone (\d+)/) || [])[1] || 0);
        const phone = ios.supportedDeviceTypes
            .filter((t) => t.productFamily === "iPhone" && /^iPhone \d+( Pro)?$/.test(t.name))
            .sort((a, b) => generation(a) - generation(b) || a.name.length - b.name.length)
            .pop();
        console.log(ios.identifier, phone.identifier);
    ') || { echo "no iOS simulator runtime is installed" >&2; exit 1; }
    udid=$(xcrun simctl create "$DEVICE_NAME" "$devicetype" "$runtime")
    echo "created simulator \"$DEVICE_NAME\" ($udid)"
fi

rm -rf "$RESULT"
# the workspace, rather than the project, is what lets the app's scheme run the package's tests
xcodebuild test \
    -workspace PoolStatus/PoolStatus.xcworkspace \
    -scheme PoolStatus \
    -destination "id=$udid" \
    -derivedDataPath build/TestDerivedData \
    -resultBundlePath "$RESULT" \
    -enableCodeCoverage YES \
    ${skip[@]+"${skip[@]}"} \
    -quiet
status=$?

if [ -d "$RESULT" ]; then
    node scripts/xccov-to-lcov.js "$RESULT" coverage/lcov.info
fi
exit $status
