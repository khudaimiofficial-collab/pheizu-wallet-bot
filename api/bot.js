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
const REQUIRED_CHANNEL = process.env.REQUIRED_CHANNEL || process.env.LOG_CHANNEL_ID || "";
const REFERRAL_REWARD_SATS = 5; // 5 SATS reward upon 20 sats spend

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

// Helper: Get Configured Channel ID
async function getConfiguredChannel() {
  if (db) {
    try {
      const cfgSnap = await db.collection("settings").doc("config").get();
      if (cfgSnap.exists && cfgSnap.data().logs_channel) return cfgSnap.data().logs_channel;
      const chSnap = await db.collection("settings").doc("logs_channel").get();
      if (chSnap.exists && chSnap.data().channel_id) return chSnap.data().channel_id;
    } catch (e) {}
  }
  return REQUIRED_CHANNEL;
}

// Helper: Check if user is in required Telegram channel
async function checkChannelMembership(ctx, userId) {
  try {
    const channelId = formatChannelId(await getConfiguredChannel());
    if (!channelId) return true;

    const member = await ctx.telegram.getChatMember(channelId, Number(userId));
    return ["creator", "administrator", "member", "restricted"].includes(member.status);
  } catch (err) {
    console.warn("Membership check warning:", err.message);
    return true;
  }
}

// Helper: Forward Log Messages
async function forwardToLogsChannel(text) {
  if (!BOT_TOKEN || !db) return;
  try {
    const channelId = formatChannelId(await getConfiguredChannel());
    if (!channelId) return;

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
// 1. /START COMMAND
// ==========================================
bot.start(async (ctx) => {
  try {
    const from = ctx.from;
    const userId = String(from.id);
    const username = (from.username || `user${userId}`).toLowerCase().replace(/[^a-z0-9_]/g, "");
    const firstName = from.first_name || "";
    const lastName = from.last_name || "";

    // ⚡ Dynamically detect bot username via Telegram API
    const botInfo = await ctx.telegram.getMe();
    const botUsername = botInfo.username || "";

    // Extract start payload (e.g. /start ref_123456789)
    const rawPayload = ctx.message?.text?.split(" ")[1] || "";
    let referrerId = "";
    if (rawPayload.startsWith("ref_")) {
      referrerId = rawPayload.replace(/^ref_/, "").trim();
    } else if (/^\d+$/.test(rawPayload)) {
      referrerId = rawPayload.trim();
    }

    // 1. Verify Channel Membership
    const isMember = await checkChannelMembership(ctx, userId);
    if (!isMember) {
      const channelId = formatChannelId(await getConfiguredChannel());
      const inviteUrl = channelId.startsWith("-100") ? `https://t.me/c/${channelId.replace("-100", "")}` : `https://t.me/${channelId.replace("@", "")}`;

      return ctx.replyWithHTML(
        `⚠️ <b>Channel Membership Required</b>\n\n` +
        `To use Pheizu Lightning Wallet and participate in rewards, you must first join our official channel.\n\n` +
        `1️⃣ Join the channel below\n` +
        `2️⃣ Tap <b>Verify Membership</b>`,
        Markup.inlineKeyboard([
          [Markup.button.url("📢 Join Channel", inviteUrl)],
          [Markup.button.callback("✅ Verify Membership", `verify_join_${referrerId || "none"}`)]
        ])
      );
    }

    // 2. Register/Update User & Pending Referral in Firestore
    if (db) {
      const userRef = db.collection("users").doc(userId);
      const userDoc = await userRef.get();
      const isNewUser = !userDoc.exists;

      if (isNewUser && referrerId && referrerId !== userId) {
        const referrerDoc = await db.collection("users").doc(referrerId).get();
        if (referrerDoc.exists) {
          await db.collection("referrals").doc(`${referrerId}_${userId}`).set({
            referrer_id: referrerId,
            referred_user_id: userId,
            referred_username: username,
            status: "pending",
            required_spend_sats: 20,
            reward_sats: REFERRAL_REWARD_SATS,
            channel_verified: true,
            created_at: new Date().toISOString()
          }, { merge: true });
        }
      }

      await userRef.set({
        user_id: userId,
        telegram_id: userId,
        username: username,
        first_name: firstName,
        last_name: lastName,
        channel_verified: true,
        bot_username: botUsername,
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

      // Save global bot username in config
      if (botUsername) {
        await db.collection("settings").doc("config").set({ bot_username: botUsername }, { merge: true });
      }
    }

    // Pass detected bot_username directly to MiniApp
    const appUrl = `${WEBAPP_URL}/?telegram_id=${userId}&username=${encodeURIComponent(username)}&first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}&bot_username=${encodeURIComponent(botUsername)}`;
    const adminUrl = `${WEBAPP_URL}/admin.html?telegram_id=${userId}&username=${encodeURIComponent(username)}`;
    const isAdmin = await isAuthorizedAdmin(userId, username);

    const keyboardRows = [
      [Markup.button.webApp("⚡ Open Lightning Wallet", appUrl)],
      [
        Markup.button.callback("👤 Account Details", "cmd_account"),
        Markup.button.callback("🎁 Invite & Earn 5 SATS", "cmd_referral")
      ]
    ];

    if (isAdmin) {
      keyboardRows.push([Markup.button.webApp("👑 Admin Console", adminUrl)]);
    }

    const welcomeText = 
      `⚡ <b>Welcome to Pheizu Lightning Wallet!</b>\n\n` +
      `Instant Bitcoin Lightning & Multi-Chain Stablecoin Wallet built for Telegram.\n\n` +
      `• ⚡ Zero-Fee Lightning Deposits\n` +
      `• 💎 Instant USDT & USDC Settlements\n` +
      `• 🔗 Your Lightning Address:\n<code>${username}@${DOMAIN}</code>\n\n` +
      `• 🎁 <b>Referral Program:</b> Invite friends and earn <b>5 SATS</b> when they send at least 20 SATS!\n\n` +
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
// 2. VERIFY MEMBERSHIP CALLBACK
// ==========================================
bot.action(/verify_join_(.+)/, async (ctx) => {
  const referrerId = ctx.match[1] === "none" ? "" : ctx.match[1];
  const userId = String(ctx.from.id);

  const isMember = await checkChannelMembership(ctx, userId);
  if (!isMember) {
    return ctx.answerCbQuery("❌ You haven't joined the channel yet. Please join and try again!", { show_alert: true });
  }

  await ctx.answerCbQuery("✅ Membership Verified!");
  ctx.message.text = `/start ${referrerId ? `ref_${referrerId}` : ''}`;
  return bot.handleUpdate({
    ...ctx.update,
    message: {
      ...ctx.message,
      text: `/start ${referrerId ? `ref_${referrerId}` : ''}`,
      from: ctx.from,
      chat: ctx.chat
    }
  });
});

// ==========================================
// 3. ACCOUNT DETAILS HANDLER
// ==========================================
async function sendAccountDetails(ctx) {
  try {
    const from = ctx.from;
    const userId = String(from.id);
    const username = (from.username || `user${userId}`).toLowerCase().replace(/[^a-z0-9_]/g, "");

    const botInfo = await ctx.telegram.getMe();
    const botUsername = botInfo.username || "";

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

    const appUrl = `${WEBAPP_URL}/?telegram_id=${userId}&username=${encodeURIComponent(username)}&bot_username=${encodeURIComponent(botUsername)}`;

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
      [Markup.button.callback("🎁 Invite Friends (+5 SATS)", "cmd_referral")]
    ]));
  } catch (err) {
    return ctx.reply("Failed to load account details.");
  }
}

// ==========================================
// 4. INVITE FRIENDS (+5 SATS) HANDLER
// ==========================================
async function sendReferralDashboard(ctx) {
  try {
    const from = ctx.from;
    const userId = String(from.id);
    const botInfo = await ctx.telegram.getMe();
    const botUsername = botInfo.username;

    // Dynamically detected working referral link
    const referralLink = `https://t.me/${botUsername}?start=ref_${userId}`;

    let verifiedCount = 0;
    let pendingCount = 0;
    let refEarnings = 0;

    if (db) {
      const uDoc = await db.collection("users").doc(userId).get();
      if (uDoc.exists) {
        refEarnings = Number(uDoc.data().referral_earnings || 0);
      }

      const snap = await db.collection("referrals").where("referrer_id", "==", userId).get();
      snap.forEach(d => {
        if (d.data().status === "completed") verifiedCount++;
        else pendingCount++;
      });
    }

    const refMessage =
      `🎁 <b>Invite Friends & Earn Free SATS!</b>\n\n` +
      `Share your personal referral link with friends. For every friend who joins, verifies membership, and sends at least <b>20 SATS</b>, you receive <b>${REFERRAL_REWARD_SATS} SATS</b> instantly!\n\n` +
      `📊 <b>Your Referral Statistics:</b>\n` +
      `• Verified Referrals: <b>${verifiedCount}</b>\n` +
      `• Pending Referrals: <b>${pendingCount}</b>\n` +
      `• Total SATS Earned: <b>${refEarnings.toLocaleString()} SATS</b>\n\n` +
      `🔗 <b>Your Exclusive Invite Link:</b>\n` +
      `<code>${referralLink}</code>`;

    const shareText = encodeURIComponent(`⚡ Join Pheizu Lightning Wallet on Telegram and get your personal Lightning Address!`);
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${shareText}`;

    return ctx.replyWithHTML(refMessage, Markup.inlineKeyboard([
      [Markup.button.url("🚀 Share Link on Telegram", shareUrl)],
      [Markup.button.callback("👤 View Account Details", "cmd_account")]
    ]));
  } catch (err) {
    console.error("Referral Error:", err);
    return ctx.reply("Failed to generate referral link.");
  }
}

// Commands & Handlers
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
    `/invite - Invite Friends & Earn 5 SATS\n` +
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
