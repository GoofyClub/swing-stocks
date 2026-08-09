// =============================================================================
// Telegram rendering of a validation result.
//
// The point of this format is that a problem is the FIRST thing read, on a
// phone, usually while something is wrong. So these tests check emphasis and
// safety, not prettiness: problems surface, their explanations travel with
// them, nothing is silently dropped, and the output can never be rejected by
// Telegram for bad markup or length.
//
// Run with:  node tests/format-validation.mjs
// =============================================================================

import { formatValidationMessage } from '../scripts/lib/format-validation.mjs';
import { dashboardUrl, resetDashboardHostCache } from '../scripts/lib/dashboard-url.mjs';

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else      { fail++; console.error('  ✗', name); }
}

const res = (sections, extra = {}) => ({
  sections, fails: 0, warns: 0, etDate: '2026-08-09', etTime: '18:16', ...extra,
});

console.log('\n--- verdict line ---');
{
  const green = formatValidationMessage(res([{ title: 'Code', items: [{ level: 'ok', message: 'fine' }] }]));
  t('all-clear is green', green.startsWith('🟢'));

  const amber = formatValidationMessage(res(
    [{ title: 'Code', items: [{ level: 'warn', message: 'meh' }] }], { warns: 1 }));
  t('warnings only are amber', amber.startsWith('🟡'));
  t('and are counted', /1 warning\b/.test(amber));

  const red = formatValidationMessage(res(
    [{ title: 'Code', items: [{ level: 'bad', message: 'broken' }] }], { fails: 1 }));
  t('a problem is red', red.startsWith('🔴'));
  t('pluralises correctly', /1 problem\b/.test(red) && !/1 problems/.test(red));

  const many = formatValidationMessage(res(
    [{ title: 'Code', items: [{ level: 'bad', message: 'a' }, { level: 'bad', message: 'b' }] }],
    { fails: 2, warns: 3 }));
  t('plural for several', /2 problems/.test(many) && /3 warnings/.test(many));
}

console.log('\n--- problems come first, with their explanation ---');
{
  const out = formatValidationMessage(res([
    { title: 'Environment', items: [{ level: 'ok', message: 'node fine' }] },
    { title: 'Accounts', items: [
      { level: 'ok', message: 'paper · equity $5081' },
      { level: 'bad', message: '1 broker position(s) are not in the journal: XOM' },
      { level: 'info', message: 'XOM: journal says partially_filled. These have NO managed exit.' },
      { level: 'warn', message: 'DRY_RUN=true while holding 4 position(s)' },
    ] },
  ], { fails: 1, warns: 1 }));

  t('the problem appears', out.includes('not in the journal: XOM'));
  // The detail is the half that says what to do — losing it would leave the
  // finding unactionable.
  t('its explanation travels with it', out.includes('NO managed exit'));
  t('problems are placed above warnings',
    out.indexOf('not in the journal') < out.indexOf('DRY_RUN=true'));
  t('the section is named', /Accounts/.test(out));
  // Every check is listed, not just the failures — an all-green report that
  // shows nothing is indistinguishable from a check that never ran.
  t('passing checks are shown too', out.includes('node fine'));
  t('healthy sections still appear', out.includes('Environment'));
  t('the problem is restated at the top, above the sections',
    out.indexOf('not in the journal') < out.indexOf('<b>Environment</b>'));
}

console.log('\n--- key facts are visible ---');
{
  const out = formatValidationMessage(res([
    { title: 'Accounts', items: [
      { level: 'ok', message: 'paper · equity $5081 · buying power $15040 · 4 position(s)' },
      { level: 'ok', message: '52 realized trade(s) · 54% win · net $91' },
      { level: 'ok', message: 'equity snapshot current (2026-08-09, peak $5130, dd 1.0%)' },
    ] },
  ]));
  t('equity is shown', out.includes('equity $5081'));
  t('realized performance is shown', out.includes('54% win'));
  t('the drawdown ratchet is shown', out.includes('equity snapshot current'));
  // Not twice: with the full section visible, a footer repeating it is noise.
  t('and not duplicated in a footer', out.split('54% win').length === 2);
}

console.log('\n--- section headings carry an icon and their own verdict ---');
{
  const out = formatValidationMessage(res([
    { title: 'Environment', items: [{ level: 'ok', message: 'fine' }] },
    { title: 'Firestore', items: [{ level: 'bad', message: 'broken' }] },
    { title: 'Account NPRKnT…', items: [{ level: 'warn', message: 'iffy' }] },
    { title: 'Code', items: [{ level: 'ok', message: 'green' }] },
  ], { fails: 1, warns: 1 }));

  // The heading states the section's status, so you do not have to scan its
  // lines to find out whether anything in it went wrong.
  t('a healthy section is green', /🟢 ⚙️ <b>Environment<\/b>/.test(out));
  t('a failing section is red', /🔴 🗄 <b>Firestore<\/b>/.test(out));
  t('a warning section is amber', /🟡 👤 <b>Account NPRKnT…<\/b>/.test(out));
  t('code has its own icon', /🧩 <b>Code<\/b>/.test(out));
  // "Accounts" (the list) and "Account X" (one account) must not collide.
  const both = formatValidationMessage(res([
    { title: 'Accounts', items: [{ level: 'ok', message: 'one enabled' }] },
    { title: 'Account ABC…', items: [{ level: 'ok', message: 'paper' }] },
  ]));
  t('the account list and a single account differ',
    /💼 <b>Accounts<\/b>/.test(both) && /👤 <b>Account ABC…<\/b>/.test(both));
  // An unknown section must still render, with a neutral marker.
  t('an unknown section still gets a heading',
    /• <b>Brand New<\/b>/.test(formatValidationMessage(res([
      { title: 'Brand New', items: [{ level: 'ok', message: 'x' }] }]))));
}

console.log('\n--- Telegram safety ---');
{
  // Telegram accepts only a small HTML subset and rejects the whole message on
  // bad markup, so raw angle brackets from a log line must be escaped.
  const out = formatValidationMessage(res([
    { title: 'Code', items: [{ level: 'bad', message: 'unexpected <script> & "quotes" in output' }] },
  ], { fails: 1 }));
  t('angle brackets are escaped', out.includes('&lt;script&gt;'));
  t('ampersands are escaped', out.includes('&amp;'));
  t('no raw tag survives', !/<script>/.test(out));
}
{
  // A message over the limit is rejected outright — so a long report must be
  // truncated to a LINE boundary rather than mid-tag.
  const items = Array.from({ length: 400 }, (_, i) => ({ level: 'bad', message: `problem number ${i} with a reasonably long description attached` }));
  const out = formatValidationMessage(res([{ title: 'Code', items }], { fails: 400 }));
  t('stays under the Telegram limit', out.length <= 4096);
  t('says it was truncated', /truncated/.test(out));
  const tags = (out.match(/<b>/g) || []).length - (out.match(/<\/b>/g) || []).length;
  t('bold tags stay balanced after truncation', tags === 0);

  // Degradation order matters: passing lines are compressed BEFORE anything is
  // cut, so a long report loses "12 checks passed" rather than a failure.
  const manyOk = Array.from({ length: 300 }, (_, i) => ({ level: 'ok', message: `check ${i} passed with a fairly wordy description of what it verified` }));
  const mixed = formatValidationMessage(res([
    { title: 'Bulk', items: manyOk },
    { title: 'Accounts', items: [{ level: 'bad', message: 'THE CRITICAL FAILURE' }] },
  ], { fails: 1 }));
  t('a long report compresses passing lines', /checks passed/.test(mixed));
  t('and keeps the failure', mixed.includes('THE CRITICAL FAILURE'));
  t('still within the limit', mixed.length <= 4096);
}

console.log('\n--- degenerate input ---');
{
  t('null does not throw', typeof formatValidationMessage(null) === 'string');
  t('missing sections does not throw', typeof formatValidationMessage({}) === 'string');
  t('empty sections renders a verdict', formatValidationMessage(res([])).startsWith('🟢'));
}

console.log('\n--- dashboard URL is derived, never stale ---');
{
  const url = (env) => dashboardUrl({ env, fetchImpl: async () => ({ ok: true, text: async () => '34.23.154.110' }) });
  // Scheme follows the cert, so switching TLS on cannot leave a dead http link.
  t('http without a cert', await url({ DASHBOARD_BIND: '0.0.0.0', DASHBOARD_PORT: '8444' })
    === 'http://34.23.154.110:8444');
  t('https once a cert is configured', await url({
    DASHBOARD_BIND: '0.0.0.0', DASHBOARD_PORT: '8444',
    DASHBOARD_CERT_FILE: '/c.pem', DASHBOARD_KEY_FILE: '/k.pem',
  }) === 'https://34.23.154.110:8444');
  t('a cert without its key is not treated as TLS', await url({
    DASHBOARD_BIND: '0.0.0.0', DASHBOARD_CERT_FILE: '/c.pem',
  }) === 'http://34.23.154.110:8444');
  t('the port is honoured', await url({ DASHBOARD_BIND: '0.0.0.0', DASHBOARD_PORT: '9999' })
    === 'http://34.23.154.110:9999');

  // Loopback has no URL that works from anywhere else — offering one would lie.
  resetDashboardHostCache();
  t('loopback yields no link', await url({ DASHBOARD_BIND: '127.0.0.1' }) === null);
  resetDashboardHostCache();
  t('an explicit bind address is used directly',
    await url({ DASHBOARD_BIND: '10.0.0.5', DASHBOARD_PORT: '8444' }) === 'http://10.0.0.5:8444');
  resetDashboardHostCache();
  t('DASHBOARD_URL overrides everything',
    await url({ DASHBOARD_URL: 'https://swing.example.com', DASHBOARD_BIND: '127.0.0.1' })
      === 'https://swing.example.com');

  // Off GCE the metadata server is unreachable; that must yield no link rather
  // than a broken one or an exception.
  resetDashboardHostCache();
  const noMeta = await dashboardUrl({
    env: { DASHBOARD_BIND: '0.0.0.0' },
    fetchImpl: async () => { throw new Error('ENOTFOUND'); },
  });
  t('no metadata server yields null, not a throw', noMeta === null);
}

console.log(`\n=============================================`);
console.log(`PASS ${pass} · FAIL ${fail}`);
console.log(`=============================================`);
if (fail) process.exit(1);
