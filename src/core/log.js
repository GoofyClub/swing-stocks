// Tiny logger that mirrors to console and (if present) a #log element.
export function log(msg, cls = 'info') {
  const ts = new Date().toLocaleTimeString();
  const el = document.getElementById('log');
  if (el) {
    const line = document.createElement('span');
    line.className = cls;
    line.textContent = `[${ts}] ${msg}\n`;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }
  const method = cls === 'fail' ? 'error' : (cls === 'warn' ? 'warn' : 'log');
  console[method](`[swing] ${msg}`);
}
