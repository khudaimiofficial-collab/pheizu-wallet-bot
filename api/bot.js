// api/bot.js
const { Telegraf, Markup } = require('telegraf');
const { 
  normalizeUserKey, 
  getBalance, 
  addBalance, 
  deductBalance 
} = require('../lib/db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || "https://pheizu-wallet-bot.vercel.app";
const SPEED_SECRET_KEY = process.env.SPEED_SECRET_KEY || "";
const SPEED_BASE_URL = "https://api.tryspeed.com";

const bot = new Telegraf(BOT_TOKEN);

// Helper for Speed payouts in chat
async function speedPay(destination, sats) {
  const authHeader = "Basic " + Buffer.from(SPEED_SECRET_KEY + ":").toString("base64");
  const payload = { currency: "SATS", amount: sats };
  if (destination.includes("@")) {
    payload.lnurl = destination;
  } else {
    payload.payment_request = destination.replace(/^lightning:/i, "");
  }

  const res = await fetch(`${SPEED_BASE_URL}/v1/payouts`, {
    method: "POST",
    headers: { "Authorization": authHeader, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "Payment routing failed");
  return data;
}

// /start command
bot.start(async (ctx) => {
  const userKey = normalizeUserKey(ctx.from);
  const balance = await getBalance(userKey);

  const welcomeMessage = 
    `⚡ *Welcome to Pheizu Wallet, ${ctx.from.first_name || "friend"}!*\n\n` +
    `💳 *Your Lightning Address:*\n\`${userKey}@pheizu-wallet-bot.vercel.app\`\n\n` +
    `💰 *Available Balance:* \`${balance.toLocaleString()} sats\`\n\n` +
    `Use the buttons below to open your Mini App or manage your satoshis directly in chat.`;

  return ctx.replyWithMarkdown(
    welcomeMessage,
    Markup.inlineKeyboard([
      [Markup.button.webApp("🚀 Open Mini App", WEBAPP_URL)],
      [
        Markup.button.callback("🔄 Refresh Balance", "cb_balance"),
        Markup.button.callback("📥 Deposit", "cb_receive")
      ]
    ])
  );
});

// /balance command
bot.command('balance', async (ctx) => {
  const userKey = normalizeUserKey(ctx.from);
  const balance = await getBalance(userKey);

  return ctx.replyWithMarkdown(
    `⚡ *Account:* \`${userKey}\`\n💰 *Balance:* \`${balance.toLocaleString()} sats\``,
    Markup.inlineKeyboard([
      [Markup.button.webApp("⚡ Open Wallet", WEBAPP_URL)],
      [Markup.button.callback("🔄 Refresh", "cb_balance")]
    ])
  );
});

// Callback query: cb_balance
bot.action('cb_balance', async (ctx) => {
  const userKey = normalizeUserKey(ctx.from);
  const balance = await getBalance(userKey);
  await ctx.answerCbQuery("Balance updated!");
  return ctx.editMessageText(
    `⚡ *Account:* \`${userKey}\`\n💰 *Current Balance:* \`${balance.toLocaleString()} sats\``,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.webApp("🚀 Open Mini App", WEBAPP_URL)],
        [Markup.button.callback("🔄 Refresh Balance", "cb_balance")]
      ])
    }
  );
});

// /receive command
bot.command('receive', async (ctx) => {
  const userKey = normalizeUserKey(ctx.from);
  return ctx.replyWithMarkdown(
    `📥 *Receive Satoshis:*\n\n` +
    `Share your Lightning Address:\n\`${userKey}@pheizu-wallet-bot.vercel.app\`\n\n` +
    `Or open the Mini App to generate an instant QR invoice!`,
    Markup.inlineKeyboard([
      [Markup.button.webApp("⚡ Generate Invoice QR", WEBAPP_URL)]
    ])
  );
});

bot.action('cb_receive', async (ctx) => {
  await ctx.answerCbQuery();
  const userKey = normalizeUserKey(ctx.from);
  return ctx.replyWithMarkdown(
    `📥 *Lightning Address:*\n\`${userKey}@pheizu-wallet-bot.vercel.app\``,
    Markup.inlineKeyboard([
      [Markup.button.webApp("⚡ Open Invoice Generator", WEBAPP_URL)]
    ])
  );
});

// /send <destination> <amount> command in chat
bot.command('send', async (ctx) => {
  const userKey = normalizeUserKey(ctx.from);
  const parts = ctx.message.text.trim().split(/\s+/);

  if (parts.length < 3) {
    return ctx.replyWithMarkdown(
      `⚠️ *Usage:* \`/send <address_or_invoice> <amount_in_sats>\`\n` +
      `*Example:* \`/send satoshi@speed.app 21\``
    );
  }

  const destination = parts[1];
  const sats = Math.floor(Number(parts[2]));

  if (!sats || sats <= 0) {
    return ctx.reply("❌ Please enter a valid number of satoshis.");
  }

  const currentBal = await getBalance(userKey);
  if (currentBal < sats) {
    return ctx.reply(`❌ Insufficient balance. You have ${currentBal} sats, tried to send ${sats} sats.`);
  }

  const statusMsg = await ctx.reply("⏳ Broadcasting payment over Lightning...");

  try {
    await deductBalance(userKey, sats);
    await speedPay(destination, sats);
    const newBal = await getBalance(userKey);

    return ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `✅ *Sent ${sats.toLocaleString()} sats successfully!*\n💰 *New Balance:* \`${newBal.toLocaleString()} sats\``,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    await addBalance(userKey, sats); // Refund on failure
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `❌ *Payment Failed:* ${err.message}\nYour balance has been refunded.`
    );
  }
});

// Vercel Serverless Webhook Handler
module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      await bot.handleUpdate(req.body);
      return res.status(200).send("OK");
    } catch (e) {
      console.error("Bot update error:", e);
      return res.status(200).send("Error handled");
    }
  }
  return res.status(200).send("Bot Webhook is Active");
};
