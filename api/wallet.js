const admin = require("firebase-admin");

// 1. Bulletproof Firebase Initialization
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

// Helper: Get active Speed API key (checks Firestore first, then env variables)
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

// Helper: Extract real error from Speed's response
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

// Helper: Multi-identifier wallet resolver
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
    // 2. CREATE PAYMENT INVOICE (DEPOSIT - FIXED)
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

      // Clean API key (strip Basic/Bearer if accidentally included)
      const cleanKey = apiKey.replace(/^Bearer\s+/i, "").replace(/^Basic\s+/i, "").trim();

      // FIXED PAYLOAD: Do NOT send target_currency when currency is SATS
      const speedRes = await fetch("https://api.tryspeed.com/v1/payments", {
        method: "POST",
        headers: {
          "Authorization": `Basic ${Buffer.from(cleanKey + ":").toString("base64")}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: sats,
          currency: "SATS",
          payment_method: "lightning",
          description: `Deposit to ${uid}`
        })
      });

      const paymentData = await speedRes.json();

      // FIXED INVOICE EXTRACTION: Check all nested locations where Speed places the bolt11 string
      const invoiceString =
        paymentData.payment_request ||
        paymentData.invoice ||
        paymentData.payment_method?.lightning?.payment_request ||
        paymentData.payment_method_options?.lightning?.payment_request ||
        paymentData.lightning?.payment_request;

      if (!speedRes.ok || !invoiceString) {
        const errorDetail = extractErrorMessage(paymentData, speedRes.status);
        console.error("Speed API Failure:", speedRes.status, paymentData);
        return res.status(speedRes.status || 400).json({
          success: false,
          error: `[Speed ${speedRes.status}] ${errorDetail}`
        });
      }

      const paymentId = paymentData.id || `inv_${Date.now()}`;

      // Save invoice to Firestore
      await db.collection("invoices").doc(paymentId).set({
        id: paymentId,
        invoice: invoiceString,
        user_id: uid,
        telegram_id: telegram_id ? String(telegram_id) : null,
        amount: sats,
        is_paid: false,
        created_at: new Date().toISOString()
      });

      return res.status(200).json({
        success: true,
        id: paymentId,
        invoice: invoiceString
      });
    }

    // ========================================================
    // 3. CHECK STATUS
    // ========================================================
    if (action === "check-status" && req.method === "GET") {
      const { payment_id, user_id, telegram_id } = req.query;

      if (!payment_id) {
        return res.status(400).json({ success: false, error: "Missing payment_id" });
      }

      const invRef = db.collection("invoices").doc(payment_id);
      const invDoc = await invRef.get();

      if (invDoc.exists && invDoc.data().is_paid) {
        return res.status(200).json({ success: true, is_paid: true });
      }

      const apiKey = await getSpeedApiKey();
      const cleanKey = apiKey.replace(/^Bearer\s+/i, "").replace(/^Basic\s+/i, "").trim();

      const speedRes = await fetch(`https://api.tryspeed.com/v1/payments/${payment_id}`, {
        headers: {
          "Authorization": `Basic ${Buffer.from(cleanKey + ":").toString("base64")}`
        }
      });

      const payment = await speedRes.json();
      const status = String(payment.status || payment.state || "").toLowerCase();
      const isPaid = ["paid", "succeeded", "completed"].includes(status);

      if (isPaid && invDoc.exists && !invDoc.data().is_paid) {
        const sats = Number(invDoc.data().amount || payment.amount || 0);
        const creditTarget = invDoc.data().user_id || user_id || (telegram_id ? `user${telegram_id}` : "");

        const candidates = [creditTarget, telegram_id, invDoc.data().telegram_id];
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

        await batch.commit();
      }

      return res.status(200).json({ success: true, is_paid: isPaid });
    }

    // ========================================================
    // 4. SEND / WITHDRAW
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

      // Check if recipient is internal
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

      // Internal transfer
      if (recipientUserId) {
        if (recipientUserId === senderWallet.id) {
          return res.status(400).json({ success: false, error: "You cannot send payments to your own account." });
        }

        const recipientWallet = await findUserWallet([recipientUserId]);

        const batch = db.batch();
        batch.set(senderWallet.ref, {
          balance: admin.firestore.FieldValue.increment(-sendAmount)
        }, { merge: true });

        batch.set(recipientWallet.ref, {
          balance: admin.firestore.FieldValue.increment(sendAmount)
        }, { merge: true });

        if (internalInvoiceDoc) {
          batch.update(internalInvoiceDoc, {
            is_paid: true,
            paid_at: new Date().toISOString(),
            paid_by: senderWallet.id
          });
        }

        await batch.commit();

        return res.status(200).json({
          success: true,
          internal: true,
          message: `Internal transfer of ${sendAmount} sats completed.`
        });
      }

      // External transfer
      const apiKey = await getSpeedApiKey();
      if (!apiKey) {
        return res.status(500).json({ success: false, error: "Speed API key is not configured." });
      }

      const cleanKey = apiKey.replace(/^Bearer\s+/i, "").replace(/^Basic\s+/i, "").trim();

      const speedWithdrawRes = await fetch("https://api.tryspeed.com/v1/withdrawals", {
        method: "POST",
        headers: {
          "Authorization": `Basic ${Buffer.from(cleanKey + ":").toString("base64")}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: sendAmount,
          currency: "SATS",
          payment_method: "lightning",
          destination: dest
        })
      });

      const withdrawData = await speedWithdrawRes.json();

      if (!speedWithdrawRes.ok) {
        const errorDetail = extractErrorMessage(withdrawData, speedWithdrawRes.status);
        return res.status(speedWithdrawRes.status).json({
          success: false,
          error: `[Speed ${speedWithdrawRes.status}] ${errorDetail}`
        });
      }

      await senderWallet.ref.set({
        balance: admin.firestore.FieldValue.increment(-sendAmount)
      }, { merge: true });

      return res.status(200).json({
        success: true,
        id: withdrawData.id,
        message: `Successfully sent ${sendAmount} sats.`
      });
    }

    return res.status(400).json({ success: false, error: "Invalid action." });
  } catch (err) {
    console.error("Wallet Handler Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
