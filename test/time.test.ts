import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTimeRefs } from '../src/time/resolve.js';

// Thursday 12 Nov 2026, 22:30 in India.
const NOW = new Date('2026-11-12T17:00:00Z');
const TZ = 'Asia/Kolkata';
const labels = (text: string) => resolveTimeRefs(text, NOW, TZ).map((r) => r.label);

test('weekday names resolve to the most recent past occurrence', () => {
  assert.deepEqual(labels('On Monday we shortlisted 5 CRM tools'), ['Monday 9 November 2026']);
  assert.deepEqual(labels('what about friday'), ['Friday 6 November 2026']);
});

test('"last Tuesday" keeps the week-before reading as an alternate', () => {
  const [ref] = resolveTimeRefs('Last Tuesday I asked you about Postgres hosting', NOW, TZ);
  assert.equal(ref!.label, 'Tuesday 10 November 2026');
  assert.deepEqual(ref!.alternates.map((a) => a.label), ['Tuesday 3 November 2026']);
});

test('same weekday as today means a week ago, with today as alternate', () => {
  const [ref] = resolveTimeRefs('on thursday', NOW, TZ);
  assert.equal(ref!.label, 'Thursday 5 November 2026');
  assert.deepEqual(ref!.alternates.map((a) => a.label), ['Thursday 12 November 2026']);
});

test('explicit dates in several formats', () => {
  assert.deepEqual(labels('What did I ask you on 3 November?'), ['Tuesday 3 November 2026']);
  assert.deepEqual(labels('November 3rd'), ['Tuesday 3 November 2026']);
  assert.deepEqual(labels('on the 3rd of Nov'), ['Tuesday 3 November 2026']);
  assert.deepEqual(labels('2026-10-01'), ['Thursday 1 October 2026']);
});

test('a date later this year without a year means last year', () => {
  assert.deepEqual(labels('on 20 December'), ['Saturday 20 December 2025']);
});

test('relative days', () => {
  assert.deepEqual(labels('yesterday'), ['Wednesday 11 November 2026']);
  assert.deepEqual(labels('the day before yesterday'), ['Tuesday 10 November 2026']);
  assert.deepEqual(labels('3 days ago'), ['Monday 9 November 2026']);
});

test('weeks and months', () => {
  assert.match(labels('last week')[0]!, /last week \(2 Nov–8 Nov 2026\)/);
  assert.deepEqual(labels('back in October'), ['October 2026']);
});

test('"monday.com" is a CRM, not a date', () => {
  assert.deepEqual(labels('Is monday.com cheaper than HubSpot?'), []);
});

test('timezone matters near midnight', () => {
  // 23:30 on Mon 9 Nov in India is still Mon 9 Nov 18:00 UTC; in Los Angeles it is Mon 9 Nov 10:00.
  const late = new Date('2026-11-09T18:00:00Z');
  assert.equal(resolveTimeRefs('yesterday', late, 'Asia/Kolkata')[0]!.label, 'Sunday 8 November 2026');
  assert.equal(resolveTimeRefs('yesterday', new Date('2026-11-09T20:00:00Z'), 'Asia/Kolkata')[0]!.label, 'Monday 9 November 2026');
});

test('no date words → no refs', () => {
  assert.deepEqual(labels('What is the best Postgres host?'), []);
});
