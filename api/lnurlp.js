// api/lnurlp.js
const { 
  normalizeUserKey, 
  addBalance, 
  isPaymentProcessed, 
  markPaymentProcessed 
} = require('../lib/db');

const DOMAIN = process.env.DOMAIN || "pheizu-wallet-bot.vercel.app";
const SPEED_SECRET_KEY = process.env.SPEED_SECRET_KEY || "";
const SPEED_BASE_URL = "https://api.tryspeed.com";
const BOT_TOKEN = process.env.BOT_TOKEN || "";

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

// Optional: Send Telegram notification to user if numeric ID is stored or determinable
async function sendTelegramNotification(userKey, amountSats) {
  if (!BOT_TOKEN) return;
  // If userKey starts with "user", we can extract the Telegram chat ID directly
  let chatId = null;
  if (/^user\d+$/i.test(userKey)) {
    chatId = userKey.replace(/^user/i, "");
  }

  if (chatId) {
    try {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `⚡ *Payment Received!*\n\nYou just received *+${amountSats.toLocaleString()} sats* via your Lightning Address!\nYour balance has been updated.`,
          parse_mode: 'Markdown'
        })
      });
    } catch (e) {
      console.error("Failed to send Telegram notification:", e.message);
    }
  }
}

module.exports = async function handler(req, res) {
  // Set CORS headers for any external lightning wallet (Wallet of Satoshi, Strike, CashApp, etc.)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { username, amount, callback } = req.query;

    if (!username) {
      return res.status(400).json({ status: "ERROR", reason: "Username is required." });
    }

    const userKey = normalizeUserKey(username);

    // =========================================================================
    // STEP 2: CALLBACK (Sender entered an amount, generating Lightning Invoice)
    // =========================================================================
    if (callback === "1" || amount) {
      const msats = Number(amount);
      if (!msats || isNaN(msats) || msats <= 0) {
        return res.status(400).json({ status: "ERROR", reason: "Invalid amount in millisatoshis." });
      }

      // 1 sat = 1,000 millisats
      const sats = Math.floor(msats / 1000);
      if (sats < 1) {
        return res.status(400).json({ status: "ERROR", reason: "Amount must be at least 1 satoshi (1,000 msats)." });
      }

      // Generate invoice via Speed
      const charge = await speedRequest("/v1/charges", "POST", {
        amount: sats,
        currency: "SATS",
        description: `⚡ Satoshis for ${userKey}@${DOMAIN}`,
        metadata: {
          user_key: userKey,
          source: "lnurlp"
        }
      });

      const bolt11 = charge?.lightning_payment_request || charge?.payment_request || charge?.invoice;
      if (!bolt11) {
        return res.status(500).json({ status: "ERROR", reason: "Failed to generate invoice from provider." });
      }

      // Background listener: Poll for payment completion to credit user ledger
      // This ensures the satoshis are credited as soon as the sender pays the invoice
      (async () => {
        let attempts = 0;
        const maxAttempts = 60; // Check for up to 3 minutes
        const interval = setInterval(async () => {
          attempts++;
          if (attempts > maxAttempts) {
            clearInterval(interval);
            return;
          }

          try {
            const check = await speedRequest(`/v1/charges/${charge.id}`, "GET");
            if (check.status === "paid" || check.status === "succeeded") {
              clearInterval(interval);
              const alreadyDone = await isPaymentProcessed(charge.id);
              if (!alreadyDone) {
                await addBalance(userKey, sats);
                await markPaymentProcessed(charge.id);
                await sendTelegramNotification(userKey, sats);
              }
            }
          } catch (err) {
            // Silently continue polling
          }
        }, 3000);
      })();

      // LNURL-pay callback specification response
      return res.status(200).json({
        pr: bolt11,
        routes: [],
        status: "OK",
        successAction: {
          tag: "message",
          message: `⚡ Payment sent to ${userKey}@${DOMAIN}!`
        }
      });
    }

    // =========================================================================
    // STEP 1: INITIAL LNURLP METADATA RESPONSE (LUD-06 / LUD-16)
    // =========================================================================
    const metadata = JSON.stringify([
      ["text/plain", `Pay to ${userKey}@${DOMAIN}`],
      ["text/identifier", `${userKey}@${DOMAIN}`]
    ]);

    return res.status(200).json({
      status: "OK",
      tag: "payRequest",
      commentAllowed: 0,
      callback: `https://${DOMAIN}/api/lnurlp?username=${encodeURIComponent(userKey)}&callback=1`,
      minSendable: 1000,          // 1 satoshi minimum (in millisatoshis)
      maxSendable: 100000000000,  // 100,000,000 sats maximum (in millisatoshis)
      metadata: metadata
    });

  } catch (error) {
    console.error("LNURL-pay Error:", error);
    return res.status(500).json({
      status: "ERROR",
      reason: error.message || "Internal server error while resolving LNURL."
    });
  }
};
