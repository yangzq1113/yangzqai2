#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

MODE="${1:-debug}"
MODE="$(printf '%s' "${MODE}" | tr '[:upper:]' '[:lower:]')"

case "${MODE}" in
  debug) GRADLE_TASK=":app:assembleDebug" ;;
  release) GRADLE_TASK=":app:assembleRelease" ;;
  *)
    echo "Usage: bash android-app/scripts/build-android-apk.sh [debug|release]" >&2
    exit 1
    ;;
esac

cd "${REPO_ROOT}"

if [[ "${INSTALL_RUNTIME_DEPS:-1}" == "1" ]]; then
  npm ci --omit=dev
fi

if [[ "${FETCH_NODEJS_MOBILE:-1}" == "1" ]]; then
  node android-app/scripts/fetch-nodejs-mobile.mjs
fi

if [[ "${ANDROID_CLEAN_BUILD:-0}" == "1" ]]; then
  android-app/gradlew -p android-app clean
fi

android-app/gradlew -p android-app "${GRADLE_TASK}"
