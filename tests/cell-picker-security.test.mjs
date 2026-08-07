import { test } from 'node:test';
import { ok } from './helpers.mjs';
import { escapeCellText } from '../js/cell-picker.js';

test('customer cell text cannot become persistent picker markup', () => {
  const hostile = `<img src=x onerror="globalThis.pwned=1"> O'Brien & Sons`;
  const rendered = escapeCellText(hostile);
  ok(!rendered.includes('<img') && !rendered.includes('onerror="'),
    'HTML and attribute delimiters are escaped');
  ok(rendered.includes('&lt;img') && rendered.includes('&quot;')
      && rendered.includes('&#39;') && rendered.includes('&amp;'),
    'the complete customer name remains visible as encoded text');
});
