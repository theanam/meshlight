# Meshlight

**A browser-based STL mesh inspector that runs entirely on your machine.**

Drop in an STL and Meshlight checks it for the things that ruin a print — holes,
non-manifold edges, flipped normals, loose shells — scores how well it will
actually print, and lets you cut through it to see the interior.

Nothing is uploaded. There is no server to upload to. The file is read in your
browser tab and never leaves it, which is a property of how the app is built
rather than a policy you have to take on trust.

**[Open Meshlight](https://theanam.github.io/meshlight/)**

- **Free and open source** (MIT)
- **100% client-side** — no backend, no accounts, no data collection
- **Works offline** — after one visit it runs with the network off for good
- Hosted as a static site on GitHub Pages

---

## Features

### Report
Score and issues share one rail, so everything is visible at once. Every check
runs in a Web Worker, so the interface never freezes:

| Check | What it finds |
| --- | --- |
| Watertightness | Open boundary edges — holes your slicer has to guess at |
| Non-manifold edges | Edges shared by more than two faces |
| Normal consistency | Faces wound against their neighbours |
| Inverted shells | Closed shells whose normals point inward (signed volume) |
| Degenerate triangles | Zero-area faces and collapsed corners |
| Disconnected shells | Separate solids, flood-filled over the adjacency graph |

Problems are painted straight onto the model — red for non-manifold and open
edges, orange for flipped normals, yellow for degenerate faces.

Above the issues sits the 0–100 printability score and its breakdown. Each row
says where it stands — `good`, `worth a look`, `needs fixing` — rather than
deducting points, and the headline leads with the next thing to do rather than
a tally. The components are:
watertightness (weighted heaviest), overhangs past a configurable angle, wall
thickness sampled against your nozzle diameter, unsupported islands, and whether
the part fits your build volume. Every weight lives in one table in
[`src/core/score.ts`](src/core/score.ts) — they are meant to be tuned.

Clicking an issue frames that whole defect class and expands it into a list of
every individual occurrence, each one clickable to fly the camera to that single
bad edge or face. Lists are capped at 200 entries per issue; the count always
reports the true total.

### Fix
Three repairs, each independently selectable, previewed before anything is
written:

| Repair | What it does |
| --- | --- |
| Drop degenerate faces | Removes zero-area triangles and collapsed corners |
| Re-wind flipped faces | Makes faces agree with their neighbours, and turns an inside-out shell the right way round |
| Fill open edges | Ear-clips each boundary loop in its own best-fit plane |

Order matters and is fixed: degenerate faces go first because they invent
phantom edges that confuse both the winding walk and boundary detection;
winding is settled before filling so each patch is wound to match the surface
it closes rather than a face that was itself reversed.

The preview is measured, not predicted — the repaired mesh goes back through
the full analysis, so the "after" score and the remaining-issue count are the
real thing. Before/After flips between the loaded mesh and the result, and the
patched triangles are drawn in mint (artboard 2b, the one place the brand kit
lets mint onto the mesh — it reads as "added", never as a defect).

`Repair & download STL` writes a binary STL with real facet normals straight to
your downloads. The loaded mesh is never mutated; every repair runs on a copy.

**Not included: merging separate shells.** A true merge is a boolean union,
which needs a CSG kernel well beyond what is here. Faking it — welding shells
that happen to touch, say — would hand you a file that claims to be one solid
and is not, which is worse than not offering it.

### Viewport
Two reference overlays answer "how big is this, actually", which a fitted camera
otherwise hides — a 4 mm bracket and a 300 mm vase fill the frame identically.

- **Grid** — a ruler on the build plane, at the height the model's lowest point
  sits. Spacing adapts to the part so it always lands on a 1, 2 or 5 × 10ⁿ step
  with roughly twenty cells across the footprint, majors are numbered in
  millimetres, and the configured build volume is drawn as a plate outline.
- **Bounding box** — the part's extents, with its three dimensions written on
  the edges that measure them.

Both toggle from round buttons over the viewport, next to the Shaded / Wire
picker and the Fit control. Grid numbers use the same millimetre coordinates
the report quotes for every defect, so a position in the list and a position on
the plane are the same reading.

### Cutaway
Drag the vertical Z handle to cut the model open. Everything above the cut is
clipped away and the cross-section is drawn in mint. Triangles are binned into
Z-slabs at load time, so scrubbing only ever touches the slab under the cursor.

It is called Cutaway, not Slice: in 3D printing "slicing" means generating
G-code, which Meshlight explicitly does not do (spec §2). The geometry module
is [`src/core/section.ts`](src/core/section.ts) for the same reason.

---

## Running it

```bash
npm install
npm run dev      # local dev server
npm run build    # static output in dist/, deployable as-is
npm run preview  # serve the production build
npm test         # pipeline tests against meshes with known defects
```

Requires Node 20+.

### Deploying

Pushing to `main` builds and publishes to GitHub Pages via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). `base` is `''`,
so the build works from a project sub-path without any configuration.

**This needs one repository setting before the first deploy can succeed:**
Settings → Pages → Source → **GitHub Actions**. Until it is set, the workflow
fails at `configure-pages` with `Get Pages site failed ... Not Found`. It cannot
be done from the workflow: `GITHUB_TOKEN` may read a Pages site but not create
one, so `enablement: true` fails with `Resource not accessible by integration`.

---

## How it works

The pipeline is one-directional and each stage is a pure function over typed
arrays, independent of Three.js and the DOM:

```
parse -> index/weld -> adjacency -> analysis -> score
                              \
                               -> Z-buckets -> section
```

- [`src/core/stl-parser.ts`](src/core/stl-parser.ts) — binary and ASCII STL.
  Format is sniffed by size arithmetic (`84 + 50n` bytes), not by the leading
  `solid` keyword, which binary exporters also write.
- [`src/core/indexer.ts`](src/core/indexer.ts) — STL is a triangle soup with no
  shared vertices, so corners are welded onto an epsilon grid before any
  topology question can be asked.
- [`src/core/adjacency.ts`](src/core/adjacency.ts) — the edge map is built once
  and reused by every check that follows.
- [`src/core/analysis.ts`](src/core/analysis.ts) — shell discovery and winding
  propagation share a single traversal, since orientation is only meaningful
  within a shell.
- [`src/core/section.ts`](src/core/section.ts) — Z-bucketing and plane
  intersection.
- [`src/core/repair.ts`](src/core/repair.ts) — hole filling, winding
  correction, degenerate removal, and binary STL export.

Parsing and all analysis run in [`src/worker/mesh.worker.ts`](src/worker/mesh.worker.ts).
Large buffers cross the worker boundary as transfers rather than clones. The
worker keeps the only live copy of the mesh; the main thread holds render
buffers and nothing else.

### Measured performance

On a 500K-triangle binary STL (Apple Silicon, `npm run build` output):

| Stage | Time |
| --- | --- |
| Parse | 7 ms |
| Index / weld | 230 ms |
| Z-bucketing | 11 ms |
| Analysis | 200 ms |
| Scoring | 199 ms |
| Section (worst of 60) | 1.5 ms |

### Rendering

The viewport shades flat, with feature edges drawn over the top. Welding the
mesh merges the corners of adjacent faces, so averaged vertex normals would
round every hard edge off and invent curvature the model does not have — a
chamfer reading as a fillet, a flat face reading as a curve. Flat shading takes
one normal per face, and [`EdgesGeometry`](src/render/viewport.ts) outlines only
edges whose dihedral angle exceeds 22°, so tessellated curves stay clean while
real corners get a line. The result is what the part looks like in a CAD
viewport, which is the thing you are trying to check.

### Development sample

`npm run dev` opens on a generated sample part carrying the defects the report
is meant to catch. It is built in code
([`src/dev/sample-mesh.ts`](src/dev/sample-mesh.ts)) rather than shipped as a
binary, and is reached only from behind an `import.meta.env.DEV` guard — Vite
evaluates that to `false` for a build and drops the branch and its chunk, so a
production build always opens on the drop screen.

### The offline guarantee

The build makes **no runtime network requests of any kind**. Three.js is bundled
and both typefaces are self-hosted, so there is no CDN in the loop.

The service worker is generated at build time by a plugin in
[`vite.config.ts`](vite.config.ts) that precaches the real content-hashed output.
This has to happen at build time: the app registers its worker on `window load`,
by which point the browser has already fetched the HTML, JS and CSS, so those
requests never pass through the fetch handler and runtime caching alone would
never see them.

---

## Design

The interface follows the Meshlight brand kit (artboard 1a) and the report rail
from Layout A (artboard 1b) in the canvas under [`design/`](design/) — score on
top of the rail, issues beneath. The left mode rail is borrowed from Layout B
(1c), reduced to Report / Fix / Cutaway / Setup now that score and issues share
a panel.
Tokens are transcribed into [`src/styles/tokens.css`](src/styles/tokens.css) —
change a value there, not in a component.

One rule from the brand kit drives the whole visual language: **mint is reserved
for the interface and never appears on the mesh**, so any colour on the model
itself always means "problem here" — red for non-manifold and open edges,
orange for flipped normals, yellow for degenerate faces.

Separate shells are the exception, and get their own token. They are a note
rather than a defect, so borrowing one of the three problem colours would say
the wrong thing, and mint is spoken for. Selecting a shell paints it in a cool
indigo (`--shell-select`) and drops everything else back to `--shell-dim`,
which reads as "this one" instead of "this is wrong".

> **Note on scope.** The design turn "Turn 2 — Mode rail, no slicing, Fix tab"
> conflicts with [`docs/spec.md`](docs/spec.md), which makes slicing an MVP
> feature (§5.5, §13) and puts auto-repair in Phase 2 (§6). Both shipped, in the
> form the design asked for: the slice viewer is here as Cutaway, and Fix is
> here as a full repair tab. Nothing in the rail generates G-code.

---

## Not in this version

Per spec §6, deliberately deferred: heatmap overlays, volume and filament
estimates, batch loading, arbitrary-angle cross sections, report export,
OBJ/3MF import, and merging separate shells.

Measurement is partial. The grid and the bounding box give you scale and overall
dimensions; picking two points and measuring between them does not ship.

Settings persistence (§6.9) is the one Phase 2 item that did ship — the Setup
panel writes to `localStorage` and the values are restored on startup — because
a tunable score is useless if you have to retype your nozzle diameter each time.

Meshlight is not a slicer and not a mesh editor.

---

## License

MIT — see [LICENSE](LICENSE).

Bundled typefaces are licensed separately under the SIL Open Font License 1.1:
[Space Grotesk](public/fonts/LICENSE-SpaceGrotesk.txt) and
[JetBrains Mono](public/fonts/LICENSE-JetBrainsMono.txt).
