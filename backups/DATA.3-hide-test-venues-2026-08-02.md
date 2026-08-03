# DATA.3 — Hide two publicly-visible test venues (direct D1 write, 2026-08-02)

Two test venues were created and left publicly visible on venueportal.us. `hidden=1` set via
direct D1 write (by id, explicit — no name matching).

## Audit (read-only, before)
| id | name | city | state | hidden |
|----|------|------|-------|--------|
| 1 | The Chill Room | Tempe | AZ | 0 (KEEP, visible) |
| 5 | Origin Boutique Nightclub | San Francisco | CA | 0 (KEEP, visible) |
| 8 | Trapbaby Worldwide - DTLA | Los Angeles | CA | 0 (KEEP, visible) |
| 9 | Test Venue 2 | Tempe | Arizona | 0 -> **target** |
| 10 | test venue 3 | Los Angeles | California | 0 -> **target** |

## Write
`UPDATE venues SET hidden = 1 WHERE id IN (9, 10);` -> **changes = 2** ✓

## Verify (after)
- Re-select: ids 9,10 `hidden=1`; ids 1,5,8 `hidden=0` (unchanged) ✓
- Public `GET /api/venues` -> ids [1,5,8] only (list excludes hidden via `WHERE hidden IS NOT 1`, api.js:656) ✓
- Public `GET /api/venues/{9,10}` -> **404**; `{1,5,8}` -> 200 (api.js:719 returns 404 for hidden when `!isOwnerOrAdmin`) ✓
- Admin/owner sessions STILL load 9,10 — the api.js:719 gate is bypassed for `isOwnerOrAdmin` (verified by code; no admin token available to test live)
- venueportal.us carousel renders only The Chill Room / Origin / Trapbaby; the two test venues gone ✓

## Correction to the task premise
The venue PATCH **does already accept `hidden`** for admin sessions — api.js:764:
`if ('hidden' in body && isAdminOrAbove(session)) { fields.push('hidden=?'); values.push(body.hidden ? 1 : 0); }`
So the API half of the follow-up exists. The actual remaining gap is the missing admin.html UI toggle.

## Follow-up (logged, NOT done this pass — its own commit)
Add a hidden/published toggle to the venue row in admin.html wired to the existing PATCH `hidden` field,
so visibility isn't managed by raw SQL. (API support already present; only the UI is missing.)
