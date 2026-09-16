/** The Edit panel: what you can do to the mesh, and what just happened.
 *
 *  Every tool here reads the current selection. A part is selected by clicking
 *  it in the viewport, and with nothing selected the transforms apply to the
 *  whole model — so the panel never has to ask "which one?", it only has to
 *  say which it is about to act on. */

import type { CutKeep } from '../core/edit'
import type { Bounds } from '../core/types'
import type { DraftPayload, EditOutcome, HistoryState, LoadedPayload } from '../worker/protocol'

export interface EditContext {
  /** The applied model — what every other tab is describing. */
  model: LoadedPayload
  /** The working mesh, when edits have not been applied yet. */
  draft: DraftPayload | null
  selectedShell: number | null
  cutArmed: boolean
  cutKeep: CutKeep
  history: HistoryState
  outcome: EditOutcome | null
  refusal: string | null
  busy: boolean
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}

const mm = (size: Bounds['size']): string => size.map((n) => n.toFixed(1)).join(' × ')

/** Extents and triangle count of one part, walked from the shell ids.
 *
 *  The same walk the viewport does to draw the selection box. It is cheap
 *  enough to repeat — one pass over the triangle list — and cheaper than
 *  keeping a table of every shell's bounds in sync through every edit. */
function shellSummary(
  model: LoadedPayload | DraftPayload,
  shell: number,
): { triangles: number; size: Bounds['size'] } {
  const { positions, indices, shellIds } = model
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  let triangles = 0

  for (let t = 0; t < shellIds.length; t++) {
    if (shellIds[t] !== shell) continue
    triangles++
    for (let corner = 0; corner < 3; corner++) {
      const v = indices[t * 3 + corner]!
      for (let axis = 0; axis < 3; axis++) {
        const value = positions[v * 3 + axis]!
        if (value < min[axis]!) min[axis] = value
        if (value > max[axis]!) max[axis] = value
      }
    }
  }

  if (triangles === 0) return { triangles: 0, size: [0, 0, 0] }
  return {
    triangles,
    size: [max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!],
  }
}

function renderTarget(context: EditContext): string {
  const { selectedShell } = context
  // Everything in this panel is about the mesh on screen, which in this tab is
  // the working one whenever there is a working one.
  const model = context.draft ?? context.model

  if (selectedShell === null) {
    const hint =
      model.shellCount > 1
        ? `${model.shellCount} parts — click one in the viewport to work on it alone`
        : 'one part — everything below applies to all of it'
    return `
      <div class="target">
        <span class="target__label mono">EDITING</span>
        <span class="target__name">Whole model</span>
        <span class="target__meta mono">${model.triangleCount.toLocaleString()} tri · ${mm(model.bounds.size)} mm</span>
        <span class="target__hint">${hint}</span>
      </div>`
  }

  const summary = shellSummary(model, selectedShell)
  return `
    <div class="target is-part">
      <span class="target__label mono">EDITING</span>
      <span class="target__name">Part ${selectedShell + 1}<span class="target__of"> of ${model.shellCount}</span></span>
      <span class="target__meta mono">${summary.triangles.toLocaleString()} tri · ${mm(summary.size)} mm</span>
      <button class="target__clear" data-edit="deselect">Work on the whole model instead</button>
    </div>`
}

function renderOutcome(context: EditContext): string {
  if (context.refusal) {
    return `<p class="outcome is-refused" role="status">${escapeHtml(context.refusal)}</p>`
  }
  if (!context.outcome) return ''
  return `
    <p class="outcome" role="status">
      <span class="outcome__label">${escapeHtml(context.outcome.label)}</span>
      ${context.outcome.detail ? `<span class="outcome__detail mono">${escapeHtml(context.outcome.detail)}</span>` : ''}
    </p>`
}

const CUT_KEEP: { id: CutKeep; label: string; tip: string }[] = [
  { id: 'both', label: 'Both', tip: 'Keep both halves as separate parts' },
  { id: 'front', label: 'Near', tip: 'Keep only the half nearer the camera' },
  { id: 'back', label: 'Far', tip: 'Keep only the half further from the camera' },
]

/** "3 changes", or just "changes" when undoing back past an apply has left
 *  nothing meaningful to count. */
function pendingLabel(history: HistoryState): string {
  if (history.pending <= 0) return 'changes'
  return `${history.pending} change${history.pending === 1 ? '' : 's'}`
}

export function renderEdit(context: EditContext): string {
  const { history, cutArmed, cutKeep, selectedShell, busy } = context
  const noPart = selectedShell === null
  const disabled = busy ? 'disabled' : ''

  return `
  <div class="edit">
    ${renderTarget(context)}
    ${renderOutcome(context)}

    <section class="tool-group">
      <h3 class="tool-group__title mono">SCALE</h3>
      <div class="numfield">
        <input type="number" id="scale-percent" class="numfield__input mono" value="100"
               min="1" max="1000" step="1" aria-label="Scale percentage" ${disabled}>
        <span class="numfield__unit mono">%</span>
        <button class="btn" data-edit="scale" ${disabled}>Apply</button>
      </div>
      <div class="chips">
        ${[50, 90, 110, 200]
          .map(
            (percent) =>
              `<button class="chipbtn mono" data-edit="scale" data-percent="${percent}" ${disabled}>${percent}%</button>`,
          )
          .join('')}
      </div>
      <p class="tool-group__note">Resizes about the centre, so it grows in place.</p>
    </section>

    <section class="tool-group">
      <h3 class="tool-group__title mono">ROTATE</h3>
      <div class="axis-rows">
        ${(['X', 'Y', 'Z'] as const)
          .map(
            (axis, index) => `
          <div class="axis-row">
            <span class="axis-row__name mono">${axis}</span>
            <button class="btn btn--slim" data-edit="rotate" data-axis="${index}" data-degrees="-90"
                    aria-label="Turn ${axis} minus 90 degrees" ${disabled}>−90°</button>
            <button class="btn btn--slim" data-edit="rotate" data-axis="${index}" data-degrees="90"
                    aria-label="Turn ${axis} plus 90 degrees" ${disabled}>+90°</button>
            <input type="number" class="numfield__input numfield__input--slim mono" data-angle="${index}"
                   value="45" step="5" aria-label="Free angle about ${axis}" ${disabled}>
            <button class="btn btn--slim" data-edit="rotate-free" data-axis="${index}"
                    aria-label="Turn ${axis} by the angle entered" ${disabled}>Turn</button>
          </div>`,
          )
          .join('')}
      </div>
    </section>

    <section class="tool-group">
      <h3 class="tool-group__title mono">CUT</h3>
      <button class="btn ${cutArmed ? 'btn--armed' : 'btn--primary'}" data-edit="cut" ${disabled}>
        ${cutArmed ? 'Cancel — press Escape' : 'Draw a cut line'}
      </button>
      <p class="tool-group__note">
        ${
          cutArmed
            ? 'Drag across the model. The cut follows the line straight back into the screen, so turn the view first to aim it.'
            : 'Drag a line across the viewport and the model is cut along it. Turn the view first to choose the angle.'
        }
      </p>
      <div class="keep">
        <span class="keep__label mono">KEEP</span>
        <div class="segmented segmented--keep">
          ${CUT_KEEP.map(
            (option) => `
            <button data-keep="${option.id}" title="${option.tip}"
                    aria-pressed="${option.id === cutKeep}">${option.label}</button>`,
          ).join('')}
        </div>
      </div>
    </section>

    <section class="tool-group">
      <h3 class="tool-group__title mono">PART</h3>
      <div class="tool-group__row">
        <button class="btn btn--danger" data-edit="delete" ${noPart || busy ? 'disabled' : ''}>
          Delete part<kbd class="kbd">⌫</kbd>
        </button>
        <button class="btn" data-edit="export-part" ${noPart || busy ? 'disabled' : ''}>
          Export part
        </button>
      </div>
      <p class="tool-group__note">
        ${noPart ? 'Select a part in the viewport first.' : 'Writes the selected part alone, in the model’s own coordinates.'}
      </p>
    </section>

    <section class="tool-group tool-group--last">
      <div class="tool-group__row">
        <button class="btn" data-edit="undo" ${history.canUndo && !busy ? '' : 'disabled'}>Undo</button>
        <button class="btn" data-edit="redo" ${history.canRedo && !busy ? '' : 'disabled'}>Redo</button>
      </div>
      <button class="btn btn--wide" data-edit="export-model" ${disabled}>
        Export what is on screen as STL
      </button>
      <p class="tool-group__note">
        ${
          history.depth === 0
            ? 'Unedited — this is the file as you opened it.'
            : `${history.depth} edit${history.depth === 1 ? '' : 's'} since opening. Exporting writes a new file; the one you opened is never overwritten.`
        }
      </p>
      ${
        history.depth === 0
          ? ''
          : `<button class="discard" data-edit="reset" ${disabled}>
               Discard all ${history.depth} edit${history.depth === 1 ? '' : 's'} and put every tab back
             </button>`
      }
    </section>

    ${
      // Applying is the point of the tab, so it does not get to sit below
      // whatever the tool groups happen to add up to — it sticks to the
      // bottom of the panel for as long as there is anything to apply.
      history.unapplied
        ? `<div class="commit">
             <button class="btn btn--primary btn--commit" data-edit="apply" ${disabled}>
               <span class="btn__label">Apply ${pendingLabel(history)} to the loaded model</span>
               <span class="btn__sub">changes this session only — your file on disk is not touched</span>
             </button>
             <p class="commit__note">
               Report, Fix and Cutaway still describe the mesh as it was before this.
             </p>
           </div>`
        : ''
    }
  </div>`
}
