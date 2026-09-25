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

// Persistent Store Helper
const store = global._pheizuStore = global._pheizuStore || {
  balances: {},
  pendingInvoices: {} // userId -> [{ id, amount, credited }]
};

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
  return Number(store.balances[userId] || 0);
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
  store.balances[userId] = Math.max(0, Number(store.balances[userId] || 0) + delta);
  return store.balances[userId];
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

// Active Settlement: Checks Speed API for any paid invoices and credits user
async function settleUserPendingPayments(userId) {
  const userPending = store.pendingInvoices[userId] || [];
  let newlyCredited = 0;

  for (const item of userPending) {
    if (!item.credited) {
      try {
        const pmt = await callSpeed(`payments/${item.id}`, "GET");
        const st = (pmt.status || "").toLowerCase();
        if (st === "succeeded" || st === "paid") {
          item.credited = true;
          await adjustUserBalance(userId, item.amount);
          newlyCredited += item.amount;
        }
      } catch (e) {}
    }
  }
  return newlyCredited;
}

if (bot) {
  // /start
  bot.start(async (ctx) => {
    const userId = String(ctx.from.id);
    const name = ctx.from.first_name || "User";

    await settleUserPendingPayments(userId);
    const userBal = await getUserBalance(userId);

    let welcome = `⚡ *Welcome to Pheizu Wallet, ${name}!*\n\n`;

    if (Number(userId) === ADMIN_ID) {
      welcome +=
        `👑 *ADMIN CONSOLE ACTIVE*\n` +
        `• \`/setkey <speed_key>\` - Set Speed Key\n` +
        `• \`/masterbalance\` - View Master Speed Account\n\n`;
    }

    welcome +=
      `💰 *Your Personal Balance:* \`${userBal.toLocaleString()} sats\`\n\n` +
      `*Commands:*\n` +
      `💰 /balance - Check and sync your balance\n` +
      `📥 /receive <sats> - Deposit satoshis\n` +
      `📤 /send <dest> <sats> - Send from your balance\n\n` +
      `Or open the interactive Mini App:`;

    ctx.reply(welcome, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.webApp("⚡ Open Pheizu Mini App", MINI_APP_URL)],
        [
          Markup.button.callback("💰 Sync Balance", "cmd_balance"),
          Markup.button.callback("📥 Deposit 100", "cmd_receive_100")
        ]
      ])
    });
  });

  // /balance (Actively checks Speed and credits paid invoices)
  bot.command("balance", async (ctx) => {
    const userId = String(ctx.from.id);
    ctx.reply("🔍 *Syncing with Lightning Network...*", { parse_mode: "Markdown" });

    const newCredits = await settleUserPendingPayments(userId);
    const userBal = await getUserBalance(userId);

    let msg = `💰 *Your Personal Balance:*\n\n⚡ Available: *${userBal.toLocaleString()} sats*`;
    if (newCredits > 0) {
      msg = `🎉 *Payment Confirmed!* +${newCredits.toLocaleString()} sats credited.\n\n` + msg;
    }

    ctx.reply(msg, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([[Markup.button.webApp("⚡ Open Mini App", MINI_APP_URL)]])
    });
  });

  bot.action("cmd_balance", async (ctx) => {
    await ctx.answerCbQuery("Syncing balance...");
    const userId = String(ctx.from.id);
    await settleUserPendingPayments(userId);
    const userBal = await getUserBalance(userId);
    ctx.reply(`💰 Your Balance: *${userBal.toLocaleString()} sats*`, { parse_mode: "Markdown" });
  });

  // /masterbalance (Admin only)
  bot.command("masterbalance", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply("⛔ Admin only.");
    try {
      const data = await callSpeed("balances", "GET");
      const avail = data.available?.find?.((b) => b.currency === "SATS")?.amount || 0;
      ctx.reply(`👑 *Master Speed Balance:* ${Number(avail).toLocaleString()} sats`, { parse_mode: "Markdown" });
    } catch (e) {
      ctx.reply(`❌ ${e.message}`);
    }
  });

  // /setkey (Admin only)
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

  // /receive <sats>
  bot.command("receive", async (ctx) => {
    const userId = String(ctx.from.id);
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
        metadata: { telegram_user_id: userId }
      });

      const invoice = extractInvoice(pmt);
      if (!invoice) return ctx.reply("⚠️ Could not generate invoice.");

      // Store in pending list for this user
      store.pendingInvoices[userId] = store.pendingInvoices[userId] || [];
      store.pendingInvoices[userId].push({ id: pmt.id, amount: sats, credited: false });

      ctx.reply(
        `⚡ *Deposit Invoice for ${sats} sats:*\n\n\`${invoice}\`\n\n_Tap to copy & pay. Once paid, type /balance to sync your sats!_`,
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🔄 I have paid (Check Status)", `check_${pmt.id}_${sats}`)]
          ])
        }
      );
    } catch (err) {
      ctx.reply(`❌ ${err.message}`);
    }
  });

  // Manual Check Button in Chat
  bot.action(/check_(.+)_(.+)/, async (ctx) => {
    const paymentId = ctx.match[1];
    const sats = Number(ctx.match[2]);
    const userId = String(ctx.from.id);

    await ctx.answerCbQuery("Verifying payment with Speed...");

    try {
      const check = await callSpeed(`payments/${paymentId}`, "GET");
      const st = (check.status || "").toLowerCase();

      if (st === "succeeded" || st === "paid") {
        // Credit user
        const newBal = await adjustUserBalance(userId, sats);
        ctx.reply(
          `🎉 *Payment Confirmed!*\n\n` +
          `⚡ Credited: *+${sats} sats*\n` +
          `💰 Your New Balance: *${newBal.toLocaleString()} sats*`,
          { parse_mode: "Markdown" }
        );
      } else {
        ctx.reply(`⏳ Payment status is still: *${st.toUpperCase()}*. Please complete the payment in your wallet.`, { parse_mode: "Markdown" });
      }
    } catch (e) {
      ctx.reply(`❌ Could not check: ${e.message}`);
    }
  });

  bot.action("cmd_receive_100", async (ctx) => {
    await ctx.answerCbQuery();
    ctx.message = { text: "/receive 100" };
    bot.handleUpdate(ctx.update);
  });

  // /send <destination> <sats>
  bot.command("send", async (ctx) => {
    const userId = String(ctx.from.id);
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
