const { Telegraf, Markup } = require("telegraf");
const admin = require("firebase-admin");

// 1. Firebase Initialization
function getDb() {
  if (admin.apps.length) return admin.firestore();
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      let sa = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
      if (!sa.startsWith("{")) sa = Buffer.from(sa, "base64").toString("utf8");
      const parsed = typeof sa === "string" ? JSON.parse(sa) : sa;
      if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
      admin.initializeApp({ credential: admin.credential.cert(parsed) });
      return admin.firestore();
    }
    if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
        })
      });
      return admin.firestore();
    }
    admin.initializeApp();
    return admin.firestore();
  } catch (err) {
    console.error("Firebase Init Error:", err);
    return null;
  }
}

const db = getDb();
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || "https://pheizu-wallet-bot.vercel.app";
const REFERRAL_REWARD_SATS = 10; // Satoshis credited per valid referral

const bot = new Telegraf(BOT_TOKEN);

// Helper: Format Channel ID
function formatChannelId(raw) {
  if (!raw) return "";
  let clean = String(raw).trim();
  if (/^\d{8,16}$/.test(clean)) return `-100${clean}`;
  if (/^-\d{8,16}$/.test(clean) && !clean.startsWith("-100")) return `-100${clean.replace(/^-/, "")}`;
  return clean;
}

// Helper: Forward Log Messages
async function forwardToLogsChannel(text) {
  if (!BOT_TOKEN || !db) return;
  try {
    let channelId = null;
    const cfgSnap = await db.collection("settings").doc("config").get();
    if (cfgSnap.exists && cfgSnap.data().logs_channel) channelId = cfgSnap.data().logs_channel;
    if (!channelId) {
      const chSnap = await db.collection("settings").doc("logs_channel").get();
      if (chSnap.exists && chSnap.data().channel_id) channelId = chSnap.data().channel_id;
    }
    if (!channelId) channelId = process.env.LOG_CHANNEL_ID;
    if (!channelId) return;

    channelId = formatChannelId(channelId);
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: channelId, text: text, parse_mode: "HTML" })
    });
  } catch (e) {}
}

// Helper: Format User Name & Link
function formatUserLink(user) {
  const name = `${user.first_name || ""} ${user.last_name || ""}`.trim() || user.username || "User";
  if (user.username) return `@${user.username}`;
  return `<a href="tg://user?id=${user.id}">${name}</a> [<code>${user.id}</code>]`;
}

// ==========================================
// 1. /START COMMAND (WITH REFERRAL HANDLING)
// ==========================================
bot.start(async (ctx) => {
  try {
    const from = ctx.from;
    const userId = String(from.id);
    const username = (from.username || `user${userId}`).toLowerCase().replace(/[^a-z0-9_]/g, "");
    const firstName = from.first_name || "";
    const lastName = from.last_name || "";

    // Extract start payload (e.g. /start ref_123456789 or /start 123456789)
    const rawPayload = ctx.message?.text?.split(" ")[1] || "";
    let referrerId = "";
    if (rawPayload.startsWith("ref_")) {
      referrerId = rawPayload.replace(/^ref_/, "").trim();
    } else if (/^\d+$/.test(rawPayload)) {
      referrerId = rawPayload.trim();
    }

    if (!db) {
      return ctx.reply("⚡ Welcome to Pheizu Lightning Wallet!", Markup.inlineKeyboard([
        [Markup.button.webApp("⚡ Open Wallet", `${WEBAPP_URL}/?telegram_id=${userId}&username=${username}`)]
      ]));
    }

    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();
    let isNewUser = !userDoc.exists;

    // Process Referral if new user and referrer is valid
    if (isNewUser && referrerId && referrerId !== userId) {
      try {
        const referrerRef = db.collection("users").doc(referrerId);
        const referrerDoc = await referrerRef.get();

        if (referrerDoc.exists && !referrerDoc.data().banned) {
          const batch = db.batch();

          // 1. Reward the Referrer
          batch.set(referrerRef, {
            balance: admin.firestore.FieldValue.increment(REFERRAL_REWARD_SATS),
            sats: admin.firestore.FieldValue.increment(REFERRAL_REWARD_SATS),
            referral_count: admin.firestore.FieldValue.increment(1),
            referral_earnings: admin.firestore.FieldValue.increment(REFERRAL_REWARD_SATS),
            updated_at: new Date().toISOString()
          }, { merge: true });

          // 2. Record Referral Log
          const refLogRef = db.collection("referrals").doc(`${referrerId}_${userId}`);
          batch.set(refLogRef, {
            referrer_id: referrerId,
            referred_user_id: userId,
            referred_username: username,
            reward_sats: REFERRAL_REWARD_SATS,
            created_at: new Date().toISOString()
          });

          await batch.commit();

          // Notify Referrer via Telegram
          await ctx.telegram.sendMessage(
            referrerId,
            `🎉 <b>New Referral Joined!</b>\n\n` +
            `👤 User ${formatUserLink(from)} joined using your link.\n` +
            `💰 <b>+${REFERRAL_REWARD_SATS} SATS</b> credited to your balance!`,
            { parse_mode: "HTML" }
          ).catch(() => {});

          // Send to Channel Logs
          await forwardToLogsChannel(
            `👥 <b>New Referral Registered</b>\n\n` +
            `• Referrer: <code>${referrerId}</code>\n` +
            `• New User: ${formatUserLink(from)}\n` +
            `• Reward: +${REFERRAL_REWARD_SATS} SATS`
          );
        }
      } catch (err) {
        console.error("Referral process error:", err);
      }
    }

    // Save/Update User Profile
    await userRef.set({
      user_id: userId,
      telegram_id: userId,
      username: username,
      first_name: firstName,
      last_name: lastName,
      referred_by: (isNewUser && referrerId && referrerId !== userId) ? referrerId : (userDoc.data()?.referred_by || null),
      updated_at: new Date().toISOString(),
      ...(isNewUser ? {
        balance: 0,
        sats: 0,
        usdt_balance: 0,
        usdc_balance: 0,
        banned: false,
        created_at: new Date().toISOString()
      } : {})
    }, { merge: true });

    // Open WebApp URL
    const appUrl = `${WEBAPP_URL}/?telegram_id=${userId}&username=${encodeURIComponent(username)}&first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}`;

    const welcomeText = 
      `⚡ <b>Welcome to Pheizu Lightning Wallet!</b>\n\n` +
      `Instant Bitcoin Lightning & Multi-Chain Stablecoin Wallet built for Telegram.\n\n` +
      `• ⚡ Zero-Fee Lightning Deposits\n` +
      `• 💎 Instant USDT & USDC Settlements\n` +
      `• 🔗 Your Lightning Address: <code>${username}@${DOMAIN}</code>\n\n` +
      `Tap below to open your wallet:`;

    return ctx.replyWithHTML(welcomeText, Markup.inlineKeyboard([
      [Markup.button.webApp("⚡ Launch Wallet", appUrl)],
      [Markup.button.callback("🎁 Invite Friends & Earn", "cmd_referral")]
    ]));
  } catch (e) {
    console.error("Bot Start Error:", e);
    return ctx.reply("⚡ Welcome to Pheizu Wallet! Please tap below to open:", Markup.inlineKeyboard([
      [Markup.button.webApp("⚡ Open Wallet", `${WEBAPP_URL}/?telegram_id=${ctx.from.id}`)]
    ]));
  }
});

// ==========================================
// 2. REFERRAL SYSTEM & INVITE LINK COMMAND
// ==========================================
async function sendReferralDashboard(ctx) {
  try {
    const from = ctx.from;
    const userId = String(from.id);
    const botInfo = await ctx.telegram.getMe();
    const botUsername = botInfo.username;

    // Correct Working Telegram Referral Link
    const referralLink = `https://t.me/${botUsername}?start=ref_${userId}`;

    let refCount = 0;
    let refEarnings = 0;

    if (db) {
      const uDoc = await db.collection("users").doc(userId).get();
      if (uDoc.exists) {
        refCount = Number(uDoc.data().referral_count || 0);
        refEarnings = Number(uDoc.data().referral_earnings || 0);
      }
    }

    const refMessage =
      `🎁 <b>Invite Friends & Earn Free SATS!</b>\n\n` +
      `Share your personal referral link with friends. For every friend who joins, you receive <b>${REFERRAL_REWARD_SATS} Satoshis</b> instantly.\n\n` +
      `📊 <b>Your Referral Stats:</b>\n` +
      `• Total Friends Invited: <b>${refCount}</b>\n` +
      `• Total SATS Earned: <b>${refEarnings.toLocaleString()} SATS</b>\n\n` +
      `🔗 <b>Your Exclusive Invite Link:</b>\n` +
      `<code>${referralLink}</code>`;

    const shareText = encodeURIComponent(`⚡ Join Pheizu Lightning Wallet on Telegram and get your personal Lightning Address!`);
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${shareText}`;

    return ctx.replyWithHTML(refMessage, Markup.inlineKeyboard([
      [Markup.button.url("🚀 Share Link with Friends", shareUrl)],
      [Markup.button.webApp("⚡ Open Wallet", `${WEBAPP_URL}/?telegram_id=${userId}`)]
    ]));
  } catch (err) {
    console.error("Referral Command Error:", err);
    return ctx.reply("Failed to generate referral link. Please try again.");
  }
}

// Commands & Action Handlers
bot.command("invite", sendReferralDashboard);
bot.command("referral", sendReferralDashboard);
bot.command("ref", sendReferralDashboard);
bot.action("cmd_referral", sendReferralDashboard);

// Help Command
bot.command("help", (ctx) => {
  return ctx.replyWithHTML(
    `📖 <b>Pheizu Wallet Commands:</b>\n\n` +
    `/start - Open Wallet & Menu\n` +
    `/invite - Get your Referral Link & Stats\n` +
    `/help - View this help guide`
  );
});

// ==========================================
// VERCEL SERVERLESS HANDLER
// ==========================================
module.exports = async (req, res) => {
  try {
    if (req.method === "POST") {
      await bot.handleUpdate(req.body);
      return res.status(200).json({ ok: true });
    }
    return res.status(200).send("Pheizu Telegram Bot Webhook Active.");
  } catch (err) {
    console.error("Webhook processing error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
