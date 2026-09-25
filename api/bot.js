const { Telegraf, Markup } = require("telegraf");

const ADMIN_ID = 8960497898;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
let DYNAMIC_SPEED_KEY = process.env.SPEED_SECRET_KEY || "";
const DOMAIN = "pheizu-wallet-bot.vercel.app";
const MINI_APP_URL = `https://${DOMAIN}`;

let bot = null;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);
}

// Deep search for invoice
function findInvoice(obj) {
  if (!obj) return null;
  if (obj.payment_method_options?.lightning?.payment_request) return obj.payment_method_options.lightning.payment_request;
  if (obj.payment_method_details?.lightning?.payment_request) return obj.payment_method_details.lightning.payment_request;
  if (obj.payment_request) return obj.payment_request;
  if (obj.next_action?.lightning_display_details?.payment_request) return obj.next_action.lightning_display_details.payment_request;

  let found = null;
  function scan(o) {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string") {
        const s = v.trim();
        if (/^(lnbc|lntb|lightning:)/i.test(s)) { if (!found) found = s; }
      } else if (typeof v === "object") scan(v);
    }
  }
  scan(obj);
  return found || obj.hosted_url || obj.url;
}

async function callSpeed(endpoint, method = "POST", body = null) {
  const key = DYNAMIC_SPEED_KEY || global.DYNAMIC_SPEED_KEY || process.env.SPEED_SECRET_KEY;
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

if (bot) {
  // /start (Now fetches and displays live balance directly)
  bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const name = ctx.from.first_name || "User";
    const username = ctx.from.username || `user${userId}`;
    const lnAddress = `${username.toLowerCase()}@${DOMAIN}`;

    // Fetch live balance from Speed
    let liveBal = 0;
    try {
      const data = await callSpeed("balances", "GET");
      const getSats = (target) => {
        if (!target) return 0;
        if (Array.isArray(target)) return target.find(b => (b.currency || "").toUpperCase() === "SATS")?.amount || 0;
        if (typeof target === "object") return target.SATS ?? target.sats ?? 0;
        if (typeof target === "number") return target;
        return 0;
      };
      let avail = Array.isArray(data) ? getSats(data) : getSats(data.available);
      let pending = Array.isArray(data) ? 0 : getSats(data.pending);
      liveBal = avail + pending;
    } catch (e) {}

    try {
      await ctx.setChatMenuButton({
        type: "web_app",
        text: "⚡ Open Wallet",
        web_app: { url: MINI_APP_URL }
      });
    } catch (e) {}

    let welcome =
      `⚡ *Welcome to Pheizu Wallet, ${name}!*\n\n` +
      `💰 *Available Balance:* \`${Number(liveBal).toLocaleString()} sats\`\n` +
      `📬 *Your Lightning Address:*\n\`${lnAddress}\`\n\n` +
      `Tap below to launch your wallet:`;

    if (userId === ADMIN_ID) {
      welcome += `\n\n👑 *Admin:* \`/setkey <key>\` to update Speed key.`;
    }

    ctx.reply(welcome, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.webApp("⚡ Launch Pheizu Wallet", MINI_APP_URL)]
      ])
    });
  });

  bot.command("balance", async (ctx) => {
    try {
      const data = await callSpeed("balances", "GET");
      const getSats = (target) => {
        if (!target) return 0;
        if (Array.isArray(target)) return target.find(b => (b.currency || "").toUpperCase() === "SATS")?.amount || 0;
        if (typeof target === "object") return target.SATS ?? target.sats ?? 0;
        if (typeof target === "number") return target;
        return 0;
      };
      let avail = Array.isArray(data) ? getSats(data) : getSats(data.available);
      let pending = Array.isArray(data) ? 0 : getSats(data.pending);
      let total = avail + pending;

      ctx.reply(`💰 *Pheizu Wallet Balance:*\n\n⚡ Available: *${Number(total).toLocaleString()} sats*`, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.webApp("⚡ Open Mini App", MINI_APP_URL)]])
      });
    } catch (e) {
      ctx.reply(`❌ Could not fetch balance`);
    }
  });

  bot.command("receive", async (ctx) => {
    const sats = parseInt(ctx.message.text.split(" ")[1]);
    if (!sats || sats <= 0) return ctx.reply("⚠️ Usage: `/receive 100`");

    try {
      const pmt = await callSpeed("payments", "POST", {
        amount: sats,
        currency: "SATS",
        target_currency: "SATS",
        payment_methods: ["lightning"]
      });

      const invoice = findInvoice(pmt);
      if (!invoice) throw new Error("Could not get invoice.");

      ctx.reply(`⚡ *Invoice for ${sats} sats:*\n\n\`${invoice}\`\n\n_Tap to copy & pay._`, { parse_mode: "Markdown" });
    } catch (err) {
      ctx.reply(`❌ ${err.message}`);
    }
  });

  bot.command("setkey", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply("⛔ Admin only.");
    const key = ctx.message.text.split(" ")[1]?.trim();
    if (!key) return ctx.reply("Usage: /setkey sk_...");
    DYNAMIC_SPEED_KEY = key;
    global.DYNAMIC_SPEED_KEY = key;
    ctx.reply("✅ Speed API Key updated!");
  });

  bot.on("message", (ctx) => {
    ctx.reply(
      "⚡ Open your wallet using the button below:",
      Markup.inlineKeyboard([[Markup.button.webApp("⚡ Open Wallet", MINI_APP_URL)]])
    );
  });
}

module.exports = async (req, res) => {
  if (!bot) return res.status(500).send("BOT_TOKEN missing.");
  if (req.method === "POST") {
    try {
      let body = req.body;
      if (typeof body === "string") body = JSON.parse(body);
      if (body) await bot.handleUpdate(body);
      return res.status(200).send("OK");
    } catch (e) {
      return res.status(200).send("OK");
    }
  }
  return res.status(200).send("Pheizu Wallet Bot is running!");
};
