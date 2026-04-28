/* ─────────────────────────────────────────────
   VENUE PORTAL — API WORKER
   Roles: superadmin | admin | venue_owner
   Auth: HMAC-SHA256 signed tokens, 24hr expiry
───────────────────────────────────────────── */

const ALLOWED_ORIGINS = [
  "https://venue-portal.pages.dev",
  "https://thevenueportal.paxey333.workers.dev"
];
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// ── CORS ─────────────────────────────────────────────────────────────────────

function corsHeaders(request) {
  const origin = (request && request.headers.get("Origin")) || "";
  const isAllowed = ALLOWED_ORIGINS.includes(origin) || origin.endsWith(".pages.dev");
  const allowedOrigin = isAllowed ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  };
}

function jsonResponse(data, status = 200, request = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) }
  });
}

function textResponse(text, status = 200, request = null) {
  return new Response(text, { status, headers: corsHeaders(request) });
}

// ── CRYPTO HELPERS ────────────────────────────────────────────────────────────

function toBase64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return toBase64(new Uint8Array(sig));
}

async function hashPassword(password, secret) {
  return hmacSign(password, secret);
}

// ── TOKEN ─────────────────────────────────────────────────────────────────────
// Format: base64(json_payload).hmac_signature
// Payload: { email, role, venue_id, name, expiry }

async function makeToken(payload, tokenSecret) {
  const expiry = Date.now() + TOKEN_TTL_MS;
  const data = JSON.stringify({ ...payload, expiry });
  const encoded = btoa(data);
  const signature = await hmacSign(encoded, tokenSecret);
  return `${encoded}.${signature}`;
}

async function verifyToken(token, tokenSecret) {
  if (!token || !tokenSecret) return null;
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx < 1) return null;
  const encoded = token.slice(0, dotIdx);
  const providedSig = token.slice(dotIdx + 1);
  try {
    const expectedSig = await hmacSign(encoded, tokenSecret);
    if (expectedSig !== providedSig) return null;
    const data = JSON.parse(new TextDecoder().decode(fromBase64(encoded)));
    if (!data.expiry || data.expiry < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function parseBearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice(7).trim();
}

// ── SESSION HELPERS ───────────────────────────────────────────────────────────

async function getSession(request, env) {
  const token = parseBearerToken(request);
  if (!token) return null;
  return verifyToken(token, env.TOKEN_SECRET);
}

function isSuperAdmin(session) {
  return session && session.role === "superadmin";
}

function isAdminOrAbove(session) {
  return session && (session.role === "superadmin" || session.role === "admin");
}

function isAnyRole(session) {
  return session && ["superadmin", "admin", "venue_owner"].includes(session.role);
}

// ── PARSE HELPERS ─────────────────────────────────────────────────────────────

async function parseJson(request) {
  try { return await request.json(); } catch { return {}; }
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

function generatePassword(length = 12) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$";
  let pw = "";
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  for (const b of arr) pw += chars[b % chars.length];
  return pw;
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    try {

      // ── ROOT ────────────────────────────────────────────────────
      if (path === "/" && request.method === "GET") {
        return jsonResponse({ ok: true, service: "venue-portal-api" }, 200, request);
      }

      // ── HEALTH ──────────────────────────────────────────────────
      if (path === "/health" && request.method === "GET") {
        try {
          await env.DB.prepare("SELECT 1 AS ok").first();
          return jsonResponse({ ok: true }, 200, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── AUTH: LOGIN ─────────────────────────────────────────────
      // Checks users table first, falls back to env superadmin
      if (path === "/api/auth/login" && request.method === "POST") {
        try {
          if (!env.TOKEN_SECRET) {
            return jsonResponse({ error: "Auth configuration missing" }, 500, request);
          }
          const body = await parseJson(request);
          const email = String(body.email || "").trim().toLowerCase();
          const password = String(body.password || "");
          if (!email || !password) {
            return jsonResponse({ error: "Email and password required" }, 400, request);
          }

          // Check users table first
          const user = await env.DB.prepare(
            "SELECT id, email, password, role, venue_id, name FROM users WHERE email = ?"
          ).bind(email).first();

          if (user) {
            const hashed = await hashPassword(password, env.TOKEN_SECRET);
            if (hashed !== user.password) {
              return jsonResponse({ error: "Invalid credentials" }, 401, request);
            }
            const token = await makeToken({
              email: user.email,
              role: user.role,
              venue_id: user.venue_id ?? null,
              name: user.name
            }, env.TOKEN_SECRET);
            return jsonResponse({ token, role: user.role, venue_id: user.venue_id ?? null, name: user.name }, 200, request);
          }

          // Fallback: env superadmin credentials (keeps existing login working)
          if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
            if (email === env.ADMIN_EMAIL.toLowerCase() && password === env.ADMIN_PASSWORD) {
              const token = await makeToken({
                email: env.ADMIN_EMAIL,
                role: "superadmin",
                venue_id: null,
                name: "Pax"
              }, env.TOKEN_SECRET);
              return jsonResponse({ token, role: "superadmin", venue_id: null, name: "Pax" }, 200, request);
            }
          }

          return jsonResponse({ error: "Invalid credentials" }, 401, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── AUTH: ME ────────────────────────────────────────────────
      if (path === "/api/auth/me" && request.method === "GET") {
        try {
          const session = await getSession(request, env);
          if (!isAnyRole(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          return jsonResponse({
            email: session.email,
            role: session.role,
            venue_id: session.venue_id ?? null,
            name: session.name ?? ""
          }, 200, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── USERS: CREATE (superadmin only) ─────────────────────────
      if (path === "/api/users" && request.method === "POST") {
        try {
          const session = await getSession(request, env);
          if (!isSuperAdmin(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);

          const body = await parseJson(request);
          const email = String(body.email || "").trim().toLowerCase();
          const role = String(body.role || "").trim();
          const name = String(body.name || "").trim();
          const venueId = toIntOrNull(body.venue_id);

          if (!email || !role || !name) {
            return jsonResponse({ error: "email, role, and name are required" }, 400, request);
          }
          if (!["admin", "venue_owner"].includes(role)) {
            return jsonResponse({ error: "role must be admin or venue_owner" }, 400, request);
          }
          if (role === "venue_owner" && !venueId) {
            return jsonResponse({ error: "venue_id is required for venue_owner role" }, 400, request);
          }

          const plainPassword = generatePassword();
          const hashedPassword = await hashPassword(plainPassword, env.TOKEN_SECRET);

          await env.DB.prepare(
            "INSERT INTO users (email, password, role, venue_id, name) VALUES (?, ?, ?, ?, ?)"
          ).bind(email, hashedPassword, role, venueId, name).run();

          const created = await env.DB.prepare(
            "SELECT id, email, role, venue_id, name, created_at FROM users WHERE email = ?"
          ).bind(email).first();

          // Return plain password ONCE — not stored anywhere after this
          return jsonResponse({ ...created, generated_password: plainPassword }, 201, request);
        } catch (err) {
          if (err.message && err.message.includes("UNIQUE")) {
            return jsonResponse({ error: "A user with that email already exists" }, 409, request);
          }
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── USERS: GET ALL (superadmin only) ────────────────────────
      if (path === "/api/users" && request.method === "GET") {
        try {
          const session = await getSession(request, env);
          if (!isSuperAdmin(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const rows = await env.DB.prepare(
            "SELECT id, email, role, venue_id, name, created_at FROM users ORDER BY id DESC"
          ).all();
          return jsonResponse(rows.results || [], 200, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── USERS: DELETE + RESET PASSWORD (superadmin only) ────────
      const userByIdMatch = path.match(/^\/api\/users\/(\d+)$/);

      if (userByIdMatch && request.method === "DELETE") {
        try {
          const session = await getSession(request, env);
          if (!isSuperAdmin(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const id = Number(userByIdMatch[1]);
          const res = await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
          if (!res.meta.changes) return jsonResponse({ error: "User not found" }, 404, request);
          return new Response(null, { status: 204, headers: corsHeaders(request) });
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      if (userByIdMatch && request.method === "PATCH") {
        try {
          const session = await getSession(request, env);
          if (!isSuperAdmin(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const id = Number(userByIdMatch[1]);
          const plainPassword = generatePassword();
          const hashedPassword = await hashPassword(plainPassword, env.TOKEN_SECRET);
          const res = await env.DB.prepare(
            "UPDATE users SET password = ? WHERE id = ?"
          ).bind(hashedPassword, id).run();
          if (!res.meta.changes) return jsonResponse({ error: "User not found" }, 404, request);
          return jsonResponse({ generated_password: plainPassword }, 200, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── VENUES: GET ALL (public) ─────────────────────────────────
      if (path === "/api/venues" && request.method === "GET") {
        try {
          const rows = await env.DB.prepare(
            `SELECT id, name, description, capacity, price_per_day, image_url, created_at
             FROM venues ORDER BY id DESC`
          ).all();
          return jsonResponse(rows.results || [], 200, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── VENUES: CREATE (admin or above) ─────────────────────────
      if (path === "/api/venues" && request.method === "POST") {
        try {
          const session = await getSession(request, env);
          if (!isAdminOrAbove(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);

          const body = await parseJson(request);
          const name = String(body.name || "").trim();
          if (!name) return jsonResponse({ error: "Venue name is required" }, 400, request);

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
          return jsonResponse(created, 201, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── VENUES: GET / PUT / DELETE BY ID ────────────────────────
      const venueByIdMatch = path.match(/^\/api\/venues\/(\d+)$/);

      if (venueByIdMatch && request.method === "GET") {
        try {
          const id = Number(venueByIdMatch[1]);
          const row = await env.DB.prepare(
            `SELECT id, name, description, capacity, price_per_day, image_url, created_at
             FROM venues WHERE id = ?`
          ).bind(id).first();
          if (!row) return jsonResponse({ error: "Venue not found" }, 404, request);
          return jsonResponse(row, 200, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      if (venueByIdMatch && request.method === "PUT") {
        try {
          const session = await getSession(request, env);
          if (!isAdminOrAbove(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const id = Number(venueByIdMatch[1]);
          const body = await parseJson(request);
          const name = String(body.name || "").trim();
          if (!name) return jsonResponse({ error: "Venue name is required" }, 400, request);

          const res = await env.DB.prepare(
            `UPDATE venues SET name=?, description=?, capacity=?, price_per_day=?, image_url=? WHERE id=?`
          ).bind(
            name,
            body.description ? String(body.description) : null,
            toIntOrNull(body.capacity),
            toNumberOrNull(body.price_per_day),
            body.image_url ? String(body.image_url) : null,
            id
          ).run();

          if (!res.meta.changes) return jsonResponse({ error: "Venue not found" }, 404, request);
          const updated = await env.DB.prepare(
            `SELECT id, name, description, capacity, price_per_day, image_url, created_at FROM venues WHERE id=?`
          ).bind(id).first();
          return jsonResponse(updated, 200, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      if (venueByIdMatch && request.method === "DELETE") {
        try {
          const session = await getSession(request, env);
          if (!isSuperAdmin(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const id = Number(venueByIdMatch[1]);
          const res = await env.DB.prepare("DELETE FROM venues WHERE id = ?").bind(id).run();
          if (!res.meta.changes) return jsonResponse({ error: "Venue not found" }, 404, request);
          return new Response(null, { status: 204, headers: corsHeaders(request) });
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── BOOKINGS: CREATE (public) ────────────────────────────────
      if (path === "/api/bookings" && request.method === "POST") {
        try {
          const body = await parseJson(request);
          const venueId = toIntOrNull(body.venue_id);
          const clientName = String(body.client_name || "").trim();
          const clientEmail = String(body.client_email || "").trim();
          const eventDate = String(body.event_date || "").trim();

          if (!venueId || !clientName || !clientEmail || !eventDate) {
            return jsonResponse({ error: "venue_id, client_name, client_email, and event_date are required" }, 400, request);
          }

          const venue = await env.DB.prepare("SELECT id FROM venues WHERE id = ?").bind(venueId).first();
          if (!venue) return jsonResponse({ error: "Venue not found" }, 404, request);

          const result = await env.DB.prepare(
            `INSERT INTO bookings (venue_id, client_name, client_email, event_date, guests, message, status)
             VALUES (?, ?, ?, ?, ?, ?, 'pending')`
          ).bind(
            venueId, clientName, clientEmail, eventDate,
            toIntOrNull(body.guests),
            body.message ? String(body.message) : null
          ).run();

          const created = await env.DB.prepare(
            `SELECT id, venue_id, client_name, client_email, event_date, guests, message, status, created_at
             FROM bookings WHERE id = ?`
          ).bind(result.meta.last_row_id).first();
          return jsonResponse(created, 201, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── BOOKINGS: GET ALL ────────────────────────────────────────
      // superadmin + admin = all bookings
      // venue_owner = only their venue's bookings
      if (path === "/api/bookings" && request.method === "GET") {
        try {
          const session = await getSession(request, env);
          if (!isAnyRole(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);

          let rows;
          if (isAdminOrAbove(session)) {
            rows = await env.DB.prepare(
              `SELECT b.id, b.venue_id, v.name AS venue_name, b.client_name, b.client_email,
                      b.event_date, b.guests, b.message, b.status, b.created_at
               FROM bookings b LEFT JOIN venues v ON v.id = b.venue_id
               ORDER BY b.id DESC`
            ).all();
          } else {
            rows = await env.DB.prepare(
              `SELECT b.id, b.venue_id, v.name AS venue_name, b.client_name, b.client_email,
                      b.event_date, b.guests, b.message, b.status, b.created_at
               FROM bookings b LEFT JOIN venues v ON v.id = b.venue_id
               WHERE b.venue_id = ?
               ORDER BY b.id DESC`
            ).bind(session.venue_id).all();
          }
          return jsonResponse(rows.results || [], 200, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── BOOKINGS: UPDATE STATUS ──────────────────────────────────
      const bookingStatusMatch = path.match(/^\/api\/bookings\/(\d+)\/status$/);
      if (bookingStatusMatch && request.method === "PATCH") {
        try {
          const session = await getSession(request, env);
          if (!isAnyRole(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const id = Number(bookingStatusMatch[1]);

          if (session.role === "venue_owner") {
            const booking = await env.DB.prepare(
              "SELECT venue_id FROM bookings WHERE id = ?"
            ).bind(id).first();
            if (!booking || booking.venue_id !== session.venue_id) {
              return jsonResponse({ error: "Unauthorized" }, 401, request);
            }
          }

          const body = await parseJson(request);
          const status = String(body.status || "").trim().toLowerCase();
          if (!["pending", "confirmed", "cancelled"].includes(status)) {
            return jsonResponse({ error: "Status must be pending, confirmed, or cancelled" }, 400, request);
          }

          const res = await env.DB.prepare(
            "UPDATE bookings SET status = ? WHERE id = ?"
          ).bind(status, id).run();
          if (!res.meta.changes) return jsonResponse({ error: "Booking not found" }, 404, request);

          const updated = await env.DB.prepare(
            `SELECT b.id, b.venue_id, v.name AS venue_name, b.client_name, b.client_email,
                    b.event_date, b.guests, b.message, b.status, b.created_at
             FROM bookings b LEFT JOIN venues v ON v.id = b.venue_id WHERE b.id = ?`
          ).bind(id).first();
          return jsonResponse(updated, 200, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── BOOKINGS: DELETE (admin or above) ───────────────────────
      const bookingByIdMatch = path.match(/^\/api\/bookings\/(\d+)$/);
      if (bookingByIdMatch && request.method === "DELETE") {
        try {
          const session = await getSession(request, env);
          if (!isAdminOrAbove(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const id = Number(bookingByIdMatch[1]);
          const res = await env.DB.prepare("DELETE FROM bookings WHERE id = ?").bind(id).run();
          if (!res.meta.changes) return jsonResponse({ error: "Booking not found" }, 404, request);
          return new Response(null, { status: 204, headers: corsHeaders(request) });
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── VENUE STATS (all roles, venue_owner filtered) ────────────
      const venueStatsMatch = path.match(/^\/api\/venues\/(\d+)\/stats$/);
      if (venueStatsMatch && request.method === "GET") {
        try {
          const session = await getSession(request, env);
          if (!isAnyRole(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const id = Number(venueStatsMatch[1]);

          if (session.role === "venue_owner" && session.venue_id !== id) {
            return jsonResponse({ error: "Unauthorized" }, 401, request);
          }

          const venue = await env.DB.prepare(
            "SELECT id, name, capacity, price_per_day FROM venues WHERE id = ?"
          ).bind(id).first();

          const totalBookings = await env.DB.prepare(
            "SELECT COUNT(*) AS count FROM bookings WHERE venue_id = ?"
          ).bind(id).first();

          const confirmed = await env.DB.prepare(
            "SELECT COUNT(*) AS count FROM bookings WHERE venue_id = ? AND status = 'confirmed'"
          ).bind(id).first();

          const pending = await env.DB.prepare(
            "SELECT COUNT(*) AS count FROM bookings WHERE venue_id = ? AND status = 'pending'"
          ).bind(id).first();

          return jsonResponse({
            venue,
            total_bookings: totalBookings?.count ?? 0,
            confirmed_bookings: confirmed?.count ?? 0,
            pending_bookings: pending?.count ?? 0,
            revenue: null // Stripe Connect placeholder
          }, 200, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      return textResponse("Not found", 404, request);

    } catch (err) {
      console.error("Worker error:", err);
      return new Response(JSON.stringify({
        error: "Internal server error",
        message: err.message ?? "Unknown error"
      }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders(request) }
      });
    }
  }
};