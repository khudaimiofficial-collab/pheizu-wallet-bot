// api/bot.js
const { Telegraf, Markup } = require('telegraf');
const { 
  normalizeUserKey,
  saveUserTelegramId,
  getBalance, 
  addBalance, 
  deductBalance 
} = require('../lib/db');

const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const DOMAIN = process.env.DOMAIN || "pheizu-wallet-bot.vercel.app";
const WEBAPP_URL = (process.env.WEBAPP_URL || `https://${DOMAIN}`).trim().replace(/\/$/, "");
const SPEED_SECRET_KEY = (process.env.SPEED_SECRET_KEY || "").trim().replace(/^["']|["']$/g, "");
const SPEED_BASE_URL = "https://api.tryspeed.com";

const bot = new Telegraf(BOT_TOKEN || "MISSING_TOKEN");

// Helper: Escape HTML
function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Middleware: Always save Telegram Chat ID on every single interaction
bot.use(async (ctx, next) => {
  if (ctx.from?.id) {
    const userKey = normalizeUserKey(ctx.from);
    try {
      await saveUserTelegramId(userKey, ctx.from.id);
    } catch (e) {}
  }
  return next();
});

// Helper: Automatically resolves a Lightning Address (name@domain) to a Bolt11 invoice
async function resolveDestinationToInvoice(destination, sats) {
  const clean = destination.trim().replace(/^lightning:/i, "");
  
  // If it's already a BOLT11 invoice (lnbc... or lntb...)
  if (!clean.includes("@")) {
    return clean;
  }

  // It's a Lightning Address (e.g. satoshi@speed.app)
  const [name, host] = clean.split("@");
  if (!name || !host) {
    throw new Error("Invalid Lightning Address format. Example: name@speed.app");
  }

  const lnurlUrl = `https://${host}/.well-known/lnurlp/${encodeURIComponent(name)}`;
  const res = await fetch(lnurlUrl);
  if (!res.ok) {
    throw new Error(`Could not resolve Lightning Address at ${host}`);
  }
  const lnurlData = await res.json();

  const msats = sats * 1000;
  if (lnurlData.minSendable && msats < lnurlData.minSendable) {
    throw new Error(`Amount is below minimum of ${Math.ceil(lnurlData.minSendable / 1000)} sats.`);
  }
  if (lnurlData.maxSendable && msats > lnurlData.maxSendable) {
    throw new Error(`Amount exceeds maximum of ${Math.floor(lnurlData.maxSendable / 1000)} sats.`);
  }

  const separator = lnurlData.callback.includes("?") ? "&" : "?";
  const cbRes = await fetch(`${lnurlData.callback}${separator}amount=${msats}`);
  if (!cbRes.ok) {
    throw new Error("Failed to retrieve invoice from recipient's Lightning provider.");
  }
  const cbData = await cbRes.json();

  const invoice = cbData.pr || cbData.payment_request;
  if (!invoice) {
    throw new Error(cbData.reason || "Provider did not return a valid Lightning invoice.");
  }

  return invoice;
}

// Helper: Speed Payout
async function speedPay(destination, sats) {
  if (!SPEED_SECRET_KEY) {
    throw new Error("SPEED_SECRET_KEY is not configured in Vercel.");
  }

  // 1. Resolve address to Bolt11 invoice first
  const bolt11Invoice = await resolveDestinationToInvoice(destination, sats);

  const authHeader = "Basic " + Buffer.from(SPEED_SECRET_KEY + ":").toString("base64");
  const payload = {
    currency: "SATS",
    amount: sats,
    payment_request: bolt11Invoice
  };

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
  const userKey = normalizeUserKey(ctx.from);
  const balance = await getBalance(userKey);
  const firstName = escapeHtml(ctx.from?.first_name || "Friend");

  const text = 
    `⚡ <b>Welcome to Pheizu Wallet, ${firstName}!</b>\n\n` +
    `💳 <b>Your Lightning Address:</b>\n<code>${userKey}@${DOMAIN}</code>\n\n` +
    `💰 <b>Available Balance:</b> <code>${balance.toLocaleString()} sats</code>\n\n` +
    `Use the buttons below to open your Mini App or withdraw satoshis directly in chat.`;

  return await ctx.replyWithHTML(
    text,
    Markup.inlineKeyboard([
      [Markup.button.webApp("🚀 Open Mini App", WEBAPP_URL)],
      [
        Markup.button.callback("🔄 Refresh Balance", "cb_balance"),
        Markup.button.callback("📤 Withdraw", "cb_withdraw")
      ]
    ])
  );
});

// /balance command
bot.command('balance', async (ctx) => {
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
});

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
  } catch (err) {}
});

// /receive command
bot.command('receive', async (ctx) => {
  const userKey = normalizeUserKey(ctx.from);
  return await ctx.replyWithHTML(
    `📥 <b>Receive Satoshis:</b>\n\n` +
    `Share your Lightning Address:\n<code>${userKey}@${DOMAIN}</code>\n\n` +
    `Or open the Mini App to generate an instant QR invoice!`,
    Markup.inlineKeyboard([[Markup.button.webApp("⚡ Generate Invoice QR", WEBAPP_URL)]])
  );
});

// /withdraw, /send, and /pay commands (all supported)
bot.command(['withdraw', 'send', 'pay'], async (ctx) => {
  const userKey = normalizeUserKey(ctx.from);
  const parts = ctx.message.text.trim().split(/\s+/);

  if (parts.length < 3) {
    return await ctx.replyWithHTML(
      `⚠️ <b>Usage:</b> <code>/withdraw &lt;address_or_invoice&gt; &lt;amount_in_sats&gt;</code>\n\n` +
      `<b>Examples:</b>\n` +
      `• <code>/withdraw satoshi@speed.app 21</code>\n` +
      `• <code>/withdraw lnbc... 100</code>`,
      Markup.inlineKeyboard([[Markup.button.webApp("⚡ Send via Mini App", WEBAPP_URL)]])
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
      `❌ Insufficient balance!\nYou have ${currentBal.toLocaleString()} sats, but tried to withdraw ${sats.toLocaleString()} sats.`
    );
  }

  const statusMsg = await ctx.reply("⏳ Broadcasting payment over Lightning Network...");

  // Deduct balance first (escrow)
  await deductBalance(userKey, sats);

  try {
    await speedPay(destination, sats);
    const newBal = await getBalance(userKey);

    // Try deleting pending message
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
    } catch (e) {}

    // Send payment success message
    return await ctx.replyWithHTML(
      `🎉 <b>Payment Sent Successfully!</b>\n\n` +
      `⚡ <b>Amount:</b> <code>${sats.toLocaleString()} sats</code>\n` +
      `📍 <b>Destination:</b> <code>${escapeHtml(destination)}</code>\n` +
      `💰 <b>Remaining Balance:</b> <code>${newBal.toLocaleString()} sats</code>`,
      Markup.inlineKeyboard([
        [Markup.button.webApp("🚀 Open Mini App", WEBAPP_URL)],
        [Markup.button.callback("🔄 Check Balance", "cb_balance")]
      ])
    );
  } catch (payErr) {
    // Refund on failure
    await addBalance(userKey, sats);

    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
    } catch (e) {}

    return await ctx.replyWithHTML(
      `❌ <b>Withdrawal Failed:</b>\n${escapeHtml(payErr.message)}\n\n` +
      `🛡️ Your balance of <b>${sats.toLocaleString()} sats</b> has been refunded.`
    );
  }
});

bot.action('cb_withdraw', async (ctx) => {
  await ctx.answerCbQuery();
  return await ctx.replyWithHTML(
    `📤 <b>Withdraw Satoshis:</b>\n\n` +
    `Type the command in chat:\n<code>/withdraw &lt;address&gt; &lt;sats&gt;</code>\n\n` +
    `<b>Example:</b>\n<code>/withdraw satoshi@speed.app 21</code>\n\n` +
    `Or open the Mini App to paste and send visually:`,
    Markup.inlineKeyboard([[Markup.button.webApp("🚀 Open Mini App to Send", WEBAPP_URL)]])
  );
});

// Vercel Serverless Function Handler
module.exports = async (req, res) => {
  if (!BOT_TOKEN) return res.status(500).json({ error: "BOT_TOKEN missing." });

  if (req.method === 'GET') {
    const webhookUrl = `https://${DOMAIN}/api/bot`;
    try {
      const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
      const result = await response.json();
      return res.status(200).json({ message: "Bot handler active", webhook_setup: result });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    try {
      let update = req.body;
      if (typeof update === 'string') update = JSON.parse(update);
      if (update && update.update_id) await bot.handleUpdate(update);
      return res.status(200).send("OK");
    } catch (e) {
      return res.status(200).send("Handled with error");
    }
  }
  return res.status(405).send("Method Not Allowed");
};
