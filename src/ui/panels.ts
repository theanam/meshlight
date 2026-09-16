import type { RepairOptions } from '../core/repair'
import type { Issue, IssueKind, Score, Settings } from '../core/types'
import type { RepairPreview } from '../worker/protocol'
import type { IssueFilter } from '../store'

const SWATCH: Record<IssueKind, string> = {
  boundary: 'var(--defect-nonmanifold)',
  'non-manifold': 'var(--defect-nonmanifold)',
  flipped: 'var(--defect-flipped)',
  degenerate: 'var(--defect-degenerate)',
  shells: 'var(--shell-select)',
}

const COUNT_CLASS: Record<IssueKind, string> = {
  boundary: 'is-fail',
  'non-manifold': 'is-fail',
  flipped: 'is-warn',
  degenerate: '',
  shells: 'is-shell',
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}

export function filterIssues(issues: Issue[], filter: IssueFilter): Issue[] {
  if (filter === 'errors') return issues.filter((i) => i.severity === 'error')
  if (filter === 'notes') return issues.filter((i) => i.severity === 'note')
  return issues
}

/** Units for each defect class, so a count reads as "12 edges" rather than
 *  a bare number (artboard 1b). */
const COUNT_UNIT: Record<IssueKind, (n: number) => string> = {
  boundary: (n) => `${n} ${n === 1 ? 'edge' : 'edges'}`,
  'non-manifold': (n) => `${n} ${n === 1 ? 'edge' : 'edges'}`,
  flipped: (n) => `${n} ${n === 1 ? 'face' : 'faces'}`,
  degenerate: (n) => `${n}`,
  shells: () => 'worth a look',
}

export function renderIssues(
  issues: Issue[],
  selected: number | null,
  expanded: number | null,
  selectedInstance: number | null,
): string {
  const head = `
    <div class="report__issues-head">
      <span class="report__eyebrow mono">Issues</span>
      <span class="report__hint mono">click to fly the camera there</span>
    </div>`

  if (issues.length === 0) {
    return `${head}<p class="empty">No problems found. Watertight, consistently wound, one solid shell — this is ready to slice.</p>`
  }

  const cards = issues
    .map((issue, index) => {
      const isOpen = index === expanded
      const color = SWATCH[issue.kind]
      return `
        <div class="card-group">
          <button class="card" data-issue="${index}" aria-current="${index === selected}"
                  aria-expanded="${isOpen}" style="--edge:${color}">
            <span class="card__body">
              <span class="card__head">
                <span class="card__title">${escapeHtml(issue.title)}</span>
                <span class="card__count ${COUNT_CLASS[issue.kind]}">${COUNT_UNIT[issue.kind](issue.count)}</span>
              </span>
              <span class="card__detail">${escapeHtml(issue.detail)}</span>
            </span>
            <span class="card__arrow" aria-hidden="true">${isOpen ? chevron : '\u2192'}</span>
          </button>
          ${isOpen ? renderInstances(issue, index, selectedInstance, color) : ''}
        </div>`
    })
    .join('')

  return `${head}<div class="card-list">${cards}</div>`
}

const chevron =
  '<svg width="10" height="10" viewBox="0 0 12 12" fill="none">' +
  '<path d="M3 4.5L6 8l3-3.5" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** The expanded list under an issue: every occurrence, individually clickable
 *  so the camera can go to that one defect rather than to the group average. */
function renderInstances(
  issue: Issue,
  groupIndex: number,
  selectedInstance: number | null,
  color: string,
): string {
  if (issue.instances.length === 0) {
    return '<p class="instances__empty">No individual locations for this one.</p>'
  }
  const rows = issue.instances
    .map(
      (instance, i) => `
      <button class="instance" data-group="${groupIndex}" data-instance="${i}"
              aria-current="${i === selectedInstance}">
        <span class="instance__index" style="color:${color}">${String(i + 1).padStart(2, '0')}</span>
        <span class="instance__label">${escapeHtml(instance.label)}</span>
        <span class="instance__meta">${escapeHtml(instance.meta)}</span>
      </button>`,
    )
    .join('')

  const more =
    issue.hiddenInstances > 0
      ? `<p class="instances__more">+${issue.hiddenInstances.toLocaleString()} more not listed — fix these first and re-run.</p>`
      : ''

  return `<div class="instances">${rows}${more}</div>`
}

/** The score header from artboard 1b: a conic-gradient ring around the
 *  number, with the verdict and the one thing most worth fixing beside it. */
export function renderScoreHeader(score: Score): string {
  const turn = (score.total / 100).toFixed(4)
  const ring = ringColor(score.total)
  const worst = [...score.components].sort((a, b) => a.ratio - b.ratio)[0]
  const advice =
    worst && worst.status !== 'pass'
      ? escapeHtml(worst.help)
      : 'Nothing is holding this back. Send it to your slicer.'

  return `
    <div class="report__score">
      <div class="dial" style="background:conic-gradient(${ring} 0 ${turn}turn, var(--line) ${turn}turn 1turn)">
        <div class="dial__well">
          <span class="dial__value mono">${score.total}</span>
          <span class="dial__outof mono">/ 100</span>
        </div>
      </div>
      <div class="report__verdict">
        <span class="report__verdict-title">${escapeHtml(score.verdict)}</span>
        <span class="report__verdict-note">${advice}</span>
      </div>
    </div>`
}

function ringColor(total: number): string {
  if (total >= 80) return 'var(--accent)'
  if (total >= 50) return 'var(--defect-flipped)'
  return 'var(--defect-nonmanifold)'
}

/** Plain words rather than a points deduction. A part that needs work is not
 *  losing a game; the useful thing to say is what state it is in. */
const STATUS_WORD: Record<'pass' | 'warn' | 'fail', string> = {
  pass: 'good',
  warn: 'worth a look',
  fail: 'needs fixing',
}

/** The breakdown rows from 1b: label, a short meter, and where it stands. */
export function renderBreakdown(score: Score): string {
  const rows = score.components
    .map(
      (component) => `
        <div class="bd" title="${escapeHtml(component.note)}">
          <span class="bd__label">${escapeHtml(component.label)}</span>
          <span class="bd__meter"><span class="bd__fill is-${component.status}" style="width:${Math.round(
            component.ratio * 100,
          )}%"></span></span>
          <span class="bd__value is-${component.status}">${STATUS_WORD[component.status]}</span>
        </div>`,
    )
    .join('')

  return `
    <div class="report__breakdown">
      <span class="report__eyebrow mono">Score breakdown</span>
      <div class="bd-list">${rows}</div>
    </div>`
}

export function renderSettings(settings: Settings): string {
  const [bx, by, bz] = settings.buildVolume
  return `
    <div class="field">
      <label class="field__label" for="set-nozzle">Nozzle diameter (mm)</label>
      <input type="number" id="set-nozzle" data-setting="nozzleDiameter"
             value="${settings.nozzleDiameter}" min="0.1" max="2" step="0.05">
      <p class="field__hint">Walls thinner than two nozzle widths are flagged.</p>
    </div>
    <div class="field">
      <label class="field__label" for="set-overhang">Overhang threshold (°)</label>
      <input type="number" id="set-overhang" data-setting="overhangThreshold"
             value="${settings.overhangThreshold}" min="0" max="89" step="1">
      <p class="field__hint">Measured from the build plate. Faces past this need support.</p>
    </div>
    <div class="field">
      <span class="field__label">Build volume (mm)</span>
      <div class="field__row">
        <input type="number" data-setting="buildVolumeX" value="${bx}" min="1" step="1" aria-label="Build volume X">
        <input type="number" data-setting="buildVolumeY" value="${by}" min="1" step="1" aria-label="Build volume Y">
        <input type="number" data-setting="buildVolumeZ" value="${bz}" min="1" step="1" aria-label="Build volume Z">
      </div>
      <p class="field__hint">Meshlight tries the part both ways round before calling it too big.</p>
    </div>
    <div class="field">
      <span class="field__label">Privacy</span>
      <p class="field__hint">
        Meshlight has no server to talk to. Your STL is read in this tab and never leaves it —
        that is a property of how the app is built, not a policy you have to trust.
      </p>
    </div>`
}

// ---------------------------------------------------------------------------
// Fix (artboard 2b)
// ---------------------------------------------------------------------------

export interface RepairChoice {
  key: keyof RepairOptions
  title: string
  /** What the mesh gains. Deliberately an outcome, not a points delta. */
  outcome: string
  detail: string
  /** How many of the thing it fixes were found. Zero means nothing to do. */
  count: number
}

/** Work out which repairs are worth offering for this mesh. A repair with
 *  nothing to act on is listed but disabled, so the panel always reads as the
 *  same checklist rather than rearranging itself per file. */
export function repairChoices(issues: Issue[]): RepairChoice[] {
  const countOf = (kind: IssueKind): number =>
    issues.find((i) => i.kind === kind)?.count ?? 0

  const openEdges = countOf('boundary')
  const flipped = countOf('flipped')
  const degenerate = countOf('degenerate')

  return [
    {
      key: 'dropDegenerate',
      title: degenerate > 0 ? `Drop ${degenerate} degenerate ${degenerate === 1 ? 'face' : 'faces'}` : 'Drop degenerate faces',
      outcome: 'no visible change',
      detail:
        'Removes zero-area triangles and collapsed corners. They carry no surface, but they do invent edges that make a clean mesh look broken.',
      count: degenerate,
    },
    {
      key: 'fixWinding',
      title: flipped > 0 ? `Re-wind ${flipped} flipped ${flipped === 1 ? 'face' : 'faces'}` : 'Re-wind flipped faces',
      outcome: 'normals point outward',
      detail:
        'Turns faces to agree with their neighbours, and turns an inside-out shell the right way round. Geometry is untouched — only the winding changes.',
      count: flipped,
    },
    {
      key: 'fillHoles',
      title: openEdges > 0 ? `Fill ${openEdges} open ${openEdges === 1 ? 'edge' : 'edges'}` : 'Fill open edges',
      outcome: 'makes it watertight',
      detail:
        'Triangulates each boundary loop in its own plane, keeping every existing vertex so the patch meets the surface exactly.',
      count: openEdges,
    },
  ]
}

export function renderFix(
  choices: RepairChoice[],
  options: RepairOptions,
  preview: RepairPreview | null,
): string {
  const rows = choices
    .map((choice) => {
      const available = choice.count > 0
      const on = available && options[choice.key]
      return `
        <button class="repair" data-repair="${choice.key}" aria-pressed="${on}"
                ${available ? '' : 'disabled'}>
          <span class="repair__box" aria-hidden="true">${on ? tick : ''}</span>
          <span class="repair__body">
            <span class="repair__head">
              <span class="repair__title">${escapeHtml(choice.title)}</span>
              <span class="repair__outcome">${available ? escapeHtml(choice.outcome) : 'nothing to do'}</span>
            </span>
            <span class="repair__detail">${escapeHtml(choice.detail)}</span>
          </span>
        </button>`
    })
    .join('')

  const selected = choices.filter((c) => c.count > 0 && options[c.key]).length
  const available = choices.filter((c) => c.count > 0).length
  const summary =
    preview === null
      ? `${selected} of ${available} selected`
      : `${selected} of ${available} selected · ${preview.triangleCount.toLocaleString()} tri`
  const outcome =
    preview === null
      ? ''
      : preview.remainingIssues === 0
        ? '<span class="repair__verdict is-pass">comes out clean</span>'
        : `<span class="repair__verdict">${preview.remainingIssues} ${
            preview.remainingIssues === 1 ? 'issue' : 'issues'
          } left after this</span>`

  return `
    <div class="fix">
      <div class="fix__rows">${rows}</div>
      <div class="fix__foot">
        <div class="fix__summary mono">
          <span>${summary}</span>
          ${outcome}
        </div>
        <div class="fix__actions">
          <button class="btn btn--primary" id="repair-download" ${selected === 0 ? 'disabled' : ''}>
            Repair &amp; download STL
          </button>
          <button class="btn" id="repair-reset" ${selected === 0 ? 'disabled' : ''}>Reset</button>
        </div>
        <p class="fix__note">
          Everything here runs on a copy. Your original file is never written to, and the
          repaired STL saves straight to your downloads — still no upload, still no server.
        </p>
      </div>
    </div>`
}

const tick =
  '<svg width="11" height="11" viewBox="0 0 12 12" fill="none">' +
  '<path d="M2 6.5l2.5 2.5L10 3" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>'
