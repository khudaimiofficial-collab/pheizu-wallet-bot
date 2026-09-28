const admin = require("firebase-admin");

// Initialize Firebase Admin (safe across Vercel serverless invocations)
if (!admin.apps.length) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
      });
    } else if (process.env.FIREBASE_PROJECT_ID) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n")
        })
      });
    } else {
      admin.initializeApp();
    }
  } catch (e) {
    console.warn("Firebase initialization skipped or failed:", e.message);
  }
}

const db = admin.apps.length ? admin.firestore() : null;

// In-memory fallback cache for payment tracking & deduplication
const memoryPayments = new Map();

// Helper: Dispatch message directly to user's Telegram chat
async function sendTelegramMessage(telegramId, messageHtml) {
  const botToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !telegramId) {
    console.warn("Missing BOT_TOKEN or telegram_id for notification dispatch.");
    return false;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramId,
        text: messageHtml,
        parse_mode: "HTML"
      })
    });
    const result = await res.json();
    return result.ok;
  } catch (err) {
    console.error("Telegram notification send error:", err);
    return false;
  }
}

// Helper: Speed API Request Wrapper
async function speedRequest(path, method = "GET", body = null) {
  const apiKey = process.env.SPEED_API_KEY || process.env.SPEED_SECRET_KEY;
  if (!apiKey) throw new Error("SPEED_API_KEY is not configured.");

  const headers = {
    "Authorization": `Basic ${Buffer.from(apiKey + ":").toString("base64")}`,
    "Content-Type": "application/json"
  };

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`https://api.tryspeed.com${path}`, options);
  const data = await res.json();
  return { status: res.status, data };
}

// Balance Helpers (Firestore or Memory fallback)
async function getUserBalance(userId) {
  if (db) {
    const doc = await db.collection("wallets").doc(userId).get();
    if (doc.exists) {
      return Number(doc.data().balance || 0);
    }
    return 0;
  }
  return memoryPayments.get(`bal_${userId}`) || 0;
}

async function adjustUserBalance(userId, delta) {
  if (db) {
    const ref = db.collection("wallets").doc(userId);
    await db.runTransaction(async (t) => {
      const doc = await t.get(ref);
      const current = doc.exists ? Number(doc.data().balance || 0) : 0;
      t.set(ref, { balance: Math.max(0, current + delta), updatedAt: new Date() }, { merge: true });
    });
    return (await getUserBalance(userId));
  }
  const current = memoryPayments.get(`bal_${userId}`) || 0;
  const next = Math.max(0, current + delta);
  memoryPayments.set(`bal_${userId}`, next);
  return next;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const action = req.query.action || (req.body && req.body.action);

  try {
    // ----------------------------------------------------
    // ACTION: BALANCE
    // ----------------------------------------------------
    if (action === "balance") {
      const userId = req.query.user_id || req.query.username || "guest";
      const balance = await getUserBalance(userId);
      return res.status(200).json({ success: true, balance });
    }

    // ----------------------------------------------------
    // ACTION: CREATE PAYMENT (Lightning Invoice)
    // ----------------------------------------------------
    if (action === "create-payment") {
      const { amount, user_id, username, telegram_id } = req.body || {};
      const satsAmount = Number(amount);

      if (!satsAmount || satsAmount <= 0) {
        return res.status(400).json({ success: false, error: "Invalid satoshi amount." });
      }

      // Create checkout session on Speed
      const speedRes = await speedRequest("/checkout/sessions", "POST", {
        amount: satsAmount,
        currency: "SATS",
        payment_methods: ["lightning"],
        statement_descriptor: `Pheizu deposit for ${username || user_id}`
      });

      if (speedRes.status >= 400 || !speedRes.data) {
        return res.status(400).json({
          success: false,
          error: speedRes.data?.message || "Failed to generate Speed invoice."
        });
      }

      const session = speedRes.data;
      const invoice =
        session.payment_method_options?.lightning?.invoice ||
        session.lightning_invoice ||
        session.invoice ||
        session.hosted_url;

      const paymentRecord = {
        id: session.id,
        amount: satsAmount,
        user_id: user_id || username,
        username: username || "",
        telegram_id: String(telegram_id || ""),
        invoice: invoice,
        status: "pending",
        notified: false,
        createdAt: new Date()
      };

      if (db) {
        await db.collection("invoices").doc(session.id).set(paymentRecord);
      }
      memoryPayments.set(session.id, paymentRecord);

      return res.status(200).json({
        success: true,
        id: session.id,
        invoice: invoice,
        amount: satsAmount
      });
    }

    // ----------------------------------------------------
    // ACTION: CHECK STATUS & NOTIFY BOT CHAT ON SUCCESS
    // ----------------------------------------------------
    if (action === "check-status") {
      const paymentId = req.query.payment_id;
      const tgIdParam = req.query.telegram_id;
      const userId = req.query.user_id || req.query.username;

      if (!paymentId) {
        return res.status(400).json({ success: false, error: "payment_id required" });
      }

      // 1. Get stored payment metadata
      let record = null;
      if (db) {
        const doc = await db.collection("invoices").doc(paymentId).get();
        if (doc.exists) record = doc.data();
      }
      if (!record) {
        record = memoryPayments.get(paymentId);
      }

      const effectiveTelegramId = tgIdParam || record?.telegram_id;
      const effectiveAmount = record?.amount || 0;

      // 2. Query Speed API for payment status
      const speedRes = await speedRequest(`/checkout/sessions/${paymentId}`, "GET");
      const session = speedRes.data;

      const isPaid =
        session?.status === "paid" ||
        session?.payment_status === "paid" ||
        session?.status === "succeeded";

      // 3. When verified paid, update balance and send message to Telegram bot chat
      if (isPaid) {
        const alreadyNotified = record?.notified === true;

        if (!alreadyNotified) {
          // Credit user balance
          if (userId && effectiveAmount > 0) {
            await adjustUserBalance(userId, effectiveAmount);
          }

          // Mark payment as notified to avoid duplicate bot notifications
          if (db) {
            await db.collection("invoices").doc(paymentId).set(
              { status: "paid", notified: true, paidAt: new Date() },
              { merge: true }
            );
          }
          if (record) {
            record.status = "paid";
            record.notified = true;
            memoryPayments.set(paymentId, record);
          }

          // SEND TELEGRAM BOT CHAT NOTIFICATION
          if (effectiveTelegramId) {
            const message = [
              `⚡ <b>Lightning Payment Received!</b>\n`,
              `💰 Amount: <b>+${effectiveAmount || session?.amount || "Unknown"} sats</b>`,
              `🧾 Status: <b>Confirmed ✅</b>`,
              `🌐 Network: <b>Lightning Network</b>\n`,
              `Your Pheizu Wallet balance has been credited!`
            ].join("\n");

            await sendTelegramMessage(effectiveTelegramId, message);
          }
        }

        return res.status(200).json({
          success: true,
          is_paid: true,
          status: "paid",
          amount: effectiveAmount
        });
      }

      return res.status(200).json({
        success: true,
        is_paid: false,
        status: session?.status || "pending"
      });
    }

    // ----------------------------------------------------
    // ACTION: SEND / WITHDRAW
    // ----------------------------------------------------
    if (action === "send") {
      const { destination, amount, user_id, telegram_id } = req.body || {};
      const satsAmount = Number(amount);

      if (!destination || !satsAmount || satsAmount <= 0) {
        return res.status(400).json({ success: false, error: "Invalid destination or amount." });
      }

      const currentBalance = await getUserBalance(user_id);
      if (satsAmount > currentBalance) {
        return res.status(400).json({ success: false, error: "Insufficient balance." });
      }

      // Deduct balance
      await adjustUserBalance(user_id, -satsAmount);

      // Dispatch Telegram confirmation
      if (telegram_id) {
        const message = [
          `⚡ <b>Lightning Payment Sent!</b>\n`,
          `💸 Sent: <b>-${satsAmount} sats</b>`,
          `🎯 Destination: <code>${destination}</code>`,
          `🧾 Status: <b>Completed ✅</b>`
        ].join("\n");

        await sendTelegramMessage(telegram_id, message);
      }

      return res.status(200).json({ success: true, amount: satsAmount });
    }

    return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("Wallet API Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
