const { Telegraf, Markup } = require("telegraf");

const ADMIN_ID = 8960497898; // Your Admin Telegram Chat ID
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
let DYNAMIC_SPEED_KEY = process.env.SPEED_SECRET_KEY || "";

// Fixed: Hardcoded fallback so the button NEVER crashes
const MINI_APP_URL = process.env.VERCEL_PROJECT_URL || "https://pheizu-wallet-bot.vercel.app";

let bot = null;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);
} else {
  console.error("CRITICAL: TELEGRAM_BOT_TOKEN is missing!");
}

// Universal deep search for Lightning invoices (lnbc...) or checkout URLs
function extractInvoice(obj) {
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

// Helper to call Speed API
async function callSpeed(endpoint, method = "POST", body = null, overrideKey = null) {
  const keyToUse = overrideKey || DYNAMIC_SPEED_KEY;
  if (!keyToUse) throw new Error("Speed API Key is not set. Admin must configure it using /setkey.");

  const auth = "Basic " + Buffer.from(keyToUse + ":").toString("base64");
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

if (bot) {
  // /start
  bot.start((ctx) => {
    const userId = ctx.from.id;
    const name = ctx.from.first_name || "User";

    let welcome = `⚡ *Welcome to Pheizu Wallet, ${name}!*\n\n`;

    if (userId === ADMIN_ID) {
      welcome +=
        `👑 *ADMIN CONSOLE ACTIVE*\n` +
        `• \`/setkey <speed_key>\` - Set Speed Secret Key\n` +
        `• \`/admin\` - View Wallet Status\n\n`;
    }

    welcome +=
      `*Commands:*\n` +
      `💰 /balance - Check balance\n` +
      `📥 /receive <sats> - Generate invoice\n` +
      `📤 /send <dest> <sats> - Send satoshis\n\n` +
      `Or launch the interactive Mini App below:`;

    ctx.reply(welcome, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.webApp("⚡ Open Pheizu Mini App", MINI_APP_URL)],
        [
          Markup.button.callback("💰 Balance", "cmd_balance"),
          Markup.button.callback("📥 Receive 100", "cmd_receive_100")
        ]
      ])
    });
  });

  // /setkey (ADMIN ONLY)
  bot.command("setkey", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
      return ctx.reply("⛔ *Unauthorized:* This command is restricted to the bot admin.", { parse_mode: "Markdown" });
    }

    const args = ctx.message.text.split(" ");
    const newKey = args[1]?.trim();

    if (!newKey || (!newKey.startsWith("sk_test_") && !newKey.startsWith("sk_live_"))) {
      return ctx.reply("⚠️ *Usage:* `/setkey sk_live_...` or `/setkey sk_test_...`", { parse_mode: "Markdown" });
    }

    ctx.reply("🔍 *Verifying key with Speed.app...*", { parse_mode: "Markdown" });

    try {
      await callSpeed("payments", "POST", {
        amount: 10,
        currency: "SATS",
        target_currency: "SATS",
        payment_methods: ["lightning"]
      }, newKey);

      DYNAMIC_SPEED_KEY = newKey;
      global.DYNAMIC_SPEED_KEY = newKey;

      ctx.reply(
        `✅ *Speed Secret Key Verified & Saved!*\n\n` +
        `🔑 *Active Key:* \`${newKey}\`\n` +
        `The wallet is ready to send, receive, and check balances.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      ctx.reply(`❌ *Verification Failed:* ${err.message}\nKey was not updated.`, { parse_mode: "Markdown" });
    }
  });

  // /admin (ADMIN ONLY)
  bot.command("admin", (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
      return ctx.reply("⛔ *Unauthorized:* Admin only.", { parse_mode: "Markdown" });
    }

    const keyStatus = DYNAMIC_SPEED_KEY
      ? `\`${DYNAMIC_SPEED_KEY.substring(0, 10)}...${DYNAMIC_SPEED_KEY.slice(-4)}\``
      : "❌ _Not Set (Use /setkey)_";

    ctx.reply(
      `👑 *Pheizu Admin Console*\n\n` +
      `👤 *Admin ID:* \`${ADMIN_ID}\`\n` +
      `🔑 *Active Speed Key:* ${keyStatus}\n` +
      `🌐 *Mini App URL:* ${MINI_APP_URL}\n\n` +
      `To update your Speed key, send: \`/setkey <your_key>\``,
      { parse_mode: "Markdown" }
    );
  });

  // /balance
  bot.command("balance", async (ctx) => {
    try {
      const data = await callSpeed("balances", "GET");
      
      let avail = 0;
      let pending = 0;

      const getSats = (target) => {
        if (!target) return 0;
        if (Array.isArray(target)) return target.find(b => (b.currency || "").toUpperCase() === "SATS")?.amount || 0;
        if (typeof target === "object") return target.SATS ?? target.sats ?? 0;
        return 0;
      };

      if (Array.isArray(data)) {
        avail = getSats(data);
      } else if (typeof data === "object") {
        avail = getSats(data.available);
        pending = getSats(data.pending);
      }

      let msg = `💰 *Pheizu Wallet Balance:*\n\n⚡ Available: *${Number(avail).toLocaleString()} sats*`;
      if (pending > 0) msg += `\n⏳ Pending: *${Number(pending).toLocaleString()} sats*`;

      ctx.reply(msg, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.webApp("⚡ Open Mini App", MINI_APP_URL)]])
      });
    } catch (err) {
      ctx.reply(`❌ ${err.message}`);
    }
  });

  bot.action("cmd_balance", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const data = await callSpeed("balances", "GET");
      const avail = data.available?.find?.((b) => b.currency === "SATS")?.amount || 0;
      ctx.reply(`💰 Balance: *${Number(avail).toLocaleString()} sats*`, { parse_mode: "Markdown" });
    } catch(e) {
      ctx.reply(`❌ Error checking balance`);
    }
  });

  // /receive <sats> (Fixed: Uses deep extractor so it NEVER returns undefined)
  bot.command("receive", async (ctx) => {
    const args = ctx.message.text.split(" ");
    const sats = parseInt(args[1]);

    if (!sats || sats <= 0) {
      return ctx.reply("⚠️ Usage: `/receive <amount>` (e.g. `/receive 100`)", { parse_mode: "Markdown" });
    }

    try {
      const pmt = await callSpeed("payments", "POST", {
        amount: sats,
        currency: "SATS",
        target_currency: "SATS",
        payment_methods: ["lightning"]
      });

      const invoice = extractInvoice(pmt);

      if (!invoice) {
        return ctx.reply(`⚠️ Invoice created (ID: \`${pmt.id}\`), but no raw bolt11 string was returned. Check your Speed dashboard.`, { parse_mode: "Markdown" });
      }

      ctx.reply(`⚡ *Invoice for ${sats} sats:*\n\n\`${invoice}\`\n\n_Tap to copy & pay with any Lightning wallet._`, { parse_mode: "Markdown" });
    } catch (err) {
      ctx.reply(`❌ Invoice creation failed: ${err.message}`);
    }
  });

  bot.action("cmd_receive_100", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const pmt = await callSpeed("payments", "POST", {
        amount: 100,
        currency: "SATS",
        target_currency: "SATS",
        payment_methods: ["lightning"]
      });
      const invoice = extractInvoice(pmt) || pmt.id;
      ctx.reply(`⚡ *Invoice (100 sats):*\n\n\`${invoice}\``, { parse_mode: "Markdown" });
    } catch (err) {
      ctx.reply(`❌ ${err.message}`);
    }
  });

  // /send <destination> <sats>
  bot.command("send", async (ctx) => {
    const args = ctx.message.text.split(" ");
    const dest = args[1];
    const sats = parseInt(args[2]);

    if (!dest || !sats || sats <= 0) {
      return ctx.reply("⚠️ Usage: `/send <address/invoice> <sats>`\nExample: `/send user@speed.app 50`", { parse_mode: "Markdown" });
    }

    try {
      const res = await callSpeed("send", "POST", {
        amount: sats,
        currency: "SATS",
        target_currency: "SATS",
        withdraw_method: "lightning",
        withdraw_request: dest
      });

      ctx.reply(`✅ *Sent ${sats} sats!*\n\n🎯 Dest: \`${dest}\`\n🆔 TX: \`${res.id || "OK"}\``, { parse_mode: "Markdown" });
    } catch (err) {
      ctx.reply(`❌ Send failed: ${err.message}`);
    }
  });
}

// Vercel Serverless Webhook Handler
module.exports = async (req, res) => {
  if (!bot) {
    return res.status(500).send("TELEGRAM_BOT_TOKEN is not configured.");
  }
  if (req.method === "POST") {
    try {
      let body = req.body;
      if (typeof body === "string") body = JSON.parse(body);
      if (body) await bot.handleUpdate(body);
      return res.status(200).send("OK");
    } catch (e) {
      console.error("Telegram update error:", e);
      return res.status(200).send("OK");
    }
  }
  return res.status(200).send("Pheizu Wallet Bot is active and running!");
};
