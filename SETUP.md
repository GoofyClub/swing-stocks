# Swing Terminal — Setup Guide

End-to-end checklist to get the app deployed at
`https://goofyclub.github.io/swing-stocks/` with working Google auth, Firestore
persistence, and the scheduled signal refresher.

> **Repo conventions**
> - Live URL: `https://goofyclub.github.io/swing-stocks/`
> - Default branch: `main` (deploys on push)
> - Built output: `dist/` (uploaded as GitHub Pages artifact; never committed)
> - Legacy console preserved at `legacy/swing_terminal_4-1.html` and served at
>   `/swing-stocks/legacy/swing_terminal_4-1.html`.

---

## 1 · Local dev

```bash
git clone https://github.com/GoofyClub/swing-stocks.git
cd swing-stocks
npm install

# Run the engine parity check (32 assertions, ~1s).
npm run test:engine

# Copy env template and fill in Firebase web config.
cp .env.example .env.local
$EDITOR .env.local

# Vite dev server (no Pages base path) — http://localhost:5173
npm run dev
```

`npm run dev` proxies your Firebase config from `.env.local`. The dev server
does **not** apply the `/swing-stocks/` base path; the prod build does.

---

## 2 · Create the Firebase project

1. Go to <https://console.firebase.google.com/> → **Add project**.
   Project name: e.g. `swing-stocks-prod`. You can disable Google Analytics.
2. In the project, click the `</>` (web) icon to register a web app.
   App nickname: `swing-stocks-web`. You don't need Hosting.
3. Firebase Console returns a `firebaseConfig` object. Copy each value into
   `.env.local` (for dev) **and** into your repo's GitHub Secrets
   (`Settings → Secrets and variables → Actions → New repository secret`):

   | Secret name (GitHub)                | `.env.local` key                    |
   |-------------------------------------|--------------------------------------|
   | `VITE_FIREBASE_API_KEY`             | `VITE_FIREBASE_API_KEY`              |
   | `VITE_FIREBASE_AUTH_DOMAIN`         | `VITE_FIREBASE_AUTH_DOMAIN`          |
   | `VITE_FIREBASE_PROJECT_ID`          | `VITE_FIREBASE_PROJECT_ID`           |
   | `VITE_FIREBASE_STORAGE_BUCKET`      | `VITE_FIREBASE_STORAGE_BUCKET`       |
   | `VITE_FIREBASE_MESSAGING_SENDER_ID` | `VITE_FIREBASE_MESSAGING_SENDER_ID`  |
   | `VITE_FIREBASE_APP_ID`              | `VITE_FIREBASE_APP_ID`               |

   These values are public by design — security is enforced by
   `firestore.rules`, not by hiding the keys.

---

## 3 · Enable Google sign-in

1. Firebase Console → **Authentication → Sign-in method**.
2. Enable **Google**. Project public-facing name: `Swing Terminal`.
   Support email: your own.
3. Click **Save**.
4. Authentication → **Settings → Authorized domains**. Add:
   - `goofyclub.github.io` (the production host)
   - `localhost` (already added by default, for dev)
5. Authentication → **Settings → User actions**: leave defaults; on first
   login the app calls `ensureUserDoc()` which creates `/users/{uid}` with
   default prefs.

The Google OAuth client created automatically by Firebase already has the
correct redirect URI:
`https://<your-firebase-project>.firebaseapp.com/__/auth/handler`

You do **not** need to add a GitHub Pages redirect URI manually — Firebase
proxies the OAuth handshake through that `firebaseapp.com` URL, which is
why the GitHub Pages subpath works without further OAuth configuration.

---

## 4 · Deploy Firestore rules + indexes

```bash
# One-time tooling install
npm install -g firebase-tools
firebase login
```

Create `firebase.json` at the repo root (one time, optional — many people commit this):

```json
{
  "firestore": {
    "rules":   "firestore.rules",
    "indexes": "firestore.indexes.json"
  }
}
```

Then:

```bash
firebase use --add   # pick your project; alias it as `default`

# Deploy rules + indexes
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```

Rules live in `firestore.rules`; composite + collection-group indexes in `firestore.indexes.json`.

> **⚠ Both files must be deployed — they fix different errors.**
>
> | If you see this error… | …deploy this |
> |---|---|
> | `Missing or insufficient permissions` (e.g. on Signal History) | `firebase deploy --only firestore:rules` |
> | `FAILED_PRECONDITION: The query requires an index` (cron log or History view) | `firebase deploy --only firestore:indexes` |
>
> The cron worker uses collection-group queries to resettle open signals and trades; the History view uses them to list signals across days. Both require:
> 1. **A wildcard rule** (`match /{path=**}/signals/{id}` in `firestore.rules`) — without this, clients get `permission-denied` even with the path-specific rule.
> 2. **Collection-group composite indexes** (in `firestore.indexes.json`) — without these, the queries throw `FAILED_PRECONDITION`.
>
> Indexes build asynchronously — 1–5 minutes after deploy. Rules are instant.
>
> **Re-deploy both whenever you edit `firestore.rules` or `firestore.indexes.json`.**

---

## 5 · Create a service account for the cron worker

The GitHub Actions cron uses the Firebase Admin SDK (which bypasses Firestore
rules) to write the shared signal collection. It needs a service account key.

1. Firebase Console → ⚙ Project settings → **Service accounts**.
2. Click **Generate new private key** → confirm. A JSON file downloads.
3. Open the file in a text editor and copy the entire JSON content.
4. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - Name: `FIREBASE_SERVICE_ACCOUNT_JSON`
   - Value: paste the full JSON
5. Add `FIREBASE_PROJECT_ID` (the same value as `VITE_FIREBASE_PROJECT_ID`).

### Data-source API keys (all optional, all stored as GitHub Secrets)

The cron worker fetches OHLCV bars from a priority list of sources. Higher-priority
sources need keys; the lower-priority ones (Yahoo Finance, Stooq + 3 CORS proxies)
are free and keyless. **Without any keys**, the cron still works — it just falls
through to the free sources first.

| Secret name        | What it unlocks                                          | Where to get it                                                            | Cost            |
|--------------------|----------------------------------------------------------|----------------------------------------------------------------------------|-----------------|
| `ALPHAVANTAGE_KEY` | Top-priority CSV source. Best when you have it.          | <https://www.alphavantage.co/support/#api-key>                              | Free (25/day)   |
| `FINNHUB_KEY`      | JSON daily candles. Wider symbol coverage.               | <https://finnhub.io/register>                                              | Free (60/min)   |
| `FMP_KEY`          | Enables **PEAD / Insider Cluster / Analyst Upgrade** strategies. Without it, these are skipped silently. | <https://financialmodelingprep.com>                  | ~$19/mo         |

To add a key:
1. Get the key from the provider (sign up — free tiers don't require a credit card).
2. Repo → **Settings → Secrets and variables → Actions → New repository secret**.
3. Name = the column above (e.g. `ALPHAVANTAGE_KEY`), value = your key.
4. Re-run **Actions → Refresh shared signals → Run workflow** to use it immediately.

### Can I run PEAD / Insider / Analyst without paying for FMP?

Short answer: **no good free alternative right now.** The free FMP tier doesn't expose
the `/earnings-surprises`, `/insider-trading`, or `/upgrades-downgrades` endpoints —
those are paid only. Free alternatives:

- **Yahoo Finance scraping** — fragile (frequent breakage) and rate-limited.
- **Alpha Vantage `EARNINGS`** — free 25/day, but doesn't give actual-vs-estimate surprise %.
- **Skip these strategies and rely on PEG** — the **Power Earnings Gap (PEG)** strategy is a pure-price proxy for PEAD (gap-up ≥4% on 2× volume held for 3+ days). It captures most of the same edge using only OHLCV data. PEG is free.

The cron silently skips FMP-gated strategies when no key is set, so removing the key just hides those three from results — everything else keeps working.

---

## 6 · Configure GitHub Pages

1. Repo → **Settings → Pages**.
2. **Build and deployment** → Source: **GitHub Actions** (not "Branch").
3. Push to `main` (or trigger `Deploy to GitHub Pages` manually under Actions).
   The first run uploads `dist/` and serves it at:
   `https://goofyclub.github.io/swing-stocks/`

The `404.html` SPA fallback (see `public/404.html`) ensures direct links to
e.g. `/swing-stocks/#/history` resolve correctly.

---

## 7 · Schedule the cron

The schedule is defined in `.github/workflows/refresh-signals.yml`:

- Every 30 minutes during US market hours (Mon–Fri 13:30–21:00 UTC)
- One end-of-US-day pass (21:00 UTC)
- One NSE end-of-day pass (11:00 UTC ≈ 16:30 IST)

Once the service-account secret is in place, the next scheduled run will:
1. Fetch SPY / NIFTY + sector ETFs + every watchlist ticker.
2. Run every strategy on each ticker.
3. Write detected signals to `/marketData/{YYYY-MM-DD}/signals/{id}`.
4. Re-settle the last 90 days of open signals (mark WIN if TP touched, LOSS
   if SL touched, else still open).
5. Delete `/marketData/{date}` buckets older than 90 days.

You can trigger an immediate run from **Actions → Refresh shared signals → Run workflow**.

---

## 7b · Push notifications (optional)

When a tracked trade hits its TP or SL, the cron worker sends a browser push
via Firebase Cloud Messaging. To enable:

1. Firebase Console → ⚙ **Project settings → Cloud Messaging** tab.
2. Under **Web configuration → Web Push certificates**, click **Generate key pair**.
   A long base64 string appears.
3. Repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - Name: `VITE_FIREBASE_VAPID_KEY`
   - Value: the public VAPID key from step 2
4. Also add it to your local `.env.local` for dev.
5. Push to `main` (or re-run **Deploy to GitHub Pages**). After the redeploy:
   - Open Settings on the deployed app
   - Click **ENABLE NOTIFICATIONS**
   - Grant the browser prompt
6. When the next cron run settles one of your open trades, you'll get a push.

The Admin SDK in the cron worker uses the same service account you set up in
§5 — no extra credentials needed.

If you skip this step, push notifications stay off and Settings shows the
button as **Unavailable**. Everything else still works.

---

## 8 · Verify

After the first deploy + first cron run, you should see:

- The app loads at `https://goofyclub.github.io/swing-stocks/`
- "Sign in with Google" works (popup or redirect, browser-dependent)
- Dashboard tiles show non-zero buy/sell counts + regime banner + sector ranks
- Live Signals → RUN SCAN walks the watchlist and shows hits in real time
- Signal History lists rows · ★ stars trades into /users/{uid}/enteredTrades
- My Trades shows enriched live data from the source signals
- Watchlist → IMPORT STARTER LIST populates your private cloud list
- Settings → ENABLE NOTIFICATIONS subscribes this browser to push (if VAPID is set)
- Firestore Console → Data → `/marketData/YYYY-MM-DD/signals/...` has docs
- Firestore Console → Data → `/users/{uid}/fcmTokens/...` has at least one entry after enabling pushes

If anything is empty:
1. Check **Actions → Refresh shared signals** for the most recent run log.
2. Check Firestore **Rules** tab — the deployed version should match `firestore.rules`.
3. Open browser DevTools → Console. The app prints `[firebase]` / `[boot]` /
   `[history]` warnings if a step failed.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Firebase not configured" on login | `VITE_FIREBASE_*` secrets not set in repo | Add secrets, re-run Deploy |
| Sign-in popup blocked | Browser pop-up policy | The app auto-falls back to redirect; wait a moment |
| Firestore "permission denied" on read | Rules not deployed | `firebase deploy --only firestore:rules` |
| Dashboard tiles all zero | Cron hasn't run yet | Trigger `Refresh shared signals` manually |
| Auth says "unauthorized domain" | Domain not whitelisted | Auth → Settings → Authorized domains → add `goofyclub.github.io` |
| Engine parity test fails | Someone edited `src/strategy/engine.js` | Revert the edit; the engine block is meant to stay verbatim |

---

## Cost / free-tier reality check

- **Firebase Spark plan** (free):
  - Firestore: 1 GB storage, 50 K reads/day, 20 K writes/day. 90 days of NIFTY 50 + US watchlist signals ≈ 30 K docs total ≈ comfortably free.
  - Auth: unlimited Google sign-ins.
- **GitHub Pages** (free): unlimited for public repos.
- **GitHub Actions** (free): 2 000 min/month for private repos, unlimited for public. Each cron run is < 2 min.

When you'd hit limits: ~500 concurrent users issuing Dashboard loads will exceed 50 K reads/day. Upgrade path → Firestore Blaze with a $0 budget alert. Or add a service-worker cache layer client-side.
