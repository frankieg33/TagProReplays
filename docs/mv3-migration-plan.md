# TagProReplays MV3 Migration Plan (Local Unpacked Focus)

## Goal and Scope

Primary goal: run as an unpacked MV3 extension in current Chrome for personal/local use.

In scope for initial migration:
- MV3 manifest/build conversion.
- Service-worker-safe architecture.
- Replay CRUD/import/export parity where feasible.

Explicitly deferred:
- Chrome Web Store hardening and review policy work.
- Movie rendering in first MV3 cut.
- Large tooling modernization unrelated to MV3 compatibility.

## Decisions Locked In

1. First MV3 build ships with movie rendering disabled.
2. Legacy Chrome FileSystem API is removed; use IndexedDB/chrome.storage paths instead.
3. Mixpanel tracking is disabled for local/dev (unpacked) builds.
4. Prioritize record/import/list/delete/rename/export before re-adding rendering.

## Why MV2 Code Fails in MV3

1. `src/manifest.json` is MV2.
2. `src/js/background.js` uses DOM (`document.createElement('canvas')`) not available in service workers.
3. `src/js/util/filesystem.js` depends on `window.requestFileSystem/webkitRequestFileSystem`.
4. Background download flows rely on `saveAs(...)` patterns not directly compatible with MV3 service-worker execution.

## Target MV3 Architecture

- `background.service_worker`:
  - message routing and replay operations.
  - no DOM access and no long-lived in-memory correctness assumptions.
- `offscreen` document (future phase):
  - owns canvas render pipeline when rendering is re-enabled.
- `content_scripts`:
  - keep mostly unchanged.
  - migrate deprecated URL calls to `chrome.runtime.getURL`.

## Phase Plan

## Phase 0: Baseline and Safety

1. Confirm current MV2 behavior baseline from `build/`.
2. Capture a manual smoke checklist baseline.

Deliverable:
- `docs/mv3-baseline-notes.md` (optional but recommended).

## Phase 1: MV3 Skeleton (Current Work)

1. Add `src/manifest.mv3.json`.
2. Add MV3 build target that emits `manifest.json` from MV3 source.
3. Add `src/js/background-sw.js` as non-DOM service-worker entrypoint.
4. Replace `chrome.extension.getURL` with `chrome.runtime.getURL`.
5. Ensure unpacked load from `build/` succeeds without manifest parse errors.

Deliverables:
- MV3 unpacked build loads.
- Known unsupported operations fail clearly instead of crashing.

## Phase 2: Replay Core Port (No Rendering)

1. Split/port background logic into service-worker-safe modules.
2. Migrate background `localStorage` metadata/counters to storage APIs.
3. Replace FileSystem movie storage plumbing with IndexedDB/chrome.storage-compatible approach.
4. Keep message protocol compatibility with content scripts where practical.

Deliverables:
- Record/import/list/delete/rename/export work on MV3.
- Persistence survives browser restarts and worker suspensions.

## Phase 3: Download Pipeline for MV3

1. Replace service-worker-incompatible `saveAs(...)` flows with MV3-compatible download handling.
2. Ensure single replay export and multi-replay zip export work from MV3 context.

Deliverables:
- Download flows function without foreground-page dependencies.

## Phase 4: Rendering Reintroduction (Follow-Up)

1. Add offscreen document and render worker script.
2. Move canvas rendering pipeline out of service worker.
3. Reconnect render progress/status messaging.
4. Add retry/recovery for offscreen lifecycle failures.

Deliverables:
- Render and movie download parity restored.

## Phase 5: Stabilization and Test Matrix

Manual matrix on latest Chrome stable:

1. Load unpacked extension from `build/`.
2. Verify menu injection on TagPro pages.
3. Record replay and verify list update.
4. Import valid/invalid replay files.
5. Delete and rename replay.
6. Export replay data (single and multi).
7. Reload extension and verify persistence.

Later, after Phase 4:

8. Render movie and download movie.

## Risks and Mitigations

1. Service worker lifecycle regressions.
- Mitigation: keep correctness in persisted storage, not globals.

2. Legacy dependency friction.
- Mitigation: isolate MV3 port first; defer broad dependency updates.

3. Download behavior differences under MV3.
- Mitigation: isolate/export adapter and test single + bulk paths early.

4. Rendering complexity.
- Mitigation: defer until non-render core is stable.
