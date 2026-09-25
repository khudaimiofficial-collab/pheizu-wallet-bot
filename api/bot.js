// api/bot.js
const { Telegraf, Markup } = require('telegraf');
const { 
  normalizeUserKey,
  saveUserTelegramId,
  getBalance, 
  claimPaymentAndCredit,
  deductBalance,
  internalTransfer,
  notifyPaymentReceived
} = require('../lib/db');

const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const DOMAIN = process.env.DOMAIN || "pheizu-wallet-bot.vercel.app";
const WEBAPP_URL = (process.env.WEBAPP_URL || `https://${DOMAIN}`).trim().replace(/\/$/, "");
const SPEED_SECRET_KEY = (process.env.SPEED_SECRET_KEY || "").trim().replace(/^["']|["']$/g, "");
const SPEED_BASE_URL = "https://api.tryspeed.com";

const bot = new Telegraf(BOT_TOKEN || "MISSING_TOKEN");

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Middleware: Auto-save Telegram chat ID on every interaction
bot.use(async (ctx, next) => {
  if (ctx.from?.id) {
    const userKey = normalizeUserKey(ctx.from);
    try {
      await saveUserTelegramId(userKey, ctx.from.id);
    } catch (e) {}
  }
  return next();
});

// Speed Instant Send Helper using POST /send
async function speedInstantSend(destination, sats, userKey) {
  if (!SPEED_SECRET_KEY) {
    throw new Error("SPEED_SECRET_KEY is not configured.");
  }

  const authHeader = "Basic " + Buffer.from(SPEED_SECRET_KEY + ":").toString("base64");
  const withdrawReq = destination.trim().replace(/^lightning:/i, "");

  const payload = {
    amount: sats,
    currency: "SATS",
    target_currency: "SATS",
    withdraw_method: "lightning",
    withdraw_request: withdrawReq,
    note: `Withdrawal by ${userKey}`
  };

  const res = await fetch(`${SPEED_BASE_URL}/send`, {
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
    throw new Error(msg || `Speed send failed with status ${res.status}`);
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

// /withdraw, /send, /pay commands
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

  const destination = parts[1].trim();
  const sats = Math.floor(Number(parts[2]));

  if (!sats || isNaN(sats) || sats <= 0) {
    return await ctx.reply("❌ Please enter a valid number of satoshis.");
  }

  // CASE A: INTERNAL TRANSFER
  if (destination.toLowerCase().endsWith(`@${DOMAIN}`)) {
    const recipientUser = destination.toLowerCase().replace(`@${DOMAIN}`, "").trim();
    try {
      const transferRes = await internalTransfer(userKey, recipientUser, sats);
      await notifyPaymentReceived(recipientUser, sats, transferRes.newToBal, userKey);

      return await ctx.replyWithHTML(
        `🎉 <b>Internal Transfer Successful!</b>\n\n` +
        `⚡ <b>Sent:</b> <code>${sats.toLocaleString()} sats</code>\n` +
        `📍 <b>To:</b> <code>${escapeHtml(destination)}</code>\n` +
        `💰 <b>Remaining Balance:</b> <code>${transferRes.newFromBal.toLocaleString()} sats</code>`
      );
    } catch (err) {
      return await ctx.reply(`❌ Transfer failed: ${err.message}`);
    }
  }

  // CASE B: EXTERNAL LIGHTNING SEND
  const currentBal = await getBalance(userKey);
  if (currentBal < sats) {
    return await ctx.reply(
      `❌ Insufficient balance!\nYou have ${currentBal.toLocaleString()} sats, but tried to withdraw ${sats.toLocaleString()} sats.`
    );
  }

  const statusMsg = await ctx.reply("⏳ Broadcasting payment over Lightning Network...");
  await deductBalance(userKey, sats);

  try {
    await speedInstantSend(destination, sats, userKey);
    const newBal = await getBalance(userKey);

    try { await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}

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
    const refundKey = `refund_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await claimPaymentAndCredit(refundKey, userKey, sats);

    try { await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id); } catch (e) {}

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
