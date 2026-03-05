# TagPro Highlights

TagPro Highlights is a Chrome extension for clipping recent TagPro gameplay and
rendering highlight movies.

Version `2.0.0` is the Manifest V3 migration release.

## Features

- Record and save highlights from a rolling in-memory buffer.
- Browse, rename, delete, import, and export highlight data.
- Render highlights to `.webm` movies in an offscreen render document.
- Re-render previously rendered highlights after changing settings.
- Use vanilla or custom textures in rendered output.

## Compatibility

- Chrome 114+.
- Chromium-based browsers that support MV3 offscreen documents.

## Quick Start (Unpacked Extension)

1. Install Node.js and npm.
2. Run `npm install`.
3. Run `npm run build:mv3`.
4. Open `chrome://extensions`.
5. Enable Developer Mode.
6. Click Load unpacked and select `build/`.

After source changes, run `npm run build:mv3` again and click Reload on the
extension in `chrome://extensions`.

## Rendering Notes

- Movie export format is currently `.webm`.
- Higher FPS improves smoothness but increases output size.
- A practical balance is often 60-75 FPS at 1280x720.
- If you change render settings (tileset, splats, size, FPS), you can render
  the same highlight again to overwrite the previous movie.

## Troubleshooting

- `Timed out waiting for offscreen render worker`:
  Reload the extension, refresh TagPro, and retry the render.
- `Extension context invalidated`:
  Refresh the page after extension reload/update.
- `The message port closed before a response was received`:
  Ensure you are on the latest `2.0.0` build and reload both the extension and
  active TagPro tab.

## Development

### Build

- `npm run build` builds browser bundles with sourcemaps.
- `npm run build:mv3` builds MV3 output into `build/`.
- `npm run build:release:mv3` builds a minified MV3 release into `dist/`.

### Test

- `npm test` builds test bundles and runs Karma once.
Watch-like flow:
1. `npm install -g karma-cli`
2. `node tools/build-tests.js`
3. `karma start`

### Project Structure

- `src/`: extension source.
- `src/js/`: entry scripts and module code.
- `src/scss/`: styles compiled to CSS.
- `src/html/`: extension UI/offscreen/sandbox pages.
- `test/`: unit tests and fixtures.
- `tools/`: build and release scripts.
- `vendor/`: vendored frontend dependencies copied into builds.

## Release

1. Bump version in `package.json`.
2. Run `npm run build:release:mv3`.
3. Load `dist/` as unpacked and smoke test.
4. Commit and tag (for example `v2.0.0`).
5. Push branch and tag, then publish a GitHub release.
