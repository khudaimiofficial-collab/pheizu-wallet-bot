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

// Helper: Retrieve Speed API Key from Firestore first, then environment variables
async function getSpeedApiKey() {
  if (db) {
    try {
      const snap = await db.collection("settings").doc("speed").get();
      if (snap.exists && snap.data().api_key) {
        const k = String(snap.data().api_key).trim().replace(/^["']|["']$/g, "");
        if (k && !k.includes("placeholder")) return k;
      }
    } catch (e) {}
  }
  const envKey = (process.env.SPEED_API_KEY || process.env.SPEED_SECRET_KEY || "").trim().replace(/^["']|["']$/g, "");
  if (envKey && !envKey.includes("placeholder")) return envKey;
  return null;
}

// Helper: Speed API Request Wrapper with robust authentication
async function speedRequest(path, method = "GET", body = null) {
  const apiKey = await getSpeedApiKey();
  if (!apiKey) {
    throw new Error("SPEED_API_KEY is not set. Use 'Set Speed Key' in Admin Panel or set SPEED_API_KEY in Vercel.");
  }

  // Speed supports Bearer or Basic Auth
  const authHeader = apiKey.startsWith("Basic ") || apiKey.startsWith("Bearer ")
    ? apiKey
    : (apiKey.startsWith("sk_") ? `Bearer ${apiKey}` : `Basic ${Buffer.from(apiKey + ":").toString("base64")}`);

  const options = {
    method,
    headers: {
      "Authorization": authHeader,
      "Content-Type": "application/json"
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(`https://api.tryspeed.com${path}`, options);
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = { error: { message: `Speed returned non-JSON HTTP ${res.status}` } };
  }

  return { status: res.status, data };
}

// Helper: Extract clean error message from Speed API responses
function parseSpeedError(data, status) {
  if (!data) return `Speed API HTTP ${status}`;
  if (data.error && typeof data.error === "object" && data.error.message) {
    return data.error.message;
  }
  if (typeof data.error === "string") return data.error;
  if (Array.isArray(data.errors) && data.errors[0]?.message) {
    return data.errors[0].message;
  }
  if (data.message) return data.message;
  return `Speed API error (${status})`;
}

// Helper: Dispatch Telegram notification to Bot Chat
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
  for (const col of ["users", "wallets"]) {
    for (const id of candidates) {
      try {
        const doc = await db.collection(col).doc(String(id).toLowerCase()).get();
        if (doc.exists) {
          const d = doc.data();
          return Number(d.balance ?? d.sats ?? d.amount ?? 0);
        }
      } catch (e) {}
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
    // 2. ACTION: CREATE PAYMENT (Lightning Invoice / QR)
    // ----------------------------------------------------
    if (action === "create-payment") {
      const body = req.body || {};
      const rawAmount = body.amount !== undefined && body.amount !== null ? Number(body.amount) : 0;
      const currency = body.target_currency || "SATS";
      const paymentMethod = body.payment_method || body.network || "lightning";
      const userId = String(body.user_id || body.username || "").toLowerCase();
      const telegramId = String(body.telegram_id || "");

      // Build payload for Speed checkout sessions
      const sessionPayload = {
        currency: currency === "SATS" ? "SATS" : currency,
        payment_methods: [paymentMethod === "lightning" ? "lightning" : paymentMethod]
      };

      // Handle specific amount vs open/variable amount
      if (rawAmount > 0) {
        sessionPayload.amount = rawAmount;
      } else {
        // Allow open-amount invoice
        sessionPayload.amount_type = "variable";
        sessionPayload.allow_variable_amount = true;
      }

      const speedRes = await speedRequest("/checkout/sessions", "POST", sessionPayload);

      if (speedRes.status >= 400 || !speedRes.data) {
        const errorMsg = parseSpeedError(speedRes.data, speedRes.status);
        return res.status(400).json({ success: false, error: errorMsg });
      }

      const session = speedRes.data;

      // Extract invoice string from Speed session object
      const invoice =
        session.payment_method_options?.lightning?.invoice ||
        session.lightning_invoice ||
        session.invoice ||
        session.payment?.invoice ||
        session.hosted_url ||
        session.url;

      if (!invoice) {
        return res.status(400).json({ success: false, error: "Speed did not return a valid Lightning invoice." });
      }

      const record = {
        tx_id: session.id,
        id: session.id,
        invoice,
        amount: rawAmount || 0,
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
        amount: rawAmount || 0,
        currency
      });
    }

    // ----------------------------------------------------
    // 3. ACTION: CHECK STATUS (Notifies Bot Chat)
    // ----------------------------------------------------
    if (action === "check-status") {
      const paymentId = req.query.payment_id;
      const queryUserId = req.query.user_id;
      const queryTelegramId = req.query.telegram_id;

      if (!paymentId) return res.status(400).json({ success: false, error: "payment_id required" });

      let invoiceData = null;
      let invoiceRef = null;
      if (db) {
        invoiceRef = db.collection("invoices").doc(paymentId);
        const snap = await invoiceRef.get();
        if (snap.exists) invoiceData = snap.data();
      }

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
          if (targetUserId || targetTelegramId) {
            await creditUser(targetUserId, targetTelegramId, paidAmount, currency);
          }

          if (invoiceRef) {
            await invoiceRef.set({ is_paid: true, notified: true, paid_at: new Date().toISOString() }, { merge: true });
          }

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

          // Send message to Telegram Bot Chat
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

      await deductUser(userId, telegramId, amount, currency);

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
