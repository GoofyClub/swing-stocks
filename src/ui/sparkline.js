// Inline SVG sparkline. Zero deps, < 1 KB. Pass an array of numbers + width/height.
//
// Returns an HTML string ready to insert into innerHTML. Renders a smooth polyline
// scaled into the viewport, with an optional fill underneath. Null values produce
// a gap in the line (handled by splitting into segments).

export function sparkline(values, opts = {}) {
  const {
    width  = 120,
    height = 32,
    stroke = 'currentColor',
    fill   = 'none',
    padding = 2,
    strokeWidth = 1.5,
  } = opts;

  const clean = values.map(v => (typeof v === 'number' && Number.isFinite(v)) ? v : null);
  const present = clean.filter(v => v != null);
  if (present.length < 2) {
    // Not enough points — show a flat dim line so the tile doesn't collapse.
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <line x1="${padding}" y1="${height/2}" x2="${width-padding}" y2="${height/2}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="0.3"/>
    </svg>`;
  }

  const min = Math.min(...present);
  const max = Math.max(...present);
  const range = max - min || 1;
  const usableW = width - padding * 2;
  const usableH = height - padding * 2;
  const stepX = clean.length > 1 ? usableW / (clean.length - 1) : 0;

  const pts = clean.map((v, i) => {
    if (v == null) return null;
    const x = padding + i * stepX;
    const y = padding + (1 - (v - min) / range) * usableH;
    return [x, y];
  });

  // Build segments of contiguous non-null points.
  let path = '';
  let segOpen = false;
  for (const p of pts) {
    if (p == null) { segOpen = false; continue; }
    path += (segOpen ? ' L ' : 'M ') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
    segOpen = true;
  }

  // Optional fill — close to the bottom for a gradient-fill look.
  let fillPath = '';
  if (fill !== 'none') {
    const first = pts.find(p => p != null);
    const last  = [...pts].reverse().find(p => p != null);
    if (first && last) {
      fillPath = `<path d="${path} L ${last[0].toFixed(1)} ${height-padding} L ${first[0].toFixed(1)} ${height-padding} Z" fill="${fill}" stroke="none"/>`;
    }
  }

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
    ${fillPath}
    <path d="${path}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}
