// server.js
const express = require("express");
const path = require("path");
const fetch = require("node-fetch");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 3000;

// ---- OneSignal config ----
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;

// ---- Google Sheets config ----
const SHEET_ID = process.env.SHEET_ID;

// Create Google Sheets client using service account JSON from env
let sheetsClient;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const authClient = await auth.getClient();
  sheetsClient = google.sheets({ version: "v4", auth: authClient });
  return sheetsClient;
}

// Append a row to the sheet
async function logAlertToSheet({ item, qty, ip, userAgent }) {
  try {
    const sheets = await getSheetsClient();
    const timestamp = new Date().toISOString();

    const values = [[timestamp, item, qty, ip || "", userAgent || ""]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A:E", // adjust if your sheet/tab name is different
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values,
      },
    });
  } catch (err) {
    console.error("Error logging to Google Sheets:", err.message);
  }
}
