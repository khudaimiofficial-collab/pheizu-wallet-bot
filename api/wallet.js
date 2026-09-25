const SPEED_KEY = process.env.SPEED_SECRET_KEY;

async function callSpeed(endpoint, method = "POST", body = null) {
  const auth = "Basic " + Buffer.from(SPEED_KEY + ":").toString("base64");
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

  const { action } = req.query;

  try {
    // 1. Get Balance
    if (action === "balance") {
      const data = await callSpeed("balances", "GET");
      return res.status(200).json(data);
    }

    // 2. Create Payment Invoice
    if (action === "create-payment") {
      const { amount } = req.body;
      const payment = await callSpeed("payments", "POST", {
        amount: Number(amount),
        currency: "SATS",
        target_currency: "SATS",
        payment_methods: ["lightning"]
      });
      return res.status(200).json(payment);
    }

    // 3. Instant Send
    if (action === "send") {
      const { amount, destination } = req.body;
      const result = await callSpeed("send", "POST", {
        amount: Number(amount),
        currency: "SATS",
        target_currency: "SATS",
        withdraw_method: "lightning",
        withdraw_request: destination,
        note: "Sent from Pheizu Mini App"
      });
      return res.status(200).json(result);
    }

    return res.status(400).json({ error: "Invalid action" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
