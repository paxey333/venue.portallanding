# DATA.2 — Production cleanup record (DESTRUCTIVE, executed 2026-08-02)

Live D1 `venue-portal-db`. Before-state: see `DATA.1-pre-cleanup-inventory-2026-08-02.md`.
Backup gate: `C:/Users/gabri/vp-backups/vp-d1-20260802-1353.sql` re-verified present at **41,105 bytes** before first DELETE.
All target rows re-confirmed against the DATA.1 snapshot (identical) before any delete.

## DATA.2a — bookings
`DELETE FROM bookings WHERE id IN (40,44,45,46,50,53,61);` → **changes = 7** ✓ · `SELECT COUNT(*) FROM bookings` → **0** ✓
(Deleted first/explicitly because `bookings.venue_id` has no FK — would otherwise orphan.)

## DATA.2b — venues 3,4,6 + owner logins
Owner-login deletes FIRST (by id, so no orphaned NULL-venue_id venue_owner rows):
- `DELETE FROM users WHERE id IN (9,12,15);` → **changes = 3** ✓ (whiteswanlive/v3, Test Owner/v4, Test Owner 2/v6)
- `DELETE FROM users WHERE id = 16;` → **changes = 1** ✓ (Test Admin, testadmin@venueportal.us) — user 13 (Mark) NOT touched.
- `DELETE FROM venues WHERE id IN (3,4,6);` → **changes = 19**

### Note on changes = 19 (not 3)
D1's `meta.changes` **includes FK-cascade deletes**. Breakdown: 3 venues + 16 cascaded children
(venue 3: 2 blocks + 7 rules = 9; venue 6: 7 rules; venue 4: 0) = 19. The prompt's "exactly 3"
did not account for cascade counting. Verified the deletion hit *only* venues 3/4/6:
- Venues remaining: **1, 5, 8** (exactly 3 removed).
- Cascade cleared for 3/4/6: blocks 0, rules 0, calendar_tokens 0.
- KEEP intact: v1 blocks 92, v5 blocks 1, v1 rules 7, v8 rules 7, v1 caltok 2.

## DATA.2c — R2 photos (venue 3 only)
Exact keys pulled from the backup (full gallery): deleted by explicit key, no prefix wipe.
- `venue-photos/3/1780303862937.jpg` → deleted (public URL now HTTP 404) ✓
- `venue-photos/3/1780303863373.jpg` → deleted (public URL now HTTP 404) ✓
- Control (untouched) `venue-photos/1/1780535764028.png` → HTTP 200 (intact) ✓

Anomaly logged: `wrangler r2 object get` kept re-serving file 1 from a **local cache** (an earlier probe
download), falsely implying it survived. Confirmed actual remote state via the public R2 URL (404 both).
`r2 bucket info object_count` is eventually-consistent and still read 44 immediately after; not authoritative.

Out of scope (logged follow-up): bucket holds ~44 objects, only ~14 now referenced by remaining venue
galleries; the rest are event photos + probable orphans. Enumerating/pruning needs the S3 API or dashboard.

## AFTER-STATE inventory (cleaned DB)
- venues (3): `1 The Chill Room (Tempe AZ, stripe_connected 1)`, `5 Origin Boutique Nightclub (SF CA, stripe_connected 1)`, `8 Trapbaby Worldwide - DTLA (LA CA, stripe_connected 0)`
- users (3): `11 Sal (venue_owner, v1)`, `13 Mark (admin, null)`, `14 Origin SF (venue_owner, v5)` — no orphaned venue_owner
- bookings: **0**
- venue_blocks: v1=92, v5=1
- venue_availability_rules: v1=7, v8=7
- calendar_tokens: v1=2
- events: id 6 & 13, both venue_id NULL, published (unchanged)

## Separate finding (NOT fixed here — own commit later)
Venue 5: `stripe_connected = 1` but `stripe_account_id = NULL`. Audit whether the checkout path gates on
the boolean vs the account id; a null-account charge risk. Its own commit.
