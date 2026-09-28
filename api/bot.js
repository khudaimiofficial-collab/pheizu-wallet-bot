const { Telegraf, Markup } = require("telegraf");
const admin = require("firebase-admin");

// ----------------------------------------------------
// 1. FIREBASE INITIALIZATION
// ----------------------------------------------------
if (!admin.apps.length) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      let sa = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
      if (!sa.startsWith("{")) {
        sa = Buffer.from(sa, "base64").toString("utf8");
      }
      const parsed = typeof sa === "string" ? JSON.parse(sa) : sa;
      if (parsed.private_key) {
        parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
      }
      admin.initializeApp({
        credential: admin.credential.cert(parsed)
      });
    } else if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
        })
      });
    } else {
      admin.initializeApp();
    }
  } catch (e) {
    console.error("Firebase init error in bot:", e.message);
  }
}

const db = admin.apps.length ? admin.firestore() : null;
const bot = new Telegraf(process.env.BOT_TOKEN);

const DOMAIN = "pheizu-wallet-bot.vercel.app";
const APP_URL = process.env.WEBAPP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `https://${DOMAIN}`);
const MASTER_ADMIN_ID = "8960497898";

// ----------------------------------------------------
// NATIVE TELEGRAM MENU & COMMAND CONFIGURATION
// ----------------------------------------------------

// Set Telegram WebApp Menu Button (bottom-left next to text input)
bot.telegram.setChatMenuButton({
  menuButton: {
    type: "web_app",
    text: "⚡ Wallet",
    web_app: { url: APP_URL }
  }
}).catch(() => {});

// Clear all slash commands from the "/" autocomplete menu to keep chat 100% clean
bot.telegram.deleteMyCommands().catch(() => {});

// ----------------------------------------------------
// HELPERS: ADMIN & CHANNEL VERIFICATION
// ----------------------------------------------------

async function isAuthorizedAdmin(ctx) {
  if (!ctx || !ctx.from) return false;
  const numericId = String(ctx.from.id).trim();
  const username = (ctx.from.username || "").toLowerCase().replace(/^@/, "").trim();

  if (numericId === MASTER_ADMIN_ID) return true;

  const rawAdmins = (process.env.ADMIN_IDS || process.env.ADMIN_ID || "");
  const envAdmins = rawAdmins
    .split(",")
    .map(id => id.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);

  if (envAdmins.includes(numericId) || (username && envAdmins.includes(username))) {
    return true;
  }

  if (db) {
    try {
      const doc = await db.collection("settings").doc("admins").get();
      if (doc.exists) {
        const list = (doc.data().list || []).map(a => String(a).toLowerCase().replace(/^@/, ""));
        if (list.includes(numericId) || (username && list.includes(username))) {
          return true;
        }
      }
    } catch (e) {}
  }

  return false;
}

// Fetch configured logs/required channel from Firestore or Environment
async function getRequiredChannelId() {
  if (db) {
    try {
      const snap = await db.collection("settings").doc("logs_channel").get();
      if (snap.exists && snap.data().channel_id) {
        return String(snap.data().channel_id).trim();
      }
    } catch (e) {}
  }
  return (process.env.LOG_CHANNEL_ID || process.env.REQUIRED_CHANNEL || process.env.CHANNEL_ID || "").trim();
}

// Generate the invite link for the channel
async function getChannelInviteLink(channelId) {
  if (!channelId) return "https://t.me";
  try {
    const chat = await bot.telegram.getChat(channelId);
    if (chat.username) return `https://t.me/${chat.username}`;
    if (chat.invite_link) return chat.invite_link;
    const link = await bot.telegram.exportChatInviteLink(channelId);
    return link;
  } catch (e) {
    if (String(channelId).startsWith("@")) {
      return `https://t.me/${String(channelId).replace(/^@/, "")}`;
    }
    return process.env.CHANNEL_LINK || "https://t.me";
  }
}

// Check if user is a member of the required channel
async function checkUserMembership(userId, channelId) {
  if (!channelId) return true;
  try {
    const member = await bot.telegram.getChatMember(channelId, userId);
    return ["creator", "administrator", "member", "restricted"].includes(member.status);
  } catch (e) {
    console.warn("Membership check warning:", e.message);
    if (e.message.includes("user not found") || e.message.includes("PARTICIPANT_ID_INVALID")) {
      return false;
    }
    return true;
  }
}

// Save user data to Firestore
async function saveUserRecord(ctx) {
  if (!db || !ctx.from) return;
  const user = ctx.from;
  const userId = String(user.username || user.id).toLowerCase();
  try {
    await db.collection("users").doc(userId).set({
      user_id: userId,
      telegram_id: String(user.id),
      username: user.username || null,
      first_name: user.first_name || "",
      last_active: new Date().toISOString()
    }, { merge: true });
  } catch (e) {}
}

// ----------------------------------------------------
// UI SCREENS: JOIN CHANNEL vs WALLET LAUNCH
// ----------------------------------------------------

// 1. Show Join Channel Prompt (If Unverified)
async function sendJoinPrompt(ctx, channelLink) {
  const text = [
    `🔒 <b>Channel Verification Required</b>\n`,
    `To access <b>Pheizu Lightning Wallet</b>, you must first join our official updates and transaction receipt channel.\n`,
    `1️⃣ Click <b>📢 Join Channel</b> below.`,
    `2️⃣ Return here and click <b>✅ Verify & Start</b>.`
  ].join("\n");

  const kb = Markup.inlineKeyboard([
    [Markup.button.url("📢 Join Channel", channelLink)],
    [Markup.button.callback("✅ Verify & Start", "verify_membership")]
  ]);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: "HTML", ...kb }).catch(() => {});
  } else {
    // Remove any leftover reply keyboard from user's screen
    await ctx.replyWithHTML(text, { ...kb, ...Markup.removeKeyboard() });
  }
}

// 2. Show Welcome & Launch Wallet (Once Verified)
async function sendWelcomeScreen(ctx) {
  await saveUserRecord(ctx);

  const user = ctx.from;
  const tgId = String(user.id);
  const username = (user.username || `user${tgId}`).toLowerCase().replace(/[^a-z0-9_]/g, "");
  const isAdm = await isAuthorizedAdmin(ctx);

  const walletUrl = `${APP_URL}/?telegram_id=${tgId}&username=${encodeURIComponent(username)}`;
  const adminUrl = `${APP_URL}/admin.html?telegram_id=${tgId}&username=${encodeURIComponent(username)}`;

  const buttons = [
    [Markup.button.webApp("⚡ Open Pheizu Wallet", walletUrl)]
  ];

  // If user is Admin, add dedicated Admin Console button
  if (isAdm) {
    buttons.push([Markup.button.webApp("👑 Open Admin Console", adminUrl)]);
  }

  const welcomeText = [
    `⚡ <b>Welcome to Pheizu Lightning Wallet!</b>\n`,
    `Your fast, non-custodial crypto wallet directly inside Telegram.\n`,
    `• <b>Assets:</b> Bitcoin (Lightning & On-Chain), USDT (TON, TRC-20, Solana, ERC-20), USDC`,
    `• <b>Lightning Address:</b> <code>${username}@${DOMAIN}</code>\n`,
    `Tap the button below to open your wallet:`
  ].join("\n");

  const kb = Markup.inlineKeyboard(buttons);

  if (ctx.callbackQuery) {
    await ctx.deleteMessage().catch(() => {});
    await ctx.replyWithHTML(welcomeText, { ...kb, ...Markup.removeKeyboard() });
  } else {
    await ctx.replyWithHTML(welcomeText, { ...kb, ...Markup.removeKeyboard() });
  }
}

// ----------------------------------------------------
// BOT CONTROLLER
// ----------------------------------------------------

// /start command
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const channelId = await getRequiredChannelId();

  if (channelId) {
    const isMember = await checkUserMembership(userId, channelId);
    if (!isMember) {
      const inviteLink = await getChannelInviteLink(channelId);
      return sendJoinPrompt(ctx, inviteLink);
    }
  }

  return sendWelcomeScreen(ctx);
});

// "✅ Verify & Start" Button Callback
bot.action("verify_membership", async (ctx) => {
  const userId = ctx.from.id;
  const channelId = await getRequiredChannelId();

  if (!channelId) {
    await ctx.answerCbQuery("✅ Verified! Welcome.");
    return sendWelcomeScreen(ctx);
  }

  const isMember = await checkUserMembership(userId, channelId);

  if (!isMember) {
    return ctx.answerCbQuery(
      "❌ You have not joined the channel yet!\n\nPlease join the channel first, then tap Verify.",
      { show_alert: true }
    );
  }

  await ctx.answerCbQuery("✅ Verification successful! Welcome.");
  return sendWelcomeScreen(ctx);
});

// Any other text message or command: Guide user to verify or open wallet
bot.on("message", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const channelId = await getRequiredChannelId();
  if (channelId) {
    const isMember = await checkUserMembership(userId, channelId);
    if (!isMember) {
      const inviteLink = await getChannelInviteLink(channelId);
      return sendJoinPrompt(ctx, inviteLink);
    }
  }

  return sendWelcomeScreen(ctx);
});

// ----------------------------------------------------
// VERCEL SERVERLESS EXPORT
// ----------------------------------------------------
module.exports = async (req, res) => {
  try {
    if (req.method === "POST") {
      await bot.handleUpdate(req.body);
    }
    res.status(200).send("OK");
  } catch (err) {
    console.error("Bot Handler Error:", err);
    res.status(500).send("Internal Server Error");
  }
};
