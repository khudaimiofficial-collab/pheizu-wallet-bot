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
      try {
        event = JSON.parse(event);
      } catch (e) {
        return res.status(400).send("Invalid JSON");
      }
    }

    const eventType = String(event?.type || "").toLowerCase();
    const paymentObj = event?.data?.object;

    // ONLY process 'payment.succeeded' to ignore duplicate charge events
    if (eventType !== "payment.succeeded" && eventType !== "payment.paid") {
      return res.status(200).json({ received: true, ignored: true, reason: `Ignored event: ${eventType}` });
    }

    if (paymentObj) {
      const paymentId = paymentObj.id;
      const sats = Math.floor(Number(paymentObj.amount || 0));
      const rawUser = paymentObj.metadata?.user_key || paymentObj.metadata?.user_id;
      const userKey = normalizeUserKey(rawUser);

      if (paymentId && userKey && sats > 0) {
        // Atomic claim: only ONE process can ever succeed
        const result = await claimPaymentAndCredit(paymentId, userKey, sats);

        if (!result.alreadyProcessed) {
          console.log(`✓ [Webhook] Credited ${sats} sats to ${userKey}. New Balance: ${result.newBalance}`);
          // Send Telegram message ONLY ONCE
          await notifyPaymentReceived(userKey, sats, result.newBalance);
        } else {
          console.log(`⚠️ [Webhook] Payment ${paymentId} was already claimed. Ignored duplicate.`);
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    return res.status(200).json({ received: true, error: err.message });
  }
};
