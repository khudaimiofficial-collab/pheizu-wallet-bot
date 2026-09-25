// api/lnurlp.js
const { 
  normalizeUserKey, 
  savePendingDeposit 
} = require('../lib/db');

const DOMAIN = process.env.DOMAIN || "pheizu-wallet-bot.vercel.app";
const SPEED_BASE_URL = "https://api.tryspeed.com";

function extractInvoice(data) {
  let invoice = "";
  function scan(obj) {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") {
        const str = v.trim();
        if (/^(lnbc|lntb|lightning:)/i.test(str)) {
          if (!invoice) invoice = str;
        }
      } else if (typeof v === "object") {
        scan(v);
      }
    }
  }
  scan(data);
  return invoice;
}

async function speedRequest(endpoint, method = "GET", body = null) {
  const rawKey = (process.env.SPEED_SECRET_KEY || "").trim().replace(/^["']|["']$/g, "");
  const authHeader = "Basic " + Buffer.from(rawKey + ":").toString("base64");

  const headers = {
    "accept": "application/json",
    "authorization": authHeader,
    "content-type": "application/json",
    "speed-version": "2022-10-15"
  };

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${SPEED_BASE_URL}/${endpoint.replace(/^\//, '')}`, options);
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch (e) {}

  if (!res.ok) {
    throw new Error(json?.message || json?.errors?.[0]?.message || text);
  }
  return json;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { username, amount, callback } = req.query;
    if (!username) {
      return res.status(400).json({ status: "ERROR", reason: "Username required." });
    }

    const userKey = normalizeUserKey(username);

    // STEP 2: CALLBACK (Sender entered amount, creating invoice)
    if (callback === "1" || amount) {
      const msats = Number(amount);
      const sats = Math.floor(msats / 1000);

      if (!sats || sats < 1) {
        return res.status(400).json({ status: "ERROR", reason: "Amount must be at least 1 satoshi." });
      }

      const payment = await speedRequest("payments", "POST", {
        amount: sats,
        currency: "SATS",
        target_currency: "SATS",
        payment_methods: ["lightning"],
        description: `⚡ Satoshis for ${userKey}@${DOMAIN}`,
        metadata: {
          user_key: userKey,
          source: "lightning_address"
        }
      });

      const bolt11 = extractInvoice(payment);
      if (!bolt11) {
        return res.status(500).json({ status: "ERROR", reason: "Failed to generate Lightning invoice from Speed." });
      }

      // Save pending deposit in Firestore so it can be settled and notified
      await savePendingDeposit(payment.id, userKey, sats);

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

    // STEP 1: METADATA
    const metadata = JSON.stringify([
      ["text/plain", `Pay to ${userKey}@${DOMAIN}`],
      ["text/identifier", `${userKey}@${DOMAIN}`]
    ]);

    return res.status(200).json({
      status: "OK",
      tag: "payRequest",
      commentAllowed: 0,
      callback: `https://${DOMAIN}/api/lnurlp?username=${encodeURIComponent(userKey)}&callback=1`,
      minSendable: 1000,
      maxSendable: 100000000000,
      metadata: metadata
    });

  } catch (error) {
    return res.status(500).json({ status: "ERROR", reason: error.message });
  }
};
