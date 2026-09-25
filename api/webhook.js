const { Telegraf } = require("telegraf");

const ADMIN_ID = 8960497898;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

const store = global._pheizuStore = global._pheizuStore || {
  balances: {},
  creditedPayments: {}
};

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
  if (req.method !== "POST") return res.status(200).send("Webhook active");

  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);

    const event = body?.event;
    const payment = body?.data;

    // Check for successful payment
    if (event === "payment.succeeded" || payment?.status === "paid" || payment?.status === "succeeded") {
      const paymentId = payment.id;
      const amount = Number(payment.amount || 0);
      const metadata = payment.metadata || {};

      // Determine recipient chat ID
      let targetChatId = metadata.telegram_user_id || ADMIN_ID;
      const type = metadata.type === "lightning_address" ? "Lightning Address" : "Lightning Invoice";

      const alreadyDone = await isPaymentCredited(paymentId);
      if (!alreadyDone) {
        await markPaymentCredited(paymentId);
        const newBal = await adjustUserBalance(targetChatId, amount);

        // Send Success Message in Telegram Chat
        if (bot && targetChatId) {
          await bot.telegram.sendMessage(
            targetChatId,
            `🎉 *Payment Received!*\n\n` +
            `⚡ *+${amount.toLocaleString()} sats* credited to your balance.\n` +
            `📬 *Method:* ${type}\n` +
            `💰 *Your New Balance:* *${newBal.toLocaleString()} sats*`,
            { parse_mode: "Markdown" }
          );
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    return res.status(200).json({ received: true });
  }
};
