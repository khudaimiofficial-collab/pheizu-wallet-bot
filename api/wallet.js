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

// Helper: Safely extract error message from Speed API responses
function extractSpeedErrorMessage(data) {
  if (!data) return "Unknown Speed API error";
  if (typeof data === "string") return data;
  if (data.message && typeof data.message === "string") return data.message;
  if (data.error) {
    if (typeof data.error === "string") return data.error;
    if (data.error.message) return data.error.message;
    if (data.error.description) return data.error.description;
  }
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    const first = data.errors[0];
    if (typeof first === "string") return first;
    if (first.message) return first.message;
  }
  return JSON.stringify(data);
}

// Helper: Safely extract lightning invoice or address from any Speed charge response format
function extractInvoice(charge) {
  if (!charge) return null;

  // Direct string payment request
  if (typeof charge.payment_request === "string" && charge.payment_request.length > 0) {
    return charge.payment_request;
  }

  // Nested in payment_request object
  if (charge.payment_request && typeof charge.payment_request === "object") {
    if (charge.payment_request.lightning_invoice) return charge.payment_request.lightning_invoice;
    if (charge.payment_request.address) return charge.payment_request.address;
    if (charge.payment_request.payment_request) return charge.payment_request.payment_request;
    if (charge.payment_request.url) return charge.payment_request.url;
  }

  // Nested in lightning object
  if (charge.lightning && typeof charge.lightning === "object") {
    if (charge.lightning.payment_request) return charge.lightning.payment_request;
    if (charge.lightning.invoice) return charge.lightning.invoice;
  }

  // Nested in payment_method_details
  if (charge.payment_method_details?.lightning?.payment_request) {
    return charge.payment_method_details.lightning.payment_request;
  }
  if (charge.payment_method_details?.bitcoin?.address) {
    return charge.payment_method_details.bitcoin.address;
  }
  if (charge.payment_method_details?.crypto?.address) {
    return charge.payment_method_details.crypto.address;
  }

  // Root fallbacks
  if (charge.lightning_invoice) return charge.lightning_invoice;
  if (charge.invoice) return charge.invoice;
  if (charge.address) return charge.address;
  if (charge.hosted_checkout_url) return charge.hosted_checkout_url;
  if (charge.checkout_url) return charge.checkout_url;
  if (charge.url) return charge.url;

  return null;
}

// Helper: Retrieve Speed API Key from Env or Firestore settings
async function getSpeedApiKey() {
  const envKey = process.env.SPEED_API_KEY || process.env.SPEED_SECRET_KEY || process.env.SPEED_KEY;
  if (envKey && envKey.trim()) {
    return envKey.trim();
  }

  if (db) {
    try {
      const snap = await db.collection("settings").doc("speed").get();
      if (snap.exists) {
        const data = snap.data();
        const key = data.api_key || data.key || data.secret_key;
        if (key && String(key).trim()) return String(key).trim();
      }

      const snap2 = await db.collection("settings").doc("speed_key").get();
      if (snap2.exists) {
        const data = snap2.data();
        const key = data.api_key || data.key || data.secret_key;
        if (key && String(key).trim()) return String(key).trim();
      }
    } catch (e) {
      console.error("Error fetching speed key from firestore:", e.message);
    }
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
    if (!data.callback) throw new Error("Could not resolve Lightning Address callback.");

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
  // 2. CREATE PAYMENT (DEPOSIT - FIXED PAYLOAD & INVOICE PARSING)
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
        return res.status(500).json({
          success: false,
          error: "Speed API Key is missing. Configure SPEED_API_KEY in environment or via Admin Panel."
        });
      }

      const selectedCurrency = (target_currency || "SATS").toUpperCase();
      const selectedMethod = (payment_method || network || "lightning").toLowerCase();

      // Clean payload for Speed /charges (Do NOT include target_currency here)
      const speedPayload = {
        amount: selectedCurrency === "SATS" ? Math.round(depositAmount) : depositAmount,
        currency: selectedCurrency,
        description: `Deposit to ${username || user_id || "wallet"}`
      };

      if (selectedCurrency === "SATS") {
        if (selectedMethod === "onchain" || selectedMethod === "bitcoin") {
          speedPayload.payment_methods = ["onchain"];
        } else {
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

      if (!speedRes.ok) {
        const errorMsg = extractSpeedErrorMessage(charge);
        console.error("Speed /charges returned HTTP error:", speedRes.status, errorMsg);
        return res.status(speedRes.status).json({
          success: false,
          error: `Speed API Error (${speedRes.status}): ${errorMsg}`
        });
      }

      const invoice = extractInvoice(charge);

      if (!charge.id || !invoice) {
        const errorMsg = extractSpeedErrorMessage(charge);
        return res.status(500).json({
          success: false,
          error: `Speed did not return a valid deposit invoice: ${errorMsg}`
        });
      }

      // Save pending invoice in Firestore
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
        }, { merge: true });
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

      // Check if already credited
      let invoiceData = null;
      let invoiceRef = null;
      if (db) {
        invoiceRef = db.collection("invoices").doc(payment_id);
        const invSnap = await invoiceRef.get();
        if (invSnap.exists) {
          invoiceData = invSnap.data();
          if (invoiceData.is_paid) {
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

      // Credit balance
      let newBalance = creditedAmount;
      if (db) {
        const user = await resolveUserDoc(targetUserId, targetTgId);

        await user.ref.set({
          balance: admin.firestore.FieldValue.increment(creditedAmount),
          updated_at: new Date().toISOString()
        }, { merge: true });

        const updatedSnap = await user.ref.get();
        newBalance = Number(updatedSnap.data().balance ?? 0);

        if (invoiceRef) {
          await invoiceRef.set({
            is_paid: true,
            paid_at: new Date().toISOString(),
            settled_amount: creditedAmount
          }, { merge: true });
        }

        await db.collection("history").add({
          user_id: user.id,
          telegram_id: String(targetTgId || ""),
          type: "deposit",
          amount: creditedAmount,
          currency: charge.currency || invoiceData?.target_currency || "SATS",
          tx_id: charge.id || payment_id,
          created_at: new Date().toISOString()
        });

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

      const user = await resolveUserDoc(username || user_id, telegram_id);
      const currentBalance = Number(user.data.balance ?? user.data.sats ?? 0);

      if (withdrawAmount > currentBalance) {
        return res.status(400).json({
          success: false,
          error: `Insufficient balance! You have ${currentBalance.toLocaleString()} sats.`
        });
      }

      let recipientTarget = destination.trim();
      if (selectedMethod === "lightning") {
        recipientTarget = await resolveLnAddressToInvoice(destination, withdrawAmount);
      }

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
        const errorMsg = extractSpeedErrorMessage(payout);
        throw new Error(errorMsg);
      }

      await user.ref.update({
        balance: admin.firestore.FieldValue.increment(-withdrawAmount),
        updated_at: new Date().toISOString()
      });

      const remainingBalance = currentBalance - withdrawAmount;
      const txId = payout.id || "N/A";

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

      history.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

      return res.status(200).json({ success: true, history });
    } catch (err) {
      console.error("Action history error:", err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(400).json({ error: "Invalid action query parameter." });
};
