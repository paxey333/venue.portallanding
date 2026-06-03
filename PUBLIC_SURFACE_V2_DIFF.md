# Public Surface Rebuild — Change Log

The public surfaces (`index.html` landing + the hardcoded `#detail-ws` / `#detail-cr` venue detail blocks + the eventual `venue.html?id=X`) are being rebuilt in 5 sequential commits to match the dashboard v2 visual system (pure black / Inter / `#ff6b1a` orange).

| Commit | Status | Scope |
|--------|--------|-------|
| **A — White Swan D1 seed** | ✅ Done | Reconcile White Swan into D1; wire `VENUES.ws.id` in index.html |
| **B — Photo upload backend (R2)** | ✅ Done | R2 bucket + custom domain + upload/delete endpoints |
| **C — `venue.html?id=X` dynamic page** | ✅ Done | New public venue page + 2 api.js changes + photo seeding |
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

---

## Commit C — `venue.html?id=X` dynamic public venue page

### New file

**`venue.html`** — standalone public venue detail page at project root. Pure HTML + CSS + vanilla JS (no frameworks). Inter from Google Fonts is the only external dependency. ~600 lines including all CSS and JS inline. Matches the locked Option B mockup (`venue-v2-mockup.html`) visual direction byte-for-byte except for dynamic-data binding and functional booking flow.

### Two api.js changes (operator-approved, in-spec)

Per the updated workstream rule ("Limited, intentional api.js changes are now approved when they enable scope that's already in spec"), Commit C required two surgical backend changes — both documented here, both atomic with this commit.

#### Change 1 — `GET /api/venues/:id` made public

Previously auth-gated to admin/venue_owner. Now anonymous.

```diff
- const session = await getSession(request, env);
- if (!isAnyRole(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
- console.log("[GET /api/venues/:id] user:", session.user_id, ...);
- if (session.role === "venue_owner" && session.venue_id !== id) {
-   return jsonResponse({ error: "Forbidden" }, 403, request);
- }
+ const session = await getSession(request, env).catch(() => null);
+ console.log("[GET /api/venues/:id]", id, "session:", session ? session.role : "public");
```

**Risk analysis (operator-validated):**
- SELECT pulls `id, name, description, capacity, price_per_day, image_url, hours, amenities, gallery, video_url, created_at` — **no Stripe fields, no emails, no PII**.
- Dashboard's `loadVenueProfile()` keeps working — it sends `Authorization: Bearer ...`; the endpoint now ignores the header instead of validating it. Backwards-compatible.
- Venue data is marketing/booking content meant to be public anyway. The auth gate was historical over-restriction.

**Regression check passed:**
- Anonymous `GET /api/venues/1` → 200, returns full 11-field shape, no Stripe leakage
- Admin-authed `GET /api/venues/1` → 200, identical shape
- Dashboard's `loadVenueProfile()` still receives the same payload it always has

#### Change 2 — new public endpoint `GET /api/venues/:id/booked-dates`

Returns only confirmed `event_date` values for the venue. No PII (no client name/email/message). Used by `venue.html`'s booking calendar to render booked dates as muted/strikethrough/non-clickable.

```js
const venueBookedDatesMatch = path.match(/^\/api\/venues\/(\d+)\/booked-dates$/);
if (venueBookedDatesMatch && request.method === "GET") {
  // SELECT event_date FROM bookings WHERE venue_id = ? AND status = 'confirmed'
  // Returns { dates: [...] }
}
```

Sample response: `{ "dates": ["2026-05-29", "2026-06-05", "2026-05-23", "2026-05-30", "2026-07-03"] }` (real confirmed bookings for Chill Room as of commit time).

Why a dedicated endpoint instead of extending `/api/bookings`: keeps scope minimal, no PII exposure, makes the public-surface API contract intentional and discoverable.

### Photo seeding

8 placeholder JPEGs uploaded via the Commit B `POST /api/venues/:id/photos` endpoint with admin auth:

- **Chill Room (id=1)** — 4 photos, warm orange/red gradients (varied 2-color blends + faint chevron watermark, ~14-18 KB each)
- **White Swan (id=3)** — 4 photos, deep red/ember tones (same generation script, different palette)

These gradients are intentional placeholder content that venue owners can later replace via the upload UI in Commit E. Not test data; not slated for cleanup.

R2 storage cost: 8 x ~15 KB = 120 KB total. Well inside the 10 GB free tier.

### Functional behavior

**URL handling**
- `?id=X` parsed from query string. Missing or non-numeric → `window.location.replace('/')` (silent redirect home).
- Non-existent id (API returns 404) → renders error state with "Back to all venues" CTA + retry button. Does NOT render an empty/broken page.

**Loading state**
- Skeleton hero + 4 stat cards + section blocks animated with a CSS shimmer. No fake placeholder text — clearly visually distinct from real content (lesson learned from dashboard fix-up #8 camouflage cleanup).

**Empty-field handling (graceful, intentional)**
- Per spec hard rule #4: no "—" dashes shown on the public surface.
- Missing description → "About" section hidden entirely (`display:none`).
- Missing amenities → "What's Included" section hidden.
- Missing hours → 4th stat pill repurposed for "Vibe" (first amenity); if neither exists, 3-pill row.
- Empty gallery → hero falls back to gradient placeholder, "Photo gallery" section hidden.
- Missing price_per_day → "The deal" section hidden; sidebar/sticky-bar show "—" only in the price slot.
- "House Rules" always renders generic platform-level rules (Stripe deposit, cancellation window, damages, owner-specific rules disclosed after acceptance). No DB column for venue-specific rules yet; future schema enhancement.

**Calendar**
- Pure CSS Grid (7 cols), Mon-first week, JS-rendered day cells.
- States: `past` (dimmed, non-clickable), `today` (orange ring), `booked` (muted strikethrough — from `/api/venues/:id/booked-dates`), `selected` (solid orange), available (warm tint, clickable).
- Month nav: prev/next buttons, capped to current month (no past months) and current+18 months (no infinite future scroll).
- Visible in both the desktop sidebar (`#cal-grid`) and the mobile booking modal (`#m-cal-grid`) — both calendars stay in sync since they read from the same state object.

**Mobile**
- Below 900px: single column, sticky bottom bar appears with price + "Pick a date" / "Send inquiry · {date}" CTA.
- Tap CTA → bottom-sheet modal slides up (border-radius 18px on top corners, max-height 92vh, padding-bottom uses `env(safe-area-inset-bottom)`).
- Modal contains calendar + booking form + summary card + submit/cancel buttons.
- Above 900px: modal becomes a centered card; calendar is only in the sidebar.
- All tap targets >=44x44px (calendar day cells use `min-height:36px` + grid spacing; buttons use `min-height:44px` explicitly).

**Booking submission — IDENTICAL CONTRACT to index.html line 2432**

Payload shape:
```
venue_id     -> state.venue.id
client_name  -> trimmed name input
client_email -> trimmed email input
event_date   -> state.selected.iso (YYYY-MM-DD)
guests       -> parseInt(headcount) || null
message      -> trimmed text || null
```

Field names byte-for-byte identical to `index.html` lines 2462-2474. Mirrors, doesn't reinvent. No `phone`, no `guest_count`, no `name`/`email` — matches what the API already accepts.

**Success path**: `window.location.href = '/booking-confirmed.html'` (existing page, untouched by this commit).
**Error path**: inline error in modal, form data preserved, button re-enabled.

### Verification — full test matrix

| # | Test | Result |
|---|------|--------|
| 1 | `GET /api/venues/1` anonymous | PASS — 200, full 11 fields, no Stripe |
| 2 | `GET /api/venues/1` admin-authed (regression) | PASS — 200, identical shape, dashboard unaffected |
| 3 | `GET /api/venues/999` | PASS — 404 with `{"error":"Venue not found"}` triggers error state in venue.html |
| 4 | `GET /api/venues/1/booked-dates` | PASS — returns 5 confirmed event_dates |
| 5 | `GET /api/venues/3/booked-dates` | PASS — returns `[]` (no confirmed bookings yet) |
| 6 | Photos uploaded to Chill Room (id=1) | PASS — 4 URLs in gallery, all served at images.venueportal.us |
| 7 | Photos uploaded to White Swan (id=3) | PASS — 4 URLs in gallery, all served |
| 8 | Booking POST for venue_id=1 (exact venue.html payload) | PASS — row 37 created, status=pending |
| 9 | Booking POST for venue_id=3 (exact venue.html payload) | PASS — row 38 created, status=pending |
| 10 | Test bookings deleted after verification | PASS — `changes: 2`, follow-up SELECT returns `[]` |
| 11 | Photos still intact after booking tests | PASS — both venues still have 4 photos each |
| 12 | Worker deployment | PASS — Version `4482a341-8083-4f33-9195-e550391b13e5` live |

### Files touched

- `api.js` — 2 changes: GET /api/venues/:id auth removed (-6 lines), new GET /api/venues/:id/booked-dates handler (+15 lines)
- `venue.html` — new file, ~600 lines
- `PUBLIC_SURFACE_V2_DIFF.md` — this section
- R2 bucket `venue-photos` — 8 new objects (4 per venue)
- D1 — gallery arrays for venue id=1 and id=3 populated with 4 URLs each

### Not touched (per hard rules)

- `index.html` — VENUES.ws.id wiring from Commit A still in place; nothing else changed
- `dashboard.html` — untouched
- Booking POST contract — exact mirror of index.html's existing flow
- Bottom tab nav — confirmed absent from venue.html (was removed from mockup in iteration #1)

---

## Commit C fix-up #1 — photos render, inquiry-sent page, sidebar overflow, entrance animations

User-reported issues from browser review of venue.html?id=1 and ?id=3:

1. ERR_BLOCKED_BY_CLIENT in console — **ignored** (Brave shields blocking Cloudflare analytics beacon, not actionable).
2. Photos not rendering in venue.html despite API returning correct gallery URLs and R2 URLs working directly when hit.
3. Booking submission redirected to `/booking-confirmed.html` (old pre-v2 page that errors "no session id provided").
4. Desktop sticky booking sidebar overflowed viewport — Book button below the fold.
5. Missing entrance animations on content reveal.

### Fixes

**Fix #2 — Bulletproof gallery rendering in `venue.html`**
- Normalized `v.gallery` to filter out non-string / empty entries.
- Rewrote hero + gallery rendering from innerHTML template literals to `document.createElement('img')` with explicit inline `width:100%;height:100%;object-fit:cover;display:block` styles as belt-and-suspenders against any CSS / parsing edge case.
- Added `onerror` / `onload` console diagnostics on each img.
- Exposed `window.__venueDebug = { venue, gallery, heroSrc, galleryRendered }` for in-browser inspection.
- Console logs: `[venue] rendering`, `[venue] gallery normalized`, `[venue] hero img loaded`, `[venue] gallery render`, and DOM img count after render.

**Fix #3 — New `inquiry-sent.html` (replaces redirect destination)**
- New v2-styled confirmation page mirroring venue.html design tokens (pure black, Inter, orange accent, green success state).
- Green check-circle with pulsing ring animation, "Inquiry sent" pill, "Your inquiry is in." headline.
- 3-step "what happens next" card: owner review → confirmation email → Stripe deposit.
- CTAs: Browse more venues / Email support. Footer with Privacy/Terms/Contact.
- `submitInquiry()` in venue.html now redirects to `/inquiry-sent.html` (was `/booking-confirmed.html`).
- `booking-confirmed.html` NOT touched per hard rules.

**Fix #4 — Compact booking sidebar (CSS-only)**
- Reduced `.book-head` padding 22/22/16 → 18/20/14; `.book-price .amt` 32px → 28px; `.book-perks` gap 7 → 6.
- Reduced `.book-cal-section` padding 18/22 → 14/20; cal nav margin 12 → 10; cal-btn 30x30 → 28x28; cal grid gap 4 → 3.
- Reduced `.book-day` min-height 36 → 30 on mobile; further to 28 on desktop sidebar via media query.
- Reduced `.book-cta-wrap` padding 14/22/22 → 12/20/18; btn-book padding 13 → 12.
- **Desktop only (min-width:900px)**: hidden `.book-perks` inside `.layout-sidebar` (perks still show in mobile bottom-sheet modal). Calendar cells shrink font 11.5 → 10.5 on sidebar to fit.

**Fix #5 — Entrance animations**
- `@keyframes fadeInUp` (translateY 16px → 0, opacity 0 → 1, 600ms ease both).
- `.anim-fade-up` + 6 stagger classes `.anim-d1` (.05s) through `.anim-d6` (.55s).
- `prefers-reduced-motion:reduce` disables the animation.
- JS in `renderVenue()` post-reveal applies stagger classes to: hero (d1), stats (d2), about (d3), included (d4), deal (d5), sidebar (d3). Skips sections still hidden.

### Files touched

- `venue.html` — gallery createElement rewrite + debug logging, submit redirect URL, sidebar compact CSS, fadeInUp keyframes + stagger classes + JS hook
- `inquiry-sent.html` — new file, ~170 lines
- `PUBLIC_SURFACE_V2_DIFF.md` — this section

### Not touched (per hard rules)

- `api.js` — no changes; existing public GET /api/venues/:id and /booked-dates from Commit C still in place
- `index.html` — untouched
- `dashboard.html` — untouched
- `booking-confirmed.html` — left as-is; venue.html no longer redirects to it
- Booking POST contract — identical payload, only the success redirect URL changed

---

## Commit C fix-up #2 — swap gradient placeholders for real venue photos

The 8 gradient placeholder JPEGs seeded in Commit C (4 per venue, generated via PIL) have been replaced with 5 real photos provided by the venue owners.

### What changed

**R2 / D1 — pure data swap, no code touched.**

8 placeholder URLs deleted from R2 + removed from D1 gallery arrays via `DELETE /api/venues/:id/photos`:

- venue 1: `1780179828453.jpg`, `1780179829891.jpg`, `1780179831227.jpg`, `1780179832555.jpg`
- venue 3: `1780179834101.jpg`, `1780179835431.jpg`, `1780179836862.jpg`, `1780179838191.jpg`

5 real photos uploaded via `POST /api/venues/:id/photos` in hero-first order so `gallery[0]` is the hero image rendered by venue.html.

### Final gallery state

**Chill Room (venue id=1)** — 3 photos:
1. `https://images.venueportal.us/venue-photos/1/1780303861275.jpg` — hero (band)
2. `https://images.venueportal.us/venue-photos/1/1780303861731.jpg` — lounge
3. `https://images.venueportal.us/venue-photos/1/1780303862267.jpg` — panorama

**White Swan Live (venue id=3)** — 2 photos:
1. `https://images.venueportal.us/venue-photos/3/1780303862937.jpg` — hero (stage)
2. `https://images.venueportal.us/venue-photos/3/1780303863373.jpg` — audience

### Verification

| # | Check | Result |
|---|-------|--------|
| 1 | All 8 placeholders deleted from R2 | PASS — both galleries verified `[]` mid-swap |
| 2 | Real photos uploaded in correct order | PASS — `-hero-` files landed at `gallery[0]` |
| 3 | Venue 1 final gallery length = 3 | PASS |
| 4 | Venue 3 final gallery length = 2 | PASS |
| 5 | Hero URL public HEAD (venue 1) | PASS — 200, `image/jpeg` via `images.venueportal.us` |
| 6 | Hero URL public HEAD (venue 3) | PASS — 200, `image/jpeg` via `images.venueportal.us` |
| 7 | Local `./photo-upload-batch/` folder removed | PASS — JPEGs live in R2 only, not the repo |

### Files touched

- R2 bucket `venue-photos` — 8 objects deleted, 5 objects created
- D1 `venues.gallery` — venue 1 array trimmed 4→0→3, venue 3 array trimmed 4→0→2
- `PUBLIC_SURFACE_V2_DIFF.md` — this section
- `./photo-upload-batch/` — removed (was untracked, never committed)

### Not touched

- `api.js`, `venue.html`, `inquiry-sent.html`, `index.html`, `dashboard.html` — pure data swap, no code change
- `booking-confirmed.html` — still left for legacy compatibility

---

## Commit D — new index.html with dynamic carousel + v2 design system

The largest commit in the public-surface rebuild. Replaces the 2,532-line legacy index.html (DM Sans / Syne / DM Mono fonts, tabbed-app shell, two hardcoded venue detail blocks with full calendar + booking modal stack, location selector) with a v2 marketing landing (Inter, pure black, orange accent) that fetches venues from /api/venues and routes clicks to venue.html with the venue id in the URL.

### Strategy
1. Backup committed first as 8da302d — index.html.backup-v1 is the rollback target.
2. All admin/login/users logic preserved byte-for-byte where possible; only colour vars and font family remapped.
3. Public landing is the default view for anonymous visitors. On admin login, JS hides the landing and swaps in #admin-shell. On venue_owner login, JS redirects to dashboard.html.
4. No hardcoded venue data anywhere. Carousel and spotlight fetch from /api/venues and render dynamically. Empty state pads with coming-soon placeholders.

### File metrics

|                | v1                       | v2          | delta     |
|----------------|--------------------------|-------------|-----------|
| Lines          | 2,532                    | 1,460       | -1,072    |
| External fonts | DM Sans + Syne + DM Mono | Inter       | 3 to 1    |
| Top-level shell| nav + 5 tabs             | Public landing OR admin shell (login-gated) | reshaped |
| Hardcoded venues | 2 (detail-cr, detail-ws) | 0         | full delete |
| Booking surface | In-page modal + calendar engine | Routes to venue.html | full delete |

### Audit-list verification (Step 5)

| Category | Items checked | Status |
|---|---|---|
| Global functions preserved/added | 37 (all unique) | All exactly-once present |
| IDs from JS targets (static ones) | 42 (all unique) | All exactly-once present in HTML |
| Admin-injected IDs (admin-venue-count, admin-venue-list, av-*, admin-booking-count, admin-revenue, admin-bookings-tbody, add-venue-form, av-owner-section) | rendered by renderAdminPanel() innerHTML at runtime, same as v1 | Preserved verbatim |
| CSS classes JS toggles | active, open, show, copied, panel, tab-btn | All have CSS rules |
| Dropped functions | showTab, openModal, closeModal, maybeCloseModal, submitBooking, toggleAcc, toggleAddForm, calPrev/Next, calState, initAllCals, renderCal, selectDate, galleryInit, gallerySetImage, galleryFullscreen, renderVenueOwnerPanel, loadVenueOwnerData, voChangeStatus, onLocationChange, onVenueChange, goToVenue, openVenue, backToSelector, resetToHome | All confirmed 0 occurrences |
| Dropped refs | VENUES, BY_LOCATION, detail-cr/ws, booking-confirmed.html | All confirmed 0 occurrences |

### What changed (per the locked spec answers)

**Q1 (Location selector):** REMOVED. The venue-selector-bar and related dropdowns are gone. Carousel is the only entry point.

**Q2 (Booking modal):** REMOVED. The v1 file had a full booking modal + calendar engine wired to the deleted detail blocks. Booking is now exclusively a venue.html concern. The booking POST contract is unchanged (identical payload to venue.html); API.createBooking() remains in the service layer as a public method should any future caller need it.

**Q3 (Tabbed shell to public landing + hidden admin shell):**
- #public-landing div = the v2 marketing landing (top nav, hero, dynamic carousel, owner CTA strip, value props, how-it-works, spotlight, footer, bottom-tab nav).
- #admin-shell div = hidden by default. On admin/superadmin login, showAdminShell() hides the landing and reveals this shell, which wraps the preserved #tab-admin + #tab-users panels and the three user-management modals.
- On venue_owner login: window.location.replace('dashboard.html') — index.html never renders the venue-owner panel anymore. All renderVenueOwnerPanel/loadVenueOwnerData/renderVenueOwnerBookings/voChangeStatus + vo-* IDs are deleted.
- On handleLogout(): clear session, hide admin shell, window.location.replace('/') for the anonymous landing.
- On page boot with active session: superadmin/admin auto-swaps to admin shell; venue_owner redirects to dashboard.

**Q4 (Fonts):** switched to Inter exclusively (matches venue.html, inquiry-sent.html, dashboard.html, onboard.html). --display, --mono, --sans all remap to Inter. Dropped Google Fonts request for DM Sans + Syne + DM Mono.

**Q5 (VENUES object):** DELETED. No surviving consumer.

**Reviews + About:** DROPPED. No equivalent sections in v2.

### What was added (NEW)

1. **renderCarousel()** — fetches /api/venues, renders one anchor.venue-card per live venue linking to venue.html?id=N. Hero image from gallery[0] when present, gradient placeholder otherwise. Pads with 3 coming-soon cards (LegacySound, Mark's Demo Studio, "List your venue") so the carousel always feels populated. Updates the hero eyebrow with live count + city list. Sets the spotlight section to the first live venue with stats and an "Explore venue" link.
2. **openLoginModal() / closeLoginModal()** — v2-styled login overlay replacing the v1 in-tab login panel. Opens from "Sign In" in top nav AND the bottom-tab "Sign In" item on mobile. Enter-to-submit wired on the password field via DOMContentLoaded.
3. **showAdminShell() / hideAdminShell() / showAdminTab(id)** — shell-swap helpers that replaced the old showTab() tab-router.
4. **Boot IIFE** — runs renderCarousel() always (anonymous visitors see live venues immediately), then checks session: venue_owner to dashboard.html; admin/superadmin auto-swap to admin shell; anonymous stay on landing.

### Onboarding funnel (per locked spec)

- "Sign In" (top nav + bottom-tab) opens login modal. Admin stays on index. Venue_owner redirects to dashboard.html.
- "Get Started" (top nav) AND "Get Onboarded" (CTA strip) AND footer links all route to /onboard.html (existing, untouched).
- No public signup endpoint. Account creation remains admin-driven via the preserved create-user modal.

### Preserved verbatim (byte-for-byte where possible)

- Session-expired banner IIFE
- API service layer (all 15 methods)
- apiFetch, all session helpers (getToken, setToken, clearSession, getRole, getName, getVenueId, etc.)
- renderAdminPanel (with its innerHTML template), loadAdminVenues, renderAdminVenueList, openAddVenueForm, closeAddVenueForm, startEditVenue, saveVenue, confirmDeleteVenue
- adminViewVenue — now opens venue.html?id=N in a new tab (Commit C surface)
- loadAdminBookings, renderAdminBookings, changeBookingStatus, removeBooking — revenue calc no longer references the deleted VENUES object; now uses apiVenues for price_per_day lookup on confirmed bookings only
- All user-management logic: loadUsers, create-user modal flow, password reset modal flow, delete user
- refreshUsersTabVisibility
- escHtml
- All three user-management modals (HTML structure + IDs identical)

### Booking POST contract — UNCHANGED

POST /api/bookings with { venue_id, client_name, client_email, event_date, guests, message }. The contract is exclusively exercised by venue.html now; index.html no longer submits bookings.

### Files touched

- index.html — full rewrite per spec (1,460 lines)
- index.html.backup-v1 — preserved rollback target (created in standalone commit 8da302d)
- PUBLIC_SURFACE_V2_DIFF.md — this section

### Not touched (per hard rules)

- api.js — no changes
- dashboard.html, venue.html, inquiry-sent.html, onboard.html, booking-confirmed.html, booking-cancelled.html, privacy.html, terms.html, legacysound-demo.html, studio-demo.html — untouched
- All *-v2-mockup.html source files — untouched
- D1 schema, R2 bucket — untouched

### Browser-side verification (for user)

Page loads (/index.html):
- Carousel populates with Chill Room + White Swan + 3 coming-soon cards
- Hero eyebrow reads "2 venues live ..." with the live city list
- Spotlight section pulled from first live venue with photo + stats
- Click either real card lands on venue.html?id=1 (or ?id=3)
- "Get Started" / "Get Onboarded" route to /onboard.html
- "Sign In" opens the login modal; submit credentials:
  - venue_owner is redirected to /dashboard.html
  - admin / superadmin: landing hides, admin panel renders with venues + bookings + (if superadmin) Users tab
- Admin "+ Create User" opens modal; generated credentials displayed
- Admin "Sign out" reloads to anonymous landing
- Mobile (375px): nav collapses, carousel scroll-snaps, bottom-tab nav visible, all CTAs at least 44px tap targets

### Follow-up filed (NOT part of D)

- **Commit F (future)**: extract admin panel from index.html into a dedicated /admin.html with its own v2 design and redirect admins there on login (mirrors the venue_owner -> dashboard.html split).
- **Cleanup commit (future)**: delete index.html.backup-v1 once Commit D is verified live for 48hrs.

---

## Commit D fix-up #1 — carousel photos, entrance animations, onboard.html v2 refresh

Three coordinated fixes following in-browser review of Commit D.

### Fix 1 — Carousel photos (root cause + fix)

**Reported**: Carousel on the new index.html showed both real venues with gradient placeholders, not real photos. Meanwhile venue.html?id=1 and ?id=3 rendered the real hero photos correctly.

**Root cause**: The API endpoints behave differently by design:
- `GET /api/venues` (list) returns only `id, name, description, capacity, price_per_day, image_url, created_at` — **no gallery, no amenities, no hours**. Lightweight.
- `GET /api/venues/:id` (single) returns the full object including `gallery` (R2 URLs), `amenities`, `hours`.

`renderCarousel()` was hitting the lightweight list endpoint, so `v.gallery` was always undefined and the cards always fell through to the gradient fallback.

**Fix**: In `renderCarousel()`, after fetching the list, fire one `GET /api/venues/:id` per row in parallel via `Promise.allSettled`, then map to the enriched row. If any enrichment fails, fall back to the lightweight list row gracefully. Two parallel requests for the current venue count is cheap and stays inside the existing API contract (no `api.js` change).

```js
const list = await API.getVenues() || [];
const enriched = await Promise.allSettled(list.map(v => API.getVenue(v.id)));
venues = list.map((v, i) => {
  const r = enriched[i];
  return (r.status === 'fulfilled' && r.value && !r.value.error) ? r.value : v;
});
```

Also added a console.log line summarising `{ id, gallery_len }` per venue for in-browser debugging.

### Fix 2 — Entrance animations on index.html

Added the same `@keyframes fadeInUp` pattern used in venue.html (translateY 16px to 0, opacity 0 to 1, 600ms ease, both fill). Stagger classes `.anim-d0` through `.anim-d6` (0–600ms in 100ms steps).

Sections decorated:

| Section | Class | Delay |
|---|---|---|
| Hero | `anim-fade-up anim-d0` | 0ms |
| Carousel wrap | `anim-fade-up anim-d1` | 100ms |
| Value props | `anim-fade-up anim-d2` | 200ms |
| How it works | `anim-fade-up anim-d3` | 300ms |
| Spotlight | `anim-fade-up anim-d4` | 400ms |
| Owner CTA strip | `anim-fade-up anim-d5` | 500ms |
| Footer | `anim-fade-up anim-d6` | 600ms |

`@media(prefers-reduced-motion:reduce)` disables the animation. CSS-only — no JS required since classes are present on initial render.

### Fix 3 — Full v2 refresh of onboard.html

Visual layer fully swapped to match the v2 design system (matches index.html, venue.html, inquiry-sent.html, dashboard.html).

**What changed**:
- Background `#111` → `#000`; surfaces `#161412/#1e1b17` → `#0a0a0a/#141414`; borders shifted to `#1f1f1f/#2a2a2a`.
- Orange `#f5a623` (amber) → `#ff6b1a` (warm orange) — matches the rest of the platform.
- Typography: dropped Syne + DM Sans + DM Mono Google Fonts request. Now Inter only. All `var(--display)`, `var(--mono)`, `var(--sans)` references gone; visual hierarchy now comes from `font-weight` (400/500/600/700/800/900), `letter-spacing`, and `font-size`.
- Removed the BETA badge (out of place — platform is past beta-vibe positioning).
- Removed the legacy stripe-gradient body decoration (`body::before`/`body::after` background art).
- New top nav: chevron + "Venue.Portal" wordmark on the left, "← Back to home" link on the right routing to `/`. Matches the top nav pattern in index.html / venue.html / dashboard.html.
- Hero eyebrow restyled as an orange pill ("List your venue") matching the eyebrow on venue.html.
- Hero title bumped to 34px / 42px (mobile / desktop), letter-spacing `-1.5px` on desktop. Matches v2 heading scale.
- Cards: `--radius-lg: 14px` (was 10px), padding `22px` (was 20px), tighter card-title styling (matches the section labels on other pages).
- Form inputs: `min-height: 44px` (was implicit ~36px), input bg switched to `--bg` so they read as a darker well inside the lighter card (matches dashboard's Edit Profile form pattern).
- Amenity options: `min-height: 42px`, font 12px, checked-state uses the v2 accent-soft background + accent border + bolder check text.
- Submit button: black text on orange, `min-height: 50px`, font-weight 800, matches the primary CTA pattern across the platform.
- Success state: green check-circle 64px with pulsing ring animation (matches the inquiry-sent.html success-circle treatment); heading bumped to 26px / 900 weight.
- Added `@keyframes fadeInUp` + stagger classes — hero (d0), 5 cards (d1–d5), submit wrap (d6). `prefers-reduced-motion:reduce` disables.

**What was preserved (verbatim where possible)**:
- All 14 form field IDs: `f-name`, `f-address`, `f-capacity`, `f-price`, `f-hours`, `f-desc`, `f-rules`, `f-photos`, `f-video`, `f-cname`, `f-cemail`, `f-cphone`, `f-notes`, `amenity-grid` — verified each exists exactly once.
- AMENITIES array — byte-identical (15 options, same order).
- POST body shape — all 14 keys identical (`venue_name`, `address`, `capacity`, `price_per_day`, `hours`, `description`, `house_rules`, `amenities`, `photo_links`, `video_url`, `contact_name`, `contact_email`, `contact_phone`, `additional_notes`).
- POST endpoint — `https://thevenueportal.paxey333.workers.dev/api/onboard`, unchanged.
- Validation logic — required-field checks + email regex unchanged.
- Success state copy and structure preserved (just visually restyled).
- Field names, placeholders, autocomplete attributes — all preserved.

### Files touched

- `index.html` — `renderCarousel()` enrichment + `@keyframes fadeInUp` + stagger classes on 7 sections (1,476 lines, was 1,460)
- `onboard.html` — full visual rewrite (350 lines, was 327; functional layer byte-identical)
- `PUBLIC_SURFACE_V2_DIFF.md` — this section

### Not touched (per hard rules)

- `api.js` — no changes. Carousel enrichment uses existing public `GET /api/venues/:id` endpoint.
- `venue.html`, `dashboard.html`, `inquiry-sent.html`, `booking-confirmed.html` — untouched.
- Onboard POST contract — byte-identical payload shape.
- AMENITIES array — byte-identical contents and order.
- Form field IDs and validation logic — unchanged.

### Browser-side verification (for user)

- Visit `/` (incognito) → carousel cards show **real photos**: band shot for Chill Room (id=1), stage shot for White Swan (id=3). Plus 3 coming-soon placeholders.
- Open DevTools console → see `[index] carousel venues [{id:1, gallery_len:3},{id:3, gallery_len:2}]`.
- First paint → sections fade in with stagger (hero first, footer last).
- Visit `/onboard.html` → new v2 black background, orange `#ff6b1a` accents, Inter throughout, chevron logo top-left, "← Back to home" top-right. BETA badge gone.
- Fill out a test submission with "TEST_FIXUP" in venue name → confirms submit + success state renders with v2 styling.
- Mobile (375px): both pages collapse cleanly, no horizontal scroll, all tap targets ≥ 44px.

---

## Commit D fix-up #2 — carousel framing + Browse-tab scroll-to-top

Two small mobile-polish fixes after in-browser review of D.1.

### Fix 1 — Carousel card photo framing

**Reported**: Carousel cards on index.html showed real photos (D.1 fix worked) but the photos rendered with inconsistent crops/aspect ratios — Chill Room's portrait band shot dictated card height, White Swan's landscape stage shot fit differently, cards felt visually inconsistent.

**Root cause**: `.vc-img` already had `aspect-ratio:4/3` set, but the inner `<img>` only had `width:100%;height:100%;object-fit:cover;display:block` (from the global `.ph` block). With `aspect-ratio` on the parent, some browsers/edge cases still let the intrinsic image dimensions influence layout — particularly when the img isn't strictly contained.

**Fix**: Lock the img to absolute positioning inside the aspect-ratio container so it's guaranteed to fill the 4:3 frame regardless of intrinsic dimensions:

```css
.vc-img{aspect-ratio:4/3;width:100%;position:relative;overflow:hidden}
.vc-img img{position:absolute;inset:0;width:100%;height:100%;
            object-fit:cover;object-position:center;display:block}
```

Added `overflow:hidden` on the parent for belt-and-suspenders cropping; `object-position:center` ensures the most important part of the photo (typically the subject) stays visible after cover-cropping.

Card body layout (text below photo) is unaffected — the card was already a flex column with `.vc-body` taking remaining space.

### Fix 2 — Bottom-nav Browse tab: tap to scroll-to-top

**Pattern**: Standard mobile-app UX — tapping the active tab again scrolls to top.

**Implementation**:
- Browse was a `<a href="#carousel">` anchor. Converted to `<button type="button" onclick="browseTabTap()" aria-label="Scroll to top">`.
- New JS handler:
  ```js
  function browseTabTap() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  ```
- No-op at the top (smooth-scroll to position 0 from position 0 is a harmless no-visible-change call).
- Other bottom-tab items unchanged: How (anchor to `#how`), For owners (anchor to `/onboard.html`), Sign In (opens login modal).

### Files touched

- `index.html` — `.vc-img` CSS hardening (+1 rule, ~2 lines), Browse anchor → button conversion, new `browseTabTap()` helper (~6 lines total). Net ~+10 lines.
- `PUBLIC_SURFACE_V2_DIFF.md` — this section

### Not touched (per hard rules)

- `api.js`, `venue.html`, `dashboard.html`, `onboard.html`, `inquiry-sent.html`, `booking-confirmed.html` — untouched
- No new endpoints, no third-party libs

### Browser-side verification (for user)

- Mobile (375px): all 5 carousel cards render at identical 4:3 aspect ratios — Chill Room band shot is cover-cropped, White Swan stage shot is cover-cropped, both look visually consistent. No card taller/shorter than its siblings.
- Desktop (≥1280px): same consistent framing at larger size, 4 cards visible per row, each at 4:3.
- Mobile, scrolled halfway down: tap **Browse** in bottom nav → page smooth-scrolls to top.
- Mobile, already at top: tap **Browse** → no visible change, no error in console.
- Other bottom-tab items (How / For owners / Sign In) behave as before.
