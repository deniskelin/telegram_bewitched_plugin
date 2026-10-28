/**
 * A single-series column chart as SVG, rendered to PNG locally with resvg:
 * spend per hour/day/week for the period reports. One hue (magnitude), thin
 * columns with a rounded data end, recessive grid, the peak labelled.
 */

import { escapeHtml } from '../format.ts'

// Reference palette (light): surface, inks, grid, baseline, the series blue.
const C = {
  surface: '#fcfcfb',
  primary: '#0b0b0b',
  secondary: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  baseline: '#c3c2b7',
  bar: '#2a78d6',
}
const FONT = 'DejaVu Sans, Arial, sans-serif'

export type Column = { label: string; value: number }

/** 0, 1, 2, 2.5, 5 × 10ⁿ: a round top for the y axis and its step. */
function niceScale(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 1, step: 0.25 }
  const raw = max / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= raw)!
  return { top: Math.ceil(max / step) * step, step }
}

function money(v: number): string {
  return v >= 100 ? `$${Math.round(v)}` : v >= 10 ? `$${v.toFixed(1)}` : `$${v.toFixed(2)}`
}

/** Axis ticks share one precision, set by the step: $5, $10, $15 or $0.25, $0.50. */
function axisMoney(v: number, step: number): string {
  return Number.isInteger(step) ? `$${Math.round(v)}` : `$${v.toFixed(step < 0.1 ? 2 : step < 1 ? 2 : 1)}`
}

/** labelEvery: show every n-th x label (24 hours don't fit side by side). */
export function columnChartSvg(o: { title: string; subtitle: string; columns: Column[]; labelEvery?: number }): string {
  const W = 1000, H = 520
  const left = 72, right = 24, top = 104, bottom = 56
  const pw = W - left - right, ph = H - top - bottom
  const max = Math.max(0, ...o.columns.map(c => c.value))
  const { top: yTop, step } = niceScale(max)
  const n = Math.max(1, o.columns.length)
  const slot = pw / n
  const bw = Math.min(24, Math.max(4, slot * 0.6))
  const y = (v: number) => top + ph - (v / yTop) * ph
  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`)
  out.push(`<rect width="${W}" height="${H}" fill="${C.surface}"/>`)
  out.push(`<text x="${left}" y="44" font-size="26" font-weight="bold" fill="${C.primary}">${escapeHtml(o.title)}</text>`)
  out.push(`<text x="${left}" y="76" font-size="17" fill="${C.secondary}">${escapeHtml(o.subtitle)}</text>`)
  for (let v = step; v <= yTop + 1e-9; v += step) {
    out.push(`<line x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}" stroke="${C.grid}" stroke-width="1"/>`)
    out.push(`<text x="${left - 10}" y="${y(v) + 5}" font-size="14" fill="${C.muted}" text-anchor="end">${axisMoney(v, step)}</text>`)
  }
  out.push(`<text x="${left - 10}" y="${top + ph + 5}" font-size="14" fill="${C.muted}" text-anchor="end">$0</text>`)
  const peak = o.columns.reduce((best, c, i) => (c.value > (o.columns[best]?.value ?? 0) ? i : best), 0)
  for (const [i, c] of o.columns.entries()) {
    const cx = left + slot * i + slot / 2
    if (c.value > 0) {
      const h = Math.max(2, (c.value / yTop) * ph)
      const x0 = cx - bw / 2, y0 = top + ph - h, r = Math.min(4, h, bw / 2)
      // Rounded data end, square at the baseline.
      out.push(`<path d="M${x0},${top + ph} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} H${x0 + bw - r} Q${x0 + bw},${y0} ${x0 + bw},${y0 + r} V${top + ph} Z" fill="${C.bar}"/>`)
      if (i === peak) out.push(`<text x="${cx}" y="${y0 - 10}" font-size="15" font-weight="bold" fill="${C.primary}" text-anchor="middle">${money(c.value)}</text>`)
    }
    if (i % (o.labelEvery ?? 1) === 0) out.push(`<text x="${cx}" y="${top + ph + 28}" font-size="14" fill="${C.muted}" text-anchor="middle">${escapeHtml(c.label)}</text>`)
  }
  out.push(`<line x1="${left}" x2="${W - right}" y1="${top + ph}" y2="${top + ph}" stroke="${C.baseline}" stroke-width="1"/>`)
  if (max <= 0) out.push(`<text x="${left + pw / 2}" y="${top + ph / 2}" font-size="18" fill="${C.muted}" text-anchor="middle">Нет активности за период</text>`)
  out.push('</svg>')
  return out.join('\n')
}

/** PNG at 2× for a sharp image on phones; null if resvg is unavailable on this platform. */
export async function svgToPng(svg: string): Promise<Buffer | null> {
  try {
    const { Resvg } = await import('@resvg/resvg-js')
    const r = new Resvg(svg, { fitTo: { mode: 'zoom', value: 2 }, font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } })
    return Buffer.from(r.render().asPng())
  } catch {
    return null
  }
}
