const admin = require("firebase-admin");

// 1. Firebase Initialization
function getDb() {
  if (admin.apps.length) {
    return admin.firestore();
  }

  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      let sa = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
      if (!sa.startsWith("{")) {
        sa = Buffer.from(sa, "base64").toString("utf8");
      }
      const parsed = typeof sa === "string" ? JSON.parse(sa) : sa;
      if (parsed.private_key) {
        parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
      }
      admin.initializeApp({
        credential: admin.credential.cert(parsed)
      });
      return admin.firestore();
    }

    if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
        })
      });
      return admin.firestore();
    }

    admin.initializeApp();
    return admin.firestore();
  } catch (err) {
    console.error("Firebase Init Error:", err);
    return null;
  }
}

const db = getDb();
const DOMAIN = "pheizu-wallet-bot.vercel.app";
const BOT_TOKEN = process.env.BOT_TOKEN;

// Helper: Send Instant Telegram Notification
async function notifyTelegramUser(telegramId, message) {
  if (!BOT_TOKEN || !telegramId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramId,
        text: message,
        parse_mode: "HTML"
      })
    });
  } catch (e) {
    console.error("Failed to notify user:", e.message);
  }
}

// Helper: Get active Speed API key
async function getSpeedApiKey() {
  if (db) {
    try {
      const snap = await db.collection("settings").doc("speed").get();
      if (snap.exists && snap.data().api_key) {
        return snap.data().api_key.trim();
      }
    } catch (e) {
      console.warn("Could not read API key from DB:", e.message);
    }
  }
  return (process.env.SPEED_API_KEY || process.env.SPEED_SECRET_KEY || "").trim();
}

// Deep search JSON for lightning bolt11 invoice
function extractInvoice(obj) {
  if (!obj) return null;
  if (typeof obj === "string") {
    if (obj.toLowerCase().startsWith("lnbc") || obj.toLowerCase().startsWith("lightning:lnbc")) {
      return obj;
    }
    return null;
  }
  if (typeof obj !== "object") return null;

  if (obj.payment_request && typeof obj.payment_request === "string") return obj.payment_request;
  if (obj.invoice && typeof obj.invoice === "string") return obj.invoice;

  for (const key of Object.keys(obj)) {
    const found = extractInvoice(obj[key]);
    if (found) return found;
  }

  return obj.hosted_url || obj.url || null;
}

// Speed Client
async function speedRequest(path, method, body, apiKey) {
  const cleanKey = apiKey.replace(/^Bearer\s+/i, "").replace(/^Basic\s+/i, "").trim();
  const authHeader = `Basic ${Buffer.from(cleanKey + ":").toString("base64")}`;
  const url = `https://api.tryspeed.com/${path.replace(/^\//, "")}`;

  const res = await fetch(url, {
    method,
    headers: {
      "accept": "application/json",
      "authorization": authHeader,
      "content-type": "application/json",
      "speed-version": "2022-10-15"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

function extractErrorMessage(data, status) {
  if (!data) return `Speed API returned HTTP ${status}`;
  if (typeof data === "string") return data;
  if (data.message) return data.message;
  if (data.error && data.error.message) return data.error.message;
  if (typeof data.error === "string") return data.error;
  if (Array.isArray(data.errors) && data.errors[0]) {
    return data.errors[0].message || JSON.stringify(data.errors[0]);
  }
  return `Speed API error (HTTP ${status})`;
}

// Smart Wallet Resolver
async function findUserWallet(identifiers) {
  if (!db) return null;

  const candidateIds = Array.from(new Set(
    identifiers
      .filter(Boolean)
      .map(id => String(id).trim().toLowerCase())
  ));

  const collectionsToCheck = ["users", "wallets"];

  for (const col of collectionsToCheck) {
    for (const docId of candidateIds) {
      const doc = await db.collection(col).doc(docId).get();
      if (doc.exists) {
        const data = doc.data();
        const bal = data.balance ?? data.sats ?? data.amount;
        if (bal !== undefined && bal !== null) {
          return {
            ref: doc.ref,
            id: doc.id,
            data,
            balance: Number(bal) || 0,
            collection: col
          };
        }
      }
    }
  }

  const primary = candidateIds[0] || "unknown";
  return {
    ref: db.collection("users").doc(primary),
    id: primary,
    data: {},
    balance: 0,
    collection: "users"
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (!db) {
    return res.status(500).json({ 
      success: false, 
      error: "Firebase connection failed. Verify FIREBASE_SERVICE_ACCOUNT variable." 
    });
  }

  const { action } = req.query;

  try {
    // ========================================================
    // 1. GET BALANCE
    // ========================================================
    if (action === "balance" && req.method === "GET") {
      const uid = req.query.user_id;
      const uname = req.query.username;
      const tid = req.query.telegram_id;

      const candidates = [uid, uname, tid, tid ? `user${tid}` : null];
      const wallet = await findUserWallet(candidates);

      return res.status(200).json({
        success: true,
        user_id: wallet ? wallet.id : uid,
        balance: wallet ? wallet.balance : 0
      });
    }

    // ========================================================
    // 2. CREATE DEPOSIT INVOICE
    // ========================================================
    if (action === "create-payment" && req.method === "POST") {
      const { amount, user_id, username, telegram_id } = req.body;
      const sats = parseInt(amount, 10);
      const uid = (user_id || username || (telegram_id ? `user${telegram_id}` : "")).toLowerCase().trim();

      if (!sats || sats <= 0) {
        return res.status(400).json({ success: false, error: "Please enter a valid amount in sats." });
      }
      if (!uid) {
        return res.status(400).json({ success: false, error: "Missing user identification." });
      }

      const apiKey = await getSpeedApiKey();
      if (!apiKey) {
        return res.status(500).json({ 
          success: false, 
          error: "Speed API key is not configured. Admin can set it using '🔑 Set Key'." 
        });
      }

      const { ok, status, data: paymentData } = await speedRequest("payments", "POST", {
        currency: "SATS",
        amount: sats,
        target_currency: "SATS",
        payment_methods: ["lightning"],
        metadata: {
          user_id: uid,
          telegram_id: telegram_id ? String(telegram_id) : ""
        }
      }, apiKey);

      if (!ok && status !== 201) {
        const errorDetail = extractErrorMessage(paymentData, status);
        return res.status(status || 400).json({
          success: false,
          error: `[Speed ${status}] ${errorDetail}`
        });
      }

      const invoiceString = extractInvoice(paymentData);
      if (!invoiceString) {
        return res.status(500).json({
          success: false,
          error: "Speed did not return a valid Lightning invoice."
        });
      }

      const txId = paymentData.id || `py_${Date.now()}`;

      // Save invoice with telegram_id to notify the user when paid
      await db.collection("invoices").doc(txId).set({
        id: txId,
        invoice: invoiceString,
        user_id: uid,
        telegram_id: telegram_id ? String(telegram_id) : null,
        amount: sats,
        is_paid: false,
        created_at: new Date().toISOString()
      });

      return res.status(200).json({
        success: true,
        id: txId,
        tx_id: txId,
        invoice: invoiceString
      });
    }

    // ========================================================
    // 3. CHECK DEPOSIT STATUS (Notifies user via Telegram on payment)
    // ========================================================
    if (action === "check-status" && req.method === "GET") {
      const { payment_id, user_id, telegram_id } = req.query;

      if (!payment_id) {
        return res.status(400).json({ success: false, error: "Missing payment_id" });
      }

      const invRef = db.collection("invoices").doc(payment_id);
      const invDoc = await invRef.get();

      if (invDoc.exists && invDoc.data().is_paid) {
        return res.status(200).json({ 
          success: true, 
          is_paid: true, 
          tx_id: payment_id,
          amount: invDoc.data().amount
        });
      }

      const apiKey = await getSpeedApiKey();
      const { data: payment } = await speedRequest(`payments/${payment_id}`, "GET", null, apiKey);

      const status = String(payment?.status || payment?.state || "").toLowerCase();
      const isPaid = ["paid", "succeeded", "completed"].includes(status);

      if (isPaid && invDoc.exists && !invDoc.data().is_paid) {
        const sats = Number(invDoc.data().amount || payment?.amount || 0);
        const creditTarget = invDoc.data().user_id || user_id || (telegram_id ? `user${telegram_id}` : "");
        const targetTgId = invDoc.data().telegram_id || telegram_id;

        const candidates = [creditTarget, targetTgId];
        const wallet = await findUserWallet(candidates);

        const batch = db.batch();
        batch.update(invRef, {
          is_paid: true,
          paid_at: new Date().toISOString()
        });

        batch.set(wallet.ref, {
          balance: admin.firestore.FieldValue.increment(sats),
          updated_at: new Date().toISOString()
        }, { merge: true });

        batch.set(db.collection("transactions").doc(payment_id), {
          id: payment_id,
          type: "deposit",
          user_id: wallet.id,
          amount: sats,
          status: "completed",
          created_at: new Date().toISOString()
        });

        await batch.commit();

        // Send Telegram confirmation to user
        if (targetTgId) {
          await notifyTelegramUser(
            targetTgId,
            `🎉 <b>Payment Received!</b>\n\n` +
            `⚡ <b>+${sats} sats</b> have been credited to your balance!\n` +
            `🆔 <b>TxID:</b> <code>${payment_id}</code>`
          );
        }
      }

      return res.status(200).json({ 
        success: true, 
        is_paid: isPaid,
        tx_id: payment_id,
        amount: invDoc.exists ? invDoc.data().amount : 0
      });
    }

    // ========================================================
    // 4. SEND / WITHDRAW (Auto-notifies recipient on internal transfer)
    // ========================================================
    if (action === "send" && req.method === "POST") {
      const { destination, amount, user_id, telegram_id, username } = req.body;
      const sendAmount = parseInt(amount, 10);
      const dest = (destination || "").trim();

      if (!dest || isNaN(sendAmount) || sendAmount <= 0) {
        return res.status(400).json({ success: false, error: "Invalid parameters." });
      }

      const senderCandidates = [user_id, username, telegram_id, telegram_id ? `user${telegram_id}` : null];
      const senderWallet = await findUserWallet(senderCandidates);

      if (!senderWallet || senderWallet.balance < sendAmount) {
        const currentBal = senderWallet ? senderWallet.balance : 0;
        return res.status(400).json({ 
          success: false, 
          error: `Insufficient balance! You have ${currentBal} sats.` 
        });
      }

      let recipientUserId = null;
      let internalInvoiceDoc = null;

      if (dest.includes("@") && dest.toLowerCase().includes(DOMAIN.toLowerCase())) {
        recipientUserId = dest.split("@")[0].toLowerCase().trim();
      }

      if (!recipientUserId) {
        const invSnap = await db.collection("invoices")
          .where("invoice", "==", dest)
          .where("is_paid", "==", false)
          .limit(1)
          .get();

        if (!invSnap.empty) {
          const inv = invSnap.docs[0];
          recipientUserId = inv.data().user_id;
          internalInvoiceDoc = inv.ref;
        }
      }

      // A. INTERNAL TRANSFER
      if (recipientUserId) {
        if (recipientUserId === senderWallet.id) {
          return res.status(400).json({ success: false, error: "You cannot send payments to your own account." });
        }

        const recipientWallet = await findUserWallet([recipientUserId]);
        const txId = `INT_${Date.now()}_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

        const batch = db.batch();
        batch.set(senderWallet.ref, {
          balance: admin.firestore.FieldValue.increment(-sendAmount)
        }, { merge: true });

        batch.set(recipientWallet.ref, {
          balance: admin.firestore.FieldValue.increment(sendAmount)
        }, { merge: true });

        let recipientTgId = null;

        if (internalInvoiceDoc) {
          const invData = (await internalInvoiceDoc.get()).data();
          recipientTgId = invData?.telegram_id;

          batch.update(internalInvoiceDoc, {
            is_paid: true,
            paid_at: new Date().toISOString(),
            paid_by: senderWallet.id,
            tx_id: txId
          });
        }

        batch.set(db.collection("transactions").doc(txId), {
          id: txId,
          type: "internal_transfer",
          sender_id: senderWallet.id,
          recipient_id: recipientWallet.id,
          amount: sendAmount,
          status: "completed",
          created_at: new Date().toISOString()
        });

        await batch.commit();

        // Notify the recipient on Telegram
        const targetChatId = recipientTgId || recipientWallet.data?.telegram_id;
        if (targetChatId) {
          await notifyTelegramUser(
            targetChatId,
            `🎉 <b>Payment Received!</b>\n\n` +
            `💰 <b>+${sendAmount} sats</b> received from @${senderWallet.id}!\n` +
            `🆔 <b>TxID:</b> <code>${txId}</code>`
          );
        }

        return res.status(200).json({
          success: true,
          internal: true,
          tx_id: txId,
          recipient: recipientWallet.id,
          message: `Internal transfer of ${sendAmount} sats completed.`
        });
      }

      // B. EXTERNAL WITHDRAWAL (Instant Send)
      const apiKey = await getSpeedApiKey();
      if (!apiKey) {
        return res.status(500).json({ success: false, error: "Speed API key is not configured." });
      }

      let withdrawRes = await speedRequest("withdraw-requests", "POST", {
        amount: sendAmount,
        currency: "SATS",
        payment_method: "lightning",
        destination: dest
      }, apiKey);

      if (!withdrawRes.ok && withdrawRes.status !== 201) {
        withdrawRes = await speedRequest("instant-sends", "POST", {
          amount: sendAmount,
          currency: "SATS",
          payment_method: "lightning",
          destination: dest
        }, apiKey);
      }

      if (!withdrawRes.ok && withdrawRes.status !== 201) {
        const errorDetail = extractErrorMessage(withdrawRes.data, withdrawRes.status);
        return res.status(withdrawRes.status).json({
          success: false,
          error: `[Speed ${withdrawRes.status}] ${errorDetail}`
        });
      }

      const txId = withdrawRes.data?.id || `WD_${Date.now()}`;

      const batch = db.batch();
      batch.set(senderWallet.ref, {
        balance: admin.firestore.FieldValue.increment(-sendAmount)
      }, { merge: true });

      batch.set(db.collection("transactions").doc(txId), {
        id: txId,
        type: "external_withdrawal",
        sender_id: senderWallet.id,
        destination: dest,
        amount: sendAmount,
        status: "completed",
        created_at: new Date().toISOString()
      });

      await batch.commit();

      return res.status(200).json({
        success: true,
        id: txId,
        tx_id: txId,
        message: `Successfully sent ${sendAmount} sats.`
      });
    }

    return res.status(400).json({ success: false, error: "Invalid action." });
  } catch (err) {
    console.error("Wallet Handler Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
