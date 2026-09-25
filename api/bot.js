// api/bot.js
const { Telegraf, Markup } = require('telegraf');
const { 
  normalizeUserKey, 
  getBalance, 
  addBalance, 
  deductBalance 
} = require('../lib/db');

const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const DOMAIN = process.env.DOMAIN || "pheizu-wallet-bot.vercel.app";
const WEBAPP_URL = (process.env.WEBAPP_URL || `https://${DOMAIN}`).trim().replace(/\/$/, "");
const SPEED_SECRET_KEY = (process.env.SPEED_SECRET_KEY || "").trim().replace(/^["']|["']$/g, "");
const SPEED_BASE_URL = "https://api.tryspeed.com";

if (!BOT_TOKEN) {
  console.error("CRITICAL: BOT_TOKEN is missing in Environment Variables!");
}

const bot = new Telegraf(BOT_TOKEN || "MISSING_TOKEN");

// Helper: Escape HTML characters for Telegram
function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Helper: Broadcast Speed Lightning Payout
async function speedPay(destination, sats) {
  if (!SPEED_SECRET_KEY) {
    throw new Error("SPEED_SECRET_KEY is not configured.");
  }

  const authHeader = "Basic " + Buffer.from(SPEED_SECRET_KEY + ":").toString("base64");
  const payload = {
    currency: "SATS",
    amount: sats
  };

  const cleanDest = destination.trim();
  if (cleanDest.includes("@")) {
    payload.lnurl = cleanDest;
  } else {
    payload.payment_request = cleanDest.replace(/^lightning:/i, "");
  }

  const res = await fetch(`${SPEED_BASE_URL}/payouts`, {
    method: "POST",
    headers: {
      "Authorization": authHeader,
      "Content-Type": "application/json",
      "accept": "application/json",
      "speed-version": "2022-10-15"
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch (e) {}

  if (!res.ok) {
    const msg = json?.message || json?.error?.message || json?.errors?.[0]?.message || text;
    throw new Error(msg || `Speed Payout failed with status ${res.status}`);
  }

  return json;
}

// /start command
bot.start(async (ctx) => {
  try {
    const userKey = normalizeUserKey(ctx.from);
    const balance = await getBalance(userKey);
    const firstName = escapeHtml(ctx.from?.first_name || "Friend");

    const text = 
      `⚡ <b>Welcome to Pheizu Wallet, ${firstName}!</b>\n\n` +
      `💳 <b>Your Lightning Address:</b>\n<code>${userKey}@${DOMAIN}</code>\n\n` +
      `💰 <b>Available Balance:</b> <code>${balance.toLocaleString()} sats</code>\n\n` +
      `Tap <b>Open Mini App</b> below to send, receive, or scan QR codes instantly!`;

    return await ctx.replyWithHTML(
      text,
      Markup.inlineKeyboard([
        [Markup.button.webApp("🚀 Open Mini App", WEBAPP_URL)],
        [
          Markup.button.callback("🔄 Refresh Balance", "cb_balance"),
          Markup.button.callback("📥 Deposit", "cb_receive")
        ]
      ])
    );
  } catch (err) {
    console.error("Start command error:", err);
    return ctx.reply("Error loading wallet. Please try again.");
  }
});

// /balance command
bot.command('balance', async (ctx) => {
  try {
    const userKey = normalizeUserKey(ctx.from);
    const balance = await getBalance(userKey);

    return await ctx.replyWithHTML(
      `⚡ <b>Account:</b> <code>${userKey}</code>\n` +
      `💰 <b>Balance:</b> <code>${balance.toLocaleString()} sats</code>`,
      Markup.inlineKeyboard([
        [Markup.button.webApp("🚀 Open Mini App", WEBAPP_URL)],
        [Markup.button.callback("🔄 Refresh", "cb_balance")]
      ])
    );
  } catch (err) {
    console.error("Balance command error:", err);
  }
});

// Callback for "Refresh Balance" button
bot.action('cb_balance', async (ctx) => {
  try {
    await ctx.answerCbQuery("Updating balance...");
    const userKey = normalizeUserKey(ctx.from);
    const balance = await getBalance(userKey);

    return await ctx.editMessageText(
      `⚡ <b>Account:</b> <code>${userKey}</code>\n` +
      `💰 <b>Current Balance:</b> <code>${balance.toLocaleString()} sats</code>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.webApp("🚀 Open Mini App", WEBAPP_URL)],
          [Markup.button.callback("🔄 Refresh Balance", "cb_balance")]
        ])
      }
    );
  } catch (err) {
    console.warn("Callback cb_balance error:", err.message);
  }
});

// /receive command
bot.command('receive', async (ctx) => {
  try {
    const userKey = normalizeUserKey(ctx.from);
    return await ctx.replyWithHTML(
      `📥 <b>Receive Satoshis:</b>\n\n` +
      `Share your Lightning Address:\n<code>${userKey}@${DOMAIN}</code>\n\n` +
      `Or open the Mini App to generate an instant QR invoice!`,
      Markup.inlineKeyboard([
        [Markup.button.webApp("⚡ Generate Invoice QR", WEBAPP_URL)]
      ])
    );
  } catch (err) {
    console.error("Receive command error:", err);
  }
});

bot.action('cb_receive', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userKey = normalizeUserKey(ctx.from);
    return await ctx.replyWithHTML(
      `📥 <b>Your Lightning Address:</b>\n<code>${userKey}@${DOMAIN}</code>`,
      Markup.inlineKeyboard([
        [Markup.button.webApp("⚡ Open Mini App", WEBAPP_URL)]
      ])
    );
  } catch (err) {
    console.error("Callback cb_receive error:", err);
  }
});

// /send <destination> <amount> command in chat
bot.command('send', async (ctx) => {
  try {
    const userKey = normalizeUserKey(ctx.from);
    const parts = ctx.message.text.trim().split(/\s+/);

    if (parts.length < 3) {
      return await ctx.replyWithHTML(
        `⚠️ <b>Usage:</b> <code>/send &lt;address_or_invoice&gt; &lt;amount_in_sats&gt;</code>\n\n` +
        `<b>Example:</b>\n<code>/send satoshi@speed.app 21</code>`
      );
    }

    const destination = parts[1];
    const sats = Math.floor(Number(parts[2]));

    if (!sats || isNaN(sats) || sats <= 0) {
      return await ctx.reply("❌ Please enter a valid number of satoshis.");
    }

    const currentBal = await getBalance(userKey);
    if (currentBal < sats) {
      return await ctx.reply(
        `❌ Insufficient balance!\nYou have ${currentBal.toLocaleString()} sats, tried to send ${sats.toLocaleString()} sats.`
      );
    }

    const statusMsg = await ctx.reply("⏳ Broadcasting payment over Lightning...");

    // Escrow balance
    await deductBalance(userKey, sats);

    try {
      await speedPay(destination, sats);
      const newBal = await getBalance(userKey);

      return await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        `✅ <b>Sent ${sats.toLocaleString()} sats successfully!</b>\n` +
        `💰 <b>New Balance:</b> <code>${newBal.toLocaleString()} sats</code>`,
        { parse_mode: 'HTML' }
      );
    } catch (payErr) {
      // Refund on failure
      await addBalance(userKey, sats);
      return await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        `❌ <b>Payment Failed:</b> ${escapeHtml(payErr.message)}\nYour balance has been refunded.`,
        { parse_mode: 'HTML' }
      );
    }
  } catch (err) {
    console.error("Send command error:", err);
    return ctx.reply("❌ Error processing send request.");
  }
});

// Vercel Serverless Function Handler
module.exports = async (req, res) => {
  if (!BOT_TOKEN) {
    return res.status(500).json({ error: "BOT_TOKEN environment variable is not configured." });
  }

  // 1. Browser GET Request: Automatically sets and confirms Telegram Webhook
  if (req.method === 'GET') {
    const webhookUrl = `https://${DOMAIN}/api/bot`;
    try {
      const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
      const result = await response.json();
      return res.status(200).json({
        message: "Bot handler active",
        webhook_setup: result,
        target_webhook_url: webhookUrl
      });
    } catch (e) {
      return res.status(500).json({ error: "Failed to set webhook", details: e.message });
    }
  }

  // 2. Telegram POST Webhook Update
  if (req.method === 'POST') {
    try {
      let update = req.body;
      if (typeof update === 'string') {
        update = JSON.parse(update);
      }

      if (update && update.update_id) {
        await bot.handleUpdate(update);
      }
      return res.status(200).send("OK");
    } catch (e) {
      console.error("Bot update error:", e);
      return res.status(200).send("Handled with error");
    }
  }

  return res.status(405).send("Method Not Allowed");
};
