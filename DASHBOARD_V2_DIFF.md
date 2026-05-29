# Dashboard v2 — Visual Swap Diff (HTML + CSS, plus one explicit script-line deviation)

**Commit scope (initial swap):** purely visual. Zero JavaScript changes. Zero API changes. Zero data model changes.

**Backup file:** `dashboard.html.backup-v1` (kept in repo for one-step rollback).

---

## Script byte-preservation history

| Commit | Script SHA256 | Length | Reason for change |
|--------|---------------|--------|-------------------|
| `dashboard.html.backup-v1` (v1) | `7865c5e6475990fbd3758c4192a2a4f6cab544fd10e08e6f1f178e9e103cbd84` | 42,933 | baseline |
| `76a9956` v2 swap | `7865c5e6...103cbd84` | 42,933 | **byte-for-byte identical** ✅ |
| `eec86d8` v2 fix-up #1 (calendar/hero/admin/chart) | `7865c5e6...103cbd84` | 42,933 | **byte-for-byte identical** ✅ |
| `141eb36` v2 fix-up #2 (logout/label/quotes) | `d4505e9a49d10481537b079fade7159481418427c66199f43d36207f19f70417` | 42,954 | **deliberate +21 chars** — inquiry-note conditional |
| `d34fd01` v2 fix-up #3 (onclick audit) | `d4505e9a...19f70417` | 42,954 | **byte-for-byte identical to fix#2** ✅ HTML/CSS only |
| `<this commit>` v2 fix-up #4 (edit-profile classes) | `d4505e9a...19f70417` | 42,954 | **byte-for-byte identical to fix#2** ✅ HTML/CSS only |

## Fix-up #4 — Edit profile field IDs / class binding (HTML only)

**Reported symptoms:** Edit Profile opens form with empty fields. Save Changes shows "Venue name is required" and never persists.

**Root cause (not the field IDs — every input ID matched v1 exactly):** Fix-up #3 added CSS rules that use *class* selectors:
```css
.profile-display.hidden{display:none}
.profile-edit-form{display:none}
.profile-edit-form.active{display:block}
```
but the corresponding elements only had `id="..."` and **no class attribute**. So:
- `<div id="profile-display">` was never targeted by `.profile-display.hidden` — display state could not toggle
- `<form id="profile-edit-form">` was never targeted by `.profile-edit-form` — form was always visible at default-block display, never animated/hidden by JS class toggling

When the user clicked "Edit profile":
- The form was already on-screen (CSS didn't hide it)
- `startProfileEdit()` ran, wrote `currentVenue.*` into the input `.value` slots correctly
- But the user perceived the click as "opening" a form that was actually always there
- If `currentVenue` hadn't fully loaded yet (race vs `loadVenueProfile()`), fields read as empty
- Save was wired correctly but body.name was empty → guard at line 1274 returned with "Venue name is required"

**Fix (HTML/CSS only, zero script touch):**
- Added `class="profile-display"` to `<div id="profile-display">`
- Added `class="profile-edit-form"` to the edit form element
- Changed `<form id="profile-edit-form">` → `<div class="profile-edit-form" id="profile-edit-form">` to match v1's structure exactly (also avoids the form-element implicit-submit-on-Enter UX bug)
- Changed `<input id="edit-video" type="url">` back to `type="text"` (matches v1 — `type="url"` triggers browser URL validation that can interfere with arbitrary input values)

**Every form input ID was already correct** — the field IDs matched v1 1:1 (edit-name, edit-location, edit-capacity, edit-price, edit-hours, edit-description, edit-video, edit-gallery, amenity-toggle-grid, edit-save-err). The bug was purely the missing class attribute that gates the CSS-driven show/hide.

**Verification:** all 4 JS-toggled class targets (`profile-display`, `profile-edit-form`, `modal-overlay`, `modal-success`) confirmed present as class attrs in HTML. Script SHA256 unchanged.

## Fix-up #3 — Complete onclick audit (HTML/CSS only)

Programmatic comparison of every `onclick="..."` attribute between `dashboard.html.backup-v1` and the post-v2-swap `dashboard.html`. The v2 body rewrite dropped **10 onclick attributes** (the Log Out + Admin-back ones from fix-up #2 were the first 2 of this larger gap — the audit found the remaining 10 plus required class/CSS scaffolding for several JS-toggle patterns).

### Onclick attributes restored in fix-up #3

| Element | Restored onclick |
|---------|------------------|
| Calendar `‹` chevron | `shiftCalMonth(-1)` |
| Calendar `›` chevron | `shiftCalMonth(1)` |
| `#edit-btn` Edit profile button | `startProfileEdit()` |
| Save changes button (inside `#profile-edit-form`) | `saveProfileEdit()` |
| Cancel button (inside `#profile-edit-form`) | `cancelProfileEdit()` |
| Update password button (inside `#pw-modal-body`) | `submitPassword()` |
| `#mnav-inquiries` | `scrollToSection('inquiry-section')` |
| `#mnav-calendar` | `scrollToSection('cal-card-section')` |
| `#mnav-bookings` | `scrollToSection('booking-section')` |
| `#mnav-profile` | `scrollToSection('profile-section')` |

After this commit: **12 onclicks in HTML body, matching v1 exactly. Zero missing, zero extra.**

`toggleAmenity(this, '...')` was intentionally NOT a static-HTML restoration — it's attached by the preserved JS inside `renderAmenityToggles()` (line 1123) as part of the dynamically generated `.amenity-toggle` button HTML. Confirmed wired through CSS additions below.

### CSS additions needed to make the restored onclicks functional

The JS uses class-based show/hide patterns (`classList.add('hidden')`, `add('open')`, etc.) that v1's CSS supports but the v2 swap dropped. Restored:

- `.profile-display.hidden{display:none}`
- `.profile-edit-form{display:none}` + `.profile-edit-form.active{display:block}`
- `.profile-edit-form input/textarea` field styling
- `.modal-overlay{display:none; ...positioning...}` + `.modal-overlay.open{display:flex}`
- `.modal-success{display:none}` + `.modal-success.visible{display:block}`
- `.amenity-toggle` base + `.amenity-toggle.active` (orange tint)
- Password modal frame (`.pw-card`, `.pw-header`, `.pw-field`, `.pw-success-label`)

### HTML structure additions

- `#pw-modal` got `class="modal-overlay"` and a proper `.pw-card` frame with labeled inputs, error placeholder, and the Update Password button — replaces the bare-input placeholder from the v2 swap.
- `#profile-edit-form` lost the inline `style="display:none"` (now CSS-controlled via `.active`), got per-field labels and the Save / Cancel action row.
- `#pw-success` got `class="modal-success"` and inner success copy.

### The one deliberate script-line change in this commit

Inside `renderInquiries()`, the inquiry-note template was unconditionally wrapping `q.message` in quotes, which produced literal `""` (empty quotes) when a promoter submitted an inquiry with no note. User-approved single-line fix:

```diff
- <div class="inquiry-note">"${esc(q.message || '')}"</div>
+ <div class="inquiry-note">${q.message ? '"' + esc(q.message) + '"' : ''}</div>
```

Net script delta: +21 chars across one line. No new functions, no new API calls, no data-flow changes — just a conditional around presentation. All other 913 script lines unchanged.

---

## Verification gates that passed for the v2 visual swap

1. **All 87 wiring-map IDs present** in new `dashboard.html`, each appearing exactly once in the rendered DOM.
   - `btn-stripe-connect` literally appears twice in the file but only once in the body markup; the second occurrence is inside a JS template string at line 1279 (preserved from backup) that overwrites `#stripe-block.innerHTML` based on Stripe connection state. Only one of these is in the live DOM at any moment.

2. **External dependency unchanged** in execution chain:
   - Chart.js v4 UMD bundle still loaded from `cdn.jsdelivr.net` (same line as before)

---

## Changed

### Fonts
- **REMOVED:** `https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@400;600;700;800&family=DM+Sans:wght@300;400;500;600&display=swap`
- **ADDED:** preconnect to `fonts.googleapis.com` + `fonts.gstatic.com`, then `Inter:wght@400;500;600;700;800;900`

### CSS variables (in `:root`)
| Var | Old (v1) | New (v2) |
|-----|----------|----------|
| `--bg` | `#13161f` | `#000000` |
| `--surface` | `#1a1f2e` | `#0a0a0a` |
| `--surface2` | `#1e2535` | `#141414` |
| `--border` | `#252b3b` | `#1f1f1f` |
| `--border2` | `#2e3548` | `#2a2a2a` |
| `--text` | `#f0f0f0` | `#ffffff` |
| `--text2` | `#7a8499` | `#a8a8a8` |
| `--text3` | `#3d4560` | `#666666` |
| `--accent` | (white-ish) | `#ff6b1a` (orange) |
| `--accent-soft` | — | `rgba(255,107,26,0.12)` |
| `--green` | `#4ade80` | `#3ddc84` |
| `--green-soft` | — | `rgba(61,220,132,0.12)` |
| `--alert` | — | `#ff4444` |
| `--alert-soft` | — | `rgba(255,68,68,0.12)` |
| `--mono` / `--sans` / `--display` | `DM Mono` / `DM Sans` / `Syne` | all → `Inter, sans-serif` |

### `<style>` block — fully rewritten (320 → ~280 lines)
- All visual rules replaced. Old class names like `.modal-card`, `.acc-body`, `.cal-day`, `.stat-card`, `.btn-book`, `.booking-card`, `.inquiry-card` retained where the JS depends on them; visuals updated.
- New utility classes added: `.dashboard-hero`, `.hero-pill`, `.hero-flyer-art`, `.quick-pills`, `.pill`, `.pill-count`, `.stat-trend`, `.stat-spark`, `.achv-card`, `.feature-preview`, `.fp-checklist`, `.entity-profile`, `.profile-avatar`, `.profile-stat`, `.booking-flyer` (.grad-1…4)

### `<body>` HTML structure — rewritten
- Header: now sticky 60px nav with chevron logo + venue name (with `#verified-check` badge) + greeting + admin badge + Log Out
- New section: `#hero-strip` — currently renders **only the quiet state inline** ("Your calendar is open" + "Add availability →" orange CTA). The active state (upcoming booking within 72h) is intentionally NOT in the static HTML; it'll be injected by JS in a follow-up commit by overwriting `#hero-strip.innerHTML`.
- New section: `#quick-pills` — horizontal scroll row of count pills
- Stats overview: top accent bar + trend delta span + inline SVG sparkline per card
- New section: achievements strip (3 gradient cards)
- Inquiries: avatar block (first-letter-of-each-of-first-2-words) + amount on right + redesigned action button row
- New section: `#artist-workflow-preview` — feature announcement, purely visual
- Calendar + Stripe row: side-by-side grid (collapses on mobile). `#stripe-block` defaults to disconnected state inline (the script overwrites it based on `/api/stripe/status/:id`)
- Bookings: flyer-art panel on left (gradient + Mo/Day stack) + body + amount right
- Revenue chart: same `<canvas id="revenue-chart">`, new card frame
- Profile: bigger gradient avatar with `#verified-check` overlay, tier badge, 4-stat grid
- Mobile nav: orange active state, cleaner outline icons, safe-area-inset padded
- Footer: same `#site-footer`, updated to new palette

---

## Preserved

### `<script>` block — **byte-for-byte identical**
Verified via SHA256. All JS unchanged:
- All function definitions (`renderStats`, `renderBookings`, `renderInquiries`, `loadVenueProfile`, `saveProfileEdit`, `loadStripeStatus`, `submitPassword`, `handleLogout`, `shiftCalMonth`, `acceptInquiry`, `declineInquiry`, `draftReply`, `regenerateDraft`, `closeDraftPanel`, `copyDraft`, `toggleAmenity`, `scrollToSection`, `startProfileEdit`, `cancelProfileEdit`, `renderStripeConnected`, `renderStripeDisconnected`, all helpers)
- All API endpoint calls (`GET /api/venues/:id/stats`, `GET /api/bookings?venue_id=X`, `GET /api/venues/:id`, `PUT /api/venues/:id`, `PATCH /api/bookings/:id/status`, `GET /api/stripe/status/:id`, `POST /api/stripe/connect/:id`, `POST /api/draft-reply`)
- All payload shapes
- All global onclick handlers (window-scoped)
- The first-login password modal trigger
- Auth guard (`vp_admin_token` check + redirect to `index.html`)

### 62 wiring-map IDs (data sinks — JS injects content into these)
`hdr-venue-name`, `hdr-greeting`, `admin-preview-badge`, `btn-back-to-admin`, `stats-overview`, `st-revenue`, `st-revenue-sub`, `st-bookings`, `st-bookings-sub`, `st-inquiries`, `st-inquiries-sub`, `st-views`, `st-views-sub`, `inquiry-section`, `inquiry-list`, `cal-card-section`, `cal-month-label`, `bk-cal-grid`, `stripe-block`, `booking-section`, `booking-list`, `revenue-chart`, `chart-total`, `profile-section`, `tier-badge`, `edit-btn`, `profile-display`, `pf-name`, `pf-location`, `pf-capacity`, `pf-price`, `pf-hours`, `pf-amenities`, `pf-hours-display`, `pf-description-display`, `profile-edit-form`, `edit-name`, `edit-location`, `edit-capacity`, `edit-price`, `edit-hours`, `edit-description`, `amenity-toggle-grid`, `edit-video`, `edit-gallery`, `edit-save-err`, `media-section`, `media-gallery-grid`, `media-video-wrap`, `media-empty`, `pw-modal`, `pw-modal-body`, `pw-new`, `pw-confirm`, `pw-err`, `pw-success`, `mobile-nav`, `mnav-inquiries`, `mnav-calendar`, `mnav-bookings`, `mnav-profile`, `site-footer`

### Wiring-map ID kept for `<script>` template usage
`btn-stripe-connect` (lives in body HTML for default disconnected state; also referenced by the JS template inside script block when it rewrites `#stripe-block.innerHTML`)

### External dependencies
- `cdn.jsdelivr.net/npm/chart.js@4` — preserved (revenue chart)
- Cloudflare Workers API endpoints — preserved
- Cloudflare Pages hosting — no change

---

## Added (new IDs — inert scaffolding, not yet wired)

These appear in the static HTML with placeholder values. The current JS does NOT touch them — they're scaffolding waiting for the follow-up commit that adds hooks to `renderStats()` and `renderBookings()`.

| ID | Purpose | Placeholder value | Follow-up wire location |
|----|---------|-------------------|-------------------------|
| `hero-strip` | container for active/quiet hero | quiet state inline | follow-up: JS overwrites `.innerHTML` when next booking within 72h |
| `hero-pill`, `hero-title`, `hero-meta`, `hero-countdown`, `hero-cta` | active-state hero pieces | (not in static DOM; rendered by future JS template) | follow-up |
| `quick-pills` | jump-to-section pill row | static pills | follow-up: scroll-to handlers |
| `qp-inquiries`, `qp-upcoming`, `qp-action`, `qp-month` | count badges | `3`, `5`, `2`, `8` | follow-up: end of `renderStats()` |
| `st-revenue-trend`, `st-bookings-trend`, `st-inquiries-trend`, `st-views-trend` | trend delta arrows | static `↑12%`, `↑2`, `↑3`, `↑18%` | follow-up: historical compare data |
| `st-revenue-spark`, `st-bookings-spark`, `st-inquiries-spark`, `st-views-spark` | sparkline SVGs | hardcoded 7-point paths | follow-up: render from history series |
| `achv-bookings`, `achv-months`, `achv-revenue` | achievement values | `14`, `4`, `$8,200` | follow-up: end of `renderStats()`/`renderBookings()` |
| `artist-workflow-preview` | feature announcement card | static checklist | no wiring needed — pure marketing |
| `verified-check` | green-check badge next to venue name | always visible | follow-up: conditional render when `venue.verified === true` |

---

## Rollback

If any user-visible bug appears in production:
```
cd "FINISHED PRE API"
cp dashboard.html.backup-v1 dashboard.html
git add dashboard.html && git commit -m "rollback: dashboard v2 → v1"
git push
```
Pages redeploys in ~10s. The backup file lives in the repo for at least one release cycle.

---

## Next steps (NOT in this commit)

After 24h of live-traffic stability, the follow-up commit will add the JS hooks in **one of two places**:
- At the end of `renderStats()` — populate `qp-*` count pills, `achv-*` achievement values, optionally `st-*-trend` deltas if we add a `/stats?compare=last_month` query param to the API
- At the end of `renderBookings()` — pick the next upcoming booking, if within 72h overwrite `#hero-strip.innerHTML` with the active-state template

Sparklines stay as static SVG until we add an `?include=history` param to the stats endpoint. Verified check stays always-visible until a `verified` boolean is added to the venue schema.
