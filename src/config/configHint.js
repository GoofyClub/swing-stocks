// =============================================================================
// Error text for a missing required setting.
//
// "FIREBASE_PROJECT_ID must be set." is true and useless: it doesn't say which
// file was read, or that a manual run and a systemd run source their environment
// differently. That ambiguity cost a real debugging session — the variable WAS
// set, in a file nothing had loaded.
//
// So the message names the file that was actually found (or every path searched
// when none was), and states the two things that are actually wrong when this
// fires.
// =============================================================================

export function configErrorHint(key) {
  // Resolved lazily and defensively: this runs on an error path, and a failure
  // to build a nicer message must never replace the real error with its own.
  let where = '';
  try {
    // Node-only; the browser bundle never hits this path.
    const mod = globalThis.__swingConfigSearch;
    if (typeof mod === 'function') where = mod();
  } catch { /* fall through to the generic text */ }

  return [
    `${key} must be set.`,
    where ? `  ${where}` : '',
    '',
    '  systemd supplies these via EnvironmentFile=; the scripts also read',
    '  swing-config/swing.env directly, so both paths should work. If this',
    '  fired, either the key is genuinely absent from that file, or the file',
    '  itself is somewhere neither looked.',
    '',
    '  Check which file is authoritative:  ./scripts/setup-vm.sh --check',
    `  Confirm the key is present:         grep -c '^${key}=' swing-config/swing.env`,
  ].filter(Boolean).join('\n');
}
