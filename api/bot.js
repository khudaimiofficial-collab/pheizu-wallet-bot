const { Telegraf, Markup } = require("telegraf");

const ADMIN_ID = 8960497898;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
let DYNAMIC_SPEED_KEY = process.env.SPEED_SECRET_KEY || "";
const DOMAIN = "pheizu-wallet-bot.vercel.app";
const MINI_APP_URL = `https://${DOMAIN}`;

let bot = null;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);
} else {
  console.error("TELEGRAM_BOT_TOKEN is missing!");
}

async function callSpeed(endpoint, method = "POST", body = null, overrideKey = null) {
  const keyToUse = overrideKey || DYNAMIC_SPEED_KEY;
  if (!keyToUse) throw new Error("Speed API Key is missing.");

  const auth = "Basic " + Buffer.from(keyToUse + ":").toString("base64");
  const options = {
    method,
    headers: {
      "accept": "application/json",
      "authorization": auth,
      "content-type": "application/json",
      "speed-version": "2022-10-15"
    },
    body: body ? JSON.stringify(body) : null
  };

  const res = await fetch(`https://api.tryspeed.com/${endpoint}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

if (bot) {
  bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const name = ctx.from.first_name || "User";
    const username = ctx.from.username || `user${userId}`;
    const lnAddress = `${username.toLowerCase()}@${DOMAIN}`;

    try {
      await ctx.setChatMenuButton({
        type: "web_app",
        text: "⚡ Open Wallet",
        web_app: { url: MINI_APP_URL }
      });
    } catch (e) {}

    let welcome =
      `⚡ *Welcome to Pheizu Wallet, ${name}!*\n\n` +
      `📬 *Your Permanent Lightning Address:*\n` +
      `\`${lnAddress}\`\n\n` +
      `Tap the button below to launch your wallet:`;

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

  bot.command("setkey", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply("⛔ Admin only.");
    const key = ctx.message.text.split(" ")[1]?.trim();
    if (!key || (!key.startsWith("sk_test_") && !key.startsWith("sk_live_"))) {
      return ctx.reply("⚠️ Usage: `/setkey sk_live_...`", { parse_mode: "Markdown" });
    }

    try {
      await callSpeed("payments", "POST", {
        amount: 10,
        currency: "SATS",
        target_currency: "SATS",
        payment_methods: ["lightning"]
      }, key);

      DYNAMIC_SPEED_KEY = key;
      global.DYNAMIC_SPEED_KEY = key;
      ctx.reply("✅ *Speed Secret Key Verified & Saved!*", { parse_mode: "Markdown" });
    } catch (err) {
      ctx.reply(`❌ *Verification Failed:* ${err.message}`, { parse_mode: "Markdown" });
    }
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
