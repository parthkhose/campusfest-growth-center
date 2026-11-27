// Small SVG chart helpers. Hover tooltips come from data-tip attributes (see app.js).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const T1 = '#191919', T2 = '#5f5f5a', GRID = '#ecece7', AXIS = '#c9c9c2';

function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }

// Line chart over dates. series: [{name, color, points:[{x:'YYYY-MM-DD', y}], dash, step}]
export function lineChart({ series, height = 240, yFmt = (v) => v, marker }) {
  const W = 760, H = height, L = 46, R = 16, Tp = 14, B = 28;
  const xs = series.flatMap((s) => s.points.map((p) => Date.parse(p.x)));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const yMax = niceMax(Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.y ?? 0))) * 1.08);
  const X = (d) => L + ((Date.parse(d) - x0) / Math.max(1, x1 - x0)) * (W - L - R);
  const Y = (v) => Tp + (1 - v / yMax) * (H - Tp - B);
  const ticks = [0, .25, .5, .75, 1].map((f) => f * yMax);
  const months = []; const d = new Date(x0); d.setUTCDate(1);
  while (d.getTime() <= x1) { if (d.getTime() >= x0) months.push(d.toISOString().slice(0, 10)); d.setUTCMonth(d.getUTCMonth() + 1); }
  const path = (s) => s.points.filter((p) => p.y != null).map((p, i, a) => {
    const x = X(p.x), y = Y(p.y);
    if (i === 0) return `M${x},${y}`;
    return s.step ? `H${x}V${y}` : `L${x},${y}`;
  }).join('');
  let out = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  out += ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}" stroke="${GRID}"/><text x="${L - 8}" y="${Y(t) + 4}" text-anchor="end" font-size="11" fill="${T2}">${esc(yFmt(t))}</text>`).join('');
  out += months.map((m) => `<text x="${X(m)}" y="${H - 8}" font-size="11" fill="${T2}" text-anchor="middle">${new Date(m).toLocaleString('en', { month: 'short', timeZone: 'UTC' })}</text>`).join('');
  out += `<line x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}" stroke="${AXIS}"/>`;
  if (marker) out += `<line x1="${X(marker.x)}" x2="${X(marker.x)}" y1="${Tp}" y2="${H - B}" stroke="${AXIS}" stroke-dasharray="3 3"/><text x="${X(marker.x) + 4}" y="${Tp + 10}" font-size="11" fill="${T2}">${esc(marker.label)}</text>`;
  for (const s of series) out += `<path d="${path(s)}" fill="none" stroke="${s.color}" stroke-width="2" ${s.dash ? 'stroke-dasharray="5 4"' : ''} stroke-linejoin="round"/>`;
  // hover columns
  const pts = series[0].points;
  const bw = (W - L - R) / Math.max(1, pts.length - 1);
  out += pts.map((p, i) => {
    const tip = series.map((s) => { const q = s.points[i]; return q && q.y != null ? `${s.name}: ${yFmt(q.y)}` : null; }).filter(Boolean).join('<br>');
    return `<rect x="${X(p.x) - bw / 2}" y="${Tp}" width="${bw}" height="${H - Tp - B}" fill="transparent" data-tip="${esc(`<b>${p.x}</b><br>${tip}`)}"/>`;
  }).join('');
  const last = series[0].points.filter((p) => p.y != null).at(-1);
  if (last) out += `<circle cx="${X(last.x)}" cy="${Y(last.y)}" r="4" fill="${series[0].color}" stroke="#fff" stroke-width="2"/><text x="${Math.min(X(last.x) + 8, W - R - 10)}" y="${Y(last.y) - 8}" font-size="12" font-weight="600" fill="${T1}" text-anchor="${X(last.x) > W - 80 ? 'end' : 'start'}">${esc(yFmt(last.y))}</text>`;
  return out + '</svg>';
}

// Horizontal bars with optional target tick. rows: [{label, value, target, color, tip, sub}]
export function hbars({ rows, fmt = (v) => v, labelW = 200, rowH = 30, max, W = 1100, R = 300 }) {
  const L = labelW, H = rows.length * rowH + 8;
  const m = niceMax(max ?? Math.max(1, ...rows.map((r) => Math.max(r.value || 0, r.target || 0))));
  const X = (v) => L + (v / m) * (W - L - R);
  let out = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  rows.forEach((r, i) => {
    const y = 4 + i * rowH, bh = rowH - 12;
    out += `<text x="${L - 10}" y="${y + bh / 2 + 4}" text-anchor="end" font-size="12" fill="${T1}">${esc(r.label)}</text>`;
    out += `<rect x="${L}" y="${y}" width="${W - L - R}" height="${bh}" fill="#f4f4f1" rx="4"/>`;
    if (r.value > 0) out += `<rect x="${L}" y="${y}" width="${Math.max(2, X(r.value) - L)}" height="${bh}" fill="${r.color || '#257de0'}" rx="4"/>`;
    if (r.target) out += `<line x1="${X(r.target)}" x2="${X(r.target)}" y1="${y - 3}" y2="${y + bh + 3}" stroke="${T1}" stroke-width="2"/>`;
    out += `<text x="${X(Math.max(r.value || 0, r.target || 0)) + 8}" y="${y + bh / 2 + 4}" font-size="12" fill="${T2}">${esc(r.sub ?? fmt(r.value))}</text>`;
    out += `<rect x="0" y="${y - 2}" width="${W}" height="${rowH - 4}" fill="transparent" data-tip="${esc(r.tip || `${r.label}: ${fmt(r.value)}`)}"/>`;
  });
  return out + '</svg>';
}

// Funnel: stages stacked, width proportional to the first stage, with the share carried on.
export function funnel({ stages }) {
  const W = 1100, rowH = 34, H = stages.length * rowH + 6, L = 190, maxW = W - L - 260;
  const first = Math.max(1, stages[0].value);
  let out = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  stages.forEach((s, i) => {
    const y = 3 + i * rowH, w = Math.max(3, (s.value / first) * maxW);
    const prev = i ? stages[i - 1].value : null;
    const conv = prev ? (prev ? Math.round((s.value / prev) * 100) : 0) : null;
    out += `<text x="${L - 10}" y="${y + 19}" text-anchor="end" font-size="12" fill="${T1}">${esc(s.label)}</text>`;
    out += `<rect x="${L}" y="${y}" width="${w}" height="${rowH - 8}" rx="4" fill="${s.color || '#257de0'}" fill-opacity="${1 - i * 0.07}"/>`;
    out += `<text x="${L + w + 8}" y="${y + 18}" font-size="12.5" font-weight="600" fill="${T1}">${s.value}</text>`;
    if (conv != null) out += `<text x="${L + w + 8 + String(s.value).length * 8 + 8}" y="${y + 18}" font-size="11.5" fill="${T2}">${conv}% of previous</text>`;
    out += `<rect x="0" y="${y}" width="${W}" height="${rowH - 4}" fill="transparent" data-tip="${esc(`<b>${s.label}</b><br>${s.value}${conv != null ? ` (${conv}% of previous stage)` : ''}${s.tip ? '<br>' + s.tip : ''}`)}"/>`;
  });
  return out + '</svg>';
}
