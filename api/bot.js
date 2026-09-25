const { Telegraf, Markup } = require("telegraf");

const ADMIN_ID = 8960497898;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
let DYNAMIC_SPEED_KEY = process.env.SPEED_SECRET_KEY || "";
const MINI_APP_URL = process.env.VERCEL_PROJECT_URL || "https://pheizu-wallet-bot.vercel.app";

let bot = null;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);
} else {
  console.error("CRITICAL: TELEGRAM_BOT_TOKEN is missing!");
}

// User Ledger Helpers
const memoryDB = global._memDB = global._memDB || { balances: {}, payments: {} };

async function getUserBalance(userId) {
  const key = `user_bal_${userId}`;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (redisUrl && redisToken) {
    try {
      const res = await fetch(`${redisUrl}/get/${key}`, { headers: { Authorization: `Bearer ${redisToken}` } });
      const d = await res.json();
      return Number(d.result || 0);
    } catch (e) {}
  }
  return Number(memoryDB.balances[userId] || 0);
}

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
  memoryDB.balances[userId] = Math.max(0, Number(memoryDB.balances[userId] || 0) + delta);
  return memoryDB.balances[userId];
}

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
  bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const name = ctx.from.first_name || "User";
    const userBal = await getUserBalance(userId);

    let welcome = `⚡ *Welcome to Pheizu Wallet, ${name}!*\n\n`;

    if (userId === ADMIN_ID) {
      welcome +=
        `👑 *ADMIN CONSOLE ACTIVE*\n` +
        `• \`/setkey <speed_key>\` - Set Speed Key\n` +
        `• \`/masterbalance\` - View master Speed account\n\n`;
    }

    welcome +=
      `💰 *Your Personal Balance:* \`${userBal.toLocaleString()} sats\`\n\n` +
      `*Commands:*\n` +
      `💰 /balance - View your personal balance\n` +
      `📥 /receive <sats> - Deposit satoshis\n` +
      `📤 /send <dest> <sats> - Send from your balance\n\n` +
      `Or open the full interactive Mini App below:`;

    ctx.reply(welcome, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.webApp("⚡ Open Pheizu Mini App", MINI_APP_URL)],
        [
          Markup.button.callback("💰 My Balance", "cmd_balance"),
          Markup.button.callback("📥 Deposit 100", "cmd_receive_100")
        ]
      ])
    });
  });

  // /balance (SHOWS ONLY THIS USER'S BALANCE)
  bot.command("balance", async (ctx) => {
    const userId = ctx.from.id;
    const userBal = await getUserBalance(userId);
    ctx.reply(
      `💰 *Your Personal Balance:*\n\n⚡ Available: *${userBal.toLocaleString()} sats*`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([[Markup.button.webApp("⚡ Open Mini App", MINI_APP_URL)]])
      }
    );
  });

  bot.action("cmd_balance", async (ctx) => {
    await ctx.answerCbQuery();
    const userBal = await getUserBalance(ctx.from.id);
    ctx.reply(`💰 Your Balance: *${userBal.toLocaleString()} sats*`, { parse_mode: "Markdown" });
  });

  // /masterbalance (ADMIN ONLY - shows Master Speed API account balance)
  bot.command("masterbalance", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply("⛔ Admin only.");
    try {
      const data = await callSpeed("balances", "GET");
      const avail = data.available?.find?.((b) => b.currency === "SATS")?.amount || 0;
      ctx.reply(`👑 *Master Speed Account Balance:* ${Number(avail).toLocaleString()} sats`, { parse_mode: "Markdown" });
    } catch (e) {
      ctx.reply(`❌ ${e.message}`);
    }
  });

  // /setkey (ADMIN ONLY)
  bot.command("setkey", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply("⛔ Admin only.");
    const args = ctx.message.text.split(" ");
    const newKey = args[1]?.trim();
    if (!newKey || (!newKey.startsWith("sk_test_") && !newKey.startsWith("sk_live_"))) {
      return ctx.reply("⚠️ Usage: `/setkey sk_live_...`", { parse_mode: "Markdown" });
    }

    ctx.reply("🔍 Verifying key with Speed...", { parse_mode: "Markdown" });
    try {
      await callSpeed("payments", "POST", {
        amount: 10,
        currency: "SATS",
        target_currency: "SATS",
        payment_methods: ["lightning"]
      }, newKey);

      DYNAMIC_SPEED_KEY = newKey;
      global.DYNAMIC_SPEED_KEY = newKey;
      ctx.reply(`✅ *Speed Secret Key Verified & Saved!*`, { parse_mode: "Markdown" });
    } catch (err) {
      ctx.reply(`❌ *Verification Failed:* ${err.message}`, { parse_mode: "Markdown" });
    }
  });

  // /receive <sats> (Auto-credits user when paid)
  bot.command("receive", async (ctx) => {
    const userId = ctx.from.id;
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
        payment_methods: ["lightning"],
        metadata: { telegram_user_id: String(userId) }
      });

      const invoice = extractInvoice(pmt);
      if (!invoice) return ctx.reply("⚠️ Could not generate invoice.");

      memoryDB.payments[pmt.id] = { userId: String(userId), amount: sats, credited: false };

      ctx.reply(
        `⚡ *Deposit Invoice for ${sats} sats:*\n\n\`${invoice}\`\n\n_Tap to copy & pay. Your balance will be credited automatically once paid._`,
        { parse_mode: "Markdown" }
      );

      // Auto-poll for 3 minutes to notify user in chat
      let checks = 0;
      const timer = setInterval(async () => {
        checks++;
        if (checks > 60) return clearInterval(timer);
        try {
          const check = await callSpeed(`payments/${pmt.id}`, "GET");
          const st = (check.status || "").toLowerCase();
          if (st === "succeeded" || st === "paid") {
            clearInterval(timer);
            const record = memoryDB.payments[pmt.id];
            if (record && !record.credited) {
              record.credited = true;
              const newBal = await adjustUserBalance(userId, sats);
              ctx.reply(
                `🎉 *Deposit Confirmed!*\n\n` +
                `⚡ Credited: *+${sats} sats*\n` +
                `💰 Your New Balance: *${newBal.toLocaleString()} sats*`,
                { parse_mode: "Markdown" }
              );
            }
          }
        } catch (e) {}
      }, 3000);

    } catch (err) {
      ctx.reply(`❌ ${err.message}`);
    }
  });

  bot.action("cmd_receive_100", async (ctx) => {
    await ctx.answerCbQuery();
    ctx.message = { text: "/receive 100" };
    bot.handleUpdate(ctx.update);
  });

  // /send <destination> <sats> (Only allows sending from user's personal balance)
  bot.command("send", async (ctx) => {
    const userId = ctx.from.id;
    const args = ctx.message.text.split(" ");
    const dest = args[1];
    const sats = parseInt(args[2]);

    if (!dest || !sats || sats <= 0) {
      return ctx.reply("⚠️ Usage: `/send <address/invoice> <sats>`\nExample: `/send user@speed.app 50`", { parse_mode: "Markdown" });
    }

    const currentBal = await getUserBalance(userId);
    if (currentBal < sats) {
      return ctx.reply(`❌ *Insufficient balance!* You have *${currentBal.toLocaleString()} sats*, but tried to send *${sats} sats*.`, { parse_mode: "Markdown" });
    }

    // Deduct user balance
    await adjustUserBalance(userId, -sats);

    try {
      const res = await callSpeed("send", "POST", {
        amount: sats,
        currency: "SATS",
        target_currency: "SATS",
        withdraw_method: "lightning",
        withdraw_request: dest
      });

      const updatedBal = await getUserBalance(userId);
      ctx.reply(
        `✅ *Payment Sent Successfully!*\n\n` +
        `💸 Amount: *${sats} sats*\n` +
        `🎯 Dest: \`${dest}\`\n` +
        `💰 Remaining Balance: *${updatedBal.toLocaleString()} sats*`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      // Refund if broadcast fails
      await adjustUserBalance(userId, sats);
      ctx.reply(`❌ Send failed: ${err.message}\nYour sats have been refunded.`, { parse_mode: "Markdown" });
    }
  });
}

module.exports = async (req, res) => {
  if (!bot) return res.status(500).send("TELEGRAM_BOT_TOKEN missing.");
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
