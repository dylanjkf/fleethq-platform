# DriverOS — App Packaging (iOS & Android)

DriverOS ships three ways from **one codebase** — the Vite web build in
`apps/driveros`. No rewrite, no second UI.

## 1. Install-as-PWA (works today, zero store review)

DriverOS is a full PWA: a `manifest.webmanifest`, a service worker (`sw.js`)
with an offline app-shell, maskable icons, and Apple meta tags. Drivers can
install it straight from the browser:

- **Android (Chrome):** the browser shows an "Install app" prompt; or menu →
  *Install app / Add to Home screen*. Launches standalone, no browser chrome.
- **iOS (Safari):** Share → *Add to Home Screen*. Runs full-screen with the
  dark status bar.

This is the fastest path for a fleet: send drivers a URL, they install in ten
seconds, it works offline. For many customers this is enough.

## 2. Google Play & App Store (native binaries via Capacitor)

For a store listing (discoverability, MDM push, "real app" trust), Capacitor
wraps the same built web app in a native shell. Config lives in
`apps/driveros/capacitor.config.ts` (appId `com.fleetos.driveros`).

**One-time setup** (on a machine with Xcode and/or Android Studio):

```bash
cd apps/driveros
npm run app:setup      # installs Capacitor, scaffolds ios/ and android/
```

**Each release:**

```bash
npm run app:android    # build web → cap sync → open Android Studio
npm run app:ios        # build web → cap sync → open Xcode
```

Then archive/sign and upload from Xcode (App Store Connect) or Android Studio
(Play Console) as normal. Point store builds at production by setting
`VITE_API_BASE` before `npm run build` so the app calls the live API instead
of the dev proxy.

Requirements checklist for submission:
- Apple: paid Developer account, App Store Connect app record, privacy nutrition
  labels (DriverOS collects location while on shift, camera for POD/photos —
  declare both), a demo login for review.
- Google: Play Console account, a signed AAB, data-safety form (same location +
  camera disclosures), a demo login.
- Store icons/splash are generated from the existing 512px maskable icon; a
  feature graphic and screenshots are the only new art needed.

## 3. Android TWA (optional middle ground)

If you want a Play Store listing but not a full native project, a Trusted Web
Activity (`@bubblewrap/cli`) packages the live PWA URL as an installable APK
that runs the real site full-screen. Lower maintenance than Capacitor, Android
only, and it needs a verified `assetlinks.json` on the DriverOS domain.

## Which to use

| Need | Path |
| --- | --- |
| Get drivers running now, no store | PWA install (1) |
| App Store + Play Store, native APIs later | Capacitor (2) |
| Play Store only, minimal upkeep | TWA (3) |

Capacitor is the recommended path to full store presence because it keeps the
door open to native plugins (background geolocation, barcode camera, push) if
DriverOS ever needs more than the web platform gives.
