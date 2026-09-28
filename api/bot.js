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

// Set native Telegram WebApp Menu Button (bottom-left next to input field)
bot.telegram.setChatMenuButton({
  menuButton: {
    type: "web_app",
    text: "⚡ Wallet",
    web_app: { url: APP_URL }
  }
}).catch(() => {});

// ----------------------------------------------------
// Helper: Blue inline button
// ----------------------------------------------------
function blueBtn(text, data) {
  return { text, callback_data: data, style: "primary" };
}
function blueUrl(text, url) {
  return { text, url, style: "primary" };
}
function blueWebApp(text, url) {
  return { text, web_app: { url }, style: "primary" };
}
function blueKb(rows) {
  return { reply_markup: { inline_keyboard: rows } };
}

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

// Persistent Reply Keyboard with WebApp launcher and action buttons
async function getMainKeyboard(ctx) {
  const launchUrl = `${APP_URL}?telegram_id=${ctx.from?.id}&username=${encodeURIComponent(ctx.from?.username || "")}`;

  const rows = [
    [{ text: "📱 Open WebApp", web_app: { url: launchUrl } }, { text: "💰 Balance", style: "primary" }],
    [{ text: "📥 Deposit", style: "primary" }, { text: "📤 Withdraw", style: "primary" }],
    [{ text: "📜 History", style: "primary" }]
  ];

  if (await isAuthorizedAdmin(ctx)) {
    rows.push([{ text: "👑 Admin Panel", style: "primary" }]);
  }

  return Markup.keyboard(rows).resize();
}

// Keyboards
function getWithdrawAssetKeyboard() {
  return blueKb([
    [blueBtn("⚡ Bitcoin (SATS)", "with_asset_sats")],
    [blueBtn("💵 USDT", "with_asset_usdt"), blueBtn("💲 USDC", "with_asset_usdc")],
    [blueBtn("🔙 Back to Main Menu", "gateway_back")]
  ]);
}

function getSatsWithdrawNetworks() {
  return blueKb([
    [blueBtn("⚡ Lightning", "with_net_sats_lightning"), blueBtn("₿ On-Chain", "with_net_sats_onchain")],
    [blueBtn("🔙 Back to Assets", "with_back_to_assets")]
  ]);
}

function getUsdtWithdrawNetworks() {
  return blueKb([
    [blueBtn("⚡ Lightning", "with_net_usdt_lightning"), blueBtn("⛓️ Ethereum", "with_net_usdt_ethereum")],
    [blueBtn("🔴 Tron (TRC-20)", "with_net_usdt_tron"), blueBtn("🟣 Solana", "with_net_usdt_solana")],
    [blueBtn("💎 TON", "with_net_usdt_ton")],
    [blueBtn("🔙 Back to Assets", "with_back_to_assets")]
  ]);
}

function getUsdcWithdrawNetworks() {
  return blueKb([
    [blueBtn("⚡ Lightning", "with_net_usdc_lightning"), blueBtn("⛓️ Ethereum", "with_net_usdc_ethereum")],
    [blueBtn("🟣 Solana", "with_net_usdc_solana")],
    [blueBtn("🔙 Back to Assets", "with_back_to_assets")]
  ]);
}

function getDepositAssetKeyboard() {
  return blueKb([
    [blueBtn("⚡ Bitcoin (SATS)", "dep_asset_sats")],
    [blueBtn("💵 USDT", "dep_asset_usdt"), blueBtn("💲 USDC", "dep_asset_usdc")],
    [blueBtn("🔙 Back", "gateway_back")]
  ]);
}

function getUsdtDepositNetworks() {
  return blueKb([
    [blueBtn("⚡ Lightning", "dep_net_usdt_lightning"), blueBtn("⛓️ Ethereum", "dep_net_usdt_ethereum")],
    [blueBtn("🔴 Tron (TRC-20)", "dep_net_usdt_tron"), blueBtn("🟣 Solana", "dep_net_usdt_solana")],
    [blueBtn("💎 TON", "dep_net_usdt_ton")],
    [blueBtn("🔙 Back to Assets", "dep_back_to_assets")]
  ]);
}

function getUsdcDepositNetworks() {
  return blueKb([
    [blueBtn("⚡ Lightning", "dep_net_usdc_lightning"), blueBtn("⛓️ Ethereum", "dep_net_usdc_ethereum")],
    [blueBtn("🟣 Solana", "dep_net_usdc_solana")],
    [blueBtn("🔙 Back to Assets", "dep_back_to_assets")]
  ]);
}

function getSatsDepositNetworks() {
  return blueKb([
    [blueBtn("⚡ Lightning", "dep_net_sats_lightning"), blueBtn("₿ On-Chain", "dep_net_sats_onchain")],
    [blueBtn("🔙 Back to Assets", "dep_back_to_assets")]
  ]);
}

function getAdminDashboardKeyboard() {
  return blueKb([
    [blueBtn("👤 Manage Users", "admin_users_menu"), blueBtn("📢 Broadcast", "admin_broadcast_prompt")],
    [blueBtn("📋 Logs Channel", "admin_logs_prompt"), blueBtn("👑 Admins (Add/Del)", "admin_admins_menu")],
    [blueBtn("🔑 Set Speed Key", "admin_setkey_prompt"), blueBtn("❌ Close", "admin_close")]
  ]);
}

function getAdminUserManagementKeyboard() {
  return blueKb([
    [blueBtn("🚫 Ban User", "adm_ban_user"), blueBtn("✅ Unban User", "adm_unban_user")],
    [blueBtn("➕ Add Balance", "adm_add_bal"), blueBtn("➖ Deduct Balance", "adm_deduct_bal")],
    [blueBtn("🗑️ Delete User", "adm_del_user"), blueBtn("🔙 Back to Admin", "admin_main_dashboard")]
  ]);
}

function getAdminAdminsKeyboard() {
  return blueKb([
    [blueBtn("➕ Add Admin", "adm_add_admin"), blueBtn("➖ Delete Admin", "adm_del_admin")],
    [blueBtn("📋 List Admins", "adm_list_admins"), blueBtn("🔙 Back to Admin", "admin_main_dashboard")]
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

function startDepositWatcher(chatId, paymentId, expectedAmount, targetUserId) {
  stopDepositWatcher(chatId);
  let attempts = 0;
  const maxAttempts = 90;

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
  }, 2000);

  activeWatchers.set(String(chatId), timer);
}

// Wallet overview
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
    `⚡ <b>Lightning Address:</b> <code>${userId}@${DOMAIN}</code>`
  );
}

function decodeBolt11Sats(invoice) {
  const clean = invoice.trim().toLowerCase().replace(/^lightning:/, "");
  const match = clean.match(/^ln(?:bc|tb|bcrt)([0-9]+)([munp]?)1/);
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

function showDepositChoiceMenu(ctx, { targetCurrency, paymentMethod, networkLabel }) {
  const isSats = targetCurrency === "SATS";
  const backAssetCallback = isSats ? "dep_asset_sats" : (targetCurrency === "USDT" ? "dep_asset_usdt" : "dep_asset_usdc");

  let rows = [];
  if (isSats && paymentMethod === "lightning") {
    rows.push([blueBtn("⚡ Quick Invoice (Open Amount)", `dep_opt:open:SATS:lightning`)]);
    rows.push([
      blueBtn("⚡ 100 SATS", `dep_preset:SATS:lightning:100`),
      blueBtn("⚡ 500 SATS", `dep_preset:SATS:lightning:500`)
    ]);
    rows.push([
      blueBtn("⚡ 1,000 SATS", `dep_preset:SATS:lightning:1000`),
      blueBtn("⚡ 5,000 SATS", `dep_preset:SATS:lightning:5000`)
    ]);
    rows.push([blueBtn("🔢 Enter Custom Amount", `dep_opt:amt:SATS:lightning`)]);
  } else if (!isSats) {
    rows.push([blueBtn("⚡ Quick Deposit Address", `dep_opt:open:${targetCurrency}:${paymentMethod}`)]);
    rows.push([
      blueBtn(`💵 5 ${targetCurrency}`, `dep_preset:${targetCurrency}:${paymentMethod}:5`),
      blueBtn(`💵 10 ${targetCurrency}`, `dep_preset:${targetCurrency}:${paymentMethod}:10`)
    ]);
    rows.push([blueBtn("🔢 Enter Custom Amount", `dep_opt:amt:${targetCurrency}:${paymentMethod}`)]);
  } else {
    rows.push([blueBtn("⚡ Quick Deposit Address", `dep_opt:open:SATS:onchain`)]);
    rows.push([blueBtn("🔢 Enter Custom Amount", `dep_opt:amt:SATS:onchain`)]);
  }

  rows.push([blueBtn("🔙 Back to Networks", backAssetCallback)]);

  return ctx.editMessageText(
    `📥 <b>Deposit ${targetCurrency} (${networkLabel})</b>\n\n` +
    `Choose your deposit option below:`,
    { parse_mode: "HTML", ...blueKb(rows) }
  );
}

async function handleGenerateDeposit(ctx, { targetCurrency, paymentMethod, amount, networkLabel, isCustomAmount }) {
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  await clearSession(ctx.from.id);

  let statusMsg = null;
  const isSpecified = Boolean(isCustomAmount && amount && Number(amount) > 0);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(`⏳ <b>Generating ${targetCurrency} (${networkLabel}) deposit details...</b>`, { parse_mode: "HTML" }).catch(() => {});
  } else {
    statusMsg = await ctx.reply(`⏳ <b>Generating ${targetCurrency} (${networkLabel}) deposit details...</b>`, { parse_mode: "HTML" });
  }

  try {
    const payload = {
      target_currency: targetCurrency,
      payment_method: paymentMethod,
      user_id: userId,
      username: userId,
      telegram_id: String(ctx.from.id)
    };

    if (isSpecified) payload.amount = Number(amount);

    const res = await fetch(`${APP_URL}/api/wallet?action=create-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!data.success || !data.invoice) throw new Error(data.error || "Failed to generate deposit details.");

    const txId = data.tx_id || data.id;
    const isLightning = paymentMethod === "lightning" || data.invoice.toLowerCase().startsWith("lnbc");
    const qrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(data.invoice)}&size=400&dark=00e676&light=0b0e14&margin=2&ecLevel=Q`;

    let caption = "";
    if (isLightning) {
      const amtLine = isSpecified
        ? `💰 <b>Amount:</b> <code>${Number(amount).toLocaleString()} ${targetCurrency}</code>\n`
        : `💰 <b>Amount:</b> <i>Open Amount</i>\n`;

      caption = `⚡ <b>Lightning Deposit Invoice</b>\n\n` +
        amtLine +
        `🌐 <b>Network:</b> Lightning Network (${targetCurrency})\n\n` +
        `<b>Invoice (tap to copy):</b>\n<code>${data.invoice}</code>\n\n` +
        `🆔 <b>TxID:</b> <code>${txId}</code>\n\n` +
        `<i>Scan QR or copy invoice to pay. Waiting for payment...</i>`;
    } else {
      const amtLine = isSpecified ? `💰 <b>Expected Amount:</b> <code>${amount} ${targetCurrency}</code>\n` : ``;
      caption = `📥 <b>${targetCurrency} Deposit Address</b>\n\n` +
        amtLine +
        `🌐 <b>Network:</b> ${networkLabel}\n\n` +
        `👉 <b>Deposit Address:</b>\n<code>${data.invoice}</code>\n\n` +
        `🆔 <b>TxID:</b> <code>${txId}</code>`;
    }

    if (ctx.callbackQuery) {
      await ctx.deleteMessage().catch(() => {});
    } else if (statusMsg) {
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    }

    await ctx.replyWithPhoto(qrUrl, {
      caption,
      parse_mode: "HTML",
      ...blueKb([[blueBtn("🔄 Check Status", `check_dep:${txId}`)]])
    });

    startDepositWatcher(ctx.from.id, txId, isSpecified ? amount : 0, userId);
  } catch (err) {
    await ctx.reply(`❌ <b>Deposit Error:</b> ${err.message}`, { parse_mode: "HTML" });
  }
}

// Preset Action
bot.action(/^dep_preset:([^:]+):([^:]+):([^:]+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return handleGenerateDeposit(ctx, {
    targetCurrency: ctx.match[1],
    paymentMethod: ctx.match[2],
    amount: Number(ctx.match[3]),
    networkLabel: ctx.match[2] === "lightning" ? "Lightning Network" : ctx.match[2].toUpperCase(),
    isCustomAmount: true
  });
});

// Check Deposit Status Action
bot.action(/^check_dep:(.+)$/, async (ctx) => {
  const paymentId = ctx.match[1];
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const chatId = ctx.from.id;

  try {
    const res = await fetch(`${APP_URL}/api/wallet?action=check-status&payment_id=${paymentId}&user_id=${userId}&telegram_id=${chatId}`);
    const data = await res.json();

    if (data && data.is_paid) {
      stopDepositWatcher(chatId);
      const amtStr = data.amount ? `+${Number(data.amount).toLocaleString()} ${data.currency || "SATS"}` : "Funds";

      await ctx.answerCbQuery(`🎉 Payment Received!\n\n${amtStr} has been credited!`, { show_alert: true });
      await ctx.editMessageReplyMarkup(blueKb([[blueBtn("✅ Payment Confirmed", "gateway_back")]]).reply_markup).catch(() => {});
    } else {
      await ctx.answerCbQuery(`⏳ Payment Status: ${(data?.status || "pending").toUpperCase()}\n\nPlease wait and try again.`, { show_alert: true });
    }
  } catch (err) {
    await ctx.answerCbQuery(`⚠️ Error: ${err.message}`, { show_alert: true }).catch(() => {});
  }
});

// Bot Start & Text commands
bot.start(async (ctx) => {
  stopDepositWatcher(ctx.from.id);
  await clearSession(ctx.from.id);

  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  if (await isUserBanned(userId, ctx.from.id)) return ctx.reply("⛔ Your account has been suspended.");

  if (db) {
    await db.collection("users").doc(userId).set({
      user_id: userId,
      telegram_id: String(ctx.from.id),
      username: ctx.from.username || null,
      updated_at: new Date().toISOString()
    }, { merge: true });
  }

  const isAdm = await isAuthorizedAdmin(ctx);
  const walletText = await getWalletOverviewText(userId, ctx.from.id, isAdm);
  const kb = await getMainKeyboard(ctx);

  await ctx.reply(walletText, { parse_mode: "HTML", ...kb });
});

bot.hears("💰 Balance", async (ctx) => {
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const isAdm = await isAuthorizedAdmin(ctx);
  const walletText = await getWalletOverviewText(userId, ctx.from.id, isAdm);

  await ctx.reply(walletText, {
    parse_mode: "HTML",
    ...blueKb([[blueWebApp("📱 Open WebApp", `${APP_URL}?telegram_id=${ctx.from.id}&username=${userId}`)]])
  });
});

bot.hears("📜 History", async (ctx) => {
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
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
      if (tx.type === "deposit") msg += `📥 <b>Deposit:</b> +${amt} ${curr}\n`;
      else msg += `📤 <b>Withdrawal:</b> -${amt} ${curr}\n`;
      msg += `📅 <code>${date} UTC</code>\n─────────────────────\n`;
    });

    await ctx.reply(msg, { parse_mode: "HTML" });
  } catch (e) {
    ctx.reply("⚠️ Could not load history.");
  }
});

bot.hears("📥 Deposit", async (ctx) => {
  await ctx.reply(`🔥 <b>Select a Deposit Asset:</b> 🔥`, { parse_mode: "HTML", ...getDepositAssetKeyboard() });
});

bot.hears("📤 Withdraw", async (ctx) => {
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const bal = await getDirectBalance(userId, ctx.from.id);

  await ctx.reply(
    `📤 <b>Withdraw / Send Funds</b>\n` +
    `💰 <b>Available Balances:</b>\n` +
    `• ⚡ SATS: <b>${bal.sats.toLocaleString()} SATS</b>\n` +
    `• 💵 USDT: <b>${bal.usdt.toFixed(2)} USDT</b>\n` +
    `• 💲 USDC: <b>${bal.usdc.toFixed(2)} USDC</b>\n\n` +
    `🔥 <b>Select a Withdrawal Asset:</b> 🔥`,
    { parse_mode: "HTML", ...getWithdrawAssetKeyboard() }
  );
});

bot.hears("👑 Admin Panel", async (ctx) => {
  if (!(await isAuthorizedAdmin(ctx))) return ctx.reply("⛔ Access denied.");
  await ctx.reply(`👑 <b>Administrator Control Panel:</b>`, { parse_mode: "HTML", ...getAdminDashboardKeyboard() });
});

bot.action("gateway_back", async (ctx) => {
  stopDepositWatcher(ctx.from.id);
  await clearSession(ctx.from.id);
  await ctx.answerCbQuery().catch(() => {});
  await ctx.deleteMessage().catch(() => {});
  const kb = await getMainKeyboard(ctx);
  await ctx.reply("🔙 Returned to main menu.", kb);
});

// Deposit / Withdraw callbacks
bot.action("dep_back_to_assets", async (ctx) => {
  await ctx.editMessageText(`🔥 <b>Select a Deposit Asset:</b> 🔥`, { parse_mode: "HTML", ...getDepositAssetKeyboard() });
});
bot.action("dep_asset_sats", async (ctx) => {
  await ctx.editMessageText(`🔥 <b>Select Bitcoin Network:</b> 🔥`, { parse_mode: "HTML", ...getSatsDepositNetworks() });
});
bot.action("dep_asset_usdt", async (ctx) => {
  await ctx.editMessageText(`🔥 <b>Select USDT Network:</b> 🔥`, { parse_mode: "HTML", ...getUsdtDepositNetworks() });
});
bot.action("dep_asset_usdc", async (ctx) => {
  await ctx.editMessageText(`🔥 <b>Select USDC Network:</b> 🔥`, { parse_mode: "HTML", ...getUsdcDepositNetworks() });
});
bot.action("dep_net_sats_lightning", async (ctx) => {
  return showDepositChoiceMenu(ctx, { targetCurrency: "SATS", paymentMethod: "lightning", networkLabel: "Lightning Network" });
});
bot.action("dep_net_sats_onchain", async (ctx) => {
  return showDepositChoiceMenu(ctx, { targetCurrency: "SATS", paymentMethod: "onchain", networkLabel: "Bitcoin On-Chain" });
});
bot.action("dep_net_usdt_lightning", async (ctx) => {
  return showDepositChoiceMenu(ctx, { targetCurrency: "USDT", paymentMethod: "lightning", networkLabel: "Lightning" });
});
bot.action("dep_net_usdt_tron", async (ctx) => {
  return showDepositChoiceMenu(ctx, { targetCurrency: "USDT", paymentMethod: "tron", networkLabel: "Tron (TRC-20)" });
});
bot.action("dep_net_usdc_lightning", async (ctx) => {
  return showDepositChoiceMenu(ctx, { targetCurrency: "USDC", paymentMethod: "lightning", networkLabel: "Lightning" });
});

bot.action(/^dep_opt:(amt|open):([^:]+):([^:]+)$/, async (ctx) => {
  const mode = ctx.match[1];
  const targetCurrency = ctx.match[2];
  const paymentMethod = ctx.match[3];
  const networkLabel = paymentMethod === "lightning" ? "Lightning Network" : paymentMethod.toUpperCase();

  if (mode === "amt") {
    await setSession(ctx.from.id, {
      step: "awaiting_deposit_custom_amount",
      target_currency: targetCurrency,
      payment_method: paymentMethod,
      network_label: networkLabel
    });
    return ctx.reply(`Please reply with the exact amount of ${targetCurrency} you want to deposit:`);
  }
  return handleGenerateDeposit(ctx, { targetCurrency, paymentMethod, amount: 0, networkLabel, isCustomAmount: false });
});

// Text input router
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const session = await getSession(ctx.from.id);

  if (session.step === "awaiting_deposit_custom_amount") {
    const amount = Number(text);
    if (!amount || amount <= 0) return ctx.reply("⚠️ Please enter a valid positive number.");

    const { target_currency, payment_method, network_label } = session;
    await clearSession(ctx.from.id);

    return handleGenerateDeposit(ctx, {
      targetCurrency: target_currency,
      paymentMethod: payment_method,
      amount,
      networkLabel: network_label,
      isCustomAmount: true
    });
  }
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
