# Public Surface Rebuild — Change Log

The public surfaces (`index.html` landing + the hardcoded `#detail-ws` / `#detail-cr` venue detail blocks + the eventual `venue.html?id=X`) are being rebuilt in 5 sequential commits to match the dashboard v2 visual system (pure black / Inter / `#ff6b1a` orange).

| Commit | Status | Scope |
|--------|--------|-------|
| **A — White Swan D1 seed** | ✅ Done | Reconcile White Swan into D1; wire `VENUES.ws.id` in index.html |
| **B — Photo upload backend (R2)** | ✅ Done | R2 bucket + custom domain + upload/delete endpoints |
| C — `venue.html?id=X` | pending | New dynamic public venue page using the dashboard v2 visual system |
| D — Remove `#detail-cr` / `#detail-ws` hardcoded blocks | pending | Once `venue.html` is live, replace inline blocks with redirects |
| E — Index landing v2 swap + upload UI in dashboard Edit Profile | pending | Swap `index.html` to the v2 mockup layout; wire the photo upload UI to the Commit B backend |

---

## Commit A — White Swan Live reconciled in-place

### What we found (pre-commit)

A row for White Swan already existed in D1 as `id=3` — created during an earlier admin session as a placeholder, not via the original Commit A spec. It had a connected Stripe Connect account (`acct_1TUelWQxbg359o6x`, from early Stripe testing) and a bound venue_owner user (`whiteswanlive@venueportal.us`, id=9).

The original Commit A spec said "INSERT a new row" — but doing that would have orphaned both the Stripe account and the venue_owner user. **Operator decision: UPDATE in place (Option A)**, preserving the user binding, disconnecting Stripe at the D1 level, and keeping the existing placeholder capacity/price values since White Swan isn't yet fully onboarded as a real bookable venue.

### Production D1 — `venues` row id=3 before/after

| Column | Before | After |
|--------|--------|-------|
| `id` | 3 | 3 (unchanged) |
| `name` | `Swan Live` | **`White Swan Live`** |
| `description` | `null` | **`4419 Navigation Blvd, Houston TX 77011. Raw bar venue on Navigation Blvd in East Houston. Established independent venue with a real stage, full PA, and a crowd that shows up. No cover bands. No tributes. This room is for originals only - artists who are building something real.`** |
| `capacity` | 400 | 400 (unchanged — placeholder) |
| `price_per_day` | 450 | 450 (unchanged — placeholder) |
| `hours` | `null` | **`9pm-1am`** (ASCII hyphen, no en-dash) |
| `amenities` | `null` | **`["Full PA System (5000W)", "Stage + Drum Riser (200 sq ft)", "Stage Lighting", "Sound Engineer On-Site", "Adjacent Parking"]`** |
| `gallery` | `null` | **`[]`** (empty array — photos arrive via Commit B/E) |
| `video_url` | `null` | `null` (unchanged) |
| `image_url` | `null` | `null` (unchanged) |
| `stripe_account_id` | `acct_1TUelWQxbg359o6x` | **`NULL`** |
| `stripe_connected` | 1 | **0** |
| `created_at` | 2026-05-08 02:27:57 | unchanged |

Source content extracted from the existing `#detail-ws` block in `index.html` lines 782–893. Address prefixed to the description since the `venues` schema has no dedicated `location` column.

### Stripe Connect disconnect — rationale + follow-up

The Stripe account `acct_1TUelWQxbg359o6x` was originally created during early Stripe Connect testing. White Swan isn't a real bookable venue yet (still in placeholder state — capacity and price aren't accurate; the visual surface rebuild is for the marketing/demo layer first).

This commit unlinks the account from D1 only — `stripe_account_id` set to `NULL`, `stripe_connected` set to `0`. The PATCH `/api/bookings/:id/status` accept flow guards on `stripe_connected`, so a venue_owner attempting to accept a White Swan inquiry will get a clean `"Connect Stripe before accepting bookings."` error (the same UX as any new venue).

The Stripe Connect account itself **continues to exist on Stripe's side**. We did NOT call Stripe's API to delete/reject it.

> **Follow-up for operator (non-blocking):** Manually delete or reject `acct_1TUelWQxbg359o6x` from your Stripe Connect dashboard when convenient. Search the connected accounts list for that account id, then "Reject account" or "Delete". Not urgent — the account just sits dormant until you clean it up.

### User binding — preserved

`whiteswanlive@venueportal.us` (user id=9) → `venue_id=3` → still wired. When this user eventually logs in and goes through the first-login password flow, they'll see the venue named "White Swan Live" with the populated content from this commit.

### `index.html` change

```diff
- ws: { id: null, name:'White Swan Live', location:'Houston, TX', fee:100, feeLabel:'$100 flat',     feeNote:'flat fee',     contact:'713-923-2837' },
+ ws: { id: 3,    name:'White Swan Live', location:'Houston, TX', fee:100, feeLabel:'$100 flat',     feeNote:'flat fee',     contact:'713-923-2837' },
```

Only the `id` field changed (`null` → `3`). All other VENUES.ws fields (name/location/fee/feeLabel/feeNote/contact) untouched — they're still consumed by the legacy `#detail-ws` block which stays in place until Commit D.

### Verification (all gates green)

| Gate | Result |
|------|--------|
| White Swan venue row id=3 has all spec fields updated | ✅ |
| Stripe fields cleared (NULL / 0) | ✅ confirmed via `SELECT id, stripe_account_id, stripe_connected` |
| User binding intact: `whiteswanlive@venueportal.us` → venue_id=3 | ✅ |
| Chill Room row id=1 untouched | ✅ capacity 275, price 450, hours `7pm-2am`, description intact, `stripe_account_id=acct_1TUYEmJPbCcQ7uFT`, `stripe_connected=1` all unchanged |
| `/api/venues` list returns both venues | ✅ |
| Test inquiry for White Swan creates booking row (id 35, pending, venue_id=3) | ✅ |
| Test inquiry for Chill Room creates booking row (id 36, pending, venue_id=1) | ✅ |
| Both test bookings deleted after verification | ✅ `DELETE FROM bookings WHERE id IN (35, 36)` → `changes: 2`, follow-up SELECT returns `[]` |
| `index.html` VENUES.ws.id = 3 | ✅ |

### Files touched in this commit

- `index.html` (1 line: VENUES.ws.id `null` → `3`)
- `PUBLIC_SURFACE_V2_DIFF.md` (new, this file)

No other files modified. `dashboard.html`, `api.js`, and all other live files untouched.

---

## Commit B — Photo upload backend (R2 + custom domain + endpoints)

### Infrastructure

**R2 bucket created**
- Name: `venue-photos`
- Created: 2026-05-30 18:24:36 UTC
- Region: Auto (Cloudflare default — currently US/WNAM)
- Public access: enabled
- Custom domain: `images.venueportal.us` (connected via Cloudflare dashboard, SSL provisioned)
- Object key structure: `venue-photos/{venue_id}/{timestamp}.{ext}`

**Worker binding** (added to `wrangler.jsonc`)
```jsonc
"r2_buckets": [
  {
    "binding": "VENUE_PHOTOS",
    "bucket_name": "venue-photos"
  }
]
```
Verified at deploy time: `env.VENUE_PHOTOS (venue-photos) — R2 Bucket` shows in wrangler output.

### Endpoints

#### `POST /api/venues/:id/photos` — upload one photo

**Auth:** Bearer JWT required. Allowed if `role` ∈ {`admin`, `superadmin`}, OR `role === 'venue_owner' && session.venue_id === :id`. Otherwise 401/403.

**Request:** `multipart/form-data` with a single field named `file`.

**Validation:**
- MIME type must be one of: `image/jpeg`, `image/png`, `image/webp`. Reject 400 otherwise.
- File size: 1 byte ≤ size ≤ 5,242,880 bytes (5 MB). Reject 400 otherwise.
- Current gallery count: must be < 8. Reject 409 if at the limit.

**Behavior:**
1. Read current `venues.gallery` (parsed from TEXT JSON; defaults to `[]` if null/malformed)
2. Generate key: `venue-photos/{id}/{Date.now()}.{ext}` where `ext` ∈ {`jpg`, `png`, `webp`}
3. `env.VENUE_PHOTOS.put(key, file.stream(), { httpMetadata: { contentType: file.type } })`
4. Append `https://images.venueportal.us/{key}` to gallery array
5. `UPDATE venues SET gallery = ? WHERE id = ?`

**Response 200:** `{ success: true, url: "<full URL>", gallery: [<full array>] }`

#### `DELETE /api/venues/:id/photos` — remove one photo

**Auth:** same rules as POST.

**Request:** JSON body `{ "url": "<full public URL>" }`.

**Behavior:**
1. Validate URL starts with `https://images.venueportal.us/` AND key path starts with `venue-photos/{id}/` (prevents cross-venue tampering)
2. Extract R2 key from URL
3. Read current gallery, filter out the URL
4. `env.VENUE_PHOTOS.delete(key)` — idempotent (no error if object doesn't exist)
5. Write filtered gallery back to D1 only if the URL was actually removed

**Response 200:** `{ success: true, removed: <bool>, gallery: [<updated array>] }`

### End-to-end test results

All tests against deployed worker `8f12508c-66c8-4f00-b555-18c4d29afb8a` with `mossjr1126@gmail.com` admin token.

| Test | Expected | Actual |
|------|----------|--------|
| Custom domain SSL handshake | 200/404 with `Server: cloudflare` | ✅ 404 (no root object), SSL valid |
| Upload 32×32 JPEG (645 B) for venue id=1 | 200 + `images.venueportal.us` URL | ✅ `https://images.venueportal.us/venue-photos/1/1780179100813.jpg` |
| Fetch URL publicly (no auth) | 200, `Content-Type: image/jpeg`, exact bytes | ✅ 645 B served, SHA256 matches local file byte-for-byte (`49c993a7…7a67f2c`) |
| D1 `venues.gallery` updated for id=1 | URL present in JSON array | ✅ `["https://images.venueportal.us/venue-photos/1/1780179100813.jpg"]` |
| Oversize file (6 MB random bytes, `.jpg` ext) | 400 with size message | ✅ `{"error":"File must be between 1 byte and 5242880 bytes (5MB)."}` |
| Wrong MIME (`.svg`, `image/svg+xml`) | 400 with MIME message | ✅ `{"error":"Unsupported file type. Allowed: image/jpeg, image/png, image/webp."}` |
| No `Authorization` header | 401 | ✅ `{"error":"Unauthorized"}` |
| DELETE photo via URL | 200, `removed: true`, gallery `[]` | ✅ `{"success":true,"removed":true,"gallery":[]}` |
| R2 object actually gone | 404 on the URL | ✅ `HTTP/1.1 404 Not Found` |
| D1 gallery cleared | `gallery = "[]"` | ✅ confirmed via `SELECT id, gallery FROM venues WHERE id=1` |

**Final state after testing: clean** — no test photos in R2, no test URLs in D1. Venue id=1 gallery back to `[]`.

### Constraints summary

| Constraint | Value |
|---|---|
| Max file size | 5,242,880 bytes (5 MB) |
| Allowed MIME types | `image/jpeg` · `image/png` · `image/webp` |
| Max photos per venue | 8 (server-enforced via gallery-length check) |
| Server-side resize | None (CSS handles display) |
| Public access | Yes (no signed URLs) |
| URL pattern | `https://images.venueportal.us/venue-photos/{venue_id}/{timestamp}.{ext}` |

### Files touched

- `wrangler.jsonc` (added `r2_buckets` array)
- `api.js` (added POST + DELETE `/api/venues/:id/photos` handlers, ~110 lines)
- `PUBLIC_SURFACE_V2_DIFF.md` (this section)

### Follow-up for Commit E

The upload UI in dashboard's Edit Profile form (currently a textarea for pasting URLs in `#edit-gallery`) needs to be replaced with a file-picker + drag-and-drop UI that POSTs to this backend. That's bundled into Commit E along with the index.html v2 swap.
