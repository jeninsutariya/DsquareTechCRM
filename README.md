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

### Translate listings with Google Gemini

1. Tick the listings you want (or the header box to select everything shown).
2. Click **Translate & update selected** and choose languages
   (German, Spanish, French, Italian, Japanese, Dutch, Polish, Portuguese, Russian, Swedish).
3. Gemini translates the **title, description and tags** of each listing, written for local Etsy search.
4. Review and edit the result. Nothing changes on Etsy yet.
5. Click **Publish to Etsy**. Each translation is saved to the listing on Etsy.
   The **Translations** column shows which languages each listing has.

**Fallback:** if Gemini fails for a listing (bad key, quota, unknown model, blocked or invalid output),
that listing is translated with **Claude** (`claude-opus-5-5` by default, set `CLAUDE_MODEL` to change it).
The review screen marks those listings and shows the Gemini error. With no Gemini key at all,
Claude is used for everything. Set `ANTHROPIC_API_KEY` in `.env`.

Output is cleaned to Etsy's rules: title at most 140 characters, at most 13 tags of up to 20 characters each.
Etsy only shows a translation if that language is enabled in your shop
(Shop Manager → Settings → Info & Appearance → Languages). The dialog marks languages that aren't enabled with ⚠.

Shops connected before this feature need to click **Reconnect shop** once, which grants the
`listings_w` (edit listings) permission.

### Setup

1. Create an app at <https://www.etsy.com/developers/your-apps>.
2. Add `http://localhost:3000/auth/etsy/callback` as a **Callback URL** on the app.
3. Configure and run:

```bash
cp .env.example .env   # fill in ETSY_API_KEY, ETSY_SHARED_SECRET, GEMINI_API_KEY, ANTHROPIC_API_KEY
npm install
npm start              # open http://localhost:3000
```

Requires Node.js 20+. The app reads `.env` from the project folder automatically.

If the page shows **Setup needed**, the message says what to fix. The most common cause on
macOS is TextEdit saving the file as `.env.txt` or `.env.rtf`. Create it from the terminal instead:
`cp .env.example .env && open -e .env`, then save it as plain text.

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
| POST | `/api/etsy/translations/generate` | `{listingIds, languages}` → Gemini drafts (background job) |
| POST | `/api/etsy/translations/publish` | `{items:[{listing_id, language, title, description, tags}]}` → save to Etsy (background job) |
| GET  | `/api/jobs/:id` | Job progress, results and per-item errors |

Data is stored in `data/etsy.json` (git-ignored, file mode 600).

### Tests

```bash
npm test
```
