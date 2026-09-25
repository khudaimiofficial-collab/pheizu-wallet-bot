const { Telegraf, Markup } = require("telegraf");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SPEED_KEY = process.env.SPEED_SECRET_KEY;
const MINI_APP_URL = process.env.VERCEL_PROJECT_URL;

const bot = new Telegraf(BOT_TOKEN);

async function callSpeed(endpoint, method = "POST", body = null) {
  const auth = "Basic " + Buffer.from(SPEED_KEY + ":").toString("base64");
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
    throw new Error(data.message || `Speed error: ${res.status}`);
  }
  return data;
}

// /start
bot.start((ctx) => {
  const name = ctx.from.first_name || "User";
  ctx.reply(
    `⚡ *Welcome to Pheizu Wallet, ${name}!*\n\n` +
    `You can use this wallet *directly in chat* or launch the *interactive Mini App* below:\n\n` +
    `*Chat Commands:*\n` +
    `💰 /balance - View live balance\n` +
    `📥 /receive <sats> - Generate invoice\n` +
    `📤 /send <dest> <sats> - Send satoshis`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.webApp("⚡ Open Pheizu Mini App", MINI_APP_URL)],
        [
          Markup.button.callback("💰 Balance", "cmd_balance"),
          Markup.button.callback("📥 Receive 100", "cmd_receive_100")
        ]
      ])
    }
  );
});

// /balance
bot.command("balance", async (ctx) => {
  try {
    const data = await callSpeed("balances", "GET");
    const avail = data.available?.find((b) => b.currency === "SATS")?.amount || 0;
    const pending = data.pending?.find((b) => b.currency === "SATS")?.amount || 0;

    let msg = `💰 *Pheizu Wallet Balance:*\n\n⚡ Available: *${Number(avail).toLocaleString()} sats*`;
    if (pending > 0) msg += `\n⏳ Pending: *${Number(pending).toLocaleString()} sats*`;

    ctx.reply(msg, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.webApp("⚡ Open Mini App", MINI_APP_URL)]
      ])
    });
  } catch (err) {
    ctx.reply(`❌ Could not fetch balance: ${err.message}`);
  }
});

bot.action("cmd_balance", async (ctx) => {
  await ctx.answerCbQuery();
  const data = await callSpeed("balances", "GET").catch(() => ({}));
  const avail = data.available?.find((b) => b.currency === "SATS")?.amount || 0;
  ctx.reply(`💰 Balance: *${Number(avail).toLocaleString()} sats*`, { parse_mode: "Markdown" });
});

// /receive <sats>
bot.command("receive", async (ctx) => {
  const args = ctx.message.text.split(" ");
  const sats = parseInt(args[1]);

  if (!sats || sats <= 0) {
    return ctx.reply("⚠️ Usage: `/receive <amount_in_sats>`\nExample: `/receive 100`", { parse_mode: "Markdown" });
  }

  try {
    const pmt = await callSpeed("payments", "POST", {
      amount: sats,
      currency: "SATS",
      target_currency: "SATS",
      payment_methods: ["lightning"]
    });

    const invoice = pmt.payment_method_details?.lightning?.payment_request || pmt.payment_request || pmt.url;
    ctx.reply(`⚡ *Invoice for ${sats} sats:*\n\n\`${invoice}\`\n\n_Tap to copy & pay._`, { parse_mode: "Markdown" });
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
    const invoice = pmt.payment_method_details?.lightning?.payment_request || pmt.payment_request || pmt.url;
    ctx.reply(`⚡ *Invoice (100 sats):*\n\n\`${invoice}\``, { parse_mode: "Markdown" });
  } catch (err) {
    ctx.reply(`❌ Error: ${err.message}`);
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

// Webhook Handler for Vercel
module.exports = async (req, res) => {
  if (req.method === "POST") {
    await bot.handleUpdate(req.body);
    return res.status(200).send("OK");
  }
  return res.status(200).send("Pheizu Wallet Bot is running!");
};
