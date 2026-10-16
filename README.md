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

### Translate listings with AI (Gemini model/key rotation)

1. Tick the listings you want, or the header box to select everything shown.
   Tip: set the filter to **Missing German** (or another language), then tick the header box to select every listing that still needs that translation.
2. Click **Translate & update selected** and choose languages
   (German, Spanish, French, Italian, Japanese, Dutch, Polish, Portuguese, Russian, Swedish).
3. AI translates the **title, description and tags** of each listing, written for local Etsy search.
4. Each translated listing is **saved as a draft on the server right away**. Reloading the page, closing
   the dialog or restarting the app keeps it, so nothing has to be generated twice. Generating again
   skips languages that already have a good draft or are published (tick "Translate again" to redo them).
   Review and edit drafts any time with **Saved drafts**; edits save automatically. Nothing changes on Etsy yet.
   A description that comes back still in English is rejected and retried on the next model, and is
   never published.
5. Click **Publish all to Etsy**. Drafts are published one at a time with progress, and each is removed
   once Etsy has it. If Etsy's API limit is hit, publishing stops and the rest stay saved; click
   **Publish remaining** later.
   The **Translations** column shows which languages each listing has.

**Speed.** Listings are translated **in parallel, one per API key** (each key sends one request
at a time, so its own limits are respected). With 4 working keys that is about 4× faster. Set
`TRANSLATE_CONCURRENCY` to override, or `TRANSLATE_DELAY_MS` to add a pause between requests on a key.
Publishing sends `PUBLISH_CONCURRENCY` (default 3) translations to Etsy at a time.

**Model and API key rotation.** The app works through a chain:
API key 1 with every model in `GEMINI_MODELS` (default: 3.5 Flash Lite → 3.1 Flash Lite →
2.5 Flash Lite → 3.6 Flash → 3 Flash → 3.7 Flash → 3.8 Flash), then key 2 with every model, up
to `GEMINI_API_KEY_5`.

- **Limit reached (429):** that model/key pauses (1 minute, or 24 hours for a daily limit). The
  **same listing is retried** on the next model/key, so nothing is skipped.
- **Invalid key, or a model that doesn't exist:** it's skipped for the rest of the run.
- **Bad output from one model:** the listing is retried on the next model.
- **Everything used up:** translating stops. Listings already done go to the review screen to
  publish. The rest stay selected so you can run them later.

The review screen shows which model and key translated each listing.

- **Model busy (503 "high demand"):** retried once on the same model, then that model pauses for 30
  seconds while others are tried. If every model is busy, the app waits rather than failing the listing.
- **Description returned in English:** the same model is asked again for just the description, one
  language at a time. If it's still English, the next model is tried.

Run `npm run models` to list the models each of your keys can actually use, then put those names in
`GEMINI_MODELS`.

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
cp .env.example .env   # fill in ETSY_API_KEY, ETSY_SHARED_SECRET, GEMINI_API_KEY_1..5
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
| GET  | `/api/etsy/listings?state=&q=&translated=&sort=` | Cached listings. `q` matches title, SKU or tag; `translated` is `none`, `any`, `has:all`, `missing:any`, `has:<lang>` or `missing:<lang>`; `sort` is `updated`, `title`, `price_asc`, `price_desc`, `views` or `favorites` |
| GET  | `/api/etsy/listings/raw` | Full raw Etsy listing objects |
| GET  | `/api/etsy/listings/export.csv` | CSV export |
| POST | `/api/etsy/translations/generate` | `{listingIds, languages}` → AI drafts via model/key rotation (background job) |
| POST | `/api/etsy/translations/publish` | `{items:[{listing_id, language, title, description, tags}]}` → save to Etsy (background job) |
| GET  | `/api/etsy/drafts` | Saved drafts waiting to be published |
| PUT  | `/api/etsy/drafts/:id/:lang` | Edit a draft (`title`, `description`, `tags`, `include`) |
| DELETE | `/api/etsy/drafts` | Discard all drafts |
| POST | `/api/etsy/drafts/publish` | Publish saved drafts one at a time (optional `listingIds`) |
| GET  | `/api/jobs/:id` | Job progress, results and per-item errors |

Data is stored in `data/etsy.json` (git-ignored, file mode 600).

### Tests

```bash
npm test
```
