// =============================================================================
// Silent-death detection.
//
// The bug these pin: the entry runner was OOM-killed mid-scan on every session
// from 13 to 28 August and nothing reported it. SIGKILL leaves no exception, no
// log line and no exit handler, so every failure path in the system — the
// `.catch()` alert, the cronRuns record, the Telegram error message — depends on
// code that never got to run. Eighteen trading days of "no signals today" were
// indistinguishable from a quiet market.
//
// The marker fixes that by recording INTENT separately from OUTCOME, on disk,
// where a killed process cannot retract it. These tests exist to keep the two
// failure modes apart: a run that died must be reported, and a run that ended
// early on purpose ("outside the close window", a weekend) must NOT be — an
// alert that fires every Saturday is one nobody reads by Monday.
//
// Run with:  node tests/run-marker.mjs
// =============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginRun, markStep, endRun, incompleteRunAlert } from '../scripts/lib/run-marker.mjs';

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else      { fail++; console.error('  ✗', name); }
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swing-marker-'));
process.env.SWING_RUN_STATE_DIR = stateDir;
const markerPath = (job) => path.join(stateDir, `.${job}.running`);
const reset = (job) => { try { fs.unlinkSync(markerPath(job)); } catch { /* fine */ } };

console.log('\n--- a clean run ---');
{
  reset('a');
  const first = beginRun('a');
  t('the first run ever sees no previous marker', first === null);
  t('a marker is on disk while the run is in flight', fs.existsSync(markerPath('a')));

  endRun('a');
  t('completion removes the marker', !fs.existsSync(markerPath('a')));

  const second = beginRun('a');
  t('the next run sees nothing wrong', second === null);
  endRun('a');
}

console.log('\n--- a run that was killed ---');
{
  reset('b');
  // Simulate the kill: begin, make progress, then never call endRun — exactly
  // what SIGKILL leaves behind.
  beginRun('b', { now: new Date('2026-08-27T19:38:00Z') });
  markStep('b', 'scan US 900/1503 rss=780MB');

  const previous = beginRun('b', { now: new Date('2026-08-28T19:38:00Z') });
  t('the next run finds the abandoned marker', previous !== null);
  t('it reports when the dead run started', previous.startedAt === '2026-08-27T19:38:00.000Z');
  t('it reports how long ago that was', Math.round(previous.ageHours) === 24);
  t('it reports where the run died', previous.lastStep === 'scan US 900/1503 rss=780MB');

  // Critically: beginRun must have REPLACED the marker, not merely read it.
  // Leaving the dead run's marker in place would re-alert on the same corpse
  // every day forever, and a recurring alert that is always the same is one the
  // operator learns to ignore.
  const raw = JSON.parse(fs.readFileSync(markerPath('b'), 'utf8'));
  t('the stale marker is replaced by this run\'s own', raw.startedAt === '2026-08-28T19:38:00.000Z');
  t('the replacement carries no stale step', !raw.lastStep);

  endRun('b');
  const third = beginRun('b');
  t('a corpse is reported exactly once', third === null);
  endRun('b');
}

console.log('\n--- a deliberate early exit ---');
{
  reset('c');
  // Weekend / outside the close window. This is a SUCCESS, and the runner calls
  // endRun on it. If it did not, the alert would fire every Monday.
  beginRun('c');
  endRun('c');
  const next = beginRun('c');
  t('an early return is not mistaken for a death', next === null);
  endRun('c');
}

console.log('\n--- durability ---');
{
  reset('d');
  // markStep on a job with no marker (state dir wiped underneath us) must not
  // throw: bookkeeping failing is never a reason to fail a trading run.
  let threw = false;
  try { markStep('d', 'step'); } catch { threw = true; }
  t('markStep on a missing marker does not throw', threw === false);

  // A truncated or half-written marker — a kill during the write itself — must
  // read as "nothing known", not as a crash on the next start-up.
  fs.writeFileSync(markerPath('d'), '{"startedAt":');
  let previous = 'unset';
  let threw2 = false;
  try { previous = beginRun('d'); } catch { threw2 = true; }
  t('a corrupt marker does not throw', threw2 === false);
  t('a corrupt marker reports nothing rather than lying', previous === null);
  endRun('d');

  let threw3 = false;
  try { endRun('d'); } catch { threw3 = true; }
  t('endRun twice is harmless', threw3 === false);
}

console.log('\n--- the alert text ---');
{
  const msg = incompleteRunAlert('sameday', {
    startedAt: '2026-08-27T19:38:00.000Z', ageHours: 24.02, lastStep: 'scan US 900/1503 rss=780MB',
  }, { unit: 'swing-sameday' });

  t('it names the job', msg.includes('sameday did not finish'));
  t('it carries the last known step', msg.includes('scan US 900/1503'));
  t('it names the unit to check', msg.includes('journalctl -u swing-sameday'));

  // It is sent through Telegram, which rejects the WHOLE message on an unknown
  // or unbalanced tag — a malformed alert is a silent one, which is the exact
  // failure this module exists to end.
  const tags = msg.match(/<\/?[a-z]+>/g) || [];
  const open = tags.filter(x => !x.startsWith('</')).length;
  const close = tags.filter(x => x.startsWith('</')).length;
  t('its HTML tags balance', open === close);
  t('it uses only tags Telegram allows', tags.every(x => /^<\/?(b|i|u|s|a|code|pre)>$/.test(x)));

  const noStep = incompleteRunAlert('maintenance', { startedAt: 'x', ageHours: 1 });
  t('a missing step is omitted, not printed as null', !noStep.includes('null'));
  t('the unit defaults from the job name', noStep.includes('swing-maintenance'));
}

fs.rmSync(stateDir, { recursive: true, force: true });

console.log(`\n=============================================`);
console.log(`PASS ${pass} · FAIL ${fail}`);
console.log(`=============================================`);
if (fail) process.exit(1);
