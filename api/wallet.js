// api/wallet.js
const { 
  normalizeUserKey, 
  getBalance, 
  addBalance, 
  deductBalance, 
  isPaymentProcessed, 
  markPaymentProcessed 
} = require('../lib/db');

const SPEED_SECRET_KEY = process.env.SPEED_SECRET_KEY || "";
const SPEED_BASE_URL = "https://api.tryspeed.com";

// Speed API client helper
async function speedRequest(endpoint, method = "GET", body = null) {
  if (!SPEED_SECRET_KEY) {
    throw new Error("SPEED_SECRET_KEY is not configured in environment variables.");
  }

  const authHeader = "Basic " + Buffer.from(SPEED_SECRET_KEY + ":").toString("base64");
  const options = {
    method,
    headers: {
      "Authorization": authHeader,
      "Content-Type": "application/json"
    }
  };

  if (body && (method === "POST" || method === "PUT")) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(`${SPEED_BASE_URL}${endpoint}`, options);
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json?.message || json?.error || `Speed API error (${res.status})`);
  }
  return json;
}

module.exports = async function handler(req, res) {
  // Enable CORS for Mini App requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

      if (!sats || sats <= 0) {
        return res.status(400).json({ success: false, error: "Invalid amount" });
      }

      // Create Lightning charge via Speed
      const charge = await speedRequest("/v1/charges", "POST", {
        amount: sats,
        currency: "SATS",
        description: `Deposit to ${userKey}`,
        metadata: { user_key: userKey }
      });

      // Extract Bolt11 Lightning invoice string
      const bolt11 = charge?.lightning_payment_request || charge?.payment_request || charge?.invoice;

      return res.status(200).json({
        success: true,
        id: charge.id,
        invoice: bolt11,
        amount: sats,
        user: userKey
      });
    }

    // 3. CHECK PAYMENT STATUS (Polling verification)
    if (action === 'check-status') {
      const paymentId = req.query.payment_id;
      const userParam = req.query.user_id || req.query.username;
      const tgId = req.query.telegram_id;
      const userKey = normalizeUserKey(userParam, tgId);

      if (!paymentId) {
        return res.status(400).json({ success: false, error: "Missing payment_id" });
      }

      const charge = await speedRequest(`/v1/charges/${paymentId}`, "GET");
      const isPaid = charge.status === "paid" || charge.status === "succeeded";

      if (isPaid) {
        // Prevent double crediting
        const alreadyCredited = await isPaymentProcessed(paymentId);
        if (!alreadyCredited) {
          const satsPaid = Math.floor(Number(charge.amount || 0));
          await addBalance(userKey, satsPaid);
          await markPaymentProcessed(paymentId);
        }
      }

      return res.status(200).json({
        success: true,
        is_paid: isPaid,
        status: charge.status
      });
    }

    // 4. SEND SATS FROM BALANCE (Send tab)
    if (action === 'send' && req.method === 'POST') {
      const { destination, amount, user_id, username, telegram_id } = req.body || {};
      const userKey = normalizeUserKey(username || user_id, telegram_id);
      const sats = Math.floor(Number(amount));

      if (!destination) {
        return res.status(400).json({ success: false, error: "Missing destination address or invoice." });
      }
      if (!sats || sats <= 0) {
        return res.status(400).json({ success: false, error: "Invalid amount." });
      }

      // Check balance first
      const currentBal = await getBalance(userKey);
      if (currentBal < sats) {
        return res.status(400).json({ 
          success: false, 
          error: `Insufficient balance. You have ${currentBal} sats, needed ${sats} sats.` 
        });
      }

      // Deduct balance before broadcast (escrow)
      await deductBalance(userKey, sats);

      try {
        // Initiate payout via Speed
        let payoutPayload = {
          currency: "SATS",
          amount: sats
        };

        if (destination.includes("@")) {
          // Lightning Address (LNURL)
          payoutPayload.lnurl = destination;
        } else {
          // Raw Bolt11 invoice
          payoutPayload.payment_request = destination.replace(/^lightning:/i, "");
        }

        const payout = await speedRequest("/v1/payouts", "POST", payoutPayload);

        return res.status(200).json({
          success: true,
          payout_id: payout.id,
          sent: sats,
          remaining_balance: await getBalance(userKey)
        });
      } catch (sendError) {
        // Refund on failure
        await addBalance(userKey, sats);
        return res.status(500).json({
          success: false,
          error: sendError.message || "Failed to route payment across the Lightning Network."
        });
      }
    }

    return res.status(404).json({ success: false, error: "Invalid action" });
  } catch (err) {
    console.error("Wallet API Error:", err);
    return res.status(500).json({ success: false, error: err.message || "Internal server error" });
  }
};
