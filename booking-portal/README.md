# Venue Portal Booking Site

This folder is a standalone static-site copy of the landing page, prepared as a separate deployable instance from `swan-live`.

## Files

- `index.html` contains the booking portal page and was copied without changing the code.

## GitHub Repo Setup

Create a new GitHub repository for this folder, then upload the contents of this folder as the repo root.

Suggested repo names:

- `venue-portal-booking`
- `venue-portals-booking`

## Cloudflare Pages Setup

Create a new Cloudflare Pages project and connect it to the new GitHub repository.

Use these settings:

- Framework preset: `None`
- Build command: leave blank
- Build output directory: `/`

This keeps the booking page as a separate instance from the existing `swan-live` deployment.
