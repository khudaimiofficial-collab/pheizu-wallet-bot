const { Telegraf, Markup } = require("telegraf");
const admin = require("firebase-admin");

// ----------------------------------------------------
// 1. FIREBASE INITIALIZATION
// ----------------------------------------------------
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
const MASTER_ADMIN_ID = "8960497898";

const SAT_TO_USD = 0.00065;
const activeWatchers = new Map();

// Helper: Check if user is an authorized admin
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

// Direct Firestore Balance Fetch
async function getDirectBalance(userId, telegramId) {
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
  } catch (e) {
    console.error("Direct balance fetch error:", e.message);
  }
  return { sats: 0, usdt: 0, usdc: 0 };
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

// ----------------------------------------------------
// KEYBOARDS: WITHDRAW, DEPOSIT & ADMIN
// ----------------------------------------------------
function getWithdrawAssetKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⚡ Bitcoin (SATS)", "with_asset_sats")],
    [
      Markup.button.callback("💵 USDT", "with_asset_usdt"),
      Markup.button.callback("💲 USDC", "with_asset_usdc")
    ],
    [Markup.button.callback("🔙 Back to Main Menu", "gateway_back")]
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

function getUsdtWithdrawNetworks() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("⚡ Lightning", "with_net_usdt_lightning"),
      Markup.button.callback("⛓️ Ethereum", "with_net_usdt_ethereum")
    ],
    [
      Markup.button.callback("🔴 Tron (TRC-20)", "with_net_usdt_tron"),
      Markup.button.callback("🟣 Solana", "with_net_usdt_solana")
    ],
    [Markup.button.callback("💎 TON", "with_net_usdt_ton")],
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

function getUsdtDepositNetworks() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("⚡ Lightning", "dep_net_usdt_lightning"),
      Markup.button.callback("⛓️ Ethereum", "dep_net_usdt_ethereum")
    ],
    [
      Markup.button.callback("🔴 Tron (TRC-20)", "dep_net_usdt_tron"),
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

// ----------------------------------------------------
// SESSION & WATCHER HELPERS
// ----------------------------------------------------
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
      }
    } catch (e) {}
  }, 3000);

  activeWatchers.set(String(chatId), timer);
}

// Format Wallet Overview Screen
async function getWalletOverviewText(userId, telegramId, isAdm) {
  const bal = await getDirectBalance(userId, telegramId);
  const sats = bal.sats;
  const usdt = bal.usdt.toFixed(2);
  const usdc = bal.usdc.toFixed(2);
  const satsUsd = (sats * SAT_TO_USD).toFixed(2);
  const totalUsd = (Number(satsUsd) + Number(usdt) + Number(usdc)).toFixed(2);
  const adminBadge = isAdm ? "👑 <b>Admin Mode:</b> Active\n" : "";

  return (
    `💳 <b>My Wallet</b>\n\n` +
    adminBadge +
    `⚡ <b>SATS:</b> <code>${sats.toLocaleString()} SATS</code> (${satsUsd}$)\n` +
    `₿ <b>BTC:</b> <code>${(sats / 100000000).toFixed(8)} BTC</code> (${satsUsd}$)\n` +
    `💵 <b>USDT:</b> <code>${usdt} USDT</code> (${usdt}$)\n` +
    `💲 <b>USDC:</b> <code>${usdc} USDC</code> (${usdc}$)\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💵 <b>Total:</b> <code>${totalUsd}$</code>\n\n` +
    `⚡ <b>Lightning Address:</b> <code>${userId}@${DOMAIN}</code>\n` +
    `📌 <b>Minimum Deposit:</b> 1 sat / 0.5 USDT`
  );
}

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
// DEPOSIT CHOICE MENU (Specific Amount vs Open Address)
// ----------------------------------------------------
function showDepositChoiceMenu(ctx, { targetCurrency, paymentMethod, minAmount, networkLabel }) {
  const minText = targetCurrency === "SATS" ? `${minAmount.toLocaleString()} SATS` : `${minAmount} ${targetCurrency}`;
  const backAssetCallback = targetCurrency === "SATS" ? "dep_asset_sats" : (targetCurrency === "USDT" ? "dep_asset_usdt" : "dep_asset_usdc");

  let buttons = [
    [Markup.button.callback("🔢 Generate Specific Amount / Address", `dep_opt:amt:${targetCurrency}:${paymentMethod}:${minAmount}`)]
  ];

  if (paymentMethod === "lightning") {
    buttons.push([Markup.button.callback("⚡ Lightning Address (Send Any Amount)", `dep_opt:lnaddr:SATS:lightning:1`)]);
    buttons.push([Markup.button.callback("⚡ 1-SAT Quick Invoice", `dep_opt:open:SATS:lightning:1`)]);
  } else {
    buttons.push([Markup.button.callback(`⚡ Quick Address (Min: ${minText})`, `dep_opt:open:${targetCurrency}:${paymentMethod}:${minAmount}`)]);
  }

  buttons.push([Markup.button.callback("« Back to Networks", backAssetCallback)]);

  return ctx.editMessageText(
    `📥 <b>Deposit ${targetCurrency} (${networkLabel})</b>\n\n` +
    `Choose your deposit option below:\n\n` +
    `1️⃣ <b>Generate Specific Amount / Address:</b> Set the exact amount for this deposit (e.g. 50, 500, 5,000 SATS or 25 USDT).\n` +
    (paymentMethod === "lightning"
      ? `2️⃣ <b>Lightning Address:</b> Pay any amount directly to your Lightning Address with no locked amount restriction.\n`
      : `2️⃣ <b>Quick Address:</b> Generate a direct address immediately.\n`) +
    `\n📌 <b>Minimum Deposit:</b> <code>${minText}</code>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(buttons)
    }
  );
}

// ----------------------------------------------------
// GENERATE & DISPLAY DEPOSIT DETAILS (ONLY "CHECK STATUS" BUTTON)
// ----------------------------------------------------
async function handleGenerateDeposit(ctx, { targetCurrency, paymentMethod, amount, minAmount, networkLabel, isCustomAmount }) {
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  await clearSession(ctx.from.id);

  let statusMsg = null;
  if (ctx.callbackQuery) {
    await ctx.editMessageText(
      `⏳ <b>Generating ${targetCurrency} (${networkLabel}) deposit details...</b>`,
      { parse_mode: "HTML" }
    ).catch(() => {});
  } else {
    statusMsg = await ctx.reply(`⏳ <b>Generating ${targetCurrency} (${networkLabel}) deposit details...</b>`, { parse_mode: "HTML" });
  }

  try {
    const finalAmount = amount || minAmount;

    const res = await fetch(`${APP_URL}/api/wallet?action=create-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: finalAmount,
        target_currency: targetCurrency,
        payment_method: paymentMethod,
        user_id: userId,
        username: userId,
        telegram_id: String(ctx.from.id)
      })
    });

    const data = await res.json();
    if (!data.success || !data.invoice) {
      throw new Error(data.error || "Failed to generate deposit details.");
    }

    const txId = data.tx_id || data.id;
    const isLightning = paymentMethod === "lightning" || data.invoice.toLowerCase().startsWith("lnbc");
    const qrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(data.invoice)}&size=400&dark=00e676&light=0b0e14&margin=2&ecLevel=Q&centerImageUrl=https%3A%2F%2Fcdn-icons-png.flaticon.com%2F512%2F1198%2F1198305.png&centerImageSizeRatio=0.22`;

    const minDepositNotice = targetCurrency === "SATS"
      ? `${minAmount.toLocaleString()} SATS`
      : `${minAmount} ${targetCurrency}`;

    let caption = "";
    if (isLightning) {
      caption = `⚡ <b>Lightning Deposit Invoice</b>\n\n` +
        `💰 <b>Amount:</b> <code>${Number(finalAmount).toLocaleString()} ${targetCurrency}</code>\n` +
        `🌐 <b>Network:</b> Lightning Network (${targetCurrency})\n` +
        `📌 <b>Minimum Deposit:</b> <code>${minDepositNotice}</code>\n\n` +
        `<b>Invoice (tap to copy):</b>\n<code>${data.invoice}</code>\n\n` +
        `⚡ <b>Lightning Address:</b> <code>${userId}@${DOMAIN}</code>\n` +
        `🆔 <b>TxID:</b> <code>${txId}</code>\n\n` +
        `<i>Scan QR or copy invoice to pay. Waiting for payment...</i>`;
    } else {
      caption = `📥 <b>${targetCurrency} Deposit Address</b>\n\n` +
        (isCustomAmount ? `💰 <b>Expected Amount:</b> <code>${finalAmount} ${targetCurrency}</code>\n` : ``) +
        `🌐 <b>Network:</b> ${networkLabel}\n` +
        `📌 <b>Minimum Deposit:</b> <code>${minDepositNotice}</code>\n\n` +
        `👉 <b>Deposit Address (tap to copy):</b>\n<code>${data.invoice}</code>\n\n` +
        `🆔 <b>TxID:</b> <code>${txId}</code>\n\n` +
        `<i>Scan QR or transfer funds to the address above.</i>`;
    }

    if (ctx.callbackQuery) {
      await ctx.deleteMessage().catch(() => {});
    } else if (statusMsg) {
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    }

    // ONLY the "Check Status" button is rendered
    await ctx.replyWithPhoto(qrUrl, {
      caption,
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Check Status", `check_dep:${txId}`)]
      ])
    });

    startDepositWatcher(ctx.from.id, txId, finalAmount, userId);
  } catch (err) {
    const backCallback = targetCurrency === "SATS" ? "dep_asset_sats" : (targetCurrency === "USDT" ? "dep_asset_usdt" : "dep_asset_usdc");
    await ctx.reply(
      `❌ <b>Deposit Error:</b> ${err.message}`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔢 Generate Specific Amount / Address", `dep_opt:amt:${targetCurrency}:${paymentMethod}:${minAmount}`)],
          [Markup.button.callback("« Back to Networks", backCallback)]
        ])
      }
    );
  }
}

// ----------------------------------------------------
// CALLBACK ACTION: CHECK DEPOSIT STATUS BUTTON
// ----------------------------------------------------
bot.action(/^check_dep:(.+)$/, async (ctx) => {
  const paymentId = ctx.match[1];
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const chatId = ctx.from.id;

  await ctx.answerCbQuery("Checking payment status...").catch(() => {});

  try {
    const res = await fetch(`${APP_URL}/api/wallet?action=check-status&payment_id=${paymentId}&user_id=${userId}&telegram_id=${chatId}`);
    const data = await res.json();

    if (data && data.is_paid) {
      stopDepositWatcher(chatId);
      await ctx.answerCbQuery("✅ Payment Confirmed! Your balance has been credited.", { show_alert: true }).catch(() => {});

      await ctx.editMessageReplyMarkup(
        Markup.inlineKeyboard([
          [Markup.button.callback("✅ Payment Confirmed", "gateway_back")]
        ]).reply_markup
      ).catch(() => {});
    } else {
      await ctx.answerCbQuery("⏳ Payment not detected yet. Please ensure the transfer is complete.", { show_alert: true }).catch(() => {});
    }
  } catch (err) {
    await ctx.answerCbQuery("⚠️ Error checking status: " + err.message, { show_alert: true }).catch(() => {});
  }
});

// ----------------------------------------------------
// CALLBACK ACTION: LIGHTNING ADDRESS DISPLAY
// ----------------------------------------------------
bot.action("dep_opt:lnaddr:SATS:lightning:1", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const lnAddress = `${userId}@${DOMAIN}`;
  const qrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(`lightning:${lnAddress}`)}&size=400&dark=00e676&light=0b0e14&margin=2&ecLevel=Q`;

  await ctx.deleteMessage().catch(() => {});
  await ctx.replyWithPhoto(qrUrl, {
    caption:
      `⚡ <b>Your Lightning Address (Accepts ANY Amount)</b>\n\n` +
      `<code>${lnAddress}</code>\n\n` +
      `👉 <b>How to pay any custom amount:</b>\n` +
      `1. Copy your Lightning Address above.\n` +
      `2. Open your Lightning wallet (Cash App, Binance, Strike, Phoenix, Wallet of Satoshi, Blink, etc.).\n` +
      `3. Paste this address and <b>enter any amount you want to send</b> (1 sat to millions of sats)!\n\n` +
      `📌 <b>Minimum Deposit:</b> 1 SAT\n` +
      `⚡ <i>Funds credit to your balance instantly upon payment.</i>`,
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("🔄 Check Status / Balance", "action_balance")],
      [Markup.button.callback("🔢 Generate Specific Amount / Address", "dep_opt:amt:SATS:lightning:1")],
      [Markup.button.callback("🏠 Main Menu", "gateway_back")]
    ])
  });
});

// ----------------------------------------------------
// COMMANDS
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

bot.hears("📤 Withdraw", async (ctx) => {
  stopDepositWatcher(ctx.from.id);
  await clearSession(ctx.from.id);

  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  if (await isUserBanned(userId, ctx.from.id)) {
    return ctx.reply("⛔ Your account has been suspended.");
  }

  await ctx.replyWithChatAction("typing");
  const bal = await getDirectBalance(userId, ctx.from.id);

  await ctx.reply(
    `📤 <b>Withdraw / Send Funds</b>\n` +
    `💰 <b>Available Balances:</b>\n` +
    `• ⚡ SATS: <b>${bal.sats.toLocaleString()} SATS</b>\n` +
    `• 💵 USDT: <b>${bal.usdt.toFixed(2)} USDT</b>\n` +
    `• 💲 USDC: <b>${bal.usdc.toFixed(2)} USDC</b>\n\n` +
    `🔥 <b>Select a Withdrawal Asset:</b> 🔥`,
    {
      parse_mode: "HTML",
      ...getWithdrawAssetKeyboard()
    }
  );
});

// Admin Panel
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
// CALLBACK ACTIONS: DEPOSIT ASSET & NETWORK SELECTIONS
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

// SATS Networks -> Choice Menu
bot.action("dep_net_sats_lightning", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return showDepositChoiceMenu(ctx, {
    targetCurrency: "SATS",
    paymentMethod: "lightning",
    minAmount: 1,
    networkLabel: "Lightning Network"
  });
});

bot.action("dep_net_sats_onchain", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return showDepositChoiceMenu(ctx, {
    targetCurrency: "SATS",
    paymentMethod: "onchain",
    minAmount: 1000,
    networkLabel: "Bitcoin On-Chain"
  });
});

// USDT Networks -> Choice Menu
bot.action("dep_net_usdt_lightning", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return showDepositChoiceMenu(ctx, { targetCurrency: "USDT", paymentMethod: "lightning", minAmount: 0.5, networkLabel: "Lightning" });
});

bot.action("dep_net_usdt_ethereum", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return showDepositChoiceMenu(ctx, { targetCurrency: "USDT", paymentMethod: "ethereum", minAmount: 0.5, networkLabel: "Ethereum (ERC-20)" });
});

bot.action("dep_net_usdt_tron", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return showDepositChoiceMenu(ctx, { targetCurrency: "USDT", paymentMethod: "tron", minAmount: 0.5, networkLabel: "Tron (TRC-20)" });
});

bot.action("dep_net_usdt_solana", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return showDepositChoiceMenu(ctx, { targetCurrency: "USDT", paymentMethod: "solana", minAmount: 0.5, networkLabel: "Solana" });
});

bot.action("dep_net_usdt_ton", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return showDepositChoiceMenu(ctx, { targetCurrency: "USDT", paymentMethod: "ton", minAmount: 0.5, networkLabel: "TON" });
});

// USDC Networks -> Choice Menu
bot.action("dep_net_usdc_lightning", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return showDepositChoiceMenu(ctx, { targetCurrency: "USDC", paymentMethod: "lightning", minAmount: 0.5, networkLabel: "Lightning" });
});

bot.action("dep_net_usdc_ethereum", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return showDepositChoiceMenu(ctx, { targetCurrency: "USDC", paymentMethod: "ethereum", minAmount: 0.5, networkLabel: "Ethereum (ERC-20)" });
});

bot.action("dep_net_usdc_solana", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return showDepositChoiceMenu(ctx, { targetCurrency: "USDC", paymentMethod: "solana", minAmount: 0.5, networkLabel: "Solana" });
});

// ----------------------------------------------------
// CALLBACK ACTIONS: OPTION 1 (CUSTOM AMOUNT) VS OPTION 2 (DIRECT)
// ----------------------------------------------------
bot.action(/^dep_opt:(amt|open):([^:]+):([^:]+):([^:]+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const mode = ctx.match[1];
  const targetCurrency = ctx.match[2];
  const paymentMethod = ctx.match[3];
  const minAmount = Number(ctx.match[4]);
  const networkLabel = paymentMethod === "lightning" ? "Lightning Network" : paymentMethod.toUpperCase();

  if (mode === "amt") {
    // Option 1: Enter exact custom amount
    await setSession(ctx.from.id, {
      step: "awaiting_deposit_custom_amount",
      target_currency: targetCurrency,
      payment_method: paymentMethod,
      min_amount: minAmount,
      network_label: networkLabel
    });

    const minText = targetCurrency === "SATS" ? `${minAmount.toLocaleString()} SATS` : `${minAmount} ${targetCurrency}`;
    const exampleAmt = targetCurrency === "SATS" ? "5000" : "20";
    const backCallback = targetCurrency === "SATS" ? "dep_asset_sats" : (targetCurrency === "USDT" ? "dep_asset_usdt" : "dep_asset_usdc");

    const promptText = `📥 <b>Deposit ${targetCurrency} (${networkLabel})</b>\n\n` +
      `Please reply with the exact amount of <b>${targetCurrency}</b> you want to deposit:\n` +
      `📌 <b>Minimum:</b> <code>${minText}</code>\n\n` +
      `<i>Example: <code>50</code>, <code>100</code>, <code>${exampleAmt}</code></i>\n\n` +
      `<i>Type /cancel to abort at any time.</i>`;

    const promptKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback("« Back to Networks", backCallback)]
    ]);

    // Safely handles deletion whether clicked from text or photo message
    try {
      await ctx.editMessageText(promptText, { parse_mode: "HTML", ...promptKeyboard });
    } catch (e) {
      await ctx.deleteMessage().catch(() => {});
      await ctx.reply(promptText, { parse_mode: "HTML", ...promptKeyboard });
    }
  } else {
    // Option 2: Direct generation with base minimum
    return handleGenerateDeposit(ctx, {
      targetCurrency,
      paymentMethod,
      amount: minAmount,
      minAmount,
      networkLabel,
      isCustomAmount: false
    });
  }
});

// ----------------------------------------------------
// CALLBACK ACTIONS: WITHDRAWAL SELECTIONS
// ----------------------------------------------------
bot.action("with_back_to_assets", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageText(`🔥 <b>Select a Withdrawal Asset:</b> 🔥`, {
    parse_mode: "HTML",
    ...getWithdrawAssetKeyboard()
  });
});

bot.action("with_asset_sats", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageText(`🔥 <b>Select Bitcoin (SATS) Withdrawal Network:</b> 🔥`, {
    parse_mode: "HTML",
    ...getSatsWithdrawNetworks()
  });
});

bot.action("with_asset_usdt", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageText(`🔥 <b>Select USDT Withdrawal Network:</b> 🔥`, {
    parse_mode: "HTML",
    ...getUsdtWithdrawNetworks()
  });
});

bot.action("with_asset_usdc", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageText(`🔥 <b>Select USDC Withdrawal Network:</b> 🔥`, {
    parse_mode: "HTML",
    ...getUsdcWithdrawNetworks()
  });
});

bot.action("with_net_sats_lightning", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const bal = await getDirectBalance(userId, ctx.from.id);

  await setSession(ctx.from.id, { 
    step: "awaiting_withdraw_dest",
    target_currency: "SATS",
    withdraw_method: "lightning",
    balance: bal.sats,
    min_amount: 1
  });

  await ctx.editMessageText(
    `⚡ <b>Withdraw SATS (Lightning Network)</b>\n` +
    `Available: <b>${bal.sats.toLocaleString()} SATS</b>\n\n` +
    `Paste recipient's <b>Lightning Invoice</b> (<code>lnbc...</code>) or <b>Lightning Address</b> (e.g. <code>name@speed.app</code>):`,
    { parse_mode: "HTML" }
  );
});

bot.action("with_net_sats_onchain", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const bal = await getDirectBalance(userId, ctx.from.id);

  await setSession(ctx.from.id, { 
    step: "awaiting_withdraw_dest",
    target_currency: "SATS",
    withdraw_method: "onchain",
    balance: bal.sats,
    min_amount: 1000
  });

  await ctx.editMessageText(
    `₿ <b>Bitcoin On-Chain Withdrawal (Min: 1,000 SATS):</b>\n` +
    `Available: <b>${bal.sats.toLocaleString()} SATS</b>\n\n` +
    `Paste your Bitcoin On-Chain destination address (<code>bc1...</code> or <code>1...</code>):`,
    { parse_mode: "HTML" }
  );
});

bot.action("with_net_usdt_lightning", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const bal = await getDirectBalance(userId, ctx.from.id);

  await setSession(ctx.from.id, { step: "awaiting_withdraw_dest", target_currency: "USDT", withdraw_method: "lightning", min_amount: 0.5 });
  await ctx.editMessageText(`⚡ <b>USDT (Lightning) Withdrawal:</b>\nAvailable: <b>${bal.usdt.toFixed(2)} USDT</b>\n\nPaste recipient's Lightning Invoice or Address:`, { parse_mode: "HTML" });
});

bot.action("with_net_usdt_ethereum", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const bal = await getDirectBalance(userId, ctx.from.id);

  await setSession(ctx.from.id, { step: "awaiting_withdraw_dest", target_currency: "USDT", withdraw_method: "ethereum", min_amount: 10 });
  await ctx.editMessageText(`⛓️ <b>USDT (Ethereum - ERC20) Withdrawal:</b>\nAvailable: <b>${bal.usdt.toFixed(2)} USDT</b>\n\nPaste your Ethereum address (<code>0x...</code>):`, { parse_mode: "HTML" });
});

bot.action("with_net_usdt_tron", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const bal = await getDirectBalance(userId, ctx.from.id);

  await setSession(ctx.from.id, { step: "awaiting_withdraw_dest", target_currency: "USDT", withdraw_method: "tron", min_amount: 0.5 });
  await ctx.editMessageText(`🔴 <b>USDT (Tron - TRC20) Withdrawal:</b>\nAvailable: <b>${bal.usdt.toFixed(2)} USDT</b>\n\nPaste your Tron destination address (<code>T...</code>):`, { parse_mode: "HTML" });
});

bot.action("with_net_usdt_solana", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const bal = await getDirectBalance(userId, ctx.from.id);

  await setSession(ctx.from.id, { step: "awaiting_withdraw_dest", target_currency: "USDT", withdraw_method: "solana", min_amount: 0.5 });
  await ctx.editMessageText(`🟣 <b>USDT (Solana) Withdrawal:</b>\nAvailable: <b>${bal.usdt.toFixed(2)} USDT</b>\n\nPaste your Solana destination address:`, { parse_mode: "HTML" });
});

bot.action("with_net_usdt_ton", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const bal = await getDirectBalance(userId, ctx.from.id);

  await setSession(ctx.from.id, { step: "awaiting_withdraw_dest", target_currency: "USDT", withdraw_method: "ton", min_amount: 0.5 });
  await ctx.editMessageText(`💎 <b>USDT (TON) Withdrawal:</b>\nAvailable: <b>${bal.usdt.toFixed(2)} USDT</b>\n\nPaste your TON destination address:`, { parse_mode: "HTML" });
});

bot.action("with_net_usdc_lightning", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const bal = await getDirectBalance(userId, ctx.from.id);

  await setSession(ctx.from.id, { step: "awaiting_withdraw_dest", target_currency: "USDC", withdraw_method: "lightning", min_amount: 0.5 });
  await ctx.editMessageText(`⚡ <b>USDC (Lightning) Withdrawal:</b>\nAvailable: <b>${bal.usdc.toFixed(2)} USDC</b>\n\nPaste recipient's Lightning Invoice or Address:`, { parse_mode: "HTML" });
});

bot.action("with_net_usdc_ethereum", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const bal = await getDirectBalance(userId, ctx.from.id);

  await setSession(ctx.from.id, { step: "awaiting_withdraw_dest", target_currency: "USDC", withdraw_method: "ethereum", min_amount: 10 });
  await ctx.editMessageText(`⛓️ <b>USDC (Ethereum) Withdrawal:</b>\nAvailable: <b>${bal.usdc.toFixed(2)} USDC</b>\n\nPaste your Ethereum address (<code>0x...</code>):`, { parse_mode: "HTML" });
});

bot.action("with_net_usdc_solana", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const bal = await getDirectBalance(userId, ctx.from.id);

  await setSession(ctx.from.id, { step: "awaiting_withdraw_dest", target_currency: "USDC", withdraw_method: "solana", min_amount: 0.5 });
  await ctx.editMessageText(`🟣 <b>USDC (Solana) Withdrawal:</b>\nAvailable: <b>${bal.usdc.toFixed(2)} USDC</b>\n\nPaste your Solana destination address:`, { parse_mode: "HTML" });
});

bot.action("gateway_back", async (ctx) => {
  stopDepositWatcher(ctx.from.id);
  await clearSession(ctx.from.id);
  await ctx.answerCbQuery().catch(() => {});
  await ctx.deleteMessage().catch(() => {});
  const kb = await getMainKeyboard(ctx);
  await ctx.reply("🔙 Returned to main menu.", kb);
});

// Admin Callbacks
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
// 7. TEXT MESSAGE HANDLER (CUSTOM DEPOSITS, WITHDRAWALS & ADMIN)
// ----------------------------------------------------
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const isAdm = await isAuthorizedAdmin(ctx);

  if (text.startsWith("/start") || text.toLowerCase() === "start" || text === "🏠 Home") {
    stopDepositWatcher(ctx.from.id);
    await clearSession(ctx.from.id);
    await ctx.replyWithChatAction("typing");
    const walletText = await getWalletOverviewText(userId, ctx.from.id, isAdm);
    const kb = await getMainKeyboard(ctx);
    return ctx.reply(walletText, { parse_mode: "HTML", ...kb });
  }

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
      let chId = text.trim();
      if (ctx.message.forward_from_chat) chId = String(ctx.message.forward_from_chat.id);
      if (/^\d{8,14}$/.test(chId)) chId = `-100${chId}`;
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

  // B. CUSTOM DEPOSIT AMOUNT INPUT
  if (session.step === "awaiting_deposit_custom_amount") {
    const amount = Number(text);
    const minAmount = session.min_amount || (session.target_currency === "SATS" ? 1 : 0.5);

    if (isNaN(amount) || amount < minAmount) {
      const minText = session.target_currency === "SATS" ? `${minAmount.toLocaleString()} SATS` : `${minAmount} ${session.target_currency}`;
      return ctx.reply(`⚠️ Minimum deposit is ${minText}. Please enter a valid number.`);
    }

    const { target_currency, payment_method, network_label } = session;
    await clearSession(ctx.from.id);

    await handleGenerateDeposit(ctx, {
      targetCurrency: target_currency,
      paymentMethod: payment_method,
      amount: amount,
      minAmount: minAmount,
      networkLabel: network_label || payment_method.toUpperCase(),
      isCustomAmount: true
    });
    return;
  }

  // C. WITHDRAW DESTINATION INPUT
  if (session.step === "awaiting_withdraw_dest") {
    await ctx.replyWithChatAction("typing");

    let detectedAmount = null;
    let detectedCurrency = session.target_currency || "SATS";
    let detectedMethod = session.withdraw_method || "lightning";

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

    if (!detectedAmount && (text.toLowerCase().startsWith("lnbc") || text.toLowerCase().startsWith("lightning:lnbc"))) {
      detectedAmount = decodeBolt11Sats(text);
      if (detectedAmount) {
        detectedCurrency = "SATS";
        detectedMethod = "lightning";
      }
    }

    if (detectedAmount && detectedAmount > 0) {
      const bal = await getDirectBalance(userId, ctx.from.id);

      if (detectedCurrency === "SATS" && detectedAmount > bal.sats) {
        await clearSession(ctx.from.id);
        return ctx.reply(`⚠️ <b>Insufficient Balance!</b> You have <b>${bal.sats.toLocaleString()} SATS</b>.`, { parse_mode: "HTML" });
      }
      if (detectedCurrency === "USDT" && detectedAmount > bal.usdt) {
        await clearSession(ctx.from.id);
        return ctx.reply(`⚠️ <b>Insufficient Balance!</b> You have <b>${bal.usdt.toFixed(2)} USDT</b>.`, { parse_mode: "HTML" });
      }
      if (detectedCurrency === "USDC" && detectedAmount > bal.usdc) {
        await clearSession(ctx.from.id);
        return ctx.reply(`⚠️ <b>Insufficient Balance!</b> You have <b>${bal.usdc.toFixed(2)} USDC</b>.`, { parse_mode: "HTML" });
      }

      await setSession(ctx.from.id, {
        step: "confirm_payment",
        destination: text,
        amount: detectedAmount,
        withdraw_method: detectedMethod,
        currency: detectedCurrency
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

    const currentBal = await getDirectBalance(userId, ctx.from.id);
    let availText = `${currentBal.sats.toLocaleString()} SATS`;
    if (detectedCurrency === "USDT") availText = `${currentBal.usdt.toFixed(2)} USDT`;
    if (detectedCurrency === "USDC") availText = `${currentBal.usdc.toFixed(2)} USDC`;

    await setSession(ctx.from.id, { step: "awaiting_withdraw_amount", destination: text, currency: detectedCurrency });
    return ctx.reply(`📍 <b>Destination Address:</b>\n<code>${text}</code>\n\nAvailable: <b>${availText}</b>\nEnter the <b>amount in ${detectedCurrency} to send</b>:`, { parse_mode: "HTML" });
  }

  // D. WITHDRAW AMOUNT INPUT
  if (session.step === "awaiting_withdraw_amount") {
    const amount = Number(text);
    if (isNaN(amount) || amount <= 0) return ctx.reply("⚠️ Please enter a valid number.");
    
    const bal = await getDirectBalance(userId, ctx.from.id);
    const curr = session.currency || session.target_currency || "SATS";

    if (curr === "SATS" && amount > bal.sats) {
      return ctx.reply(`⚠️ Insufficient balance! You only have ${bal.sats.toLocaleString()} SATS.`);
    }
    if (curr === "USDT" && amount > bal.usdt) {
      return ctx.reply(`⚠️ Insufficient balance! You only have ${bal.usdt.toFixed(2)} USDT.`);
    }
    if (curr === "USDC" && amount > bal.usdc) {
      return ctx.reply(`⚠️ Insufficient balance! You only have ${bal.usdc.toFixed(2)} USDC.`);
    }

    const destination = session.destination;
    const withdrawMethod = session.withdraw_method || "lightning";

    await setSession(ctx.from.id, {
      step: "confirm_payment",
      destination,
      amount,
      withdraw_method: withdrawMethod,
      currency: curr
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
// PAYMENT DISPATCH CONFIRMATION
// ----------------------------------------------------
bot.action("confirm_send", async (ctx) => {
  await ctx.answerCbQuery("Broadcasting Send...").catch(() => {});
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

    if (!data.success) throw new Error(data.error || "Send failed.");

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
    const displayRecipient = destination.includes("@") ? destination : `${destination.substring(0, 24)}...`;
    await ctx.editMessageText(`❌ <b>Payment Failed:</b> ${err.message}`, { parse_mode: "HTML" });
  }
});

bot.action("cancel_send", async (ctx) => {
  stopDepositWatcher(ctx.from.id);
  await clearSession(ctx.from.id);
  await ctx.answerCbQuery("Cancelled").catch(() => {});
  await ctx.editMessageText("❌ Action cancelled.");
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
