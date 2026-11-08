// Offline checks for the copyright-year window: node --test scripts/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyrightYearOk } from './copyright-year.mjs';

test('the current year always passes', () => {
  assert.equal(copyrightYearOk(2026, new Date('2026-06-15')), true);
  assert.equal(copyrightYearOk(2027, new Date('2027-01-01')), true);
});

test('January accepts last year, so the daily job survives New Year', () => {
  assert.equal(copyrightYearOk(2026, new Date('2027-01-01')), true);
  assert.equal(copyrightYearOk(2026, new Date('2027-01-31')), true);
});

test('by February last year is stale again', () => {
  assert.equal(copyrightYearOk(2026, new Date('2027-02-01')), false);
  assert.equal(copyrightYearOk(2026, new Date('2027-06-15')), false);
});

test('older years and future years never pass', () => {
  assert.equal(copyrightYearOk(2025, new Date('2027-01-15')), false);
  assert.equal(copyrightYearOk(2028, new Date('2027-01-15')), false);
});
