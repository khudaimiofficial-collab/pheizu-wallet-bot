const { Telegraf } = require("telegraf");

const ADMIN_ID = 8960497898;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

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

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("Webhook endpoint is active!");

  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);

    console.log("INCOMING SPEED WEBHOOK:", JSON.stringify(body));

    // Support both Speed/Stripe formats (body.type or body.event)
    const eventType = String(body?.type || body?.event || "").toLowerCase();
    
    // Support data.object or data
    const payment = body?.data?.object || body?.data || body;
    const paymentStatus = String(payment?.status || "").toLowerCase();

    const isPaid = 
      eventType.includes("payment.succeeded") ||
      eventType.includes("paid") ||
      paymentStatus === "paid" ||
      paymentStatus === "succeeded";

    if (isPaid) {
      const paymentId = payment.id;
      const amount = Number(payment.amount || 0);
      const metadata = payment.metadata || {};

      // Identify the Telegram user
      let targetChatId = metadata.telegram_user_id || ADMIN_ID;
      const type = metadata.type === "lightning_address" ? "Lightning Address" : "Invoice";

      const alreadyCredited = await isPaymentCredited(paymentId);
      if (!alreadyCredited) {
        await markPaymentCredited(paymentId);
        const newBal = await adjustUserBalance(targetChatId, amount);

        // Send instant notification to Telegram Chat
        if (bot && targetChatId) {
          try {
            await bot.telegram.sendMessage(
              targetChatId,
              `🎉 <b>Payment Received!</b>\n\n` +
              `⚡ <b>+${amount.toLocaleString()} sats</b> credited to your balance.\n` +
              `📬 <b>Method:</b> ${type}\n` +
              `💰 <b>Your New Balance:</b> <b>${newBal.toLocaleString()} sats</b>`,
              { parse_mode: "HTML" }
            );
          } catch (tgErr) {
            console.error("Failed to send Telegram message:", tgErr.message);
          }
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    return res.status(200).json({ received: true });
  }
};
