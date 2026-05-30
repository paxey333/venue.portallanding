# Public Surface Rebuild — Change Log

The public surfaces (`index.html` landing + the hardcoded `#detail-ws` / `#detail-cr` venue detail blocks + the eventual `venue.html?id=X`) are being rebuilt in 5 sequential commits to match the dashboard v2 visual system (pure black / Inter / `#ff6b1a` orange).

| Commit | Status | Scope |
|--------|--------|-------|
| **A — White Swan D1 seed** | ✅ Done | Reconcile White Swan into D1; wire `VENUES.ws.id` in index.html |
| B — Photo upload (R2) | pending | Add R2 bucket + upload UI for venue galleries |
| C — `venue.html?id=X` | pending | New dynamic public venue page using the dashboard v2 visual system |
| D — Remove `#detail-cr` / `#detail-ws` hardcoded blocks | pending | Once `venue.html` is live, replace inline blocks with redirects |
| E — Index landing v2 swap | pending | Swap `index.html` to the v2 mockup layout |

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
