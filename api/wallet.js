const ADMIN_ID = 8960497898;
let DYNAMIC_KEY = global.DYNAMIC_SPEED_KEY || process.env.SPEED_SECRET_KEY || "";

// In-Memory & Redis/KV Database Helper for Per-User Balances
const memoryDB = global._memDB = global._memDB || { balances: {}, payments: {} };

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
  return Number(memoryDB.balances[userId] || 0);
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
  memoryDB.balances[userId] = Math.max(0, Number(memoryDB.balances[userId] || 0) + delta);
  return memoryDB.balances[userId];
}

async function callSpeed(endpoint, method = "POST", body = null, overrideKey = null) {
  const key = overrideKey || DYNAMIC_KEY || global.DYNAMIC_SPEED_KEY;
  if (!key) throw new Error("Speed API Key is not configured.");

  const auth = "Basic " + Buffer.from(key + ":").toString("base64");
  const options = {
    method,
    headers: {
      "accept": "application/json",
      "authorization": auth,
      "content-type": "application/json",
      "speed-version": "2022-10-15"
    }
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`https://api.tryspeed.com/${endpoint}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.errors?.[0]?.message || `HTTP ${res.status}`);
  }
  return data;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { action, user_id, payment_id } = req.query;

  try {
    // 1. Per-User Balance
    if (action === "balance") {
      const uid = String(user_id || "guest");
      const balance = await getUserBalance(uid);
      return res.status(200).json({ user_id: uid, balance });
    }

    // 2. Create Payment (Linked to this specific user)
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

      // Save pending payment record to verify credit
      memoryDB.payments[payment.id] = {
        userId: uid,
        amount: Number(amount),
        credited: false
      };

      return res.status(200).json(payment);
    }

    // 3. Check Payment Status & Auto-Credit User
    if (action === "check-status") {
      if (!payment_id) return res.status(400).json({ error: "Missing payment_id" });

      const payment = await callSpeed(`payments/${payment_id}`, "GET");
      const st = (payment.status || "").toLowerCase();
      const isPaid = st === "succeeded" || st === "paid";

      let creditedNow = false;
      let newBalance = 0;

      if (isPaid) {
        const record = memoryDB.payments[payment_id];
        const uid = String(record?.userId || user_id || "guest");
        const amount = Number(record?.amount || payment.amount || 0);

        if (record && !record.credited) {
          record.credited = true;
          newBalance = await adjustUserBalance(uid, amount);
          creditedNow = true;
        } else {
          newBalance = await getUserBalance(uid);
        }
      }

      return res.status(200).json({
        id: payment.id,
        status: payment.status,
        is_paid: isPaid,
        credited_now: creditedNow,
        new_balance: newBalance
      });
    }

    // 4. Send (Deducts from user's personal balance only)
    if (action === "send") {
      const { amount, destination, user_id } = req.body;
      const uid = String(user_id || "guest");
      const sats = Number(amount);

      const currentBalance = await getUserBalance(uid);
      if (currentBalance < sats) {
        return res.status(400).json({
          error: `Insufficient balance. You have ${currentBalance} sats, but tried to send ${sats} sats.`
        });
      }

      // Deduct first (prevent double spending)
      await adjustUserBalance(uid, -sats);

      try {
        const result = await callSpeed("send", "POST", {
          amount: sats,
          currency: "SATS",
          target_currency: "SATS",
          withdraw_method: "lightning",
          withdraw_request: destination,
          note: `Pheizu Mini App send by user ${uid}`
        });

        const updatedBalance = await getUserBalance(uid);
        return res.status(200).json({ success: true, result, new_balance: updatedBalance });
      } catch (sendErr) {
        // Refund if send fails
        await adjustUserBalance(uid, sats);
        throw sendErr;
      }
    }

    // ADMIN ONLY: Master Speed balance
    if (action === "admin-master-balance") {
      if (Number(user_id) !== ADMIN_ID) return res.status(403).json({ error: "Unauthorized" });
      const data = await callSpeed("balances", "GET");
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: "Invalid action" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
