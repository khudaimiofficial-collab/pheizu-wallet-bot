const { Telegraf, Markup } = require("telegraf");
const admin = require("firebase-admin");

// 1. Firebase Initialization
if (!admin.apps.length) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
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
const APP_URL = process.env.WEBAPP_URL || `https://${DOMAIN}`;
const MASTER_ADMIN_ID = "8960497898"; // Your Master Admin ID

const SAT_TO_USD = 0.00065;
const activeWatchers = new Map();

// Helper: Check if user is an authorized admin
async function isAuthorizedAdmin(ctx) {
  if (!ctx || !ctx.from) return false;
  const numericId = String(ctx.from.id).trim();
  const username = (ctx.from.username || "").toLowerCase().replace(/^@/, "").trim();

  // Master Admin
  if (numericId === MASTER_ADMIN_ID) return true;

  // ENV variables
  const rawAdmins = (process.env.ADMIN_IDS || process.env.ADMIN_ID || "");
  const envAdmins = rawAdmins
    .split(",")
    .map(id => id.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);

  if (envAdmins.includes(numericId) || (username && envAdmins.includes(username))) {
    return true;
  }

  // Firestore admins
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

// Direct Firestore Balance Fetch (Zero latency, no fragile HTTP roundtrips)
async function getDirectBalance(userId, telegramId) {
  if (!db) return 0;
  try {
    const candidates = [userId, telegramId, telegramId ? `user${telegramId}` : null].filter(Boolean);
    for (const col of ["users", "wallets"]) {
      for (const id of candidates) {
        const doc = await db.collection(col).doc(String(id).toLowerCase()).get();
        if (doc.exists) {
          const b = doc.data().balance ?? doc.data().sats ?? doc.data().amount;
          if (b !== undefined && b !== null) return Number(b) || 0;
        }
      }
    }
  } catch (e) {
    console.error("Direct balance fetch error:", e.message);
  }
  return 0;
}

// Persistent Reply Keyboard
async function getMainKeyboard(ctx) {
  const rows = [
    ["💰 Balance", "📥 Deposit"],
    ["📤 Withdraw", "📜 History"]
  ];

  if (await isAuthorizedAdmin(ctx)) {
    rows.push(["👑 Admin Panel"]);
  }

  return Markup.keyboard(rows).resize();
}

// Withdrawal Options Keyboard
function getQuickWithdrawKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("⚡ SATS (Lightning)", "with_net_sats_lightning"),
      Markup.button.callback("₿ BTC (On-Chain)", "with_net_sats_onchain")
    ],
    [
      Markup.button.callback("🔴 USDT (TRC-20)", "with_net_usdt_tron"),
      Markup.button.callback("🟣 USDC (Solana)", "with_net_usdc_solana")
    ],
    [Markup.button.callback("🔙 Back to Main Menu", "gateway_back")]
  ]);
}

// Deposit Asset Keyboard
function getDepositAssetKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⚡ Bitcoin (SATS)", "dep_asset_sats")],
    [
      Markup.button.callback("💵 USDT", "dep_asset_usdt"),
      Markup.button.callback("💲 USDC", "dep_asset_usdc")
    ],
    [Markup.button.callback("🔙 Back", "gateway_back")]
  ]);
}

// Deposit Network Keyboards
function getUsdtDepositNetworks() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("⚡ Lightning", "dep_net_usdt_lightning"),
      Markup.button.callback("⛓️ Ethereum", "dep_net_usdt_ethereum")
    ],
    [
      Markup.button.callback("🔴 Tron", "dep_net_usdt_tron"),
      Markup.button.callback("🟣 Solana", "dep_net_usdt_solana")
    ],
    [Markup.button.callback("💎 TON", "dep_net_usdt_ton")],
    [Markup.button.callback("🔙 Back to Assets", "dep_back_to_assets")]
  ]);
}

function getUsdcDepositNetworks() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("⚡ Lightning", "dep_net_usdc_lightning"),
      Markup.button.callback("⛓️ Ethereum", "dep_net_usdc_ethereum")
    ],
    [Markup.button.callback("🟣 Solana", "dep_net_usdc_solana")],
    [Markup.button.callback("🔙 Back to Assets", "dep_back_to_assets")]
  ]);
}

function getSatsDepositNetworks() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("⚡ Lightning", "dep_net_sats_lightning"),
      Markup.button.callback("₿ On-Chain", "dep_net_sats_onchain")
    ],
    [Markup.button.callback("🔙 Back to Assets", "dep_back_to_assets")]
  ]);
}

// Admin Keyboards
function getAdminDashboardKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("👤 Manage Users", "admin_users_menu"),
      Markup.button.callback("📢 Broadcast", "admin_broadcast_prompt")
    ],
    [
      Markup.button.callback("📋 Logs Channel", "admin_logs_prompt"),
      Markup.button.callback("👑 Admins (Add/Del)", "admin_admins_menu")
    ],
    [
      Markup.button.callback("🔑 Set Speed Key", "admin_setkey_prompt"),
      Markup.button.callback("❌ Close", "admin_close")
    ]
  ]);
}

function getAdminUserManagementKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🚫 Ban User", "adm_ban_user"),
      Markup.button.callback("✅ Unban User", "adm_unban_user")
    ],
    [
      Markup.button.callback("➕ Add Balance", "adm_add_bal"),
      Markup.button.callback("➖ Deduct Balance", "adm_deduct_bal")
    ],
    [
      Markup.button.callback("🗑️ Delete User", "adm_del_user"),
      Markup.button.callback("🔙 Back to Admin", "admin_main_dashboard")
    ]
  ]);
}

function getAdminAdminsKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("➕ Add Admin", "adm_add_admin"),
      Markup.button.callback("➖ Delete Admin", "adm_del_admin")
    ],
    [
      Markup.button.callback("📋 List Admins", "adm_list_admins"),
      Markup.button.callback("🔙 Back to Admin", "admin_main_dashboard")
    ]
  ]);
}

// Session Helpers
async function getSession(userId) {
  if (!db) return {};
  try {
    const doc = await db.collection("bot_sessions").doc(String(userId)).get();
    return doc.exists ? doc.data() : {};
  } catch (e) {
    return {};
  }
}

async function setSession(userId, data) {
  if (!db) return;
  try {
    await db.collection("bot_sessions").doc(String(userId)).set(data, { merge: true });
  } catch (e) {}
}

async function clearSession(userId) {
  if (!db) return;
  try {
    await db.collection("bot_sessions").doc(String(userId)).delete();
  } catch (e) {}
}

function stopDepositWatcher(chatId) {
  const id = String(chatId);
  if (activeWatchers.has(id)) {
    clearInterval(activeWatchers.get(id));
    activeWatchers.delete(id);
  }
}

// Forward to Telegram Logs Channel
async function forwardToLogsChannel(text) {
  if (!db || !process.env.BOT_TOKEN) return;
  try {
    const snap = await db.collection("settings").doc("logs_channel").get();
    if (snap.exists && snap.data().channel_id) {
      const channelId = snap.data().channel_id;
      await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: channelId,
          text: `📋 <b>Wallet Event:</b>\n\n${text}`,
          parse_mode: "HTML"
        })
      });
    }
  } catch (e) {}
}

// Format My Wallet Screen
async function getWalletOverviewText(userId, telegramId, isAdm) {
  const sats = await getDirectBalance(userId, telegramId);
  const satsUsd = (sats * SAT_TO_USD).toFixed(2);
  const totalUsd = satsUsd;
  const adminBadge = isAdm ? "👑 <b>Admin Mode:</b> Active\n" : "";

  return (
    `💳 <b>My Wallet</b>\n\n` +
    adminBadge +
    `⚡ <b>SATS:</b> <code>${sats.toLocaleString()} SATS</code> (${satsUsd}$)\n` +
    `₿ <b>BTC:</b> <code>${(sats / 100000000).toFixed(8)} BTC</code> (${satsUsd}$)\n` +
    `💵 <b>USDT:</b> <code>0.0000 USDT</code> (0.00$)\n` +
    `💲 <b>USDC:</b> <code>0.0000 USDC</code> (0.00$)\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💵 <b>Total:</b> <code>${totalUsd}$</code>\n\n` +
    `⚡ <b>Lightning Address:</b> <code>${userId}@${DOMAIN}</code>\n` +
    `📌 <b>Minimum Deposit:</b> 1 sat`
  );
}

// Decode BOLT-11 Sats
function decodeBolt11Sats(invoice) {
  const clean = invoice.trim().toLowerCase().replace(/^lightning:/, "");
  const match = clean.match(/^ln(?:bc|tb|bcrt)([0-9]+)([munp]?)/);
  if (!match) return null;

  const val = parseInt(match[1], 10);
  const multiplier = match[2];

  if (!multiplier) return val * 100000000;
  if (multiplier === "m") return Math.round(val * 100000);
  if (multiplier === "u") return Math.round(val * 100);
  if (multiplier === "n") return Math.round(val * 0.1);
  if (multiplier === "p") return Math.round(val * 0.0001);
  return null;
}

// Background poller for deposits
function startDepositWatcher(chatId, paymentId, expectedAmount, targetUserId) {
  stopDepositWatcher(chatId);
  let attempts = 0;
  const maxAttempts = 60;

  const timer = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) {
      stopDepositWatcher(chatId);
      return;
    }

    try {
      const res = await fetch(`${APP_URL}/api/wallet?action=check-status&payment_id=${paymentId}&user_id=${targetUserId}&telegram_id=${chatId}`);
      const data = await res.json();

      if (data && data.is_paid) {
        stopDepositWatcher(chatId);
        const amount = data.amount || expectedAmount;
        const txId = data.tx_id || paymentId;
        const curr = data.currency || "SATS";

        const currentBal = await getDirectBalance(targetUserId, chatId);

        await bot.telegram.sendMessage(
          chatId,
          `🎉 <b>Payment Received!</b>\n\n` +
          `⚡ <b>+${amount} ${curr}</b> credited to your balance!\n` +
          `💰 <b>New Balance:</b> ${currentBal.toLocaleString()} sats\n` +
          `🆔 <b>TxID:</b> <code>${txId}</code>`,
          { parse_mode: "HTML" }
        );

        forwardToLogsChannel(
          `📥 <b>Deposit Confirmed</b>\n` +
          `• User: @${targetUserId}\n` +
          `• Amount: +${amount} ${curr}\n` +
          `• TxID: <code>${txId}</code>`
        );
      }
    } catch (e) {}
  }, 3000);

  activeWatchers.set(String(chatId), timer);
}

// Ban check helper
async function isUserBanned(userId, numericId) {
  if (!db) return false;
  try {
    const doc1 = await db.collection("users").doc(String(userId)).get();
    if (doc1.exists && doc1.data().banned) return true;
    if (numericId) {
      const doc2 = await db.collection("users").doc(String(numericId)).get();
      if (doc2.exists && doc2.data().banned) return true;
    }
  } catch (e) {}
  return false;
}

// ----------------------------------------------------
// 0. /id COMMAND - PRIVACY CLEAN
// ----------------------------------------------------
bot.command("id", async (ctx) => {
  const uid = ctx.from.id;
  const uname = ctx.from.username ? `@${ctx.from.username}` : "none";
  const isAdm = await isAuthorizedAdmin(ctx);

  if (isAdm) {
    return ctx.reply(
      `🆔 <b>Admin Information:</b>\n\n` +
      `• <b>Numeric ID:</b> <code>${uid}</code>\n` +
      `• <b>Username:</b> ${uname}\n` +
      `• <b>Admin Status:</b> ✅ <b>YES (Authorized Admin)</b>`,
      { parse_mode: "HTML" }
    );
  }

  return ctx.reply(
    `🆔 <b>Your Account Info:</b>\n\n` +
    `• <b>User ID:</b> <code>${uid}</code>\n` +
    `• <b>Username:</b> ${uname}`,
    { parse_mode: "HTML" }
  );
});

// ----------------------------------------------------
// 1. /START
// ----------------------------------------------------
bot.start(async (ctx) => {
  stopDepositWatcher(ctx.from.id);
  await clearSession(ctx.from.id);

  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  if (await isUserBanned(userId, ctx.from.id)) {
    return ctx.reply("⛔ Your account has been suspended.");
  }

  if (db) {
    await db.collection("users").doc(userId).set({
      user_id: userId,
      telegram_id: String(ctx.from.id),
      username: ctx.from.username || null,
      updated_at: new Date().toISOString()
    }, { merge: true });
  }

  await ctx.replyWithChatAction("typing");
  const isAdm = await isAuthorizedAdmin(ctx);
  const walletText = await getWalletOverviewText(userId, ctx.from.id, isAdm);
  const kb = await getMainKeyboard(ctx);

  await ctx.reply(walletText, {
    parse_mode: "HTML",
    ...kb
  });
});

// ----------------------------------------------------
// 2. 💰 BALANCE
// ----------------------------------------------------
bot.hears("💰 Balance", async (ctx) => {
  stopDepositWatcher(ctx.from.id);
  await clearSession(ctx.from.id);

  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  if (await isUserBanned(userId, ctx.from.id)) {
    return ctx.reply("⛔ Your account has been suspended.");
  }

  await ctx.replyWithChatAction("typing");
  const isAdm = await isAuthorizedAdmin(ctx);
  const walletText = await getWalletOverviewText(userId, ctx.from.id, isAdm);

  await ctx.reply(walletText, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      Markup.button.webApp("📱 Open WebApp", APP_URL)
    ])
  });
});

// ----------------------------------------------------
// 3. 📜 HISTORY
// ----------------------------------------------------
bot.hears("📜 History", async (ctx) => {
  stopDepositWatcher(ctx.from.id);
  await clearSession(ctx.from.id);

  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  await ctx.replyWithChatAction("typing");

  try {
    const res = await fetch(`${APP_URL}/api/wallet?action=history&user_id=${encodeURIComponent(userId)}&telegram_id=${ctx.from.id}`);
    const data = await res.json();

    if (!data.success || !data.history || data.history.length === 0) {
      return ctx.reply(`📜 <b>Transaction History</b>\n\nNo transactions found yet.`, { parse_mode: "HTML" });
    }

    let msg = `📜 <b>Recent Transactions:</b>\n\n`;
    data.history.forEach((tx) => {
      const date = tx.created_at ? new Date(tx.created_at).toISOString().replace("T", " ").substring(0, 16) : "Recent";
      const curr = tx.currency || "SATS";
      const amt = tx.amount;
      const txId = tx.tx_id || tx.id || "N/A";

      if (tx.type === "deposit") msg += `📥 <b>Deposit:</b> +${amt} ${curr}\n`;
      else if (tx.type === "withdrawal" || tx.type === "instant_send") msg += `📤 <b>Withdrawal:</b> -${amt} ${curr}\n`;
      else if (tx.type === "transfer_sent") msg += `⚡ <b>Sent to:</b> @${tx.to || "user"} (-${amt} ${curr})\n`;
      else if (tx.type === "transfer_received") msg += `⚡ <b>Received from:</b> @${tx.from || "user"} (+${amt} ${curr})\n`;
      else msg += `🔄 <b>Transfer:</b> ${amt} ${curr}\n`;

      msg += `📅 <code>${date} UTC</code>\n🆔 <code>${txId}</code>\n─────────────────────\n`;
    });

    await ctx.reply(msg, { parse_mode: "HTML" });
  } catch (e) {
    ctx.reply("⚠️ Could not load history.");
  }
});

// ----------------------------------------------------
// 4. 📥 DEPOSIT
// ----------------------------------------------------
bot.hears("📥 Deposit", async (ctx) => {
  stopDepositWatcher(ctx.from.id);
  await clearSession(ctx.from.id);

  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  if (await isUserBanned(userId, ctx.from.id)) {
    return ctx.reply("⛔ Your account has been suspended.");
  }

  await ctx.reply(`🔥 <b>Select a Deposit Asset:</b> 🔥`, {
    parse_mode: "HTML",
    ...getDepositAssetKeyboard()
  });
});

// ----------------------------------------------------
// 5. 📤 WITHDRAW (FIXED: ZERO LATENCY & INSTANT READY)
// ----------------------------------------------------
bot.hears("📤 Withdraw", async (ctx) => {
  stopDepositWatcher(ctx.from.id);
  await clearSession(ctx.from.id);

  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  if (await isUserBanned(userId, ctx.from.id)) {
    return ctx.reply("⛔ Your account has been suspended.");
  }

  await ctx.replyWithChatAction("typing");
  const balance = await getDirectBalance(userId, ctx.from.id);

  // Ready session for destination input immediately
  await setSession(ctx.from.id, {
    step: "awaiting_withdraw_dest",
    balance: balance,
    target_currency: "SATS"
  });

  const balanceNotice = balance <= 0
    ? `⚠️ <i>Note: Your balance is currently 0 sats. You need funds to withdraw.</i>\n\n`
    : ``;

  await ctx.reply(
    `📤 <b>Withdraw / Send Funds</b>\n` +
    `💰 Available Balance: <b>${balance.toLocaleString()} sats</b>\n\n` +
    balanceNotice +
    `👉 <b>Instant Withdraw:</b>\n` +
    `Paste any <b>Lightning Invoice</b> (<code>lnbc...</code>), <b>Lightning Address</b>, or <b>Crypto Address</b> directly here.\n` +
    `<i>(The bot will auto-detect the network & amount)</i>\n\n` +
    `Or choose a specific network below:`,
    {
      parse_mode: "HTML",
      ...getQuickWithdrawKeyboard()
    }
  );
});

// ----------------------------------------------------
// 6. 👑 ADMIN PANEL MENU
// ----------------------------------------------------
bot.hears("👑 Admin Panel", async (ctx) => {
  if (!(await isAuthorizedAdmin(ctx))) {
    return ctx.reply("⛔ Access denied: You are not authorized.");
  }

  stopDepositWatcher(ctx.from.id);
  await clearSession(ctx.from.id);

  await ctx.reply(
    `👑 <b>Administrator Control Panel</b>\n\nSelect an administration module below:`,
    {
      parse_mode: "HTML",
      ...getAdminDashboardKeyboard()
    }
  );
});

bot.command("admin", async (ctx) => {
  if (!(await isAuthorizedAdmin(ctx))) return ctx.reply("⛔ Access denied.");
  await ctx.reply(`👑 <b>Admin Control Panel:</b>`, {
    parse_mode: "HTML",
    ...getAdminDashboardKeyboard()
  });
});

// ----------------------------------------------------
// CALLBACK ACTIONS: WITHDRAWAL QUICK BUTTONS
// ----------------------------------------------------
bot.action("with_net_sats_lightning", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const balance = await getDirectBalance(userId, ctx.from.id);

  await setSession(ctx.from.id, { 
    step: "awaiting_withdraw_dest",
    target_currency: "SATS",
    withdraw_method: "lightning",
    balance 
  });

  await ctx.editMessageText(
    `⚡ <b>Withdraw SATS (Lightning Network)</b>\n` +
    `Available: <b>${balance.toLocaleString()} sats</b>\n\n` +
    `Paste the recipient's <b>Lightning Invoice</b> (<code>lnbc...</code>) or <b>Lightning Address</b> (e.g. <code>name@speed.app</code>):`,
    { parse_mode: "HTML" }
  );
});

bot.action("with_net_sats_onchain", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const balance = await getDirectBalance(userId, ctx.from.id);

  await setSession(ctx.from.id, { 
    step: "awaiting_withdraw_dest",
    target_currency: "SATS",
    withdraw_method: "onchain",
    balance,
    min_amount: 1000
  });

  await ctx.editMessageText(
    `₿ <b>Bitcoin On-Chain Withdrawal (Min: 1,000 SATS):</b>\n` +
    `Available: <b>${balance.toLocaleString()} sats</b>\n\n` +
    `Paste your Bitcoin On-Chain destination address (<code>bc1...</code> or <code>1...</code>):`,
    { parse_mode: "HTML" }
  );
});

bot.action("with_net_usdt_tron", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await setSession(ctx.from.id, { 
    step: "awaiting_withdraw_dest",
    target_currency: "USDT",
    withdraw_method: "tron",
    min_amount: 0.5
  });
  await ctx.editMessageText(`🔴 <b>USDT (Tron - TRC20) Withdrawal:</b>\n\nPaste your Tron destination address (<code>T...</code>):`, { parse_mode: "HTML" });
});

bot.action("with_net_usdc_solana", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await setSession(ctx.from.id, { 
    step: "awaiting_withdraw_dest",
    target_currency: "USDC",
    withdraw_method: "solana",
    min_amount: 0.5
  });
  await ctx.editMessageText(`🟣 <b>USDC (Solana) Withdrawal:</b>\n\nPaste your Solana destination address:`, { parse_mode: "HTML" });
});

bot.action("gateway_back", async (ctx) => {
  stopDepositWatcher(ctx.from.id);
  await clearSession(ctx.from.id);
  await ctx.answerCbQuery().catch(() => {});
  await ctx.deleteMessage().catch(() => {});
  const kb = await getMainKeyboard(ctx);
  await ctx.reply("🔙 Returned to main menu.", kb);
});

// ----------------------------------------------------
// DEPOSIT CALLBACK ACTIONS
// ----------------------------------------------------
bot.action("dep_back_to_assets", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageText(`🔥 <b>Select a Deposit Asset:</b> 🔥`, { parse_mode: "HTML", ...getDepositAssetKeyboard() });
});

bot.action("dep_asset_usdt", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageText(`🔥 <b>Select USDT Network:</b> 🔥`, { parse_mode: "HTML", ...getUsdtDepositNetworks() });
});

bot.action("dep_asset_usdc", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageText(`🔥 <b>Select USDC Network:</b> 🔥`, { parse_mode: "HTML", ...getUsdcDepositNetworks() });
});

bot.action("dep_asset_sats", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageText(`🔥 <b>Select Bitcoin Network:</b> 🔥`, { parse_mode: "HTML", ...getSatsDepositNetworks() });
});

bot.action("dep_net_usdt_lightning", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  await setSession(ctx.from.id, { step: "awaiting_deposit_amount", target_currency: "USDT", payment_method: "lightning", min_amount: 0.5 });
  await ctx.editMessageText(`⚡ <b>Deposit USDT (Lightning)</b>\nAddress: <code>${userId}@${DOMAIN}</code>\n\nReply with amount (Min: 0.5 USDT):`, { parse_mode: "HTML" });
});

bot.action("dep_net_usdt_ethereum", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await setSession(ctx.from.id, { step: "awaiting_deposit_amount", target_currency: "USDT", payment_method: "ethereum", min_amount: 0.5 });
  await ctx.editMessageText(`⛓️ <b>Deposit USDT (Ethereum - ERC20)</b>\nReply with amount (Min: 0.5 USDT):`, { parse_mode: "HTML" });
});

bot.action("dep_net_usdt_tron", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await setSession(ctx.from.id, { step: "awaiting_deposit_amount", target_currency: "USDT", payment_method: "tron", min_amount: 0.5 });
  await ctx.editMessageText(`🔴 <b>Deposit USDT (Tron - TRC20)</b>\nReply with amount (Min: 0.5 USDT):`, { parse_mode: "HTML" });
});

bot.action("dep_net_usdt_solana", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await setSession(ctx.from.id, { step: "awaiting_deposit_amount", target_currency: "USDT", payment_method: "solana", min_amount: 0.5 });
  await ctx.editMessageText(`🟣 <b>Deposit USDT (Solana)</b>\nReply with amount (Min: 0.5 USDT):`, { parse_mode: "HTML" });
});

bot.action("dep_net_usdt_ton", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await setSession(ctx.from.id, { step: "awaiting_deposit_amount", target_currency: "USDT", payment_method: "ton", min_amount: 0.5 });
  await ctx.editMessageText(`💎 <b>Deposit USDT (TON)</b>\nReply with amount (Min: 0.5 USDT):`, { parse_mode: "HTML" });
});

bot.action("dep_net_usdc_lightning", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await setSession(ctx.from.id, { step: "awaiting_deposit_amount", target_currency: "USDC", payment_method: "lightning", min_amount: 0.5 });
  await ctx.editMessageText(`⚡ <b>Deposit USDC (Lightning)</b>\nReply with amount (Min: 0.5 USDC):`, { parse_mode: "HTML" });
});

bot.action("dep_net_usdc_ethereum", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await setSession(ctx.from.id, { step: "awaiting_deposit_amount", target_currency: "USDC", payment_method: "ethereum", min_amount: 0.5 });
  await ctx.editMessageText(`⛓️ <b>Deposit USDC (Ethereum)</b>\nReply with amount (Min: 0.5 USDC):`, { parse_mode: "HTML" });
});

bot.action("dep_net_usdc_solana", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await setSession(ctx.from.id, { step: "awaiting_deposit_amount", target_currency: "USDC", payment_method: "solana", min_amount: 0.5 });
  await ctx.editMessageText(`🟣 <b>Deposit USDC (Solana)</b>\nReply with amount (Min: 0.5 USDC):`, { parse_mode: "HTML" });
});

bot.action("dep_net_sats_lightning", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  await setSession(ctx.from.id, { step: "awaiting_deposit_amount", target_currency: "SATS", payment_method: "lightning", min_amount: 1 });
  await ctx.editMessageText(`⚡ <b>Deposit SATS (Lightning)</b>\nAddress: <code>${userId}@${DOMAIN}</code>\n\nReply with sats (Min: 1 sat):`, { parse_mode: "HTML" });
});

bot.action("dep_net_sats_onchain", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await setSession(ctx.from.id, { step: "awaiting_deposit_amount", target_currency: "SATS", payment_method: "onchain", min_amount: 1000 });
  await ctx.editMessageText(`₿ <b>Deposit Bitcoin (On-Chain)</b>\nReply with amount in sats (Min: 1,000 sats):`, { parse_mode: "HTML" });
});

// ----------------------------------------------------
// ADMIN ACTIONS
// ----------------------------------------------------
bot.action("admin_main_dashboard", async (ctx) => {
  if (!(await isAuthorizedAdmin(ctx))) return ctx.answerCbQuery("Unauthorized");
  await ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageText(`👑 <b>Admin Control Panel:</b>`, { parse_mode: "HTML", ...getAdminDashboardKeyboard() });
});

bot.action("admin_close", async (ctx) => {
  await clearSession(ctx.from.id);
  await ctx.answerCbQuery().catch(() => {});
  await ctx.deleteMessage().catch(() => {});
});

bot.action("admin_users_menu", async (ctx) => {
  if (!(await isAuthorizedAdmin(ctx))) return ctx.answerCbQuery("Unauthorized");
  await ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageText(`👤 <b>User Management Module:</b>`, { parse_mode: "HTML", ...getAdminUserManagementKeyboard() });
});

bot.action("admin_admins_menu", async (ctx) => {
  if (!(await isAuthorizedAdmin(ctx))) return ctx.answerCbQuery("Unauthorized");
  await ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageText(`👑 <b>Admin Management Module:</b>`, { parse_mode: "HTML", ...getAdminAdminsKeyboard() });
});

bot.action("adm_ban_user", async (ctx) => {
  if (!(await isAuthorizedAdmin(ctx))) return ctx.answerCbQuery("Unauthorized");
  await setSession(ctx.from.id, { step: "adm_input_ban_user" });
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply("🚫 <b>Ban User:</b>\nSend Username or Numeric ID to ban:", { parse_mode: "HTML" });
});

bot.action("adm_unban_user", async (ctx) => {
  if (!(await isAuthorizedAdmin(ctx))) return ctx.answerCbQuery("Unauthorized");
  await setSession(ctx.from.id, { step: "adm_input_unban_user" });
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply("✅ <b>Unban User:</b>\nSend Username or Numeric ID to unban:", { parse_mode: "HTML" });
});

bot.action("adm_del_user", async (ctx) => {
  if (!(await isAuthorizedAdmin(ctx))) return ctx.answerCbQuery("Unauthorized");
  await setSession(ctx.from.id, { step: "adm_input_del_user" });
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply("🗑️ <b>Delete User:</b>\nSend Username or Numeric ID to delete permanently:", { parse_mode: "HTML" });
});

bot.action("adm_add_bal", async (ctx) => {
  if (!(await isAuthorizedAdmin(ctx))) return ctx.answerCbQuery("Unauthorized");
  await setSession(ctx.from.id, { step: "adm_input_add_bal_target" });
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply("➕ <b>Add Balance:</b>\nSend Username or Numeric ID:", { parse_mode: "HTML" });
});

bot.action("adm_deduct_bal", async (ctx) => {
  if (!(await isAuthorizedAdmin(ctx))) return ctx.answerCbQuery("Unauthorized");
  await setSession(ctx.from.id, { step: "adm_input_deduct_bal_target" });
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply("➖ <b>Deduct Balance:</b>\nSend Username or Numeric ID:", { parse_mode: "HTML" });
});

bot.action("admin_broadcast_prompt", async (ctx) => {
  if (!(await isAuthorizedAdmin(ctx))) return ctx.answerCbQuery("Unauthorized");
  await setSession(ctx.from.id, { step: "adm_input_broadcast" });
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply("📢 <b>Broadcast:</b>\nSend the message to deliver to all bot users:", { parse_mode: "HTML" });
});

bot.action("admin_logs_prompt", async (ctx) => {
  if (!(await isAuthorizedAdmin(ctx))) return ctx.answerCbQuery("Unauthorized");
  await setSession(ctx.from.id, { step: "adm_input_logs_channel" });
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply("📋 <b>Set Logs Channel:</b>\nSend the Channel ID (e.g. <code>-1001234567890</code>):", { parse_mode: "HTML" });
});

bot.action("adm_add_admin", async (ctx) => {
  if (!(await isAuthorizedAdmin(ctx))) return ctx.answerCbQuery("Unauthorized");
  await setSession(ctx.from.id, { step: "adm_input_add_admin" });
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply("➕ <b>Add Co-Admin:</b>\nSend the Numeric ID or @username:", { parse_mode: "HTML" });
});

bot.action("adm_del_admin", async (ctx) => {
  if (!(await isAuthorizedAdmin(ctx))) return ctx.answerCbQuery("Unauthorized");
  await setSession(ctx.from.id, { step: "adm_input_del_admin" });
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply("➖ <b>Remove Co-Admin:</b>\nSend the Numeric ID or @username to remove:", { parse_mode: "HTML" });
});

bot.action("adm_list_admins", async (ctx) => {
  if (!(await isAuthorizedAdmin(ctx))) return ctx.answerCbQuery("Unauthorized");
  await ctx.answerCbQuery().catch(() => {});

  let adminList = [`• Master Admin: <code>${MASTER_ADMIN_ID}</code>`];
  if (db) {
    const doc = await db.collection("settings").doc("admins").get();
    if (doc.exists) {
      (doc.data().list || []).forEach(a => adminList.push(`• Co-Admin: <code>${a}</code>`));
    }
  }

  await ctx.reply(`👑 <b>Active Administrators:</b>\n\n${adminList.join("\n")}`, { parse_mode: "HTML" });
});

bot.action("admin_setkey_prompt", async (ctx) => {
  if (!(await isAuthorizedAdmin(ctx))) return ctx.answerCbQuery("Unauthorized");
  await setSession(ctx.from.id, { step: "awaiting_admin_key" });
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply("🔑 <b>Set Speed Secret API Key:</b>\nPaste your key directly below:", { parse_mode: "HTML" });
});

// ----------------------------------------------------
// 7. TEXT MESSAGE HANDLER
// ----------------------------------------------------
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const isAdm = await isAuthorizedAdmin(ctx);

  // Return to Home instantly on /start, start, Home
  if (text.startsWith("/start") || text.toLowerCase() === "start" || text === "🏠 Home") {
    stopDepositWatcher(ctx.from.id);
    await clearSession(ctx.from.id);
    await ctx.replyWithChatAction("typing");
    const walletText = await getWalletOverviewText(userId, ctx.from.id, isAdm);
    const kb = await getMainKeyboard(ctx);
    return ctx.reply(walletText, { parse_mode: "HTML", ...kb });
  }

  // Abort on other main menu buttons
  if (text.startsWith("/") || ["💰 Balance", "📥 Deposit", "📤 Withdraw", "📜 History", "👑 Admin Panel"].includes(text)) {
    stopDepositWatcher(ctx.from.id);
    await clearSession(ctx.from.id);
    return;
  }

  const session = await getSession(ctx.from.id);

  // A. ADMIN ACTIONS
  if (isAdm) {
    if (session.step === "adm_input_ban_user") {
      await clearSession(ctx.from.id);
      const target = text.toLowerCase().replace(/^@/, "");
      if (db) await db.collection("users").doc(target).set({ banned: true }, { merge: true });
      return ctx.reply(`🚫 <b>User @${target} is now BANNED.</b>`, { parse_mode: "HTML" });
    }
    if (session.step === "adm_input_unban_user") {
      await clearSession(ctx.from.id);
      const target = text.toLowerCase().replace(/^@/, "");
      if (db) await db.collection("users").doc(target).set({ banned: false }, { merge: true });
      return ctx.reply(`✅ <b>User @${target} is now UNBANNED.</b>`, { parse_mode: "HTML" });
    }
    if (session.step === "adm_input_del_user") {
      await clearSession(ctx.from.id);
      const target = text.toLowerCase().replace(/^@/, "");
      if (db) await db.collection("users").doc(target).delete();
      return ctx.reply(`🗑️ <b>User @${target} deleted from database.</b>`, { parse_mode: "HTML" });
    }
    if (session.step === "adm_input_add_bal_target") {
      const target = text.toLowerCase().replace(/^@/, "");
      await setSession(ctx.from.id, { step: "adm_input_add_bal_amt", target_user: target });
      return ctx.reply(`➕ Enter amount of <b>SATS</b> to add to @${target}:`, { parse_mode: "HTML" });
    }
    if (session.step === "adm_input_add_bal_amt") {
      const amt = parseInt(text, 10);
      const target = session.target_user;
      await clearSession(ctx.from.id);
      if (isNaN(amt) || amt <= 0) return ctx.reply("⚠️ Invalid number.");
      if (db) {
        await db.collection("users").doc(target).set({ balance: admin.firestore.FieldValue.increment(amt) }, { merge: true });
      }
      return ctx.reply(`✅ <b>+${amt.toLocaleString()} sats</b> credited to <b>@${target}</b>!`, { parse_mode: "HTML" });
    }
    if (session.step === "adm_input_deduct_bal_target") {
      const target = text.toLowerCase().replace(/^@/, "");
      await setSession(ctx.from.id, { step: "adm_input_deduct_bal_amt", target_user: target });
      return ctx.reply(`➖ Enter amount of <b>SATS</b> to deduct from @${target}:`, { parse_mode: "HTML" });
    }
    if (session.step === "adm_input_deduct_bal_amt") {
      const amt = parseInt(text, 10);
      const target = session.target_user;
      await clearSession(ctx.from.id);
      if (isNaN(amt) || amt <= 0) return ctx.reply("⚠️ Invalid number.");
      if (db) {
        await db.collection("users").doc(target).set({ balance: admin.firestore.FieldValue.increment(-amt) }, { merge: true });
      }
      return ctx.reply(`✅ <b>-${amt.toLocaleString()} sats</b> deducted from <b>@${target}</b>.`, { parse_mode: "HTML" });
    }
    if (session.step === "adm_input_broadcast") {
      await clearSession(ctx.from.id);
      let count = 0;
      if (db) {
        const snap = await db.collection("users").get();
        for (const doc of snap.docs) {
          const tId = doc.data().telegram_id;
          if (tId) {
            try { await bot.telegram.sendMessage(tId, `📢 <b>Announcement:</b>\n\n${text}`, { parse_mode: "HTML" }); count++; } catch (e) {}
          }
        }
      }
      return ctx.reply(`✅ Broadcast delivered to ${count} users.`, { parse_mode: "HTML" });
    }
    if (session.step === "adm_input_logs_channel") {
      await clearSession(ctx.from.id);
      let chId = text;
      if (ctx.message.forward_from_chat) chId = String(ctx.message.forward_from_chat.id);
      if (db) await db.collection("settings").doc("logs_channel").set({ channel_id: chId }, { merge: true });
      return ctx.reply(`✅ Logs Channel set to: <code>${chId}</code>`, { parse_mode: "HTML" });
    }
    if (session.step === "adm_input_add_admin") {
      await clearSession(ctx.from.id);
      const newAdm = text.toLowerCase().replace(/^@/, "");
      if (db) await db.collection("settings").doc("admins").set({ list: admin.firestore.FieldValue.arrayUnion(newAdm) }, { merge: true });
      return ctx.reply(`✅ Admin added: <code>${newAdm}</code>`, { parse_mode: "HTML" });
    }
    if (session.step === "adm_input_del_admin") {
      await clearSession(ctx.from.id);
      const remAdm = text.toLowerCase().replace(/^@/, "");
      if (remAdm === MASTER_ADMIN_ID) return ctx.reply("⚠️ You cannot remove the Master Admin.");
      if (db) await db.collection("settings").doc("admins").set({ list: admin.firestore.FieldValue.arrayRemove(remAdm) }, { merge: true });
      return ctx.reply(`✅ Admin removed: <code>${remAdm}</code>`, { parse_mode: "HTML" });
    }
    if (session.step === "awaiting_admin_key") {
      await clearSession(ctx.from.id);
      if (db) await db.collection("settings").doc("speed").set({ api_key: text, updated_at: new Date().toISOString() }, { merge: true });
      return ctx.reply("✅ <b>Speed API Key saved successfully!</b>", { parse_mode: "HTML" });
    }
  }

  // B. DEPOSIT AMOUNT INPUT
  if (session.step === "awaiting_deposit_amount") {
    const amount = Number(text);
    const minAmount = session.min_amount || 1;

    if (isNaN(amount) || amount < minAmount) {
      return ctx.reply(`⚠️ Minimum deposit is ${minAmount}. Please enter a valid number.`);
    }

    await ctx.replyWithChatAction("typing");
    const targetCurrency = session.target_currency || "SATS";
    const paymentMethod = session.payment_method || "lightning";
    await clearSession(ctx.from.id);

    try {
      const res = await fetch(`${APP_URL}/api/wallet?action=create-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount,
          target_currency: targetCurrency,
          payment_method: paymentMethod,
          user_id: userId,
          username: userId,
          telegram_id: String(ctx.from.id)
        })
      });
      const data = await res.json();

      if (!data.success || !data.invoice) throw new Error(data.error || "Could not generate deposit.");

      const txId = data.tx_id || data.id;
      const isLightning = data.invoice.toLowerCase().startsWith("lnbc");
      const qrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(data.invoice)}&size=400&dark=00e676&light=0b0e14&margin=2&ecLevel=Q&centerImageUrl=https%3A%2F%2Fcdn-icons-png.flaticon.com%2F512%2F1198%2F1198305.png&centerImageSizeRatio=0.22`;

      const caption = isLightning
        ? `⚡ <b>Lightning Deposit Invoice Created</b>\n\n💰 <b>Amount:</b> ${amount} ${targetCurrency}\n🆔 <b>TxID:</b> <code>${txId}</code>\n\n<code>${data.invoice}</code>\n\n<i>Scan QR or tap invoice to copy. Waiting for payment...</i>`
        : `📥 <b>${targetCurrency} Deposit Address Created</b>\n\n💰 <b>Expected Amount:</b> ${amount} ${targetCurrency}\n🌐 <b>Network:</b> ${paymentMethod.toUpperCase()}\n🆔 <b>TxID:</b> <code>${txId}</code>\n\n👉 <b>Address:</b>\n<code>${data.invoice}</code>\n\n<i>Scan QR or copy address to transfer.</i>`;

      await ctx.replyWithPhoto(qrUrl, { caption, parse_mode: "HTML" });
      startDepositWatcher(ctx.from.id, txId, amount, userId);
    } catch (err) {
      ctx.reply(`❌ Failed to create deposit: ${err.message}`);
    }
    return;
  }

  // C. WITHDRAW DESTINATION INPUT (Auto-detects invoice, amount & currency)
  if (session.step === "awaiting_withdraw_dest") {
    await ctx.replyWithChatAction("typing");

    let detectedAmount = null;
    let detectedCurrency = session.target_currency || "SATS";
    let detectedMethod = session.withdraw_method || "lightning";

    // 1. Internal Invoice Lookup
    if (db) {
      const invSnap = await db.collection("invoices")
        .where("invoice", "==", text)
        .where("is_paid", "==", false)
        .limit(1)
        .get();

      if (!invSnap.empty) {
        const invData = invSnap.docs[0].data();
        detectedAmount = Number(invData.amount || 0);
        detectedCurrency = invData.target_currency || detectedCurrency;
        detectedMethod = invData.payment_method || detectedMethod;
      }
    }

    // 2. Decode Lightning Bolt-11 Invoice
    if (!detectedAmount && (text.toLowerCase().startsWith("lnbc") || text.toLowerCase().startsWith("lightning:lnbc"))) {
      detectedAmount = decodeBolt11Sats(text);
      if (detectedAmount) {
        detectedCurrency = "SATS";
        detectedMethod = "lightning";
      }
    }

    // 3. Decode URI Params
    if (!detectedAmount && text.includes("?")) {
      const uriMatch = text.match(/[?&]amount=([0-9.]+)/i);
      if (uriMatch) {
        const parsedAmt = parseFloat(uriMatch[1]);
        if (!isNaN(parsedAmt) && parsedAmt > 0) {
          detectedAmount = parsedAmt;
          if (text.toLowerCase().startsWith("bitcoin:")) {
            detectedCurrency = "SATS";
            detectedMethod = "onchain";
            if (detectedAmount < 1) detectedAmount = Math.round(detectedAmount * 100000000);
          } else if (text.toLowerCase().startsWith("tron:")) {
            detectedCurrency = "USDT";
            detectedMethod = "tron";
          }
        }
      }
    }

    // Amount Auto-Detected ➔ Direct Confirmation Screen
    if (detectedAmount && detectedAmount > 0) {
      const currentBal = await getDirectBalance(userId, ctx.from.id);

      if (detectedCurrency === "SATS" && detectedAmount > currentBal) {
        await clearSession(ctx.from.id);
        return ctx.reply(
          `⚠️ <b>Insufficient Balance!</b>\n` +
          `This payment requires <b>${detectedAmount.toLocaleString()} ${detectedCurrency}</b>, but you have <b>${currentBal.toLocaleString()} sats</b>.`,
          { parse_mode: "HTML" }
        );
      }

      await setSession(ctx.from.id, {
        step: "confirm_payment",
        destination: text,
        amount: detectedAmount,
        withdraw_method: detectedMethod,
        currency: detectedCurrency,
        balance: currentBal
      });

      return ctx.reply(
        `⚡ <b>Payment Request Detected!</b>\n\n` +
        `💰 <b>Amount:</b> ${detectedAmount.toLocaleString()} ${detectedCurrency}\n` +
        `🌐 <b>Network:</b> ${detectedMethod.toUpperCase()}\n` +
        `🎯 <b>Recipient:</b> <code>${text.substring(0, 30)}...</code>\n\n` +
        `Click <b>Send</b> below to confirm payment:`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback(`🚀 Send ${detectedAmount.toLocaleString()} ${detectedCurrency}`, "confirm_send")],
            [Markup.button.callback("❌ Cancel", "cancel_send")]
          ])
        }
      );
    }

    // Destination is plain address
    const currentBal = await getDirectBalance(userId, ctx.from.id);
    await setSession(ctx.from.id, { step: "awaiting_withdraw_amount", destination: text, balance: currentBal });
    return ctx.reply(`📍 <b>Destination Address:</b>\n<code>${text}</code>\n\nEnter the <b>amount in ${detectedCurrency} to send</b>:`, { parse_mode: "HTML" });
  }

  // D. WITHDRAW AMOUNT INPUT
  if (session.step === "awaiting_withdraw_amount") {
    const amount = Number(text);
    if (isNaN(amount) || amount <= 0) return ctx.reply("⚠️ Please enter a valid number.");
    
    const currentBal = await getDirectBalance(userId, ctx.from.id);
    if (session.target_currency === "SATS" && amount > currentBal) {
      return ctx.reply(`⚠️ Insufficient balance! You only have ${currentBal.toLocaleString()} sats.`);
    }

    const destination = session.destination;
    const withdrawMethod = session.withdraw_method || "lightning";
    const curr = session.target_currency || "SATS";

    await setSession(ctx.from.id, {
      step: "confirm_payment",
      destination,
      amount,
      withdraw_method: withdrawMethod,
      currency: curr,
      balance: currentBal
    });

    return ctx.reply(
      `⚡ <b>Payment Summary</b>\n\n💰 <b>Amount:</b> ${amount} ${curr}\n🎯 <b>Recipient:</b> <code>${destination}</code>\n🌐 <b>Method:</b> ${withdrawMethod.toUpperCase()}\n\nClick Send below:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`🚀 Send ${amount} ${curr}`, "confirm_send")],
          [Markup.button.callback("❌ Cancel", "cancel_send")]
        ])
      }
    );
  }
});

// ----------------------------------------------------
// 8. PAYMENT DISPATCH CONFIRMATION
// ----------------------------------------------------
bot.action("confirm_send", async (ctx) => {
  await ctx.answerCbQuery("Broadcasting Instant Send...").catch(() => {});
  const session = await getSession(ctx.from.id);
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();

  if (!session.destination || !session.amount) {
    return ctx.editMessageText("⚠️ Session expired. Please restart withdrawal.");
  }

  const { destination, amount, withdraw_method, currency } = session;
  await clearSession(ctx.from.id);

  await ctx.editMessageText(`⏳ <b>Broadcasting payment of ${amount} ${currency || "SATS"}...</b>`, { parse_mode: "HTML" });

  try {
    const res = await fetch(`${APP_URL}/api/wallet?action=send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        destination,
        amount,
        withdraw_method: withdraw_method || "lightning",
        currency: currency || "SATS",
        target_currency: currency || "SATS",
        user_id: userId,
        username: userId,
        telegram_id: String(ctx.from.id)
      })
    });
    const data = await res.json();

    if (!data.success) throw new Error(data.error || "Instant Send failed.");

    const txId = data.tx_id || data.id || "N/A";
    const displayRecipient = destination.includes("@") ? destination : `${destination.substring(0, 24)}...`;

    await ctx.editMessageText(
      `✅ <b>Payment Successful!</b>\n\n` +
      `💸 <b>Amount Sent:</b> ${amount} ${currency || "SATS"}\n` +
      `🎯 <b>Recipient:</b> <code>${displayRecipient}</code>\n` +
      `🆔 <b>TxID:</b> <code>${txId}</code>`,
      { parse_mode: "HTML" }
    );

    forwardToLogsChannel(
      `📤 <b>Withdrawal Completed</b>\n` +
      `• User: @${userId}\n` +
      `• Amount: -${amount} ${currency || "SATS"}\n` +
      `• Destination: <code>${displayRecipient}</code>\n` +
      `• TxID: <code>${txId}</code>`
    );
  } catch (err) {
    await ctx.editMessageText(`❌ <b>Payment Failed:</b> ${err.message}`, { parse_mode: "HTML" });
  }
});

bot.action("cancel_send", async (ctx) => {
  stopDepositWatcher(ctx.from.id);
  await clearSession(ctx.from.id);
  await ctx.answerCbQuery("Cancelled").catch(() => {});
  await ctx.editMessageText("❌ Payment cancelled.");
});

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
