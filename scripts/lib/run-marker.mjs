// =============================================================================
// Did the last run actually FINISH?
//
// The entry runner was OOM-killed mid-scan every session for eighteen days and
// nobody found out. SIGKILL leaves no exception, no log line and no exit
// handler — so every mechanism that reports failures reported nothing, and an
// absence of messages is indistinguishable from a quiet market.
//
// The fix is to record intent separately from outcome. A run writes a marker
// when it starts and deletes it when it finishes. A marker still on disk when
// the next run begins means the previous one died where no error handler could
// speak for it.
//
// Deliberately file-based: it must keep working when Firestore is the thing
// that broke, and it must survive the process being killed outright, which
// rules out anything held in memory or flushed on exit.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = () => process.env.SWING_RUN_STATE_DIR || path.join(REPO_ROOT, 'logs');
const markerFor = (job) => path.join(dir(), `.${job}.running`);

// Call at the start of a run. Returns the PREVIOUS run's marker if it never
// completed, so the caller can alert — the previous run's own code cannot.
export function beginRun(job, { now = new Date() } = {}) {
  const file = markerFor(job);
  let previous = null;
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      previous = {
        startedAt: raw.startedAt,
        pid: raw.pid,
        ageHours: (now.getTime() - Date.parse(raw.startedAt)) / 3600_000,
        lastStep: raw.lastStep || null,
      };
    }
  } catch { /* unreadable marker tells us nothing; carry on */ }

  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ startedAt: now.toISOString(), pid: process.pid }));
  } catch { /* cannot record intent — not worth failing the run over */ }

  return previous;
}

// Progress breadcrumb, so an incomplete run can say WHERE it died. A scan that
// dies at the same point every day is a very different problem from one that
// dies at random, and without this the marker cannot tell them apart.
export function markStep(job, step) {
  const file = markerFor(job);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.lastStep = step;
    fs.writeFileSync(file, JSON.stringify(raw));
  } catch { /* best effort */ }
}

// Call on normal completion — including a deliberate early return such as
// "outside the trading window". Those ARE successful outcomes; leaving a marker
// behind for them would cry wolf every weekend.
export function endRun(job) {
  try { fs.unlinkSync(markerFor(job)); } catch { /* already gone */ }
}

export function incompleteRunAlert(job, previous, { unit = `swing-${job}` } = {}) {
  const where = previous.lastStep ? `\n<i>last step: ${previous.lastStep}</i>` : '';
  return [
    `🔴 <b>${job} did not finish</b>`,
    `<i>started ${previous.startedAt}, ${previous.ageHours.toFixed(1)}h ago</i>${where}`,
    '',
    'It was killed without an error — the usual cause is the out-of-memory',
    'killer, which leaves nothing in the log because SIGKILL cannot be caught.',
    '',
    `Confirm with:  <code>journalctl -u ${unit} -n 50</code>`,
    'or:            <code>dmesg -T | grep -i "killed process"</code>',
  ].join('\n');
}
