import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_RICH_STYLE_ID,
  RICH_STYLE_PRESETS,
  formatRichStylePresetList,
  renderRichStyleContactSheetSvg,
  richStyleBySelector,
} from '../lib/rich-style-themes.mjs';
import { renderFormulaSvg, splitRichContent } from '../lib/rich-content.mjs';

test('rich style catalog exposes twelve immutable presets with stable selectors', () => {
  assert.equal(DEFAULT_RICH_STYLE_ID, 'warm-noir');
  assert.equal(RICH_STYLE_PRESETS.length, 12);
  assert.equal(Object.isFrozen(RICH_STYLE_PRESETS), true);
  assert.equal(new Set(RICH_STYLE_PRESETS.map((theme) => theme.id)).size, 12);
  for (const theme of RICH_STYLE_PRESETS) {
    assert.equal(Object.isFrozen(theme), true);
    assert.equal(Object.isFrozen(theme.colors), true);
  }
  assert.equal(richStyleBySelector('1').id, 'warm-noir');
  assert.equal(richStyleBySelector(' 2 ').id, 'glassmorphism');
  assert.equal(richStyleBySelector('MINIMAL-LIGHT').id, 'minimal-light');
  assert.equal(richStyleBySelector('13'), null);
  assert.equal(richStyleBySelector('missing'), null);
  assert.equal(formatRichStylePresetList('minimal-light').split('\n').length, 12);
  assert.match(formatRichStylePresetList('minimal-light'), /7\. Minimal Light.*\(current\)/);
});

test('style contact sheet contains a sample card for every preset and rasterizes once', async () => {
  const svg = renderRichStyleContactSheetSvg();
  assert.equal((svg.match(/data-style-id=/g) || []).length, 12);
  for (const theme of RICH_STYLE_PRESETS) {
    assert.match(svg, new RegExp(`data-style-id="${theme.id}"`));
  }

  const parts = await splitRichContent('Rendering themes', { includeStylePreview: true });
  assert.deepEqual(parts.map((part) => part.type), ['text', 'image']);
  const attachment = parts[1].attachment;
  assert.match(attachment.filename, /^codex-style-preview-[a-f0-9]{12}\.png$/);
  assert.equal(attachment.contentType, 'image/png');
  assert.equal(attachment.data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('selected style changes tables, formulas, diagrams, and their image digests', async () => {
  const samples = [
    '| Name | Value |\n| --- | ---: |\n| latency | 42 |',
    '```math\nE=mc^2\n```',
    '```text\n[Input]\n  └─→ [Output]\n  └── [Store]\n```',
  ];
  for (const sample of samples) {
    const warm = (await splitRichContent(sample, { styleId: 'warm-noir' }))
      .find((part) => part.type === 'image').attachment;
    const light = (await splitRichContent(sample, { styleId: 'minimal-light' }))
      .find((part) => part.type === 'image').attachment;
    assert.notEqual(warm.filename, light.filename);
    assert.notDeepEqual(warm.data, light.data);
  }

  const defaultFormula = await renderFormulaSvg('E=mc^2');
  const warmFormula = await renderFormulaSvg('E=mc^2', { styleId: 'warm-noir' });
  const lightFormula = await renderFormulaSvg('E=mc^2', { styleId: 'minimal-light' });
  const stableRendererIds = (svg) => svg.replace(/MJX-\d+/g, 'MJX-N');
  assert.equal(stableRendererIds(defaultFormula), stableRendererIds(warmFormula));
  assert.match(defaultFormula, /#f59e0b/);
  assert.match(defaultFormula, /fill="#1c1917"/);
  assert.notEqual(defaultFormula, lightFormula);
});
