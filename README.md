# ADB SQLite DevTools

Inspect SQLite databases on Android devices. Browse tables, view schemas, and run SQL queries — all from your browser.

## Quick Start (npm)

```bash
npm install --save-dev adb-sqlite-viewer
npx sqlite-viewer
```

Opens a local server at `http://127.0.0.1:8085` with the full UI and ADB bridge built in. One command, no extra downloads.

```bash
# Custom port
npx sqlite-viewer --port 3000
```

**Requirements:** `adb` on your PATH ([Android SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools)) and a USB-connected Android device with debugging enabled.

## All Options

### npm Package (Recommended for dev workflows)

Install into any project and run alongside your app:

```bash
npm install --save-dev adb-sqlite-viewer
```

Add to your `package.json` scripts:

```json
{
  "scripts": {
    "sqlite-viewer": "sqlite-viewer"
  }
}
```

Then `npm run sqlite-viewer` opens the viewer. Works great alongside React Native, Flutter, or any Android project.

### Desktop App

Download the Windows installer from [Releases](https://github.com/amitwinit/SQLite-DevTools-Mobile-ReactNative/releases). Double-click to launch — the bridge server starts automatically.

### Hosted Version + ADB Bridge

Use the deployed version at **[amitwinit.github.io/SQLite-DevTools-Mobile-ReactNative](https://amitwinit.github.io/SQLite-DevTools-Mobile-ReactNative/)** together with the standalone ADB Bridge.

1. Download `adb-bridge.exe` from [Releases](https://github.com/amitwinit/SQLite-DevTools-Mobile-ReactNative/releases)
2. Run `adb-bridge.exe`
3. Open the hosted website — it auto-detects the bridge

```
Website (HTTPS) ──HTTP──> localhost:15555 (bridge) ──> adb shell ──> Device
```

### Hosted Version with WebUSB (No install required)

Open **[amitwinit.github.io/SQLite-DevTools-Mobile-ReactNative](https://amitwinit.github.io/SQLite-DevTools-Mobile-ReactNative/)** in Chrome/Edge. Uses WebUSB to talk directly to the device — no server needed.

**Note:** Requires `adb kill-server` first (WebUSB and ADB can't share the USB interface). Not suitable when you need ADB running for development.

## When to Use Which

| Scenario | Recommended |
|----------|-------------|
| Active development (React Native, Flutter, etc.) | `npx sqlite-viewer` or Desktop App |
| Quick one-off DB inspection | WebUSB (hosted version) |
| CI or shared dev environment | `npx sqlite-viewer` |
| No Node.js installed | Desktop App or WebUSB |

## Development

```bash
npm install
npm run dev          # Vite dev server
npm run build        # Build for GitHub Pages
npm run electron:dev # Build + launch Electron app
npm run electron:build # Build Electron installer
```

## License

MIT
