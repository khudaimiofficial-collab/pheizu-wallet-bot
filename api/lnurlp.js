const DOMAIN = "pheizu-wallet-bot.vercel.app";
const ADMIN_ID = 8960497898;

function extractInvoice(obj) {
  if (!obj) return null;
  if (obj.payment_method_options?.lightning?.payment_request) return obj.payment_method_options.lightning.payment_request;
  if (obj.payment_method_details?.lightning?.payment_request) return obj.payment_method_details.lightning.payment_request;
  if (obj.payment_request) return obj.payment_request;
  if (obj.next_action?.lightning_display_details?.payment_request) return obj.next_action.lightning_display_details.payment_request;
  if (obj.next_action?.display_details?.payment_request) return obj.next_action.display_details.payment_request;

  let invoice = null;
  function scan(o) {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string") {
        const str = v.trim();
        if (/^(lnbc|lntb|lightning:)/i.test(str)) {
          if (!invoice) invoice = str;
        } else if ((k.toLowerCase().includes("url") || k === "link") && /^https?:\/\//i.test(str)) {
          if (!invoice) invoice = str;
        }
      } else if (typeof v === "object") {
        scan(v);
      }
    }
  }
  scan(obj);
  return invoice;
}

async function callSpeed(endpoint, method = "POST", body = null) {
  const key = process.env.SPEED_SECRET_KEY || global.DYNAMIC_SPEED_KEY;
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
  if (!res.ok) throw new Error(data.message || data.errors?.[0]?.message || `HTTP ${res.status}`);
  return data;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") return res.status(200).end();

  let rawUser = req.query.username;
  if (!rawUser) {
    const parts = req.url.split("?")[0].split("/").filter(Boolean);
    rawUser = parts[parts.length - 1];
  }

  const userHandle = String(rawUser || "").toLowerCase().replace(/[^a-z0-9_]/g, "");

  if (!userHandle) {
    return res.status(200).json({ status: "ERROR", reason: "Invalid username" });
  }

  // STEP 2: Generate Invoice for incoming payment
  if (req.query.callback || req.url.includes("/cb/")) {
    const msats = Number(req.query.amount);
    if (!msats || msats < 1000) {
      return res.status(200).json({ status: "ERROR", reason: "Minimum amount is 1 sat" });
    }
    const sats = Math.floor(msats / 1000);

    try {
      // Tags payment with telegram metadata for chat success notification
      const pmt = await callSpeed("payments", "POST", {
        amount: sats,
        currency: "SATS",
        target_currency: "SATS",
        payment_methods: ["lightning"],
        metadata: {
          telegram_username: userHandle,
          telegram_user_id: String(ADMIN_ID), // Delivers notification directly to your chat
          type: "lightning_address"
        }
      });

      const invoice = extractInvoice(pmt);
      if (!invoice) {
        return res.status(200).json({ status: "ERROR", reason: "Could not generate invoice" });
      }

      return res.status(200).json({
        pr: invoice,
        routes: []
      });
    } catch (err) {
      return res.status(200).json({ status: "ERROR", reason: err.message });
    }
  }

  // STEP 1: Metadata discovery
  const metadata = JSON.stringify([
    ["text/plain", `Pay to ${userHandle} on Pheizu Wallet`],
    ["text/identifier", `${userHandle}@${DOMAIN}`]
  ]);

  return res.status(200).json({
    tag: "payRequest",
    callback: `https://${DOMAIN}/api/lnurlp/cb/${userHandle}`,
    minSendable: 1000,
    maxSendable: 10000000000,
    metadata: metadata,
    commentAllowed: 0
  });
};
