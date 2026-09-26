const { Telegraf, Markup } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN);

// Put your Telegram Numeric ID or comma-separated IDs in environment variables
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(id => id.trim());
const WEBAPP_URL = process.env.WEBAPP_URL || "https://pheizu-wallet-bot.vercel.app";

// Helper: Check if user is an admin
function isAdmin(ctx) {
  const userId = String(ctx.from?.id);
  return ADMIN_IDS.includes(userId);
}

// Generate the Keyboard Menu
function getMainKeyboard(ctx) {
  const rows = [
    ["💰 Balance", "📥 Deposit"],
    ["📤 Withdraw"]
  ];

  // Show "🔑 Set Key" only if the user is an admin
  if (isAdmin(ctx)) {
    rows.push(["🔑 Set Key"]);
  }

  return Markup.keyboard(rows).resize();
}

// 1. /start command
bot.start(async (ctx) => {
  const name = ctx.from.first_name || "User";

  await ctx.reply(
    `👋 Hello, <b>${name}</b>!\n\nWelcome to <b>Pheizu Lightning Wallet</b>.\nChoose an action below:`,
    {
      parse_mode: "HTML",
      ...getMainKeyboard(ctx)
    }
  );
});

// 2. 💰 Balance Button
bot.hears("💰 Balance", async (ctx) => {
  const username = ctx.from.username || `user${ctx.from.id}`;
  
  await ctx.reply(
    `⚡ <b>Your Wallet</b>\n` +
    `• Username: <code>${username}</code>\n` +
    `• Lightning Address: <code>${username}@pheizu-wallet-bot.vercel.app</code>\n\n` +
    `Tap below to open your full dashboard:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        Markup.button.webApp("📱 Open Wallet App", WEBAPP_URL)
      ])
    }
  );
});

// 3. 📥 Deposit Button
bot.hears("📥 Deposit", async (ctx) => {
  const username = ctx.from.username || `user${ctx.from.id}`;
  const lnAddress = `${username}@pheizu-wallet-bot.vercel.app`;

  await ctx.reply(
    `📥 <b>Deposit Satoshis</b>\n\n` +
    `Send Lightning sats directly to your address:\n` +
    `👉 <code>${lnAddress}</code>\n\n` +
    `Or open the Web App to generate a custom Lightning Invoice QR code.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        Markup.button.webApp("⚡ Generate Invoice QR", WEBAPP_URL)
      ])
    }
  );
});

// 4. 📤 Withdraw Button
bot.hears("📤 Withdraw", async (ctx) => {
  await ctx.reply(
    `📤 <b>Withdraw / Send Sats</b>\n\n` +
    `To withdraw satoshis to any Lightning Address or Lightning Invoice, launch the wallet interface:`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        Markup.button.webApp("🚀 Send / Withdraw", WEBAPP_URL)
      ])
    }
  );
});

// 5. 🔑 Set Key (Admin Only)
bot.hears("🔑 Set Key", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("⛔ Access denied: You are not authorized to set API keys.");
  }

  await ctx.reply(
    `🔑 <b>Admin Control Panel</b>\n\n` +
    `To update your Speed / LNURL API key, send the command:\n` +
    `<code>/setkey YOUR_SECRET_KEY_HERE</code>`,
    { parse_mode: "HTML" }
  );
});

// Command to accept and store the key
bot.command("setkey", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("⛔ Access denied.");
  }

  const parts = ctx.message.text.split(" ");
  if (parts.length < 2 || !parts[1].trim()) {
    return ctx.reply("⚠️ Usage: <code>/setkey YOUR_NEW_KEY</code>", { parse_mode: "HTML" });
  }

  const newKey = parts[1].trim();

  // Here you can save 'newKey' to Firestore or your database
  // await db.collection("settings").doc("keys").set({ speed_api_key: newKey }, { merge: true });

  await ctx.reply("✅ <b>API Key updated successfully!</b>", { parse_mode: "HTML" });
});

// Vercel Serverless Function Handler
module.exports = async (req, res) => {
  try {
    if (req.method === "POST") {
      await bot.handleUpdate(req.body);
    }
    res.status(200).send("OK");
  } catch (err) {
    console.error("Bot webhook error:", err);
    res.status(500).send("Internal Server Error");
  }
};
