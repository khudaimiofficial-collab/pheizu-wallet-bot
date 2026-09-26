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
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(id => id.trim());

// Approximate 1 sat in USD for display (~$65,000 BTC)
const SAT_TO_USD = 0.00065;

function isAdmin(ctx) {
  return ADMIN_IDS.includes(String(ctx.from?.id));
}

// Persistent Reply Keyboard (Grid)
function getMainKeyboard(ctx) {
  const rows = [
    ["💰 Balance", "📥 Deposit"],
    ["📤 Withdraw"]
  ];
  if (isAdmin(ctx)) {
    rows.push(["🔑 Set Key"]);
  }
  return Markup.keyboard(rows).resize();
}

// Deposit Gateway Inline Keyboard (Screenshot 2 Style)
function getDepositGatewayKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("⚡ SATS (Lightning)", "dep_sats_lightning"),
      Markup.button.callback("₿ BTC (On-Chain)", "dep_btc_onchain")
    ],
    [
      Markup.button.callback("💵 USDT (TRC-20)", "dep_usdt_trc20"),
      Markup.button.callback("💲 USDC (Solana)", "dep_usdc_solana")
    ],
    [
      Markup.button.callback("🔙 Back", "gateway_back")
    ]
  ]);
}

// Withdrawal Gateway Inline Keyboard (Screenshot 2 Style)
function getWithdrawGatewayKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("⚡ SATS (Lightning)", "with_sats_lightning"),
      Markup.button.callback("₿ BTC (On-Chain)", "with_btc_onchain")
    ],
    [
      Markup.button.callback("💵 USDT (TRC-20)", "with_usdt_trc20"),
      Markup.button.callback("💲 USDC (Solana)", "with_usdc_solana")
    ],
    [
      Markup.button.callback("🔙 Back", "gateway_back")
    ]
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

// Helper: Format Wallet Overview (Screenshot 1 Style)
async function getWalletOverviewText(userId, telegramId) {
  let sats = 0;
  try {
    const res = await fetch(`${APP_URL}/api/wallet?action=balance&user_id=${encodeURIComponent(userId)}&telegram_id=${telegramId}`);
    const data = await res.json();
    if (data.success) sats = Number(data.balance || 0);
  } catch (e) {}

  const satsUsd = (sats * SAT_TO_USD).toFixed(2);
  const totalUsd = satsUsd;

  return (
    `💳 <b>My Wallet</b>\n\n` +
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
  let attempts = 0;
  const maxAttempts = 60;

  const timer = setInterval(async () => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(timer);
      return;
    }

    try {
      const res = await fetch(`${APP_URL}/api/wallet?action=check-status&payment_id=${paymentId}&user_id=${targetUserId}&telegram_id=${chatId}`);
      const data = await res.json();

      if (data && data.is_paid) {
        clearInterval(timer);
        const amount = data.amount || expectedAmount;
        const txId = data.tx_id || paymentId;

        const bRes = await fetch(`${APP_URL}/api/wallet?action=balance&user_id=${targetUserId}&telegram_id=${chatId}`);
        const bData = await bRes.json();
        const currentBal = bData.success ? Number(bData.balance).toLocaleString() : "...";

        await bot.telegram.sendMessage(
          chatId,
          `🎉 <b>Payment Received!</b>\n\n` +
          `⚡ <b>+${amount} sats</b> credited to your balance!\n` +
          `💰 <b>New Balance:</b> ${currentBal} sats\n` +
          `🆔 <b>TxID:</b> <code>${txId}</code>`,
          { parse_mode: "HTML" }
        );
      }
    } catch (e) {}
  }, 3000);
}

// ----------------------------------------------------
// 1. /START (Displays My Wallet List)
// ----------------------------------------------------
bot.start(async (ctx) => {
  await clearSession(ctx.from.id);
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();

  await ctx.replyWithChatAction("typing");
  const walletText = await getWalletOverviewText(userId, ctx.from.id);

  await ctx.reply(walletText, {
    parse_mode: "HTML",
    ...getMainKeyboard(ctx)
  });
});

// ----------------------------------------------------
// 2. 💰 BALANCE (Displays My Wallet List)
// ----------------------------------------------------
bot.hears("💰 Balance", async (ctx) => {
  await clearSession(ctx.from.id);
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();

  await ctx.replyWithChatAction("typing");
  const walletText = await getWalletOverviewText(userId, ctx.from.id);

  await ctx.reply(walletText, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      Markup.button.webApp("📱 Open WebApp", APP_URL)
    ])
  });
});

// ----------------------------------------------------
// 3. 📥 DEPOSIT (Gateway Selector - Screenshot 2)
// ----------------------------------------------------
bot.hears("📥 Deposit", async (ctx) => {
  await clearSession(ctx.from.id);

  await ctx.reply(
    `🔥 <b>Select a Deposit Gateway:</b> 🔥`,
    {
      parse_mode: "HTML",
      ...getDepositGatewayKeyboard()
    }
  );
});

// ----------------------------------------------------
// 4. 📤 WITHDRAW (Gateway Selector - Screenshot 2)
// ----------------------------------------------------
bot.hears("📤 Withdraw", async (ctx) => {
  await clearSession(ctx.from.id);

  await ctx.reply(
    `🔥 <b>Select a Withdrawal Gateway:</b> 🔥`,
    {
      parse_mode: "HTML",
      ...getWithdrawGatewayKeyboard()
    }
  );
});

// ----------------------------------------------------
// 5. 🔑 SET KEY (Admin)
// ----------------------------------------------------
bot.hears("🔑 Set Key", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("⛔ Access denied: You are not authorized.");
  }

  await setSession(ctx.from.id, { step: "awaiting_admin_key" });

  await ctx.reply(
    `🔑 <b>Set Speed API Secret Key</b>\n\n` +
    `Paste your API key directly in this chat:`,
    { parse_mode: "HTML" }
  );
});

// ----------------------------------------------------
// GATEWAY CALLBACK ACTIONS
// ----------------------------------------------------

// Back Button Action
bot.action("gateway_back", async (ctx) => {
  await clearSession(ctx.from.id);
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
  await ctx.reply("🔙 Returned to main menu.", getMainKeyboard(ctx));
});

// DEPOSIT GATEWAYS
bot.action("dep_sats_lightning", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const lnAddress = `${userId}@${DOMAIN}`;

  await setSession(ctx.from.id, { 
    step: "awaiting_deposit_amount",
    target_currency: "SATS",
    payment_method: "lightning"
  });

  await ctx.editMessageText(
    `⚡ <b>Deposit SATS (Lightning Network)</b>\n\n` +
    `👉 <b>Lightning Address:</b>\n<code>${lnAddress}</code>\n<i>(Tap to copy & pay from any wallet)</i>\n\n` +
    `<b>Or generate an Invoice QR:</b>\n` +
    `Reply with amount in <b>sats</b> (Min: <b>1 sat</b>, e.g. <code>50</code>):`,
    { parse_mode: "HTML" }
  );
});

bot.action("dep_btc_onchain", async (ctx) => {
  await ctx.answerCbQuery();
  await setSession(ctx.from.id, { 
    step: "awaiting_deposit_amount",
    target_currency: "SATS",
    payment_method: "on-chain"
  });

  await ctx.editMessageText(
    `₿ <b>Deposit Bitcoin (On-Chain)</b>\n\n` +
    `Reply with the amount in <b>sats</b> you want to deposit (e.g. <code>10000</code>):`,
    { parse_mode: "HTML" }
  );
});

bot.action("dep_usdt_trc20", async (ctx) => {
  await ctx.answerCbQuery();
  await setSession(ctx.from.id, { 
    step: "awaiting_deposit_amount",
    target_currency: "USDT",
    payment_method: "tron"
  });

  await ctx.editMessageText(
    `💵 <b>Deposit USDT (TRC-20)</b>\n\n` +
    `Reply with the amount in <b>USDT</b> you want to deposit (e.g. <code>10</code>):`,
    { parse_mode: "HTML" }
  );
});

bot.action("dep_usdc_solana", async (ctx) => {
  await ctx.answerCbQuery();
  await setSession(ctx.from.id, { 
    step: "awaiting_deposit_amount",
    target_currency: "USDC",
    payment_method: "solana"
  });

  await ctx.editMessageText(
    `💲 <b>Deposit USDC (Solana)</b>\n\n` +
    `Reply with the amount in <b>USDC</b> you want to deposit (e.g. <code>10</code>):`,
    { parse_mode: "HTML" }
  );
});

// WITHDRAWAL GATEWAYS
bot.action("with_sats_lightning", async (ctx) => {
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
      balance 
    });

    await ctx.editMessageText(
      `⚡ <b>Withdraw SATS (Lightning)</b>\nAvailable: <b>${balance.toLocaleString()} sats</b>\n\n` +
      `Paste the recipient's <b>Lightning Invoice</b> (<code>lnbc...</code>) or <b>Lightning Address</b> (e.g. <code>name@speed.app</code>):`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    ctx.editMessageText("⚠️ Error checking balance. Please try again.");
  }
});

bot.action("with_btc_onchain", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("₿ <b>Bitcoin On-Chain Withdrawal:</b>\nPaste your Bitcoin On-Chain destination address (<code>bc1...</code> or <code>1...</code>):");
});

bot.action("with_usdt_trc20", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("💵 <b>USDT (TRC-20) Withdrawal:</b>\nPaste your Tron USDT wallet address (<code>T...</code>):");
});

bot.action("with_usdc_solana", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("💲 <b>USDC (Solana) Withdrawal:</b>\nPaste your Solana USDC wallet address:");
});

// ----------------------------------------------------
// 6. TEXT MESSAGE HANDLER
// ----------------------------------------------------
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  const session = await getSession(ctx.from.id);
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();

  if (["💰 Balance", "📥 Deposit", "📤 Withdraw", "🔑 Set Key"].includes(text)) {
    return;
  }

  // A. PROCESS DEPOSIT AMOUNT
  if (session.step === "awaiting_deposit_amount") {
    const amount = parseInt(text, 10);
    if (isNaN(amount) || amount < 1) {
      return ctx.reply("⚠️ Minimum deposit is 1. Please enter a valid number (e.g. 50).");
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
        throw new Error(data.error || "Could not generate invoice.");
      }

      const txId = data.tx_id || data.id;

      // Styled Cyberpunk QR
      const qrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(data.invoice)}&size=400&dark=00e676&light=0b0e14&margin=2&ecLevel=Q&centerImageUrl=https%3A%2F%2Fcdn-icons-png.flaticon.com%2F512%2F1198%2F1198305.png&centerImageSizeRatio=0.22`;

      await ctx.replyWithPhoto(qrUrl, {
        caption:
          `⚡ <b>Deposit Invoice Created</b>\n\n` +
          `💰 <b>Amount:</b> ${amount} ${targetCurrency}\n` +
          `🆔 <b>TxID:</b> <code>${txId}</code>\n\n` +
          `<code>${data.invoice}</code>\n\n` +
          `<i>Scan QR or tap invoice to copy. Waiting for payment...</i>`,
        parse_mode: "HTML"
      });

      startDepositWatcher(ctx.from.id, txId, amount, userId);
    } catch (err) {
      ctx.reply(`❌ Failed to create deposit: ${err.message}`);
    }
    return;
  }

  // B. PROCESS WITHDRAW DESTINATION
  if (session.step === "awaiting_withdraw_dest") {
    const isInvoice = text.toLowerCase().startsWith("lnbc") || text.toLowerCase().startsWith("lightning:lnbc");

    // Case 1: Lightning Invoice
    if (isInvoice) {
      await ctx.replyWithChatAction("typing");

      let detectedSats = null;

      if (db) {
        const invSnap = await db.collection("invoices")
          .where("invoice", "==", text)
          .where("is_paid", "==", false)
          .limit(1)
          .get();
        if (!invSnap.empty) {
          detectedSats = Number(invSnap.docs[0].data().amount || 0);
        }
      }

      if (!detectedSats) {
        detectedSats = decodeBolt11Sats(text);
      }

      if (!detectedSats || detectedSats <= 0) {
        await setSession(ctx.from.id, {
          step: "awaiting_withdraw_amount",
          destination: text,
          balance: session.balance
        });
        return ctx.reply(
          `📍 <b>Invoice detected without preset amount.</b>\n\n` +
          `Enter the <b>amount in sats</b> to pay (Max: <b>${session.balance} sats</b>):`,
          { parse_mode: "HTML" }
        );
      }

      if (detectedSats > session.balance) {
        await clearSession(ctx.from.id);
        return ctx.reply(
          `⚠️ <b>Insufficient Balance!</b>\n` +
          `This invoice requires <b>${detectedSats.toLocaleString()} sats</b>, but your available balance is <b>${session.balance.toLocaleString()} sats</b>.`,
          { parse_mode: "HTML" }
        );
      }

      // Confirmation button (Waits for send click)
      await setSession(ctx.from.id, {
        step: "confirm_payment",
        destination: text,
        amount: detectedSats,
        balance: session.balance
      });

      return ctx.reply(
        `⚡ <b>Invoice Detected!</b>\n\n` +
        `💰 <b>Amount:</b> ${detectedSats.toLocaleString()} sats\n` +
        `🎯 <b>Invoice:</b> <code>${text.substring(0, 32)}...</code>\n` +
        `💳 <b>Your Balance:</b> ${session.balance.toLocaleString()} sats\n\n` +
        `Click <b>Send</b> below to confirm payment:`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback(`🚀 Send ${detectedSats.toLocaleString()} sats`, "confirm_send")],
            [Markup.button.callback("❌ Cancel", "cancel_send")]
          ])
        }
      );
    }

    // Case 2: Lightning Address
    await setSession(ctx.from.id, {
      step: "awaiting_withdraw_amount",
      destination: text,
      balance: session.balance
    });

    return ctx.reply(
      `📍 <b>Destination:</b>\n<code>${text}</code>\n\n` +
      `Enter the <b>amount in sats</b> to send (Max: <b>${session.balance} sats</b>):`,
      { parse_mode: "HTML" }
    );
  }

  // C. PROCESS WITHDRAW AMOUNT
  if (session.step === "awaiting_withdraw_amount") {
    const amount = parseInt(text, 10);
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply("⚠️ Please enter a valid positive number.");
    }
    if (amount > session.balance) {
      return ctx.reply(`⚠️ Insufficient balance! You only have ${session.balance} sats.`);
    }

    const destination = session.destination;

    await setSession(ctx.from.id, {
      step: "confirm_payment",
      destination,
      amount,
      balance: session.balance
    });

    return ctx.reply(
      `⚡ <b>Payment Summary</b>\n\n` +
      `💰 <b>Amount:</b> ${amount.toLocaleString()} sats\n` +
      `🎯 <b>Recipient:</b> <code>${destination}</code>\n` +
      `💳 <b>Your Balance:</b> ${session.balance.toLocaleString()} sats\n\n` +
      `Click <b>Send</b> below to confirm payment:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`🚀 Send ${amount.toLocaleString()} sats`, "confirm_send")],
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
// 7. CONFIRM SEND & CANCEL BUTTON CALLBACKS
// ----------------------------------------------------
bot.action("confirm_send", async (ctx) => {
  await ctx.answerCbQuery("Processing payment...");
  const session = await getSession(ctx.from.id);
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();

  if (!session.destination || !session.amount) {
    return ctx.editMessageText("⚠️ Payment session expired. Please start over by tapping 📤 Withdraw.");
  }

  const { destination, amount } = session;
  await clearSession(ctx.from.id);

  await ctx.editMessageText(`⏳ <b>Broadcasting payment of ${amount.toLocaleString()} sats...</b>`, { parse_mode: "HTML" });

  try {
    const res = await fetch(`${APP_URL}/api/wallet?action=send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        destination,
        amount,
        user_id: userId,
        username: userId,
        telegram_id: String(ctx.from.id)
      })
    });
    const data = await res.json();

    if (!data.success) {
      throw new Error(data.error || "Withdrawal failed.");
    }

    const txId = data.tx_id || data.id || "N/A";
    const displayRecipient = destination.includes("@") ? destination : `${destination.substring(0, 24)}...`;

    await ctx.editMessageText(
      `✅ <b>Payment Successful!</b>\n\n` +
      `💸 <b>Amount Sent:</b> ${amount.toLocaleString()} sats\n` +
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
