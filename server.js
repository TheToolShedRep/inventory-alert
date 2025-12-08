// server.js
const express = require("express");
const path = require("path");
// const fetch = require("node-fetch");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Polyfill fetch for CommonJS + node-fetch v3
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// ---- OneSignal config ----
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;

// ---- Google Sheets config ----
const SHEET_ID = process.env.SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

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

async function logAlertToSheet({ item, qty, ip, userAgent }) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return; // logging disabled or failed

    const timestamp = new Date().toISOString();
    const values = [[timestamp, item, qty, ip || "", userAgent || ""]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A:E", // use your tab name if not "Sheet1"
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });

    console.log("✅ Logged alert to Google Sheets:", { item, qty, ip });
  } catch (err) {
    console.error("❌ Error logging to Google Sheets:", err.message);
  }
}

// ---------------- Express setup ----------------

app.use(express.static(path.join(__dirname, "public")));

// Inventory alert endpoint
app.get("/alert", async (req, res) => {
  const { item = "unknown", qty = "unknown" } = req.query;

  try {
    // 1) Send OneSignal push
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
          en: `Inventory alert: ${item} is running low (qty: ${qty}). Please restock.`,
        },
        url: "https://inventory-alert-gx9o.onrender.com/",
      }),
    });

    const data = await response.json();
    console.log("📨 OneSignal response:", data);

    // 2) Log to Google Sheets (fire-and-forget)
    const ip =
      (req.headers["x-forwarded-for"] || "")
        .split(",")[0]
        .trim() || req.ip || "";
    const userAgent = req.headers["user-agent"] || "";

    await logAlertToSheet({ item, qty, ip, userAgent });

    res.send("Push notification sent!");
  } catch (err) {
    console.error("❌ Error in /alert route:", err);
    res.status(500).send("Error sending push notification.");
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
