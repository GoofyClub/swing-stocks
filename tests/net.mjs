// =============================================================================
// Diagnosing a failed fetch.
//
// The bug these pin: the bot logged `poll error fetch failed` hundreds of times
// and that string is IDENTICAL for DNS failure, connection reset, egress
// firewall, expired certificate and our own timeout. Node's fetch throws
// `TypeError: fetch failed` for all of them and buries the real code in
// `.cause`, so the log could not distinguish a problem you fix in five seconds
// from one you cannot fix at all.
//
// Run with:  node tests/net.mjs
// =============================================================================

import { describeFetchError, rootCause, backoffMs, shouldLogFailure } from '../scripts/lib/net.mjs';

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else      { fail++; console.error('  ✗', name); }
}

// How undici actually shapes it: a bare TypeError wrapping the system error.
const fetchFailed = (cause) => Object.assign(new TypeError('fetch failed'), { cause });
const sysErr = (code, message) => Object.assign(new Error(message || code), { code });

console.log('\n--- the cause is found, not the wrapper ---');
{
  const e = fetchFailed(sysErr('ENOTFOUND', 'getaddrinfo ENOTFOUND api.telegram.org'));
  const d = describeFetchError(e);
  t('the real code is extracted', d.code === 'ENOTFOUND');
  t('the description names DNS', /DNS/i.test(d.text));
  t('the useless wrapper text is gone', !d.text.includes('fetch failed'));

  // undici nests two deep for connect failures.
  const nested = fetchFailed(Object.assign(new Error('connect failure'), {
    cause: sysErr('UND_ERR_CONNECT_TIMEOUT'),
  }));
  t('a two-deep cause chain is unwrapped', describeFetchError(nested).code === 'UND_ERR_CONNECT_TIMEOUT');

  t('rootCause prefers the error carrying a code', rootCause(nested).code === 'UND_ERR_CONNECT_TIMEOUT');
}

console.log('\n--- the failures are told apart ---');
{
  const codes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'CERT_HAS_EXPIRED', 'UND_ERR_HEADERS_TIMEOUT'];
  const texts = codes.map(c => describeFetchError(fetchFailed(sysErr(c))).text);
  t('every code produces a distinct message', new Set(texts).size === codes.length);
  t('each message names its code', texts.every((x, i) => x.startsWith(codes[i] + ':')));
}

console.log('\n--- our own timeout is not their outage ---');
{
  // AbortSignal.timeout() rejects with a DOMException named TimeoutError, which
  // carries no `code`. Reporting that as an unknown network fault would send you
  // hunting a problem at the far end that is actually a limit set at this one.
  const abort = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
  const d = describeFetchError(abort);
  t('a timeout abort is identified', d.code === 'ABORT_ERR');
  t('it says the timeout was ours', /we gave up/i.test(d.text));
}

console.log('\n--- nothing throws, whatever it is handed ---');
{
  const cases = [null, undefined, 'a string', 42, {}, new Error(''), fetchFailed(undefined)];
  let threw = false;
  let results = [];
  for (const c of cases) {
    try { results.push(describeFetchError(c)); } catch { threw = true; }
  }
  t('every shape is handled without throwing', threw === false);
  t('each returns a code and text', results.every(r => r && r.code && typeof r.text === 'string'));

  // A cause chain that points at itself must terminate. A logger that hangs
  // takes the process with it, which is a worse outcome than a vague message.
  const loop = new Error('loop');
  loop.cause = loop;
  let hung = true;
  try { describeFetchError(loop); hung = false; } catch { hung = false; }
  t('a self-referential cause chain terminates', hung === false);

  const bare = describeFetchError(fetchFailed(undefined));
  t('a codeless failure does not report "fetch failed"', !bare.text.includes('fetch failed'));
}

console.log('\n--- backoff ---');
{
  t('the first retry is quick', backoffMs(1) === 5000);
  t('it doubles', backoffMs(2) === 10000 && backoffMs(3) === 20000);
  t('it caps at a minute', backoffMs(20) === 60000);
  // Zero and negative must not produce a zero or negative sleep: a hot loop
  // against a dead endpoint is how a retry becomes an outage of its own.
  t('a zero count still waits', backoffMs(0) >= 5000);
  t('a negative count still waits', backoffMs(-3) >= 5000);
}

console.log('\n--- log volume ---');
{
  t('the first failure is always logged', shouldLogFailure(1, 'ECONNRESET', null));
  t('an identical repeat is suppressed', !shouldLogFailure(2, 'ECONNRESET', 'ECONNRESET'));
  t('a CHANGE of cause is always logged', shouldLogFailure(2, 'ENOTFOUND', 'ECONNRESET'));
  t('every tenth repeat gets a heartbeat', shouldLogFailure(10, 'ECONNRESET', 'ECONNRESET'));

  // The point of the exercise: an outage must not fill the log. Over 200
  // consecutive identical failures, the old code wrote 200 lines.
  let lines = 0;
  for (let i = 1; i <= 200; i++) if (shouldLogFailure(i, 'ECONNRESET', i === 1 ? null : 'ECONNRESET')) lines++;
  t('200 identical failures produce ~20 lines, not 200', lines > 5 && lines < 30);
}

console.log(`\n=============================================`);
console.log(`PASS ${pass} · FAIL ${fail}`);
console.log(`=============================================`);
if (fail) process.exit(1);
