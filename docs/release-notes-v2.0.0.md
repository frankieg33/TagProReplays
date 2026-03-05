# TagPro Highlights v2.0.0

This is the Manifest V3 migration release for the `frankieg33/TagProReplays`
fork, now focused on TagPro highlights.

## Highlights

- Migrated extension architecture to MV3 with a service worker background.
- Added offscreen render pipeline for movie generation.
- Renamed in-app UX from "Replays" to "Highlights" where applicable.
- Added support for re-rendering already rendered highlights.
- Improved render/download reliability in MV3 messaging flows.
- Prevented extension UI injection on TagPro group pages to avoid mode picker
  interference.

## Rendering and Export

- Rendering now runs through `render-offscreen.html` and `render-offscreen.js`.
- Render completion and error handling were hardened for reconnect/disconnect
  edge cases.
- Movie download flow was updated for MV3 service worker constraints.
- Output movie format remains `.webm` in this release.

## Build and Tooling

- Replaced legacy gulp/browserify flow with `tools/build.js` (esbuild + sass).
- Added `tools/build-tests.js` for test bundling.
- Updated MV3 manifest build output with version injected from `package.json`.

## Notes

- Recommended first-run steps after update:
1. Reload the extension in `chrome://extensions`.
2. Refresh existing TagPro tabs.
3. Re-open the Highlights UI and verify render settings.

- Known quality tradeoff:
1. Higher FPS can reduce jitter but increases file size.
2. 60-75 FPS at 1280x720 is usually a good balance.
