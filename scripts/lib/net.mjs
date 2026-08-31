// =============================================================================
// What actually went wrong with that fetch?
//
// Node's fetch throws `TypeError: fetch failed` for EVERY network-layer failure
// — DNS, refused, reset, timed out, TLS — and puts the real reason in `.cause`,
// sometimes nested two deep. Logging `e.message` therefore produces a line that
// is identical for a expired certificate, a dead DNS resolver and a firewall
// change, which is how a bot spent an afternoon printing "poll error fetch
// failed" without ever saying what to fix.
//
// This unwraps the chain to the error code and turns it into a sentence naming
// the thing to check.
// =============================================================================

const HINTS = {
  ENOTFOUND:               'DNS lookup failed — the resolver could not find the host',
  EAI_AGAIN:               'DNS is temporarily unreachable — usually the resolver, not the host',
  ECONNREFUSED:            'the host answered and refused the connection',
  ECONNRESET:              'the connection was established then dropped mid-request',
  EPIPE:                   'the connection was closed while writing the request',
  EHOSTUNREACH:            'no route to the host — check egress rules',
  ENETUNREACH:             'the network itself is unreachable',
  ETIMEDOUT:               'the connection timed out — egress firewall or a black hole',
  EPROTO:                  'TLS handshake failed',
  UND_ERR_CONNECT_TIMEOUT: 'could not open a socket in time — egress firewall or packet loss',
  UND_ERR_HEADERS_TIMEOUT: 'the socket opened but no response headers arrived',
  UND_ERR_BODY_TIMEOUT:    'the response stalled part-way through the body',
  UND_ERR_SOCKET:          'the socket closed unexpectedly',
  CERT_HAS_EXPIRED:        'the server certificate has expired',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the certificate chain could not be verified',
  ABORT_ERR:               'we gave up first — our own timeout fired',
};

// Walk `.cause` to the innermost error. undici nests: TypeError('fetch failed')
// → Error('...') → the real system error carrying `.code`. Bounded, because a
// self-referential cause chain would hang the logger — and a logger that hangs
// takes the process with it.
export function rootCause(e) {
  let cur = e, best = e;
  for (let i = 0; cur && i < 8; i++) {
    if (cur.code || cur.errno) best = cur;
    if (cur.cause === cur) break;
    cur = cur.cause;
  }
  return best;
}

// A one-line description safe to put in a log or a Telegram message.
export function describeFetchError(e) {
  if (!e) return { code: 'UNKNOWN', text: 'unknown error' };
  const root = rootCause(e);
  // AbortError arrives with name, not code — an AbortSignal.timeout() firing is
  // the single most likely "failure" here and deserves its own label, because
  // "we gave up" and "they never answered" call for different responses.
  const code = String(root.code || root.errno
    || (root.name === 'TimeoutError' || root.name === 'AbortError' ? 'ABORT_ERR' : '')
    || '').toUpperCase();
  const hint = HINTS[code];
  const raw = String(root.message || e.message || e);
  if (code && hint) return { code, text: `${code}: ${hint}` };
  if (code) return { code, text: `${code}: ${raw}` };
  // No code anywhere. Fall back to the message, but never to the bare
  // "fetch failed" that started all this — say so explicitly instead.
  return { code: 'UNKNOWN', text: raw === 'fetch failed' ? 'network failure with no error code reported' : raw };
}

// Retry pacing. A fixed 5s retry through a three-hour outage is 2,000 identical
// log lines and 2,000 pointless connections; backing off to a minute is 180.
export function backoffMs(consecutiveFailures, { base = 5000, max = 60000 } = {}) {
  const n = Math.max(1, consecutiveFailures);
  return Math.min(max, base * Math.pow(2, n - 1));
}

// Should this failure be logged, or is it the same thing we said a moment ago?
// The point is to keep the FIRST occurrence, every change of cause, and a
// periodic heartbeat — while dropping the hundreds of duplicates in between that
// bury everything else in the log.
export function shouldLogFailure(consecutiveFailures, code, previousCode) {
  if (consecutiveFailures === 1) return true;
  if (code !== previousCode) return true;
  return consecutiveFailures % 10 === 0;
}
