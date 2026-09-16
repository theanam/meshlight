import { DEFAULT_SETTINGS } from '../core/types'
import type { RepairOptions } from '../core/repair'
import type { Settings } from '../core/types'
import { Viewport } from '../render/viewport'
import type { Mode } from '../store'
import { NO_REPAIRS, saveSettings, store } from '../store'
import type { WorkerRequest, WorkerResponse } from '../worker/protocol'
import { markSvg, railIcons, toolIcons } from './icons'
import {
  filterIssues,
  renderBreakdown,
  renderFix,
  renderIssues,
  renderScoreHeader,
  renderSettings,
  repairChoices,
} from './panels'

type RepairKey = keyof RepairOptions

const MODES: { id: Mode; label: string; icon: string }[] = [
  // Score and issues share one panel now (artboard 1b), so there is no
  // separate Score mode to switch to.
  { id: 'report', label: 'REPORT', icon: railIcons.report },
  { id: 'fix', label: 'FIX', icon: railIcons.fix },
  { id: 'cutaway', label: 'CUTAWAY', icon: railIcons.cutaway },
]

const PANEL_COPY: Record<Mode, { title: string; lede: string }> = {
  report: { title: 'Report', lede: '' },
  fix: {
    title: 'Fix',
    lede: 'Repairs Meshlight can make safely. Tick what you want, see it before you commit.',
  },
  cutaway: {
    title: 'Cutaway',
    lede: 'Drag the height handle to cut the model open and see what is actually inside.',
  },
  setup: {
    title: 'Setup',
    lede: 'Your printer, so the score reflects what you will actually print on.',
  },
}

export function mountApp(root: HTMLElement): void {
  root.innerHTML = shellHtml()

  const canvas = root.querySelector<HTMLCanvasElement>('.stage__canvas')!
  const shell = root.querySelector<HTMLElement>('.shell')!
  const drop = root.querySelector<HTMLElement>('.drop')!
  const dropError = root.querySelector<HTMLElement>('.drop__error')!
  const progress = root.querySelector<HTMLElement>('.progress')!
  const progressFill = root.querySelector<HTMLElement>('.progress__fill')!
  const progressStage = root.querySelector<HTMLElement>('.progress__stage')!
  const fileInput = root.querySelector<HTMLInputElement>('#file-input')!
  const panelBody = root.querySelector<HTMLElement>('.panel__body')!
  const panelHead = root.querySelector<HTMLElement>('.panel__head')!
  const panelFixed = root.querySelector<HTMLElement>('.panel__fixed')!
  const panelTitle = root.querySelector<HTMLElement>('.panel__title')!
  const panelLede = root.querySelector<HTMLElement>('.panel__lede')!
  const panelStat = root.querySelector<HTMLElement>('.panel__stat')!
  const rerun = root.querySelector<HTMLButtonElement>('#rerun')!
  const chip = root.querySelector<HTMLElement>('.chip--file')!
  const scorecard = root.querySelector<HTMLElement>('.scorecard')!
  const legend = root.querySelector<HTMLElement>('.legend')!
  const cutbar = root.querySelector<HTMLElement>('.cutbar')!
  const cutRange = root.querySelector<HTMLInputElement>('#cut-range')!
  const cutReadout = root.querySelector<HTMLElement>('.cutbar__readout')!
  const segmented = root.querySelector<HTMLElement>('.segmented:not(.segmented--compare)')!
  const gridButton = root.querySelector<HTMLButtonElement>('[data-action="grid"]')!
  const boxButton = root.querySelector<HTMLButtonElement>('[data-action="box"]')!
  const compare = root.querySelector<HTMLElement>('.segmented--compare')!

  const viewport = new Viewport(canvas)
  const worker = new Worker(new URL('../worker/mesh.worker.ts', import.meta.url), { type: 'module' })

  /** Keeps the last buffer around so re-running analysis after a settings
   *  change does not ask the user to pick the file again. */
  let lastBuffer: ArrayBuffer | null = null

  const send = (message: WorkerRequest, transfer: Transferable[] = []): void =>
    worker.postMessage(message, transfer)

  // ---- file intake ----------------------------------------------------

  function loadBuffer(buffer: ArrayBuffer, name: string): void {
    store.set({
      busy: true,
      error: null,
      fileName: name,
      selectedIssue: null,
      expandedIssue: null,
      selectedInstance: null,
    })
    // The worker takes ownership of the buffer it receives, so keep our own
    // copy for re-runs rather than reading the source a second time.
    lastBuffer = buffer.slice(0)
    send({ type: 'load', buffer, settings: store.get().settings }, [buffer])
  }

  async function loadFile(file: File): Promise<void> {
    loadBuffer(await file.arrayBuffer(), file.name)
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    if (file) void loadFile(file)
    fileInput.value = ''
  })

  root.querySelectorAll('[data-open-file]').forEach((button) =>
    button.addEventListener('click', () => fileInput.click()),
  )

  // Drag-drop works the moment the page loads — no onboarding gate (§8).
  let dragDepth = 0
  window.addEventListener('dragenter', (event) => {
    event.preventDefault()
    dragDepth++
    shell.classList.add('is-dragging')
  })
  window.addEventListener('dragleave', (event) => {
    event.preventDefault()
    if (--dragDepth <= 0) shell.classList.remove('is-dragging')
  })
  window.addEventListener('dragover', (event) => event.preventDefault())
  window.addEventListener('drop', (event) => {
    event.preventDefault()
    dragDepth = 0
    shell.classList.remove('is-dragging')
    const file = event.dataTransfer?.files?.[0]
    if (file) void loadFile(file)
  })

  // ---- worker replies -------------------------------------------------

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data
    switch (message.type) {
      case 'progress':
        progressStage.textContent = message.stage
        progressFill.style.width = `${Math.round(message.fraction * 100)}%`
        break

      case 'loaded': {
        const payload = message.payload
        viewport.setBuildVolume(store.get().settings.buildVolume)
        viewport.setModel(payload.positions, payload.indices, payload.bounds, payload.shellIds)
        viewport.setHighlights(payload.highlights)
        viewport.highlightShell(null)
        viewport.clearRepair()
        store.set({
          model: payload,
          score: payload.score,
          busy: false,
          error: null,
          selectedIssue: null,
          expandedIssue: null,
          selectedInstance: null,
          cutZ: null,
          repairOptions: { ...NO_REPAIRS },
          repairPreview: null,
          repairBusy: false,
        })
        const [minZ] = [payload.bounds.min[2]]
        cutRange.min = String(minZ)
        cutRange.max = String(payload.bounds.max[2])
        cutRange.step = String(Math.max(payload.bounds.size[2] / 400, 1e-4))
        cutRange.value = String(payload.bounds.center[2])
        break
      }

      case 'scored':
        store.set({ score: message.score })
        break

      case 'repaired': {
        const preview = message.preview
        viewport.setRepairPreview(preview.positions, preview.indices, preview.patch)
        viewport.showRepair(store.get().showRepair && store.get().mode === 'fix')
        store.set({ repairPreview: preview, repairBusy: false })
        break
      }

      case 'exported': {
        // Straight to the user's downloads — no server is ever involved.
        const base = (store.get().fileName ?? 'model.stl').replace(/\.stl$/i, '')
        const url = URL.createObjectURL(new Blob([message.stl], { type: 'model/stl' }))
        const link = document.createElement('a')
        link.href = url
        link.download = `${base}-fixed.stl`
        link.click()
        URL.revokeObjectURL(url)
        break
      }

      case 'section':
        viewport.setSection(message.segments, message.z)
        break

      case 'error':
        store.set({ busy: false, error: message.message, model: null, score: null })
        break
    }
  }

  // ---- rail -----------------------------------------------------------

  root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) =>
    button.addEventListener('click', () => {
      const mode = button.dataset.mode as Mode
      const state = store.get()

      // Entering cutaway mode shows a cut straight away rather than making the
      // user nudge the slider first. This belongs here, at the point the mode
      // actually changes — driving it from a store subscriber would mean
      // calling set() during a notify, which re-enters the subscriber list.
      if (mode === 'fix' && state.model) {
        // Artboard 2b opens with everything actionable already ticked, so the
        // first thing you see is the outcome rather than an empty checklist.
        const available = repairChoices(state.model.issues).filter((c) => c.count > 0)
        const options = { ...NO_REPAIRS }
        for (const choice of available) options[choice.key] = true
        store.set({ mode, repairOptions: options, showRepair: true, repairBusy: available.length > 0 })
        if (available.length > 0) send({ type: 'repair', options })
        return
      }

      if (mode === 'cutaway' && state.model) {
        const z = state.cutZ ?? state.model.bounds.center[2]
        cutRange.value = String(z)
        store.set({ mode, cutZ: z })
        viewport.setClipZ(z)
        send({ type: 'section', z })
        return
      }

      store.set({ mode })
    }),
  )

  // ---- viewport controls ----------------------------------------------

  segmented.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-view]')
    if (button) store.set({ shaded: button.dataset.view === 'shaded' })
  })

  root.querySelector('.stage__top')!.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]')
    if (!button) return
    const action = button.dataset.action
    if (action === 'fit') viewport.fitCamera()
    else if (action === 'box') store.set({ showBox: !store.get().showBox })
    else store.set({ showGrid: !store.get().showGrid })
  })

  compare.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-compare]')
    if (!button) return
    const show = button.dataset.compare === 'after'
    store.set({ showRepair: show })
    viewport.showRepair(show)
  })

  // ---- cutaway --------------------------------------------------------

  cutRange.addEventListener('input', () => {
    const z = Number(cutRange.value)
    store.set({ cutZ: z })
    viewport.setClipZ(z)
    send({ type: 'section', z })
  })

  // ---- panel interaction ----------------------------------------------

  panelBody.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    const state = store.get()
    const issues = filterIssues(state.model?.issues ?? [], state.filter)

    // A single occurrence: zoom in tight on that one defect.
    const instanceRow = target.closest<HTMLButtonElement>('[data-instance]')
    if (instanceRow) {
      const group = Number(instanceRow.dataset.group)
      const index = Number(instanceRow.dataset.instance)
      const issue = issues[group]
      const instance = issue?.instances[index]
      store.set({ selectedIssue: group, selectedInstance: index })
      // Shells are the one defect class with no highlight painted on the
      // mesh, because a whole solid cannot be outlined like a bad edge.
      // Picking one isolates it in its own colour instead.
      viewport.highlightShell(issue?.kind === 'shells' ? index : null)
      if (instance) viewport.focusOn(instance.focus, instance.radius)
      return
    }

    // The issue itself: frame the whole group and toggle its list open.
    const row = target.closest<HTMLButtonElement>('[data-issue]')
    if (!row) return
    const index = Number(row.dataset.issue)
    const issue = issues[index]
    const wasOpen = state.expandedIssue === index
    store.set({
      selectedIssue: index,
      expandedIssue: wasOpen ? null : index,
      selectedInstance: null,
    })
    // Stepping back up to the group drops the isolation.
    viewport.highlightShell(null)
    // Clicking an issue takes the camera there (spec §5.3).
    if (issue?.focus) viewport.focusOn(issue.focus)
  })

  panelBody.addEventListener('click', (event) => {
    const target = event.target as HTMLElement

    const toggle = target.closest<HTMLButtonElement>('[data-repair]')
    if (toggle && !toggle.disabled) {
      const key = toggle.dataset.repair as RepairKey
      const options = { ...store.get().repairOptions, [key]: !store.get().repairOptions[key] }
      store.set({ repairOptions: options, repairBusy: true })
      send({ type: 'repair', options })
      return
    }

    if (target.closest('#repair-reset')) {
      store.set({ repairOptions: { ...NO_REPAIRS }, repairPreview: null, repairBusy: false })
      viewport.clearRepair()
      return
    }

    if (target.closest('#repair-download')) {
      send({ type: 'exportRepair', options: store.get().repairOptions })
    }
  })

  panelBody.addEventListener('change', (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('[data-setting]')
    if (!input) return
    const settings = readSettings(panelBody, store.get().settings)
    store.set({ settings })
    saveSettings(settings)
    viewport.setBuildVolume(settings.buildVolume)
    if (store.get().model) send({ type: 'rescore', settings })
  })

  rerun.addEventListener('click', () => {
    if (!lastBuffer) return
    const buffer = lastBuffer.slice(0)
    store.set({ busy: true, error: null })
    send({ type: 'load', buffer, settings: store.get().settings }, [buffer])
  })

  // Development only. Vite substitutes `false` for import.meta.env.DEV in a
  // production build, so this branch and the sample module it pulls in are
  // both dropped from the bundle — a release always opens on the drop screen.
  if (import.meta.env.DEV) {
    void import('../dev/sample-mesh').then(({ SAMPLE_NAME, sampleStl }) => {
      if (store.get().model === null) loadBuffer(sampleStl(), SAMPLE_NAME)
    })
  }

  // ---- render ---------------------------------------------------------

  store.subscribe((state) => {
    const hasModel = state.model !== null

    drop.hidden = hasModel
    dropError.textContent = state.error ?? ''
    progress.hidden = !state.busy

    root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
      button.setAttribute('aria-current', String(button.dataset.mode === state.mode))
      // Only Cutaway is meaningless without a mesh. Report shows the drop
      // prompt and Setup is worth configuring before loading anything.
      button.disabled = !hasModel && button.dataset.mode === 'cutaway'
    })

    const errorCount = state.model?.issues.filter((i) => i.severity === 'error').length ?? 0
    const badge = root.querySelector<HTMLElement>('.rail__badge:not(.rail__badge--fix)')!
    badge.hidden = errorCount === 0
    badge.textContent = String(errorCount)

    // The Fix badge counts repairs on offer, not problems found.
    const repairable = state.model
      ? repairChoices(state.model.issues).filter((c) => c.count > 0).length
      : 0
    const fixBadge = root.querySelector<HTMLElement>('.rail__badge--fix')!
    fixBadge.hidden = repairable === 0
    fixBadge.textContent = String(repairable)

    viewport.setShaded(state.shaded)
    viewport.setGridVisible(state.showGrid)
    segmented.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) =>
      button.setAttribute('aria-pressed', String((button.dataset.view === 'shaded') === state.shaded)),
    )
    gridButton.setAttribute('aria-pressed', String(state.showGrid))
    viewport.setBoxVisible(state.showBox)
    boxButton.setAttribute('aria-pressed', String(state.showBox))

    // Chrome that only means something once a mesh is on screen.
    chip.hidden = !hasModel
    legend.hidden = !hasModel || state.mode === 'cutaway'
    cutbar.hidden = !hasModel || state.mode !== 'cutaway'
    shell.classList.toggle('is-cutaway', hasModel && state.mode === 'cutaway')

    if (state.mode !== 'cutaway') {
      viewport.setClipZ(null)
      viewport.clearSection()
    }

    const inFix = state.mode === 'fix' && hasModel
    compare.hidden = !inFix || state.repairPreview === null
    compare.querySelectorAll<HTMLButtonElement>('[data-compare]').forEach((button) => {
      button.setAttribute(
        'aria-pressed',
        String((button.dataset.compare === 'after') === state.showRepair),
      )
    })
    // The repaired mesh only ever shows inside Fix.
    viewport.showRepair(inFix && state.showRepair && state.repairPreview !== null)

    if (hasModel && state.model) {
      const m = state.model
      chip.querySelector('.chip__name')!.textContent = state.fileName ?? 'model.stl'
      // The numbers on the grid mark the strong lines; this says what one of
      // the small squares between them is worth, which they do not.
      const grid = state.showGrid && viewport.gridStep > 0 ? ` · cell ${fmtStep(viewport.gridStep)} mm` : ''
      const previewMesh = state.mode === 'fix' ? state.repairPreview : null
      chip.querySelector('.chip__meta')!.textContent = previewMesh
        ? `${m.triangleCount.toLocaleString()} → ${previewMesh.triangleCount.toLocaleString()} tri`
        :
        `${m.triangleCount.toLocaleString()} tri · ${m.bounds.size.map((n) => n.toFixed(1)).join(' × ')} mm${grid}`
    }

    if (state.score) {
      // Inside Fix the card reports the repair: the original struck through,
      // then what it becomes. Everywhere else it is just the score.
      const preview = state.mode === 'fix' ? state.repairPreview : null
      const shown = preview?.score ?? state.score

      const was = scorecard.querySelector<HTMLElement>('.scorecard__was')!
      const arrow = scorecard.querySelector<HTMLElement>('.scorecard__arrow')!
      was.hidden = preview === null
      arrow.hidden = preview === null
      was.textContent = String(state.score.total)

      const value = scorecard.querySelector<HTMLElement>('.scorecard__value')!
      value.textContent = String(shown.total)
      value.style.color =
        shown.total >= 80
          ? 'var(--accent)'
          : shown.total >= 50
            ? 'var(--defect-flipped)'
            : 'var(--defect-nonmanifold)'
      scorecard.querySelector('.scorecard__verdict')!.textContent = preview
        ? preview.watertight
          ? 'Watertight after repair'
          : shown.verdict
        : state.score.verdict
      if (preview) {
        scorecard.querySelector('.scorecard__hint')!.textContent =
          'preview only — nothing written yet'
      } else {
        const worst = [...state.score.components].sort((a, b) => a.ratio - b.ratio)[0]
        scorecard.querySelector('.scorecard__hint')!.textContent =
          worst && worst.status !== 'pass'
            ? `${worst.label.toLowerCase()} needs fixing — see Report`
            : 'nothing holding it back'
      }
    }

    const isReport = state.mode === 'report'
    panelHead.hidden = isReport
    panelFixed.hidden = !isReport || !hasModel
    panelTitle.textContent = PANEL_COPY[state.mode].title
    panelLede.textContent = PANEL_COPY[state.mode].lede

    // The floating scorecard is a stand-in for the panel: show it only when
    // the report rail is not already displaying the score, so the number is
    // always on screen exactly once.
    scorecard.hidden = !hasModel || (isReport && state.score !== null)

    if (isReport && hasModel && state.score) {
      panelFixed.innerHTML = renderScoreHeader(state.score) + renderBreakdown(state.score)
    }

    if (!hasModel) {
      panelBody.innerHTML =
        state.mode === 'setup'
          ? renderSettings(state.settings)
          : '<p class="empty">Drop an STL to get started. Nothing is uploaded — the file is read right here in this tab.</p>'
    } else if (isReport) {
      panelBody.innerHTML = renderIssues(
        filterIssues(state.model!.issues, state.filter),
        state.selectedIssue,
        state.expandedIssue,
        state.selectedInstance,
      )
    } else if (state.mode === 'fix') {
      panelBody.innerHTML = renderFix(
        repairChoices(state.model!.issues),
        state.repairOptions,
        state.repairPreview,
      )
    } else if (state.mode === 'cutaway') {
      panelBody.innerHTML = `
        <p class="empty">
          Drag the handle to cut the model at a height. Everything above the cut is
          hidden and the cross-section is drawn in mint, so you can see the interior —
          voids, trapped bubbles, walls that do not meet.
        </p>`
    } else if (state.mode === 'setup') {
      panelBody.innerHTML = renderSettings(state.settings)
    }

    panelStat.textContent = state.model
      ? `analysis ${(state.model.elapsedMs / 1000).toFixed(1)} s · worker`
      : 'no model loaded'
    rerun.disabled = !hasModel

    if (state.mode === 'cutaway' && state.model) {
      const z = state.cutZ ?? state.model.bounds.center[2]
      const span = state.model.bounds.size[2] || 1
      const percent = ((z - state.model.bounds.min[2]) / span) * 100
      cutReadout.textContent = `${z.toFixed(2)} mm · ${percent.toFixed(0)}%`
    }
  })

}

/** Grid steps are round numbers by construction, so print them as such:
 *  "0.5", not "0.50"; "20", not "20.0". */
function fmtStep(step: number): string {
  return String(Number(step.toPrecision(3)))
}

function readSettings(scope: HTMLElement, current: Settings): Settings {
  const read = (name: string, fallback: number): number => {
    const input = scope.querySelector<HTMLInputElement>(`[data-setting="${name}"]`)
    const value = Number(input?.value)
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  return {
    ...current,
    nozzleDiameter: read('nozzleDiameter', DEFAULT_SETTINGS.nozzleDiameter),
    overhangThreshold: read('overhangThreshold', DEFAULT_SETTINGS.overhangThreshold),
    buildVolume: [
      read('buildVolumeX', DEFAULT_SETTINGS.buildVolume[0]),
      read('buildVolumeY', DEFAULT_SETTINGS.buildVolume[1]),
      read('buildVolumeZ', DEFAULT_SETTINGS.buildVolume[2]),
    ],
  }
}

function shellHtml(): string {
  return `
  <div class="shell">
    <nav class="rail" aria-label="Mode">
      <span class="rail__mark">${markSvg(30)}</span>
      ${MODES.map(
        (mode) => `
        <button class="rail__item" data-mode="${mode.id}" aria-current="false">
          ${mode.icon}
          <span class="rail__label">${mode.label}</span>
          ${mode.id === 'report' ? '<span class="rail__badge" hidden>0</span>' : ''}
          ${mode.id === 'fix' ? '<span class="rail__badge rail__badge--fix" hidden>0</span>' : ''}
        </button>`,
      ).join('')}
      <span class="rail__spacer"></span>
      <button class="rail__item" data-mode="setup" aria-current="false">
        ${railIcons.setup}
        <span class="rail__label">SETUP</span>
      </button>
    </nav>

    <main class="stage">
      <canvas class="stage__canvas"></canvas>

      <div class="stage__top">
        <div class="chip chip--file" hidden>
          <span class="chip__name"></span>
          <span class="chip__meta"></span>
        </div>
        <span class="stage__spacer"></span>
        <div class="segmented segmented--compare" hidden>
          <button data-compare="before" aria-pressed="false">Before</button>
          <button data-compare="after" aria-pressed="true">After</button>
        </div>
        <!-- Shaded and Wire are two ways of drawing one model, so they stay
             a picker. Grid is an on/off state and Fit is a one-shot action;
             neither belongs in a group that says "pick one of these". -->
        <div class="segmented">
          <button data-view="shaded" aria-pressed="true">Shaded</button>
          <button data-view="wire" aria-pressed="false">Wire</button>
        </div>
        <button class="iconbtn" data-action="grid" aria-pressed="true"
                aria-label="Grid" data-tip="Grid — a ruler on the build plane">${toolIcons.grid}</button>
        <button class="iconbtn" data-action="box" aria-pressed="true"
                aria-label="Bounding box" data-tip="Bounding box — measured extents">${toolIcons.box}</button>
        <button class="iconbtn" data-action="fit"
                aria-label="Fit view" data-tip="Fit the model in view">${toolIcons.fit}</button>
      </div>

      <div class="scorecard" hidden>
        <span class="scorecard__figure">
          <span class="scorecard__label mono">PRINTABILITY</span>
          <span class="scorecard__reading">
            <span class="scorecard__was mono" hidden>—</span><span class="scorecard__arrow" hidden>→</span><span class="scorecard__value mono">—</span><span class="scorecard__outof mono">/100</span>
          </span>
        </span>
        <span class="scorecard__text">
          <span class="scorecard__verdict"></span>
          <span class="scorecard__hint"></span>
        </span>
      </div>

      <div class="legend" hidden>
        <span class="legend__item"><span class="legend__swatch-line" style="background:var(--defect-nonmanifold)"></span>non-manifold</span>
        <span class="legend__item"><span class="legend__swatch-line" style="background:var(--defect-flipped)"></span>flipped</span>
        <span class="legend__item"><span class="legend__swatch-dot" style="background:var(--defect-degenerate)"></span>degenerate</span>
      </div>

      <div class="cutbar" hidden>
        <span class="cutbar__label mono">Z</span>
        <input type="range" id="cut-range" min="0" max="1" step="0.001" value="0.5" aria-label="Cut height">
        <span class="cutbar__readout mono">—</span>
      </div>

      <div class="drop">
        ${markSvg(56, 5)}
        <h1 class="drop__title">Drop an STL</h1>
        <p class="drop__lede">
          Meshlight checks the mesh for holes, flipped faces and loose shells,
          scores how well it will print, and lets you cut through it to see inside.
        </p>
        <span class="drop__promise"><span class="dot"></span>nothing leaves your machine</span>
        <button class="btn btn--primary drop__cta" data-open-file>Choose a file</button>
        <p class="drop__error" role="alert"></p>
      </div>

      <div class="progress" hidden>
        <span class="progress__stage">Working</span>
        <span class="progress__track"><span class="progress__fill"></span></span>
      </div>
    </main>

    <aside class="panel">
      <div class="panel__head" hidden>
        <h2 class="panel__title">Report</h2>
        <p class="panel__lede"></p>
      </div>
      <!-- Report mode pins the score and its breakdown to the top of the rail
           so they stay put while the issue list below scrolls. -->
      <div class="panel__fixed" hidden></div>
      <div class="panel__body"></div>
      <!-- Opening a file used to sit over the 3D view, where it covered the
           model and competed with the view tools. It belongs next to Re-run:
           both are about which mesh is loaded, not about how it is drawn. -->
      <div class="panel__foot">
        <span class="panel__stat">no model loaded</span>
        <div class="panel__actions">
          <button class="btn" data-open-file>Open file</button>
          <button class="btn" id="rerun" disabled>Re-run</button>
        </div>
      </div>
    </aside>
  </div>

  <input type="file" id="file-input" accept=".stl,model/stl" hidden>`
}
