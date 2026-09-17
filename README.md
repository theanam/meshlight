# Meshlight

**A browser-based mesh inspector that runs entirely on your machine.**

Drop in a mesh and Meshlight checks it for the things that ruin a print — holes,
non-manifold edges, flipped normals, loose shells — scores how well it will
actually print, and lets you cut through it to see the interior.

Reads **STL** (binary and ascii), **OBJ**, **PLY** (ascii and both binary byte
orders) and **3MF**.

Your mesh is not uploaded. There is no server to upload it to. The file is read
in your browser tab and never leaves it, which is a property of how the app is
built rather than a policy you have to take on trust.

**[meshlight.org](https://meshlight.org)**

- **Free and open source** (MIT)
- **100% client-side** — no backend, no accounts, and your mesh never leaves the tab
- **Works offline** — after one visit it runs with the network off for good
- Hosted as a static site on GitHub Pages

One exception, stated plainly because the rest of this page makes a strong
claim: **meshlight.org loads Google Analytics** and counts page views. It is
injected into the deployed build only and runs only on that hostname, so
`npm run dev`, a local build, and any fork or self-host carry no analytics at
all — see `analytics()` in [`vite.config.ts`](vite.config.ts). It sees a page
view. It never sees your file, which is parsed and analysed entirely in the
tab and is never sent anywhere.

---

## Formats

| Format | Notes |
| --- | --- |
| STL | Binary and ascii. Detected by size arithmetic (`84 + 50n`), not the `solid` keyword, which binary exporters also write |
| OBJ | `v` and `f` only. Negative (relative) indices and n-gons handled; materials, normals and texture coordinates ignored |
| PLY | ascii, `binary_little_endian` and `binary_big_endian`. Extra vertex properties (colour, confidence) are skipped over |
| 3MF | ZIP container inflated with the platform's own `DecompressionStream` — no bundled inflate. Handles ZIP64, the production extension (geometry in separate parts), namespace-prefixed elements, unit conversion to mm, and build-item and component transforms |

Every format collapses to the same triangle soup in
[`src/core/mesh-loader.ts`](src/core/mesh-loader.ts), so indexing, analysis,
scoring, sectioning and repair never learn what the file was. Adding a format
means adding a parser and nothing else.

The loader sniffs magic bytes before trusting the extension, so a PLY saved as
`.stl` still opens correctly — the detected format is shown next to the
triangle count.

Two things about 3MF are worth knowing, because a reader that skips either
opens almost nothing real:

- **ZIP64 is not just for huge files.** Writers opt in regardless of size, so a
  40 KB 3MF routinely stores `0xFFFFFFFF` sentinels in the ordinary
  end-of-central-directory record and the true offsets in a ZIP64 record
  behind it. Reading only the 32-bit fields finds no entries at all.
- **The geometry is usually not in `3dmodel.model`.** Bambu Studio, Orca and
  PrusaSlicer use the production extension: the root part is a few kilobytes
  of build instructions, and every triangle lives in `3D/Objects/*.model`,
  referenced by `p:path`. Those parts are followed and their object ids are
  scoped per part, since two parts may each define object `1`.

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

### 3D printing readiness
Under the issues sits a second pass that asks a different question. The score
answers "is this mesh sound"; these answer "what happens when I press print" —
a watertight, perfectly wound model can still be unprintable because it is
0.2 mm thick or balanced on a corner. Each check states what was measured, then
what to do about it:

| Check | What it tells you |
| --- | --- |
| Fine detail | The thinnest feature in the model, against your nozzle. Under one nozzle width nothing is extruded at all, so the detail comes out as a gap rather than a thin wall |
| Supports | How much of the surface area leans past your overhang angle, excluding the faces resting on the plate |
| Bed adhesion | How much of the part lies flat on the plate, and over what area — a small footprint wants a brim |
| Stability | Height against the narrowest footprint dimension; tall and narrow parts ring and shear off |
| Plate fit | Whether it fits as it stands, only once turned — and by how many degrees — or not at all |
| Separate bodies | How many solids will be printed, and how many start in mid-air |

Plate fit is asked over every orientation the part could be turned to, not just
the two the axes happen to offer. A bar lying diagonally measures its own
diagonal on both axes: 200 × 30 mm at 45° reads as 155 × 155, which is true of
the extents and wrong about the bed. The search is exhaustive rather than
sampled — a convex footprint that fits a rectangle at all fits with one of its
own hull edges parallel to a bed side, so trying each of those settles it.

Everything is measured, not guessed. Overhangs are weighted by area rather than
face count, so one large downward face outranks a thousand tiny ones on a
tessellated curve, and faces resting on the build plate are excluded — they
point straight down and would otherwise read as the worst overhang in the
model when they are in fact the first layer.

The checks re-run when you change your nozzle, overhang angle or build volume
in Setup, so they always describe the printer you are actually using.

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

The export is always STL, whatever went in — an OBJ, PLY or 3MF comes back out
as `name-fixed.stl`. STL is what every slicer takes, and the formats Meshlight
reads carry things it deliberately drops on the way in (materials, colours,
3MF's build metadata), so writing them back would mean writing them back wrong.

**Not included: merging separate shells.** A true merge is a boolean union,
which needs a CSG kernel well beyond what is here. Faking it — welding shells
that happen to touch, say — would hand you a file that claims to be one solid
and is not, which is worse than not offering it.

### Edit
Basic mesh modification, run in the worker. Tools act on the part selected in
the viewport, or on the whole model when nothing is selected.

**Edits are a draft until you apply them.** The Edit tab has its own working
mesh; Report, Fix, Cutaway and the score go on describing the mesh as it was,
and the viewport draws whichever of the two the tab you are on is talking about.
`Apply N changes to the loaded model` promotes the working mesh, re-runs the
full analysis and hands it to everything else.

The button says *loaded model* and repeats the caveat on its own second line,
because this is the point someone is most likely to assume they have saved
something: applying changes the copy held in the tab and nothing on disk. The
file you opened is never written to. `Export` is what produces a file, and it
always produces a new one.

| Tool | What it does |
| --- | --- |
| Scale | Uniform resize about the selection's own centre, so it grows in place |
| Rotate | Quarter turns or a free angle about X, Y or Z |
| Cut | Drag a line across the viewport; the model is cut along it and both faces are capped |
| Delete part | Removes the selected body — `Delete`/`Backspace` does the same |
| Export part | Writes the selected body alone as `name-part-N.stl` |
| Apply | Promotes the working mesh so every other tab describes it |

**The cut is drawn, not dialled.** A line on screen does not name a plane by
itself — it names every plane containing it. The one you mean is the plane
through the eye and the two endpoints, which under a perspective camera is
exactly the set of world points landing on that line, so the seam follows the
stroke. Orbit first to choose the angle; `Keep` decides whether you get both
halves as separate parts or only the near or far side.

Cutting is a real split, not a clipping plane: straddling triangles are clipped
with Sutherland–Hodgman, the edges the plane carves are chained into loops, and
each loop is ear-clipped into a cap wound to face out of its own half. The two
halves are welded separately and then placed in one buffer *without* welding
across, so they stay two parts you can select, export or delete rather than one
solid with an internal wall.

A plane passing exactly through a vertex is the one case the algorithm cannot
express — it finds the cut boundary by looking at where triangles straddle, and
a plane running along a model's own edge straddles nothing there. Rather than
special-case coplanar geometry, the plane slides a few microns until it meets
only triangle interiors; on a 100 mm part that is under three microns, far below
any printer's resolution. Cut an axis-aligned box corner to corner and you can
see why it is needed: the plane lies along two of its edges.

**Undo is a stack of whole meshes**, not inverse operations. Every edit is
already a pure function returning a new mesh, so keeping the old one is both
simpler and exact — a cut is not invertible any other way. History is capped at
24 steps or roughly 192 MB of geometry, whichever runs out first, and `Ctrl`/`⌘`
`+Z` works wherever a mesh is loaded.

`Discard all N edits and put every tab back` restores the mesh kept from load
rather than re-parsing, and resets the applied model with it, so the whole app
returns to the file as opened. It goes on the undo stack on the way past — so
discarding everything is recoverable from the same Undo that recovers a
mis-drawn cut, which otherwise would be the one action in the panel you could
not take back. Each history entry carries the edit count that was current when
its mesh was, so undoing a discard restores the depth it had before rather than
one less than whatever it happens to be now.

**Edits stay inside the Edit tab until applied.** No other mode's chrome changes
shape because a mesh has been edited — unapplied changes show as a badge on the
Edit tab and nowhere else. The badge is mint rather than red: red on the Report
and Fix badges means something is wrong with the mesh, and an edit is a state,
not a defect. It counts unapplied changes, or shows a dot in the one case with
nothing sensible to count — undoing back past an apply leaves a mesh that
differs from the applied one while the count reads zero.

**No score in Edit.** The printability score grades a mesh for printing, which
is not the question you are asking while you are still changing its shape — and
over an unapplied draft it would be grading geometry that is not even the one on
screen. The defect legend goes with it, for the same reason: those highlights
belong to the applied analysis, and over a draft they would be marking edges
that may no longer exist. The file chip stays, reading the working mesh with the
applied count beside it, so the difference an unapplied edit has made is legible
without leaving the tab.

A draft costs a shell trace, not a full analysis (`findShells` in
[`analysis.ts`](src/core/analysis.ts)): the Edit tab redraws and re-selects parts
on every step and has no use for an issue list, a score or highlights until the
edits are applied. Skipping the rest is most of the cost.

**Not included: boolean union, move, and mirror.** Merging shells still needs a
CSG kernel (see Fix). Move and mirror were left out of the first pass rather
than ruled out.

### Viewport
Two reference overlays answer "how big is this, actually", which a fitted camera
otherwise hides — a 4 mm bracket and a 300 mm vase fill the frame identically.

- **Grid** — a ruler on the build plane, at the height the model's lowest point
  sits. Spacing adapts to the part so it always lands on a 1, 2 or 5 × 10ⁿ step
  with roughly twenty cells across the footprint, majors are numbered in
  millimetres, and the configured build volume is drawn as a plate outline.
  A bed is drawn from the first visit: the score has always graded "fits build
  volume" against the default 220 × 220 × 250, and the viewport used to refuse
  to draw the bed it was grading against. It carries the Setup numbers
  unlabelled until you pick your printer from the plate button, which then
  writes that machine's name on it. Choose `None` to turn it off; the choice
  is remembered, and the score reads the same volume either way.
- **Bounding box** — the part's extents, with its three dimensions written on
  the edges that measure them.
- **Select parts** — off by default. With it on, clicking a body in the
  viewport isolates it: the shell is painted indigo, everything else drops
  back, and it gets its own dimensioned box so you can measure one part of a
  multi-body file without splitting the file up. Clicking empty space clears
  it. A drag is still an orbit — only a press that stays put counts as a
  selection — and the same selection drives the shell rows in the report, so
  clicking a part and clicking its row in the list mean the same thing.

Both toggle from round buttons over the viewport, next to the Shaded / Wire
picker and the Fit control. Grid numbers use the same millimetre coordinates
the report quotes for every defect, so a position in the list and a position on
the plane are the same reading.

**Colour.** The model can be painted in one of six colours from the drop button
in the top bar — slate, bone, graphite, steel, copper or sage. It is filament
colour, not decoration: a part is easier to judge in something close to what it
will be printed in, and a light bone shows shallow surface detail that slate
swallows. The choice is saved with the rest of your settings.

The palette is deliberately narrow. Saturated red, orange and yellow mean a
defect, mint means geometry a repair added, and indigo means the part you
picked — every one of those is a claim about the mesh, and a body wearing one
would be making that claim by accident. So the colours on offer are neutrals
and hues held far enough down in saturation to read as a material rather than
as a finding, and nothing else in the viewport moves with them: the highlights,
the patch, the selected shell, the grid and the boxes keep their own meanings.
The cut face is the exception, and follows the surface a shade darker, because
it is the same material seen from inside.

### Cutaway
Drag the vertical Z handle to cut the model open. Everything above the cut is
clipped away and the cross-section is drawn in mint. The slider runs the full
height of the viewport, the way a slicer's layer slider does: the cut travels
the whole part, so the same drag buys more resolution, and the track lights up
below the handle to show how much of the part survives. The height rides the
handle rather than sitting at the end of the bar — millimetres first, then the
percentage of the part's Z span — because at that length the ends are most of a
screen apart, and looking away from the cut to find out where the cut is
defeats the point of putting the number on the model. Triangles are binned into
Z-slabs at load time, so scrubbing only ever touches the slab under the cursor.

**Capped and open sections.** The cut face is filled in by default, so a
section through solid material reads as solid and a section through a cavity
reads as a hole. The `Cap` button in the top bar turns the fill off, leaving an
**open section**: nothing covers the cut, so you look straight down into the
part and can see internal walls, trapped voids and shells that float below the
plane. Capped answers "is there material here"; open answers "what is under
here". They are different questions, which is why both are kept rather than one
being the correct rendering.

The fill is drawn with the stencil buffer rather than by triangulating the
cross-section. Every back face behind the plane increments the stencil and
every front face decrements it, so what is left set is exactly where a ray
entered the solid and did not leave — the material. A plane drawn through that
mask is the section, exact for any shape, holes and nested shells included,
with no polygon stitching to get wrong. It needs a stencil buffer, which
three.js has not requested by default since r163.

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
so every asset is referenced relatively and the same build works from a custom
domain at the root or from a project sub-path.

The site is served from **meshlight.org**. The domain lives in two places and
needs both: the apex `A` records point at GitHub's four Pages addresses, and
[`public/CNAME`](public/CNAME) carries it into `dist/` on every build, so a
deploy cannot leave the Pages configuration without a domain to serve from.

Two settings under Settings → Pages, each needed once:

- **Source → GitHub Actions.** Without it the workflow fails at
  `configure-pages` with `Get Pages site failed ... Not Found`. It cannot be
  done from the workflow — `GITHUB_TOKEN` may read a Pages site but not create
  one, so `enablement: true` fails with `Resource not accessible by integration`.
- **Enforce HTTPS**, once GitHub has issued the certificate for the domain.
  This one is not cosmetic: service workers only register in a secure context,
  so until the certificate is live the offline guarantee below does not hold.

---

## How it works

The pipeline is one-directional and each stage is a pure function over typed
arrays, independent of Three.js and the DOM:

```
parse -> index/weld -> adjacency -> analysis -> score
                              \
                               -> Z-buckets -> section
```

- [`src/core/mesh-loader.ts`](src/core/mesh-loader.ts) — format sniffing and
  dispatch; the parsers themselves live in
  [`src/core/formats/`](src/core/formats/).
- [`src/core/indexer.ts`](src/core/indexer.ts) — every format arrives as a
  triangle soup, so corners are welded onto an epsilon grid before any topology
  question can be asked. STL has no shared vertices to begin with; OBJ, PLY and
  3MF do, but the loader flattens them anyway and lets welding rebuild the
  sharing. That is deliberate: a file's own indices say who the author grouped,
  not which corners actually meet, and two faces written a hair apart are a
  hole to a printer no matter what the index buffer claims. The cost is that an
  intentional seam welds shut if it is tighter than the epsilon.
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

The app makes **no runtime network requests of its own**. Three.js is bundled and
both typefaces are self-hosted, so there is no CDN in the loop and nothing to
fetch once the tab is open.

The analytics tag on meshlight.org is the one request that leaves, and it is
outside this guarantee by construction: it is not precached, the service worker
ignores cross-origin requests entirely, and it fails silently with the network
off. Offline behaviour is identical with it and without it.

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
estimates, batch loading, arbitrary-angle cross *sections*, report export,
and merging separate shells. Arbitrary-angle **cuts** did ship, in Edit — the
section view still only reads horizontal slabs, because that is what the Z
bucketing it scrubs through is built on.

Auto-cutting a part to fit the build plate is not in yet. The cut and the
plate-fit check both exist; nothing joins them up and picks the plane for you.

Measurement is partial. The grid and the bounding box give you scale and overall
dimensions; picking two points and measuring between them does not ship.

Settings persistence (§6.9) is the one Phase 2 item that did ship — the Setup
panel writes to `localStorage` and the values are restored on startup — because
a tunable score is useless if you have to retype your nozzle diameter each time.

Meshlight is not a slicer. It is now a *basic* mesh editor — delete, scale,
rotate, cut and per-part export (see Edit) — but not a modeller: there is no
boolean union, no sculpting and no topology editing, and there is no plan for
any of them.

---

## License

MIT — see [LICENSE](LICENSE).

Bundled typefaces are licensed separately under the SIL Open Font License 1.1:
[Space Grotesk](public/fonts/LICENSE-SpaceGrotesk.txt) and
[JetBrains Mono](public/fonts/LICENSE-JetBrainsMono.txt).
