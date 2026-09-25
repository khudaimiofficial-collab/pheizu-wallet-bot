const DOMAIN = "pheizu-wallet-bot.vercel.app";
let DYNAMIC_KEY = global.DYNAMIC_SPEED_KEY || process.env.SPEED_SECRET_KEY || "";

async function callSpeed(endpoint, method = "POST", body = null) {
  const key = DYNAMIC_KEY || global.DYNAMIC_SPEED_KEY || process.env.SPEED_SECRET_KEY;
  if (!key) throw new Error("Speed API Key is missing.");

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
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

function extractInvoice(obj) {
  let invoice = null;
  function scan(o) {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string") {
        const str = v.trim();
        if (/^(lnbc|lntb|lightning:)/i.test(str)) { if (!invoice) invoice = str; }
      } else if (typeof v === "object") scan(o);
    }
  }
  scan(obj);
  return invoice;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { username, callback, amount } = req.query;
  const userHandle = (username || "").toLowerCase().replace(/[^a-z0-9_]/g, "");

  if (!userHandle) return res.status(400).json({ status: "ERROR", reason: "Invalid username" });

  if (callback) {
    const msats = Number(amount);
    if (!msats || msats < 1000) return res.status(400).json({ status: "ERROR", reason: "Min amount 1 sat" });
    const sats = Math.floor(msats / 1000);

    try {
      const pmt = await callSpeed("payments", "POST", {
        amount: sats,
        currency: "SATS",
        target_currency: "SATS",
        payment_methods: ["lightning"],
        metadata: { telegram_username: userHandle }
      });

      const invoice = extractInvoice(pmt) || pmt.payment_request;
      return res.status(200).json({ status: "OK", pr: invoice, routes: [] });
    } catch (err) {
      return res.status(500).json({ status: "ERROR", reason: err.message });
    }
  }

  return res.status(200).json({
    status: "OK",
    tag: "payRequest",
    commentAllowed: 255,
    callback: `https://${DOMAIN}/api/lnurlp/cb/${userHandle}`,
    minSendable: 1000,
    maxSendable: 10000000000,
    metadata: JSON.stringify([["text/plain", `Pay to ${userHandle} on Pheizu Wallet`], ["text/identifier", `${userHandle}@${DOMAIN}`]])
  });
};
