const admin = require("firebase-admin");

// 1. Initialize Firebase Admin
if (!admin.apps.length) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
      });
    } else {
      admin.initializeApp();
    }
  } catch (err) {
    console.error("Firebase initialization warning:", err.message);
  }
}

const db = admin.apps.length ? admin.firestore() : null;
const DOMAIN = "pheizu-wallet-bot.vercel.app";

// Helper: Get active Speed API Key (checks Firestore first, falls back to ENV)
async function getSpeedApiKey() {
  if (db) {
    try {
      const snap = await db.collection("settings").doc("speed").get();
      if (snap.exists && snap.data().api_key) {
        return snap.data().api_key.trim();
      }
    } catch (e) {
      console.warn("Could not read key from DB:", e.message);
    }
  }
  return (process.env.SPEED_API_KEY || "").trim();
}

module.exports = async function handler(req, res) {
  // Enable CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { action } = req.query;

  try {
    // ========================================================
    // ACTION 1: GET BALANCE
    // ========================================================
    if (action === "balance" && req.method === "GET") {
      const userId = (req.query.user_id || req.query.username || "").toLowerCase().trim();
      if (!userId) {
        return res.status(400).json({ success: false, error: "Missing user_id" });
      }

      if (!db) {
        return res.status(200).json({ success: true, balance: 0 });
      }

      const userDoc = await db.collection("users").doc(userId).get();
      const balance = userDoc.exists ? Number(userDoc.data().balance || 0) : 0;

      return res.status(200).json({ success: true, balance });
    }

    // ========================================================
    // ACTION 2: CREATE INVOICE (DEPOSIT)
    // ========================================================
    if (action === "create-payment" && req.method === "POST") {
      const { amount, user_id, username } = req.body;
      const sats = parseInt(amount, 10);
      const uid = (user_id || username || "").toLowerCase().trim();

      if (!sats || sats <= 0) {
        return res.status(400).json({ success: false, error: "Invalid amount" });
      }
      if (!uid) {
        return res.status(400).json({ success: false, error: "Missing user_id" });
      }

      const apiKey = await getSpeedApiKey();
      if (!apiKey) {
        return res.status(500).json({ success: false, error: "Speed API key is not configured." });
      }

      // Call Speed API to create a Lightning Invoice
      const speedRes = await fetch("https://api.tryspeed.com/v1/payments", {
        method: "POST",
        headers: {
          "Authorization": `Basic ${Buffer.from(apiKey + ":").toString("base64")}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: sats,
          currency: "SATS",
          target_currency: "SATS",
          payment_method: "lightning",
          description: `Deposit for ${uid}`
        })
      });

      const paymentData = await speedRes.json();

      if (!speedRes.ok || (!paymentData.payment_request && !paymentData.invoice)) {
        return res.status(speedRes.status).json({
          success: false,
          error: paymentData.message || paymentData.error || "Failed to create invoice from Speed."
        });
      }

      const invoiceString = paymentData.payment_request || paymentData.invoice;
      const paymentId = paymentData.id;

      // Save the invoice in Firestore to support internal transfers & verification
      if (db) {
        await db.collection("invoices").doc(paymentId).set({
          id: paymentId,
          invoice: invoiceString,
          user_id: uid,
          amount: sats,
          is_paid: false,
          created_at: new Date().toISOString()
        });
      }

      return res.status(200).json({
        success: true,
        id: paymentId,
        invoice: invoiceString
      });
    }

    // ========================================================
    // ACTION 3: CHECK INVOICE STATUS
    // ========================================================
    if (action === "check-status" && req.method === "GET") {
      const { payment_id, user_id } = req.query;
      const uid = (user_id || "").toLowerCase().trim();

      if (!payment_id) {
        return res.status(400).json({ success: false, error: "Missing payment_id" });
      }

      // Check database first
      if (db) {
        const invDoc = await db.collection("invoices").doc(payment_id).get();
        if (invDoc.exists && invDoc.data().is_paid) {
          return res.status(200).json({ success: true, is_paid: true });
        }
      }

      // Verify directly with Speed API
      const apiKey = await getSpeedApiKey();
      const speedRes = await fetch(`https://api.tryspeed.com/v1/payments/${payment_id}`, {
        headers: {
          "Authorization": `Basic ${Buffer.from(apiKey + ":").toString("base64")}`
        }
      });

      const payment = await speedRes.json();
      const isPaid = payment.status === "paid" || payment.status === "completed" || payment.state === "paid";

      if (isPaid && db) {
        // Credit the balance once
        const invRef = db.collection("invoices").doc(payment_id);
        const invDoc = await invRef.get();

        if (invDoc.exists && !invDoc.data().is_paid) {
          const sats = Number(invDoc.data().amount || payment.amount || 0);
          const creditUser = invDoc.data().user_id || uid;

          const batch = db.batch();
          batch.update(invRef, { is_paid: true, paid_at: new Date().toISOString() });
          batch.set(db.collection("users").doc(creditUser), {
            balance: admin.firestore.FieldValue.increment(sats)
          }, { merge: true });

          await batch.commit();
        }
      }

      return res.status(200).json({ success: true, is_paid: isPaid });
    }

    // ========================================================
    // ACTION 4: SEND / WITHDRAW (With Internal Transfer Fix)
    // ========================================================
    if (action === "send" && req.method === "POST") {
      const { destination, amount, user_id } = req.body;
      const sendAmount = parseInt(amount, 10);
      const senderId = (user_id || "").toLowerCase().trim();
      const dest = (destination || "").trim();

      if (!senderId || !dest || isNaN(sendAmount) || sendAmount <= 0) {
        return res.status(400).json({ success: false, error: "Invalid parameters." });
      }

      if (!db) {
        return res.status(500).json({ success: false, error: "Database not connected." });
      }

      // 1. Verify Sender Balance
      const senderDoc = await db.collection("users").doc(senderId).get();
      const currentBal = senderDoc.exists ? Number(senderDoc.data().balance || 0) : 0;

      if (currentBal < sendAmount) {
        return res.status(400).json({ success: false, error: `Insufficient balance (${currentBal} sats available).` });
      }

      // 2. CHECK IF THIS IS AN INTERNAL TRANSFER
      let recipientId = null;
      let internalInvoiceDoc = null;

      // Case A: Destination is a Pheizu Lightning Address (e.g. friend@pheizu-wallet-bot.vercel.app)
      if (dest.includes("@") && dest.toLowerCase().includes(DOMAIN.toLowerCase())) {
        recipientId = dest.split("@")[0].toLowerCase().trim();
      }

      // Case B: Destination is an Invoice created by another user inside this bot
      if (!recipientId) {
        const invQuery = await db.collection("invoices")
          .where("invoice", "==", dest)
          .where("is_paid", "==", false)
          .limit(1)
          .get();

        if (!invQuery.empty) {
          const found = invQuery.docs[0];
          recipientId = found.data().user_id;
          internalInvoiceDoc = found.ref;
        }
      }

      // 3. EXECUTE INTERNAL TRANSFER (Bypasses Speed 400 error completely!)
      if (recipientId) {
        if (recipientId === senderId) {
          return res.status(400).json({ success: false, error: "You cannot send payments to your own account." });
        }

        const batch = db.batch();
        batch.update(db.collection("users").doc(senderId), {
          balance: admin.firestore.FieldValue.increment(-sendAmount)
        });
        batch.set(db.collection("users").doc(recipientId), {
          balance: admin.firestore.FieldValue.increment(sendAmount)
        }, { merge: true });

        if (internalInvoiceDoc) {
          batch.update(internalInvoiceDoc, {
            is_paid: true,
            paid_at: new Date().toISOString(),
            paid_by: senderId
          });
        }

        await batch.commit();

        return res.status(200).json({
          success: true,
          internal: true,
          message: `Internal transfer of ${sendAmount} sats sent to @${recipientId} successfully!`
        });
      }

      // 4. EXTERNAL WITHDRAWAL (Destination is outside Pheizu)
      const apiKey = await getSpeedApiKey();
      if (!apiKey) {
        return res.status(500).json({ success: false, error: "Speed API key is not configured." });
      }

      const speedWithdrawRes = await fetch("https://api.tryspeed.com/v1/withdrawals", {
        method: "POST",
        headers: {
          "Authorization": `Basic ${Buffer.from(apiKey + ":").toString("base64")}`,
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
        return res.status(speedWithdrawRes.status).json({
          success: false,
          error: withdrawData.message || withdrawData.error || "External Lightning payment failed."
        });
      }

      // Deduct balance from sender after successful Speed dispatch
      await db.collection("users").doc(senderId).update({
        balance: admin.firestore.FieldValue.increment(-sendAmount)
      });

      return res.status(200).json({
        success: true,
        id: withdrawData.id,
        message: `Successfully sent ${sendAmount} sats.`
      });
    }

    return res.status(400).json({ success: false, error: "Invalid action." });
  } catch (err) {
    console.error("Wallet API Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
