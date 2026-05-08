/* ─────────────────────────────────────────────
   VENUE PORTAL — API WORKER
   Roles: superadmin | admin | venue_owner
   Auth: HMAC-SHA256 signed tokens, 24hr expiry

   Required env vars (wrangler secrets):
   STRIPE_SECRET_KEY         — sk_live_... or sk_test_...
   STRIPE_PLATFORM_ACCOUNT_ID — acct_... (your Stripe account)
   FRONTEND_URL              — https://venue-portal.pages.dev
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

async function hmacHex(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
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

      // ── STRIPE WEBHOOK: checkout.session.completed ──────────────
      if (path === "/webhooks/stripe" && request.method === "POST") {
        try {
          const rawBody = await request.text();
          const sigHeader = request.headers.get("Stripe-Signature") || "";
          const parts = Object.fromEntries(
            sigHeader.split(",").map(p => { const [k, ...v] = p.split("="); return [k, v.join("=")]; })
          );
          const timestamp = parts["t"];
          const v1 = parts["v1"];

          if (!timestamp || !v1 || !env.STRIPE_WEBHOOK_SECRET) {
            return new Response("Webhook Error: Missing signature", { status: 400 });
          }
          if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
            return new Response("Webhook Error: Timestamp too old", { status: 400 });
          }
          const expectedSig = await hmacHex(`${timestamp}.${rawBody}`, env.STRIPE_WEBHOOK_SECRET);
          if (expectedSig !== v1) {
            return new Response("Webhook Error: Invalid signature", { status: 400 });
          }

          const event = JSON.parse(rawBody);
          console.log("[webhooks/stripe] event.type:", event.type);

          if (event.type === "payment_intent.succeeded") {
            const paymentIntent = event.data?.object ?? {};
            const bookingId = paymentIntent.metadata?.booking_id;
            if (bookingId) {
              const booking = await env.DB.prepare(
                "SELECT id, client_name, client_email, event_date FROM bookings WHERE id = ?"
              ).bind(bookingId).first();
              if (booking) {
                await env.DB.prepare(
                  "UPDATE bookings SET status='confirmed' WHERE id=?"
                ).bind(booking.id).run();
                if (env.RESEND_API_KEY) {
                  await fetch("https://api.resend.com/emails", {
                    method: "POST",
                    headers: {
                      "Authorization": "Bearer " + env.RESEND_API_KEY,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      from: "Venue Portal <onboarding@resend.dev>",
                      to: [booking.client_email],
                      subject: "Booking confirmed! See you on " + booking.event_date,
                      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto"><h2 style="color:#111">You're confirmed, ${booking.client_name}!</h2><p>Your booking for <strong>${booking.event_date}</strong> is fully confirmed. We look forward to seeing you!</p><p style="color:#888;font-size:13px">If you have questions, reply to this email.</p></div>`,
                    }),
                  });
                }
              }
            }
          }

          if (event.type === "checkout.session.completed") {
            const sess = event.data?.object ?? {};
            console.log("Webhook: checkout.session.completed for session", sess.id);
            const result = await env.DB.prepare(
              "UPDATE bookings SET status = 'confirmed' WHERE stripe_session_id = ?"
            ).bind(sess.id).run();
            console.log("Booking status update result:", JSON.stringify(result));
            if (result.meta && result.meta.changes === 0) {
              console.log("WARNING: No booking found with session_id", sess.id);
            }
            return jsonResponse({ ok: true }, 200, request);
          }

          return jsonResponse({ received: true }, 200, request);
        } catch (err) {
          console.log("[webhooks/stripe] error:", err.message);
          return new Response("Webhook Error: " + err.message, { status: 500 });
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
          if (!isAdminOrAbove(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);

          const body = await parseJson(request);
          const email = String(body.email || "").trim().toLowerCase();
          const role = String(body.role || "").trim();
          let name = String(body.name || "").trim();
          const venueId = toIntOrNull(body.venue_id);

          if (!email)        return jsonResponse({ error: "email is required" }, 400, request);
          if (!role)         return jsonResponse({ error: "role is required" }, 400, request);
          if (!["admin", "venue_owner", "promoter", "superadmin"].includes(role)) {
            return jsonResponse({ error: "invalid role" }, 400, request);
          }
          // Only superadmin can create admin or superadmin accounts.
          if ((role === "admin" || role === "superadmin") && !isSuperAdmin(session)) {
            return jsonResponse({ error: "Only superadmin can create admin or superadmin accounts" }, 403, request);
          }
          if (role === "venue_owner" && !venueId) {
            return jsonResponse({ error: "venue_id is required for venue_owner role" }, 400, request);
          }

          if (!name) name = email.split("@")[0];

          // Password: use provided, or auto-generate.
          const providedPassword = String(body.password || "").trim();
          const plainPassword = providedPassword || generatePassword();
          const hashedPassword = await hashPassword(plainPassword, env.TOKEN_SECRET);

          await env.DB.prepare(
            "INSERT INTO users (email, password, role, venue_id, name) VALUES (?, ?, ?, ?, ?)"
          ).bind(email, hashedPassword, role, venueId, name).run();

          const created = await env.DB.prepare(
            "SELECT id, email, role, venue_id, name, created_at FROM users WHERE email = ?"
          ).bind(email).first();

          if (env.RESEND_API_KEY) {
            let venueName = "";
            if (venueId) {
              const venueRow = await env.DB.prepare("SELECT name FROM venues WHERE id = ?").bind(venueId).first();
              venueName = venueRow?.name || "";
            }
            await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                "Authorization": "Bearer " + env.RESEND_API_KEY,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                from: "Venue Portal <onboarding@resend.dev>",
                to: [email],
                subject: "Your Venue Portal is ready",
                html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto"><h2 style="color:#111">Welcome to Venue Portal, ${name}!</h2>${venueName ? `<p>Your venue <strong>${venueName}</strong> has been set up and is ready to go.</p>` : ""}<p>Log in to manage your bookings and venue profile.</p><p><strong>Email:</strong> ${email}<br><strong>Temporary password:</strong> ${plainPassword}</p><p style="color:#888;font-size:13px">Please change your password after your first login.</p><p style="text-align:center;margin:32px 0"><a href="https://venue-portal.pages.dev/dashboard.html" style="background:#f5a623;color:#111;font-weight:700;padding:14px 28px;border-radius:6px;text-decoration:none;display:inline-block">Go to Dashboard &#8594;</a></p></div>`,
              }),
            });
          }

          // Return plaintext password ONLY on creation — never persisted in any other response.
          return jsonResponse({ ...created, password: plainPassword }, 201, request);
        } catch (err) {
          if (err.message && err.message.includes("UNIQUE")) {
            return jsonResponse({ error: "A user with that email already exists" }, 409, request);
          }
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── USERS: GET ALL (admin or above) ─────────────────────────
      if (path === "/api/users" && request.method === "GET") {
        try {
          const session = await getSession(request, env);
          if (!isAdminOrAbove(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const rows = await env.DB.prepare(
            `SELECT u.id, u.email, u.role, u.venue_id, u.name, u.created_at, v.name AS venue_name
             FROM users u LEFT JOIN venues v ON v.id = u.venue_id
             ORDER BY u.id DESC`
          ).all();
          return jsonResponse(rows.results || [], 200, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── USERS: DELETE + RESET PASSWORD (admin or above) ────────
      const userByIdMatch = path.match(/^\/api\/users\/(\d+)$/);

      if (userByIdMatch && request.method === "DELETE") {
        try {
          const session = await getSession(request, env);
          if (!isAdminOrAbove(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const id = Number(userByIdMatch[1]);
          const target = await env.DB.prepare("SELECT id, email, role FROM users WHERE id = ?").bind(id).first();
          if (!target) return jsonResponse({ error: "User not found" }, 404, request);
          // Prevent self-delete.
          if (session.email && target.email && target.email.toLowerCase() === String(session.email).toLowerCase()) {
            return jsonResponse({ error: "You cannot delete your own account" }, 403, request);
          }
          // Admin cannot delete admin or superadmin — only superadmin can.
          if ((target.role === "admin" || target.role === "superadmin") && !isSuperAdmin(session)) {
            return jsonResponse({ error: "Only superadmin can delete admin or superadmin accounts" }, 403, request);
          }
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
          if (!isAdminOrAbove(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const id = Number(userByIdMatch[1]);
          const target = await env.DB.prepare("SELECT id, email, role FROM users WHERE id = ?").bind(id).first();
          if (!target) return jsonResponse({ error: "User not found" }, 404, request);
          // Prevent self-reset (use the proper change-password flow instead).
          if (session.email && target.email && target.email.toLowerCase() === String(session.email).toLowerCase()) {
            return jsonResponse({ error: "You cannot reset your own password from here" }, 403, request);
          }
          // Admin cannot reset admin or superadmin — only superadmin can.
          if ((target.role === "admin" || target.role === "superadmin") && !isSuperAdmin(session)) {
            return jsonResponse({ error: "Only superadmin can reset admin or superadmin passwords" }, 403, request);
          }
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
          const session = await getSession(request, env);
          if (!isAnyRole(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          console.log("[GET /api/venues/:id] user:", session.user_id, "role:", session.role, "session.venue_id:", session.venue_id, "requested venue_id:", id);
          if (session.role === "venue_owner" && session.venue_id !== id) {
            return jsonResponse({ error: "Forbidden" }, 403, request);
          }
          const row = await env.DB.prepare(
            `SELECT id, name, description, capacity, price_per_day, image_url, hours, amenities, gallery, video_url, created_at
             FROM venues WHERE id = ?`
          ).bind(id).first();
          if (!row) return jsonResponse({ error: "Venue not found" }, 404, request);
          let amenities = [];
          try { const a = row.amenities ? JSON.parse(row.amenities) : []; amenities = Array.isArray(a) ? a : []; } catch(e) { amenities = []; }
          let gallery = [];
          try { const g = row.gallery ? JSON.parse(row.gallery) : []; gallery = Array.isArray(g) ? g : []; } catch(e) { gallery = []; }
          return jsonResponse({ ...row, amenities, gallery }, 200, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      if (venueByIdMatch && (request.method === "PUT" || request.method === "PATCH")) {
        try {
          const session = await getSession(request, env);
          if (!isAnyRole(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const id = Number(venueByIdMatch[1]);
          console.log("[PATCH /api/venues/:id] user:", session.user_id, "role:", session.role, "session.venue_id:", session.venue_id, "requested venue_id:", id);
          if (session.role === "venue_owner" && session.venue_id !== id) {
            return jsonResponse({ error: "Forbidden" }, 403, request);
          }
          const body = await parseJson(request);

          const fields = [];
          const values = [];
          if ('name' in body) {
            const name = String(body.name || "").trim();
            if (!name) return jsonResponse({ error: "Venue name is required" }, 400, request);
            fields.push('name=?'); values.push(name);
          }
          if ('description' in body)   { fields.push('description=?');   values.push(body.description ? String(body.description) : null); }
          if ('capacity' in body)      { fields.push('capacity=?');      values.push(toIntOrNull(body.capacity)); }
          if ('price_per_day' in body) { fields.push('price_per_day=?'); values.push(toNumberOrNull(body.price_per_day)); }
          if ('image_url' in body)     { fields.push('image_url=?');     values.push(body.image_url ? String(body.image_url) : null); }
          if ('hours' in body)         { fields.push('hours=?');         values.push(body.hours ? String(body.hours) : null); }
          if ('video_url' in body)     { fields.push('video_url=?');     values.push(body.video_url ? String(body.video_url) : null); }
          if ('amenities' in body)     { fields.push('amenities=?');     values.push(Array.isArray(body.amenities) ? JSON.stringify(body.amenities) : null); }
          if ('gallery' in body)       { fields.push('gallery=?');       values.push(Array.isArray(body.gallery) ? JSON.stringify(body.gallery) : null); }

          if (!fields.length) return jsonResponse({ error: "No fields to update" }, 400, request);

          const exists = await env.DB.prepare("SELECT id FROM venues WHERE id=?").bind(id).first();
          if (!exists) return jsonResponse({ error: "Venue not found" }, 404, request);

          values.push(id);
          await env.DB.prepare(
            `UPDATE venues SET ${fields.join(', ')} WHERE id=?`
          ).bind(...values).run();

          const updated = await env.DB.prepare(
            `SELECT id, name, description, capacity, price_per_day, image_url, hours, amenities, gallery, video_url, created_at FROM venues WHERE id=?`
          ).bind(id).first();
          let amenities = [];
          try { const a = updated.amenities ? JSON.parse(updated.amenities) : []; amenities = Array.isArray(a) ? a : []; } catch(e) { amenities = []; }
          let gallery = [];
          try { const g = updated.gallery ? JSON.parse(updated.gallery) : []; gallery = Array.isArray(g) ? g : []; } catch(e) { gallery = []; }
          return jsonResponse({ ...updated, amenities, gallery }, 200, request);
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

          console.log("[INQUIRY SUBMIT] venue_id:", body.venue_id, "client:", body.client_name, "inserted as id:", result.meta.last_row_id);

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

          // Honour ?venue_id= query param for admin/superadmin (used by admin-preview dashboard
          // to scope to a single venue). venue_owner is ALWAYS forced to their own venue_id.
          const queryVenueIdRaw = url.searchParams.get("venue_id");
          const queryVenueId    = queryVenueIdRaw ? parseInt(queryVenueIdRaw, 10) : null;

          let filterVenueId;
          if (isAdminOrAbove(session)) {
            filterVenueId = (queryVenueId && !isNaN(queryVenueId)) ? queryVenueId : "ALL";
          } else {
            // Block venue_owner from spoofing another venue via query param.
            if (queryVenueId && queryVenueId !== session.venue_id) {
              return jsonResponse({ error: "Forbidden" }, 403, request);
            }
            filterVenueId = session.venue_id;
          }
          console.log("[FILTER] GET /api/bookings hit by user:", session.user_id ?? session.email, "role:", session.role, "session venue_id:", session.venue_id, "query venue_id:", queryVenueId, "WHERE clause venue_id:", filterVenueId);

          let rows;
          if (filterVenueId === "ALL") {
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
            ).bind(filterVenueId).all();
          }
          const results = rows.results || [];
          const pendingCount = results.filter(r => r.status === 'pending').length;
          console.log("[INQUIRIES] fetched for venue_id:", filterVenueId, "returning:", results.length, "bookings (", pendingCount, "pending inquiries )");
          return jsonResponse(results, 200, request);
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
            const ownerCheck = await env.DB.prepare(
              "SELECT venue_id FROM bookings WHERE id = ?"
            ).bind(id).first();
            if (!ownerCheck || ownerCheck.venue_id !== session.venue_id) {
              return jsonResponse({ error: "Unauthorized" }, 401, request);
            }
          }

          const body = await parseJson(request);
          const status = String(body.status || "").trim().toLowerCase();
          if (!["pending", "confirmed", "cancelled", "accepted", "declined"].includes(status)) {
            return jsonResponse({ error: "Invalid status" }, 400, request);
          }

          // Prevent double-accept: if already accepted/confirmed, short-circuit with 409.
          if (status === "accepted") {
            const current = await env.DB.prepare("SELECT status FROM bookings WHERE id = ?").bind(id).first();
            if (current && (current.status === "accepted" || current.status === "confirmed")) {
              return jsonResponse({ error: "Already processed" }, 409, request);
            }
          }

          if (status === "accepted") {
            const booking = await env.DB.prepare(
              `SELECT b.id, b.venue_id, b.client_name, b.client_email, b.event_date,
                      v.name AS venue_name, v.stripe_account_id, v.stripe_connected
               FROM bookings b JOIN venues v ON v.id = b.venue_id WHERE b.id = ?`
            ).bind(id).first();
            console.log("[bookings/accept] booking lookup:", JSON.stringify(booking));
            if (!booking) return jsonResponse({ error: "Booking not found" }, 404, request);
            console.log("[bookings/accept] venue stripe_account_id:", booking.stripe_account_id, "stripe_connected:", booking.stripe_connected);
            if (!booking.stripe_connected) {
              return jsonResponse({ error: "Connect Stripe before accepting bookings." }, 400, request);
            }

            const venueName = booking.venue_name;
            const stripeAccountId = booking.stripe_account_id;
            const bookingId = booking.id;

            const stripeBody = new URLSearchParams();
            stripeBody.append('payment_method_types[]', 'card');
            stripeBody.append('mode', 'payment');
            stripeBody.append('line_items[0][price_data][currency]', 'usd');
            // TEST MODE — $1 booking. Restore to actual venue price_per_day before launch.
            stripeBody.append('line_items[0][price_data][unit_amount]', '100');
            stripeBody.append('line_items[0][price_data][product_data][name]', `Venue Booking - ${venueName}`);
            stripeBody.append('line_items[0][quantity]', '1');
            // Connect split re-enabled when venue owner has separate Stripe account
            // application_fee_amount: 5000, transfer_data destination: stripeAccountId
            stripeBody.append('success_url', env.FRONTEND_URL + '/booking-confirmed.html?session_id={CHECKOUT_SESSION_ID}');
            stripeBody.append('cancel_url', env.FRONTEND_URL + '/booking-cancelled.html?session_id={CHECKOUT_SESSION_ID}');
            stripeBody.append('metadata[booking_id]', String(bookingId));

            const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
                'Content-Type': 'application/x-www-form-urlencoded'
              },
              body: stripeBody.toString()
            });

            const stripeData = await stripeRes.json();
            console.log('[stripe] status:', stripeRes.status, 'body:', JSON.stringify(stripeData));

            if (!stripeRes.ok) {
              return jsonResponse({ error: stripeData.error?.message || 'Stripe error' }, 400, request);
            }

            const paymentLink = stripeData.url;
            const sessionId = stripeData.id;

            await env.DB.prepare(
              "UPDATE bookings SET status='accepted', payment_link=?, stripe_session_id=? WHERE id=?"
            ).bind(paymentLink, sessionId, id).run();

            // TEST — 100 cents = $1.00 booking total. Restore to venue.price_per_day * 100 before launch.
            await env.DB.prepare(
              "UPDATE bookings SET total_amount = ? WHERE id = ?"
            ).bind(100, bookingId).run();

            if (env.RESEND_API_KEY) {
              const emailPayload = {
                from: "Venue Portal <onboarding@resend.dev>",
                // Sends to real promoter email — requires verified Resend domain to
                // deliver to any address. Until domain verified, only delivers to
                // paxey333@gmail.com for testing.
                to: [booking.client_email],
                subject: "Your booking request has been accepted — complete your deposit",
                html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto"><h2 style="color:#111">Great news, ${booking.client_name}!</h2><p>Your booking request for <strong>${booking.event_date}</strong> has been accepted.</p><p>To confirm your spot, complete your deposit:</p><p style="text-align:center;margin:32px 0"><a href="${paymentLink}" style="background:#f5a623;color:#111;font-weight:700;padding:14px 28px;border-radius:6px;text-decoration:none;display:inline-block">Complete Deposit &#8594;</a></p><p style="color:#888;font-size:13px">If you have questions, reply to this email.</p></div>`,
              };
              console.log("[bookings/accept] resend payload:", JSON.stringify({ ...emailPayload, html: "[omitted]" }));
              const resendRes = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                  "Authorization": "Bearer " + env.RESEND_API_KEY,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(emailPayload),
              });
              const resendBody = await resendRes.json();
              console.log("[bookings/accept] resend response status:", resendRes.status, "body:", JSON.stringify(resendBody));
            }

          } else if (status === "declined") {
            const res = await env.DB.prepare(
              "UPDATE bookings SET status='declined' WHERE id=?"
            ).bind(id).run();
            if (!res.meta.changes) return jsonResponse({ error: "Booking not found" }, 404, request);

          } else {
            const res = await env.DB.prepare(
              "UPDATE bookings SET status = ? WHERE id = ?"
            ).bind(status, id).run();
            if (!res.meta.changes) return jsonResponse({ error: "Booking not found" }, 404, request);
          }

          const updated = await env.DB.prepare(
            `SELECT b.id, b.venue_id, v.name AS venue_name, b.client_name, b.client_email,
                    b.event_date, b.guests, b.message, b.status, b.created_at, b.payment_link
             FROM bookings b LEFT JOIN venues v ON v.id = b.venue_id WHERE b.id = ?`
          ).bind(id).first();
          return jsonResponse(updated, 200, request);
        } catch (err) {
          console.log("[bookings/status] caught error:", err.message, JSON.stringify(err));
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

          console.log("[FILTER] GET /api/venues/:id/stats hit by user:", session.user_id ?? session.email, "role:", session.role, "session venue_id:", session.venue_id, "WHERE clause venue_id:", id);

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

      // ── STRIPE: START CONNECT ONBOARDING ────────────────────────────────────
      const stripeConnectMatch = path.match(/^\/api\/stripe\/connect\/(\d+)$/);
      if (stripeConnectMatch && request.method === "GET") {
        try {
          const session = await getSession(request, env);
          console.log("[stripe/connect] session:", JSON.stringify(session));
          if (!session) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const venueId = parseInt(stripeConnectMatch[1]);
          console.log("[stripe/connect] venueId:", venueId, "session.venue_id:", session.venue_id, "role:", session.role);
          if (session.role === "venue_owner" && session.venue_id !== venueId) {
            return jsonResponse({ error: "Forbidden" }, 403, request);
          }
          if (session.role !== "venue_owner" && session.role !== "admin" && session.role !== "superadmin") {
            return jsonResponse({ error: "Forbidden" }, 403, request);
          }

          const venue = await env.DB.prepare(
            "SELECT stripe_account_id FROM venues WHERE id = ?"
          ).bind(venueId).first();
          console.log("[stripe/connect] venue row:", JSON.stringify(venue));
          if (!venue) return jsonResponse({ error: "Venue not found" }, 404, request);

          let stripeAccountId = venue.stripe_account_id;

          if (!stripeAccountId) {
            console.log("[stripe/connect] creating new Stripe Express account");
            const createRes = await fetch("https://api.stripe.com/v1/accounts", {
              method: "POST",
              headers: {
                "Authorization": "Bearer " + env.STRIPE_SECRET_KEY,
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({ type: "express" }).toString(),
            });
            const createBody = await createRes.json();
            console.log("[stripe/connect] create account status:", createRes.status, "body:", JSON.stringify(createBody));
            if (!createRes.ok) {
              return jsonResponse({ error: createBody?.error?.message ?? "Failed to create Stripe account" }, 502, request);
            }
            stripeAccountId = createBody.id;
            await env.DB.prepare(
              "UPDATE venues SET stripe_account_id = ? WHERE id = ?"
            ).bind(stripeAccountId, venueId).run();
          }

          console.log("[stripe/connect] using stripeAccountId:", stripeAccountId);
          console.log("[stripe/connect] FRONTEND_URL:", env.FRONTEND_URL);

          const params = new URLSearchParams({
            account: stripeAccountId,
            refresh_url: env.FRONTEND_URL + "/dashboard.html?stripe=refresh",
            return_url:  env.FRONTEND_URL + "/dashboard.html?stripe=success",
            type: "account_onboarding",
          });

          console.log("[stripe/connect] account_links params:", params.toString());

          const stripeRes = await fetch("https://api.stripe.com/v1/account_links", {
            method: "POST",
            headers: {
              "Authorization": "Bearer " + env.STRIPE_SECRET_KEY,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: params.toString(),
          });

          const stripeBody = await stripeRes.json();
          console.log("[stripe/connect] account_links status:", stripeRes.status, "body:", JSON.stringify(stripeBody));

          if (!stripeRes.ok) {
            return jsonResponse({ error: stripeBody?.error?.message ?? "Stripe error" }, 502, request);
          }

          return jsonResponse({ url: stripeBody.url }, 200, request);
        } catch (err) {
          console.log("[stripe/connect] caught error:", err.message, err.stack);
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── STRIPE: STATUS ───────────────────────────────────────────────────────
      const stripeStatusMatch = path.match(/^\/api\/stripe\/status\/(\d+)$/);
      if (stripeStatusMatch && request.method === "GET") {
        try {
          const session = await getSession(request, env);
          if (!session) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const venueId = parseInt(stripeStatusMatch[1]);
          console.log("[stripe/status] venueId:", venueId, "role:", session.role);
          if (session.role === "venue_owner" && session.venue_id !== venueId) {
            return jsonResponse({ error: "Forbidden" }, 403, request);
          }

          const row = await env.DB.prepare(
            "SELECT stripe_account_id, stripe_connected FROM venues WHERE id = ?"
          ).bind(venueId).first();

          if (!row) return jsonResponse({ error: "Venue not found" }, 404, request);

          console.log("[stripe/status] result:", JSON.stringify(row));
          // Explicit scoping log — confirms admin preview returns the previewed venue's data, not the admin's.
          console.log("[STRIPE STATUS] checking venue_id:", venueId, "returning connected:", row.stripe_connected === 1, "account:", row.stripe_account_id);
          return jsonResponse({
            connected: row.stripe_connected === 1,
            stripe_account_id: row.stripe_account_id ?? null,
          }, 200, request);
        } catch (err) {
          console.log("[stripe/status] error:", err.message);
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── STRIPE: WEBHOOK (Connect dashboard — account.updated only) ──────────
      // Booking-related events (payment_intent.succeeded, checkout.session.completed)
      // live in /webhooks/stripe which is signature-verified.
      if (path === "/api/stripe/webhook" && request.method === "POST") {
        try {
          const event = await request.json();
          console.log("[stripe/webhook] event.type:", event.type, "account:", event.account);

          const isV1 = event.type === "account.updated";
          const isV2 = event.type === "v2.core.account.updated";

          if (isV1 || isV2) {
            // Log the full body the first time we see one of these so we can confirm v2 shape.
            console.log("Webhook account event received:", JSON.stringify(event));

            // Extract account id — try every plausible location across v1/v2 payloads.
            const acct = event.data?.object ?? event.data ?? {};
            const acctId =
              acct.id ||
              event.account ||
              event.data?.id ||
              acct.account ||
              null;

            // charges_enabled lives directly on the account in v1; v2 may nest under
            // configuration.merchant.charges_enabled or capabilities — check several paths.
            const chargesEnabled =
              acct.charges_enabled === true ||
              acct.configuration?.merchant?.charges_enabled === true ||
              acct.configuration?.customer?.charges_enabled === true ||
              acct.capabilities?.card_payments === "active" ||
              false;

            console.log("[stripe/webhook] parsed acctId:", acctId, "chargesEnabled:", chargesEnabled, "format:", isV2 ? "v2" : "v1");

            if (chargesEnabled && acctId) {
              const result = await env.DB.prepare(
                "UPDATE venues SET stripe_connected = 1, stripe_account_id = ? WHERE stripe_account_id = ?"
              ).bind(acctId, acctId).run();
              console.log("[stripe/webhook] DB update changes:", result.meta?.changes);
            } else if (!acctId) {
              console.log("[stripe/webhook] WARNING: could not extract account id from event payload");
            }
          }
          return jsonResponse({ received: true }, 200, request);
        } catch (err) {
          console.log("[stripe/webhook] error:", err.message);
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── AI DRAFT REPLY ───────────────────────────────────────────────────────
      if (path === "/api/draft-reply" && request.method === "POST") {
        console.log("[draft-reply] route hit");
        try {
          const session = await getSession(request, env);
          if (!isAnyRole(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);

          console.log("[draft-reply] API key present:", !!env.ANTHROPIC_API_KEY);

          const body = await parseJson(request);
          console.log("[draft-reply] venue:", JSON.stringify(body.venue));
          console.log("[draft-reply] inquiry:", JSON.stringify(body.inquiry));

          const venue   = body.venue   || {};
          const inquiry = body.inquiry || {};

          const systemPrompt = `You are a professional venue coordinator writing on behalf of a venue called ${venue.name || "the venue"}. \nThe venue is located at ${venue.location || ""}. \nCapacity: ${venue.capacity || ""} guests.\nPrice: $${venue.price_per_day || ""} per night.\nAmenities: ${Array.isArray(venue.amenities) ? venue.amenities.join(", ") : ""}.\nHours: ${venue.hours || ""}.\nWrite warm, professional, concise inquiry responses. No fluff. No emoji. Sign off with the venue name only.`;

          const userPrompt = `Draft a reply to this venue inquiry:\nName: ${inquiry.client_name || ""}\nEmail: ${inquiry.client_email || ""}\nEvent date: ${inquiry.event_date || ""}\nGuests: ${inquiry.guests || ""}\nMessage: "${inquiry.message || ""}"\n\nWrite a warm professional response confirming we received their inquiry, mention availability for their date, highlight one or two relevant amenities, state the $${venue.price_per_day || ""} per night rate, and invite them to confirm so we can send the booking deposit link.`;

          const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "anthropic-version": "2023-06-01",
              "x-api-key": env.ANTHROPIC_API_KEY,
            },
            body: JSON.stringify({
              model: "claude-sonnet-4-6",
              max_tokens: 1000,
              system: systemPrompt,
              messages: [{ role: "user", content: userPrompt }],
            }),
          });

          const anthropicData = await anthropicRes.json();
          console.log("[draft-reply] Anthropic status:", anthropicRes.status, "body:", JSON.stringify(anthropicData));

          if (!anthropicRes.ok) {
            return jsonResponse({ error: anthropicData?.error?.message || "Anthropic API error" }, 502, request);
          }

          if (!anthropicData.content || !anthropicData.content[0] || !anthropicData.content[0].text) {
            console.log("[draft-reply] unexpected response shape:", JSON.stringify(anthropicData));
            return jsonResponse({ error: "Unexpected response from Anthropic" }, 502, request);
          }

          return jsonResponse({ draft: anthropicData.content[0].text }, 200, request);
        } catch (err) {
          console.log("[draft-reply] caught error:", err.message, err.stack);
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── BOOKING LOOKUP BY STRIPE SESSION (public) ───────────────
      const bookingBySessionMatch = path.match(/^\/api\/bookings\/by-session\/(.+)$/);
      if (bookingBySessionMatch && request.method === "GET") {
        try {
          const sessionId = decodeURIComponent(bookingBySessionMatch[1]);
          const row = await env.DB.prepare(
            `SELECT b.id, b.client_name, b.client_email, b.event_date, b.guests,
                    b.total_amount, b.status, b.created_at,
                    v.name AS venue_name, v.description AS venue_location
             FROM bookings b
             LEFT JOIN venues v ON b.venue_id = v.id
             WHERE b.stripe_session_id = ?`
          ).bind(sessionId).first();
          if (!row) return jsonResponse({ error: "Booking not found" }, 404, request);
          return jsonResponse(row, 200, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── ONBOARDING SUBMISSION (public) ──────────────────────────
      if (path === "/api/onboard" && request.method === "POST") {
        try {
          const body = await parseJson(request);
          const venueName    = String(body.venue_name || "").trim();
          const contactEmail = String(body.contact_email || "").trim();
          if (!venueName)    return jsonResponse({ error: "venue_name is required" }, 400, request);
          if (!contactEmail) return jsonResponse({ error: "contact_email is required" }, 400, request);

          const esc = (s) => String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const amenities = Array.isArray(body.amenities) ? body.amenities : [];
          const row = (label, val) => `<tr><td style="padding:6px 12px 6px 0;color:#888;font-family:monospace;font-size:11px;text-transform:uppercase;letter-spacing:.08em;vertical-align:top;white-space:nowrap">${esc(label)}</td><td style="padding:6px 0;color:#111;font-size:14px;line-height:1.5">${esc(val) || '<span style="color:#bbb">—</span>'}</td></tr>`;
          const html = `
            <div style="font-family:sans-serif;max-width:640px;margin:0 auto;padding:20px;background:#fff;color:#111">
              <h2 style="margin:0 0 4px;font-size:20px">New Venue Onboarding</h2>
              <div style="color:#888;font-size:12px;margin-bottom:18px">${esc(venueName)}</div>
              <table style="width:100%;border-collapse:collapse;border-top:1px solid #eee">
                ${row('Venue Name',      body.venue_name)}
                ${row('Address',         body.address)}
                ${row('Capacity',        body.capacity)}
                ${row('Price / Night',   body.price_per_day)}
                ${row('Hours',           body.hours)}
                ${row('Description',     body.description)}
                ${row('House Rules',     body.house_rules)}
                ${row('Amenities',       amenities.join(', '))}
                ${row('Photo Links',     body.photo_links)}
                ${row('Video URL',       body.video_url)}
                ${row('Contact Name',    body.contact_name)}
                ${row('Contact Email',   body.contact_email)}
                ${row('Contact Phone',   body.contact_phone)}
                ${row('Additional Notes',body.additional_notes)}
              </table>
              <div style="margin-top:16px;color:#888;font-size:11px">Submitted via /onboard.html</div>
            </div>`;

          if (!env.RESEND_API_KEY) {
            console.log("[onboard] RESEND_API_KEY not configured; submission logged only:", venueName);
            return jsonResponse({ ok: true, message: "Submission received" }, 200, request);
          }

          const adminEmail = env.ADMIN_EMAIL || "paxey333@gmail.com";
          const resendRes = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": "Bearer " + env.RESEND_API_KEY,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              // TODO: switch to onboard@venueportal.us once domain verified in Resend
              from: "Venue Portal <onboarding@resend.dev>",
              to: [adminEmail],
              reply_to: contactEmail,
              subject: "New Venue Onboarding Submission — " + venueName,
              html
            })
          });
          if (!resendRes.ok) {
            const errText = await resendRes.text();
            console.log("[onboard] resend error:", resendRes.status, errText);
            return jsonResponse({ error: "Email delivery failed" }, 502, request);
          }
          return jsonResponse({ ok: true, message: "Submission received" }, 200, request);
        } catch (err) {
          console.log("[onboard] error:", err.message);
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