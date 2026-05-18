// Sign-in screen — shown when no user is authenticated.

import { signIn } from '../data/firebase.js';

export function renderLogin(root) {
  root.innerHTML = `
    <div class="login-screen">
      <main class="login-card" role="main" aria-labelledby="login-title">
        <div class="brand">SWING · TERMINAL</div>
        <h1 id="login-title">Multi-strategy swing scans, in your pocket.</h1>
        <p class="sub">
          Daily signals across NSE &amp; US markets. Track entered trades, sync across devices,
          and review a 3-month signal history with target-vs-stop win/loss attribution.
        </p>
        <button class="btn-google" id="btn-signin" type="button" aria-label="Sign in with Google">
          <span class="gicon" aria-hidden="true"></span>
          <span>Sign in with Google</span>
        </button>
        <div id="signin-err" hidden></div>
        <ul class="bullet-list">
          <li>Backed by Firestore — your trades are private to your account.</li>
          <li>Signals are computed once per refresh window and shared across all users.</li>
          <li>3-month rolling history. Multi-device sync.</li>
        </ul>
      </main>
    </div>
  `;
  const btn = document.getElementById('btn-signin');
  const err = document.getElementById('signin-err');
  btn.addEventListener('click', async () => {
    err.hidden = true;
    btn.disabled = true;
    btn.querySelector('span:last-child').textContent = 'Signing in…';
    try {
      await signIn();
      // onAuthStateChanged in main.js will re-render to the app shell.
    } catch (e) {
      console.error('[signin]', e);
      err.hidden = false;
      err.className = 'login-err';
      err.textContent = (e?.message || 'Sign-in failed.') +
        ' If the popup was blocked, the redirect should kick in — wait 2–3 seconds. ' +
        'If nothing happens, see SETUP.md → Firebase configuration.';
      btn.disabled = false;
      btn.querySelector('span:last-child').textContent = 'Sign in with Google';
    }
  });
}
