/** SVG lifted from the brand kit artboard (1a) and the mode rail (1c/2a).
 *  The monogram is a hexagonal mesh cell wrapping an "M" drawn as three
 *  strokes; keep the two paths' stroke weights in proportion when resizing. */

export const markSvg = (size: number, strokeWidth = 6): string => `
<svg width="${size}" height="${size}" viewBox="0 0 120 120" fill="none" aria-hidden="true">
  <path d="M60 8 106 34v52L60 112 14 86V34z" stroke="var(--accent)" stroke-width="${strokeWidth}"/>
  <path d="M32 74V46l28 30" stroke="var(--ink)" stroke-width="${strokeWidth + 2}" stroke-linejoin="round"/>
  <path d="M88 46v28" stroke="var(--ink)" stroke-width="${strokeWidth + 2}"/>
  <path d="M60 76l28-30" stroke="var(--ink)" stroke-width="${strokeWidth + 2}" stroke-linejoin="round"/>
</svg>`

/** Rail glyphs, drawn with currentColor so the active/inactive states in the
 *  artboards fall out of the parent's color alone. */
export const railIcons = {
  report: '<span style="width:20px;height:20px;border:2px solid currentColor;border-radius:4px"></span>',
  cutaway:
    '<span style="display:block;width:20px;height:20px;position:relative">' +
    '<span style="position:absolute;top:5px;left:0;width:20px;height:4px;background:currentColor"></span>' +
    '<span style="position:absolute;top:11px;left:0;width:20px;height:4px;background:currentColor;opacity:.5"></span>' +
    '</span>',
  fix: '<span style="width:20px;height:20px;border:2px solid currentColor;border-radius:4px;transform:rotate(45deg)"></span>',
  setup: '<span style="width:18px;height:18px;border:2px solid currentColor;border-radius:50%"></span>',
} as const

/** Viewport tools. These sit as round buttons over the 3D view, so they are
 *  glyph-only and drawn on the same 18px box as each other. */
export const toolIcons = {
  grid: `
<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
  <rect x="1.5" y="1.5" width="15" height="15" rx="2.5" stroke="currentColor" stroke-width="1.4"/>
  <path d="M6.5 1.5v15M11.5 1.5v15M1.5 6.5h15M1.5 11.5h15" stroke="currentColor" stroke-width="1.2"/>
</svg>`,
  box: `
<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
  <rect x="2.5" y="2.5" width="13" height="13" rx="1" stroke="currentColor" stroke-width="1.3"
        stroke-dasharray="3 2.2"/>
  <path d="M2.5 2.5h2M13.5 2.5h2M2.5 15.5h2M13.5 15.5h2M2.5 2.5v2M2.5 13.5v2M15.5 2.5v2M15.5 13.5v2"
        stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</svg>`,
  fit: `
<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
  <path d="M1.5 6V3a1.5 1.5 0 0 1 1.5-1.5h3M12 1.5h3A1.5 1.5 0 0 1 16.5 3v3M16.5 12v3a1.5 1.5 0 0 1-1.5 1.5h-3M6 16.5H3A1.5 1.5 0 0 1 1.5 15v-3"
        stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <rect x="6.25" y="6.25" width="5.5" height="5.5" rx="1.2" stroke="currentColor" stroke-width="1.3"/>
</svg>`,
} as const
