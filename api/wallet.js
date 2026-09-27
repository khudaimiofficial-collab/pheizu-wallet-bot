const admin = require("firebase-admin");

// 1. Firebase Initialization
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
    console.error("Firebase init error in wallet.js:", e.message);
  }
}

const db = admin.apps.length ? admin.firestore() : null;

// Helper: Retrieve Speed API Key from Env or Firestore settings
async function getSpeedApiKey() {
  if (process.env.SPEED_API_KEY && process.env.SPEED_API_KEY.trim()) {
    return process.env.SPEED_API_KEY.trim();
  }
  if (db) {
    try {
      const snap = await db.collection("settings").doc("speed").get();
      if (snap.exists && snap.data().api_key) {
        return snap.data().api_key.trim();
      }
    } catch (e) {}
  }
  return "";
}

// Helper: Dispatches log messages to Telegram logs channel
async function forwardToLogsChannel(text) {
  const token = process.env.BOT_TOKEN;
  if (!token) return;
  try {
    let channelId = null;
    if (db) {
      try {
        const snap = await db.collection("settings").doc("logs_channel").get();
        if (snap.exists && snap.data().channel_id) {
          channelId = snap.data().channel_id;
        }
      } catch (err) {}
    }

    if (!channelId) {
      channelId = process.env.LOG_CHANNEL_ID || process.env.ADMIN_CHAT_ID;
    }

    if (!channelId) return;

    channelId = String(channelId).trim();
    if (/^\d{8,14}$/.test(channelId)) channelId = `-100${channelId}`;

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: channelId,
        text: `📋 <b>Wallet Event:</b>\n\n${text}`,
        parse_mode: "HTML"
      })
    });

    const result = await res.json();
    if (!result.ok) {
      // Plain text fallback
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: channelId,
          text: `📋 Wallet Event:\n\n${text.replace(/<[^>]*>?/gm, "")}`
        })
      });
    }
  } catch (e) {
    console.error("forwardToLogsChannel error in wallet.js:", e.message);
  }
}

// Helper: Sends direct confirmation to user on Telegram
async function notifyUser(telegramId, text) {
  const token = process.env.BOT_TOKEN;
  if (!token || !telegramId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: String(telegramId),
        text: text,
        parse_mode: "HTML"
      })
    });
  } catch (e) {}
}

// Helper: Smart User Resolver (Syncs Bot ID, Username, and WebApp ID to one Document)
async function resolveUserDoc(userId, telegramId) {
  if (!db) return null;

  const rawCandidates = [
    userId,
    telegramId,
    telegramId ? `user${telegramId}` : null,
    userId ? String(userId).toLowerCase().replace(/[^a-z0-9_]/g, "") : null
  ].filter(Boolean);

  const candidates = [...new Set(rawCandidates)];

  for (const col of ["users", "wallets"]) {
    for (const id of candidates) {
      const ref = db.collection(col).doc(String(id));
      const snap = await ref.get();
      if (snap.exists) {
        return { ref, data: snap.data(), id: String(id), col };
      }
    }
  }

  // Create document if user is new
  const primaryId = (userId || (telegramId ? `user${telegramId}` : "guest")).toLowerCase().replace(/[^a-z0-9_]/g, "");
  const newRef = db.collection("users").doc(primaryId);
  const initialData = {
    user_id: primaryId,
    telegram_id: String(telegramId || ""),
    balance: 0,
    created_at: new Date().toISOString()
  };
  await newRef.set(initialData, { merge: true });
  return { ref: newRef, data: initialData, id: primaryId, col: "users" };
}

// Helper: Resolve Lightning Address / LNURL to BOLT11 invoice
async function resolveLnAddressToInvoice(destination, amountSats) {
  const cleanDest = destination.trim();
  if (cleanDest.toLowerCase().startsWith("lnbc") || cleanDest.toLowerCase().startsWith("lightning:lnbc")) {
    return cleanDest.replace(/^lightning:/i, "");
  }

  if (cleanDest.includes("@")) {
    const [name, host] = cleanDest.split("@");
    const res = await fetch(`https://${host}/.well-known/lnurlp/${name}`);
    const data = await res.json();
    if (!data.callback) throw new Error("Could not resolve Lightning Address LNURL callback.");

    const msats = Math.round(Number(amountSats) * 1000);
    const sep = data.callback.includes("?") ? "&" : "?";
    const cbRes = await fetch(`${data.callback}${sep}amount=${msats}`);
    const cbData = await cbRes.json();
    if (!cbData.pr) throw new Error(cbData.reason || "Failed to generate BOLT11 invoice from Lightning Address.");
    return cbData.pr;
  }

  return cleanDest;
}

// -------------------------------------------------------------
// MAIN ROUTE HANDLER
// -------------------------------------------------------------
module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { action } = req.query;
  const speedKey = await getSpeedApiKey();

  // ===========================================================
  // 1. GET BALANCE
  // ===========================================================
  if (action === "balance" && req.method === "GET") {
    try {
      const { user_id, username, telegram_id } = req.query;
      const user = await resolveUserDoc(username || user_id, telegram_id);

      if (!user) {
        return res.status(200).json({ success: true, balance: 0 });
      }

      const balance = Number(user.data.balance ?? user.data.sats ?? user.data.amount ?? 0);
      return res.status(200).json({ success: true, balance });
    } catch (err) {
      console.error("Action balance error:", err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ===========================================================
  // 2. CREATE PAYMENT (DEPOSIT)
  // ===========================================================
  if (action === "create-payment" && req.method === "POST") {
    try {
      const {
        amount,
        target_currency,
        payment_method,
        network,
        user_id,
        username,
        telegram_id
      } = req.body;

      const depositAmount = Number(amount);
      if (!depositAmount || depositAmount <= 0) {
        return res.status(400).json({ success: false, error: "Invalid deposit amount." });
      }

      if (!speedKey) {
        return res.status(500).json({ success: false, error: "Speed API Key is not configured." });
      }

      const selectedCurrency = (target_currency || "SATS").toUpperCase();
      const selectedMethod = (payment_method || network || "lightning").toLowerCase();

      let speedPayload = {
        amount: depositAmount,
        currency: selectedCurrency,
        target_currency: selectedCurrency,
        description: `Deposit to ${username || user_id || "wallet"}`
      };

      if (selectedCurrency === "SATS") {
        if (selectedMethod === "onchain" || selectedMethod === "bitcoin") {
          speedPayload.network = "bitcoin";
          speedPayload.payment_methods = ["onchain"];
        } else {
          speedPayload.network = "lightning";
          speedPayload.payment_methods = ["lightning"];
        }
      } else {
        speedPayload.payment_methods = [selectedMethod];
      }

      const speedRes = await fetch("https://api.tryspeed.com/charges", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Basic ${Buffer.from(speedKey + ":").toString("base64")}`
        },
        body: JSON.stringify(speedPayload)
      });

      const charge = await speedRes.json();
      const invoice =
        charge.payment_request?.lightning_invoice ||
        charge.payment_request?.address ||
        charge.payment_request?.url;

      if (!charge.id || !invoice) {
        throw new Error(charge.message || charge.error || "Failed to generate Speed deposit invoice.");
      }

      // Store pending invoice in Firestore so check-status reliably tracks it
      if (db) {
        await db.collection("invoices").doc(charge.id).set({
          id: charge.id,
          invoice: invoice,
          amount: depositAmount,
          currency: selectedCurrency,
          target_currency: selectedCurrency,
          payment_method: selectedMethod,
          user_id: String(username || user_id || "").toLowerCase(),
          telegram_id: String(telegram_id || ""),
          is_paid: false,
          created_at: new Date().toISOString()
        });
      }

      return res.status(200).json({
        success: true,
        id: charge.id,
        tx_id: charge.id,
        invoice: invoice,
        amount: depositAmount,
        currency: selectedCurrency
      });
    } catch (err) {
      console.error("Action create-payment error:", err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ===========================================================
  // 3. CHECK DEPOSIT STATUS & UPDATE BALANCE
  // ===========================================================
  if (action === "check-status" && req.method === "GET") {
    try {
      const { payment_id, user_id, username, telegram_id } = req.query;

      if (!payment_id) {
        return res.status(400).json({ success: false, error: "Missing payment_id." });
      }

      if (!speedKey) {
        return res.status(500).json({ success: false, error: "Speed API Key missing." });
      }

      // 1. Fetch charge from Speed
      const speedRes = await fetch(`https://api.tryspeed.com/charges/${payment_id}`, {
        headers: {
          "Authorization": `Basic ${Buffer.from(speedKey + ":").toString("base64")}`
        }
      });
      const charge = await speedRes.json();

      const status = String(charge.status || "").toLowerCase();
      const isPaid = status === "paid" || status === "succeeded" || status === "successful";

      if (!isPaid) {
        return res.status(200).json({ success: true, is_paid: false, status });
      }

      // 2. Fetch invoice metadata from Firestore
      let invoiceData = null;
      let invoiceRef = null;
      if (db) {
        invoiceRef = db.collection("invoices").doc(payment_id);
        const invSnap = await invoiceRef.get();
        if (invSnap.exists) {
          invoiceData = invSnap.data();
          if (invoiceData.is_paid) {
            // Already credited
            const user = await resolveUserDoc(invoiceData.user_id, invoiceData.telegram_id);
            const currentBal = Number(user.data.balance ?? 0);
            return res.status(200).json({
              success: true,
              is_paid: true,
              already_credited: true,
              amount: invoiceData.amount,
              balance: currentBal
            });
          }
        }
      }

      const creditedAmount = Number(charge.amount || invoiceData?.amount || 0);
      const targetUserId = invoiceData?.user_id || username || user_id;
      const targetTgId = invoiceData?.telegram_id || telegram_id;

      // 3. Credit user's balance
      let newBalance = creditedAmount;
      if (db) {
        const user = await resolveUserDoc(targetUserId, targetTgId);

        // Increment balance atomically
        await user.ref.set({
          balance: admin.firestore.FieldValue.increment(creditedAmount),
          updated_at: new Date().toISOString()
        }, { merge: true });

        // Calculate latest balance
        const updatedSnap = await user.ref.get();
        newBalance = Number(updatedSnap.data().balance ?? 0);

        // Mark invoice as paid
        if (invoiceRef) {
          await invoiceRef.set({
            is_paid: true,
            paid_at: new Date().toISOString(),
            settled_amount: creditedAmount
          }, { merge: true });
        }

        // Add record to history
        await db.collection("history").add({
          user_id: user.id,
          telegram_id: String(targetTgId || ""),
          type: "deposit",
          amount: creditedAmount,
          currency: charge.currency || invoiceData?.target_currency || "SATS",
          tx_id: charge.id || payment_id,
          created_at: new Date().toISOString()
        });

        // 4. Send Confirmation to User and Logs Channel
        await notifyUser(
          targetTgId,
          `🎉 <b>Payment Received!</b>\n\n` +
          `⚡ <b>+${creditedAmount.toLocaleString()} SATS</b> credited to your balance!\n` +
          `💰 <b>New Balance:</b> ${newBalance.toLocaleString()} sats\n` +
          `🆔 <b>TxID:</b> <code>${charge.id || payment_id}</code>`
        );

        await forwardToLogsChannel(
          `📥 <b>Deposit Confirmed</b>\n` +
          `• User: @${user.id}\n` +
          `• Amount: +${creditedAmount.toLocaleString()} SATS\n` +
          `• New Balance: ${newBalance.toLocaleString()} sats\n` +
          `• TxID: <code>${charge.id || payment_id}</code>`
        );
      }

      return res.status(200).json({
        success: true,
        is_paid: true,
        amount: creditedAmount,
        balance: newBalance,
        tx_id: charge.id || payment_id
      });
    } catch (err) {
      console.error("Action check-status error:", err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ===========================================================
  // 4. SEND / WITHDRAW
  // ===========================================================
  if (action === "send" && req.method === "POST") {
    try {
      const {
        destination,
        amount,
        withdraw_method,
        network,
        currency,
        target_currency,
        user_id,
        username,
        telegram_id
      } = req.body;

      const withdrawAmount = Number(amount);
      if (!destination || !withdrawAmount || withdrawAmount <= 0) {
        return res.status(400).json({ success: false, error: "Invalid destination or amount." });
      }

      if (!speedKey) {
        return res.status(500).json({ success: false, error: "Speed API Key missing." });
      }

      const selectedMethod = (withdraw_method || network || "lightning").toLowerCase();
      const selectedCurrency = (currency || target_currency || "SATS").toUpperCase();

      // Check balance
      const user = await resolveUserDoc(username || user_id, telegram_id);
      const currentBalance = Number(user.data.balance ?? user.data.sats ?? 0);

      if (withdrawAmount > currentBalance) {
        return res.status(400).json({
          success: false,
          error: `Insufficient balance! You have ${currentBalance.toLocaleString()} sats.`
        });
      }

      // Resolve Lightning Address if applicable
      let recipientTarget = destination.trim();
      if (selectedMethod === "lightning") {
        recipientTarget = await resolveLnAddressToInvoice(destination, withdrawAmount);
      }

      // Execute Speed Payout
      const speedRes = await fetch("https://api.tryspeed.com/payouts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Basic ${Buffer.from(speedKey + ":").toString("base64")}`
        },
        body: JSON.stringify({
          amount: withdrawAmount,
          currency: selectedCurrency,
          target_currency: selectedCurrency,
          network: selectedMethod,
          payment_method: selectedMethod,
          recipient: recipientTarget
        })
      });

      const payout = await speedRes.json();
      if (!speedRes.ok || payout.status === "failed") {
        throw new Error(payout.message || payout.error || "Speed rejected the payout request.");
      }

      // Deduct balance
      await user.ref.update({
        balance: admin.firestore.FieldValue.increment(-withdrawAmount),
        updated_at: new Date().toISOString()
      });

      const remainingBalance = currentBalance - withdrawAmount;
      const txId = payout.id || "N/A";

      // Save to History
      if (db) {
        await db.collection("history").add({
          user_id: user.id,
          telegram_id: String(telegram_id || ""),
          type: "withdrawal",
          amount: withdrawAmount,
          currency: selectedCurrency,
          method: selectedMethod,
          destination: recipientTarget.length > 30 ? recipientTarget.slice(0, 27) + "..." : recipientTarget,
          tx_id: txId,
          created_at: new Date().toISOString()
        });
      }

      return res.status(200).json({
        success: true,
        tx_id: txId,
        id: txId,
        amount: withdrawAmount,
        remaining_balance: remainingBalance
      });
    } catch (err) {
      console.error("Action send error:", err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ===========================================================
  // 5. TRANSACTION HISTORY
  // ===========================================================
  if (action === "history" && req.method === "GET") {
    try {
      const { user_id, username, telegram_id } = req.query;
      const user = await resolveUserDoc(username || user_id, telegram_id);

      if (!db || !user) {
        return res.status(200).json({ success: true, history: [] });
      }

      const snap = await db.collection("history")
        .where("user_id", "in", [user.id, String(telegram_id || "")].filter(Boolean))
        .limit(25)
        .get();

      const history = [];
      snap.forEach(doc => history.push({ id: doc.id, ...doc.data() }));

      // Sort descending by date
      history.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

      return res.status(200).json({ success: true, history });
    } catch (err) {
      console.error("Action history error:", err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(400).json({ error: "Invalid action query parameter." });
};
