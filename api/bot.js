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
const BOT_USERNAME = process.env.BOT_USERNAME || "pheizu_bot";

// ----------------------------------------------------
// NATIVE TELEGRAM MENU & COMMAND CONFIGURATION
// ----------------------------------------------------

// 1. By default, ensure the global menu button is DEFAULT (no Open Wallet button for strangers)
bot.telegram.callApi("setChatMenuButton", {
  menu_button: { type: "default" }
}).catch(() => {});

// 2. Clear all slash commands from the "/" autocomplete menu
bot.telegram.deleteMyCommands().catch(() => {});

// Helper: Set or Remove the Telegram Chat Menu Button per-user
async function setMenuButtonForUser(chatId, isVerified, walletUrl = "") {
  try {
    if (!isVerified) {
      // Hide the Open Wallet button from the bottom-left bar
      await bot.telegram.callApi("setChatMenuButton", {
        chat_id: chatId,
        menu_button: { type: "default" }
      });
    } else {
      // Show the Open Wallet button ONLY after verification
      await bot.telegram.callApi("setChatMenuButton", {
        chat_id: chatId,
        menu_button: {
          type: "web_app",
          text: "⚡ Wallet",
          web_app: { url: walletUrl }
        }
      });
    }
  } catch (e) {
    console.warn("Could not set chat menu button:", e.message);
  }
}

// ----------------------------------------------------
// HELPERS: ADMIN, BALANCES & CHANNEL VERIFICATION
// ----------------------------------------------------

async function isAuthorizedAdmin(ctx) {
  if (!ctx || !ctx.from) return false;
  const numericId = String(ctx.from.id).trim();
  const username = (ctx.from.username || "").toLowerCase().replace(/^@/, "").trim();

  if (numericId === MASTER_ADMIN_ID || username === "pheizu") return true;

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

async function getUserBalances(userId, telegramId) {
  if (!db) return { sats: 0, usdt: 0, usdc: 0 };
  try {
    const candidates = [userId, telegramId, telegramId ? `user${telegramId}` : null].filter(Boolean);
    for (const col of ["users", "wallets"]) {
      for (const id of candidates) {
        const doc = await db.collection(col).doc(String(id).toLowerCase()).get();
        if (doc.exists) {
          const d = doc.data();
          const sats = Number(d.balance ?? d.sats ?? d.amount ?? 0);
          const usdt = Number(d.usdt_balance ?? 0);
          const usdc = Number(d.usdc_balance ?? 0);
          return { sats, usdt, usdc };
        }
      }
    }
  } catch (e) {}
  return { sats: 0, usdt: 0, usdc: 0 };
}

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

async function checkUserMembership(userId, channelId) {
  if (!channelId) return true;
  try {
    const member = await bot.telegram.getChatMember(channelId, userId);
    return ["creator", "administrator", "member", "restricted"].includes(member.status);
  } catch (e) {
    if (e.message.includes("user not found") || e.message.includes("PARTICIPANT_ID_INVALID")) {
      return false;
    }
    return true;
  }
}

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
// UI SCREENS: CHANNEL PROMPT, MAIN MENU & ACCOUNT DETAILS
// ----------------------------------------------------

// 1. Channel Join Prompt (If Unverified)
async function sendJoinPrompt(ctx, channelLink) {
  const userId = ctx.from.id;
  
  // 🔥 Ensure Open Wallet is REMOVED from the chat menu bar
  await setMenuButtonForUser(userId, false);

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
    await ctx.replyWithHTML(text, kb);
  }
}

// 2. Main Menu: Wallet, Account, Share & Admin (If Admin)
async function sendMainMenu(ctx) {
  await saveUserRecord(ctx);

  const user = ctx.from;
  const tgId = String(user.id);
  const username = (user.username || `user${tgId}`).toLowerCase().replace(/[^a-z0-9_]/g, "");
  const isAdm = await isAuthorizedAdmin(ctx);

  const walletUrl = `${APP_URL}/?telegram_id=${tgId}&username=${encodeURIComponent(username)}`;
  const adminUrl = `${APP_URL}/admin.html?telegram_id=${tgId}&username=${encodeURIComponent(username)}`;

  // 🔥 User is verified: Enable the Open Wallet menu button in bottom-left
  await setMenuButtonForUser(tgId, true, walletUrl);

  const shareText = encodeURIComponent("⚡ Pay & receive Bitcoin and Stablecoins instantly with zero fees on Pheizu Lightning Wallet!");
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(`https://t.me/${BOT_USERNAME}?start=ref_${username}`)}&text=${shareText}`;

  const buttons = [
    [Markup.button.webApp("⚡ Open Pheizu Wallet", walletUrl)],
    [
      Markup.button.callback("👤 Account Details", "menu_account_details"),
      Markup.button.url("🔗 Invite Friends", shareUrl)
    ]
  ];

  if (isAdm) {
    buttons.push([Markup.button.webApp("👑 Open Admin Console", adminUrl)]);
  }

  const welcomeText = [
    `⚡ <b>Pheizu Lightning Wallet</b>\n`,
    `Your high-speed non-custodial crypto wallet built directly into Telegram.\n`,
    `• <b>Assets:</b> Bitcoin (Lightning & On-Chain), USDT (TON, TRC-20, Solana, ERC-20), USDC`,
    `• <b>Lightning Address:</b> <code>${username}@${DOMAIN}</code>\n`,
    isAdm ? `👑 <b>Administrator Mode:</b> Active\n\n` : ``,
    `Choose an option below to get started:`
  ].join("\n");

  const kb = Markup.inlineKeyboard(buttons);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(welcomeText, { parse_mode: "HTML", ...kb });
    } catch (e) {
      await ctx.deleteMessage().catch(() => {});
      await ctx.replyWithHTML(welcomeText, kb);
    }
  } else {
    await ctx.replyWithHTML(welcomeText, kb);
  }
}

// 3. Account Details Screen
async function sendAccountDetails(ctx) {
  const user = ctx.from;
  const tgId = String(user.id);
  const username = (user.username || `user${tgId}`).toLowerCase().replace(/[^a-z0-9_]/g, "");
  const isAdm = await isAuthorizedAdmin(ctx);

  const bal = await getUserBalances(username, tgId);
  const btcVal = (bal.sats / 100000000).toFixed(8);
  const myLnAddress = `${username}@${DOMAIN}`;

  const walletUrl = `${APP_URL}/?telegram_id=${tgId}&username=${encodeURIComponent(username)}`;
  const adminUrl = `${APP_URL}/admin.html?telegram_id=${tgId}&username=${encodeURIComponent(username)}`;

  const text = [
    `👤 <b>Your Account Details</b>\n`,
    `• <b>Username:</b> @${username}`,
    `• <b>Telegram ID:</b> <code>${tgId}</code>`,
    `• <b>Lightning Address:</b>\n<code>${myLnAddress}</code>\n`,
    `💰 <b>Available Balances:</b>`,
    `• ₿ <b>Bitcoin:</b> <code>${btcVal} BTC</code> (${bal.sats.toLocaleString()} SATS)`,
    `• 💵 <b>USDT:</b> <code>$${bal.usdt.toFixed(2)}</code>`,
    `• 💲 <b>USDC:</b> <code>$${bal.usdc.toFixed(2)}</code>\n`,
    `⚡ <b>Settlement:</b> Pheizu Lightning Network Node`,
    isAdm ? `👑 <b>Role:</b> Administrator` : `👤 <b>Role:</b> Standard User`
  ].join("\n");

  const buttons = [
    [Markup.button.webApp("⚡ Launch Full Wallet", walletUrl)]
  ];

  if (isAdm) {
    buttons.push([Markup.button.webApp("👑 Open Admin Console", adminUrl)]);
  }

  buttons.push([Markup.button.callback("🔙 Back to Main Menu", "menu_back_main")]);

  const kb = Markup.inlineKeyboard(buttons);

  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", ...kb });
  } catch (e) {
    await ctx.replyWithHTML(text, kb);
  }
}

// ----------------------------------------------------
// BOT CONTROLLER & CALLBACKS
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

  return sendMainMenu(ctx);
});

// /admin command
bot.command("admin", async (ctx) => {
  const isAdm = await isAuthorizedAdmin(ctx);
  if (!isAdm) {
    return ctx.reply("⛔ Access denied: You are not an authorized administrator.");
  }

  const user = ctx.from;
  const tgId = String(user.id);
  const username = (user.username || `user${tgId}`).toLowerCase().replace(/[^a-z0-9_]/g, "");
  const adminUrl = `${APP_URL}/admin.html?telegram_id=${tgId}&username=${encodeURIComponent(username)}`;

  await ctx.replyWithHTML(
    `👑 <b>Pheizu Administrator Console</b>\n\nTap below to launch the admin management dashboard:`,
    Markup.inlineKeyboard([
      [Markup.button.webApp("👑 Open Admin Console", adminUrl)]
    ])
  );
});

// /id command
bot.command("id", async (ctx) => {
  const isAdm = await isAuthorizedAdmin(ctx);
  const uid = ctx.from.id;
  const uname = ctx.from.username ? `@${ctx.from.username}` : "none";

  await ctx.replyWithHTML(
    `🆔 <b>Your Account Info:</b>\n\n` +
    `• <b>Numeric ID:</b> <code>${uid}</code>\n` +
    `• <b>Username:</b> ${uname}\n` +
    `• <b>Admin Status:</b> ${isAdm ? "✅ <b>Authorized Admin</b>" : "❌ Regular User"}`
  );
});

// "✅ Verify & Start" Button Callback
bot.action("verify_membership", async (ctx) => {
  const userId = ctx.from.id;
  const channelId = await getRequiredChannelId();

  if (!channelId) {
    await ctx.answerCbQuery("✅ Verified! Welcome.");
    return sendMainMenu(ctx);
  }

  const isMember = await checkUserMembership(userId, channelId);

  if (!isMember) {
    await setMenuButtonForUser(userId, false);
    return ctx.answerCbQuery(
      "❌ You have not joined the channel yet!\n\nPlease join the channel first, then tap Verify.",
      { show_alert: true }
    );
  }

  await ctx.answerCbQuery("✅ Verification successful! Welcome.");
  return sendMainMenu(ctx);
});

// "👤 Account Details" Callback
bot.action("menu_account_details", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return sendAccountDetails(ctx);
});

// "🔙 Back to Main Menu" Callback
bot.action("menu_back_main", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return sendMainMenu(ctx);
});

// Fallback message listener
bot.on("message", async (ctx) => {
  const text = (ctx.message?.text || "").toLowerCase().trim();

  if (text === "/admin" || text === "admin") {
    const isAdm = await isAuthorizedAdmin(ctx);
    if (isAdm) {
      const tgId = String(ctx.from.id);
      const username = (ctx.from.username || `user${tgId}`).toLowerCase().replace(/[^a-z0-9_]/g, "");
      const adminUrl = `${APP_URL}/admin.html?telegram_id=${tgId}&username=${encodeURIComponent(username)}`;
      return ctx.replyWithHTML(
        `👑 <b>Pheizu Administrator Console</b>`,
        Markup.inlineKeyboard([[Markup.button.webApp("👑 Open Admin Console", adminUrl)]])
      );
    }
  }

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

  return sendMainMenu(ctx);
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
