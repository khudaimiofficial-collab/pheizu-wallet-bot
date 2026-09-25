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

// Helper: Sanitize and validate Speed Secret Key
function getSanitizedSpeedKey() {
  let key = process.env.SPEED_SECRET_KEY || "";
  key = key.trim().replace(/^["']|["']$/g, ""); // Remove accidental quotes or whitespace

  if (!key) {
    throw new Error("SPEED_SECRET_KEY is missing in your Vercel Environment Variables.");
  }

  if (key.startsWith("pk_")) {
    throw new Error(
      "Speed API Error 403: You configured a Publishable Key (pk_...). " +
      "You MUST use a Secret Key starting with 'sk_test_' or 'sk_live_' from the Speed Dashboard."
    );
  }

  return key;
}

// Speed API client helper
async function speedRequest(endpoint, method = "GET", body = null) {
  const secretKey = getSanitizedSpeedKey();

  // Speed supports HTTP Basic Auth: base64(secretKey + ":")
  const authHeader = "Basic " + Buffer.from(secretKey + ":").toString("base64");

  const options = {
    method,
    headers: {
      "Authorization": authHeader,
      "Content-Type": "application/json",
      "Accept": "application/json"
    }
  };

  if (body && (method === "POST" || method === "PUT")) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(`${SPEED_BASE_URL}${endpoint}`, options);

  let responseData;
  const rawText = await res.text();
  try {
    responseData = JSON.parse(rawText);
  } catch (err) {
    responseData = null;
  }

  if (!res.ok) {
    // Extract exact nested error message from Speed's response
    const detailedMessage = 
      responseData?.errors?.[0]?.message || 
      responseData?.message || 
      responseData?.error?.message || 
      responseData?.error || 
      rawText || 
      `HTTP status ${res.status}`;

    console.error(`[Speed Error ${res.status}]:`, detailedMessage);

    if (res.status === 403) {
      throw new Error(
        `Speed API 403 Forbidden: ${detailedMessage}. ` +
        `Ensure your Secret Key (sk_...) has write permissions for Charges and that Live Mode account compliance is approved.`
      );
    }

    if (res.status === 401) {
      throw new Error(`Speed API 401 Unauthorized: Invalid Secret Key. Check your SPEED_SECRET_KEY in Vercel.`);
    }

    throw new Error(`Speed API [${res.status}]: ${detailedMessage}`);
  }

  return responseData;
}

module.exports = async function handler(req, res) {
  // CORS configuration for Telegram Mini App
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const action = req.query.action;

  try {
    // =========================================================================
    // 1. GET BALANCE
    // =========================================================================
    if (action === 'balance') {
      const userParam = req.query.user_id || req.query.username;
      const tgId = req.query.telegram_id;
      const userKey = normalizeUserKey(userParam, tgId);

      const balance = await getBalance(userKey);
      return res.status(200).json({ success: true, balance, user: userKey });
    }

    // =========================================================================
    // 2. CREATE PAYMENT INVOICE (Receive Tab)
    // =========================================================================
    if (action === 'create-payment' && req.method === 'POST') {
      const { amount, user_id, username, telegram_id } = req.body || {};
      const userKey = normalizeUserKey(username || user_id, telegram_id);
      const sats = Math.floor(Number(amount));

      if (!sats || isNaN(sats) || sats <= 0) {
        return res.status(400).json({ success: false, error: "Please enter a valid amount greater than 0 sats." });
      }

      // Create Lightning charge payload for Speed
      const chargePayload = {
        amount: sats,
        currency: "SATS",
        description: `Deposit to ${userKey}`,
        metadata: {
          user_key: userKey,
          source: "telegram_mini_app"
        }
      };

      const charge = await speedRequest("/v1/charges", "POST", chargePayload);

      // Extract Bolt11 Lightning invoice string across Speed response variants
      const bolt11 = 
        charge?.lightning_payment_request || 
        charge?.payment_request || 
        charge?.invoice ||
        charge?.payment_method_details?.lightning?.payment_request ||
        charge?.payment_method_options?.lightning?.payment_request;

      if (!bolt11) {
        console.error("Speed charge created without bolt11:", charge);
        return res.status(500).json({
          success: false,
          error: "Speed created the charge but returned no Lightning payment request. Check if Lightning is enabled in Speed dashboard."
        });
      }

      return res.status(200).json({
        success: true,
        id: charge.id,
        invoice: bolt11,
        amount: sats,
        user: userKey
      });
    }

    // =========================================================================
    // 3. CHECK PAYMENT STATUS (Polling from Mini App)
    // =========================================================================
    if (action === 'check-status') {
      const paymentId = req.query.payment_id;
      const userParam = req.query.user_id || req.query.username;
      const tgId = req.query.telegram_id;
      const userKey = normalizeUserKey(userParam, tgId);

      if (!paymentId) {
        return res.status(400).json({ success: false, error: "Missing payment_id." });
      }

      const charge = await speedRequest(`/v1/charges/${paymentId}`, "GET");
      const isPaid = charge.status === "paid" || charge.status === "succeeded";

      if (isPaid) {
        // Prevent crediting the same payment multiple times
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

    // =========================================================================
    // 4. SEND SATS FROM BALANCE (Send Tab)
    // =========================================================================
    if (action === 'send' && req.method === 'POST') {
      const { destination, amount, user_id, username, telegram_id } = req.body || {};
      const userKey = normalizeUserKey(username || user_id, telegram_id);
      const sats = Math.floor(Number(amount));

      if (!destination || typeof destination !== "string") {
        return res.status(400).json({ success: false, error: "Missing destination Lightning Address or Invoice." });
      }
      if (!sats || isNaN(sats) || sats <= 0) {
        return res.status(400).json({ success: false, error: "Invalid satoshi amount." });
      }

      // Check current user balance
      const currentBal = await getBalance(userKey);
      if (currentBal < sats) {
        return res.status(400).json({ 
          success: false, 
          error: `Insufficient balance: You have ${currentBal.toLocaleString()} sats, needed ${sats.toLocaleString()} sats.` 
        });
      }

      // Escrow / deduct balance first to prevent double-spending
      await deductBalance(userKey, sats);

      try {
        const cleanDestination = destination.trim();
        let payoutPayload = {
          currency: "SATS",
          amount: sats
        };

        if (cleanDestination.includes("@")) {
          // Lightning Address (e.g. name@domain.com)
          payoutPayload.lnurl = cleanDestination;
        } else {
          // Raw Bolt11 invoice (strip 'lightning:' protocol if present)
          payoutPayload.payment_request = cleanDestination.replace(/^lightning:/i, "");
        }

        const payout = await speedRequest("/v1/payouts", "POST", payoutPayload);

        return res.status(200).json({
          success: true,
          payout_id: payout.id,
          sent: sats,
          remaining_balance: await getBalance(userKey)
        });
      } catch (sendError) {
        // Refund satoshis to the user if the Lightning broadcast failed
        await addBalance(userKey, sats);
        console.error("Payout broadcast failed, refunded user:", sendError);
        return res.status(500).json({
          success: false,
          error: sendError.message || "Failed to route payment across the Lightning Network."
        });
      }
    }

    return res.status(404).json({ success: false, error: `Invalid action '${action}' requested.` });
  } catch (err) {
    console.error("Wallet API Error:", err);
    return res.status(500).json({ 
      success: false, 
      error: err.message || "An unexpected internal server error occurred." 
    });
  }
};
