// =============================================================================
// Deploy-output rendering, and the Telegram primitives every formatter shares.
//
// deploy.sh writes for a terminal; a chat is not a terminal. These pin the
// translation — and, more importantly, the safety rules that apply to EVERY
// message: Telegram rejects a whole message on bad markup or excess length, so
// a formatting slip does not garble output, it deletes it.
//
// Run with:  node tests/format-deploy.mjs
// =============================================================================

import { formatDeployMessage, parseDeployOutput } from '../scripts/lib/format-deploy.mjs';
import { esc, stripAnsi, fit, pre, TG_LIMIT } from '../scripts/lib/tg.mjs';

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else      { fail++; console.error('  ✗', name); }
}

const SAMPLE = `
\x1b[1m1. Timing\x1b[0m
  \x1b[32m✓\x1b[0m outside the execution window (Sun 17:59 ET)

\x1b[1m2. Source\x1b[0m
  \x1b[32m✓\x1b[0m Updating 85fa42e..4b3c5fb
  \x1b[32m✓\x1b[0m HEAD 4b3c5fb Add validate

\x1b[1m4. Verification\x1b[0m
  \x1b[32m✓\x1b[0m all scripts parse
  \x1b[32m✓\x1b[0m test suite passed (529 assertions)

\x1b[1m5. Services\x1b[0m
  \x1b[33m!\x1b[0m swing-sameday.service is RUNNING right now — leaving it alone
  \x1b[32m✓\x1b[0m swing-bot restarted

\x1b[1mSummary\x1b[0m
  \x1b[32m✓\x1b[0m deployed 85fa42e → 4b3c5fb
`;

console.log('\n--- parsing terminal output ---');
{
  const secs = parseDeployOutput(SAMPLE);
  t('finds the sections', secs.map(s => s.title).join(',') === 'Timing,Source,Verification,Services,Summary');
  t('strips the section numbers', secs[0].title === 'Timing');
  t('collects items', secs[1].items.length === 2);
  t('reads the mark', secs[3].items[0].level === '!' && secs[3].items[1].level === '✓');
  t('drops ANSI colour', !JSON.stringify(secs).includes('\x1b'));
  t('empty input does not throw', parseDeployOutput('').length === 0);
  t('null does not throw', parseDeployOutput(null).length === 0);
}

console.log('\n--- the verdict line ---');
{
  const okMsg = formatDeployMessage(SAMPLE, { label: 'Swing' });
  t('a real deploy says deployed', okMsg.startsWith('🚀'));
  t('names the system', okMsg.includes('Swing'));
  t('surfaces the commit range', okMsg.includes('85fa42e → 4b3c5fb'));
  t('surfaces the test result', okMsg.includes('529 assertions'));
  t('keeps the warning visible', okMsg.includes('RUNNING right now'));

  const noop = formatDeployMessage(`
1. Source
  ✓ already up to date — nothing to restart (use --force to bounce anyway)
`, { label: 'Swing' });
  t('a no-op deploy says so', noop.startsWith('✅') && /already up to date/.test(noop));

  const check = formatDeployMessage(SAMPLE, { label: 'Swing', check: true });
  t('a check says nothing was changed', check.startsWith('🔎') && /nothing was changed/.test(check));

  const failed = formatDeployMessage(`
4. Verification
  ✗ TEST SUITE FAILED — not restarting; the previous code keeps running
`, { label: 'Swing', ok: false });
  t('a failure leads with the failure', failed.startsWith('❌'));
  t('and says the old code survives', /previous code is still running/.test(failed));
  t('the failing step is repeated up top',
    failed.indexOf('TEST SUITE FAILED') < failed.indexOf('Verification'));
}

console.log('\n--- unrecognised output degrades, never disappears ---');
{
  // deploy.sh will change. The formatter must not silently eat lines it does
  // not recognise — losing a deploy's output is worse than formatting it plainly.
  const odd = formatDeployMessage('some entirely unexpected line\nand another', { label: 'Swing' });
  t('unknown lines are kept', odd.includes('some entirely unexpected line') || odd.includes('and another'));
  t('no output produces a placeholder, not an empty message',
    formatDeployMessage('', { label: 'Swing' }).length > 0);
}

console.log('\n--- Telegram safety (applies to every formatter) ---');
{
  t('escapes angle brackets', esc('<b>x</b>') === '&lt;b&gt;x&lt;/b&gt;');
  t('escapes ampersands', esc('a & b') === 'a &amp; b');
  t('null escapes to empty', esc(null) === '');
  t('strips ANSI', stripAnsi('\x1b[32mgreen\x1b[0m') === 'green');

  const dangerous = formatDeployMessage('  ✗ error in <script>alert(1)</script> & co', { label: 'Swing', ok: false });
  t('markup from tool output is neutralised', !/<script>/.test(dangerous));
  t('and is still readable', dangerous.includes('&lt;script&gt;'));

  const long = 'x'.repeat(9000);
  t('fit() respects the limit', fit(long).length < TG_LIMIT);
  t('fit() marks the truncation', /truncated/.test(fit(long)));
  // Every surviving line must be one of the originals, unchanged — a cut in
  // the middle of a line is how markup gets severed mid-tag, which makes
  // Telegram reject the entire message.
  const originals = new Set(Array.from({ length: 2000 }, (_, n) => `line ${n}`));
  const cut = fit(Array.from({ length: 2000 }, (_, n) => `line ${n}`).join('\n'));
  const body = cut.split('\n').filter(l => !/truncated/.test(l));
  t('fit() cuts at a line boundary', body.every(l => originals.has(l)));
  t('fit() keeps the start of the content', body[0] === 'line 0');

  t('pre() wraps and escapes', pre('<x>') === '<pre>&lt;x&gt;</pre>');
  t('pre() of nothing is empty, not an empty block', pre('   ') === '');
  const bigPre = pre('y'.repeat(9000));
  t('pre() trims to its limit', bigPre.length < 3100);
  t('pre() keeps the END (where errors are)', pre('start' + 'z'.repeat(4000) + 'THEERROR').includes('THEERROR'));
}

console.log('\n--- every reply must be valid Telegram HTML ---');
{
  // Telegram parses the whole message and rejects it on an unknown tag or an
  // unbalanced one — the failure mode is a MISSING reply, not a malformed one,
  // which is why this is worth checking mechanically rather than by eye.
  const ALLOWED = new Set(['b', 'i', 'u', 's', 'a', 'code', 'pre']);
  const check = (name, html) => {
    const stack = [];
    let okTags = true, unknown = null;
    for (const m of html.matchAll(/<(\/?)([a-z]+)(\s[^>]*)?>/g)) {
      const [, closing, tag] = m;
      if (!ALLOWED.has(tag)) { unknown = tag; okTags = false; break; }
      if (closing) { if (stack.pop() !== tag) { okTags = false; break; } }
      else stack.push(tag);
    }
    t(`${name}: tags valid and balanced${unknown ? ` (saw <${unknown}>)` : ''}`, okTags && stack.length === 0);
    t(`${name}: within the Telegram limit`, html.length <= TG_LIMIT);
  };

  check('deploy ok', formatDeployMessage(SAMPLE, { label: 'Swing' }));
  check('deploy failed', formatDeployMessage(SAMPLE, { label: 'Swing', ok: false }));
  check('deploy check', formatDeployMessage(SAMPLE, { label: 'Swing', check: true }));
  check('deploy empty', formatDeployMessage('', { label: 'Swing' }));
  // A label carrying markup must not be able to break out of its own tag.
  check('hostile label', formatDeployMessage(SAMPLE, { label: '<script>x</script>' }));
  check('hostile output', formatDeployMessage('  ✗ <img src=x onerror=1> & "q"', { label: 'S', ok: false }));
}

console.log(`\n=============================================`);
console.log(`PASS ${pass} · FAIL ${fail}`);
console.log(`=============================================`);
if (fail) process.exit(1);
