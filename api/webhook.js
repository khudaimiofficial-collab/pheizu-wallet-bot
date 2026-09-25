// api/webhook.js
const { 
  normalizeUserKey, 
  claimPaymentAndCredit,
  notifyPaymentReceived
} = require('../lib/db');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    let event = req.body;
    if (typeof event === 'string') {
      try { event = JSON.parse(event); } catch (e) {
        return res.status(400).send("Invalid JSON");
      }
    }

    const eventType = String(event?.type || "").toLowerCase();
    const paymentObj = event?.data?.object;

    // Catch any success event variants from Speed
    const isSuccess = 
      eventType.includes("succeeded") || 
      eventType.includes("paid") ||
      paymentObj?.status === "succeeded" ||
      paymentObj?.status === "paid";

    if (isSuccess && paymentObj) {
      const paymentId = paymentObj.id;
      const sats = Math.floor(Number(paymentObj.amount || 0));
      const rawUser = paymentObj.metadata?.user_key || paymentObj.metadata?.user_id;
      const userKey = normalizeUserKey(rawUser);

      if (paymentId && userKey && sats > 0) {
        const result = await claimPaymentAndCredit(paymentId, userKey, sats);

        if (!result.alreadyProcessed) {
          await notifyPaymentReceived(userKey, sats, result.newBalance);
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(200).json({ received: true, error: err.message });
  }
};
