# Luker Android App (Backend-in-App)

This directory contains an Android shell app that runs Luker backend locally on the phone and opens it in a WebView.

## Architecture

- **WebView UI**: loads `http://127.0.0.1:8000`
- **Backend runtime**: Node.js Mobile (`libnode.so` + JNI bridge)
- **App boot flow**:
  1. copy runtime assets to app-private storage
  2. start Node with `bootstrap.js`
  3. wait for local server
  4. open WebView

## Local build

From repository root:

```bash
npm ci --omit=dev
node android-app/scripts/fetch-nodejs-mobile.mjs
gradle -p android-app :app:assembleDebug
```

Debug APK output:

`android-app/app/build/outputs/apk/debug/app-debug.apk`

## Release build (signed)

Set environment variables before Gradle release build:

- `ANDROID_KEYSTORE_FILE`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Then run:

```bash
gradle -p android-app :app:assembleRelease
```

## Update model

- No in-app APK auto-update is implemented.
- Recommend GitHub Release distribution with user-side APK overlay install.
- App data stays in app-private storage and survives overlay install.
