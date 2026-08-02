# DATA.1 — Pre-cleanup backup & inventory (READ-ONLY, no deletes)

Date: 2026-08-02 · DB: `venue-portal-db` (`5253aacd-dc38-4de0-9bc8-20062e0b3193`) · all queries `--remote`.
This pass deleted nothing. No DELETE/DROP/UPDATE run. Snapshot of production state before cleanup.

> Note: this record contains customer/inquirer emails (data controller: account owner, private repo).
> The raw `.sql` dump is stored OUTSIDE the repo/OneDrive tree and is NOT committed.

## Step 1 — Backup (verified)
- Path (outside OneDrive): `C:/Users/gabri/vp-backups/vp-d1-20260802-1353.sql`
- Size: **41,105 bytes** · Lines: **188**
- Verified row counts in dump (INSERT statements): `venues 6`, `users 7`, `bookings 7`, `venue_blocks 95`, `venue_availability_rules 28`
- Tables in dump: admins, api_tokens, bookings, calendar_tokens, events, users, venue_availability_rules, venue_blocks, venues

## Query errors (reported, not massaged)
- Prompt query 1 (`SELECT ... status ... FROM venues`) FAILED: `no such column: status` (SQLITE_ERROR 7500). `venues` has no `status` column; real state columns are `hidden` (0/1) and `stripe_connected`. Re-ran with real columns below.

## Step 2 — Inventory

### 1. Venues (real columns)
| id | name | city | state | hidden | stripe_connected | stripe_account_id | created_at |
|----|------|------|-------|--------|------------------|-------------------|------------|
| 1 | The Chill Room | Tempe | AZ | 0 | 1 | acct_1TgpsVJK06eMjDaA | 2026-04-28 |
| 3 | White Swan Live | Houston | TX | 0 | 0 | (null) | 2026-05-08 |
| 4 | Pax Test Venue | TEST | TEST | 1 | 0 | (null) | 2026-07-01 |
| 5 | Origin Boutique Nightclub | San Francisco | CA | 0 | 1 | (null) ⚠ | 2026-06-27 |
| 6 | Pax Test Venue 2 | TEST | TEST | 1 | 0 | (null) | 2026-07-01 |
| 8 | Trapbaby Worldwide - DTLA | Los Angeles | CA | 0 | 0 | (null) | 2026-07-26 |

(no venue_id 2 or 7 — gaps.) ⚠ venue 5: `stripe_connected=1` but `stripe_account_id` null (inconsistent).

### 2. Users
| id | email | role | venue_id | name | created_at |
|----|-------|------|----------|------|------------|
| 9 | whiteswanlive@venueportal.us | venue_owner | 3 | whiteswanlive | 2026-05-22 |
| 11 | sal@thechillroomtempe.com | venue_owner | 1 | Sal | 2026-06-11 |
| 12 | testowner@venueportal.us | venue_owner | 4 | Test Owner | 2026-06-24 |
| 13 | mossjr1126@gmail.com | admin | (null) | Mark | 2026-06-24 |
| 14 | owner@originsf.com | venue_owner | 5 | Origin SF | 2026-06-27 |
| 15 | testowner2@venueportal.us | venue_owner | 6 | Test Owner 2 | 2026-07-01 |
| 16 | testadmin@venueportal.us | admin | (null) | Test Admin | 2026-07-15 |

Venue 8 has NO owner login. Admins 13 & 16 have no venue.

### 3. Bookings (full) — NB: every `stripe_session_id` is NULL
| id | venue_id | client_name | client_email | event_date | guests | status | total_amount | stripe_session_id | created_at |
|----|----------|-------------|--------------|------------|--------|--------|--------------|-------------------|------------|
| 40 | 3 | bob | paxey333@gmail.com | 2026-06-27 | 150 | expired | 50000 | null | 2026-06-03 |
| 44 | 3 | bob | paxey333@gmail.com | 2026-06-13 | 42 | expired | 50000 | null | 2026-06-10 |
| 45 | 1 | Alex Rivera | laxatories@gmail.com | 2026-06-13 | 90 | declined | 50000 | null | 2026-06-10 |
| 46 | 1 | Jadyn | paxey333@gmail.com | 2026-06-28 | 100 | declined | 50000 | null | 2026-06-19 |
| 50 | 5 | Test Inquiry | paxey333@gmail.com | 2026-06-30 | 120 | confirmed | 50000 | null | 2026-06-30 |
| 53 | 5 | test | paxey333@gmail.com | 2026-07-01 | 90 | expired | 50000 | null | 2026-07-01 |
| 61 | 8 | Paxey | paxey333@gmail.com | 2026-07-30 | 95 | accepted | 50000 | null | 2026-07-28 |

### 4. Bookings grouped (venue_id, status, n)
1/declined:2 · 3/expired:2 · 5/confirmed:1 · 5/expired:1 · 8/accepted:1

### 5. venue_blocks (venue_id, n)
1:92 · 3:2 · 5:1  (total 95; none for 4,6,8)

### 6. venue_availability_rules (venue_id, n)
1:7 · 3:7 · 6:7 · 8:7  (total 28; none for 4,5)

### 7. events (ticketing) + calendar_tokens
Events (2), both `venue_id = NULL` (platform-hosted, reference no venue):
| id | slug | title | host_type | venue_id | status |
|----|------|-------|-----------|----------|--------|
| 6 | la-underground-summer-smash | LA Underground Summer Smash | platform | null | published |
| 13 | lackvill-blackedy-live-in-los-angeles | LACKVILL & BLACKEDY - Live in Los Angeles | platform | null | published |

calendar_tokens: venue 1 → 2 (none for other venues).

## FK paths (cascade planning — CRITICAL)
References INTO `venues(id)`:
- `venue_blocks.venue_id` → **ON DELETE CASCADE**
- `venue_availability_rules.venue_id` → **ON DELETE CASCADE**
- `calendar_tokens.venue_id` → **ON DELETE CASCADE**
- `events.venue_id` → ON DELETE SET NULL (all currently null)
- `users.venue_id` → ON DELETE SET NULL (owner login would be orphaned, not deleted)
- `bookings.venue_id` → **NO FK CONSTRAINT** (plain INTEGER). Deleting a venue does NOT cascade or null its bookings — they ORPHAN. **Bookings must be deleted explicitly.**

References INTO `bookings`: none. `bookings` is a leaf (nothing references booking id).

D1 enforces FKs by default, so CASCADE/SET NULL will fire on venue delete — except bookings (no constraint).

## Step 3 — Per-venue flags
| venue | name | owner login? | real money (stripe_session_id)? | stripe onboarding | R2 photos (gallery ref) | context disposition |
|-------|------|--------------|--------------------------------|-------------------|-------------------------|---------------------|
| 1 | The Chill Room (Tempe AZ) | YES (user 11 Sal) | NONE | connected, acct_1Tgps… | 3 | **KEEP — real paying customer, do NOT touch any row** |
| 3 | White Swan Live (Houston TX) | YES (user 9) | NONE | no | 2 | cleanup candidate |
| 4 | Pax Test Venue (TEST) | YES (user 12) | NONE | no | 0 | cleanup candidate (test) |
| 5 | Origin Boutique Nightclub (SF CA) | YES (user 14) | NONE | connected=1 / acct null ⚠ | 6 | cleanup candidate (1 "confirmed" booking, self-email, no Stripe session) |
| 6 | Pax Test Venue 2 (TEST) | YES (user 15) | NONE | no | 0 | cleanup candidate (test) |
| 8 | Trapbaby Worldwide - DTLA (LA CA) | NO | NONE | no | 5 | **KEEP venue (WIP); Stripe + owner login stay unset** |

Admins not tied to a venue: user 13 (Mark), user 16 (Test Admin).

## Real-customer-data flags
- **No booking anywhere has a `stripe_session_id`** — by that metric, no real money ever touched a booking row. (Venue 1 DID complete Stripe onboarding: `stripe_connected=1`, real `acct_…`.)
- Only non-owner/real-person booking email: **booking 45** (venue 1) `laxatories@gmail.com` / "Alex Rivera", status declined. It sits on venue 1, which is KEEP regardless.
- Every other booking email is `paxey333@gmail.com` (owner's own test inquiries).

## R2 (venue-photos bucket)
- Bucket total: **44 objects / 20.6 MB**. Gallery-referenced across venues: **16**. Remainder (~28) = event photos (`events/<slug>/…`) + possible orphaned objects. wrangler cannot list R2 objects per prefix (only get/put/delete); full per-prefix enumeration needs the S3 API or dashboard.

## Step 4 — STOP
Inventory posted. Awaiting explicit row IDs to delete and a cascade order. Nothing deleted this pass.
