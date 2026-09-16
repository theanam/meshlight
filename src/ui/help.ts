/** Where to send people who want the source, a bug filed, or a word with the
 *  author. Kept in one place so the rail, the help dialog and anything added
 *  later cannot drift apart. */
export const REPO_URL = 'https://github.com/theanam/meshlight'
export const REPO_SLUG = 'theanam/meshlight'
export const NEW_ISSUE_URL = `${REPO_URL}/issues/new`
export const FEEDBACK_EMAIL = 'anam.ahmed.a@gmail.com'
const MAILTO = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent('Meshlight feedback')}`

/** The GitHub mark, drawn in currentColor so it takes the rail's states. */
export const githubIcon = `
<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.04-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.94 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.8 5.63-5.48 5.93.43.37.81 1.1.81 2.22 0 1.61-.01 2.9-.01 3.29 0 .32.22.7.83.58A12.01 12.01 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z"/>
</svg>`

/** One glyph per step. They are the whole explanation — the words under them
 *  are a label for the picture, not a paragraph. Drawn on the same 44px box
 *  so the row reads as one sequence. */
const stepArt = {
  drop: `
<svg width="44" height="44" viewBox="0 0 44 44" fill="none" aria-hidden="true">
  <path d="M22 5v19M14.5 17.5 22 25l7.5-7.5" stroke="currentColor" stroke-width="2.4"
        stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M7 28v6a4 4 0 0 0 4 4h22a4 4 0 0 0 4-4v-6" stroke="currentColor" stroke-width="2.4"
        stroke-linecap="round"/>
</svg>`,
  local: `
<svg width="44" height="44" viewBox="0 0 44 44" fill="none" aria-hidden="true">
  <rect x="4.5" y="7.5" width="35" height="29" rx="3.5" stroke="currentColor" stroke-width="2.2"/>
  <path d="M4.5 15.5h35" stroke="currentColor" stroke-width="2.2"/>
  <circle cx="9.5" cy="11.5" r="1.2" fill="currentColor"/>
  <circle cx="13.8" cy="11.5" r="1.2" fill="currentColor"/>
  <rect x="16.5" y="24" width="11" height="8" rx="1.8" stroke="currentColor" stroke-width="2.1"/>
  <path d="M19.2 24v-2.6a2.8 2.8 0 0 1 5.6 0V24" stroke="currentColor" stroke-width="2.1"
        stroke-linecap="round"/>
</svg>`,
  score: `
<svg width="44" height="44" viewBox="0 0 44 44" fill="none" aria-hidden="true">
  <path d="M7 31a15 15 0 1 1 30 0" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M22 31l9-9.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
  <circle cx="22" cy="31" r="2.6" fill="currentColor"/>
</svg>`,
  fix: `
<svg width="44" height="44" viewBox="0 0 44 44" fill="none" aria-hidden="true">
  <path d="M22 5.5 36 13.5v17L22 38.5 8 30.5v-17z" stroke="currentColor" stroke-width="2.2"
        stroke-linejoin="round"/>
  <path d="M4 22h36" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"
        stroke-dasharray="5 4"/>
</svg>`,
} as const

const STEPS: { art: string; caption: string; note: string }[] = [
  { art: stepArt.drop, caption: 'Drop a mesh', note: 'STL · OBJ · PLY · 3MF' },
  { art: stepArt.local, caption: 'Read in your browser', note: 'nothing is uploaded' },
  { art: stepArt.score, caption: 'Score and issues', note: 'every defect, located' },
  { art: stepArt.fix, caption: 'Fix, edit, export', note: 'repair · cut · resize' },
]

/** The same three colours the viewport paints defects in. Repeating them here
 *  is the point: the dialog is where you learn to read the model. */
const KEYS: { swatch: 'line' | 'dot'; color: string; label: string }[] = [
  { swatch: 'line', color: 'var(--defect-nonmanifold)', label: 'non-manifold' },
  { swatch: 'line', color: 'var(--defect-flipped)', label: 'flipped' },
  { swatch: 'dot', color: 'var(--defect-degenerate)', label: 'degenerate' },
  { swatch: 'line', color: 'var(--shell-select)', label: 'selected shell' },
]

export function helpHtml(): string {
  return `
  <div class="overlay" data-overlay="help" hidden>
    <div class="help" role="dialog" aria-modal="true" aria-labelledby="help-title">
      <header class="help__head">
        <h2 class="help__title" id="help-title">How it works</h2>
        <button class="help__close" data-help-close aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.8"
                  stroke-linecap="round"/>
          </svg>
        </button>
      </header>

      <ol class="help__steps">
        ${STEPS.map(
          (step) => `
          <li class="step">
            <span class="step__art">${step.art}</span>
            <span class="step__caption">${step.caption}</span>
            <span class="step__note mono">${step.note}</span>
          </li>`,
        ).join('')}
      </ol>

      <section class="help__keys">
        <h3 class="help__keys-title mono">ON THE MODEL</h3>
        <div class="help__keys-row">
          ${KEYS.map(
            (key) => `
            <span class="hkey">
              <span class="hkey__${key.swatch}" style="background:${key.color}"></span>${key.label}
            </span>`,
          ).join('')}
        </div>
      </section>

      <footer class="help__foot">
        <a class="help__repo" href="${REPO_URL}" target="_blank" rel="noreferrer noopener">
          ${githubIcon}<span class="mono">${REPO_SLUG}</span>
        </a>
        <div class="help__actions">
          <a class="btn" href="${NEW_ISSUE_URL}" target="_blank" rel="noreferrer noopener">Report an issue</a>
          <a class="btn btn--primary" href="${MAILTO}">Send feedback</a>
        </div>
        <p class="help__mail">
          or email <a class="mono" href="${MAILTO}">${FEEDBACK_EMAIL}</a>
        </p>
      </footer>
    </div>
  </div>`
}

export interface HelpDialog {
  open(): void
  close(): void
  toggle(): void
  readonly isOpen: boolean
}

/** Wires the dialog up: opens, closes on the X, the backdrop and Escape, and
 *  keeps Tab inside it while it is up. Nothing here touches the store — which
 *  mesh is loaded and whether the help is showing have nothing to say to each
 *  other, and routing it through the store would only make reloads replay it. */
export function mountHelp(root: HTMLElement): HelpDialog {
  const overlay = root.querySelector<HTMLElement>('[data-overlay="help"]')!
  const dialog = overlay.querySelector<HTMLElement>('.help')!
  const closeButton = overlay.querySelector<HTMLButtonElement>('[data-help-close]')!
  const triggers = (): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>('[data-action="help"]'))

  /** Where focus was before we took it, so closing puts it back rather than
   *  dumping the caret at the top of the document. */
  let restoreTo: HTMLElement | null = null

  const focusable = (): HTMLElement[] =>
    Array.from(dialog.querySelectorAll<HTMLElement>('a[href], button')).filter(
      (element) => !element.hasAttribute('disabled'),
    )

  function open(): void {
    if (!overlay.hidden) return
    restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    overlay.hidden = false
    triggers().forEach((trigger) => trigger.setAttribute('aria-expanded', 'true'))
    closeButton.focus()
  }

  function close(): void {
    if (overlay.hidden) return
    overlay.hidden = true
    triggers().forEach((trigger) => trigger.setAttribute('aria-expanded', 'false'))
    restoreTo?.focus()
    restoreTo = null
  }

  closeButton.addEventListener('click', close)

  // The backdrop is the whole overlay, so only a press that lands outside the
  // card counts — a click that starts on text inside it must not dismiss.
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close()
  })

  // A link out of the dialog leaves the tab behind it; close so coming back
  // does not land on a panel the user already finished with.
  dialog.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('a[href]')) close()
  })

  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return
    const items = focusable()
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    const active = document.activeElement
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  })

  return {
    open,
    close,
    toggle: () => (overlay.hidden ? open() : close()),
    get isOpen() {
      return !overlay.hidden
    },
  }
}
