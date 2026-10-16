# DsquareTechCRM

CRM with a one-click Etsy shop connection that automatically imports **all** listings.

## Etsy integration

**Connect, then fetch all listings automatically:**

1. Click **Connect Etsy shop**. You are sent to Etsy to approve access (OAuth 2.0 + PKCE).
2. Etsy redirects back. The app stores the tokens, looks up your shop, and right away
   imports every listing in every state (`active`, `draft`, `inactive`, `sold_out`, `expired`),
   following pagination 100 at a time.
3. Listings show in a searchable table and can be exported to CSV. They re-sync automatically
   every `SYNC_INTERVAL_MINUTES`, or whenever you click **Sync all listings**.

Access tokens refresh automatically, so the shop stays connected after restarts.
Rate limits (429) and 5xx errors are retried with backoff.

### Setup

1. Create an app at <https://www.etsy.com/developers/your-apps>.
2. Add `http://localhost:3000/auth/etsy/callback` as a **Callback URL** on the app.
3. Configure and run:

```bash
cp .env.example .env   # fill in ETSY_API_KEY (keystring) and ETSY_SHARED_SECRET
npm install
npm start              # open http://localhost:3000
```

Requires Node.js 20+ (22.9+ for automatic `.env` loading via `npm start`).

### API

| Method | Path | Description |
| --- | --- | --- |
| GET  | `/auth/etsy` | Start the Etsy connection (redirects to Etsy) |
| GET  | `/auth/etsy/callback` | OAuth callback: saves tokens and imports all listings |
| POST | `/auth/etsy/disconnect` | Forget the shop, its tokens and cached listings |
| GET  | `/api/etsy/status` | Connection status, last sync time, counts per state |
| POST | `/api/etsy/listings/sync` | Re-fetch all listings from Etsy now |
| GET  | `/api/etsy/listings?state=&q=` | Cached listings (filter by state or by title/SKU text) |
| GET  | `/api/etsy/listings/raw` | Full raw Etsy listing objects |
| GET  | `/api/etsy/listings/export.csv` | CSV export |

Data is stored in `data/etsy.json` (git-ignored, file mode 600).

### Tests

```bash
npm test
```
