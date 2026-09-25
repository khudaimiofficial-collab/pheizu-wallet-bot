// api/webhook.js
const { 
  normalizeUserKey, 
  addBalance, 
  isPaymentProcessed, 
  markPaymentProcessed,
  getBalance
} = require('../lib/db');

module.exports = async function handler(req, res) {
  // Only accept POST requests from Speed
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    let event = req.body;
    if (typeof event === 'string') {
      try {
        event = JSON.parse(event);
      } catch (e) {
        return res.status(400).send("Invalid JSON payload");
      }
    }

    console.log(`[Speed Webhook Event Received]: ${event?.type}`);

    // Speed emits events like 'payment.succeeded' or 'payment.paid'
    const paymentObj = event?.data?.object;
    const isSuccess = 
      event?.type === "payment.succeeded" || 
      event?.type === "payment.paid" ||
      paymentObj?.status === "succeeded" || 
      paymentObj?.status === "paid";

    if (isSuccess && paymentObj) {
      const paymentId = paymentObj.id;
      const sats = Math.floor(Number(paymentObj.amount || 0));

      // Extract userKey from metadata attached during invoice creation
      const rawUser = paymentObj.metadata?.user_key || paymentObj.metadata?.user_id;
      const userKey = normalizeUserKey(rawUser);

      if (paymentId && userKey && sats > 0) {
        // Prevent crediting twice (if Mini App already polled it)
        const alreadyDone = await isPaymentProcessed(paymentId);

        if (!alreadyDone) {
          // addBalance automatically updates Firestore AND sends the Telegram message!
          await addBalance(userKey, sats);
          await markPaymentProcessed(paymentId);
          console.log(`✓ Credited ${sats} sats to ${userKey} via webhook!`);
        } else {
          console.log(`Payment ${paymentId} already credited. Skipping duplicate.`);
        }
      }
    }

    // Always acknowledge receipt to Speed
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    // Return 200 so Speed does not continuously retry broken requests
    return res.status(200).json({ received: true, error: err.message });
  }
};
