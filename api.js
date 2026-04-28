const ALLOWED_ORIGIN = "https://venue-portal.pages.dev";
const AUTH_EMAIL = "paxey333@gmail.com";
const AUTH_PASSWORD = "portallanding123";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
    }
  });
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: corsHeaders()
  });
}

function parseBearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice("Bearer ".length).trim();
}

function makeAdminToken() {
  const raw = `${AUTH_EMAIL}:${Date.now()}`;
  return btoa(raw);
}

function isValidAdminToken(token) {
  if (!token) return false;
  try {
    const decoded = atob(token);
    return decoded.startsWith(`${AUTH_EMAIL}:`);
  } catch {
    return false;
  }
}

async function requireAdmin(request) {
  const token = parseBearerToken(request);
  return isValidAdminToken(token);
}

async function parseJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIntOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = parseInt(value, 10);
  return Number.isInteger(n) ? n : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" && request.method === "GET") {
      return jsonResponse({ ok: true, service: "venue-portal-api" });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (path === "/health" && request.method === "GET") {
      await env.DB.prepare("SELECT 1 AS ok").first();
      return jsonResponse({ ok: true });
    }

    if (path === "/api/auth/login" && request.method === "POST") {
      await env.DB.prepare("SELECT 1 AS ok").first();
      const body = await parseJson(request);
      if (body.email === AUTH_EMAIL && body.password === AUTH_PASSWORD) {
        return jsonResponse({ token: makeAdminToken() });
      }
      return jsonResponse({ error: "Invalid credentials" }, 401);
    }

    if (path === "/api/auth/set-password" && request.method === "POST") {
      await env.DB.prepare("SELECT 1 AS ok").first();
      const authed = await requireAdmin(request);
      if (!authed) return jsonResponse({ error: "Unauthorized" }, 401);
      return jsonResponse({ ok: false, message: "Password rotation not enabled in this build." }, 501);
    }

    if (path === "/api/venues" && request.method === "GET") {
      const rows = await env.DB.prepare(
        `SELECT id, name, description, capacity, price_per_day, image_url, created_at
         FROM venues
         ORDER BY id DESC`
      ).all();
      return jsonResponse(rows.results || []);
    }

    if (path === "/api/venues" && request.method === "POST") {
      const authed = await requireAdmin(request);
      if (!authed) return jsonResponse({ error: "Unauthorized" }, 401);

      const body = await parseJson(request);
      const name = String(body.name || "").trim();
      if (!name) return jsonResponse({ error: "Venue name is required" }, 400);

      const result = await env.DB.prepare(
        `INSERT INTO venues (name, description, capacity, price_per_day, image_url)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        name,
        body.description ? String(body.description) : null,
        toIntOrNull(body.capacity),
        toNumberOrNull(body.price_per_day),
        body.image_url ? String(body.image_url) : null
      ).run();

      const created = await env.DB.prepare(
        `SELECT id, name, description, capacity, price_per_day, image_url, created_at
         FROM venues WHERE id = ?`
      ).bind(result.meta.last_row_id).first();
      return jsonResponse(created, 201);
    }

    const venueByIdMatch = path.match(/^\/api\/venues\/(\d+)$/);
    if (venueByIdMatch && request.method === "GET") {
      const id = Number(venueByIdMatch[1]);
      const row = await env.DB.prepare(
        `SELECT id, name, description, capacity, price_per_day, image_url, created_at
         FROM venues WHERE id = ?`
      ).bind(id).first();
      if (!row) return jsonResponse({ error: "Venue not found" }, 404);
      return jsonResponse(row);
    }

    if (venueByIdMatch && request.method === "PUT") {
      const authed = await requireAdmin(request);
      if (!authed) return jsonResponse({ error: "Unauthorized" }, 401);
      const id = Number(venueByIdMatch[1]);
      const body = await parseJson(request);
      const name = String(body.name || "").trim();
      if (!name) return jsonResponse({ error: "Venue name is required" }, 400);

      const res = await env.DB.prepare(
        `UPDATE venues
         SET name = ?, description = ?, capacity = ?, price_per_day = ?, image_url = ?
         WHERE id = ?`
      ).bind(
        name,
        body.description ? String(body.description) : null,
        toIntOrNull(body.capacity),
        toNumberOrNull(body.price_per_day),
        body.image_url ? String(body.image_url) : null,
        id
      ).run();

      if (!res.meta.changes) return jsonResponse({ error: "Venue not found" }, 404);

      const updated = await env.DB.prepare(
        `SELECT id, name, description, capacity, price_per_day, image_url, created_at
         FROM venues WHERE id = ?`
      ).bind(id).first();
      return jsonResponse(updated);
    }

    if (venueByIdMatch && request.method === "DELETE") {
      const authed = await requireAdmin(request);
      if (!authed) return jsonResponse({ error: "Unauthorized" }, 401);
      const id = Number(venueByIdMatch[1]);
      const res = await env.DB.prepare("DELETE FROM venues WHERE id = ?").bind(id).run();
      if (!res.meta.changes) return jsonResponse({ error: "Venue not found" }, 404);
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (path === "/api/bookings" && request.method === "POST") {
      const body = await parseJson(request);
      const venueId = toIntOrNull(body.venue_id);
      const clientName = String(body.client_name || "").trim();
      const clientEmail = String(body.client_email || "").trim();
      const eventDate = String(body.event_date || "").trim();

      if (!venueId || !clientName || !clientEmail || !eventDate) {
        return jsonResponse({ error: "venue_id, client_name, client_email, and event_date are required" }, 400);
      }

      const venue = await env.DB.prepare("SELECT id, name FROM venues WHERE id = ?").bind(venueId).first();
      if (!venue) return jsonResponse({ error: "Venue not found" }, 404);

      const result = await env.DB.prepare(
        `INSERT INTO bookings
         (venue_id, client_name, client_email, event_date, guests, message, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`
      ).bind(
        venueId,
        clientName,
        clientEmail,
        eventDate,
        toIntOrNull(body.guests),
        body.message ? String(body.message) : null
      ).run();

      const created = await env.DB.prepare(
        `SELECT id, venue_id, client_name, client_email, event_date, guests, message, status, created_at
         FROM bookings WHERE id = ?`
      ).bind(result.meta.last_row_id).first();
      return jsonResponse(created, 201);
    }

    if (path === "/api/bookings" && request.method === "GET") {
      const authed = await requireAdmin(request);
      if (!authed) return jsonResponse({ error: "Unauthorized" }, 401);
      const rows = await env.DB.prepare(
        `SELECT b.id, b.venue_id, v.name AS venue_name, b.client_name, b.client_email, b.event_date, b.guests, b.message, b.status, b.created_at
         FROM bookings b
         LEFT JOIN venues v ON v.id = b.venue_id
         ORDER BY b.id DESC`
      ).all();
      return jsonResponse(rows.results || []);
    }

    const bookingStatusMatch = path.match(/^\/api\/bookings\/(\d+)\/status$/);
    if (bookingStatusMatch && request.method === "PATCH") {
      const authed = await requireAdmin(request);
      if (!authed) return jsonResponse({ error: "Unauthorized" }, 401);
      const id = Number(bookingStatusMatch[1]);
      const body = await parseJson(request);
      const status = String(body.status || "").trim().toLowerCase();
      if (!["pending", "confirmed", "cancelled"].includes(status)) {
        return jsonResponse({ error: "Status must be pending, confirmed, or cancelled" }, 400);
      }

      const res = await env.DB.prepare(
        `UPDATE bookings SET status = ? WHERE id = ?`
      ).bind(status, id).run();
      if (!res.meta.changes) return jsonResponse({ error: "Booking not found" }, 404);

      const updated = await env.DB.prepare(
        `SELECT b.id, b.venue_id, v.name AS venue_name, b.client_name, b.client_email, b.event_date, b.guests, b.message, b.status, b.created_at
         FROM bookings b
         LEFT JOIN venues v ON v.id = b.venue_id
         WHERE b.id = ?`
      ).bind(id).first();
      return jsonResponse(updated);
    }

    const bookingByIdMatch = path.match(/^\/api\/bookings\/(\d+)$/);
    if (bookingByIdMatch && request.method === "DELETE") {
      const authed = await requireAdmin(request);
      if (!authed) return jsonResponse({ error: "Unauthorized" }, 401);
      const id = Number(bookingByIdMatch[1]);
      const res = await env.DB.prepare("DELETE FROM bookings WHERE id = ?").bind(id).run();
      if (!res.meta.changes) return jsonResponse({ error: "Booking not found" }, 404);
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    return textResponse("Not found", 404);
  }
};
