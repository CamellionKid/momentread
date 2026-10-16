# Vendored foliate-js subset

Upstream: https://github.com/johnfactotum/foliate-js

Pinned commit: `78914aef4466eb960965702401634c2cb348e9b1` (retrieved 2026-09-10).

The original MIT license is preserved in `LICENSE`. Only `epub.js`, `epubcfi.js`, `paginator.js`, and `progress.js` are included. These modules have no external imports beyond this subset. ZIP loading uses the application's pinned `fflate` dependency. `view.js` and its other-format dependencies are intentionally absent.

Local patch: the iframe sandbox in `paginator.js` permits `allow-same-origin` only, omitting upstream `allow-scripts`; a descriptive iframe title is added. The adapter also sanitizes content before loading and after resource rewriting, and injects per-document CSP. The upstream comment documents the historical WebKit event limitation. Chromium is the first-release browser target; Safari event behavior must be verified separately before claiming support.

Local lifecycle patch (2026-09-19): destruction disconnects observers even before the first chapter exists, settles pending iframe loads, and ignores late chapter/font/animation/resize callbacks. Detached iframe documents are not laid out. The upstream commit remains pinned; see `tests/unit/reader-lifecycle.test.ts` and the production Chrome scale suite for regression coverage.

When updating, review these patches and the iframe isolation/lifecycle tests. Do not replace the directory with an unpinned checkout or copy a nested `.git` directory.
