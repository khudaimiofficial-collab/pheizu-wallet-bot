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
const DOMAIN = "pheizu-wallet-bot.vercel.app";
const MASTER_ADMIN_ID = "8960497898";
const REFERRAL_REWARD_SATS = 1; // 1 SAT per valid referral

const bot = new Telegraf(BOT_TOKEN);

// Helper: Format Channel ID
function formatChannelId(raw) {
  if (!raw) return "";
  let clean = String(raw).trim();
  if (/^\d{8,16}$/.test(clean)) return `-100${clean}`;
  if (/^-\d{8,16}$/.test(clean) && !clean.startsWith("-100")) return `-100${clean.replace(/^-/, "")}`;
  return clean;
}

// Helper: Check if user is an admin
async function isAuthorizedAdmin(telegramId, username) {
  const numId = String(telegramId || "").trim();
  const uname = String(username || "").toLowerCase().replace(/^@/, "").trim();
  if (numId === MASTER_ADMIN_ID || uname === "pheizu") return true;

  if (db) {
    try {
      const snap = await db.collection("settings").doc("admins").get();
      if (snap.exists) {
        const list = (snap.data().list || []).map(a => String(a).toLowerCase().replace(/^@/, ""));
        if (list.includes(numId) || (uname && list.includes(uname))) return true;
      }
    } catch (e) {}
  }
  return false;
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
// 1. /START COMMAND (WITH ALL 3 BUTTONS)
// ==========================================
bot.start(async (ctx) => {
  try {
    const from = ctx.from;
    const userId = String(from.id);
    const username = (from.username || `user${userId}`).toLowerCase().replace(/[^a-z0-9_]/g, "");
    const firstName = from.first_name || "";
    const lastName = from.last_name || "";

    // Extract start payload (e.g. /start ref_123456789)
    const rawPayload = ctx.message?.text?.split(" ")[1] || "";
    let referrerId = "";
    if (rawPayload.startsWith("ref_")) {
      referrerId = rawPayload.replace(/^ref_/, "").trim();
    } else if (/^\d+$/.test(rawPayload)) {
      referrerId = rawPayload.trim();
    }

    let isNewUser = true;
    if (db) {
      const userRef = db.collection("users").doc(userId);
      const userDoc = await userRef.get();
      isNewUser = !userDoc.exists;

      // Handle referral bonus if newly joining
      if (isNewUser && referrerId && referrerId !== userId) {
        try {
          const referrerRef = db.collection("users").doc(referrerId);
          const referrerDoc = await referrerRef.get();

          if (referrerDoc.exists && !referrerDoc.data().banned) {
            const batch = db.batch();

            // 1. Credit 1 SAT to referrer
            batch.set(referrerRef, {
              balance: admin.firestore.FieldValue.increment(REFERRAL_REWARD_SATS),
              sats: admin.firestore.FieldValue.increment(REFERRAL_REWARD_SATS),
              referral_count: admin.firestore.FieldValue.increment(1),
              referral_earnings: admin.firestore.FieldValue.increment(REFERRAL_REWARD_SATS),
              updated_at: new Date().toISOString()
            }, { merge: true });

            // 2. Record referral event
            const refLogRef = db.collection("referrals").doc(`${referrerId}_${userId}`);
            batch.set(refLogRef, {
              referrer_id: referrerId,
              referred_user_id: userId,
              referred_username: username,
              reward_sats: REFERRAL_REWARD_SATS,
              created_at: new Date().toISOString()
            });

            await batch.commit();

            // Notify Referrer
            await ctx.telegram.sendMessage(
              referrerId,
              `🎉 <b>New Referral Joined!</b>\n\n` +
              `👤 User ${formatUserLink(from)} joined via your link.\n` +
              `💰 <b>+${REFERRAL_REWARD_SATS} SAT</b> credited to your wallet balance!`,
              { parse_mode: "HTML" }
            ).catch(() => {});

            // Send Log
            await forwardToLogsChannel(
              `👥 <b>Referral Registered</b>\n\n` +
              `• Referrer: <code>${referrerId}</code>\n` +
              `• New User: ${formatUserLink(from)}\n` +
              `• Reward: +${REFERRAL_REWARD_SATS} SAT`
            );
          }
        } catch (err) {
          console.error("Referral process error:", err);
        }
      }

      // Save User Data
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
    }

    const appUrl = `${WEBAPP_URL}/?telegram_id=${userId}&username=${encodeURIComponent(username)}&first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}`;
    const adminUrl = `${WEBAPP_URL}/admin.html?telegram_id=${userId}&username=${encodeURIComponent(username)}`;
    const isAdmin = await isAuthorizedAdmin(userId, username);

    // Build Action Keyboard
    const keyboardRows = [
      [Markup.button.webApp("⚡ Open Lightning Wallet", appUrl)],
      [
        Markup.button.callback("👤 Account Details", "cmd_account"),
        Markup.button.callback("🎁 Invite Friends (+1 SAT)", "cmd_referral")
      ]
    ];

    // Conditionally attach Admin Button only to authorized users
    if (isAdmin) {
      keyboardRows.push([Markup.button.webApp("👑 Admin Console", adminUrl)]);
    }

    const welcomeText = 
      `⚡ <b>Welcome to Pheizu Lightning Wallet!</b>\n\n` +
      `Instant Bitcoin Lightning & Multi-Chain Stablecoin Wallet built for Telegram.\n\n` +
      `• ⚡ Zero-Fee Lightning Deposits\n` +
      `• 💎 Instant USDT & USDC Settlements\n` +
      `• 🔗 Your Lightning Address:\n<code>${username}@${DOMAIN}</code>\n\n` +
      `Choose an option below:`;

    return ctx.replyWithHTML(welcomeText, Markup.inlineKeyboard(keyboardRows));
  } catch (e) {
    console.error("Bot Start Error:", e);
    return ctx.reply("⚡ Welcome to Pheizu Wallet! Tap below to open:", Markup.inlineKeyboard([
      [Markup.button.webApp("⚡ Open Wallet", `${WEBAPP_URL}/?telegram_id=${ctx.from.id}`)]
    ]));
  }
});

// ==========================================
// 2. ACCOUNT DETAILS BUTTON HANDLER
// ==========================================
async function sendAccountDetails(ctx) {
  try {
    const from = ctx.from;
    const userId = String(from.id);
    const username = (from.username || `user${userId}`).toLowerCase().replace(/[^a-z0-9_]/g, "");

    let sats = 0;
    let usdt = 0;
    let usdc = 0;

    if (db) {
      const uDoc = await db.collection("users").doc(userId).get();
      if (uDoc.exists) {
        const d = uDoc.data();
        sats = Number(d.balance ?? d.sats ?? 0);
        usdt = Number(d.usdt_balance ?? d.usdt ?? 0);
        usdc = Number(d.usdc_balance ?? d.usdc ?? 0);
      }
    }

    const appUrl = `${WEBAPP_URL}/?telegram_id=${userId}&username=${encodeURIComponent(username)}`;

    const msg =
      `👤 <b>Your Account Details:</b>\n\n` +
      `• <b>Name:</b> ${from.first_name || ""} ${from.last_name || ""}\n` +
      `• <b>Username:</b> ${from.username ? `@${from.username}` : "Not Set"}\n` +
      `• <b>Telegram ID:</b> <code>${userId}</code>\n` +
      `• <b>Lightning Address:</b>\n<code>${username}@${DOMAIN}</code>\n\n` +
      `💰 <b>Current Balances:</b>\n` +
      `• <b>Bitcoin:</b> ${sats.toLocaleString()} SATS (${(sats / 100000000).toFixed(8)} BTC)\n` +
      `• <b>USDT:</b> $${usdt.toFixed(2)}\n` +
      `• <b>USDC:</b> $${usdc.toFixed(2)}`;

    return ctx.replyWithHTML(msg, Markup.inlineKeyboard([
      [Markup.button.webApp("⚡ Open Wallet", appUrl)],
      [Markup.button.callback("🎁 Invite Friends (+1 SAT)", "cmd_referral")]
    ]));
  } catch (err) {
    return ctx.reply("Failed to load account details.");
  }
}

// ==========================================
// 3. INVITE FRIENDS (+1 SAT) BUTTON HANDLER
// ==========================================
async function sendReferralDashboard(ctx) {
  try {
    const from = ctx.from;
    const userId = String(from.id);
    const botInfo = await ctx.telegram.getMe();
    const botUsername = botInfo.username;

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
      `🎁 <b>Invite Friends & Earn Free Bitcoin!</b>\n\n` +
      `Share your personal referral link with friends. For every friend who joins, you receive <b>${REFERRAL_REWARD_SATS} SAT</b> credited to your balance instantly.\n\n` +
      `📊 <b>Your Referral Statistics:</b>\n` +
      `• Friends Invited: <b>${refCount}</b>\n` +
      `• Total Earned: <b>${refEarnings.toLocaleString()} SATS</b>\n\n` +
      `🔗 <b>Your Exclusive Invite Link:</b>\n` +
      `<code>${referralLink}</code>`;

    const shareText = encodeURIComponent(`⚡ Join Pheizu Lightning Wallet on Telegram and get your personal Lightning Address!`);
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${shareText}`;

    return ctx.replyWithHTML(refMessage, Markup.inlineKeyboard([
      [Markup.button.url("🚀 Share Link on Telegram", shareUrl)],
      [Markup.button.callback("👤 View Account Details", "cmd_account")]
    ]));
  } catch (err) {
    return ctx.reply("Failed to generate referral link.");
  }
}

// Callback queries and commands
bot.action("cmd_account", sendAccountDetails);
bot.action("cmd_referral", sendReferralDashboard);
bot.command("account", sendAccountDetails);
bot.command("invite", sendReferralDashboard);
bot.command("referral", sendReferralDashboard);
bot.command("ref", sendReferralDashboard);

// Help Command
bot.command("help", (ctx) => {
  return ctx.replyWithHTML(
    `📖 <b>Pheizu Wallet Commands:</b>\n\n` +
    `/start - Main Wallet Menu\n` +
    `/account - View Account Details & Balances\n` +
    `/invite - Invite Friends & Earn 1 SAT\n` +
    `/help - View this guide`
  );
});

// Vercel Serverless Handler
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
