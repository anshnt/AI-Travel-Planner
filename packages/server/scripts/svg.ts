/**
 * A very small SVG writer, plus the shared theme tokens.
 *
 * The diagrams in `docs/` are generated rather than drawn so they cannot drift
 * away from what the planner actually does: every bar and every label in them
 * comes from a real `planTrip` call.
 *
 * Colours are emitted as CSS custom properties with a `prefers-color-scheme`
 * override, so one file reads correctly on a light or a dark README.
 */

export type Tokens = {
  surface: string;
  ink: string;
  ink2: string;
  ink3: string;
  grid: string;
  band: string;
  /** Categorical slots 1-3 of the validated palette. */
  s1: string;
  s2: string;
  s3: string;
  /** Sequential ramp for magnitude (rain probability), light to dark. */
  ramp: [string, string, string, string];
};

export const LIGHT: Tokens = {
  surface: '#fcfcfb',
  ink: '#0b0b0b',
  ink2: '#52514e',
  ink3: '#8a887f',
  grid: '#e6e5e0',
  band: '#eceae4',
  s1: '#2a78d6',
  s2: '#eb6834',
  s3: '#1baf7a',
  ramp: ['#dbe8f8', '#a9c8ee', '#6ba1e0', '#2a78d6'],
};

export const DARK: Tokens = {
  surface: '#1a1a19',
  ink: '#ffffff',
  ink2: '#c3c2b7',
  ink3: '#8a887f',
  grid: '#2e2e2b',
  band: '#262623',
  s1: '#3987e5',
  s2: '#d95926',
  s3: '#199e70',
  ramp: ['#1e2a38', '#26456b', '#2c639f', '#3987e5'],
};

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif";

export function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function tokenBlock(tokens: Tokens): string {
  const entries: [string, string][] = [
    ['surface', tokens.surface],
    ['ink', tokens.ink],
    ['ink-2', tokens.ink2],
    ['ink-3', tokens.ink3],
    ['grid', tokens.grid],
    ['band', tokens.band],
    ['s1', tokens.s1],
    ['s2', tokens.s2],
    ['s3', tokens.s3],
    ['ramp-1', tokens.ramp[0]],
    ['ramp-2', tokens.ramp[1]],
    ['ramp-3', tokens.ramp[2]],
    ['ramp-4', tokens.ramp[3]],
  ];
  return entries.map(([name, value]) => `    --${name}: ${value};`).join('\n');
}

/**
 * Wraps a body in an SVG document with theme-aware tokens.
 *
 * The dark values are declared under a media query rather than baked in, so the
 * same file works on both README themes. A viewer that strips the media query
 * still gets the light palette, which is the safe default.
 */
export function svgDocument(
  width: number,
  height: number,
  title: string,
  description: string,
  body: string,
): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="t d">
  <title id="t">${escapeText(title)}</title>
  <desc id="d">${escapeText(description)}</desc>
  <style>
  :root {
${tokenBlock(LIGHT)}
  }
  @media (prefers-color-scheme: dark) {
    :root {
${tokenBlock(DARK)}
    }
  }
  text { font-family: ${FONT}; fill: var(--ink); }
  .t-dim { fill: var(--ink-2); }
  .t-faint { fill: var(--ink-3); }
  .t-num { font-variant-numeric: tabular-nums; }
  .rule { stroke: var(--grid); stroke-width: 1; }
  </style>
  <rect width="${width}" height="${height}" fill="var(--surface)"/>
${body}
</svg>
`;
}

export type TextOptions = {
  size?: number;
  weight?: number;
  anchor?: 'start' | 'middle' | 'end';
  className?: string;
  fill?: string;
  baseline?: 'auto' | 'middle' | 'hanging';
};

export function text(x: number, y: number, value: string, options: TextOptions = {}): string {
  const attrs = [
    `x="${round(x)}"`,
    `y="${round(y)}"`,
    `font-size="${options.size ?? 12}"`,
    options.weight ? `font-weight="${options.weight}"` : '',
    options.anchor && options.anchor !== 'start' ? `text-anchor="${options.anchor}"` : '',
    options.className ? `class="${options.className}"` : '',
    // An inline style, not a `fill` attribute: the stylesheet's `text { fill }`
    // rule beats a presentation attribute, which silently painted white labels
    // black on top of saturated fills.
    options.fill ? `style="fill:${options.fill}"` : '',
    options.baseline && options.baseline !== 'auto' ? `dominant-baseline="${options.baseline}"` : '',
  ].filter(Boolean);
  return `  <text ${attrs.join(' ')}>${escapeText(value)}</text>`;
}

export function rect(
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  radius = 0,
  extra = '',
): string {
  return `  <rect x="${round(x)}" y="${round(y)}" width="${round(Math.max(0, width))}" height="${round(Math.max(0, height))}" rx="${radius}" fill="${fill}"${extra ? ` ${extra}` : ''}/>`;
}

export function line(x1: number, y1: number, x2: number, y2: number, extra = 'class="rule"'): string {
  return `  <line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}" ${extra}/>`;
}

export function path(d: string, extra: string): string {
  return `  <path d="${d}" ${extra}/>`;
}

export function circle(cx: number, cy: number, r: number, fill: string, extra = ''): string {
  return `  <circle cx="${round(cx)}" cy="${round(cy)}" r="${r}" fill="${fill}"${extra ? ` ${extra}` : ''}/>`;
}

export function group(transform: string, body: string): string {
  return `  <g transform="${transform}">\n${body}\n  </g>`;
}

/**
 * A legend row: swatch, then label. Identity is never colour alone.
 *
 * Advance is measured from the label text rather than assumed, because a legend
 * carrying values ("Food EUR 496") is far wider than one carrying bare names and
 * a fixed stride runs the entries into each other.
 */
export function legend(
  x: number,
  y: number,
  entries: { color: string; label: string }[],
  size = 11,
): string {
  const parts: string[] = [];
  let cursor = x;
  for (const entry of entries) {
    parts.push(rect(cursor, y - size * 0.62, 9, 9, entry.color, 2));
    parts.push(text(cursor + 14, y, entry.label, { size, className: 't-dim' }));
    cursor += 14 + textWidth(entry.label, size) + 22;
  }
  return parts.join('\n');
}

/**
 * Rough advance width of a string at a given font size.
 *
 * 0.56em per character is a serviceable average for a system sans; digits and
 * capitals run wider, so the estimate is deliberately generous rather than
 * tight. Used only for laying out legends and deciding whether a label fits
 * inside a mark -- never for anything the reader can measure against.
 */
export function textWidth(value: string, size: number): number {
  return value.length * size * 0.56;
}

/** A two-swatch scale legend for a sequential ramp. */
export function rampLegend(
  x: number,
  y: number,
  steps: readonly string[],
  lowLabel: string,
  highLabel: string,
  size = 11,
): string {
  const parts: string[] = [text(x, y, lowLabel, { size, className: 't-dim' })];
  let cursor = x + textWidth(lowLabel, size) + 8;
  for (const step of steps) {
    parts.push(rect(cursor, y - size * 0.62, 14, 9, step, 2));
    cursor += 16;
  }
  parts.push(text(cursor + 2, y, highLabel, { size, className: 't-dim' }));
  return parts.join('\n');
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}
