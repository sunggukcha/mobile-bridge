export const DEFAULT_RICH_STYLE_ID = 'warm-noir';

function preset(id, name, colors) {
  return Object.freeze({
    id,
    name,
    colors: Object.freeze({ ...colors }),
  });
}

// Stable ordering is part of the command contract: `/style 2` must keep meaning
// the same thing across restarts and deployments.
export const RICH_STYLE_PRESETS = Object.freeze([
  preset('warm-noir', 'Warm Noir', {
    background: '#1c1917', surface: '#262626', accent: '#f0b429', accentAlt: '#d97706',
    formulaAccent: '#f59e0b', text: '#fef3c7', headerText: '#1c1917', border: '#57534e', muted: '#d6d3d1',
  }),
  preset('glassmorphism', 'Glassmorphism', {
    background: '#172033', surface: '#26344d', accent: '#7dd3fc', accentAlt: '#c4b5fd',
    text: '#f8fafc', headerText: '#172033', border: '#64748b', muted: '#cbd5e1',
  }),
  preset('arctic-neon', 'Arctic Neon', {
    background: '#071a2b', surface: '#0b2942', accent: '#67e8f9', accentAlt: '#22d3ee',
    text: '#ecfeff', headerText: '#082f49', border: '#0e7490', muted: '#a5f3fc',
  }),
  preset('cyberpunk', 'Cyberpunk', {
    background: '#16051f', surface: '#2a0a3d', accent: '#f9f871', accentAlt: '#ff3cac',
    text: '#fdf4ff', headerText: '#21102b', border: '#d946ef', muted: '#f5d0fe',
  }),
  preset('emerald-slate', 'Emerald Slate', {
    background: '#10201d', surface: '#18312c', accent: '#34d399', accentAlt: '#059669',
    text: '#ecfdf5', headerText: '#052e16', border: '#2f6b5d', muted: '#a7f3d0',
  }),
  preset('midnight-purple', 'Midnight Purple', {
    background: '#17152b', surface: '#252044', accent: '#a78bfa', accentAlt: '#7c3aed',
    text: '#f5f3ff', headerText: '#1e1b4b', border: '#5b4b8a', muted: '#ddd6fe',
  }),
  preset('minimal-light', 'Minimal Light', {
    background: '#f8fafc', surface: '#e2e8f0', accent: '#334155', accentAlt: '#64748b',
    text: '#0f172a', headerText: '#f8fafc', border: '#cbd5e1', muted: '#475569',
  }),
  preset('solarized-dark', 'Solarized Dark', {
    background: '#002b36', surface: '#073642', accent: '#b58900', accentAlt: '#cb4b16',
    text: '#eee8d5', headerText: '#002b36', border: '#586e75', muted: '#93a1a1',
  }),
  preset('soft-pastel', 'Soft Pastel', {
    background: '#fff7fb', surface: '#f3e8ff', accent: '#f9a8d4', accentAlt: '#c4b5fd',
    text: '#4a315f', headerText: '#4a315f', border: '#e9d5ff', muted: '#7e5d8f',
  }),
  preset('synthwave', 'Synthwave', {
    background: '#1b1035', surface: '#2e1854', accent: '#ff6ec7', accentAlt: '#7df9ff',
    text: '#fff1ff', headerText: '#27113e', border: '#8b5cf6', muted: '#e9d5ff',
  }),
  preset('oceanic', 'Oceanic', {
    background: '#0b2230', surface: '#12394a', accent: '#38bdf8', accentAlt: '#14b8a6',
    text: '#f0fdfa', headerText: '#082f49', border: '#28788e', muted: '#bae6fd',
  }),
  preset('rosewood', 'Rosewood', {
    background: '#2a1518', surface: '#432126', accent: '#fb7185', accentAlt: '#be123c',
    text: '#fff1f2', headerText: '#3f0d18', border: '#7f3541', muted: '#fecdd3',
  }),
]);

const PRESETS_BY_ID = new Map(RICH_STYLE_PRESETS.map((theme) => [theme.id, theme]));

export function richStyleBySelector(selector) {
  const value = String(selector ?? '').trim().toLowerCase();
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const index = Number.parseInt(value, 10) - 1;
    return RICH_STYLE_PRESETS[index] || null;
  }
  return PRESETS_BY_ID.get(value) || null;
}

export function normalizeRichStyleId(value, fallback = DEFAULT_RICH_STYLE_ID) {
  return richStyleBySelector(value)?.id || richStyleBySelector(fallback)?.id || DEFAULT_RICH_STYLE_ID;
}

export function richStyleById(value) {
  return PRESETS_BY_ID.get(normalizeRichStyleId(value)) || RICH_STYLE_PRESETS[0];
}

export function formatRichStylePresetList(currentStyleId = DEFAULT_RICH_STYLE_ID) {
  const selected = normalizeRichStyleId(currentStyleId);
  return RICH_STYLE_PRESETS.map((theme, index) =>
    `${index + 1}. ${theme.name} \`${theme.id}\`${theme.id === selected ? ' (current)' : ''}`)
    .join('\n');
}

export function renderRichStyleContactSheetSvg() {
  const width = 900;
  const height = 600;
  const columns = 3;
  const cardWidth = 276;
  const cardHeight = 124;
  const gapX = 12;
  const gapY = 12;
  const marginX = 24;
  const marginY = 48;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`,
    '<rect width="100%" height="100%" fill="#0f172a"/>',
    '<text x="24" y="31" fill="#f8fafc" font-family="Noto Sans KR, Arial, sans-serif" font-size="20" font-weight="700">Bridge rendering themes</text>',
  ];

  RICH_STYLE_PRESETS.forEach((theme, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = marginX + column * (cardWidth + gapX);
    const y = marginY + row * (cardHeight + gapY);
    const c = theme.colors;
    parts.push(
      `<g data-style-id="${theme.id}">`,
      `<rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="12" fill="${c.background}" stroke="${c.border}" stroke-width="2"/>`,
      `<rect x="${x}" y="${y}" width="8" height="${cardHeight}" rx="4" fill="${c.accent}"/>`,
      `<text x="${x + 18}" y="${y + 24}" fill="${c.text}" font-family="Noto Sans KR, Arial, sans-serif" font-size="14" font-weight="700">${index + 1}. ${theme.name}</text>`,
      `<text x="${x + 18}" y="${y + 41}" fill="${c.muted}" font-family="Noto Sans KR, Arial, sans-serif" font-size="9">${theme.id}</text>`,
      `<rect x="${x + 18}" y="${y + 52}" width="102" height="17" rx="3" fill="${c.accent}"/>`,
      `<rect x="${x + 18}" y="${y + 71}" width="102" height="20" rx="3" fill="${c.surface}"/>`,
      `<rect x="${x + 132}" y="${y + 52}" width="126" height="39" rx="7" fill="${c.surface}" stroke="${c.border}"/>`,
      `<text x="${x + 155}" y="${y + 77}" fill="${c.text}" font-family="Noto Sans KR, Arial, sans-serif" font-size="17" font-weight="600">E = mc²</text>`,
      `<rect x="${x + 36}" y="${y + 101}" width="55" height="15" rx="5" fill="${c.surface}" stroke="${c.accent}"/>`,
      `<rect x="${x + 187}" y="${y + 101}" width="55" height="15" rx="5" fill="${c.surface}" stroke="${c.accentAlt}"/>`,
      `<path d="M ${x + 93} ${y + 108} H ${x + 182}" stroke="${c.muted}" stroke-width="2"/>`,
      `<path d="M ${x + 176} ${y + 104} L ${x + 183} ${y + 108} L ${x + 176} ${y + 112}" fill="none" stroke="${c.muted}" stroke-width="2"/>`,
      '</g>',
    );
  });
  parts.push('</svg>');
  return parts.join('');
}
