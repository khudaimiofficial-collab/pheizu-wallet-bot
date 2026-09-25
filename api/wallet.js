const ADMIN_ID = 8960497898;
let DYNAMIC_KEY = global.DYNAMIC_SPEED_KEY || process.env.SPEED_SECRET_KEY || "";

const store = global._pheizuStore = global._pheizuStore || {
  balances: {},
  creditedPayments: {}
};

async function getUserBalance(userId) {
  const key = `user_bal_${userId}`;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (redisUrl && redisToken) {
    try {
      const res = await fetch(`${redisUrl}/get/${key}`, { headers: { Authorization: `Bearer ${redisToken}` } });
      const d = await res.json();
      return Number(d.result || 0);
    } catch (e) {}
  }
  return Number(store.balances[userId] || 0);
}

async function adjustUserBalance(userId, delta) {
  const key = `user_bal_${userId}`;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (redisUrl && redisToken) {
    try {
      const res = await fetch(`${redisUrl}/incrby/${key}/${delta}`, { headers: { Authorization: `Bearer ${redisToken}` } });
      const d = await res.json();
      return Number(d.result || 0);
    } catch (e) {}
  }
  store.balances[userId] = Math.max(0, Number(store.balances[userId] || 0) + delta);
  return store.balances[userId];
}

async function isPaymentCredited(paymentId) {
  const key = `credited_pmt_${paymentId}`;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (redisUrl && redisToken) {
    try {
      const res = await fetch(`${redisUrl}/get/${key}`, { headers: { Authorization: `Bearer ${redisToken}` } });
      const d = await res.json();
      return Boolean(d.result);
    } catch (e) {}
  }
  return Boolean(store.creditedPayments[paymentId]);
}

async function markPaymentCredited(paymentId) {
  const key = `credited_pmt_${paymentId}`;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (redisUrl && redisToken) {
    try {
      await fetch(`${redisUrl}/set/${key}/1`, { headers: { Authorization: `Bearer ${redisToken}` } });
    } catch (e) {}
  }
  store.creditedPayments[paymentId] = true;
}

// Deep search for invoice
function findInvoice(obj) {
  if (!obj) return null;
  // 1. Direct path checks
  if (obj.payment_method_options?.lightning?.payment_request) return obj.payment_method_options.lightning.payment_request;
  if (obj.payment_method_details?.lightning?.payment_request) return obj.payment_method_details.lightning.payment_request;
  if (obj.payment_request) return obj.payment_request;
  if (obj.next_action?.lightning_display_details?.payment_request) return obj.next_action.lightning_display_details.payment_request;
  if (obj.next_action?.display_details?.payment_request) return obj.next_action.display_details.payment_request;

  // 2. Recursive scan for any lnbc/lntb string
  let found = null;
  function scan(o) {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string") {
        const s = v.trim();
        if (/^(lnbc|lntb|lightning:)/i.test(s)) {
          if (!found) found = s;
        } else if ((k.toLowerCase().includes("url") || k === "link") && /^https?:\/\//i.test(s)) {
          if (!found) found = s;
        }
      } else if (typeof v === "object") {
        scan(v);
      }
    }
  }
  scan(obj);
  return found || obj.hosted_url || obj.url || obj.id;
}

async function callSpeed(endpoint, method = "POST", body = null) {
  const key = DYNAMIC_KEY || global.DYNAMIC_SPEED_KEY || process.env.SPEED_SECRET_KEY;
  if (!key) throw new Error("Speed API Key is missing. Please set SPEED_SECRET_KEY in Vercel.");

  const auth = "Basic " + Buffer.from(key + ":").toString("base64");
  const res = await fetch(`https://api.tryspeed.com/${endpoint}`, {
    method,
    headers: {
      "accept": "application/json",
      "authorization": auth,
      "content-type": "application/json",
      "speed-version": "2022-10-15"
    },
    body: body ? JSON.stringify(body) : null
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.errors?.[0]?.message || `HTTP ${res.status}`);
  return data;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { action, user_id, payment_id } = req.query;

  try {
    // 1. Balance
    if (action === "balance") {
      const uid = String(user_id || "guest");
      const balance = await getUserBalance(uid);
      return res.status(200).json({ success: true, user_id: uid, balance });
    }

    // 2. Create Payment Invoice
    if (action === "create-payment") {
      const { amount, user_id } = req.body;
      const uid = String(user_id || "guest");

      const payment = await callSpeed("payments", "POST", {
        amount: Number(amount),
        currency: "SATS",
        target_currency: "SATS",
        payment_methods: ["lightning"],
        metadata: { telegram_user_id: uid }
      });

      const invoiceString = findInvoice(payment);

      return res.status(200).json({
        success: true,
        id: payment.id,
        invoice: invoiceString,
        raw: payment
      });
    }

    // 3. Check Payment Status
    if (action === "check-status") {
      if (!payment_id) return res.status(400).json({ success: false, error: "Missing payment_id" });

      const uid = String(user_id || "guest");
      const payment = await callSpeed(`payments/${payment_id}`, "GET");
      const st = (payment.status || "").toLowerCase();
      const isPaid = st === "succeeded" || st === "paid";

      let creditedNow = false;
      let balance = await getUserBalance(uid);

      if (isPaid) {
        const alreadyCredited = await isPaymentCredited(payment_id);
        if (!alreadyCredited) {
          await markPaymentCredited(payment_id);
          const sats = Number(payment.amount || 0);
          balance = await adjustUserBalance(uid, sats);
          creditedNow = true;
        }
      }

      return res.status(200).json({
        success: true,
        id: payment.id,
        status: payment.status,
        is_paid: isPaid,
        credited_now: creditedNow,
        balance
      });
    }

    // 4. Send Sats
    if (action === "send") {
      const { amount, destination, user_id } = req.body;
      const uid = String(user_id || "guest");
      const sats = Number(amount);

      const currentBalance = await getUserBalance(uid);
      if (currentBalance < sats) {
        return res.status(400).json({
          success: false,
          error: `Insufficient balance (${currentBalance} sats available).`
        });
      }

      await adjustUserBalance(uid, -sats);

      try {
        const result = await callSpeed("send", "POST", {
          amount: sats,
          currency: "SATS",
          target_currency: "SATS",
          withdraw_method: "lightning",
          withdraw_request: destination,
          note: `Mini App send by ${uid}`
        });

        const updatedBalance = await getUserBalance(uid);
        return res.status(200).json({ success: true, result, balance: updatedBalance });
      } catch (sendErr) {
        await adjustUserBalance(uid, sats);
        throw sendErr;
      }
    }

    return res.status(400).json({ success: false, error: "Invalid action" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
