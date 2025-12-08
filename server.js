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

// ---- Google Sheets config ----
const SHEET_ID = process.env.SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// ---- Cooldown config ----
// 60 seconds between pushes for the same (item + location)
const COOLDOWN_MS = 60 * 1000;
const lastAlertByKey = {}; // key: `${item}|${location}` → timestamp

// ---------------- Utility Helpers ----------------

// "whole_milk" → "Whole Milk", "running_low" → "Running Low"
function prettifyText(input = "") {
  return input
    .replace(/_/g, " ")
    .replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
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
    const values = [[
      timestamp,
      item,
      qty,
      location || "",
      ip || "",
      userAgent || "",
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A:F", // adjust if your tab name is different
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });

    console.log("✅ Logged alert to Google Sheets:", { item, qty, location, ip });
  } catch (err) {
    console.error("❌ Error logging to Google Sheets:", err.message);
  }
}

// ---------------- Express setup ----------------

app.use(express.static(path.join(__dirname, "public")));

// ---------------- Inventory Alert Endpoint ----------------

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
    // 1) Send OneSignal push (only if not on cooldown)
    if (isRateLimited) {
      console.log(`⏱ Cooldown active, not sending push for ${key}`);
    } else {
      const response = await fetch("https://onesignal.com/api/v1/notifications", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Basic ${ONESIGNAL_API_KEY}`,
        },
        body: JSON.stringify({
          app_id: ONESIGNAL_APP_ID,
          included_segments: ["All"],
          headings: { en: "Inventory Alert" },
          contents: {
            en: `Inventory Alert${locationSuffix}: ${itemPretty} is ${qtyPretty}. Please restock.`,
          },
          url: "https://inventory-alert-gx9o.onrender.com/",
        }),
      });

      const data = await response.json();
      console.log("📨 OneSignal response:", data);
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

    // Simple HTML confirmation page for staff
    const statusTitle = isRateLimited
      ? "Alert Logged (Already Sent Recently)"
      : "Alert Sent to Managers!";
    const statusDetail = isRateLimited
      ? "We’ve logged this again, but skipped another notification to avoid spam."
      : "Managers have been notified. Thank you!";
    const locationLine = locationPretty ? `<p><strong>Location:</strong> ${locationPretty}</p>` : "";

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


// ---------------- Start Server ----------------

app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
