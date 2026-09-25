// api/wallet.js
const { 
  normalizeUserKey, 
  getBalance, 
  addBalance, 
  deductBalance, 
  isPaymentProcessed, 
  markPaymentProcessed 
} = require('../lib/db');

const SPEED_BASE_URL = "https://api.tryspeed.com";

// Recursive extractor for bolt11 invoice and hosted checkout URL
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

// Universal Speed API client with required version header
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
    "speed-version": "2022-10-15" // Required by Speed API
  };

  const options = {
    method,
    headers
  };

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, speed-version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const action = req.query.action;

  try {
    // 1. GET BALANCE
    if (action === 'balance') {
      const userParam = req.query.user_id || req.query.username;
      const tgId = req.query.telegram_id;
      const userKey = normalizeUserKey(userParam, tgId);

      const balance = await getBalance(userKey);
      return res.status(200).json({ success: true, balance, user: userKey });
    }

    // 2. CREATE PAYMENT INVOICE (Receive tab)
    if (action === 'create-payment' && req.method === 'POST') {
      const { amount, user_id, username, telegram_id } = req.body || {};
      const userKey = normalizeUserKey(username || user_id, telegram_id);
      const sats = Math.floor(Number(amount));

      if (!sats || isNaN(sats) || sats <= 0) {
        return res.status(400).json({ success: false, error: "Please enter a valid amount in sats." });
      }

      // Calls /payments with exact required fields
      const payment = await speedRequest("payments", "POST", {
        amount: sats,
        currency: "SATS",
        target_currency: "SATS",
        payment_methods: ["lightning"],
        description: `Deposit to ${userKey}`,
        metadata: { user_key: userKey }
      });

      const { invoice, url } = extractPaymentDetails(payment);

      if (!invoice && !url) {
        return res.status(500).json({
          success: false,
          error: "Speed created payment but did not return a Lightning invoice."
        });
      }

      return res.status(200).json({
        success: true,
        id: payment.id,
        invoice: invoice || url,
        url: url,
        amount: sats,
        user: userKey
      });
    }

    // 3. CHECK PAYMENT STATUS (Polling)
    if (action === 'check-status') {
      const paymentId = req.query.payment_id;
      const userParam = req.query.user_id || req.query.username;
      const tgId = req.query.telegram_id;
      const userKey = normalizeUserKey(userParam, tgId);

      if (!paymentId) {
        return res.status(400).json({ success: false, error: "Missing payment_id." });
      }

      const payment = await speedRequest(`payments/${paymentId}`, "GET");
      const st = (payment.status || "").toLowerCase();
      const isPaid = st === "succeeded" || st === "paid";

      if (isPaid) {
        const alreadyCredited = await isPaymentProcessed(paymentId);
        if (!alreadyCredited) {
          const satsPaid = Math.floor(Number(payment.amount || 0));
          await addBalance(userKey, satsPaid);
          await markPaymentProcessed(paymentId);
        }
      }

      return res.status(200).json({
        success: true,
        is_paid: isPaid,
        status: payment.status
      });
    }

    // 4. SEND SATS FROM BALANCE (Send tab)
    if (action === 'send' && req.method === 'POST') {
      const { destination, amount, user_id, username, telegram_id } = req.body || {};
      const userKey = normalizeUserKey(username || user_id, telegram_id);
      const sats = Math.floor(Number(amount));

      if (!destination || typeof destination !== "string") {
        return res.status(400).json({ success: false, error: "Missing destination Lightning Address or Invoice." });
      }
      if (!sats || isNaN(sats) || sats <= 0) {
        return res.status(400).json({ success: false, error: "Invalid amount." });
      }

      const currentBal = await getBalance(userKey);
      if (currentBal < sats) {
        return res.status(400).json({ 
          success: false, 
          error: `Insufficient balance. You have ${currentBal.toLocaleString()} sats, needed ${sats.toLocaleString()} sats.` 
        });
      }

      await deductBalance(userKey, sats);

      try {
        const cleanDestination = destination.trim();
        let payoutPayload = {
          currency: "SATS",
          amount: sats
        };

        if (cleanDestination.includes("@")) {
          payoutPayload.lnurl = cleanDestination;
        } else {
          payoutPayload.payment_request = cleanDestination.replace(/^lightning:/i, "");
        }

        const payout = await speedRequest("payouts", "POST", payoutPayload);

        return res.status(200).json({
          success: true,
          payout_id: payout.id,
          sent: sats,
          remaining_balance: await getBalance(userKey)
        });
      } catch (sendError) {
        await addBalance(userKey, sats); // Refund on failure
        return res.status(500).json({
          success: false,
          error: sendError.message || "Failed to broadcast payment over Lightning."
        });
      }
    }

    return res.status(404).json({ success: false, error: `Invalid action '${action}'` });
  } catch (err) {
    console.error("Wallet API Error:", err);
    return res.status(500).json({ success: false, error: err.message || "Internal server error" });
  }
};
