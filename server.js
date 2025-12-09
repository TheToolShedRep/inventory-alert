// server.js
const express = require("express");
const path = require("path");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Polyfill fetch for CommonJS + node-fetch v3 (Render / Node 18+ safe)
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// ---- OneSignal config ----
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;

// 🔍 Extra sanity check at startup
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

// ---- Manager key (for /manager access) ----
const MANAGER_KEY = process.env.MANAGER_KEY || "";

// ---- Cooldown config ----
// const COOLDOWN_MS = 5 * 1000; // ⏱ use this for testing (5 seconds)
const COOLDOWN_MS = 60 * 1000; // 60 seconds between pushes for the same (item + location)
const lastAlertByKey = {}; // key: `${item}|${location}` → timestamp

// ---------------- Utility Helpers ----------------

// "whole_milk" → "Whole Milk", "running_low" → "Running Low"
function prettifyText(input = "") {
  return input
    .replace(/_/g, " ")
    .replace(/\w\S*/g, (w) =>
      w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    );
}

// Compare if a timestamp string is the same UTC calendar day as refDate
function isSameUTCDay(timestamp, refDate = new Date()) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return false;

  return (
    d.getUTCFullYear() === refDate.getUTCFullYear() &&
    d.getUTCMonth() === refDate.getUTCMonth() &&
    d.getUTCDate() === refDate.getUTCDate()
  );
}

// Basic CSV escaping: wrap in quotes and double any internal quotes
function csvEscape(value = "") {
  const str = String(value ?? "");
  return `"${str.replace(/"/g, '""')}"`;
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

    // Columns: Time | Item | Qty | Location | IP | User Agent
    const values = [
      [timestamp, item, qty, location || "", ip || "", userAgent || ""],
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A:F", // adjust if your tab name is different
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });

    console.log("✅ Logged alert to Google Sheets:", {
      item,
      qty,
      location,
      ip,
    });
  } catch (err) {
    console.error("❌ Error logging to Google Sheets:", err.message);
  }
}

// Fetch latest alerts from the sheet for the manager view / CSV
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

    // If the first row is your header row, you can skip it:
    // const dataRows = rows.slice(1);
    const dataRows = rows; // assuming no header row yet

    // Take the last `limit` rows (most recent at the bottom)
    const recent = dataRows.slice(-limit);

    // Map to objects
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
      .reverse(); // latest first
  } catch (err) {
    console.error("❌ Error reading alerts from Google Sheets:", err.message);
    return [];
  }
}

// ---------------- Express setup ----------------

app.use(express.static(path.join(__dirname, "public")));

// ---------------- Inventory Alert Endpoint (staff QR) ----------------

app.get("/alert", async (req, res) => {
  let { item = "unknown", qty = "unknown", location = "" } = req.query;

  const itemPretty = prettifyText(item);
  const qtyPretty = prettifyText(qty);
  const locationPretty = location ? prettifyText(location) : "";
  const locationSuffix = locationPretty ? ` (Location: ${locationPretty})` : "";

  // Cooldown key for "same item in same location"
  const key = `${item}|${location || ""}`;
  const now = Date.now();
  const last = lastAlertByKey[key] || 0;
  const isRateLimited = now - last < COOLDOWN_MS;

  try {
    // 1) Send OneSignal push (only if not on cooldown and keys present)
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
        // 👇 When tapping the notification, open the dynamic checklist
        url: "https://inventory-alert-gx9o.onrender.com/checklist",
      };

      console.log(
        "📤 Sending OneSignal notification with body:",
        JSON.stringify(body)
      );

      const response = await fetch(
        "https://onesignal.com/api/v1/notifications",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            Authorization: `Basic ${ONESIGNAL_API_KEY}`,
          },
          body: JSON.stringify(body),
        }
      );

      const text = await response.text();
      console.log("📨 OneSignal raw response:", text);

      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.warn("⚠️ Could not parse OneSignal response as JSON.");
      }

      if (!response.ok) {
        console.error(
          "❌ OneSignal HTTP error:",
          response.status,
          response.statusText
        );
      }
      if (data && data.errors) {
        console.error("❌ OneSignal API errors:", data.errors);
      }

      lastAlertByKey[key] = now;
    }

    // 2) Log to Google Sheets (always log, even during cooldown)
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

    // Friendly confirmation HTML for staff
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
          body {
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: #0f172a;
            color: #e5e7eb;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            padding: 16px;
          }
          .card {
            max-width: 420px;
            width: 100%;
            background: #020617;
            border-radius: 16px;
            padding: 24px 20px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.5);
            text-align: center;
            border: 1px solid #1f2937;
          }
          .icon {
            font-size: 40px;
            margin-bottom: 12px;
          }
          h1 {
            font-size: 20px;
            margin: 0 0 8px;
          }
          p {
            margin: 4px 0;
            font-size: 14px;
            color: #9ca3af;
          }
          .item {
            font-size: 16px;
            color: #f9fafb;
            margin-top: 8px;
          }
          .pill {
            display: inline-block;
            margin-top: 10px;
            padding: 4px 10px;
            border-radius: 999px;
            font-size: 12px;
            background: #1e293b;
            color: #e5e7eb;
          }
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
    res
      .status(500)
      .send("Error sending push notification. Please tell a manager.");
  }
});

// ---------------- Dynamic Checklist View (HTML) ----------------

app.get("/checklist", async (req, res) => {
  try {
    // Get recent alerts from Google Sheets
    let alerts = await getRecentAlertsFromSheet(200);
    const now = new Date();

    // Only look at today's alerts
    alerts = alerts.filter((a) => isSameUTCDay(a.timestamp, now));

    // Keep only "low / running low / out / empty / critical"
    const lowAlerts = alerts.filter((a) =>
      /(low|running|out|empty|critical)/i.test(a.qty || "")
    );

    // Deduplicate by item + location
    const byKey = new Map();
    for (const a of lowAlerts) {
      const key = `${a.item || ""}|${a.location || ""}`;
      if (!byKey.has(key)) {
        byKey.set(key, a);
      }
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

    // Simple HTML checklist
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Restock Checklist</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          body {
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: #020617;
            color: #e5e7eb;
            margin: 0;
            padding: 16px;
          }
          h1 {
            font-size: 22px;
            margin-bottom: 8px;
          }
          p {
            font-size: 14px;
            color: #9ca3af;
            margin-top: 0;
            margin-bottom: 12px;
          }
          ul {
            list-style: none;
            padding: 0;
          }
          li {
            background: #0b1120;
            margin-bottom: 8px;
            padding: 10px 12px;
            border-radius: 8px;
            border: 1px solid #1f2937;
            font-size: 14px;
          }
          .top-link {
            display: inline-block;
            margin-top: 12px;
            font-size: 13px;
            color: #60a5fa;
            text-decoration: none;
          }
          .top-link:hover {
            text-decoration: underline;
          }
        </style>
      </head>
      <body>
        <h1>Restock Checklist</h1>
        <p>These are the items that were logged as low or out today.</p>
        <ul>
          ${listItemsHtml}
        </ul>
        <a href="/manager" class="top-link">Open Inventory Alert Manager View →</a>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("❌ Error in /checklist route:", err);
    res.status(500).send("Error loading checklist.");
  }
});

// ---------------- Manager View Endpoint (HTML) ----------------

app.get("/manager", async (req, res) => {
  try {
    const providedKey = (req.query.key || "").toString();

    // 🔐 If MANAGER_KEY is set, require it in the query
    if (MANAGER_KEY) {
      if (providedKey !== MANAGER_KEY) {
        console.warn("⚠️ Invalid or missing manager key on /manager");
        return res.status(401).send(`
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="utf-8" />
            <title>Access Denied</title>
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <style>
              body {
                font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                background: #020617;
                color: #e5e7eb;
                display: flex;
                align-items: center;
                justify-content: center;
                min-height: 100vh;
                margin: 0;
                padding: 16px;
              }
              .card {
                max-width: 420px;
                width: 100%;
                background: #0b1120;
                border-radius: 16px;
                padding: 24px 20px;
                text-align: center;
                border: 1px solid #1f2937;
              }
              h1 {
                font-size: 20px;
                margin-bottom: 8px;
              }
              p {
                font-size: 14px;
                color: #9ca3af;
              }
            </style>
          </head>
          <body>
            <div class="card">
              <h1>Access Denied</h1>
              <p>This page is for managers only.</p>
            </div>
          </body>
          </html>
        `);
      }
    } else {
      console.warn("⚠️ MANAGER_KEY is not set; /manager is open to anyone.");
    }

    const rangeParam = (req.query.range || "today").toLowerCase(); // "today" | "all"
    let alerts = await getRecentAlertsFromSheet(50);
    const now = new Date();

    let subtitle;
    let toggleLink;

    // Build URLs that preserve the key if present
    const todayUrl = MANAGER_KEY
      ? `/manager?key=${encodeURIComponent(providedKey)}&range=today`
      : `/manager?range=today`;

    const allUrl = MANAGER_KEY
      ? `/manager?key=${encodeURIComponent(providedKey)}&range=all`
      : `/manager?range=all`;

    if (rangeParam === "all") {
      subtitle = "Showing all recent alerts.";
      toggleLink = `<a href="${todayUrl}">View today only</a>`;
    } else {
      // default: today
      alerts = alerts.filter((a) => isSameUTCDay(a.timestamp, now));
      subtitle = "Showing alerts from today.";
      toggleLink = `<a href="${allUrl}">View all</a>`;
    }

    // CSV download link (preserve key + range)
    const csvUrl = MANAGER_KEY
      ? `/manager.csv?key=${encodeURIComponent(
          providedKey
        )}&range=${encodeURIComponent(rangeParam)}`
      : `/manager.csv?range=${encodeURIComponent(rangeParam)}`;

    const rowsHtml = alerts
      .map((a) => {
        const ts = a.timestamp || "";
        const item = a.item || "";
        const qty = a.qty || "";
        const loc = a.location || "";
        const ip = a.ip || "";
        const ua = a.userAgent || "";

        // 🔴🟠🟢 Decide status color based on qty text
        const normalized = (qty || "").toLowerCase();
        let statusClass = "status-badge status-ok";

        if (/(out|empty|critical)/.test(normalized)) {
          statusClass = "status-badge status-danger";
        } else if (/(low|running)/.test(normalized)) {
          statusClass = "status-badge status-warn";
        }

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
          body {
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: #020617;
            color: #e5e7eb;
            margin: 0;
            padding: 16px;
          }
          h1 {
            font-size: 22px;
            margin-bottom: 8px;
          }
          p {
            font-size: 14px;
            color: #9ca3af;
            margin-top: 0;
            margin-bottom: 8px;
          }
          .top-bar {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 8px;
          }
          .legend {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 6px;
            font-size: 11px;
            color: #9ca3af;
            margin-bottom: 10px;
          }
          .legend-label {
            font-weight: 500;
            margin-right: 2px;
          }
          .btn-csv {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 6px 10px;
            border-radius: 999px;
            font-size: 11px;
            font-weight: 500;
            border: 1px solid #1f2937;
            background: #0b1120;
            color: #e5e7eb;
            text-decoration: none;
          }
          .btn-csv:hover {
            background: #111827;
          }
          .table-wrapper {
            overflow-x: auto;
            margin-top: 8px;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            background: #020617;
            border-radius: 12px;
            overflow: hidden;
          }
          thead {
            background: #111827;
          }
          th, td {
            padding: 8px 10px;
            font-size: 12px;
            border-bottom: 1px solid #1f2937;
            text-align: left;
            white-space: nowrap;
          }
          th {
            font-weight: 600;
            color: #e5e7eb;
            cursor: pointer; /* clickable for sorting */
          }
          tr:nth-child(even) td {
            background: #030712;
          }
          a {
            color: #60a5fa;
            text-decoration: none;
          }
          a:hover {
            text-decoration: underline;
          }

          /* 🔴🟠🟢 Status badges */
          .status-badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 999px;
            font-size: 11px;
            font-weight: 500;
          }
          .status-ok {
            background: #064e3b;
            color: #bbf7d0;
          }
          .status-warn {
            background: #7c2d12;
            color: #fed7aa;
          }
          .status-danger {
            background: #7f1d1d;
            color: #fecaca;
          }
        </style>
      </head>
      <body>
        <h1>Inventory Alerts – Manager View</h1>
        <div class="top-bar">
          <p>${subtitle} &nbsp; ${toggleLink}</p>
          <a href="${csvUrl}" class="btn-csv">Download CSV</a>
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
              ${
                rowsHtml ||
                '<tr><td colspan="6">No alerts for the selected range.</td></tr>'
              }
            </tbody>
          </table>
        </div>
        <script>
          // Simple client-side column sorting for the manager table
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

                var rowsArray = Array.prototype.slice.call(
                  tbody.querySelectorAll("tr")
                );

                rowsArray.sort(function (a, b) {
                  var aText = (a.children[index].innerText || "").toLowerCase();
                  var bText = (b.children[index].innerText || "").toLowerCase();

                  if (aText < bText) return next === "asc" ? -1 : 1;
                  if (aText > bText) return next === "asc" ? 1 : -1;
                  return 0;
                });

                rowsArray.forEach(function (row) {
                  tbody.appendChild(row);
                });
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

// ---------------- Manager CSV Endpoint ----------------

app.get("/manager.csv", async (req, res) => {
  try {
    const providedKey = (req.query.key || "").toString();

    // 🔐 Same key protection as /manager
    if (MANAGER_KEY) {
      if (providedKey !== MANAGER_KEY) {
        console.warn("⚠️ Invalid or missing manager key on /manager.csv");
        return res.status(401).send("Access denied");
      }
    } else {
      console.warn("⚠️ MANAGER_KEY is not set; /manager.csv is open to anyone.");
    }

    const rangeParam = (req.query.range || "today").toLowerCase();
    let alerts = await getRecentAlertsFromSheet(500); // allow more for export
    const now = new Date();

    if (rangeParam !== "all") {
      alerts = alerts.filter((a) => isSameUTCDay(a.timestamp, now));
    }

    // Build CSV header
    let csv = [
      ["Time", "Item", "Status", "Location", "IP", "User Agent"]
        .map(csvEscape)
        .join(","),
    ];

    // Add rows
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

    // Set headers for download
    const filename =
      rangeParam === "all"
        ? "inventory-alerts-all.csv"
        : "inventory-alerts-today.csv";

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );
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
