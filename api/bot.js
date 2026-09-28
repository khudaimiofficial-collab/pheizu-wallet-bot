const { Telegraf, Markup } = require("telegraf");
const admin = require("firebase-admin");

const botToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  throw new Error("BOT_TOKEN is not defined in environment variables.");
}

const bot = new Telegraf(botToken);
const MINI_APP_URL = "https://pheizu-wallet-bot.vercel.app";

// Helper to register / update user in Firestore
async function saveUser(ctx) {
  const user = ctx.from;
  if (!user) return;

  try {
    if (admin.apps.length) {
      const db = admin.firestore();
      await db.collection("users").doc(String(user.id)).set(
        {
          telegram_id: String(user.id),
          username: user.username || "",
          first_name: user.first_name || "",
          last_name: user.last_name || "",
          last_active: new Date()
        },
        { merge: true }
      );
    }
  } catch (e) {
    console.warn("Could not save user profile:", e.message);
  }
}

// /start command
bot.start(async (ctx) => {
  await saveUser(ctx);

  const tgId = ctx.from.id;
  const username = ctx.from.username || `user${tgId}`;
  const webAppLaunchUrl = `${MINI_APP_URL}?telegram_id=${tgId}&username=${encodeURIComponent(username)}`;

  const welcomeText = [
    `⚡ <b>Welcome to Pheizu Wallet!</b>\n`,
    `Your fast, non-custodial Lightning Network wallet directly inside Telegram.`,
    `• Instant deposits & withdrawals via Lightning Network`,
    `• Your Lightning Address: <code>${username.toLowerCase()}@pheizu-wallet-bot.vercel.app</code>\n`,
    `Tap the button below to open your wallet:`
  ].join("\n");

  await ctx.replyWithHTML(
    welcomeText,
    Markup.inlineKeyboard([
      [Markup.button.webApp("⚡ Open Pheizu Wallet", webAppLaunchUrl)]
    ])
  );
});

// /help command
bot.help(async (ctx) => {
  await ctx.replyWithHTML(
    `⚡ <b>Pheizu Wallet Help</b>\n\n` +
    `• Click <b>Open Pheizu Wallet</b> to generate Lightning invoices or make withdrawals.\n` +
    `• Payments sent from any wallet (Phoenix, WoS, Strike, CashApp) are credited in real-time.\n` +
    `• Instant notifications will be sent directly here upon payment completion.`
  );
});

// Export serverless handler for Vercel Webhook / Telegram updates
export default async function handler(req, res) {
  if (req.method === "POST") {
    try {
      await bot.handleUpdate(req.body);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("Bot update error:", err);
      return res.status(500).json({ error: err.message });
    }
  }
  return res.status(200).send("Pheizu Wallet Bot is active.");
}
