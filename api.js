/* ─────────────────────────────────────────────
   VENUE PORTAL — API WORKER
   Roles: superadmin | admin | venue_owner
   Auth: HMAC-SHA256 signed tokens, 24hr expiry

   Required env vars (wrangler secrets):
   STRIPE_SECRET_KEY         — sk_live_... or sk_test_...
   STRIPE_PLATFORM_ACCOUNT_ID — acct_... (your Stripe account)
   FRONTEND_URL              — https://venueportal.us
───────────────────────────────────────────── */

const ALLOWED_ORIGINS = [
  "https://venueportal.us",
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

            // Send confirmation email to promoter
            const booking = await env.DB.prepare(
              `SELECT b.id, b.client_name, b.client_email, b.event_date, b.guests, b.total_amount,
                      v.name AS venue_name, v.description AS venue_location
               FROM bookings b LEFT JOIN venues v ON v.id = b.venue_id
               WHERE b.stripe_session_id = ?`
            ).bind(sess.id).first();

            if (booking && env.RESEND_API_KEY) {
              const amount = booking.total_amount ? '$' + (booking.total_amount / 100).toLocaleString('en-US', {minimumFractionDigits:2}) : '—';
              const dateFormatted = booking.event_date ? new Date(booking.event_date + 'T00:00:00').toLocaleDateString('en-US', {weekday:'long',month:'long',day:'numeric',year:'numeric'}) : booking.event_date;

              // Email to promoter
              await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                  "Authorization": "Bearer " + env.RESEND_API_KEY,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  from: "Venue Portal <noreply@venueportal.us>",
                  to: [booking.client_email],
                  subject: "Booking confirmed — " + booking.venue_name,
                  html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#fff;color:#111;padding:32px 28px;border-radius:8px">
          <div style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#888;margin-bottom:20px">Venue.Portal</div>
          <h1 style="font-size:24px;font-weight:800;margin:0 0 6px;letter-spacing:-.3px">You're confirmed.</h1>
          <p style="color:#555;font-size:14px;margin:0 0 28px;line-height:1.6">Hi ${booking.client_name} — your deposit went through and your booking is locked in.</p>
          <div style="background:#f7f7f7;border-radius:8px;padding:20px 22px;margin-bottom:28px">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#999;padding:6px 0 2px">Venue</td></tr>
              <tr><td style="font-size:15px;font-weight:600;padding-bottom:14px;border-bottom:1px solid #eee">${booking.venue_name}</td></tr>
              <tr><td style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#999;padding:14px 0 2px">Event Date</td></tr>
              <tr><td style="font-size:15px;font-weight:600;padding-bottom:14px;border-bottom:1px solid #eee">${dateFormatted}</td></tr>
              <tr><td style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#999;padding:14px 0 2px">Amount Paid</td></tr>
              <tr><td style="font-size:15px;font-weight:700;color:#111">${amount}</td></tr>
            </table>
          </div>
          <p style="color:#888;font-size:12px;line-height:1.6;margin:0">Questions? Reply to this email or contact us at hello@venueportal.us</p>
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;font-family:monospace;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#bbb">Venue.Portal · Flat fee. No cuts.</div>
        </div>`
                })
              });

              // Email to venue owner
              const owner = await env.DB.prepare(
                "SELECT email FROM users WHERE venue_id = (SELECT venue_id FROM bookings WHERE stripe_session_id = ?) AND role = 'venue_owner' LIMIT 1"
              ).bind(sess.id).first();

              if (owner) {
                await fetch("https://api.resend.com/emails", {
                  method: "POST",
                  headers: {
                    "Authorization": "Bearer " + env.RESEND_API_KEY,
                    "Content-Type": "application/json"
                  },
                  body: JSON.stringify({
                    from: "Venue Portal <noreply@venueportal.us>",
                    to: [owner.email],
                    subject: "Deposit received — " + booking.client_name + " · " + dateFormatted,
                    html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#fff;color:#111;padding:32px 28px;border-radius:8px">
            <div style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#888;margin-bottom:20px">Venue.Portal</div>
            <h1 style="font-size:22px;font-weight:800;margin:0 0 6px">Deposit received.</h1>
            <p style="color:#555;font-size:14px;margin:0 0 24px;line-height:1.6">A booking deposit just came in for ${booking.venue_name}.</p>
            <div style="background:#f7f7f7;border-radius:8px;padding:20px 22px;margin-bottom:24px">
              <table style="width:100%;border-collapse:collapse">
                <tr><td style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#999;padding:6px 0 2px">Promoter</td></tr>
                <tr><td style="font-size:14px;font-weight:600;padding-bottom:12px;border-bottom:1px solid #eee">${booking.client_name} · ${booking.client_email}</td></tr>
                <tr><td style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#999;padding:12px 0 2px">Event Date</td></tr>
                <tr><td style="font-size:14px;font-weight:600;padding-bottom:12px;border-bottom:1px solid #eee">${dateFormatted}</td></tr>
                <tr><td style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#999;padding:12px 0 2px">Deposit Amount</td></tr>
                <tr><td style="font-size:14px;font-weight:700">${amount} <span style="font-weight:400;color:#999;font-size:12px">(your payout is on its way via Stripe)</span></td></tr>
              </table>
            </div>
            <p style="color:#888;font-size:12px;line-height:1.6">Log in to your dashboard to view the full booking details.</p>
            <div style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;font-family:monospace;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#bbb">Venue.Portal · Flat fee. No cuts.</div>
          </div>`
                  })
                });
              }
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
            "SELECT id, email, password, role, venue_id, name, first_login FROM users WHERE email = ?"
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
            return jsonResponse({ token, role: user.role, venue_id: user.venue_id ?? null, name: user.name, first_login: user.first_login === 1 }, 200, request);
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

      // ── AUTH: CHANGE PASSWORD (self-service) ────────────────────
      if (path === "/api/auth/change-password" && request.method === "PATCH") {
        try {
          const session = await getSession(request, env);
          if (!isAnyRole(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const body = await parseJson(request);
          const newPassword = String(body.new_password || "");
          if (!newPassword || newPassword.length < 8) {
            return jsonResponse({ error: "Password must be at least 8 characters" }, 400, request);
          }
          const user = await env.DB.prepare(
            "SELECT id FROM users WHERE email = ?"
          ).bind(String(session.email).toLowerCase()).first();
          if (!user) return jsonResponse({ error: "User not found" }, 404, request);
          const newHash = await hashPassword(newPassword, env.TOKEN_SECRET);
          await env.DB.prepare(
            "UPDATE users SET password = ?, first_login = 0 WHERE id = ?"
          ).bind(newHash, user.id).run();
          return jsonResponse({ ok: true }, 200, request);
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
            "INSERT INTO users (email, password, role, venue_id, name, first_login) VALUES (?, ?, ?, ?, ?, 1)"
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
                from: "Venue Portal <noreply@venueportal.us>",
                to: [email],
                subject: "Your Venue Portal is ready",
                html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto"><h2 style="color:#111">Welcome to Venue Portal, ${name}!</h2>${venueName ? `<p>Your venue <strong>${venueName}</strong> has been set up and is ready to go.</p>` : ""}<p>Log in to manage your bookings and venue profile.</p><p><strong>Email:</strong> ${email}<br><strong>Temporary password:</strong> ${plainPassword}</p><p style="color:#888;font-size:13px">Please change your password after your first login.</p><p style="text-align:center;margin:32px 0"><a href="https://venueportal.us/dashboard.html" style="background:#f5a623;color:#111;font-weight:700;padding:14px 28px;border-radius:6px;text-decoration:none;display:inline-block">Go to Dashboard &#8594;</a></p></div>`,
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
            `SELECT id, name, description, capacity, price_per_day, image_url, address, city, state, created_at
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
            `INSERT INTO venues (name, description, capacity, price_per_day, image_url, address, city, state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            name,
            body.description ? String(body.description) : null,
            toIntOrNull(body.capacity),
            toNumberOrNull(body.price_per_day),
            body.image_url ? String(body.image_url) : null,
            body.address ? String(body.address) : null,
            body.city ? String(body.city) : null,
            body.state ? String(body.state) : null
          ).run();

          const created = await env.DB.prepare(
            `SELECT id, name, description, capacity, price_per_day, image_url, address, city, state, created_at
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
          // PUBLIC: anonymous read allowed so venue.html?id=X (Commit C of the
          // public-surface rebuild) can render for unauthenticated visitors.
          // The SELECT below pulls no secrets — Stripe fields are NOT included.
          // Dashboard's loadVenueProfile() keeps working since extra Authorization
          // headers don't affect a no-auth endpoint. Operator-approved change.
          const session = await getSession(request, env).catch(() => null);
          console.log("[GET /api/venues/:id]", id, "session:", session ? session.role : "public");
          const row = await env.DB.prepare(
            `SELECT id, name, description, capacity, price_per_day, image_url, hours, amenities, gallery, video_url, address, city, state, created_at
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
          if ('address' in body)       { fields.push('address=?');       values.push(body.address ? String(body.address) : null); }
          if ('city' in body)          { fields.push('city=?');          values.push(body.city ? String(body.city) : null); }
          if ('state' in body)         { fields.push('state=?');         values.push(body.state ? String(body.state) : null); }

          if (!fields.length) return jsonResponse({ error: "No fields to update" }, 400, request);

          const exists = await env.DB.prepare("SELECT id FROM venues WHERE id=?").bind(id).first();
          if (!exists) return jsonResponse({ error: "Venue not found" }, 404, request);

          values.push(id);
          await env.DB.prepare(
            `UPDATE venues SET ${fields.join(', ')} WHERE id=?`
          ).bind(...values).run();

          const updated = await env.DB.prepare(
            `SELECT id, name, description, capacity, price_per_day, image_url, hours, amenities, gallery, video_url, address, city, state, created_at FROM venues WHERE id=?`
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

      // ── VENUE BOOKED DATES (public — for venue.html calendar) ─────
      // Returns only confirmed event_dates for the venue. No PII (no client
      // name/email/message). Used by venue.html to mark unavailable dates
      // on its booking calendar. Anonymous read allowed.
      const venueBookedDatesMatch = path.match(/^\/api\/venues\/(\d+)\/booked-dates$/);
      if (venueBookedDatesMatch && request.method === "GET") {
        try {
          const id = Number(venueBookedDatesMatch[1]);
          const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
          const cutoffStr = cutoff.toISOString().slice(0, 10);
          const bookingRows = await env.DB.prepare(
            `SELECT id, event_date, event_time_start, event_time_end, status,
                    client_name, client_email, guests, message, created_at
             FROM bookings
             WHERE venue_id = ? AND status IN ('confirmed','pending','accepted')
               AND event_date >= ?
             ORDER BY event_date ASC`
          ).bind(id, cutoffStr).all();
          const blockRows = await env.DB.prepare(
            `SELECT id, block_date AS date, time_start, time_end, reason
             FROM venue_blocks WHERE venue_id = ? ORDER BY block_date ASC`
          ).bind(id).all();
          const events = (bookingRows.results || []).map(r => ({
            id: r.id,
            date: r.event_date,
            time_start: r.event_time_start || null,
            time_end: r.event_time_end || null,
            status: r.status,
            client_name: r.client_name,
            client_email: r.client_email,
            guests: r.guests,
            message: r.message,
            created_at: r.created_at
          }));
          const blocks = (blockRows.results || []).map(r => ({
            id: r.id,
            date: r.date,
            time_start: r.time_start || null,
            time_end: r.time_end || null,
            reason: r.reason
          }));

          // Auth-aware response: owners/admins get full detail; public gets only taken dates.
          // Pending bookings are NEVER exposed publicly (owner-only info).
          const session = await getSession(request, env);
          const isPrivileged = session && (
            isAdminOrAbove(session) ||
            (session.venue_id === Number(id))
          );
          if (isPrivileged) {
            return jsonResponse({ events, blocks }, 200, request);
          }
          const takenDates = new Set();
          events
            .filter(e => e.status === 'confirmed' || e.status === 'accepted')
            .forEach(e => takenDates.add(e.date));
          blocks.forEach(b => takenDates.add(b.date));
          return jsonResponse({ dates: Array.from(takenDates).sort() }, 200, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── VENUE BLOCKS: CREATE ──────────────────────────────────────
      const venueBlocksMatch = path.match(/^\/api\/venues\/(\d+)\/blocks$/);
      if (venueBlocksMatch && request.method === "POST") {
        try {
          const session = await getSession(request, env);
          if (!isAnyRole(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const id = Number(venueBlocksMatch[1]);
          if (session.role === "venue_owner" && session.venue_id !== id) {
            return jsonResponse({ error: "Forbidden" }, 403, request);
          }
          const body = await parseJson(request);
          const blockDate = String(body.block_date || "").trim();
          const reason = String(body.reason || "Blocked").trim();
          if (!blockDate) return jsonResponse({ error: "block_date is required" }, 400, request);
          const result = await env.DB.prepare(
            `INSERT INTO venue_blocks (venue_id, block_date, time_start, time_end, reason)
             VALUES (?, ?, ?, ?, ?)`
          ).bind(id, blockDate, body.time_start || null, body.time_end || null, reason).run();
          const created = await env.DB.prepare(
            "SELECT id, venue_id, block_date AS date, time_start, time_end, reason, created_at FROM venue_blocks WHERE id = ?"
          ).bind(result.meta.last_row_id).first();
          return jsonResponse(created, 201, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── VENUE BLOCKS: DELETE ──────────────────────────────────────
      const venueBlockDeleteMatch = path.match(/^\/api\/venues\/(\d+)\/blocks\/(\d+)$/);
      if (venueBlockDeleteMatch && request.method === "DELETE") {
        try {
          const session = await getSession(request, env);
          if (!isAnyRole(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const venueId = Number(venueBlockDeleteMatch[1]);
          const blockId = Number(venueBlockDeleteMatch[2]);
          if (session.role === "venue_owner" && session.venue_id !== venueId) {
            return jsonResponse({ error: "Forbidden" }, 403, request);
          }
          const res = await env.DB.prepare(
            "DELETE FROM venue_blocks WHERE id = ? AND venue_id = ?"
          ).bind(blockId, venueId).run();
          if (!res.meta.changes) return jsonResponse({ error: "Block not found" }, 404, request);
          return jsonResponse({ ok: true }, 200, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── VENUE AVAILABILITY RULES: GET (public) ───────────────────
      const venueRulesMatch = path.match(/^\/api\/venues\/(\d+)\/availability-rules$/);
      if (venueRulesMatch && request.method === "GET") {
        try {
          const id = Number(venueRulesMatch[1]);
          const rows = await env.DB.prepare(
            "SELECT day_of_week, time_start, time_end, is_open FROM venue_availability_rules WHERE venue_id = ? ORDER BY day_of_week ASC"
          ).bind(id).all();
          if (rows.results && rows.results.length > 0) {
            return jsonResponse({ rules: rows.results }, 200, request);
          }
          const defaults = [];
          for (let d = 0; d < 7; d++) defaults.push({ day_of_week: d, time_start: "00:00", time_end: "23:59", is_open: 1 });
          return jsonResponse({ rules: defaults }, 200, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── VENUE AVAILABILITY RULES: PUT (owner/admin) ──────────────
      if (venueRulesMatch && request.method === "PUT") {
        try {
          const session = await getSession(request, env);
          if (!isAnyRole(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const id = Number(venueRulesMatch[1]);
          if (session.role === "venue_owner" && session.venue_id !== id) {
            return jsonResponse({ error: "Forbidden" }, 403, request);
          }
          const body = await parseJson(request);
          const rules = body.rules;
          if (!Array.isArray(rules) || rules.length !== 7) {
            return jsonResponse({ error: "rules must be an array of exactly 7 entries" }, 400, request);
          }
          const seen = new Set();
          const hhmmRe = /^\d{2}:\d{2}$/;
          for (const r of rules) {
            const dow = Number(r.day_of_week);
            if (dow < 0 || dow > 6 || !Number.isInteger(dow)) return jsonResponse({ error: "Invalid day_of_week: " + r.day_of_week }, 400, request);
            if (seen.has(dow)) return jsonResponse({ error: "Duplicate day_of_week: " + dow }, 400, request);
            seen.add(dow);
            if (Number(r.is_open)) {
              if (!r.time_start || !r.time_end) return jsonResponse({ error: "time_start and time_end required when is_open=1 for day " + dow }, 400, request);
              if (!hhmmRe.test(r.time_start) || !hhmmRe.test(r.time_end)) return jsonResponse({ error: "Times must be HH:MM for day " + dow }, 400, request);
              if (r.time_start >= r.time_end) return jsonResponse({ error: "time_start must be before time_end for day " + dow }, 400, request);
            }
          }
          await env.DB.prepare("DELETE FROM venue_availability_rules WHERE venue_id = ?").bind(id).run();
          const stmt = env.DB.prepare(
            "INSERT INTO venue_availability_rules (venue_id, day_of_week, time_start, time_end, is_open) VALUES (?, ?, ?, ?, ?)"
          );
          const batch = rules.map(r => stmt.bind(id, Number(r.day_of_week), r.is_open ? r.time_start : null, r.is_open ? r.time_end : null, r.is_open ? 1 : 0));
          await env.DB.batch(batch);
          const saved = await env.DB.prepare(
            "SELECT day_of_week, time_start, time_end, is_open FROM venue_availability_rules WHERE venue_id = ? ORDER BY day_of_week ASC"
          ).bind(id).all();
          return jsonResponse({ rules: saved.results || [] }, 200, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── VENUE PHOTOS: UPLOAD / DELETE (R2-backed) ─────────────────
      // Public URL prefix served by the R2 bucket via Cloudflare custom domain.
      // Requires the `venue-photos` R2 bucket to have `images.venueportal.us`
      // connected under Settings -> Public Access -> Connect Domain.
      const venuePhotosMatch = path.match(/^\/api\/venues\/(\d+)\/photos$/);
      const R2_PUBLIC_BASE = "https://images.venueportal.us";
      const MAX_PHOTOS = 8;
      const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
      const ALLOWED_MIME = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

      if (venuePhotosMatch && request.method === "POST") {
        try {
          const session = await getSession(request, env);
          if (!isAnyRole(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const id = Number(venuePhotosMatch[1]);
          if (session.role === "venue_owner" && session.venue_id !== id) {
            return jsonResponse({ error: "Forbidden" }, 403, request);
          }
          if (!env.VENUE_PHOTOS) return jsonResponse({ error: "R2 bucket not bound (VENUE_PHOTOS)" }, 500, request);

          // Parse multipart upload — expects a single file field named "file"
          let form;
          try { form = await request.formData(); }
          catch (e) { return jsonResponse({ error: "Invalid multipart body" }, 400, request); }
          const file = form.get("file");
          if (!file || typeof file === "string") {
            return jsonResponse({ error: "Missing 'file' field in form data" }, 400, request);
          }

          // Validate MIME
          const ext = ALLOWED_MIME[file.type];
          if (!ext) {
            return jsonResponse({ error: "Unsupported file type. Allowed: image/jpeg, image/png, image/webp." }, 400, request);
          }
          // Validate size (read .size if present; fallback to byte count via arrayBuffer)
          const size = typeof file.size === "number" ? file.size : (await file.arrayBuffer()).byteLength;
          if (size < 1 || size > MAX_BYTES) {
            return jsonResponse({ error: `File must be between 1 byte and ${MAX_BYTES} bytes (5MB).` }, 400, request);
          }

          // Verify venue exists + fetch current gallery
          const venue = await env.DB.prepare("SELECT id, gallery FROM venues WHERE id = ?").bind(id).first();
          if (!venue) return jsonResponse({ error: "Venue not found" }, 404, request);
          let gallery = [];
          if (venue.gallery) {
            try { const parsed = JSON.parse(venue.gallery); if (Array.isArray(parsed)) gallery = parsed; }
            catch (e) { gallery = []; }
          }
          if (gallery.length >= MAX_PHOTOS) {
            return jsonResponse({ error: `This venue already has the maximum of ${MAX_PHOTOS} photos. Delete one first.` }, 409, request);
          }

          // Build storage key + upload to R2
          const key = `venue-photos/${id}/${Date.now()}.${ext}`;
          await env.VENUE_PHOTOS.put(key, file.stream(), {
            httpMetadata: { contentType: file.type }
          });

          // Append URL to D1 gallery
          const url = `${R2_PUBLIC_BASE}/${key}`;
          gallery.push(url);
          await env.DB.prepare("UPDATE venues SET gallery = ? WHERE id = ?")
            .bind(JSON.stringify(gallery), id).run();

          console.log("[VENUE PHOTO UPLOAD]", "venue_id:", id, "key:", key, "size:", size, "gallery_count:", gallery.length);
          return jsonResponse({ success: true, url, gallery }, 200, request);
        } catch (err) {
          console.log("[VENUE PHOTO UPLOAD ERROR]", err && err.message);
          return jsonResponse({ error: err.message || "Upload failed" }, 500, request);
        }
      }

      if (venuePhotosMatch && request.method === "DELETE") {
        try {
          const session = await getSession(request, env);
          if (!isAnyRole(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const id = Number(venuePhotosMatch[1]);
          if (session.role === "venue_owner" && session.venue_id !== id) {
            return jsonResponse({ error: "Forbidden" }, 403, request);
          }
          if (!env.VENUE_PHOTOS) return jsonResponse({ error: "R2 bucket not bound (VENUE_PHOTOS)" }, 500, request);

          const body = await parseJson(request);
          const url = String(body.url || "").trim();
          if (!url) return jsonResponse({ error: "Missing 'url' in request body" }, 400, request);
          if (!url.startsWith(R2_PUBLIC_BASE + "/")) {
            return jsonResponse({ error: "URL does not belong to this bucket" }, 400, request);
          }
          // Extract the R2 key (everything after the public base + leading /)
          const key = url.slice(R2_PUBLIC_BASE.length + 1);
          if (!key.startsWith(`venue-photos/${id}/`)) {
            return jsonResponse({ error: "URL does not belong to this venue" }, 400, request);
          }

          // Fetch current gallery
          const venue = await env.DB.prepare("SELECT id, gallery FROM venues WHERE id = ?").bind(id).first();
          if (!venue) return jsonResponse({ error: "Venue not found" }, 404, request);
          let gallery = [];
          if (venue.gallery) {
            try { const parsed = JSON.parse(venue.gallery); if (Array.isArray(parsed)) gallery = parsed; }
            catch (e) { gallery = []; }
          }
          const before = gallery.length;
          gallery = gallery.filter(g => g !== url);
          const removedFromGallery = gallery.length < before;

          // Delete from R2 regardless of whether it was in the gallery (idempotent)
          await env.VENUE_PHOTOS.delete(key);

          if (removedFromGallery) {
            await env.DB.prepare("UPDATE venues SET gallery = ? WHERE id = ?")
              .bind(JSON.stringify(gallery), id).run();
          }

          console.log("[VENUE PHOTO DELETE]", "venue_id:", id, "key:", key, "removed_from_gallery:", removedFromGallery, "gallery_count:", gallery.length);
          return jsonResponse({ success: true, removed: removedFromGallery, gallery }, 200, request);
        } catch (err) {
          console.log("[VENUE PHOTO DELETE ERROR]", err && err.message);
          return jsonResponse({ error: err.message || "Delete failed" }, 500, request);
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

          // Notify admin + venue owner of new inquiry
          if (env.RESEND_API_KEY) {
            const venueData = await env.DB.prepare(
              `SELECT v.name AS venue_name, u.email AS owner_email
               FROM venues v
               LEFT JOIN users u ON u.venue_id = v.id AND u.role = 'venue_owner'
               WHERE v.id = ?`
            ).bind(venueId).first();

            const inquiryDate = eventDate ? new Date(eventDate + 'T00:00:00').toLocaleDateString('en-US', {weekday:'long',month:'long',day:'numeric',year:'numeric'}) : eventDate;
            const guestCount = body.guests ? String(body.guests) : '—';
            const message = body.message ? String(body.message) : '—';

            const notifyHtml = `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#fff;color:#111;padding:32px 28px;border-radius:8px">
    <div style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#888;margin-bottom:20px">Venue.Portal</div>
    <h1 style="font-size:22px;font-weight:800;margin:0 0 6px">New inquiry received.</h1>
    <p style="color:#555;font-size:14px;margin:0 0 24px;line-height:1.6">Someone just submitted a booking inquiry for <strong>${venueData?.venue_name || 'your venue'}</strong>. Log in to accept or decline.</p>
    <div style="background:#f7f7f7;border-radius:8px;padding:20px 22px;margin-bottom:24px">
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#999;padding:6px 0 2px">Promoter</td></tr>
        <tr><td style="font-size:14px;font-weight:600;padding-bottom:12px;border-bottom:1px solid #eee">${clientName} · ${clientEmail}</td></tr>
        <tr><td style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#999;padding:12px 0 2px">Event Date</td></tr>
        <tr><td style="font-size:14px;font-weight:600;padding-bottom:12px;border-bottom:1px solid #eee">${inquiryDate}</td></tr>
        <tr><td style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#999;padding:12px 0 2px">Guests</td></tr>
        <tr><td style="font-size:14px;font-weight:600;padding-bottom:12px;border-bottom:1px solid #eee">${guestCount}</td></tr>
        <tr><td style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#999;padding:12px 0 2px">Message</td></tr>
        <tr><td style="font-size:13px;color:#555;line-height:1.6">${message}</td></tr>
      </table>
    </div>
    <a href="https://venueportal.us" style="display:inline-block;background:#111;color:#fff;font-weight:700;font-size:13px;padding:12px 22px;border-radius:6px;text-decoration:none">Go to Dashboard →</a>
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;font-family:monospace;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#bbb">Venue.Portal · Flat fee. No cuts.</div>
  </div>`;

            const recipients = ['paxey333@gmail.com'];
            if (venueData?.owner_email && venueData.owner_email !== 'paxey333@gmail.com') {
              recipients.push(venueData.owner_email);
            }

            await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
              body: JSON.stringify({
                from: "Venue Portal <noreply@venueportal.us>",
                to: recipients,
                subject: "New inquiry — " + (venueData?.venue_name || 'your venue') + " · " + inquiryDate,
                html: notifyHtml
              })
            });
          }

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
                      v.name AS venue_name, v.price_per_day, v.stripe_account_id, v.stripe_connected
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
            stripeBody.append('line_items[0][price_data][product_data][name]', `Venue Booking - ${venueName}`);
            stripeBody.append('line_items[0][quantity]', '1');
            const unitAmount = Math.round(booking.price_per_day * 100);
            const appFee = unitAmount >= 10000 ? 5000 : Math.min(500, Math.floor(unitAmount * 0.25));
            stripeBody.append('line_items[0][price_data][unit_amount]', String(unitAmount));
            stripeBody.append('payment_intent_data[application_fee_amount]', String(appFee));
            stripeBody.append('payment_intent_data[transfer_data][destination]', stripeAccountId);
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
              "UPDATE bookings SET status='confirmed', payment_link=?, stripe_session_id=? WHERE id=?"
            ).bind(paymentLink, sessionId, id).run();

            await env.DB.prepare(
              "UPDATE bookings SET total_amount = ? WHERE id = ?"
            ).bind(unitAmount, bookingId).run();

            if (env.RESEND_API_KEY) {
              const emailPayload = {
                from: "Venue Portal <noreply@venueportal.us>",
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
            const declineRow = await env.DB.prepare(
              `SELECT b.id, b.venue_id, b.client_name, b.client_email, b.event_date, b.guests,
                      v.name AS venue_name
               FROM bookings b LEFT JOIN venues v ON v.id = b.venue_id WHERE b.id = ?`
            ).bind(id).first();
            if (!declineRow) return jsonResponse({ error: "Booking not found" }, 404, request);

            const res = await env.DB.prepare(
              "UPDATE bookings SET status='declined' WHERE id=?"
            ).bind(id).run();
            if (!res.meta.changes) return jsonResponse({ error: "Booking not found" }, 404, request);

            if (env.RESEND_API_KEY && declineRow.client_email) {
              try {
                const firstName = (declineRow.client_name || '').split(/\s+/)[0] || 'there';
                const eventDate = declineRow.event_date || '';
                const venueName = declineRow.venue_name || 'the venue';
                const html = `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#fff;color:#111;padding:32px 28px;border-radius:8px">
        <div style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#888;margin-bottom:20px">Venue.Portal</div>
        <h1 style="font-size:22px;font-weight:800;margin:0 0 12px">Update on your booking request</h1>
        <p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 16px">Hey ${firstName},</p>
        <p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 16px">Unfortunately <strong>${venueName}</strong> isn't able to accommodate your booking request for <strong>${eventDate}</strong>. This could be due to a scheduling conflict, capacity, or other availability reasons.</p>
        <p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 24px">Don't worry — there are other great independent venues on Venue Portal. Browse available spaces and submit a new request anytime.</p>
        <p style="text-align:center;margin:24px 0"><a href="https://venueportal.us" style="display:inline-block;background:#ff6b1a;color:#000;font-weight:700;font-size:14px;padding:13px 26px;border-radius:6px;text-decoration:none">Browse Venues &#x2192;</a></p>
        <div style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;font-family:monospace;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#bbb">Venue.Portal &middot; Flat fee. No cuts.</div>
      </div>`;
                await fetch("https://api.resend.com/emails", {
                  method: "POST",
                  headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    from: "Venue Portal <noreply@venueportal.us>",
                    to: [declineRow.client_email],
                    reply_to: "venueportalus@gmail.com",
                    subject: `Update on your booking request — ${venueName}`,
                    html
                  })
                });
              } catch (declineEmailErr) {
                console.log("[bookings/decline] email failed (non-fatal):", declineEmailErr.message);
              }
            }

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
            "SELECT id, name, capacity, price_per_day, created_at FROM venues WHERE id = ?"
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

          const row = (label, val) => {
            const v = esc(val);
            return `<tr><td style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#999;padding:12px 0 2px">${esc(label)}</td></tr>
                    <tr><td style="font-size:14px;font-weight:600;color:#111;padding-bottom:12px;border-bottom:1px solid #eee">${v || '<span style="color:#bbb;font-weight:400">—</span>'}</td></tr>`;
          };

          const html = `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#fff;color:#111;padding:32px 28px;border-radius:8px">
            <div style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#888;margin-bottom:20px">Venue.Portal</div>
            <h1 style="font-size:22px;font-weight:800;margin:0 0 6px">New venue onboarding.</h1>
            <p style="color:#555;font-size:14px;margin:0 0 24px;line-height:1.6"><strong>${esc(venueName)}</strong> just submitted an onboarding request. Reply to this email to reach the venue owner directly.</p>
            <div style="background:#f7f7f7;border-radius:8px;padding:20px 22px;margin-bottom:24px">
              <table style="width:100%;border-collapse:collapse">
                ${row('Venue Name',       body.venue_name)}
                ${row('Address',          body.address)}
                ${row('Capacity',         body.capacity)}
                ${row('Price / Night',    body.price_per_day)}
                ${row('Hours',            body.hours)}
                ${row('Description',      body.description)}
                ${row('House Rules',      body.house_rules)}
                ${row('Amenities',        amenities.join(', '))}
                ${row('Photo Links',      body.photo_links)}
                ${row('Video URL',        body.video_url)}
                ${row('Contact Name',     body.contact_name)}
                ${row('Contact Email',    body.contact_email)}
                ${row('Contact Phone',    body.contact_phone)}
                ${row('Additional Notes', body.additional_notes)}
              </table>
            </div>
            <a href="https://venueportal.us/admin.html" style="display:inline-block;background:#111;color:#fff;font-weight:700;font-size:13px;padding:12px 22px;border-radius:6px;text-decoration:none">Open Admin →</a>
            <div style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;font-family:monospace;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#bbb">Venue.Portal · Onboarding</div>
          </div>`;

          if (!env.RESEND_API_KEY) {
            console.log("[onboard] RESEND_API_KEY not configured; submission logged only:", venueName);
            return jsonResponse({ ok: true, message: "Submission received" }, 200, request);
          }

          // Both admin and sales (Mark) get notified on every onboarding submission
          const recipients = ['paxey333@gmail.com', 'mossjr1126@gmail.com'];

          const resendRes = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": "Bearer " + env.RESEND_API_KEY,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              from: "Venue Portal <noreply@venueportal.us>",
              to: recipients,
              reply_to: contactEmail,
              subject: "New venue onboarding — " + venueName,
              html
            })
          });
          if (!resendRes.ok) {
            const errText = await resendRes.text();
            console.log("[onboard] resend error:", resendRes.status, errText);
            return jsonResponse({ error: "Email delivery failed" }, 502, request);
          }

          // Confirmation email to the venue owner who submitted the form.
          // Non-fatal: admin notification already succeeded; submitter still gets {ok:true}.
          try {
            const contactName = String(body.contact_name || "").trim();
            const greeting = contactName ? `Hey ${esc(contactName.split(/\s+/)[0])},` : 'Hey there,';
            const confirmHtml = `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#fff;color:#111;padding:32px 28px;border-radius:8px">
              <div style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#888;margin-bottom:20px">Venue.Portal</div>
              <h1 style="font-size:22px;font-weight:800;margin:0 0 6px">Got it. Thanks for submitting.</h1>
              <p style="color:#555;font-size:14px;margin:0 0 18px;line-height:1.7">${greeting}</p>
              <p style="color:#555;font-size:14px;margin:0 0 18px;line-height:1.7">We received your onboarding details for <strong>${esc(venueName)}</strong>. Our team will review and reach out within 24 hours to set up your dashboard and get you live.</p>
              <p style="color:#555;font-size:14px;margin:0 0 24px;line-height:1.7">In the meantime, feel free to reply to this email with any questions.</p>
              <div style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;font-family:monospace;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#bbb">Venue.Portal · Flat fee. No cuts.</div>
            </div>`;
            await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
              body: JSON.stringify({
                from: "Venue Portal <noreply@venueportal.us>",
                to: [contactEmail],
                reply_to: 'venueportalus@gmail.com',
                subject: "We received your submission — Venue.Portal",
                html: confirmHtml
              })
            });
          } catch (confirmErr) {
            console.log("[onboard] confirmation email failed (non-fatal):", confirmErr.message);
          }

          return jsonResponse({ ok: true, message: "Submission received" }, 200, request);
        } catch (err) {
          console.log("[onboard] error:", err.message);
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── TEST EMAIL (superadmin only) ─────────────────────────────────
      if (path === "/api/test-email" && request.method === "POST") {
        try {
          const session = await getSession(request, env);
          if (!isAdminOrAbove(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          if (!env.RESEND_API_KEY) return jsonResponse({ error: "RESEND_API_KEY not set" }, 500, request);

          const body = await parseJson(request);
          const to = String(body.to || "").trim();
          if (!to) return jsonResponse({ error: "to email required" }, 400, request);

          const mockBooking = {
            client_name: "Test Promoter",
            client_email: to,
            event_date: "2026-07-15",
            venue_name: "The Chill Room",
            total_amount: 45000
          };
          const amount = '$' + (mockBooking.total_amount / 100).toLocaleString('en-US', {minimumFractionDigits:2});
          const dateFormatted = new Date(mockBooking.event_date + 'T00:00:00').toLocaleDateString('en-US', {weekday:'long',month:'long',day:'numeric',year:'numeric'});

          const promoterRes = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "Venue Portal <noreply@venueportal.us>",
              to: [to],
              subject: "[TEST] Booking confirmed — The Chill Room",
              html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#fff;color:#111;padding:32px 28px;border-radius:8px">
          <div style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#888;margin-bottom:20px">Venue.Portal</div>
          <h1 style="font-size:24px;font-weight:800;margin:0 0 6px;letter-spacing:-.3px">You're confirmed.</h1>
          <p style="color:#555;font-size:14px;margin:0 0 28px;line-height:1.6">Hi ${mockBooking.client_name} — your deposit went through and your booking is locked in.</p>
          <div style="background:#f7f7f7;border-radius:8px;padding:20px 22px;margin-bottom:28px">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#999;padding:6px 0 2px">Venue</td></tr>
              <tr><td style="font-size:15px;font-weight:600;padding-bottom:14px;border-bottom:1px solid #eee">${mockBooking.venue_name}</td></tr>
              <tr><td style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#999;padding:14px 0 2px">Event Date</td></tr>
              <tr><td style="font-size:15px;font-weight:600;padding-bottom:14px;border-bottom:1px solid #eee">${dateFormatted}</td></tr>
              <tr><td style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#999;padding:14px 0 2px">Amount Paid</td></tr>
              <tr><td style="font-size:15px;font-weight:700;color:#111">${amount}</td></tr>
            </table>
          </div>
          <p style="color:#888;font-size:12px;line-height:1.6;margin:0">Questions? Reply to this email or contact us at hello@venueportal.us</p>
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;font-family:monospace;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#bbb">Venue.Portal · Flat fee. No cuts.</div>
        </div>`
            })
          });

          const ownerRes = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "Venue Portal <noreply@venueportal.us>",
              to: [to],
              subject: "[TEST] Deposit received — Test Promoter · " + dateFormatted,
              html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#fff;color:#111;padding:32px 28px;border-radius:8px">
          <div style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#888;margin-bottom:20px">Venue.Portal</div>
          <h1 style="font-size:22px;font-weight:800;margin:0 0 6px">Deposit received.</h1>
          <p style="color:#555;font-size:14px;margin:0 0 24px;line-height:1.6">A booking deposit just came in for ${mockBooking.venue_name}.</p>
          <div style="background:#f7f7f7;border-radius:8px;padding:20px 22px;margin-bottom:24px">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#999;padding:6px 0 2px">Promoter</td></tr>
              <tr><td style="font-size:14px;font-weight:600;padding-bottom:12px;border-bottom:1px solid #eee">${mockBooking.client_name} · ${mockBooking.client_email}</td></tr>
              <tr><td style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#999;padding:12px 0 2px">Event Date</td></tr>
              <tr><td style="font-size:14px;font-weight:600;padding-bottom:12px;border-bottom:1px solid #eee">${dateFormatted}</td></tr>
              <tr><td style="font-family:monospace;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#999;padding:12px 0 2px">Deposit Amount</td></tr>
              <tr><td style="font-size:14px;font-weight:700">${amount} <span style="font-weight:400;color:#999;font-size:12px">(your payout is on its way via Stripe)</span></td></tr>
            </table>
          </div>
          <p style="color:#888;font-size:12px;line-height:1.6">Log in to your dashboard to view the full booking details.</p>
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;font-family:monospace;font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#bbb">Venue.Portal · Flat fee. No cuts.</div>
        </div>`
            })
          });

          const p = await promoterRes.json();
          const o = await ownerRes.json();
          return jsonResponse({ ok: true, promoter: p, owner: o }, 200, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── iCAL FEED: PUBLIC (token-authenticated) ──────────────────
      const calFeedMatch = path.match(/^\/api\/calendar\/feed\/([A-Za-z0-9_-]{32,})$/);
      if (calFeedMatch && request.method === "GET") {
        try {
          const feedToken = calFeedMatch[1];
          const row = await env.DB.prepare(
            "SELECT venue_id FROM calendar_tokens WHERE token = ?"
          ).bind(feedToken).first();
          if (!row) return textResponse("Not found", 404, request);

          const venueRow = await env.DB.prepare(
            "SELECT name FROM venues WHERE id = ?"
          ).bind(row.venue_id).first();
          const venueName = venueRow ? venueRow.name : "Venue";

          const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
          const cutoffStr = cutoff.toISOString().slice(0, 10);

          const bookings = await env.DB.prepare(
            `SELECT id, event_date, event_time_start, event_time_end, status,
                    client_name, guests
             FROM bookings
             WHERE venue_id = ? AND status IN ('confirmed','accepted','pending')
               AND event_date >= ?
             ORDER BY event_date ASC`
          ).bind(row.venue_id, cutoffStr).all();

          const blocks = await env.DB.prepare(
            `SELECT id, block_date, time_start, time_end, reason
             FROM venue_blocks WHERE venue_id = ? AND block_date >= ?
             ORDER BY block_date ASC`
          ).bind(row.venue_id, cutoffStr).all();

          const lines = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//VenuePortal//EN",
            "CALSCALE:GREGORIAN",
            "METHOD:PUBLISH",
            "X-WR-CALNAME:" + venueName + " Bookings",
          ];

          for (const b of (bookings.results || [])) {
            const uid = "booking-" + b.id + "@venueportal.us";
            const dtStart = b.event_time_start
              ? b.event_date.replace(/-/g, "") + "T" + b.event_time_start.replace(/:/g, "") + "00"
              : b.event_date.replace(/-/g, "");
            const dtEnd = b.event_time_end
              ? b.event_date.replace(/-/g, "") + "T" + b.event_time_end.replace(/:/g, "") + "00"
              : b.event_date.replace(/-/g, "");
            const isAllDay = !b.event_time_start;
            const statusMap = { confirmed: "CONFIRMED", accepted: "CONFIRMED", pending: "TENTATIVE" };

            lines.push("BEGIN:VEVENT");
            lines.push("UID:" + uid);
            if (isAllDay) {
              lines.push("DTSTART;VALUE=DATE:" + dtStart);
              const nextDay = new Date(b.event_date + "T00:00:00Z");
              nextDay.setUTCDate(nextDay.getUTCDate() + 1);
              lines.push("DTEND;VALUE=DATE:" + nextDay.toISOString().slice(0, 10).replace(/-/g, ""));
            } else {
              lines.push("DTSTART:" + dtStart);
              lines.push("DTEND:" + dtEnd);
            }
            lines.push("SUMMARY:" + (b.status === "pending" ? "[Pending] " : "") + (b.client_name || "Booking"));
            if (b.guests) lines.push("DESCRIPTION:Guests: " + b.guests);
            lines.push("STATUS:" + (statusMap[b.status] || "TENTATIVE"));
            lines.push("END:VEVENT");
          }

          for (const bl of (blocks.results || [])) {
            const uid = "block-" + bl.id + "@venueportal.us";
            const dtStart = bl.time_start
              ? bl.block_date.replace(/-/g, "") + "T" + bl.time_start.replace(/:/g, "") + "00"
              : bl.block_date.replace(/-/g, "");
            const isAllDay = !bl.time_start;

            lines.push("BEGIN:VEVENT");
            lines.push("UID:" + uid);
            if (isAllDay) {
              lines.push("DTSTART;VALUE=DATE:" + dtStart);
              const nextDay = new Date(bl.block_date + "T00:00:00Z");
              nextDay.setUTCDate(nextDay.getUTCDate() + 1);
              lines.push("DTEND;VALUE=DATE:" + nextDay.toISOString().slice(0, 10).replace(/-/g, ""));
            } else {
              lines.push("DTSTART:" + dtStart);
              const dtEnd = bl.time_end
                ? bl.block_date.replace(/-/g, "") + "T" + bl.time_end.replace(/:/g, "") + "00"
                : dtStart;
              lines.push("DTEND:" + dtEnd);
            }
            lines.push("SUMMARY:[Blocked] " + (bl.reason || "Blocked"));
            lines.push("STATUS:CONFIRMED");
            lines.push("END:VEVENT");
          }

          lines.push("END:VCALENDAR");
          const ics = lines.join("\r\n") + "\r\n";

          return new Response(ics, {
            status: 200,
            headers: {
              "Content-Type": "text/calendar; charset=utf-8",
              "Content-Disposition": 'attachment; filename="venue-calendar.ics"',
              "Cache-Control": "no-cache, no-store",
              ...corsHeaders(request)
            }
          });
        } catch (err) {
          return textResponse("Internal server error", 500, request);
        }
      }

      // ── CALENDAR TOKENS: CREATE ──────────────────────────────────
      if (path === "/api/calendar-tokens" && request.method === "POST") {
        try {
          const session = await getSession(request, env);
          if (!isAnyRole(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const body = await parseJson(request);
          const venueId = session.role === "venue_owner" ? session.venue_id : (body.venue_id || null);
          if (!venueId) return jsonResponse({ error: "venue_id required" }, 400, request);
          if (session.role === "venue_owner" && session.venue_id !== venueId) {
            return jsonResponse({ error: "Forbidden" }, 403, request);
          }
          const arr = new Uint8Array(24);
          crypto.getRandomValues(arr);
          const token = toBase64(arr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          const label = String(body.label || "Default").trim().slice(0, 50);
          await env.DB.prepare(
            "INSERT INTO calendar_tokens (venue_id, token, label) VALUES (?, ?, ?)"
          ).bind(venueId, token, label).run();
          return jsonResponse({ token, label, venue_id: venueId }, 201, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── CALENDAR TOKENS: LIST ────────────────────────────────────
      if (path === "/api/calendar-tokens" && request.method === "GET") {
        try {
          const session = await getSession(request, env);
          if (!isAnyRole(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const venueId = session.role === "venue_owner"
            ? session.venue_id
            : (url.searchParams.get("venue_id") || null);
          if (!venueId) return jsonResponse({ error: "venue_id required" }, 400, request);
          const rows = await env.DB.prepare(
            "SELECT id, token, label, created_at FROM calendar_tokens WHERE venue_id = ? ORDER BY created_at DESC"
          ).bind(Number(venueId)).all();
          return jsonResponse({ tokens: rows.results || [] }, 200, request);
        } catch (err) {
          return jsonResponse({ error: err.message }, 500, request);
        }
      }

      // ── CALENDAR TOKENS: DELETE (revoke) ─────────────────────────
      const calTokenDeleteMatch = path.match(/^\/api\/calendar-tokens\/(\d+)$/);
      if (calTokenDeleteMatch && request.method === "DELETE") {
        try {
          const session = await getSession(request, env);
          if (!isAnyRole(session)) return jsonResponse({ error: "Unauthorized" }, 401, request);
          const tokenId = Number(calTokenDeleteMatch[1]);
          const existing = await env.DB.prepare(
            "SELECT venue_id FROM calendar_tokens WHERE id = ?"
          ).bind(tokenId).first();
          if (!existing) return jsonResponse({ error: "Not found" }, 404, request);
          if (session.role === "venue_owner" && session.venue_id !== existing.venue_id) {
            return jsonResponse({ error: "Forbidden" }, 403, request);
          }
          await env.DB.prepare("DELETE FROM calendar_tokens WHERE id = ?").bind(tokenId).run();
          return jsonResponse({ ok: true }, 200, request);
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