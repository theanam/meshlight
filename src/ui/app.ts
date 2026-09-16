import { FILE_INPUT_ACCEPT, SUPPORTED_EXTENSIONS, baseName } from '../core/mesh-loader'
import { DEFAULT_SETTINGS } from '../core/types'
import type { RepairOptions } from '../core/repair'
import type { Settings } from '../core/types'
import { NavCube } from '../render/navcube'
import { Viewport } from '../render/viewport'
import type { Mode } from '../store'
import { NO_REPAIRS, saveSettings, store } from '../store'
import type {
  DraftPayload,
  EditOp,
  LoadedPayload,
  WorkerRequest,
  WorkerResponse,
} from '../worker/protocol'
import type { Axis, CutKeep } from '../core/edit'
import { renderEdit } from './edit-panel'
import { REPO_URL, githubIcon, helpHtml, mountHelp } from './help'
import { markSvg, railIcons, toolIcons } from './icons'
import { PLATE_PRESETS, findPlate, plateLabel } from './plates'
import {
  filterIssues,
  renderBreakdown,
  renderFix,
  renderIssues,
  renderReadiness,
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
  { id: 'edit', label: 'EDIT', icon: railIcons.edit },
  { id: 'cutaway', label: 'CUTAWAY', icon: railIcons.cutaway },
]

const PANEL_COPY: Record<Mode, { title: string; lede: string }> = {
  report: { title: 'Report', lede: '' },
  fix: {
    title: 'Fix',
    lede: 'Repairs Meshlight can make safely. Tick what you want, see it before you commit.',
  },
  edit: {
    title: 'Edit',
    lede: 'Take parts out, resize them, turn them, cut the model along a line you draw.',
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
  const plateButton = root.querySelector<HTMLButtonElement>('[data-action="plate"]')!
  const partsButton = root.querySelector<HTMLButtonElement>('[data-action="parts"]')!
  const viewbar = root.querySelector<HTMLElement>('.viewbar')!
  const cubeCanvas = root.querySelector<HTMLCanvasElement>('.viewbar__cube')!
  const plateMenu = root.querySelector<HTMLElement>('[data-menu="plate"]')!
  const compare = root.querySelector<HTMLElement>('.segmented--compare')!
  const cutline = root.querySelector<SVGSVGElement>('.cutline')!
  const cutStroke = root.querySelector<SVGLineElement>('.cutline__stroke')!
  const stage = root.querySelector<HTMLElement>('.stage')!

  const viewport = new Viewport(canvas)
  // Clicking a face looks from that face; the cube follows the camera through
  // the viewport's per-frame callback rather than polling it.
  const navCube = new NavCube(
    cubeCanvas,
    (direction) => viewport.orientTo(direction),
    (theta, phi) => viewport.orbitBy(theta, phi),
  )
  viewport.onFrame = (orientation) => navCube.sync(orientation)
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
    send({ type: 'load', buffer, settings: store.get().settings, fileName: name }, [buffer])
  }

  async function loadFile(file: File): Promise<void> {
    loadBuffer(await file.arrayBuffer(), file.name)
  }

  // ---- edits ----------------------------------------------------------

  /** Whichever payload's geometry is currently uploaded, so the swap between
   *  the draft and the applied model happens once per change rather than on
   *  every store notification — rebuilding the buffers, the feature edges and
   *  the wireframe sixty times a second would be visible. */
  let shownGeometry: unknown = null

  /** The Edit tab draws its working mesh; every other tab draws the applied
   *  model. That split is the whole point of applying: a report has to be
   *  describing the geometry it is drawn next to. */
  function showGeometry(state: { mode: Mode; model: LoadedPayload | null; draft: DraftPayload | null }): void {
    const wanted = state.mode === 'edit' && state.draft ? state.draft : state.model
    if (wanted === shownGeometry) return
    shownGeometry = wanted
    if (!wanted) return

    // Keep the camera: after a cut you want to see the seam you just drew,
    // from where you drew it, and switching tabs should not move the view.
    viewport.setModel(wanted.positions, wanted.indices, wanted.bounds, wanted.shellIds, true)
    // Defect highlights belong to the applied analysis. Over a draft they
    // would be marking edges that may no longer exist.
    viewport.showOnly(wanted === state.model ? null : [])
  }



  /** Whether the part currently selected still means the same thing once the
   *  edit in flight comes back.
   *
   *  Shell numbers are positions in the analysis, so anything that adds or
   *  removes a shell renumbers the rest. Scaling and turning leave the
   *  triangle order alone, so the selection survives those and only those. */
  let selectionSurvivesEdit = false

  function sendEdit(op: EditOp): void {
    selectionSurvivesEdit = op.kind === 'scale' || op.kind === 'rotate'
    store.set({ editBusy: true, editOutcome: null, editRefusal: null })
    send({ type: 'edit', op })
  }

  /** Which part the tools act on: the selected one, or the whole model. */
  const editTarget = (): number | null => store.get().selectedShell

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
        shownGeometry = null
        viewport.setBuildVolume(
          store.get().settings.buildVolume,
          plateLabel(store.get().settings.platePreset),
        )
        viewport.setModel(payload.positions, payload.indices, payload.bounds, payload.shellIds)
        viewport.setHighlights(payload.highlights)
        viewport.clearRepair()
        store.set({
          model: payload,
          score: payload.score,
          readiness: payload.readiness,
          busy: false,
          error: null,
          selectedIssue: null,
          expandedIssue: null,
          selectedInstance: null,
          selectedShell: null,
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
        store.set({ score: message.score, readiness: message.readiness })
        break

      case 'repaired': {
        const preview = message.preview
        viewport.setRepairPreview(preview.positions, preview.indices, preview.patch)
        viewport.showRepair(store.get().showRepair && store.get().mode === 'fix')
        store.set({ repairPreview: preview, repairBusy: false })
        break
      }

      case 'drafted': {
        const draft = message.draft
        const keptShell =
          selectionSurvivesEdit && (store.get().selectedShell ?? 0) < draft.shellCount
            ? store.get().selectedShell
            : null

        store.set({
          draft,
          busy: false,
          editBusy: false,
          error: null,
          history: message.history,
          editOutcome: message.outcome,
          editRefusal: null,
          selectedShell: keptShell,
        })
        break
      }

      case 'applied': {
        const payload = message.payload
        viewport.setHighlights(payload.highlights)
        viewport.clearRepair()

        store.set({
          model: payload,
          draft: null,
          score: payload.score,
          readiness: payload.readiness,
          busy: false,
          editBusy: false,
          error: null,
          history: message.history,
          editOutcome: message.outcome,
          editRefusal: null,
          selectedShell: null,
          selectedIssue: null,
          expandedIssue: null,
          selectedInstance: null,
          cutZ: null,
          // The mesh moved on, so anything the Fix panel was previewing
          // described a shape that no longer exists.
          repairOptions: { ...NO_REPAIRS },
          repairPreview: null,
          repairBusy: false,
        })

        cutRange.min = String(payload.bounds.min[2])
        cutRange.max = String(payload.bounds.max[2])
        cutRange.step = String(Math.max(payload.bounds.size[2] / 400, 1e-4))
        cutRange.value = String(payload.bounds.center[2])
        break
      }

      case 'editRefused':
        store.set({ editBusy: false, editRefusal: message.message, editOutcome: null })
        break

      case 'exported': {
        // Straight to the user's downloads — no server is ever involved.
        const base = baseName(store.get().fileName ?? 'model')
        const url = URL.createObjectURL(new Blob([message.stl], { type: 'model/stl' }))
        const link = document.createElement('a')
        link.href = url
        link.download = `${base}-${message.suffix}.stl`
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

      // Selecting a part is the premise of the Edit tab, so arriving there
      // switches picking on rather than making it a second thing to discover.
      if (mode === 'edit' && state.model) {
        store.set({ mode, pickParts: true, editOutcome: null, editRefusal: null })
        return
      }

      // Leaving Edit puts the pointer back to orbiting, whatever was armed.
      if (state.mode === 'edit' && mode !== 'edit') {
        store.set({ cutArmed: false, editOutcome: null, editRefusal: null })
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

  // ---- help ------------------------------------------------------------

  const help = mountHelp(root)

  root.querySelectorAll<HTMLElement>('[data-action="help"]').forEach((trigger) =>
    trigger.addEventListener('click', () => help.toggle()),
  )

  document.addEventListener('keydown', (event) => {
    // Setup is a form, so "?" has to stay a character anywhere it could be one.
    const target = event.target as HTMLElement | null
    if (target?.closest('input, textarea, select')) return

    // Undo is a reflex, so it is bound wherever a mesh is loaded rather than
    // only while the Edit panel happens to be open.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      if (!store.get().model) return
      event.preventDefault()
      const direction = event.shiftKey ? 'redo' : 'undo'
      const { history } = store.get()
      if (direction === 'undo' ? !history.canUndo : !history.canRedo) return
      selectionSurvivesEdit = false
      store.set({ editBusy: true })
      send({ type: 'history', direction })
      return
    }

    // Delete removes the selected part, but only in Edit — a destructive key
    // needs the visible button beside it, and a part can be selected from any
    // mode. Backspace too: on a Mac that key is labelled Delete.
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const state = store.get()
      if (state.mode !== 'edit' || state.selectedShell === null || state.editBusy) return
      event.preventDefault()
      sendEdit({ kind: 'delete', shell: state.selectedShell })
      return
    }

    if (event.key === 'Escape' && store.get().cutArmed) {
      cutFrom = null
      cutline.setAttribute('hidden', '')
      store.set({ cutArmed: false })
      return
    }

    if (event.key === '?') {
      event.preventDefault()
      help.toggle()
    } else if (event.key === 'Escape' && help.isOpen) {
      help.close()
    }
  })

  // ---- viewport controls ----------------------------------------------

  segmented.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-view]')
    if (button) store.set({ shaded: button.dataset.view === 'shaded' })
  })

  // The controls sit in two places now — the view picker with the cube, the
  // overlay toggles up beside Shaded/Wire — so this listens across the stage
  // and answers only to the actions it owns. `help` also lives here.
  const VIEW_ACTIONS = new Set(['reset', 'fit', 'parts', 'box', 'plate', 'grid'])
  root.querySelector('.stage')!.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]')
    if (!button || !VIEW_ACTIONS.has(button.dataset.action ?? '')) return
    const action = button.dataset.action
    if (action === 'reset') viewport.resetView()
    else if (action === 'fit') viewport.fitCamera()
    else if (action === 'parts') {
      const on = !store.get().pickParts
      // Leaving the mode drops the selection with it, so the viewport never
      // keeps a part isolated by a mode that is no longer on.
      store.set({ pickParts: on, selectedShell: on ? store.get().selectedShell : null })
    } else if (action === 'box') store.set({ showBox: !store.get().showBox })
    else if (action === 'plate') {
      // Nothing to show until a bed has been chosen, so the first press opens
      // the menu rather than toggling a plate that does not exist yet.
      if (store.get().settings.platePreset === 'none') openPlateMenu()
      else {
        store.set({ showPlate: !store.get().showPlate })
        // Pull the bed into frame on the way in, and back to the part on the
        // way out. Either way the press has a visible result.
        viewport.fitCamera()
      }
    } else store.set({ showGrid: !store.get().showGrid })
  })

  compare.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-compare]')
    if (!button) return
    const show = button.dataset.compare === 'after'
    store.set({ showRepair: show })
    viewport.showRepair(show)
  })

  // ---- picking parts in the viewport ----------------------------------

  // OrbitControls owns the same pointer, so a press only counts as a selection
  // if it did not turn into a drag. Anything further or slower than this is
  // someone rotating the model, and stealing that would make the view stick.
  const CLICK_SLOP_PX = 4
  const CLICK_MS = 500
  let pressedAt = 0
  let pressX = 0
  let pressY = 0

  canvas.addEventListener('pointerdown', (event) => {
    pressedAt = event.timeStamp
    pressX = event.clientX
    pressY = event.clientY
  })

  canvas.addEventListener('pointerup', (event) => {
    if (!store.get().pickParts || store.get().cutArmed || event.button !== 0) return
    if (event.timeStamp - pressedAt > CLICK_MS) return
    if (Math.hypot(event.clientX - pressX, event.clientY - pressY) > CLICK_SLOP_PX) return

    // Empty space clears the selection, which is the only obvious way back out
    // of an isolated part.
    store.set({ selectedShell: viewport.pickShell(event.clientX, event.clientY) })
  })

  // ---- drawing a cut line ---------------------------------------------

  /** Screen point of the drag in progress, or null when nothing is being
   *  drawn. Held here rather than in the store: it changes on every pointer
   *  move, and re-rendering the panel sixty times a second to show a line
   *  that is drawn in SVG anyway would be absurd. */
  let cutFrom: [number, number] | null = null

  function drawCutLine(from: [number, number], to: [number, number]): void {
    const rect = stage.getBoundingClientRect()
    cutStroke.setAttribute('x1', String(from[0] - rect.left))
    cutStroke.setAttribute('y1', String(from[1] - rect.top))
    cutStroke.setAttribute('x2', String(to[0] - rect.left))
    cutStroke.setAttribute('y2', String(to[1] - rect.top))
    cutline.removeAttribute('hidden')
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (!store.get().cutArmed || event.button !== 0) return
    cutFrom = [event.clientX, event.clientY]
    canvas.setPointerCapture(event.pointerId)
    drawCutLine(cutFrom, cutFrom)
  })

  canvas.addEventListener('pointermove', (event) => {
    if (cutFrom) drawCutLine(cutFrom, [event.clientX, event.clientY])
  })

  canvas.addEventListener('pointerup', (event) => {
    if (!cutFrom) return
    const from = cutFrom
    cutFrom = null
    cutline.setAttribute('hidden', '')

    const plane = viewport.planeFromScreenLine(from, [event.clientX, event.clientY])
    store.set({ cutArmed: false })

    if (!plane) {
      store.set({
        editRefusal: 'That stroke was too short to aim a cut. Drag a line right across the part.',
      })
      return
    }
    sendEdit({ kind: 'cut', shell: editTarget(), plane, keep: store.get().cutKeep })
  })

  // A drag that leaves the window would otherwise leave the line hanging.
  canvas.addEventListener('pointercancel', () => {
    cutFrom = null
    cutline.setAttribute('hidden', '')
  })

  // ---- build plate menu -----------------------------------------------

  function openPlateMenu(): void {
    const chosen = store.get().settings.platePreset
    plateMenu.querySelectorAll<HTMLButtonElement>('[data-plate]').forEach((item) =>
      item.setAttribute('aria-checked', String(item.dataset.plate === chosen)),
    )
    plateMenu.hidden = false
    plateButton.setAttribute('aria-expanded', 'true')
  }

  function closePlateMenu(): void {
    plateMenu.hidden = true
    plateButton.setAttribute('aria-expanded', 'false')
  }

  plateButton.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    if (plateMenu.hidden) openPlateMenu()
    else closePlateMenu()
  })

  plateMenu.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-plate]')
    if (!item) return
    const choice = item.dataset.plate!
    closePlateMenu()

    // A preset carries its own volume; Custom keeps whatever is in Setup and
    // takes you there to edit it. Either way the plate comes on, because
    // picking a bed and seeing nothing happen is not an answer.
    const preset = findPlate(choice)
    const settings: Settings = {
      ...store.get().settings,
      platePreset: choice,
      buildVolume: preset ? [...preset.volume] : store.get().settings.buildVolume,
    }
    store.set({ settings, showPlate: choice !== 'none' })
    if (choice === 'custom') store.set({ mode: 'setup' })
    saveSettings(settings)
    viewport.setBuildVolume(settings.buildVolume, plateLabel(choice))
    viewport.setPlateVisible(choice !== 'none')
    viewport.fitCamera()
    // The volume feeds the fits-on-plate component, so the score has to catch up.
    if (preset && store.get().model) send({ type: 'rescore', settings })
  })

  // Dismiss on anything that is not the menu or the button that opened it.
  document.addEventListener('click', (event) => {
    const target = event.target as Node
    if (!plateMenu.hidden && !plateMenu.contains(target) && !plateButton.contains(target)) {
      closePlateMenu()
    }
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !plateMenu.hidden) closePlateMenu()
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
      store.set({ selectedShell: issue?.kind === 'shells' ? index : null })
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
    store.set({ selectedShell: null })
    // Clicking an issue takes the camera there (spec §5.3).
    if (issue?.focus) viewport.focusOn(issue.focus)
  })

  // ---- edit tools -------------------------------------------------------

  /** Read a number out of the panel, falling back when it has been cleared or
   *  typed into nonsense. */
  function numberField(selector: string, fallback: number): number {
    const input = panelBody.querySelector<HTMLInputElement>(selector)
    const value = Number(input?.value)
    return Number.isFinite(value) && value !== 0 ? value : fallback
  }

  panelBody.addEventListener('click', (event) => {
    const target = event.target as HTMLElement

    const keep = target.closest<HTMLButtonElement>('[data-keep]')
    if (keep) {
      store.set({ cutKeep: keep.dataset.keep as CutKeep })
      return
    }

    const tool = target.closest<HTMLButtonElement>('[data-edit]')
    if (!tool || tool.disabled) return

    switch (tool.dataset.edit) {
      case 'deselect':
        store.set({ selectedShell: null })
        return

      case 'scale': {
        const percent = tool.dataset.percent
          ? Number(tool.dataset.percent)
          : numberField('#scale-percent', 100)
        if (percent === 100) {
          store.set({ editRefusal: 'That is the size it already is.', editOutcome: null })
          return
        }
        const ratio = percent / 100
        sendEdit({ kind: 'scale', shell: editTarget(), factor: [ratio, ratio, ratio] })
        return
      }

      case 'rotate':
        sendEdit({
          kind: 'rotate',
          shell: editTarget(),
          axis: Number(tool.dataset.axis) as Axis,
          degrees: Number(tool.dataset.degrees),
        })
        return

      case 'rotate-free': {
        const axis = Number(tool.dataset.axis) as Axis
        sendEdit({
          kind: 'rotate',
          shell: editTarget(),
          axis,
          degrees: numberField(`[data-angle="${axis}"]`, 45),
        })
        return
      }

      case 'cut':
        // Arming is a toggle: the same button cancels, and so does Escape.
        store.set({ cutArmed: !store.get().cutArmed, editOutcome: null, editRefusal: null })
        return

      case 'delete': {
        const shell = editTarget()
        if (shell !== null) sendEdit({ kind: 'delete', shell })
        return
      }

      case 'export-part':
        send({ type: 'exportMesh', shell: editTarget() })
        return

      case 'export-model':
        send({ type: 'exportMesh', shell: null })
        return

      case 'apply':
        selectionSurvivesEdit = false
        store.set({ editBusy: true, editOutcome: null, editRefusal: null })
        send({ type: 'apply' })
        return

      case 'reset':
        selectionSurvivesEdit = false
        store.set({ editBusy: true, editOutcome: null, editRefusal: null })
        send({ type: 'reset' })
        return

      case 'undo':
      case 'redo':
        selectionSurvivesEdit = false
        store.set({ editBusy: true })
        send({ type: 'history', direction: tool.dataset.edit === 'undo' ? 'undo' : 'redo' })
        return
    }
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
    let settings = readSettings(panelBody, store.get().settings)
    // Typing your own numbers over a preset means it is no longer that
    // printer, and the plate should stop claiming to be one.
    const preset = findPlate(settings.platePreset)
    if (preset && preset.volume.some((v, i) => v !== settings.buildVolume[i])) {
      settings = { ...settings, platePreset: 'custom' }
    }
    store.set({ settings })
    saveSettings(settings)
    viewport.setBuildVolume(settings.buildVolume, plateLabel(settings.platePreset))
    if (store.get().model) send({ type: 'rescore', settings })
  })

  rerun.addEventListener('click', () => {
    if (!lastBuffer) return
    const buffer = lastBuffer.slice(0)
    store.set({ busy: true, error: null })
    send(
      { type: 'load', buffer, settings: store.get().settings, fileName: store.get().fileName ?? '' },
      [buffer],
    )
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
      // Cutaway and Edit are meaningless without a mesh. Report shows the
      // drop prompt and Setup is worth configuring before loading anything.
      button.disabled =
        !hasModel && (button.dataset.mode === 'cutaway' || button.dataset.mode === 'edit')
    })

    const errorCount = state.model?.issues.filter((i) => i.severity === 'error').length ?? 0
    const badge = root.querySelector<HTMLElement>('.rail__badge--report')!
    badge.hidden = errorCount === 0
    badge.textContent = String(errorCount)

    // The Fix badge counts repairs on offer, not problems found.
    const repairable = state.model
      ? repairChoices(state.model.issues).filter((c) => c.count > 0).length
      : 0
    const fixBadge = root.querySelector<HTMLElement>('.rail__badge--fix')!
    fixBadge.hidden = repairable === 0
    fixBadge.textContent = String(repairable)

    // Edits live in the Edit tab and nowhere else. The one thing the rest of
    // the app needs to know is that they exist, and a count on the tab says
    // that without putting edit state into chrome every mode shares.
    const editBadge = root.querySelector<HTMLElement>('.rail__badge--edit')!
    editBadge.hidden = !state.history.unapplied
    // Undoing back past an apply leaves a mesh that differs from the applied
    // one with nothing sensible to count, so it gets a mark rather than a
    // number. Applying always clears the badge either way.
    editBadge.textContent = state.history.pending > 0 ? String(state.history.pending) : '•'

    viewport.setShaded(state.shaded)
    viewport.setGridVisible(state.showGrid)
    segmented.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) =>
      button.setAttribute('aria-pressed', String((button.dataset.view === 'shaded') === state.shaded)),
    )
    gridButton.setAttribute('aria-pressed', String(state.showGrid))
    viewport.setBoxVisible(state.showBox)
    boxButton.setAttribute('aria-pressed', String(state.showBox))
    viewport.setPlateVisible(state.showPlate)
    plateButton.setAttribute('aria-pressed', String(state.showPlate))
    showGeometry(state)
    viewport.highlightShell(state.selectedShell)
    partsButton.setAttribute('aria-pressed', String(state.pickParts))
    shell.classList.toggle('is-picking', state.pickParts && hasModel && !state.cutArmed)

    // While a cut is armed the drag belongs to the tool, not to the orbit.
    viewport.setInteractive(!state.cutArmed)
    shell.classList.toggle('is-cutting', state.cutArmed)
    if (!state.cutArmed) cutline.setAttribute('hidden', '')

    // Chrome that only means something once a mesh is on screen.
    chip.hidden = !hasModel
    viewbar.hidden = !hasModel
    legend.hidden = !hasModel || state.mode === 'cutaway' || state.mode === 'edit'
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
      // In Edit the chip follows the working mesh, because that is what is on
      // screen — and it shows the applied count beside it so the difference
      // an unapplied edit has made is readable without leaving the tab.
      const draft = state.mode === 'edit' ? state.draft : null
      chip.querySelector('.chip__meta')!.textContent = previewMesh
        ? `${m.triangleCount.toLocaleString()} → ${previewMesh.triangleCount.toLocaleString()} tri`
        : draft
          ? // Scaling and turning leave the triangle count alone, and
            // "163 → 163" is noise. Show the arrow only where it says something.
            `${
              draft.triangleCount === m.triangleCount
                ? draft.triangleCount.toLocaleString()
                : `${m.triangleCount.toLocaleString()} → ${draft.triangleCount.toLocaleString()}`
            } tri · ${draft.bounds.size.map((n) => n.toFixed(1)).join(' × ')} mm · not applied`
          :
        `${m.format} · ${m.triangleCount.toLocaleString()} tri · ${m.bounds.size.map((n) => n.toFixed(1)).join(' × ')} mm${grid}`
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
    // always on screen exactly once. Edit never shows it — the score grades a
    // mesh for printing, which is not the question you are asking while you
    // are still changing its shape, and over an unapplied draft it would be
    // grading geometry that is not even on screen.
    scorecard.hidden =
      !hasModel || state.mode === 'edit' || (isReport && state.score !== null)

    if (isReport && hasModel && state.score) {
      panelFixed.innerHTML = renderScoreHeader(state.score) + renderBreakdown(state.score)
    }

    if (!hasModel) {
      panelBody.innerHTML =
        state.mode === 'setup'
          ? renderSettings(state.settings)
          : '<p class="empty">Drop a mesh to get started. Nothing is uploaded — the file is read right here in this tab.</p>'
    } else if (isReport) {
      panelBody.innerHTML =
        renderIssues(
          filterIssues(state.model!.issues, state.filter),
          state.selectedIssue,
          state.expandedIssue,
          state.selectedInstance,
        ) + (state.readiness ? renderReadiness(state.readiness) : '')
    } else if (state.mode === 'fix') {
      panelBody.innerHTML = renderFix(
        repairChoices(state.model!.issues),
        state.repairOptions,
        state.repairPreview,
      )
    } else if (state.mode === 'edit') {
      // Typed values are transient — they live in the inputs and nowhere else —
      // so a re-render prompted by something unrelated must not wipe the
      // number half-entered in the scale box.
      const typed = new Map<string, string>()
      panelBody.querySelectorAll<HTMLInputElement>('input[id], input[data-angle]').forEach((input) =>
        typed.set(input.id || `angle-${input.dataset.angle}`, input.value),
      )

      panelBody.innerHTML = renderEdit({
        model: state.model!,
        draft: state.draft,
        selectedShell: state.selectedShell,
        cutArmed: state.cutArmed,
        cutKeep: state.cutKeep,
        history: state.history,
        outcome: state.editOutcome,
        refusal: state.editRefusal,
        busy: state.editBusy,
      })

      panelBody.querySelectorAll<HTMLInputElement>('input[id], input[data-angle]').forEach((input) => {
        const previous = typed.get(input.id || `angle-${input.dataset.angle}`)
        if (previous !== undefined) input.value = previous
      })
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
    // The footer belongs to every mode, so it does not change shape when the
    // mesh has been edited — the badge on the Edit tab carries that. It does
    // owe anyone hovering the truth about what it will do to their edits.
    rerun.title =
      state.history.depth > 0
        ? 'Read the file again from scratch — this discards every edit'
        : 'Analyse the same file again'

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
          ${mode.id === 'report' ? '<span class="rail__badge rail__badge--report" hidden>0</span>' : ''}
          ${mode.id === 'fix' ? '<span class="rail__badge rail__badge--fix" hidden>0</span>' : ''}
          ${mode.id === 'edit' ? '<span class="rail__badge rail__badge--edit" hidden>0</span>' : ''}
        </button>`,
      ).join('')}
      <span class="rail__spacer"></span>
      <button class="rail__item" data-action="help" aria-haspopup="dialog" aria-expanded="false">
        ${railIcons.help}
        <span class="rail__label">HELP</span>
      </button>
      <button class="rail__item" data-mode="setup" aria-current="false">
        ${railIcons.setup}
        <span class="rail__label">SETUP</span>
      </button>
      <a class="rail__item rail__item--out" href="${REPO_URL}" target="_blank"
         rel="noreferrer noopener" aria-label="Source on GitHub">
        ${githubIcon}
        <span class="rail__label">GITHUB</span>
      </a>
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
        <div class="segmented">
          <button data-view="shaded" aria-pressed="true">Shaded</button>
          <button data-view="wire" aria-pressed="false">Wire</button>
        </div>
        <button class="iconbtn" data-action="box" aria-pressed="true"
                aria-label="Bounding box" data-tip="Bounding box — measured extents">${toolIcons.box}</button>
        <button class="iconbtn" data-action="grid" aria-pressed="true"
                aria-label="Grid" data-tip="Grid — a ruler on the build plane">${toolIcons.grid}</button>
        <div class="tool">
          <button class="iconbtn" data-action="plate" aria-pressed="false" aria-haspopup="menu"
                  aria-label="Build plate" data-tip="Build plate — right-click to pick a printer">${toolIcons.plate}</button>
          <div class="menu" data-menu="plate" role="menu" aria-label="Build plate" hidden>
            <button class="menu__item" role="menuitemradio" data-plate="none">None</button>
            <span class="menu__sep"></span>
            ${PLATE_PRESETS.map(
              (preset) => `
              <button class="menu__item" role="menuitemradio" data-plate="${preset.id}">
                <span>${preset.name}</span>
                <span class="menu__dim mono">${preset.volume[0]} × ${preset.volume[1]} × ${preset.volume[2]}</span>
              </button>`,
            ).join('')}
            <span class="menu__sep"></span>
            <button class="menu__item" role="menuitemradio" data-plate="custom">
              <span>Custom…</span>
              <span class="menu__dim mono">set in Setup</span>
            </button>
          </div>
        </div>
        <button class="iconbtn" data-action="parts" aria-pressed="false"
                aria-label="Select parts" data-tip="Select parts — click a body to isolate it">${toolIcons.parts}</button>
      </div>

      <!-- Viewport controls live together on the left, under the cube that
           says which way you are looking. The right-hand side is the defect
           legend and stays that way. -->
      <div class="viewbar" hidden>
        <canvas class="viewbar__cube" width="208" height="208"
                aria-label="View cube — click a face to look from it"></canvas>
        <div class="viewbar__tools">
          <button class="iconbtn" data-action="reset"
                  aria-label="Reset view" data-tip="Reset the view">${toolIcons.reset}</button>
          <button class="iconbtn" data-action="fit"
                  aria-label="Fit view" data-tip="Fit the model in view">${toolIcons.fit}</button>
        </div>
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

      <!-- The cut line is drawn over the canvas rather than in it: it is a
           stroke on the screen, not a thing in the scene, and it disappears
           the moment the plane it describes has been worked out. -->
      <svg class="cutline" hidden aria-hidden="true">
        <line class="cutline__stroke" x1="0" y1="0" x2="0" y2="0"/>
      </svg>

      <div class="drop">
        ${markSvg(56, 5)}
        <h1 class="drop__title">Drop a mesh</h1>
        <p class="drop__lede">
          Meshlight checks it for holes, flipped faces and loose shells, scores how well
          it will print, and lets you cut through it to see inside.
        </p>
        <span class="drop__formats mono">${SUPPORTED_EXTENSIONS.map((e) => e.slice(1).toUpperCase()).join(' · ')}</span>
        <span class="drop__promise"><span class="dot"></span>nothing leaves your machine</span>
        <button class="btn btn--primary drop__cta" data-open-file>Choose a file</button>
        <button class="drop__help" data-action="help" aria-haspopup="dialog" aria-expanded="false">
          How it works
        </button>
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

  ${helpHtml()}

  <input type="file" id="file-input" accept="${FILE_INPUT_ACCEPT}" hidden>`
}
