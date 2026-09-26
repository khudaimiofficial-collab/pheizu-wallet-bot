const { Telegraf, Markup } = require("telegraf");
const admin = require("firebase-admin");

// Initialize Firebase Admin (persists sessions, balance & keys)
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
    console.error("Firebase init fallback:", e.message);
  }
}

const db = admin.apps.length ? admin.firestore() : null;
const bot = new Telegraf(process.env.BOT_TOKEN);

const DOMAIN = "pheizu-wallet-bot.vercel.app";
const APP_URL = process.env.WEBAPP_URL || `https://${DOMAIN}`;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(id => id.trim());

// Helper: Check if user is admin
function isAdmin(ctx) {
  return ADMIN_IDS.includes(String(ctx.from?.id));
}

// Persistent Bottom Menu Grid
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

// Session Helpers in Firestore (Works reliably across Vercel serverless requests)
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

// ----------------------------------------------------
// 1. /START COMMAND
// ----------------------------------------------------
bot.start(async (ctx) => {
  await clearSession(ctx.from.id);
  const name = ctx.from.first_name || "User";

  await ctx.reply(
    `👋 Hello, <b>${name}</b>!\n\nWelcome to <b>Pheizu Lightning Wallet</b>.\nChoose an option from the menu below:`,
    {
      parse_mode: "HTML",
      ...getMainKeyboard(ctx)
    }
  );
});

// ----------------------------------------------------
// 2. 💰 BALANCE BUTTON
// ----------------------------------------------------
bot.hears("💰 Balance", async (ctx) => {
  await clearSession(ctx.from.id);
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();

  await ctx.replyWithChatAction("typing");

  try {
    const res = await fetch(`${APP_URL}/api/wallet?action=balance&user_id=${encodeURIComponent(userId)}&telegram_id=${ctx.from.id}`);
    const data = await res.json();
    const balance = data.success ? Number(data.balance || 0).toLocaleString() : "0";

    await ctx.reply(
      `⚡ <b>Pheizu Wallet Balance</b>\n\n` +
      `💰 Available: <b>${balance} sats</b>\n` +
      `📬 Lightning Address: <code>${userId}@${DOMAIN}</code>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          Markup.button.webApp("📱 Open Mini App", APP_URL)
        ])
      }
    );
  } catch (err) {
    ctx.reply("⚠️ Could not fetch balance. Please try again later.");
  }
});

// ----------------------------------------------------
// 3. 📥 DEPOSIT (Address -> Amount -> Invoice)
// ----------------------------------------------------
bot.hears("📥 Deposit", async (ctx) => {
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();
  const lnAddress = `${userId}@${DOMAIN}`;

  // Save state: expecting amount
  await setSession(ctx.from.id, { step: "awaiting_deposit_amount" });

  await ctx.reply(
    `📥 <b>Deposit Satoshis</b>\n\n` +
    `⚡ <b>Your Lightning Address:</b>\n<code>${lnAddress}</code>\n<i>(Tap to copy)</i>\n\n` +
    `👉 Send sats to this address directly, <b>OR reply with the amount in sats</b> to create a one-time invoice QR code (e.g. <code>100</code>):`,
    { parse_mode: "HTML" }
  );
});

// ----------------------------------------------------
// 4. 📤 WITHDRAW (Destination -> Amount -> Pay)
// ----------------------------------------------------
bot.hears("📤 Withdraw", async (ctx) => {
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();

  // Check balance first
  try {
    const res = await fetch(`${APP_URL}/api/wallet?action=balance&user_id=${encodeURIComponent(userId)}&telegram_id=${ctx.from.id}`);
    const data = await res.json();
    const balance = data.success ? Number(data.balance || 0) : 0;

    if (balance <= 0) {
      await clearSession(ctx.from.id);
      return ctx.reply("⚠️ <b>Your balance is 0 sats.</b>\nPlease deposit sats before withdrawing.", { parse_mode: "HTML" });
    }

    // Step 1: Ask for address or invoice
    await setSession(ctx.from.id, { step: "awaiting_withdraw_dest", balance });

    await ctx.reply(
      `📤 <b>Withdraw Satoshis</b>\nAvailable: <b>${balance.toLocaleString()} sats</b>\n\n` +
      `Please paste the recipient's <b>Lightning Address</b> (e.g. <code>name@speed.app</code>) or <b>Lightning Invoice</b> (<code>lnbc...</code>):`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    ctx.reply("⚠️ Error checking balance. Please try again.");
  }
});

// ----------------------------------------------------
// 5. 🔑 SET KEY (Admin - Direct input without commands)
// ----------------------------------------------------
bot.hears("🔑 Set Key", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply("⛔ Access denied: You are not authorized.");
  }

  await setSession(ctx.from.id, { step: "awaiting_admin_key" });

  await ctx.reply(
    `🔑 <b>Set Speed / API Key</b>\n\n` +
    `Paste your API secret key directly in chat now:`,
    { parse_mode: "HTML" }
  );
});

// ----------------------------------------------------
// 6. TEXT MESSAGE HANDLER (Processes conversational steps)
// ----------------------------------------------------
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  const session = await getSession(ctx.from.id);
  const userId = String(ctx.from.username || ctx.from.id).toLowerCase();

  // Skip if user clicked one of the main menu buttons
  if (["💰 Balance", "📥 Deposit", "📤 Withdraw", "🔑 Set Key"].includes(text)) {
    return;
  }

  // A. Handling Deposit Amount Input
  if (session.step === "awaiting_deposit_amount") {
    const amount = parseInt(text, 10);
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply("⚠️ Please send a valid positive number for sats (e.g. 50).");
    }

    await ctx.replyWithChatAction("typing");
    await clearSession(ctx.from.id);

    try {
      const res = await fetch(`${APP_URL}/api/wallet?action=create-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount,
          user_id: userId,
          username: userId,
          telegram_id: String(ctx.from.id)
        })
      });
      const data = await res.json();

      if (!data.success || !data.invoice) {
        throw new Error(data.error || "Could not generate invoice.");
      }

      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(data.invoice)}`;

      await ctx.replyWithPhoto(qrUrl, {
        caption:
          `⚡ <b>Deposit Invoice: ${amount} sats</b>\n\n` +
          `<code>${data.invoice}</code>\n\n` +
          `<i>Scan QR or copy the invoice above to pay.</i>`,
        parse_mode: "HTML"
      });
    } catch (err) {
      ctx.reply(`❌ Failed to create invoice: ${err.message}`);
    }
    return;
  }

  // B. Handling Withdraw Step 1: Destination Received
  if (session.step === "awaiting_withdraw_dest") {
    await setSession(ctx.from.id, {
      step: "awaiting_withdraw_amount",
      destination: text,
      balance: session.balance
    });

    return ctx.reply(
      `📍 <b>Destination set:</b>\n<code>${text}</code>\n\n` +
      `Now enter the <b>amount in sats</b> to withdraw (Max: <b>${session.balance} sats</b>):`,
      { parse_mode: "HTML" }
    );
  }

  // C. Handling Withdraw Step 2: Amount Received
  if (session.step === "awaiting_withdraw_amount") {
    const amount = parseInt(text, 10);
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply("⚠️ Please enter a valid number of sats.");
    }
    if (amount > session.balance) {
      return ctx.reply(`⚠️ Insufficient balance! You only have ${session.balance} sats.`);
    }

    const destination = session.destination;
    await clearSession(ctx.from.id);
    await ctx.replyWithChatAction("typing");

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

      await ctx.reply(
        `✅ <b>Withdrawal Successful!</b>\n\n` +
        `💸 Sent: <b>${amount} sats</b>\n` +
        `🎯 To: <code>${destination}</code>`,
        { parse_mode: "HTML" }
      );
    } catch (err) {
      ctx.reply(`❌ Payment failed: ${err.message}`);
    }
    return;
  }

  // D. Handling Admin Key Input
  if (session.step === "awaiting_admin_key" && isAdmin(ctx)) {
    // Temporarily save the entered key and prompt with a "Save" button
    await setSession(ctx.from.id, {
      step: "confirm_admin_key",
      pending_key: text
    });

    return ctx.reply(
      `🔑 <b>Key Received:</b>\n<code>${text}</code>\n\nClick <b>Save Key</b> below to confirm:`,
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
// 7. INLINE BUTTON CALLBACKS (Save / Cancel Admin Key)
// ----------------------------------------------------
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

// Vercel Serverless Function Export
module.exports = async (req, res) => {
  try {
    if (req.method === "POST") {
      await bot.handleUpdate(req.body);
    }
    res.status(200).send("OK");
  } catch (err) {
    console.error("Bot Error:", err);
    res.status(500).send("Internal Server Error");
  }
};
