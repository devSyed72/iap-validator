# IAP Validator

Multi-game in-app purchase validation server for Android. One Cloud Run deployment serves every game in a single Google Play developer account via a per-game registry.

---

## Live deployment

| Thing | Value |
|---|---|
| GCP project | `zi-iap-validator` |
| Region | `us-central1` |
| Cloud Run service | `iap-validator` |
| Public URL | `https://iap-validator-700115340332.us-central1.run.app` |
| Source repo | `https://github.com/devSyed72/iap-validator` (auto-deploy from `main`) |
| Cloud Build trigger | Auto-created by Cloud Run "Connect repo" |
| Secret in Secret Manager | `google-play-credentials` (the Play Console SA JSON) |
| Cloud Run env var | `GOOGLE_PLAY_CREDENTIALS` (sourced from the secret above) |
| Play Console SA | `zi-iap-validator@zi-iap-validator.iam.gserviceaccount.com` (account-level access) |
| Runtime SA | `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com` (default), granted `roles/secretmanager.secretAccessor` on the secret |

Liveness check: `curl https://iap-validator-700115340332.us-central1.run.app/health` should return `{"status":"OK", ...}`.

---

## Architecture

```
GitHub (main) ──push──► Cloud Build ──build & deploy──► Cloud Run (iap-validator)
                                                              │
                                                              │ per-request, reads:
                                                              │   • config/games-registry.json (baked into image)
                                                              │   • GOOGLE_PLAY_CREDENTIALS env var (from Secret Manager)
                                                              │
                                                              ▼
                                                androidpublisher.googleapis.com
                                                (validates purchase tokens against
                                                 Google Play for whichever app the
                                                 request says it's for)
```

One Cloud Run service handles every game. Per-game data lives in `config/games-registry.json` (product IDs, package name, bcrypt'd API-key hash, rate limits). Auth is per-game API key sent as `X-API-Key` + `X-Game-ID` headers.

---

## Authentication model

Two layers:

1. **Client → server** (Unity → Cloud Run). Each game's Unity client sends its own API key and game ID as headers. The server bcrypt-compares the key against `games.<gameId>.apiKeyHash` in `games-registry.json`. Per-game keys = if one game's client is decompiled and the key is leaked, only that game is impacted.

2. **Server → Google Play**. A single Play Console SA, granted **account-level** permissions in Play Console, can validate purchases for *any* app in the same developer account. Its JSON key lives in Secret Manager and is injected as `GOOGLE_PLAY_CREDENTIALS` at runtime.

Net effect: adding a new game requires **no new GCP service account, no new secret, no Cloud Run config change** — only a registry entry and a `git push`.

---

## Project layout

```
iap-validator-source/
├── server.js                    # Express app, POST /api/v1/validate-purchase
├── lib/
│   ├── credentialManager.js     # Loads SA creds (per-game env > shared env > local file)
│   ├── gameValidatorService.js  # Calls Play Developer API, parses Unity receipts
│   └── cacheManager.js          # Per-game LRU cache, TTL'd by game settings
├── middleware/
│   ├── authMiddleware.js        # API-key + game-id header validation, IP allowlist
│   └── rateLimiter.js           # Sliding-window rate limit per game+IP
├── config/
│   └── games-registry.json      # ▶ Source of truth: every game's config
├── serviceAccountKeys/
│   ├── .gitignore               # Ignores all *.json
│   └── play-credentials.json    # Local dev only — NEVER committed
├── unity_iap_code/              # Reference Unity client code (not deployed)
│   ├── IAPManager.cs
│   └── IAPReceiptValidator.cs
├── generate-api-key.js          # CLI: mints key, writes bcrypt hash to registry
├── Dockerfile                   # node:20-slim, runs `node server.js`
├── .gitignore / .dockerignore / .gcloudignore
└── package.json
```

---

## Adding a new game

This is the only runbook you need for an existing Play Console app:

### 1. Verify Play Console permissions cover the new app

The shared SA was granted **account-level** access, so any new app in your Play developer account is automatically covered. Sanity-check in **Play Console → Settings → API access** if you're unsure.

### 2. Add a registry entry

In `config/games-registry.json`, add a new block under `games`:

```json
"<game-id-slug>": {
  "displayName": "<Human Readable Name>",
  "packageName": "com.example.app",
  "serviceAccountFile": "play-credentials.json",
  "apiKeyHash": "",
  "validProducts": [
    "com.example.app.product1",
    "com.example.app.product2"
  ],
  "settings": {
    "cacheTimeout": 3600000,
    "rateLimit": { "requests": 100, "window": 60000 },
    "allowedIPs": []
  },
  "enabled": true
}
```

`<game-id-slug>` is what the Unity client will send as `X-Game-ID`. Use lowercase-hyphenated; `generate-api-key.js` derives the key prefix from the initials of dash-separated parts (e.g. `racing-tycoon-3d` → `rt3_…`).

Leave `apiKeyHash` empty — the next step fills it.

### 3. Mint the API key

```powershell
node generate-api-key.js --game <game-id-slug>
```

This writes the bcrypt hash into `games-registry.json` and prints the **plaintext key once**. Save it — it is not recoverable.

To rotate an existing key, add `--force`.

### 4. Wire the Unity client

In the new game's Unity project, edit `IAPReceiptValidator.cs`:

```csharp
private const string CLOUD_RUN_VALIDATION_ENDPOINT = "https://iap-validator-700115340332.us-central1.run.app/api/v1/validate-purchase";
private const string API_KEY = "<plaintext key from step 3>";
private const string GAME_ID = "<game-id-slug>";
```

The URL is the same for every game. Then populate the `iapProducts` list in the Inspector — `androidProductId` must exactly match each entry in `validProducts` from the registry.

### 5. Push

```powershell
git add config/games-registry.json
git commit -m "Add <game-id-slug>"
git push
```

Cloud Build picks up the push, rebuilds the image, Cloud Run rolls out a new revision (~2 min). Game is live.

---

## Local development

```powershell
npm install

# Either drop play-credentials.json into serviceAccountKeys/ (gitignored),
# or set the env var directly:
$env:GOOGLE_PLAY_CREDENTIALS = Get-Content -Raw .\serviceAccountKeys\play-credentials.json

npm start
# → http://localhost:8080
```

Smoke test:
```powershell
curl http://localhost:8080/health
```

---

## Endpoints

| Method | Path | Auth required | Body |
|---|---|---|---|
| `GET` | `/health` | no | — |
| `GET` | `/api/v1/status` | no | — |
| `POST` | `/api/v1/validate-purchase` | `X-API-Key` + `X-Game-ID` headers | `{ receipt, productId, userId, platform: "android" }` |

Validation responses:
- `200 { isValid: true, transactionId, purchaseTime, purchaseState, ... }` — purchase verified
- `200 { isValid: false, error, errorCode }` — Play API rejected (404 not found / 410 expired / 403 perms / 401 auth)
- `400` — bad input (missing fields, package mismatch, etc.)
- `401` — bad client credentials
- `429` — rate limited

---

## Operations

### Tail logs
```bash
gcloud run services logs tail iap-validator --region=us-central1
```

### Rotate a game's API key (e.g. suspected leak)
```powershell
node generate-api-key.js --game <game-id> --force
git commit -am "Rotate <game-id> API key"
git push
```
Then update the Unity client with the new plaintext key and re-publish.

### Rotate the Play Console SA key
1. In GCP → IAM → Service Accounts → click the SA → Keys → **Add key** → JSON.
2. Upload the new JSON to Cloud Shell, then:
   ```bash
   gcloud secrets versions add google-play-credentials --data-file=new-key.json
   rm new-key.json
   ```
3. Force a fresh revision so Cloud Run picks up `latest`:
   ```bash
   gcloud run services update iap-validator --region=us-central1 \
     --update-env-vars=ROTATED=$(date +%s)
   ```
4. Verify with a real-purchase test, then **delete the old key** in GCP IAM.

### Disable a game without removing it
Set `"enabled": false` in `games-registry.json`, commit, push.

### Roll back a deploy
```bash
# List recent revisions
gcloud run revisions list --service=iap-validator --region=us-central1

# Send 100% traffic to a previous revision
gcloud run services update-traffic iap-validator --region=us-central1 \
  --to-revisions=<previous-revision-name>=100
```
Or use the Revisions tab in the Cloud Run console.

---

## Currently deployed games

| gameId | Package | Products | Notes |
|---|---|---|---|
| `arcade-simulator-retro-games` | `com.zi.arcade.shop.supermarket.simulator` | 14 | First game wired up |

---

## Security model

**In git** (committed):
- All source code, Dockerfile, registry — **including the bcrypt hashes** of API keys (hashes, not plaintext)

**Not in git** (gitignored, local only):
- `serviceAccountKeys/*.json` — the Play Console SA private key
- Plaintext API keys for any game (these live only in each game's Unity project)

**In Secret Manager:**
- `google-play-credentials` — the Play Console SA JSON, mounted into Cloud Run as `GOOGLE_PLAY_CREDENTIALS`

**Credential precedence at runtime** (`credentialManager.js` lines 22–34):
1. `GOOGLE_CREDENTIALS_<GAMEID_UPPER>` env var (per-game override; not currently set, available if a future game ever needs an isolated SA)
2. `GOOGLE_PLAY_CREDENTIALS` env var (the shared SA — what's set in production)
3. Local file at `serviceAccountKeys/<filename>` (local dev fallback)

Even though the registry's `apiKeyHash` values are bcrypt'd and not directly usable, treat the repo as if it leaks plaintext: rotate any key whose hash gets exposed.

---

## Common errors and causes

| Symptom | Likely cause |
|---|---|
| Server logs `Failed to load credentials for <gameId>` | `GOOGLE_PLAY_CREDENTIALS` env var not bound, or the secret has no `latest` version |
| Play API returns `403 Access denied` | SA lost Play Console permissions, or a brand-new app isn't yet covered (re-check **Play Console → Settings → API access**) |
| Play API returns `401` | SA key revoked or expired — rotate (see Operations) |
| Play API returns `404 Purchase not found` | Receipt is for a real but already-consumed purchase, or token doesn't match the package |
| Server returns `Invalid API key` for a real client | Unity's `API_KEY` constant is out of sync with `apiKeyHash` in the registry — re-mint with `--force` and re-publish Unity |
| Server returns `Package name mismatch` | Unity's product was bought against a different package than the registry's `packageName` — usually a Play Console internal-test vs production drift |
| `429` on first request | Rate limit window from a prior request burst; default is 100 req / 60s per (game, IP) |
