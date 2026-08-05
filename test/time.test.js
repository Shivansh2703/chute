import assert from 'node:assert/strict';
import test from 'node:test';

import { zonedParts } from '../src/lib/time.js';

test('zonedParts: defaults to UTC and zero-pads', () => {
  const parts = zonedParts(new Date('2026-01-05T03:07:00Z'));
  assert.deepEqual(parts, { y: '2026', m: '01', d: '05', hh: '03', mm: '07' });
});

test('zonedParts: honors an explicit IANA timezone', () => {
  // 2026-01-05T03:07:00Z is 2026-01-04 22:07 in America/Toronto (EST, UTC-5).
  const parts = zonedParts(new Date('2026-01-05T03:07:00Z'), 'America/Toronto');
  assert.deepEqual(parts, { y: '2026', m: '01', d: '04', hh: '22', mm: '07' });
});

test('zonedParts: normalizes midnight from "24" to "00"', () => {
  const parts = zonedParts(new Date('2026-01-05T00:00:00Z'), 'UTC');
  assert.equal(parts.hh, '00');
});
