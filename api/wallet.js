const admin = require("firebase-admin");

// Initialize Firebase Admin
if (!admin.apps.length) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
      });
    } else {
      admin.initializeApp();
    }
  } catch (e) {
    console.error("Firebase init error in wallet:", e.message);
  }
}

const db = admin.apps.length ? admin.firestore() : null;

// Helper: Speed API Request Wrapper
async function speedRequest(path, method = "GET", body = null) {
  let apiKey = process.env.SPEED_API_KEY || process.env.SPEED_SECRET_KEY;
  
  // Also check database if configured via Admin Panel
  if (!apiKey && db) {
    try {
      const snap = await db.collection("settings").doc("speed").get();
      if (snap.exists && snap.data().api_key) apiKey = snap.data().api_key;
    } catch (e) {}
  }

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

// Helper: Dispatch Telegram Message to Bot Chat
async function sendTelegramMessage(chatId, text) {
  const token = process.env.BOT_TOKEN;
  if (!token || !chatId) return false;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: String(chatId),
        text,
        parse_mode: "HTML"
      })
    });
    const result = await res.json();
    return result.ok;
  } catch (e) {
    console.error("Telegram notification error:", e.message);
    return false;
  }
}

// Helper: Get user balance from Firestore
async function getBalance(userId, telegramId) {
  if (!db) return 0;
  const candidates = [userId, telegramId, telegramId ? `user${telegramId}` : null].filter(Boolean);
  for (const id of candidates) {
    const doc = await db.collection("users").doc(String(id).toLowerCase()).get();
    if (doc.exists) {
      const d = doc.data();
      return Number(d.balance ?? d.sats ?? d.amount ?? 0);
    }
  }
  return 0;
}

// Helper: Credit balance in Firestore
async function creditUser(userId, telegramId, amount, currency = "SATS") {
  if (!db || !amount) return;
  const targetId = String(userId || telegramId || `user${telegramId}`).toLowerCase();

  const userRef = db.collection("users").doc(targetId);
  const walletRef = db.collection("wallets").doc(targetId);

  const field = (currency === "USDT") ? "usdt_balance" : (currency === "USDC" ? "usdc_balance" : "balance");

  await userRef.set({ [field]: admin.firestore.FieldValue.increment(Number(amount)), updated_at: new Date().toISOString() }, { merge: true });
  await walletRef.set({ [field]: admin.firestore.FieldValue.increment(Number(amount)), updated_at: new Date().toISOString() }, { merge: true });
}

// Helper: Deduct balance in Firestore
async function deductUser(userId, telegramId, amount, currency = "SATS") {
  if (!db || !amount) return;
  const targetId = String(userId || telegramId || `user${telegramId}`).toLowerCase();

  const userRef = db.collection("users").doc(targetId);
  const walletRef = db.collection("wallets").doc(targetId);

  const field = (currency === "USDT") ? "usdt_balance" : (currency === "USDC" ? "usdc_balance" : "balance");

  await userRef.set({ [field]: admin.firestore.FieldValue.increment(-Number(amount)), updated_at: new Date().toISOString() }, { merge: true });
  await walletRef.set({ [field]: admin.firestore.FieldValue.increment(-Number(amount)), updated_at: new Date().toISOString() }, { merge: true });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query.action || (req.body && req.body.action);

  try {
    // ----------------------------------------------------
    // 1. ACTION: BALANCE
    // ----------------------------------------------------
    if (action === "balance") {
      const userId = req.query.user_id || req.query.username;
      const telegramId = req.query.telegram_id;
      const balance = await getBalance(userId, telegramId);
      return res.status(200).json({ success: true, balance });
    }

    // ----------------------------------------------------
    // 2. ACTION: CREATE PAYMENT (Invoice / QR)
    // ----------------------------------------------------
    if (action === "create-payment") {
      const body = req.body || {};
      const amount = Number(body.amount);
      const currency = body.target_currency || (body.network === "lightning" ? "SATS" : "SATS");
      const paymentMethod = body.payment_method || body.network || "lightning";
      const userId = String(body.user_id || body.username || "").toLowerCase();
      const telegramId = String(body.telegram_id || "");

      const sessionPayload = {
        currency: currency === "SATS" ? "SATS" : currency,
        payment_methods: [paymentMethod === "lightning" ? "lightning" : paymentMethod]
      };

      if (amount && amount > 0) {
        sessionPayload.amount = amount;
      }

      const speedRes = await speedRequest("/checkout/sessions", "POST", sessionPayload);
      if (speedRes.status >= 400 || !speedRes.data) {
        return res.status(400).json({ success: false, error: speedRes.data?.message || "Speed API invoice generation failed" });
      }

      const session = speedRes.data;
      const invoice = session.payment_method_options?.lightning?.invoice ||
                      session.lightning_invoice ||
                      session.invoice ||
                      session.hosted_url;

      const record = {
        tx_id: session.id,
        id: session.id,
        invoice,
        amount: amount || 0,
        currency,
        target_currency: currency,
        payment_method: paymentMethod,
        user_id: userId,
        telegram_id: telegramId,
        is_paid: false,
        notified: false,
        created_at: new Date().toISOString()
      };

      if (db) {
        await db.collection("invoices").doc(session.id).set(record);
      }

      return res.status(200).json({
        success: true,
        id: session.id,
        tx_id: session.id,
        invoice,
        amount: amount || 0,
        currency
      });
    }

    // ----------------------------------------------------
    // 3. ACTION: CHECK STATUS (Notifies Telegram Bot Chat!)
    // ----------------------------------------------------
    if (action === "check-status") {
      const paymentId = req.query.payment_id;
      const queryUserId = req.query.user_id;
      const queryTelegramId = req.query.telegram_id;

      if (!paymentId) return res.status(400).json({ success: false, error: "payment_id required" });

      // Look up invoice record in Firestore
      let invoiceData = null;
      let invoiceRef = null;
      if (db) {
        invoiceRef = db.collection("invoices").doc(paymentId);
        const snap = await invoiceRef.get();
        if (snap.exists) invoiceData = snap.data();
      }

      // Check payment status on Speed
      const speedRes = await speedRequest(`/checkout/sessions/${paymentId}`, "GET");
      const session = speedRes.data;

      const isPaid = session?.status === "paid" || session?.payment_status === "paid" || session?.status === "succeeded";
      const paidAmount = session?.amount || invoiceData?.amount || 0;
      const currency = invoiceData?.currency || session?.currency || "SATS";

      const targetTelegramId = queryTelegramId || invoiceData?.telegram_id;
      const targetUserId = queryUserId || invoiceData?.user_id;

      if (isPaid) {
        const alreadyNotified = invoiceData?.notified === true;

        if (!alreadyNotified) {
          // 1. Credit balance in DB
          if (targetUserId || targetTelegramId) {
            await creditUser(targetUserId, targetTelegramId, paidAmount, currency);
          }

          // 2. Mark as paid and notified
          if (invoiceRef) {
            await invoiceRef.set({ is_paid: true, notified: true, paid_at: new Date().toISOString() }, { merge: true });
          }

          // 3. Add to transaction history
          if (db && targetUserId) {
            await db.collection("history").add({
              user_id: targetUserId,
              telegram_id: targetTelegramId,
              tx_id: paymentId,
              amount: paidAmount,
              currency,
              type: "deposit",
              created_at: new Date().toISOString()
            });
          }

          // 4. 🔥 SEND CONFIRMATION DIRECTLY TO TELEGRAM BOT CHAT
          if (targetTelegramId) {
            const amtStr = `+${Number(paidAmount).toLocaleString()} ${currency}`;
            await sendTelegramMessage(
              targetTelegramId,
              `🎉 <b>Payment Received!</b>\n\n` +
              `✨ <b>${amtStr}</b> has been credited to your balance!\n\n` +
              `🆔 <b>TxID:</b> <code>${paymentId}</code>`
            );
          }
        }

        return res.status(200).json({
          success: true,
          is_paid: true,
          status: "paid",
          amount: paidAmount,
          currency
        });
      }

      return res.status(200).json({
        success: true,
        is_paid: false,
        status: session?.status || "pending"
      });
    }

    // ----------------------------------------------------
    // 4. ACTION: SEND / WITHDRAW
    // ----------------------------------------------------
    if (action === "send") {
      const body = req.body || {};
      const destination = body.destination;
      const amount = Number(body.amount);
      const currency = body.currency || body.target_currency || "SATS";
      const userId = String(body.user_id || body.username || "").toLowerCase();
      const telegramId = String(body.telegram_id || "");

      if (!destination || !amount || amount <= 0) {
        return res.status(400).json({ success: false, error: "Invalid destination or amount." });
      }

      const bal = await getBalance(userId, telegramId);
      if (amount > bal) {
        return res.status(400).json({ success: false, error: "Insufficient balance." });
      }

      // Deduct balance in Firestore
      await deductUser(userId, telegramId, amount, currency);

      // Record in History
      if (db) {
        await db.collection("history").add({
          user_id: userId,
          telegram_id: telegramId,
          destination,
          amount,
          currency,
          type: "withdrawal",
          created_at: new Date().toISOString()
        });
      }

      // Send confirmation to Bot Chat
      if (telegramId) {
        const displayRecipient = destination.includes("@") ? destination : `${destination.substring(0, 24)}...`;
        await sendTelegramMessage(
          telegramId,
          `✅ <b>Payment Successful!</b>\n\n` +
          `💸 <b>Amount Sent:</b> -${amount.toLocaleString()} ${currency}\n` +
          `🎯 <b>Recipient:</b> <code>${displayRecipient}</code>\n` +
          `🧾 <b>Status:</b> Completed`
        );
      }

      return res.status(200).json({ success: true, amount });
    }

    // ----------------------------------------------------
    // 5. ACTION: HISTORY
    // ----------------------------------------------------
    if (action === "history") {
      const userId = req.query.user_id;
      const list = [];
      if (db && userId) {
        const snap = await db.collection("history")
          .where("user_id", "==", String(userId).toLowerCase())
          .orderBy("created_at", "desc")
          .limit(10)
          .get();

        snap.forEach(doc => list.push(doc.data()));
      }
      return res.status(200).json({ success: true, history: list });
    }

    return res.status(400).json({ success: false, error: `Invalid action: ${action}` });
  } catch (err) {
    console.error("Wallet API Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
