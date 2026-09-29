const admin = require("firebase-admin");

// 1. Firebase Initialization (Singleton)
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
const DOMAIN = "pheizu-wallet-bot.vercel.app";
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const WITHDRAWAL_FEE_PERCENT = 0.02; // 2% Fee on Withdrawals
const REFERRAL_QUALIFY_SPEND_SATS = 20; // 20 SATS minimum send to qualify
const REFERRAL_REWARD_SATS = 5; // 5 SATS reward to referrer

// Helper: Sanitize API Key
function sanitizeApiKey(raw) {
  if (!raw) return "";
  return String(raw).trim().replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "").replace(/^Basic\s+/i, "").trim();
}

// Helper: Format Telegram Channel ID
function formatChannelId(raw) {
  if (!raw) return "";
  let clean = String(raw).trim();
  if (/^\d{8,16}$/.test(clean)) return `-100${clean}`;
  if (/^-\d{8,16}$/.test(clean) && !clean.startsWith("-100")) return `-100${clean.replace(/^-/, "")}`;
  return clean;
}

// Helper: Format User Identity for Telegram Messages
function formatUserIdentity(userObj) {
  const data = userObj?.data || userObj || {};
  const tgId = data.telegram_id || userObj?.id || "";
  const username = data.username ? data.username.replace(/^@/, "") : "";
  const firstName = data.first_name || data.name || "";
  const lastName = data.last_name || "";
  const fullName = `${firstName} ${lastName}`.trim();

  let userDisplay = "";
  if (username && !username.startsWith("user") && isNaN(username)) {
    userDisplay = `@${username}`;
    if (fullName) userDisplay += ` (${fullName})`;
  } else if (fullName) {
    userDisplay = `${fullName}`;
  } else {
    userDisplay = `User`;
  }

  return tgId ? `<a href="tg://user?id=${tgId}">${userDisplay}</a> [<code>${tgId}</code>]` : `<code>${userDisplay}</code>`;
}

// Helper: Resolve Telegram ID
async function resolveNumericTelegramId(userId, candidateTgId) {
  if (candidateTgId && /^\d{6,14}$/.test(String(candidateTgId).trim())) return String(candidateTgId).trim();
  if (userId && /^\d{6,14}$/.test(String(userId).trim())) return String(userId).trim();

  if (db) {
    const ids = [userId, candidateTgId].filter(Boolean).map(s => String(s).toLowerCase().replace(/^@/, "").trim());
    for (const id of ids) {
      try {
        const uDoc = await db.collection("users").doc(id).get();
        if (uDoc.exists && uDoc.data().telegram_id && /^\d+$/.test(String(uDoc.data().telegram_id))) {
          return String(uDoc.data().telegram_id);
        }
      } catch (e) {}
    }
  }
  return null;
}

// Helper: Send Telegram notification
async function notifyTelegramUser(telegramId, message) {
  if (!BOT_TOKEN || !telegramId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: String(telegramId), text: message, parse_mode: "HTML" })
    });
  } catch (e) {}
}

// Helper: Forward receipt to logs channel
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

// Helper: Speed Key Resolution
async function getSpeedApiKey() {
  if (db) {
    try {
      const cfgSnap = await db.collection("settings").doc("config").get();
      if (cfgSnap.exists && cfgSnap.data().speed_key) return sanitizeApiKey(cfgSnap.data().speed_key);
      const spSnap = await db.collection("settings").doc("speed").get();
      if (spSnap.exists && spSnap.data().api_key) return sanitizeApiKey(spSnap.data().api_key);
      const spSnap2 = await db.collection("settings").doc("speed_key").get();
      if (spSnap2.exists && spSnap2.data().api_key) return sanitizeApiKey(spSnap2.data().api_key);
    } catch (e) {}
  }
  return sanitizeApiKey(process.env.SPEED_API_KEY || process.env.SPEED_SECRET_KEY || "");
}

// Helper: Speed Request with Basic Auth
async function speedRequest(path, method, body, apiKey) {
  const cleanKey = sanitizeApiKey(apiKey);
  const authHeader = `Basic ${Buffer.from(cleanKey + ":").toString("base64")}`;
  const url = `https://api.tryspeed.com/${path.replace(/^\//, "")}`;

  const res = await fetch(url, {
    method,
    headers: {
      "Accept": "application/json",
      "Authorization": authHeader,
      "Content-Type": "application/json",
      "speed-version": "2022-10-15"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

// Helper: Universal Payment Target Extractor
function extractPaymentTarget(obj) {
  if (!obj) return null;

  if (typeof obj === "string") {
    const str = obj.trim();
    if (str.toLowerCase().startsWith("lnbc") || str.toLowerCase().startsWith("lightning:lnbc")) return { type: "lightning", value: str };
    if (str.startsWith("bc1") || str.startsWith("1") || str.startsWith("3")) return { type: "onchain", value: str.replace(/^bitcoin:/i, "") };
    if (str.startsWith("T") && str.length >= 30) return { type: "tron", value: str };
    if (str.startsWith("0x") && str.length === 42) return { type: "ethereum", value: str };
    return null;
  }

  if (typeof obj !== "object") return null;

  if (obj.payment_request) return { type: "lightning", value: obj.payment_request };
  if (obj.invoice) return { type: "lightning", value: obj.invoice };
  if (obj.address) return { type: "address", value: obj.address };
  if (obj.uri) return { type: "uri", value: obj.uri };

  if (obj.payment_method_options) {
    if (obj.payment_method_options.lightning?.payment_request) return { type: "lightning", value: obj.payment_method_options.lightning.payment_request };
    if (obj.payment_method_options.lightning?.invoice) return { type: "lightning", value: obj.payment_method_options.lightning.invoice };
    if (obj.payment_method_options.on_chain?.address) return { type: "onchain", value: obj.payment_method_options.on_chain.address };
    if (obj.payment_method_options.onchain?.address) return { type: "onchain", value: obj.payment_method_options.onchain.address };
  }

  if (Array.isArray(obj.payment_methods)) {
    for (const pm of obj.payment_methods) {
      for (const key of ["lightning", "onchain", "on-chain", "tron", "solana", "ethereum", "ton"]) {
        if (pm[key]) {
          if (pm[key].address) return { type: key, value: pm[key].address };
          if (pm[key].payment_request) return { type: "lightning", value: pm[key].payment_request };
          if (pm[key].invoice) return { type: "lightning", value: pm[key].invoice };
        }
      }
    }
  }

  for (const key of Object.keys(obj)) {
    const res = extractPaymentTarget(obj[key]);
    if (res) return res;
  }

  if (obj.hosted_url || obj.url) return { type: "url", value: obj.hosted_url || obj.url };
  return null;
}

// Helper: Extract Real Settled Amount
function extractPaidAmount(payment, invData) {
  if (!payment) return 0;
  const candidates = [
    payment.target_amount_paid,
    payment.amount_received,
    payment.total_amount_received,
    payment.paid_amount,
    payment.amount_paid,
    payment.amount,
    invData?.amount > 0 ? invData.amount : null
  ];
  for (const val of candidates) {
    if (val !== undefined && val !== null) {
      const num = Number(val);
      if (!isNaN(num) && num > 0) {
        if (num < 0.01 && (payment.currency === "BTC" || payment.target_currency === "BTC")) {
          return Math.round(num * 100000000);
        }
        return Math.round(num);
      }
    }
  }
  return 0;
}

// User Finder & Automatic Registration
async function findOrRegisterUser(identifiers, meta = {}) {
  if (!db) return null;
  const rawList = [];
  for (const id of identifiers) {
    if (!id) continue;
    const s = String(id).trim().toLowerCase().replace(/^@/, "");
    rawList.push(s);
    if (s.startsWith("user") && /^\d+$/.test(s.slice(4))) rawList.push(s.slice(4));
    if (/^\d+$/.test(s)) rawList.push(`user${s}`);
  }

  const candidateIds = Array.from(new Set(rawList));

  for (const docId of candidateIds) {
    const doc = await db.collection("users").doc(docId).get();
    if (doc.exists) {
      const data = doc.data();
      if ((meta.first_name && !data.first_name) || (meta.username && !data.username)) {
        await doc.ref.set({
          first_name: meta.first_name || data.first_name || "",
          last_name: meta.last_name || data.last_name || "",
          username: meta.username || data.username || ""
        }, { merge: true });
      }
      return { ref: doc.ref, id: doc.id, data, balance: Number(data.balance ?? data.sats ?? 0) };
    }
  }

  const primary = candidateIds.find(c => !c.startsWith("user") && /^\d+$/.test(c)) || candidateIds[0] || "guest";
  const userRef = db.collection("users").doc(primary);
  const initialData = {
    user_id: primary,
    username: meta.username || primary,
    telegram_id: meta.telegram_id || (primary.match(/^\d+$/) ? primary : ""),
    first_name: meta.first_name || "",
    last_name: meta.last_name || "",
    balance: 0,
    sats: 0,
    usdt_balance: 0,
    usdc_balance: 0,
    banned: false,
    created_at: new Date().toISOString()
  };

  await userRef.set(initialData, { merge: true });
  return { ref: userRef, id: primary, data: initialData, balance: 0 };
}

// Helper: Award Referral Reward on Spend >= 20 SATS
async function checkAndAwardReferral(spendingUserId, satsSpent) {
  if (!db || satsSpent < REFERRAL_QUALIFY_SPEND_SATS) return;

  try {
    const snap = await db.collection("referrals")
      .where("referred_user_id", "==", String(spendingUserId))
      .where("status", "==", "pending")
      .limit(1)
      .get();

    if (snap.empty) return;

    const refDoc = snap.docs[0];
    const refData = refDoc.data();
    const referrerId = refData.referrer_id;

    const referrerRef = db.collection("users").doc(referrerId);
    const referrerDoc = await referrerRef.get();

    if (!referrerDoc.exists || referrerDoc.data().banned) return;

    const batch = db.batch();

    batch.update(refDoc.ref, {
      status: "completed",
      qualified_at: new Date().toISOString(),
      sats_spent_to_qualify: satsSpent
    });

    batch.set(referrerRef, {
      balance: admin.firestore.FieldValue.increment(REFERRAL_REWARD_SATS),
      sats: admin.firestore.FieldValue.increment(REFERRAL_REWARD_SATS),
      referral_count: admin.firestore.FieldValue.increment(1),
      referral_earnings: admin.firestore.FieldValue.increment(REFERRAL_REWARD_SATS),
      updated_at: new Date().toISOString()
    }, { merge: true });

    await batch.commit();

    await notifyTelegramUser(
      referrerId,
      `🎉 <b>Referral Reward Verified & Credited!</b>\n\n` +
      `Your referred user @${refData.referred_username || spendingUserId} sent $\\ge$ ${REFERRAL_QUALIFY_SPEND_SATS} SATS.\n` +
      `💰 <b>+${REFERRAL_REWARD_SATS} SATS</b> added to your wallet balance!`
    );

    await forwardToLogsChannel(
      `🎁 <b>Referral Reward Verified (+${REFERRAL_REWARD_SATS} SATS)</b>\n\n` +
      `• Referrer: <code>${referrerId}</code>\n` +
      `• Qualified User: @${refData.referred_username || spendingUserId}\n` +
      `• Initial Send: ${satsSpent} SATS\n` +
      `• Status: Verified & Paid`
    );
  } catch (e) {
    console.error("Referral Award Error:", e);
  }
}

// Main Handler
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (!db) return res.status(500).json({ success: false, error: "Database unavailable." });

  const { action } = req.query;

  try {
    // 0. GET BOT LIVE INFO
    if (action === "get-bot-info" && req.method === "GET") {
      if (!BOT_TOKEN) return res.status(500).json({ success: false, error: "BOT_TOKEN not configured." });
      try {
        const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
        const tgData = await tgRes.json();
        if (tgData.ok && tgData.result?.username) {
          return res.status(200).json({
            success: true,
            bot_username: tgData.result.username,
            bot_id: tgData.result.id,
            first_name: tgData.result.first_name
          });
        }
      } catch(e) {}
      return res.status(200).json({ success: true, bot_username: "" });
    }

    // 1. BALANCE (Auto-registers user fresh upon entering)
    if (action === "balance" && req.method === "GET") {
      const { user_id, username, telegram_id, first_name, last_name } = req.query;
      const candidates = [user_id, username, telegram_id, telegram_id ? `user${telegram_id}` : null];
      const user = await findOrRegisterUser(candidates, { username, telegram_id, first_name, last_name });

      if (user.data.banned) {
        return res.status(403).json({ success: false, error: "Account suspended by administrator." });
      }

      return res.status(200).json({
        success: true,
        user_id: user.id,
        balance: user.balance,
        usdt_balance: Number(user.data.usdt_balance ?? user.data.usdt ?? 0),
        usdc_balance: Number(user.data.usdc_balance ?? user.data.usdc ?? 0)
      });
    }

    // 2. CREATE DEPOSIT INVOICE (100% Free)
    if (action === "create-payment" && req.method === "POST") {
      const { amount, user_id, username, telegram_id, first_name, last_name, target_currency, payment_method, network } = req.body;
      const uid = (user_id || username || (telegram_id ? `user${telegram_id}` : "")).toLowerCase().trim();

      const user = await findOrRegisterUser([uid, telegram_id], { username, telegram_id, first_name, last_name });
      if (user.data.banned) return res.status(403).json({ success: false, error: "Account suspended." });

      const apiKey = await getSpeedApiKey();
      if (!apiKey) return res.status(500).json({ success: false, error: "Speed API key not configured. Save it in Admin Console." });

      const targetCurr = (target_currency || "SATS").toUpperCase();
      let payMethod = (payment_method || network || "lightning").toLowerCase();
      if (payMethod === "on-chain" || payMethod === "bitcoin" || payMethod === "onchain") payMethod = "onchain";

      const baseCurr = targetCurr === "SATS" ? "SATS" : "USD";
      const requestedAmount = Number(amount);
      const isOpenAmount = !requestedAmount || requestedAmount <= 0;

      let paymentData = null;
      let ok = false;

      // Strategy 1: Open Amount Lightning -> Create Payrequest
      if (isOpenAmount && payMethod === "lightning") {
        const prRes = await speedRequest("payrequests", "POST", {
          currency: baseCurr,
          target_currency: targetCurr,
          description: `Pheizu deposit for ${user.id}`
        }, apiKey);

        if (prRes.ok && prRes.data) {
          ok = true;
          paymentData = prRes.data;
        }
      }

      // Strategy 2: Open Amount On-chain -> Create Payment Address
      if (isOpenAmount && payMethod === "onchain" && !ok) {
        const addrRes = await speedRequest("payment-addresses", "POST", {
          currency: baseCurr,
          target_currency: targetCurr,
          payment_method: "onchain",
          metadata: { user_id: user.id, telegram_id: String(telegram_id || "") }
        }, apiKey);

        if (addrRes.ok && addrRes.data) {
          ok = true;
          paymentData = addrRes.data;
        }
      }

      // Strategy 3: Specific Amount or Payments Endpoint Fallback
      if (!ok) {
        const speedBody = {
          currency: baseCurr,
          target_currency: targetCurr,
          payment_methods: [payMethod],
          amount: isOpenAmount ? 0 : requestedAmount,
          metadata: {
            user_id: user.id,
            telegram_id: String(telegram_id || "")
          }
        };

        const res1 = await speedRequest("payments", "POST", speedBody, apiKey);
        if (res1.ok && res1.data) {
          ok = true;
          paymentData = res1.data;
        } else {
          paymentData = res1.data;
        }
      }

      const target = extractPaymentTarget(paymentData);
      if (!target || !target.value) {
        const errMsg = paymentData?.error?.message || (typeof paymentData?.error === "string" ? paymentData.error : "Failed to generate payment address from Speed.");
        return res.status(500).json({ success: false, error: errMsg });
      }

      const speedId = paymentData?.id || paymentData?.payrequest_id || `TX_${Date.now()}`;
      const txId = speedId;

      await db.collection("invoices").doc(txId).set({
        id: txId,
        tx_id: txId,
        speed_payment_id: speedId,
        invoice: target.value,
        payment_type: target.type,
        user_id: user.id,
        target_currency: targetCurr,
        payment_method: payMethod,
        telegram_id: String(telegram_id || ""),
        first_name: first_name || user.data.first_name || "",
        last_name: last_name || user.data.last_name || "",
        username: username || user.data.username || "",
        amount: isOpenAmount ? 0 : requestedAmount,
        is_paid: false,
        created_at: new Date().toISOString()
      }, { merge: true });

      return res.status(200).json({
        success: true,
        id: txId,
        tx_id: txId,
        payment_type: target.type,
        target_currency: targetCurr,
        amount: isOpenAmount ? 0 : requestedAmount,
        invoice: target.value
      });
    }

    // 3. CHECK STATUS (0% Deposit Fee - 100% Full Crediting)
    if (action === "check-status" && req.method === "GET") {
      const { payment_id, user_id, telegram_id } = req.query;
      if (!payment_id) return res.status(400).json({ success: false, error: "Missing payment_id" });

      const invRef = db.collection("invoices").doc(payment_id);
      const invDoc = await invRef.get();
      const invData = invDoc.exists ? invDoc.data() : null;

      const user = await findOrRegisterUser([invData?.user_id, user_id, telegram_id]);
      const curr = invData?.target_currency || "SATS";

      if (invData && invData.is_paid && Number(invData.amount || 0) > 0) {
        return res.status(200).json({
          success: true,
          is_paid: true,
          status: "paid",
          tx_id: payment_id,
          amount: Number(invData.amount),
          balance: user.balance,
          currency: curr
        });
      }

      const apiKey = await getSpeedApiKey();
      let payment = null;

      if (payment_id.startsWith("pr_")) {
        try {
          const prPayRes = await speedRequest(`payrequests/${payment_id}/payments`, "GET", null, apiKey);
          if (prPayRes.ok && prPayRes.data) {
            const list = prPayRes.data.data || prPayRes.data.items || [];
            const paidItems = list.filter(p => ["paid", "succeeded", "completed", "confirmed"].includes(String(p.status).toLowerCase()));
            if (paidItems.length > 0) payment = paidItems[0];
          }
        } catch (e) {}
      }

      if (!payment) {
        try {
          const directPay = await speedRequest(`payments/${payment_id}`, "GET", null, apiKey);
          if (directPay.ok && directPay.data) payment = directPay.data;
        } catch (e) {}
      }

      const rawStatus = String(payment?.status || "").toLowerCase();
      const isPaid = ["paid", "succeeded", "completed", "confirmed"].includes(rawStatus);
      const finalSats = extractPaidAmount(payment, invData);

      if (isPaid && finalSats > 0) {
        const batch = db.batch();
        batch.set(invRef, { is_paid: true, paid_at: new Date().toISOString(), amount: finalSats }, { merge: true });

        const field = curr === "USDT" ? "usdt_balance" : (curr === "USDC" ? "usdc_balance" : "balance");
        const altField = curr === "USDT" ? "usdt" : (curr === "USDC" ? "usdc" : "sats");

        batch.set(user.ref, {
          [field]: admin.firestore.FieldValue.increment(finalSats),
          [altField]: admin.firestore.FieldValue.increment(finalSats),
          updated_at: new Date().toISOString()
        }, { merge: true });

        batch.set(db.collection("transactions").doc(payment_id), {
          id: payment_id,
          tx_id: payment_id,
          type: "deposit",
          user_id: user.id,
          amount: finalSats,
          gross_amount: finalSats,
          fee: 0,
          currency: curr,
          status: "completed",
          created_at: new Date().toISOString()
        });

        await batch.commit();

        const tChatId = await resolveNumericTelegramId(user.id, telegram_id || invData?.telegram_id);
        if (tChatId) {
          await notifyTelegramUser(tChatId, `🎉 <b>Payment Received!</b>\n\n⚡ <b>+${finalSats} ${curr}</b> credited!\n🆔 <code>${payment_id}</code>`);
        }

        const userTag = formatUserIdentity(user);
        const displayAmt = curr === "SATS" ? `${finalSats.toLocaleString()} SATS` : `$${Number(finalSats).toFixed(2)} ${curr}`;

        await forwardToLogsChannel(
          `⚡ <b>Deposit Received</b>\n\n` +
          `👤 <b>User:</b> ${userTag}\n` +
          `💰 <b>Amount:</b> +${displayAmt}\n` +
          `🎉 <b>Deposit Fee:</b> 0% (FREE)\n` +
          `🌐 <b>Method:</b> ${invData?.payment_method || 'lightning'}\n` +
          `🆔 <b>TxID:</b> <code>${payment_id}</code>`
        );

        return res.status(200).json({
          success: true,
          is_paid: true,
          status: "paid",
          tx_id: payment_id,
          amount: finalSats,
          balance: user.balance + finalSats,
          currency: curr
        });
      }

      return res.status(200).json({ success: true, is_paid: false, status: rawStatus || "unpaid", balance: user.balance });
    }

    // 4. WITHDRAWAL & REFERRAL QUALIFICATION CHECK (2.0% Platform Fee Collection)
    if (action === "send" && req.method === "POST") {
      const { destination, amount, user_id, telegram_id, username, first_name, last_name, withdraw_method, currency, target_currency } = req.body;
      const sendAmount = Number(amount);
      const dest = (destination || "").trim();

      if (!dest || isNaN(sendAmount) || sendAmount <= 0) {
        return res.status(400).json({ success: false, error: "Invalid withdrawal parameters." });
      }

      const user = await findOrRegisterUser([user_id, username, telegram_id], { first_name, last_name, username, telegram_id });
      if (user.data.banned) return res.status(403).json({ success: false, error: "Account suspended." });

      const curr = (currency || target_currency || "SATS").toUpperCase();
      const currentBal = curr === "USDT" ? Number(user.data.usdt_balance ?? user.data.usdt ?? 0) :
                         curr === "USDC" ? Number(user.data.usdc_balance ?? user.data.usdc ?? 0) : user.balance;

      if (sendAmount > currentBal) {
        return res.status(400).json({ success: false, error: `Insufficient balance. Available: ${currentBal}` });
      }

      // 2% platform fee
      let fee = curr === "SATS" ? Math.max(1, Math.floor(sendAmount * WITHDRAWAL_FEE_PERCENT)) : Number((sendAmount * WITHDRAWAL_FEE_PERCENT).toFixed(2));
      let netPayout = curr === "SATS" ? sendAmount - fee : Number((sendAmount - fee).toFixed(2));

      const apiKey = await getSpeedApiKey();
      if (!apiKey) return res.status(500).json({ success: false, error: "Speed key not configured." });

      const speedRes = await speedRequest("send", "POST", {
        amount: netPayout,
        currency: curr,
        target_currency: curr,
        withdraw_method: withdraw_method || "lightning",
        withdraw_request: dest,
        note: `Withdrawal by ${user.id}`
      }, apiKey);

      if (!speedRes.ok) {
        return res.status(400).json({ success: false, error: speedRes.data?.error?.message || "Speed payout failed." });
      }

      const txId = speedRes.data?.id || `WD_${Date.now()}`;
      const batch = db.batch();

      const field = curr === "USDT" ? "usdt_balance" : (curr === "USDC" ? "usdc_balance" : "balance");
      const altField = curr === "USDT" ? "usdt" : (curr === "USDC" ? "usdc" : "sats");

      batch.set(user.ref, {
        [field]: admin.firestore.FieldValue.increment(-sendAmount),
        [altField]: admin.firestore.FieldValue.increment(-sendAmount),
        updated_at: new Date().toISOString()
      }, { merge: true });

      const treasuryRef = db.collection("settings").doc("admin_treasury");
      const trField = curr === "USDT" ? "earned_usdt" : (curr === "USDC" ? "earned_usdc" : "earned_sats");
      batch.set(treasuryRef, { [trField]: admin.firestore.FieldValue.increment(fee) }, { merge: true });

      batch.set(db.collection("transactions").doc(txId), {
        id: txId,
        tx_id: txId,
        type: "withdrawal",
        user_id: user.id,
        destination: dest,
        amount: sendAmount,
        gross_amount: sendAmount,
        fee: fee,
        net_sent: netPayout,
        currency: curr,
        status: "completed",
        created_at: new Date().toISOString()
      });

      await batch.commit();

      if (curr === "SATS" && sendAmount >= REFERRAL_QUALIFY_SPEND_SATS) {
        await checkAndAwardReferral(user.id, sendAmount);
      }

      const userTag = formatUserIdentity(user);
      const displaySent = curr === "SATS" ? `${netPayout.toLocaleString()} SATS` : `$${Number(netPayout).toFixed(2)} ${curr}`;
      const displayFee = curr === "SATS" ? `${fee.toLocaleString()} SATS` : `$${Number(fee).toFixed(2)} ${curr}`;

      await forwardToLogsChannel(
        `📤 <b>Withdrawal Dispatched</b>\n\n` +
        `👤 <b>User:</b> ${userTag}\n` +
        `🚀 <b>Sent to Destination:</b> ${displaySent}\n` +
        `💰 <b>Platform Fee (2%):</b> ${displayFee}\n` +
        `🌐 <b>Network:</b> ${withdraw_method || 'lightning'}\n` +
        `📍 <b>Destination:</b> <code>${dest}</code>\n` +
        `🆔 <b>TxID:</b> <code>${txId}</code>`
      );

      return res.status(200).json({
        success: true,
        tx_id: txId,
        sent_amount: netPayout,
        fee: fee,
        gross_deducted: sendAmount
      });
    }

    // 5. HISTORY
    if (action === "history" && req.method === "GET") {
      const { user_id, telegram_id } = req.query;
      const user = await findOrRegisterUser([user_id, telegram_id]);

      const snap = await db.collection("transactions").where("user_id", "==", user.id).limit(20).get();
      const list = [];
      snap.forEach(d => list.push(d.data()));
      list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      return res.status(200).json({ success: true, history: list });
    }

    return res.status(400).json({ success: false, error: "Invalid action." });
  } catch (err) {
    console.error("Wallet Handler Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
