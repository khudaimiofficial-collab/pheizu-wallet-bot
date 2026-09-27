const { Telegraf, Markup } = require("telegraf");
const admin = require("firebase-admin");

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

// Parse Admin list: accepts numeric IDs or usernames, comma-separated
const rawAdmins = (process.env.ADMIN_IDS || process.env.ADMIN_ID || "");
const ADMIN_IDS = rawAdmins
  .split(",")
  .map(id => id.trim().toLowerCase().replace(/^@/, ""))
  .filter(Boolean);

const SAT_TO_USD = 0.00065;
const activeWatchers = new Map();

// Resilient Admin Checker (Matches numeric ID or @username)
function isAdmin(ctx) {
  if (!ctx || !ctx.from) return false;
  const numericId = String(ctx.from.id).trim();
  const username = (ctx.from.username || "").toLowerCase().replace(/^@/, "").trim();

  // If no admin set, fallback to false
  if (ADMIN_IDS.length === 0) return false;

  return ADMIN_IDS.some(adminIdentifier => {
    return adminIdentifier === numericId || (username && adminIdentifier === username);
  });
}

function getMainKeyboard(ctx) {
  const rows = [
    ["💰 Balance", "📥 Deposit"],
    ["📤 Withdraw", "📜 History"]
  ];
  if (isAdmin(ctx)) {
    rows.push(["🔑 Set Key"]);
  }
  return Markup.keyboard(rows).resize();
}

// Keyboards: Step 1 (Asset Selection)
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

function getWithdrawAssetKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⚡ Bitcoin (SATS)", "with_asset_sats")],
    [
      Markup.button.callback("💵 USDT", "with_asset_usdt"),
      Markup.button.callback("💲 USDC", "with_asset_usdc")
    ],
    [Markup.button.callback("🔙 Back", "gateway_back")]
  ]);
}

// Keyboards: Step 2 (Deposit Networks)
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
    [
      Markup.button.callback("💎 TON", "dep_net_usdt_ton")
    ],
    [Markup.button.callback("🔙 Back to Assets", "dep_back_to_assets")]
  ]);
}

function getUsdcDepositNetworks() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("⚡ Lightning", "dep_net_usdc_lightning"),
      Markup.button.callback("⛓️ Ethereum", "dep_net_usdc_ethereum")
    ],
    [
      Markup.button.callback("🟣 Solana", "dep_net_usdc_solana")
    ],
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

// Keyboards: Step 2 (Withdraw Networks)
function getUsdtWithdrawNetworks() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("⚡ Lightning", "with_net_usdt_lightning"),
      Markup.button.callback("⛓️ Ethereum", "with_net_usdt_ethereum")
    ],
    [
      Markup.button.callback("🔴 Tron", "with_net_usdt_tron"),
      Markup.button.callback("🟣 Solana", "with_net_usdt_solana")
    ],
    [
      Markup.button.callback("💎 TON", "with_net_usdt_ton")
    ],
    [Markup.button.callback("🔙 Back to Assets", "with_back_to_assets")]
  ]);
}

function getUsdcWithdrawNetworks() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("⚡ Lightning", "with_net_usdc_lightning"),
      Markup.button.callback("⛓️ Ethereum", "with_net_usdc_ethereum")
    ],
    [
      Markup.button.callback("🟣 Solana", "with_net_usdc_solana")
    ],
    [Markup.button.callback("🔙 Back to Assets", "with_back_to_assets")]
  ]);
}

function getSatsWithdrawNetworks() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("⚡ Lightning", "with_net_sats_lightning"),
      Markup.button.callback("₿ On-Chain", "with_net_sats_onchain")
    ],
    [Markup.button.callback("🔙 Back to Assets", "with_back_to_assets")]
  ]);
}

// Session Helpers
async function getSession(userId) {
  if (!db) return {};
  const doc = await db.collection("bot_sessions").doc(String(userId)).get();
  return doc.exists ? doc.data() : {};
}

async function setSession(userId, data) {
  if (!db) return;
  await db.collection("bot_sessions").doc(String(userId)).set(data, { merge: true });
}

async function clearSession(userId) {
  if (!db) return;
  await db.collection("bot_sessions").doc(String(userId)).delete();
}

function stopDepositWatcher(chatId) {
  const id = String(chatId);
  if (activeWatchers.has(id)) {
    clearInterval(activeWatchers.get(id));
    activeWatchers.delete(id);
  }
}

// Format My Wallet Screen
async function getWalletOverviewText(userId, telegramId, ctx) {
  let sats = 0;
  try {
    const res = await fetch(`${APP_URL}/api/wallet?action=balance&user_id=${encodeURIComponent(userId)}&telegram_id=${telegramId}`);
    const data = await res.json();
    if (data.success) sats = Number(data.balance || 0);
  } catch (e) {}

  const satsUsd = (sats * SAT_TO_USD).toFixed(2);
  const totalUsd = satsUsd;
  const adminBadge = isAdmin(ctx) ? "👑 <b>Admin Mode:</b> Active\n" : "";

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

        const bRes = await fetch(`${APP_URL}/api/wallet?action=balance&user_id=${targetUserId}&telegram_id=${chatId}`);
        const bData = await bRes.json();
        const currentBal = bData.success ? Number(bData.balance).toLocaleString() : "...";

        await bot.telegram.sendMessage(
          chatId,
          `🎉 <b>Payment Received!</b>\n\n` +
          `⚡ <b>+${amount} ${curr}</b> credited to your balance!\n` +
          `💰 <b>New Balance:</b> ${currentBal} sats\n` +
          `🆔 <b>TxID:</b> <code>${txId}</code>`,
          { parse_mode: "HTML" }
        );
      }
    } catch (e) {}
  }, 3000);

  activeWatchers.set(String(chatId), timer);
}

// ----------------------------------------------------
// 0. /id COMMAND - CHECK ADMIN STATUS INSTANTLY
// ----------------------------------------------------
bot.command("id", async (ctx) => {
  const uid = ctx.from.id;
  const uname = ctx.from.username ? `@${ctx.from.username}` : "none";
  const isAdm = isAdmin(ctx);

  return ctx.reply(
    `🆔 <b>Your Telegram Account Info:</b>\n\n` +
    `• <b>Numeric ID:</b> <code>${uid}</code>\n` +
    `• <b>Username:</b> ${uname}\n` +
    `• <b>Admin Status:</b> ${isAdm ? "✅ <b>YES (Authorized Admin)</b>" : "❌ <b>NO (Not Admin)</b>"}\n\n` +
    `<i>If it says 'NO', put <code>${uid}</code> into ADMIN_IDS in your Vercel Environment Variables.</i>`,
    { parse_mode: "HTML" }
  );
});

// ----------------------------------------------------
// 0. /setkey COMMAND - DIRECT KEY UPDATE FOR ADMIN
// ----------------------------------------------------
bot.command("setkey", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("⛔ Access denied: You are not authorized.");
  }

  const parts = ctx.message.text.trim().split(" ");
  if (parts.length < 2 || !parts[1].trim()) {
    return ctx.reply("⚠️ Usage: <code>/setkey YOUR_SPEED_API_KEY</code>", { parse_mode: "HTML" });
  }

  const newKey = parts[1].trim();

  if (db) {
    await db.collection("settings").doc("speed").set({
      api_key: newKey,
      updated_at: new Date().toISOString()
    }, { merge: true });
  }

  await clearSession(ctx.from.id);
  return ctx.reply("✅ <b>Speed API Key saved successfully!</b>", { parse_mode: "HTML" });
});

// ----------------------------------------------------
// 1. /START - DIRECT RETURN TO WALLET HOME
// ----------------------------------------------------
bot.start(async (ctx) => {
  stopDepositWatcher(ctx.from.id);
  await clearSession(ctx.from.id);

  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  await ctx.replyWithChatAction("typing");
  const walletText = await getWalletOverviewText(userId, ctx.from.id, ctx);

  await ctx.reply(walletText, {
    parse_mode: "HTML",
    ...getMainKeyboard(ctx)
  });
});

// ----------------------------------------------------
// 2. 💰 BALANCE
// ----------------------------------------------------
bot.hears("💰 Balance", async (ctx) => {
  stopDepositWatcher(ctx.from.id);
  await clearSession(ctx.from.id);

  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  await ctx.replyWithChatAction("typing");
  const walletText = await getWalletOverviewText(userId, ctx.from.id, ctx);

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
      return ctx.reply(
        `📜 <b>Transaction History</b>\n\n` +
        `No transactions found yet.\n` +
        `Your deposits, withdrawals, and internal transfers will appear here.`,
        { parse_mode: "HTML" }
      );
    }

    let msg = `📜 <b>Recent Transactions:</b>\n\n`;

    data.history.forEach((tx) => {
      const date = tx.created_at ? new Date(tx.created_at).toISOString().replace("T", " ").substring(0, 16) : "Recent";
      const curr = tx.currency || "SATS";
      const amt = tx.amount;
      const txId = tx.tx_id || tx.id || "N/A";

      if (tx.type === "deposit") {
        msg += `📥 <b>Deposit:</b> +${amt} ${curr}\n`;
      } else if (tx.type === "withdrawal" || tx.type === "instant_send") {
        msg += `📤 <b>Withdrawal:</b> -${amt} ${curr}\n`;
      } else if (tx.type === "transfer_sent") {
        msg += `⚡ <b>Sent to:</b> @${tx.to || "user"} (-${amt} ${curr})\n`;
      } else if (tx.type === "transfer_received") {
        msg += `⚡ <b>Received from:</b> @${tx.from || "user"} (+${amt} ${curr})\n`;
      } else {
        msg += `🔄 <b>Transfer:</b> ${amt} ${curr}\n`;
      }

      msg += `📅 <code>${date} UTC</code>\n`;
      msg += `🆔 <code>${txId}</code>\n`;
      msg += `─────────────────────\n`;
    });

    await ctx.reply(msg, { parse_mode: "HTML" });
  } catch (e) {
    ctx.reply("⚠️ Could not load history. Please try again later.");
  }
});

// ----------------------------------------------------
// 4. 📥 DEPOSIT (Step 1)
// ----------------------------------------------------
bot.hears("📥 Deposit", async (ctx) => {
  stopDepositWatcher(ctx.from.id);
  await clearSession(ctx.from.id);

  await ctx.reply(
    `🔥 <b>Select a Deposit Asset:</b> 🔥`,
    {
      parse_mode: "HTML",
      ...getDepositAssetKeyboard()
    }
  );
});

// ----------------------------------------------------
// 5. 📤 WITHDRAW (Step 1)
// ----------------------------------------------------
bot.hears("📤 Withdraw", async (ctx) => {
  stopDepositWatcher(ctx.from.id);
  await clearSession(ctx.from.id);

  await ctx.reply(
    `🔥 <b>Select a Withdrawal Asset:</b> 🔥`,
    {
      parse_mode: "HTML",
      ...getWithdrawAssetKeyboard()
    }
  );
});

// ----------------------------------------------------
// 6. 🔑 SET KEY (Admin Button)
// ----------------------------------------------------
bot.hears("🔑 Set Key", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("⛔ Access denied: You are not authorized.");
  }

  stopDepositWatcher(ctx.from.id);
  await setSession(ctx.from.id, { step: "awaiting_admin_key" });

  await ctx.reply(
    `🔑 <b>Set Speed API Secret Key</b>\n\n` +
    `Paste your API secret key directly in this chat\n` +
    `<i>(Or type <code>/setkey YOUR_KEY</code>)</i>:`,
    { parse_mode: "HTML" }
  );
});

// ----------------------------------------------------
// CALLBACKS: DEPOSIT STEP 2 (NETWORK SELECTION)
// ----------------------------------------------------
bot.action("dep_back_to_assets", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `🔥 <b>Select a Deposit Asset:</b> 🔥`,
    {
      parse_mode: "HTML",
      ...getDepositAssetKeyboard()
    }
  );
});

bot.action("dep_asset_usdt", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(`🔥 <b>Select USDT Network:</b> 🔥`, {
    parse_mode: "HTML",
    ...getUsdtDepositNetworks()
  });
});

bot.action("dep_asset_usdc", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(`🔥 <b>Select USDC Network:</b> 🔥`, {
    parse_mode: "HTML",
    ...getUsdcDepositNetworks()
  });
});

bot.action("dep_asset_sats", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(`🔥 <b>Select Bitcoin Network:</b> 🔥`, {
    parse_mode: "HTML",
    ...getSatsDepositNetworks()
  });
});

// USDT Networks
bot.action("dep_net_usdt_lightning", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const lnAddress = `${userId}@${DOMAIN}`;

  await setSession(ctx.from.id, { 
    step: "awaiting_deposit_amount",
    target_currency: "USDT",
    payment_method: "lightning",
    min_amount: 0.5
  });

  await ctx.editMessageText(
    `⚡ <b>Deposit USDT (Lightning Network)</b>\n\n` +
    `👉 <b>Lightning Address:</b>\n<code>${lnAddress}</code>\n\n` +
    `<b>Or generate an Invoice:</b>\n` +
    `Reply with the amount in <b>USDT</b> (Min: <b>0.5 USDT</b>, e.g. <code>10</code>):`,
    { parse_mode: "HTML" }
  );
});

bot.action("dep_net_usdt_ethereum", async (ctx) => {
  await ctx.answerCbQuery();
  await setSession(ctx.from.id, { 
    step: "awaiting_deposit_amount",
    target_currency: "USDT",
    payment_method: "ethereum",
    min_amount: 0.5
  });

  await ctx.editMessageText(
    `⛓️ <b>Deposit USDT (Ethereum - ERC20)</b>\n\n` +
    `Reply with the amount in <b>USDT</b> (Min: <b>0.5 USDT</b>, e.g. <code>25</code>):`,
    { parse_mode: "HTML" }
  );
});

bot.action("dep_net_usdt_tron", async (ctx) => {
  await ctx.answerCbQuery();
  await setSession(ctx.from.id, { 
    step: "awaiting_deposit_amount",
    target_currency: "USDT",
    payment_method: "tron",
    min_amount: 0.5
  });

  await ctx.editMessageText(
    `🔴 <b>Deposit USDT (Tron - TRC20)</b>\n\n` +
    `Reply with the amount in <b>USDT</b> (Min: <b>0.5 USDT</b>, e.g. <code>10</code>):`,
    { parse_mode: "HTML" }
  );
});

bot.action("dep_net_usdt_solana", async (ctx) => {
  await ctx.answerCbQuery();
  await setSession(ctx.from.id, { 
    step: "awaiting_deposit_amount",
    target_currency: "USDT",
    payment_method: "solana",
    min_amount: 0.5
  });

  await ctx.editMessageText(
    `🟣 <b>Deposit USDT (Solana)</b>\n\n` +
    `Reply with the amount in <b>USDT</b> (Min: <b>0.5 USDT</b>, e.g. <code>10</code>):`,
    { parse_mode: "HTML" }
  );
});

bot.action("dep_net_usdt_ton", async (ctx) => {
  await ctx.answerCbQuery();
  await setSession(ctx.from.id, { 
    step: "awaiting_deposit_amount",
    target_currency: "USDT",
    payment_method: "ton",
    min_amount: 0.5
  });

  await ctx.editMessageText(
    `💎 <b>Deposit USDT (TON Network)</b>\n\n` +
    `Reply with the amount in <b>USDT</b> (Min: <b>0.5 USDT</b>, e.g. <code>10</code>):`,
    { parse_mode: "HTML" }
  );
});

// USDC Networks
bot.action("dep_net_usdc_lightning", async (ctx) => {
  await ctx.answerCbQuery();
  await setSession(ctx.from.id, { 
    step: "awaiting_deposit_amount",
    target_currency: "USDC",
    payment_method: "lightning",
    min_amount: 0.5
  });

  await ctx.editMessageText(
    `⚡ <b>Deposit USDC (Lightning Network)</b>\n\n` +
    `Reply with the amount in <b>USDC</b> (Min: <b>0.5 USDC</b>, e.g. <code>10</code>):`,
    { parse_mode: "HTML" }
  );
});

bot.action("dep_net_usdc_ethereum", async (ctx) => {
  await ctx.answerCbQuery();
  await setSession(ctx.from.id, { 
    step: "awaiting_deposit_amount",
    target_currency: "USDC",
    payment_method: "ethereum",
    min_amount: 0.5
  });

  await ctx.editMessageText(
    `⛓️ <b>Deposit USDC (Ethereum - ERC20)</b>\n\n` +
    `Reply with the amount in <b>USDC</b> (Min: <b>0.5 USDC</b>, e.g. <code>25</code>):`,
    { parse_mode: "HTML" }
  );
});

bot.action("dep_net_usdc_solana", async (ctx) => {
  await ctx.answerCbQuery();
  await setSession(ctx.from.id, { 
    step: "awaiting_deposit_amount",
    target_currency: "USDC",
    payment_method: "solana",
    min_amount: 0.5
  });

  await ctx.editMessageText(
    `🟣 <b>Deposit USDC (Solana)</b>\n\n` +
    `Reply with the amount in <b>USDC</b> (Min: <b>0.5 USDC</b>, e.g. <code>10</code>):`,
    { parse_mode: "HTML" }
  );
});

// SATS Networks
bot.action("dep_net_sats_lightning", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const lnAddress = `${userId}@${DOMAIN}`;

  await setSession(ctx.from.id, { 
    step: "awaiting_deposit_amount",
    target_currency: "SATS",
    payment_method: "lightning",
    min_amount: 1
  });

  await ctx.editMessageText(
    `⚡ <b>Deposit SATS (Lightning Network)</b>\n\n` +
    `👉 <b>Lightning Address:</b>\n<code>${lnAddress}</code>\n\n` +
    `<b>Or generate an Invoice:</b>\n` +
    `Reply with the amount in <b>sats</b> (Min: <b>1 sat</b>, e.g. <code>50</code>):`,
    { parse_mode: "HTML" }
  );
});

bot.action("dep_net_sats_onchain", async (ctx) => {
  await ctx.answerCbQuery();
  await setSession(ctx.from.id, { 
    step: "awaiting_deposit_amount",
    target_currency: "SATS",
    payment_method: "onchain",
    min_amount: 1000
  });

  await ctx.editMessageText(
    `₿ <b>Deposit Bitcoin (On-Chain)</b>\n\n` +
    `Reply with the amount in <b>sats</b> (Min: <b>1,000 sats</b>, e.g. <code>10000</code>):`,
    { parse_mode: "HTML" }
  );
});

// ----------------------------------------------------
// CALLBACKS: WITHDRAW STEP 2 (NETWORKS)
// ----------------------------------------------------
bot.action("with_back_to_assets", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(`🔥 <b>Select a Withdrawal Asset:</b> 🔥`, {
    parse_mode: "HTML",
    ...getWithdrawAssetKeyboard()
  });
});

bot.action("with_asset_usdt", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(`🔥 <b>Select USDT Withdrawal Network:</b> 🔥`, {
    parse_mode: "HTML",
    ...getUsdtWithdrawNetworks()
  });
});

bot.action("with_asset_usdc", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(`🔥 <b>Select USDC Withdrawal Network:</b> 🔥`, {
    parse_mode: "HTML",
    ...getUsdcWithdrawNetworks()
  });
});

bot.action("with_asset_sats", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(`🔥 <b>Select Bitcoin Withdrawal Network:</b> 🔥`, {
    parse_mode: "HTML",
    ...getSatsWithdrawNetworks()
  });
});

// Withdraw Networks Actions
bot.action("with_net_sats_lightning", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  try {
    const res = await fetch(`${APP_URL}/api/wallet?action=balance&user_id=${encodeURIComponent(userId)}&telegram_id=${ctx.from.id}`);
    const data = await res.json();
    const balance = data.success ? Number(data.balance || 0) : 0;

    if (balance <= 0) {
      await clearSession(ctx.from.id);
      return ctx.editMessageText("⚠️ <b>Your balance is 0 sats.</b>\nPlease deposit sats before withdrawing.", { parse_mode: "HTML" });
    }

    await setSession(ctx.from.id, { 
      step: "awaiting_withdraw_dest",
      target_currency: "SATS",
      withdraw_method: "lightning",
      balance 
    });

    await ctx.editMessageText(
      `⚡ <b>Withdraw SATS (Lightning)</b>\nAvailable: <b>${balance.toLocaleString()} sats</b>\n\n` +
      `Paste the recipient's <b>Lightning Invoice</b> or <b>Lightning Address</b>:`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    ctx.editMessageText("⚠️ Error checking balance. Please try again.");
  }
});

bot.action("with_net_sats_onchain", async (ctx) => {
  await ctx.answerCbQuery();
  await setSession(ctx.from.id, { 
    step: "awaiting_withdraw_dest",
    target_currency: "SATS",
    withdraw_method: "onchain",
    min_amount: 1000
  });
  await ctx.editMessageText(`₿ <b>Bitcoin On-Chain Withdrawal (Min: 1,000 SATS):</b>\n\nPaste your Bitcoin destination address:`, { parse_mode: "HTML" });
});

bot.action("with_net_usdt_tron", async (ctx) => {
  await ctx.answerCbQuery();
  await setSession(ctx.from.id, { 
    step: "awaiting_withdraw_dest",
    target_currency: "USDT",
    withdraw_method: "tron",
    min_amount: 0.5
  });
  await ctx.editMessageText(`🔴 <b>USDT (Tron - TRC20) Withdrawal:</b>\n\nPaste your Tron destination address (<code>T...</code>):`, { parse_mode: "HTML" });
});

bot.action("with_net_usdt_solana", async (ctx) => {
  await ctx.answerCbQuery();
  await setSession(ctx.from.id, { 
    step: "awaiting_withdraw_dest",
    target_currency: "USDT",
    withdraw_method: "solana",
    min_amount: 0.5
  });
  await ctx.editMessageText(`🟣 <b>USDT (Solana) Withdrawal:</b>\n\nPaste your Solana destination address:`, { parse_mode: "HTML" });
});

bot.action("with_net_usdt_ethereum", async (ctx) => {
  await ctx.answerCbQuery();
  await setSession(ctx.from.id, { 
    step: "awaiting_withdraw_dest",
    target_currency: "USDT",
    withdraw_method: "ethereum",
    min_amount: 0.5
  });
  await ctx.editMessageText(`⛓️ <b>USDT (Ethereum - ERC20) Withdrawal:</b>\n\nPaste your Ethereum address (<code>0x...</code>):`, { parse_mode: "HTML" });
});

bot.action("with_net_usdt_ton", async (ctx) => {
  await ctx.answerCbQuery();
  await setSession(ctx.from.id, { 
    step: "awaiting_withdraw_dest",
    target_currency: "USDT",
    withdraw_method: "ton",
    min_amount: 0.5
  });
  await ctx.editMessageText(`💎 <b>USDT (TON) Withdrawal:</b>\n\nPaste your TON destination address:`, { parse_mode: "HTML" });
});

bot.action("with_net_usdc_solana", async (ctx) => {
  await ctx.answerCbQuery();
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
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
  await ctx.reply("🔙 Returned to main menu.", getMainKeyboard(ctx));
});

// ----------------------------------------------------
// 7. TEXT MESSAGE HANDLER
// ----------------------------------------------------
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();

  // EMERGENCY ESCAPE: If user sends /start, "start", or "Home"
  if (
    text.startsWith("/start") ||
    text.toLowerCase() === "start" ||
    text.toLowerCase() === "home" ||
    text === "🏠 Home"
  ) {
    stopDepositWatcher(ctx.from.id);
    await clearSession(ctx.from.id);
    await ctx.replyWithChatAction("typing");
    const walletText = await getWalletOverviewText(userId, ctx.from.id, ctx);
    return ctx.reply(walletText, {
      parse_mode: "HTML",
      ...getMainKeyboard(ctx)
    });
  }

  // If user clicked any persistent button or command, abort pending inputs
  if (
    text.startsWith("/") ||
    ["💰 Balance", "📥 Deposit", "📤 Withdraw", "📜 History", "🔑 Set Key", "🔙 Back"].includes(text)
  ) {
    stopDepositWatcher(ctx.from.id);
    await clearSession(ctx.from.id);
    return;
  }

  const session = await getSession(ctx.from.id);

  // A. PROCESS DEPOSIT AMOUNT
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

      if (!data.success || !data.invoice) {
        throw new Error(data.error || "Could not generate deposit.");
      }

      const txId = data.tx_id || data.id;
      const isLightning = data.invoice.toLowerCase().startsWith("lnbc");

      const qrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(data.invoice)}&size=400&dark=00e676&light=0b0e14&margin=2&ecLevel=Q&centerImageUrl=https%3A%2F%2Fcdn-icons-png.flaticon.com%2F512%2F1198%2F1198305.png&centerImageSizeRatio=0.22`;

      const caption = isLightning
        ? `⚡ <b>Lightning Deposit Invoice Created</b>\n\n` +
          `💰 <b>Amount:</b> ${amount} ${targetCurrency}\n` +
          `🆔 <b>TxID:</b> <code>${txId}</code>\n\n` +
          `<code>${data.invoice}</code>\n\n` +
          `<i>Scan QR or tap invoice to copy. Waiting for payment...</i>`
        : `📥 <b>${targetCurrency} Deposit Address Created</b>\n\n` +
          `💰 <b>Expected Amount:</b> ${amount} ${targetCurrency}\n` +
          `🌐 <b>Network:</b> ${paymentMethod.toUpperCase()}\n` +
          `🆔 <b>TxID:</b> <code>${txId}</code>\n\n` +
          `👉 <b>Deposit Address (Tap to copy):</b>\n` +
          `<code>${data.invoice}</code>\n\n` +
          `<i>Scan QR or copy address to deposit. Waiting for confirmation...</i>`;

      await ctx.replyWithPhoto(qrUrl, {
        caption,
        parse_mode: "HTML"
      });

      startDepositWatcher(ctx.from.id, txId, amount, userId);
    } catch (err) {
      ctx.reply(`❌ Failed to create deposit: ${err.message}`);
    }
    return;
  }

  // B. PROCESS WITHDRAW DESTINATION (UNIVERSAL AUTO-DETECT)
  if (session.step === "awaiting_withdraw_dest") {
    await ctx.replyWithChatAction("typing");

    let detectedAmount = null;
    let detectedCurrency = session.target_currency || "SATS";
    let detectedMethod = session.withdraw_method || "lightning";

    // 1. Check internal Firestore records
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

    // 3. Decode URI params (?amount=...)
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

    // IF AMOUNT WAS AUTO-DETECTED
    if (detectedAmount && detectedAmount > 0) {
      if (session.balance && detectedCurrency === "SATS" && detectedAmount > session.balance) {
        await clearSession(ctx.from.id);
        return ctx.reply(
          `⚠️ <b>Insufficient Balance!</b>\n` +
          `This payment requires <b>${detectedAmount.toLocaleString()} ${detectedCurrency}</b>, but your available balance is <b>${session.balance.toLocaleString()} sats</b>.`,
          { parse_mode: "HTML" }
        );
      }

      await setSession(ctx.from.id, {
        step: "confirm_payment",
        destination: text,
        amount: detectedAmount,
        withdraw_method: detectedMethod,
        currency: detectedCurrency,
        balance: session.balance
      });

      return ctx.reply(
        `⚡ <b>Payment Request Detected!</b>\n\n` +
        `💰 <b>Amount:</b> ${detectedAmount.toLocaleString()} ${detectedCurrency}\n` +
        `🌐 <b>Network:</b> ${detectedMethod.toUpperCase()}\n` +
        `🎯 <b>Recipient:</b> <code>${text.substring(0, 32)}...</code>\n\n` +
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

    await setSession(ctx.from.id, {
      step: "awaiting_withdraw_amount",
      destination: text,
      balance: session.balance
    });

    return ctx.reply(
      `📍 <b>Destination Address:</b>\n<code>${text}</code>\n\n` +
      `Enter the <b>amount in ${detectedCurrency} to send</b>:`,
      { parse_mode: "HTML" }
    );
  }

  // C. PROCESS WITHDRAW AMOUNT
  if (session.step === "awaiting_withdraw_amount") {
    const amount = Number(text);
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply("⚠️ Please enter a valid positive number.");
    }
    if (session.balance && session.target_currency === "SATS" && amount > session.balance) {
      return ctx.reply(`⚠️ Insufficient balance! You only have ${session.balance} sats.`);
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
      balance: session.balance
    });

    return ctx.reply(
      `⚡ <b>Payment Summary</b>\n\n` +
      `💰 <b>Amount:</b> ${amount} ${curr}\n` +
      `🎯 <b>Recipient:</b> <code>${destination}</code>\n` +
      `🌐 <b>Method:</b> ${withdrawMethod.toUpperCase()}\n\n` +
      `Click <b>Send</b> below to confirm:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`🚀 Send ${amount} ${curr}`, "confirm_send")],
          [Markup.button.callback("❌ Cancel", "cancel_send")]
        ])
      }
    );
  }

  // D. PROCESS ADMIN KEY INPUT
  if (session.step === "awaiting_admin_key" && isAdmin(ctx)) {
    await setSession(ctx.from.id, {
      step: "confirm_admin_key",
      pending_key: text
    });

    return ctx.reply(
      `🔑 <b>Key Received:</b>\n<code>${text}</code>\n\nClick <b>Save Key</b> below to save:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("💾 Save Key", "save_admin_key")],
          [Markup.button.callback("❌ Cancel", "cancel_admin_key")]
        ])
      }
    );
  }
});

// ----------------------------------------------------
// 8. CONFIRM SEND & CANCEL CALLBACKS
// ----------------------------------------------------
bot.action("confirm_send", async (ctx) => {
  await ctx.answerCbQuery("Broadcasting Instant Send...");
  const session = await getSession(ctx.from.id);
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();

  if (!session.destination || !session.amount) {
    return ctx.editMessageText("⚠️ Payment session expired. Please start over by tapping 📤 Withdraw.");
  }

  const { destination, amount, withdraw_method, currency } = session;
  await clearSession(ctx.from.id);

  await ctx.editMessageText(`⏳ <b>Broadcasting Instant Send of ${amount} ${currency || "SATS"}...</b>`, { parse_mode: "HTML" });

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

    if (!data.success) {
      throw new Error(data.error || "Instant Send failed.");
    }

    const txId = data.tx_id || data.id || "N/A";
    const displayRecipient = destination.includes("@") ? destination : `${destination.substring(0, 24)}...`;

    await ctx.editMessageText(
      `✅ <b>Payment Successful!</b>\n\n` +
      `💸 <b>Amount Sent:</b> ${amount} ${currency || "SATS"}\n` +
      `🎯 <b>Recipient:</b> <code>${displayRecipient}</code>\n` +
      `🆔 <b>TxID:</b> <code>${txId}</code>`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    await ctx.editMessageText(`❌ <b>Payment Failed:</b> ${err.message}`, { parse_mode: "HTML" });
  }
});

bot.action("cancel_send", async (ctx) => {
  await clearSession(ctx.from.id);
  await ctx.answerCbQuery("Cancelled");
  await ctx.editMessageText("❌ Payment cancelled.");
});

// Admin Save Button
bot.action("save_admin_key", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCbQuery("Unauthorized", { show_alert: true });
  }

  const session = await getSession(ctx.from.id);
  const keyToSave = session.pending_key;

  if (!keyToSave) {
    return ctx.editMessageText("⚠️ No key found to save.");
  }

  if (db) {
    await db.collection("settings").doc("speed").set({
      api_key: keyToSave,
      updated_at: new Date().toISOString()
    }, { merge: true });
  }

  await clearSession(ctx.from.id);
  await ctx.answerCbQuery("Key saved successfully!");
  await ctx.editMessageText("✅ <b>API Key has been saved successfully!</b>", { parse_mode: "HTML" });
});

bot.action("cancel_admin_key", async (ctx) => {
  await clearSession(ctx.from.id);
  await ctx.answerCbQuery("Cancelled");
  await ctx.editMessageText("❌ Key update cancelled.");
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
