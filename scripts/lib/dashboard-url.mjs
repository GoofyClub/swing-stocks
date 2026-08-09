// =============================================================================
// The URL the log dashboard is actually reachable at.
//
// Derived, not configured: the scheme follows whether a TLS cert is set, the
// host comes from the GCE metadata server, and the port from DASHBOARD_PORT.
// Asking someone to keep a URL in sync with three other settings is how a link
// ends up pointing at http:// after TLS was switched on — a link that silently
// stops working is worse than no link.
//
// Returns null when the dashboard is loopback-bound, because there is then no
// URL that works from anywhere else, and offering one would be a lie.
// =============================================================================

const META = 'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip';

let cachedHost;   // the external IP does not change while the VM is up

async function externalHost(fetchImpl = globalThis.fetch) {
  if (cachedHost !== undefined) return cachedHost;
  try {
    const ctl = AbortSignal.timeout ? { signal: AbortSignal.timeout(2000) } : {};
    const res = await fetchImpl(META, { headers: { 'Metadata-Flavor': 'Google' }, ...ctl });
    cachedHost = res.ok ? (await res.text()).trim() || null : null;
  } catch { cachedHost = null; }   // not a GCE VM, or metadata unreachable
  return cachedHost;
}

export async function dashboardUrl({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (env.DASHBOARD_URL) return env.DASHBOARD_URL;          // explicit override wins

  const bind = env.DASHBOARD_BIND || '0.0.0.0';
  if (bind === '127.0.0.1' || bind === 'localhost') return null;   // tunnel-only

  const port = Number(env.DASHBOARD_PORT || 8444);
  const scheme = (env.DASHBOARD_CERT_FILE && env.DASHBOARD_KEY_FILE) ? 'https' : 'http';

  // A specific bind address is itself the answer; 0.0.0.0 means "every
  // interface", which is not something you can put in a URL.
  const host = (bind !== '0.0.0.0' && bind !== '::') ? bind : await externalHost(fetchImpl);
  if (!host) return null;

  return `${scheme}://${host}:${port}`;
}

// For tests, and for a process that outlives an IP change.
export function resetDashboardHostCache() { cachedHost = undefined; }
