# Meshlight — Product & Technical Spec

**Version:** 0.1 (draft)
**Type:** Free, open-source, fully client-side web app
**Hosting:** GitHub Pages (static, no backend)
**License:** MIT (open to change — see Licensing section)

---

## 1. One-line description

Meshlight is a browser-based STL mesh inspector that runs 100% offline: it loads STL files entirely client-side, detects mesh errors, computes a 3D-printability score, and lets users scrub through the model slice-by-slice to see the interior — no upload, no server, no account.

---

## 2. Goals & non-goals

**Goals**
- Fully offline-capable after first load (works with no internet connection, no server calls ever)
- Zero data leaves the user's browser — privacy by architecture, not policy
- Fast enough to handle typical hobbyist STL files (up to a few hundred thousand triangles) without freezing the UI
- Clear, visual (not just numeric) feedback — highlight problems directly on the 3D model
- Free and open source from day one

**Non-goals (v1)**
- Not a full slicer (no G-code generation, no support generation)
- Not a mesh editor (no vertex dragging / sculpting) — repair features are a stretch goal, not MVP
- No cloud sync, accounts, or file storage
- No mobile-first design requirement (desktop browser is primary target; mobile should not break, but isn't optimized for in v1)

---

## 3. Target user

Hobbyist and prosumer 3D printing users who want to sanity-check an STL (their own or downloaded) before slicing — catch non-manifold geometry, floating shells, inverted normals, or thin walls before wasting filament and print time.

---

## 4. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript | strict mode on |
| Rendering | Three.js | WebGL 3D viewport |
| Build tool | Vite | fast dev server, static output for GH Pages |
| Heavy compute | Web Workers | mesh analysis off the main thread |
| Optional | WASM (Rust) | only if JS perf becomes a bottleneck on large meshes — phase 2, not MVP |
| Styling | Plain CSS / CSS variables | no heavy UI framework needed; keep bundle small |
| State | Vanilla JS/TS modules or a tiny store (e.g. nanostores) | avoid React/Redux overhead unless UI complexity demands it |
| Offline support | Service Worker (Workbox or hand-rolled) | cache all assets after first load |
| Package manager | npm | |

**Hard constraint:** no runtime network requests of any kind. All libraries, fonts, and assets must be bundled into the build output. Nothing loaded from a CDN at runtime.

---

## 5. Core features (MVP — build in this order)

### 5.1 File loading
- Drag-and-drop STL file onto the page, or file picker button
- Support both binary and ASCII STL formats
- Parse in a Web Worker; show a loading indicator for large files
- Display parse errors gracefully (corrupt file, wrong format, empty mesh)

### 5.2 3D viewport
- Orbit/pan/zoom camera (Three.js OrbitControls)
- Shaded view by default; toggle to wireframe
- Reset-camera-to-fit button
- Basic 3-point lighting, neutral background
- Show triangle count, bounding box dimensions (mm), in a small info panel

### 5.3 Error detection
Build an indexed mesh (merge duplicate vertices within an epsilon) as the first processing step, then run:

- **Non-manifold edge detection** — edges shared by ≠2 triangles
- **Watertightness check** — mesh is watertight iff no boundary edges exist
- **Normal consistency check** — flag inconsistent winding / flipped normals
- **Degenerate triangle detection** — zero/near-zero area triangles
- **Disconnected shell detection** — flood-fill over the adjacency graph; report each shell (e.g. "3 separate shells found — is this intentional?")
- **Inverted shell detection** — signed volume per shell to catch inverted normals at the shell level

**Output requirements:**
- Text report panel listing each issue type with a count
- Visual highlighting: color the offending edges/faces directly on the 3D model (e.g. red = non-manifold edge, orange = flipped normal, yellow = degenerate triangle)
- Clicking an issue in the report should focus/zoom the camera on that location

### 5.4 Printability score
A composite 0–100 score with a visible breakdown (not just a bare number):

- Watertight/manifold status (heaviest weight — large penalty if failed)
- Overhang analysis: face angle vs. build-plate normal (Z axis, configurable), flag faces beyond a configurable threshold (default 45°)
- Wall thickness sampling: ray-cast from surface points to detect thin walls below a configurable threshold (default tied to a configurable nozzle diameter, e.g. 0.4mm × 2)
- Floating/unsupported island detection
- Bounding box vs. configurable build volume (default 220×220×250mm, user-editable)

Display: overall score + a breakdown list showing what dragged the score down, each with its own sub-score or pass/fail.

### 5.5 Slice viewer
- Horizontal slider representing Z-height (0% to 100% of the model's Z bounding box)
- As the user drags, compute the plane-mesh intersection at that Z height and render the resulting 2D cross-section (filled or outlined polygon) on a `<canvas>` overlay or in the 3D view
- Should feel smooth while scrubbing — pre-bucket triangles by Z-range at load time so each slice recompute only touches relevant triangles, not the whole mesh
- Optional: numeric Z-height readout next to the slider

### 5.6 Offline / PWA basics
- Service worker caches all app assets on first visit
- App shell loads and functions with no network connection on repeat visits
- Add a manifest.json so it's installable as a PWA (optional but cheap to add)

---

## 6. Phase 2 features (post-MVP, prioritized)

1. **Auto-repair**: hole filling (ear-clipping triangulation of boundary loops), duplicate/degenerate triangle removal, normal winding fix, vertex welding — plus export the repaired STL
2. **Heatmap overlays**: wall-thickness and overhang-angle heatmaps painted directly on the mesh surface
3. **Measurement tool**: click two points on the mesh, show distance
4. **Volume / surface area / estimated filament weight & print time** (clearly labeled as rough estimates)
5. **Batch loading**: drop multiple STLs, get a summary table (pass/fail/score per file)
6. **Cross-section plane** (arbitrary angle, not just Z) in addition to the Z-slider
7. **Report export** (JSON/HTML) of the analysis
8. **OBJ / 3MF import support**
9. **Settings persistence** via localStorage (build volume, nozzle diameter, score weighting)

Do not build phase 2 items until the MVP list in Section 5 is complete and working end-to-end.

---

## 7. Architecture notes

- **Parsing → indexing → analysis → render** is a one-directional pipeline. Keep each stage as a pure function operating on typed arrays (`Float32Array` for positions, `Uint32Array` for indices) so stages are testable independently of Three.js.
- **Web Worker boundary:** parsing and all analysis (manifold check, printability scoring, slicing) should run in a worker, communicating via `postMessage` with transferable typed arrays (avoid structured-clone copies of large buffers). The main thread only handles rendering and UI.
- **Adjacency structure:** build a half-edge or simple edge-map (edge key → list of triangle indices) once after indexing; reuse it for manifold checking, shell flood-fill, and later for repair — don't rebuild it per feature.
- **Z-bucketing for slicing:** at load time, bin triangles into Z-slabs (e.g. 200 buckets across the bounding box) so slice queries only scan the 1–2 buckets near the current Z, not all triangles.
- **No global mutable state outside a single app store** — keep the loaded mesh, analysis results, and UI state in one place so features can read/write predictably.

---

## 8. UI/UX guidelines

- Single-page layout: 3D viewport dominant (left/center), collapsible side panel (right) for report/score/settings, slice slider along the bottom or as an overlay
- Dark theme by default (common preference for 3D tools), but should not hard-block light theme if `prefers-color-scheme` support is easy to add
- Every detected issue should be clickable and lead the user's eye to it on the model — text-only reports are not acceptable per Section 5.3
- Loading and analysis states must show progress indicators for large files — never let the UI appear frozen
- No modal dialogs for core workflow — drag-drop should work the instant the page loads, no onboarding gate

---

## 9. Performance targets

- Parse + first render of a 500K-triangle binary STL: under ~3 seconds on a mid-range laptop
- Slice-slider scrubbing: should feel interactive (no more than ~100ms perceived lag) up to ~500K triangles after Z-bucketing
- Error detection + printability scoring on a 500K-triangle mesh: acceptable to take several seconds, but must run in a worker with a visible progress indicator, never blocking the UI thread

---

## 10. Repo / project conventions

- Repo name: `meshlight`
- README must clearly state: free, open source (MIT), 100% offline/client-side, no data collection, hosted via GitHub Pages
- `npm run dev` for local dev, `npm run build` produces static output deployable directly to GitHub Pages (via `gh-pages` branch or GitHub Actions workflow)
- Include a GitHub Actions workflow to auto-deploy `main` branch builds to GitHub Pages
- Code style: TypeScript strict mode, Prettier/ESLint defaults are fine — don't over-engineer tooling for a small static app

---

## 11. Licensing

MIT license, `LICENSE` file at repo root, attribution in README. (Flag if a different license — e.g. GPL to prevent closed-source forks — is preferred before Claude Code scaffolds the repo.)

---

## 12. Open questions for implementation

- Exact default printability score weighting (Section 5.4) — start with reasonable defaults, make them tunable/config-driven rather than hardcoded magic numbers, since these will likely need tuning after real-world testing
- Whether wireframe/heatmap rendering should reuse the same Three.js material system or use custom shaders — default to Three.js built-ins first, only reach for custom GLSL if a specific visualization needs it
- Mobile support level — v1 should not break on mobile but is not required to be touch-optimized

---

## 13. Definition of done for MVP

- [ ] Load a binary and an ASCII STL via drag-drop and file picker
- [ ] 3D viewport with orbit controls, wireframe toggle, dimensions/triangle count display
- [ ] Manifold/watertight/normal/degenerate/shell checks running in a worker with visual highlighting on the model
- [ ] Printability score with breakdown panel
- [ ] Working Z-slice slider with smooth scrubbing
- [ ] Fully functional with network disabled after first load (service worker caching verified)
- [ ] Deployed and working on GitHub Pages
