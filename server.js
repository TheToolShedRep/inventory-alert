// server.js
require("dotenv").config();


const express = require("express");
const path = require("path");
const { google } = require("googleapis");

const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Polyfill fetch for CommonJS + node-fetch v3 (Render / Node 18+ safe)
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// ---- OneSignal config ----
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;

if (!ONESIGNAL_APP_ID || !ONESIGNAL_API_KEY) {
  console.warn(
    "⚠️ OneSignal config missing: check ONESIGNAL_APP_ID and ONESIGNAL_API_KEY env vars."
  );
} else {
  console.log("✅ OneSignal config present.");
}

// ---- Google Sheets config ----
const SHEET_ID = process.env.SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// ---- Login config (V2-lite) ----
const LOGIN_USER = process.env.LOGIN_USER || "manager";
const LOGIN_PASS_HASH = process.env.LOGIN_PASS_HASH || ""; // bcrypt hash
const JWT_SECRET = process.env.JWT_SECRET || "";

if (!LOGIN_PASS_HASH || !JWT_SECRET) {
  console.warn(
    "⚠️ Login env vars missing. Set LOGIN_PASS_HASH and JWT_SECRET in Render."
  );
}

// ---- Cooldown config ----
const COOLDOWN_MS = 60 * 1000; // 60 seconds
const lastAlertByKey = {}; // key: `${item}|${location}` → timestamp

// ---------------- Express setup ----------------
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true })); // for form POSTs
app.use(cookieParser());

// ---------------- Utility Helpers ----------------
function prettifyText(input = "") {
  return input
    .replace(/_/g, " ")
    .replace(/\w\S*/g, (w) =>
      w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    );
}

function isSameUTCDay(timestamp, refDate = new Date()) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getUTCFullYear() === refDate.getUTCFullYear() &&
    d.getUTCMonth() === refDate.getUTCMonth() &&
    d.getUTCDate() === refDate.getUTCDate()
  );
}

function csvEscape(value = "") {
  const str = String(value ?? "");
  return `"${str.replace(/"/g, '""')}"`;
}

// ---------------- Simple Auth (JWT Cookie) ----------------
// Cookie name for auth token
const AUTH_COOKIE = "inv_auth";

function signAuthToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

function verifyAuthToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Middleware to protect manager routes
function requireAuth(req, res, next) {
  // If login isn’t configured yet, block access (safer)
  if (!JWT_SECRET || !LOGIN_PASS_HASH) {
    return res
      .status(500)
      .send("Login is not configured. Set LOGIN_PASS_HASH and JWT_SECRET.");
  }

  const token = req.cookies[AUTH_COOKIE];
  const decoded = token ? verifyAuthToken(token) : null;

  if (!decoded) {
    // Redirect to login with return url
    const returnTo = encodeURIComponent(req.originalUrl || "/manager");
    return res.redirect(`/login?returnTo=${returnTo}`);
  }

  req.user = decoded;
  next();
}

// ---------------- Google Sheets helper ----------------
let sheetsClient = null;

async function getSheetsClient() {
  try {
    if (!GOOGLE_SERVICE_ACCOUNT_JSON || !SHEET_ID) {
      console.log("ℹ️ Google Sheets env vars missing; skipping logging.");
      return null;
    }
    if (sheetsClient) return sheetsClient;

    const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const authClient = await auth.getClient();
    sheetsClient = google.sheets({ version: "v4", auth: authClient });
    console.log("✅ Google Sheets client initialized");
    return sheetsClient;
  } catch (err) {
    console.error("❌ Error creating Google Sheets client:", err.message);
    return null;
  }
}

async function logAlertToSheet({ item, qty, location, ip, userAgent }) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;

    const timestamp = new Date().toISOString();
    const values = [
      [timestamp, item, qty, location || "", ip || "", userAgent || ""],
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A:F",
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });

    console.log("✅ Logged alert to Google Sheets:", { item, qty, location, ip });
  } catch (err) {
    console.error("❌ Error logging to Google Sheets:", err.message);
  }
}

async function getRecentAlertsFromSheet(limit = 50) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return [];

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A:F",
    });

    const rows = res.data.values || [];
    if (rows.length === 0) return [];

    const dataRows = rows; // assuming no header row
    const recent = dataRows.slice(-limit);

    return recent
      .map((r) => {
        const [
          timestamp = "",
          item = "",
          qty = "",
          location = "",
          ip = "",
          userAgent = "",
        ] = r;

        return { timestamp, item, qty, location, ip, userAgent };
      })
      .reverse();
  } catch (err) {
    console.error("❌ Error reading alerts from Google Sheets:", err.message);
    return [];
  }
}

// ---------------- Login Routes ----------------

// GET /login (simple HTML form)
app.get("/login", (req, res) => {
  const returnTo = (req.query.returnTo || "/manager").toString();

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>Manager Login</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body{
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          background:#020617; color:#e5e7eb;
          display:flex; align-items:center; justify-content:center;
          min-height:100vh; margin:0; padding:16px;
        }
        .card{
          width:100%; max-width:420px;
          background:#0b1120; border:1px solid #1f2937;
          border-radius:16px; padding:22px;
        }
        h1{ margin:0 0 8px; font-size:20px; }
        p{ margin:0 0 16px; color:#9ca3af; font-size:13px; }
        label{ display:block; font-size:12px; color:#9ca3af; margin:10px 0 6px; }
        input{
          width:100%; padding:10px 12px; border-radius:10px;
          border:1px solid #1f2937; background:#020617; color:#e5e7eb;
          font-size:14px;
        }
        button{
          width:100%; margin-top:14px; padding:10px 12px;
          border-radius:10px; border:1px solid #1f2937;
          background:#111827; color:#e5e7eb; font-weight:600;
          cursor:pointer;
        }
        button:hover{ background:#0f172a; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Manager Login</h1>
        <p>Sign in to view the checklist and inventory dashboard.</p>
        <form method="POST" action="/login">
          <input type="hidden" name="returnTo" value="${returnTo.replace(/"/g, "&quot;")}" />
          <label>Username</label>
          <input name="username" autocomplete="username" required />
          <label>Password</label>
          <input name="password" type="password" autocomplete="current-password" required />
          <button type="submit">Sign In</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

// POST /login (verify + set cookie)
app.post("/login", async (req, res) => {
  try {
    const { username = "", password = "", returnTo = "/manager" } = req.body;

    // Basic checks
    if (!LOGIN_PASS_HASH || !JWT_SECRET) {
      return res
        .status(500)
        .send("Login not configured. Set LOGIN_PASS_HASH and JWT_SECRET.");
    }

    if (username !== LOGIN_USER) {
      return res.status(401).send("Invalid login.");
    }

    const ok = await bcrypt.compare(password, LOGIN_PASS_HASH);
    if (!ok) {
      return res.status(401).send("Invalid login.");
    }

    const token = signAuthToken({ username });

    // httpOnly cookie so JS can’t steal it
    res.cookie(AUTH_COOKIE, token, {
      httpOnly: true,
      secure: true, // Render is HTTPS
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.redirect(returnTo);
  } catch (err) {
    console.error("❌ Login error:", err);
    res.status(500).send("Login error.");
  }
});

// GET /logout (clear cookie)
app.get("/logout", (req, res) => {
  res.clearCookie(AUTH_COOKIE, { httpOnly: true, secure: true, sameSite: "lax" });
  res.redirect("/login");
});

// ---------------- Inventory Alert Endpoint (staff QR) ----------------

app.get("/alert", async (req, res) => {
  let { item = "unknown", qty = "unknown", location = "" } = req.query;

  const itemPretty = prettifyText(item);
  const qtyPretty = prettifyText(qty);
  const locationPretty = location ? prettifyText(location) : "";
  const locationSuffix = locationPretty ? ` (Location: ${locationPretty})` : "";

  const key = `${item}|${location || ""}`;
  const now = Date.now();
  const last = lastAlertByKey[key] || 0;
  const isRateLimited = now - last < COOLDOWN_MS;

  try {
    // 1) Send push (tap opens checklist)
    if (!ONESIGNAL_APP_ID || !ONESIGNAL_API_KEY) {
      console.warn("🔕 Skipping push: OneSignal env vars missing.");
    } else if (isRateLimited) {
      console.log(`⏱ Cooldown active, not sending push for ${key}`);
    } else {
      const body = {
        app_id: ONESIGNAL_APP_ID,
        included_segments: ["All"],
        headings: { en: "Inventory Alert" },
        contents: {
          en: `Inventory Alert${locationSuffix}: ${itemPretty} is ${qtyPretty}. Please restock.`,
        },
        url: "https://inventory-alert-gx9o.onrender.com/checklist",
      };

      const response = await fetch("https://onesignal.com/api/v1/notifications", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Basic ${ONESIGNAL_API_KEY}`,
        },
        body: JSON.stringify(body),
      });

      const text = await response.text();
      console.log("📨 OneSignal raw response:", text);

      lastAlertByKey[key] = now;
    }

    // 2) Log to Sheets
    const ip =
      (req.headers["x-forwarded-for"] || "")
        .split(",")[0]
        .trim() || req.ip || "";
    const userAgent = req.headers["user-agent"] || "";

    await logAlertToSheet({
      item: itemPretty,
      qty: qtyPretty,
      location: locationPretty,
      ip,
      userAgent,
    });

    // Confirmation
    const statusTitle = isRateLimited
      ? "Alert Logged (Already Sent Recently)"
      : "Alert Sent to Managers!";
    const statusDetail = isRateLimited
      ? "We’ve logged this again, but skipped another notification to avoid spam."
      : "Managers have been notified. Thank you!";
    const locationLine = locationPretty
      ? `<p><strong>Location:</strong> ${locationPretty}</p>`
      : "";

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Inventory Alert</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background:#0f172a; color:#e5e7eb; display:flex; align-items:center; justify-content:center;
            min-height:100vh; margin:0; padding:16px; }
          .card{ max-width:420px; width:100%; background:#020617; border-radius:16px; padding:24px 20px;
            box-shadow:0 20px 40px rgba(0,0,0,0.5); text-align:center; border:1px solid #1f2937; }
          .icon{ font-size:40px; margin-bottom:12px; }
          h1{ font-size:20px; margin:0 0 8px; }
          p{ margin:4px 0; font-size:14px; color:#9ca3af; }
          .item{ font-size:16px; color:#f9fafb; margin-top:8px; }
          .pill{ display:inline-block; margin-top:10px; padding:4px 10px; border-radius:999px;
            font-size:12px; background:#1e293b; color:#e5e7eb; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">✅</div>
          <h1>${statusTitle}</h1>
          <p>${statusDetail}</p>
          <p class="item"><strong>Item:</strong> ${itemPretty}</p>
          ${locationLine}
          <p class="pill">Status: ${qtyPretty}</p>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("❌ Error in /alert route:", err);
    res.status(500).send("Error sending push notification. Please tell a manager.");
  }
});

// ---------------- Dynamic Checklist View (Protected) ----------------
app.get("/checklist", requireAuth, async (req, res) => {
  try {
    let alerts = await getRecentAlertsFromSheet(200);
    const now = new Date();

    alerts = alerts.filter((a) => isSameUTCDay(a.timestamp, now));
    const lowAlerts = alerts.filter((a) =>
      /(low|running|out|empty|critical)/i.test(a.qty || "")
    );

    const byKey = new Map();
    for (const a of lowAlerts) {
      const key = `${a.item || ""}|${a.location || ""}`;
      if (!byKey.has(key)) byKey.set(key, a);
    }

    const items = Array.from(byKey.values());
    const listItemsHtml =
      items.length === 0
        ? `<li>No low-inventory items logged today yet.</li>`
        : items
            .map((a) => {
              const item = a.item || "Unknown Item";
              const loc = a.location || "";
              const locationSuffix = loc ? ` – ${loc}` : "";
              return `<li>☐ ${item}${locationSuffix}</li>`;
            })
            .join("");

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Restock Checklist</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          body{ font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background:#020617; color:#e5e7eb; margin:0; padding:16px; }
          h1{ font-size:22px; margin-bottom:8px; }
          p{ font-size:14px; color:#9ca3af; margin-top:0; margin-bottom:12px; }
          ul{ list-style:none; padding:0; }
          li{ background:#0b1120; margin-bottom:8px; padding:10px 12px; border-radius:8px;
            border:1px solid #1f2937; font-size:14px; }
          .row{ display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
          .btn{
            display:inline-flex; align-items:center; justify-content:center;
            padding:8px 10px; border-radius:999px; font-size:12px; font-weight:600;
            border:1px solid #1f2937; background:#0b1120; color:#e5e7eb; text-decoration:none;
          }
          .btn:hover{ background:#111827; }
        </style>
      </head>
      <body>
        <h1>Restock Checklist</h1>
        <p>These are the items that were logged as low or out today.</p>
        <ul>${listItemsHtml}</ul>

        <div class="row">
          <a href="/manager" class="btn">Open Inventory Manager View →</a>
          <a href="/logout" class="btn">Logout</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("❌ Error in /checklist route:", err);
    res.status(500).send("Error loading checklist.");
  }
});

// ---------------- Manager View Endpoint (Protected) ----------------
app.get("/manager", requireAuth, async (req, res) => {
  try {
    const rangeParam = (req.query.range || "today").toLowerCase(); // "today" | "all"
    let alerts = await getRecentAlertsFromSheet(50);
    const now = new Date();

    let subtitle;
    let toggleLink;

    const todayUrl = `/manager?range=today`;
    const allUrl = `/manager?range=all`;

    if (rangeParam === "all") {
      subtitle = "Showing all recent alerts.";
      toggleLink = `<a href="${todayUrl}">View today only</a>`;
    } else {
      alerts = alerts.filter((a) => isSameUTCDay(a.timestamp, now));
      subtitle = "Showing alerts from today.";
      toggleLink = `<a href="${allUrl}">View all</a>`;
    }

    const csvUrl = `/manager.csv?range=${encodeURIComponent(rangeParam)}`;

    const rowsHtml = alerts
      .map((a) => {
        const ts = a.timestamp || "";
        const item = a.item || "";
        const qty = a.qty || "";
        const loc = a.location || "";
        const ip = a.ip || "";
        const ua = a.userAgent || "";

        const normalized = (qty || "").toLowerCase();
        let statusClass = "status-badge status-ok";
        if (/(out|empty|critical)/.test(normalized)) statusClass = "status-badge status-danger";
        else if (/(low|running)/.test(normalized)) statusClass = "status-badge status-warn";

        return `
          <tr>
            <td>${ts}</td>
            <td>${item}</td>
            <td><span class="${statusClass}">${qty}</span></td>
            <td>${loc}</td>
            <td>${ip}</td>
            <td>${ua}</td>
          </tr>
        `;
      })
      .join("");

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Inventory Alerts – Manager View</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          body{ font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background:#020617; color:#e5e7eb; margin:0; padding:16px; }
          h1{ font-size:22px; margin-bottom:8px; }
          p{ font-size:14px; color:#9ca3af; margin-top:0; margin-bottom:8px; }
          .top-bar{ display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
          .legend{ display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-size:11px; color:#9ca3af; margin-bottom:10px; }
          .legend-label{ font-weight:500; margin-right:2px; }
          .btn{ display:inline-flex; align-items:center; justify-content:center; padding:6px 10px; border-radius:999px;
            font-size:11px; font-weight:600; border:1px solid #1f2937; background:#0b1120; color:#e5e7eb; text-decoration:none; }
          .btn:hover{ background:#111827; }
          .table-wrapper{ overflow-x:auto; margin-top:8px; }
          table{ width:100%; border-collapse:collapse; background:#020617; border-radius:12px; overflow:hidden; }
          thead{ background:#111827; }
          th,td{ padding:8px 10px; font-size:12px; border-bottom:1px solid #1f2937; text-align:left; white-space:nowrap; }
          th{ font-weight:600; color:#e5e7eb; cursor:pointer; }
          tr:nth-child(even) td{ background:#030712; }
          a{ color:#60a5fa; text-decoration:none; }
          a:hover{ text-decoration:underline; }
          .status-badge{ display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; }
          .status-ok{ background:#064e3b; color:#bbf7d0; }
          .status-warn{ background:#7c2d12; color:#fed7aa; }
          .status-danger{ background:#7f1d1d; color:#fecaca; }
        </style>
      </head>
      <body>
        <h1>Inventory Alerts – Manager View</h1>
        <div class="top-bar">
          <p>${subtitle} &nbsp; ${toggleLink}</p>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <a href="/checklist" class="btn">View Restock Checklist</a>
            <a href="${csvUrl}" class="btn">Download CSV</a>
            <a href="/logout" class="btn">Logout</a>
          </div>
        </div>

        <div class="legend">
          <span class="legend-label">Legend:</span>
          <span class="status-badge status-danger">Out / Empty / Critical</span>
          <span class="status-badge status-warn">Low / Running Low</span>
          <span class="status-badge status-ok">OK / Test / Other</span>
        </div>

        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Item</th>
                <th>Status</th>
                <th>Location</th>
                <th>IP</th>
                <th>User Agent</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml || '<tr><td colspan="6">No alerts for the selected range.</td></tr>'}
            </tbody>
          </table>
        </div>

        <script>
          document.addEventListener("DOMContentLoaded", function () {
            var table = document.querySelector("table");
            if (!table) return;

            var tbody = table.querySelector("tbody");
            var headers = table.querySelectorAll("th");
            var sortState = {};

            headers.forEach(function (th, index) {
              th.addEventListener("click", function () {
                var key = index;
                var current = sortState[key] || "desc";
                var next = current === "asc" ? "desc" : "asc";
                sortState = {};
                sortState[key] = next;

                var rowsArray = Array.prototype.slice.call(tbody.querySelectorAll("tr"));
                rowsArray.sort(function (a, b) {
                  var aText = (a.children[index].innerText || "").toLowerCase();
                  var bText = (b.children[index].innerText || "").toLowerCase();
                  if (aText < bText) return next === "asc" ? -1 : 1;
                  if (aText > bText) return next === "asc" ? 1 : -1;
                  return 0;
                });

                rowsArray.forEach(function (row) { tbody.appendChild(row); });
              });
            });
          });
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("❌ Error in /manager route:", err);
    res.status(500).send("Error loading manager view.");
  }
});

// ---------------- Manager CSV Endpoint (Protected) ----------------
app.get("/manager.csv", requireAuth, async (req, res) => {
  try {
    const rangeParam = (req.query.range || "today").toLowerCase();
    let alerts = await getRecentAlertsFromSheet(500);
    const now = new Date();

    if (rangeParam !== "all") {
      alerts = alerts.filter((a) => isSameUTCDay(a.timestamp, now));
    }

    let csv = [
      ["Time", "Item", "Status", "Location", "IP", "User Agent"]
        .map(csvEscape)
        .join(","),
    ];

    alerts.forEach((a) => {
      csv.push(
        [
          csvEscape(a.timestamp || ""),
          csvEscape(a.item || ""),
          csvEscape(a.qty || ""),
          csvEscape(a.location || ""),
          csvEscape(a.ip || ""),
          csvEscape(a.userAgent || ""),
        ].join(",")
      );
    });

    const csvString = csv.join("\r\n");
    const filename =
      rangeParam === "all" ? "inventory-alerts-all.csv" : "inventory-alerts-today.csv";

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csvString);
  } catch (err) {
    console.error("❌ Error in /manager.csv route:", err);
    res.status(500).send("Error generating CSV.");
  }
});

// ---------------- Start Server ----------------
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
