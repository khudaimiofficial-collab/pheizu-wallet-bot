const admin = require("firebase-admin");

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

function sanitizeApiKey(raw) {
  if (!raw) return "";
  return String(raw).trim().replace(/^["']|["']$/g, "").replace(/^Bearer\s+/i, "").trim();
}

function formatChannelId(raw) {
  if (!raw) return "";
  let clean = String(raw).trim();
  if (/^\d{8,16}$/.test(clean)) return `-100${clean}`;
  if (/^-\d{8,16}$/.test(clean) && !clean.startsWith("-100")) return `-100${clean.replace(/^-/, "")}`;
  return clean;
}

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

async function getSpeedApiKey() {
  if (db) {
    try {
      const cfgSnap = await db.collection("settings").doc("config").get();
      if (cfgSnap.exists && cfgSnap.data().speed_key) return sanitizeApiKey(cfgSnap.data().speed_key);
      const spSnap = await db.collection("settings").doc("speed").get();
      if (spSnap.exists && spSnap.data().api_key) return sanitizeApiKey(spSnap.data().api_key);
    } catch (e) {}
  }
  return sanitizeApiKey(process.env.SPEED_API_KEY || "");
}

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

  if (Array.isArray(obj.payment_methods)) {
    for (const pm of obj.payment_methods) {
      for (const key of ["lightning", "onchain", "tron", "solana", "ethereum", "ton"]) {
        if (pm[key]) {
          if (pm[key].address) return { type: key, value: pm[key].address };
          if (pm[key].payment_request) return { type: "lightning", value: pm[key].payment_request };
        }
      }
    }
  }
  return null;
}

function extractPaidAmount(payment, invData) {
  if (!payment) return 0;
  const candidates = [
    payment.target_amount_paid,
    payment.amount_received,
    payment.total_amount_received,
    payment.paid_amount,
    payment.amount_paid,
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

// User Finder & Auto-Register
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

  // Check existing
  for (const docId of candidateIds) {
    const doc = await db.collection("users").doc(docId).get();
    if (doc.exists) {
      const data = doc.data();
      return { ref: doc.ref, id: doc.id, data, balance: Number(data.balance ?? data.sats ?? 0) };
    }
  }

  // Provision fresh user
  const primary = candidateIds.find(c => !c.startsWith("user") && /^\d+$/.test(c)) || candidateIds[0] || "guest";
  const userRef = db.collection("users").doc(primary);
  const initialData = {
    user_id: primary,
    username: meta.username || primary,
    telegram_id: meta.telegram_id || (primary.match(/^\d+$/) ? primary : ""),
    first_name: meta.first_name || "",
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

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (!db) return res.status(500).json({ success: false, error: "Database unavailable." });

  const { action } = req.query;

  try {
    // 1. BALANCE (Auto-registers user if fresh)
    if (action === "balance" && req.method === "GET") {
      const { user_id, username, telegram_id, first_name } = req.query;
      const candidates = [user_id, username, telegram_id, telegram_id ? `user${telegram_id}` : null];
      const user = await findOrRegisterUser(candidates, { username, telegram_id, first_name });

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
      const { amount, user_id, username, telegram_id, target_currency, payment_method, network } = req.body;
      const uid = (user_id || username || (telegram_id ? `user${telegram_id}` : "")).toLowerCase().trim();

      const user = await findOrRegisterUser([uid, telegram_id], { username, telegram_id });
      if (user.data.banned) return res.status(403).json({ success: false, error: "Account suspended." });

      const apiKey = await getSpeedApiKey();
      if (!apiKey) return res.status(500).json({ success: false, error: "Speed API key not configured." });

      const targetCurr = (target_currency || "SATS").toUpperCase();
      let payMethod = (payment_method || network || "lightning").toLowerCase();
      if (payMethod === "on-chain" || payMethod === "bitcoin") payMethod = "onchain";

      const baseCurr = targetCurr === "SATS" ? "SATS" : "USD";
      const requestedAmount = Number(amount);
      const isOpenAmount = !requestedAmount || requestedAmount <= 0;

      let paymentData = null;
      let ok = false;

      if (isOpenAmount && payMethod === "lightning") {
        const prRes = await speedRequest("payrequests", "POST", {
          currency: baseCurr,
          target_currency: targetCurr,
          description: `Pheizu deposit for ${user.id}`
        }, apiKey);
        if (prRes.ok) { ok = true; paymentData = prRes.data; }
      }

      if (!ok) {
        const res1 = await speedRequest("payments", "POST", {
          currency: baseCurr,
          target_currency: targetCurr,
          payment_methods: [payMethod],
          amount: isOpenAmount ? 0 : requestedAmount,
          metadata: { user_id: user.id, telegram_id: String(telegram_id || "") }
        }, apiKey);
        ok = res1.ok;
        paymentData = res1.data;
      }

      const target = extractPaymentTarget(paymentData);
      if (!target || !target.value) {
        return res.status(500).json({ success: false, error: "Failed to generate payment address from Speed." });
      }

      const txId = paymentData.id || `TX_${Date.now()}`;
      await db.collection("invoices").doc(txId).set({
        id: txId,
        tx_id: txId,
        invoice: target.value,
        payment_type: target.type,
        user_id: user.id,
        target_currency: targetCurr,
        payment_method: payMethod,
        telegram_id: String(telegram_id || ""),
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

      try {
        const directPay = await speedRequest(`payments/${payment_id}`, "GET", null, apiKey);
        if (directPay.ok && directPay.data) payment = directPay.data;
      } catch (e) {}

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

        await forwardToLogsChannel(`✅ <b>Deposit Received</b>\n• User: @${user.id}\n• Amount: +${finalSats} ${curr}\n• Fee: 0% (Free)\n• TxID: <code>${payment_id}</code>`);

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

    // 4. WITHDRAWAL (2.0% Platform Fee Collection)
    if (action === "send" && req.method === "POST") {
      const { destination, amount, user_id, telegram_id, username, withdraw_method, currency, target_currency } = req.body;
      const sendAmount = Number(amount);
      const dest = (destination || "").trim();

      if (!dest || isNaN(sendAmount) || sendAmount <= 0) {
        return res.status(400).json({ success: false, error: "Invalid withdrawal parameters." });
      }

      const user = await findOrRegisterUser([user_id, username, telegram_id]);
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

      // Add to treasury
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

      await forwardToLogsChannel(`📤 <b>Withdrawal Dispatched</b>\n• User: @${user.id}\n• Sent: ${netPayout} ${curr}\n• Fee (2%): ${fee} ${curr}\n• TxID: <code>${txId}</code>`);

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
