// server.js
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ---- OneSignal creds from .env ----
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;

// ---- Serve static files (index.html, OneSignal workers, etc.) ----
app.use(express.static(path.join(__dirname, "public")));

// Simple health check
app.get("/", (req, res) => {
  res.send("Inventory alert server (OneSignal) is running ✅");
});

// Main alert endpoint: /alert?item=cheese&qty=low
app.get("/alert", async (req, res) => {
  const item = req.query.item || "Unknown item";
  const qty = req.query.qty || "unspecified amount";

  const messageBody = `Inventory alert: ${item} is running low (qty: ${qty}). Please restock.`;

  try {
    const response = await axios.post(
      "https://api.onesignal.com/notifications",
      {
        app_id: ONESIGNAL_APP_ID,
        included_segments: ["All"], // all subscribed devices
        headings: { en: "Inventory Alert" },
        contents: { en: messageBody },
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${ONESIGNAL_API_KEY}`,
        },
      }
    );

    console.log("✅ OneSignal response:", response.data.id || response.data);
    res.send("📨 Push notification sent!");
  } catch (err) {
    console.error("❌ Error sending push:", err.response?.data || err.message);
    res.status(500).send("Error sending alert");
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
