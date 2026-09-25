// api/wallet.js
const { 
  normalizeUserKey,
  saveUserTelegramId,
  notifyPaymentReceived,
  getBalance, 
  claimPaymentAndCredit,
  deductBalance,
  internalTransfer,
  checkPendingDeposits
} = require('../lib/db');

const DOMAIN = process.env.DOMAIN || "pheizu-wallet-bot.vercel.app";
const SPEED_BASE_URL = "https://api.tryspeed.com";

function extractPaymentDetails(data) {
  let invoice = "";
  let url = "";

  function scan(obj) {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") {
        const str = v.trim();
        if (/^(lnbc|lntb|lightning:)/i.test(str)) {
          if (!invoice) invoice = str;
        } else if ((k.toLowerCase().includes("url") || k === "link") && /^https?:\/\//i.test(str)) {
          if (!url) url = str;
        }
      } else if (typeof v === "object") {
        scan(v);
      }
    }
  }

  scan(data);
  return { invoice, url };
}

async function speedRequest(endpoint, method = "GET", body = null) {
  const rawKey = (process.env.SPEED_SECRET_KEY || "").trim().replace(/^["']|["']$/g, "");
  if (!rawKey) {
    throw new Error("SPEED_SECRET_KEY is missing in your Vercel Environment Variables.");
  }

  const cleanEndpoint = endpoint.startsWith("/") ? endpoint.slice(1) : endpoint;
  const authHeader = "Basic " + Buffer.from(rawKey + ":").toString("base64");

  const headers = {
    "accept": "application/json",
    "authorization": authHeader,
    "content-type": "application/json",
    "speed-version": "2022-10-15"
  };

  const options = { method, headers };

  if (body && (method === "POST" || method === "PUT")) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(`${SPEED_BASE_URL}/${cleanEndpoint}`, options);
  const text = await res.text();

  let json = {};
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Speed error (${res.status}): ${text}`);
  }

  if (!res.ok) {
    const errMsg = json?.message || json?.error?.message || json?.errors?.[0]?.message || text;
    throw new Error(`[Speed ${res.status}] ${errMsg}`);
  }

  return json;
}

// Resolves a Lightning Address (name@domain) to a Bolt11 invoice
async function resolveDestinationToInvoice(destination, sats) {
  const clean = destination.trim().replace(/^lightning:/i, "");
  if (!clean.includes("@")) return clean; // Already a BOLT11 invoice

  const [name, host] = clean.split("@");
  if (!name || !host) throw new Error("Invalid Lightning Address format.");

  const lnurlUrl = `https://${host}/.well-known/lnurlp/${encodeURIComponent(name)}`;
  const res = await fetch(lnurlUrl);
  if (!res.ok) throw new Error(`Could not reach provider for ${destination}`);
  const lnurlData = await res.json();

  const msats = sats * 1000;
  if (lnurlData.minSendable && msats < lnurlData.minSendable) {
    throw new Error(`Amount below minimum of ${Math.ceil(lnurlData.minSendable / 1000)} sats.`);
  }
  if (lnurlData.maxSendable && msats > lnurlData.maxSendable) {
    throw new Error(`Amount exceeds maximum of ${Math.floor(lnurlData.maxSendable / 1000)} sats.`);
  }

  const sep = lnurlData.callback.includes("?") ? "&" : "?";
  const cbRes = await fetch(`${lnurlData.callback}${sep}amount=${msats}`);
  const cbData = await cbRes.json();

  const invoice = cbData.pr || cbData.payment_request;
  if (!invoice) throw new Error(cbData.reason || "Provider did not return a valid invoice.");
  return invoice;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, speed-version');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  try {
    // 1. GET BALANCE
    if (action === 'balance') {
      const userParam = req.query.user_id || req.query.username;
      const tgId = req.query.telegram_id;
      const userKey = normalizeUserKey(userParam, tgId);

      if (tgId) await saveUserTelegramId(userKey, tgId);

      // Check any pending Lightning Address deposits
      await checkPendingDeposits(userKey, speedRequest);

      const balance = await getBalance(userKey);
      return res.status(200).json({ success: true, balance, user: userKey });
    }

    // 2. CREATE PAYMENT INVOICE (Receive Tab)
    if (action === 'create-payment' && req.method === 'POST') {
      const { amount, user_id, username, telegram_id } = req.body || {};
      const userKey = normalizeUserKey(username || user_id, telegram_id);
      const sats = Math.floor(Number(amount));

      if (telegram_id) await saveUserTelegramId(userKey, telegram_id);
      if (!sats || isNaN(sats) || sats <= 0) {
        return res.status(400).json({ success: false, error: "Please enter a valid amount in sats." });
      }

      const payment = await speedRequest("payments", "POST", {
        amount: sats,
        currency: "SATS",
        target_currency: "SATS",
        payment_methods: ["lightning"],
        description: `Deposit to ${userKey}`,
        metadata: { user_key: userKey }
      });

      const { invoice, url } = extractPaymentDetails(payment);

      return res.status(200).json({
        success: true,
        id: payment.id,
        invoice: invoice || url,
        url: url,
        amount: sats,
        user: userKey
      });
    }

    // 3. CHECK STATUS (Receive Verification)
    if (action === 'check-status') {
      const paymentId = req.query.payment_id;
      const userParam = req.query.user_id || req.query.username;
      const tgId = req.query.telegram_id;
      const userKey = normalizeUserKey(userParam, tgId);

      if (tgId) await saveUserTelegramId(userKey, tgId);
      if (!paymentId) return res.status(400).json({ success: false, error: "Missing payment_id." });

      const payment = await speedRequest(`payments/${paymentId}`, "GET");
      const st = (payment.status || "").toLowerCase();
      const isPaid = st === "succeeded" || st === "paid";
      let satsCredited = 0;
      let newBalance = 0;

      if (isPaid) {
        const satsPaid = Math.floor(Number(payment.amount || 0));
        const result = await claimPaymentAndCredit(paymentId, userKey, satsPaid);

        if (!result.alreadyProcessed) {
          satsCredited = satsPaid;
          newBalance = result.newBalance;
          await notifyPaymentReceived(userKey, satsPaid, newBalance);
        } else {
          newBalance = await getBalance(userKey);
        }
      }

      return res.status(200).json({
        success: true,
        is_paid: isPaid,
        status: payment.status,
        amount_credited: satsCredited,
        balance: newBalance
      });
    }

    // 4. SEND SATS FROM BALANCE (Send Tab)
    if (action === 'send' && req.method === 'POST') {
      const { destination, amount, user_id, username, telegram_id } = req.body || {};
      const userKey = normalizeUserKey(username || user_id, telegram_id);
      const sats = Math.floor(Number(amount));

      if (telegram_id) await saveUserTelegramId(userKey, telegram_id);
      if (!destination || typeof destination !== "string") {
        return res.status(400).json({ success: false, error: "Missing destination." });
      }
      if (!sats || isNaN(sats) || sats <= 0) {
        return res.status(400).json({ success: false, error: "Invalid amount." });
      }

      const cleanDest = destination.trim().toLowerCase();

      // =======================================================================
      // CASE A: INTERNAL TRANSFER TO ANOTHER BOT USER (Zero Fee, Instant)
      // =======================================================================
      if (cleanDest.endsWith(`@${DOMAIN}`)) {
        const recipientUser = cleanDest.replace(`@${DOMAIN}`, "").trim();

        const transferRes = await internalTransfer(userKey, recipientUser, sats);

        // Notify recipient immediately in Telegram
        await notifyPaymentReceived(recipientUser, sats, transferRes.newToBal, userKey);

        return res.status(200).json({
          success: true,
          type: "internal",
          sent: sats,
          remaining_balance: transferRes.newFromBal
        });
      }

      // =======================================================================
      // CASE B: EXTERNAL LIGHTNING WITHDRAWAL VIA SPEED
      // =======================================================================
      const currentBal = await getBalance(userKey);
      if (currentBal < sats) {
        return res.status(400).json({ 
          success: false, 
          error: `Insufficient balance: You have ${currentBal.toLocaleString()} sats, needed ${sats.toLocaleString()} sats.` 
        });
      }

      // Escrow balance
      await deductBalance(userKey, sats);

      try {
        // Resolve Lightning Address to a Bolt11 invoice
        const bolt11 = await resolveDestinationToInvoice(cleanDest, sats);

        // Speed's correct withdrawal endpoint: POST /withdrawals
        const withdrawal = await speedRequest("withdrawals", "POST", {
          amount: sats,
          currency: "SATS",
          target_currency: "SATS",
          payment_method: "lightning",
          payment_request: bolt11
        });

        return res.status(200).json({
          success: true,
          withdrawal_id: withdrawal.id,
          sent: sats,
          remaining_balance: await getBalance(userKey)
        });
      } catch (sendError) {
        // Refund on failure
        const refundKey = `refund_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        await claimPaymentAndCredit(refundKey, userKey, sats);

        return res.status(500).json({
          success: false,
          error: sendError.message || "Failed to broadcast withdrawal."
        });
      }
    }

    return res.status(404).json({ success: false, error: `Invalid action '${action}' requested.` });
  } catch (err) {
    console.error("Wallet API Error:", err);
    return res.status(500).json({ success: false, error: err.message || "Server error occurred." });
  }
};
