import type { RepairOptions } from './core/repair'
import type { Readiness } from './core/readiness'
import type { Score, Settings } from './core/types'
import { DEFAULT_SETTINGS } from './core/types'
import type { LoadedPayload, RepairPreview } from './worker/protocol'

export type Mode = 'report' | 'fix' | 'cutaway' | 'setup'
export type IssueFilter = 'all' | 'errors' | 'notes'

export interface State {
  mode: Mode
  model: LoadedPayload | null
  score: Score | null
  readiness: Readiness | null
  settings: Settings
  fileName: string | null
  shaded: boolean
  /** Ground grid and build-plate outline under the model. */
  showGrid: boolean
  /** Bounding box on the model's extents, labelled with its dimensions. */
  showBox: boolean
  /** The build plate under the model. Off until a bed is picked. */
  showPlate: boolean
  filter: IssueFilter
  /** Index into the filtered issue list, or null when nothing is selected. */
  selectedIssue: number | null
  /** Which issue's occurrence list is open, if any. */
  expandedIssue: number | null
  /** Index into the expanded issue's instances. */
  selectedInstance: number | null
  /** Height of the cutaway plane, in mm. */
  cutZ: number | null
  busy: boolean
  error: string | null

  /** Which repairs are ticked in the Fix panel. */
  repairOptions: RepairOptions
  /** Result of applying them, or null before anything is previewed. */
  repairPreview: RepairPreview | null
  /** Whether the viewport is showing the repair or the loaded mesh. */
  showRepair: boolean
  repairBusy: boolean
}

/** Everything a mesh can actually have wrong with it that Meshlight can put
 *  right. Defaults are set from what the analysis found, not from this. */
export const NO_REPAIRS: RepairOptions = {
  fillHoles: false,
  fixWinding: false,
  dropDegenerate: false,
}

type Listener = (state: State) => void

/** Built by a function, not by a module-level const, and deliberately so.
 *  A const here would run before `SETTINGS_KEY` further down the file is
 *  initialised, and loadSettings' catch — which exists for browsers that
 *  refuse localStorage — would swallow the resulting ReferenceError and hand
 *  back defaults, silently discarding every saved setting. A function
 *  declaration is hoisted but not called until `new Store()` at the bottom,
 *  by which point the whole module is ready. */
function initialState(): State {
  const settings = loadSettings()
  return {
    mode: 'report',
    model: null,
    score: null,
    readiness: null,
    settings,
    fileName: null,
    shaded: true,
    showGrid: true,
    showBox: true,
    // Follow the bed picked last time rather than defaulting off every visit.
    showPlate: settings.platePreset !== 'none',
    filter: 'all',
    selectedIssue: null,
    expandedIssue: null,
    selectedInstance: null,
    cutZ: null,
    busy: false,
    error: null,
    repairOptions: { ...NO_REPAIRS },
    repairPreview: null,
    showRepair: true,
    repairBusy: false,
  }
}

/** The single app store (spec §7). Features read and write here rather
 *  than reaching into each other, so the rail, the panel and the viewport
 *  can never disagree about what is loaded. */
class Store {
  private state: State = initialState()

  private readonly listeners = new Set<Listener>()

  get(): Readonly<State> {
    return this.state
  }

  set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch }
    // Snapshot the set first: a listener is allowed to subscribe or
    // unsubscribe while being notified without corrupting this iteration.
    for (const listener of [...this.listeners]) listener(this.state)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }
}

const SETTINGS_KEY = 'meshlight.settings'

/** Settings persistence is a phase 2 item (§6.9), pulled forward because a
 *  tunable score is not much use if the printer has to be described again on
 *  every visit. Both halves ship; see saveSettings below. */
function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_SETTINGS
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Private-mode browsers reject writes; the app works fine without them.
  }
}

export const store = new Store()
