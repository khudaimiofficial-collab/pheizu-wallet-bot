const admin = require("firebase-admin");

// 1. Firebase Initialization
function getDb() {
  if (admin.apps.length) {
    return admin.firestore();
  }

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

// Helper: Sanitize API Key
function sanitizeApiKey(raw) {
  if (!raw) return "";
  return String(raw)
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^Bearer\s+/i, "")
    .replace(/^Basic\s+/i, "")
    .trim();
}

// Helper: Resolve Numeric Telegram ID
async function resolveNumericTelegramId(userId, candidateTgId) {
  if (candidateTgId && /^\d{6,14}$/.test(String(candidateTgId).trim())) {
    return String(candidateTgId).trim();
  }
  if (userId && /^\d{6,14}$/.test(String(userId).trim())) {
    return String(userId).trim();
  }

  if (db) {
    const ids = [userId, candidateTgId].filter(Boolean).map(s => String(s).toLowerCase().replace(/^@/, "").trim());
    for (const id of ids) {
      try {
        const uDoc = await db.collection("users").doc(id).get();
        if (uDoc.exists && uDoc.data().telegram_id && /^\d+$/.test(String(uDoc.data().telegram_id))) {
          return String(uDoc.data().telegram_id);
        }
        const wDoc = await db.collection("wallets").doc(id).get();
        if (wDoc.exists && wDoc.data().telegram_id && /^\d+$/.test(String(wDoc.data().telegram_id))) {
          return String(wDoc.data().telegram_id);
        }
      } catch (e) {}
    }
    for (const id of ids) {
      try {
        const snap = await db.collection("users").where("username", "==", id).limit(1).get();
        if (!snap.empty && snap.docs[0].data().telegram_id) {
          return String(snap.docs[0].data().telegram_id);
        }
      } catch (e) {}
    }
  }
  return null;
}

// Helper: Check if user is an authorized admin
async function isAuthorizedAdminById(telegramId, username) {
  const numId = String(telegramId || "").trim();
  const uname = String(username || "").toLowerCase().replace(/^@/, "").trim();
  if (numId === "8960497898" || uname === "pheizu") return true;

  if (db) {
    try {
      const snap = await db.collection("settings").doc("admins").get();
      if (snap.exists) {
        const list = (snap.data().list || []).map(a => String(a).toLowerCase().replace(/^@/, ""));
        if (list.includes(numId) || (uname && list.includes(uname))) return true;
      }
    } catch(e) {}
  }
  return false;
}

// Helper: Send Telegram notification to user
async function notifyTelegramUser(telegramId, message) {
  if (!BOT_TOKEN || !telegramId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: String(telegramId),
        text: message,
        parse_mode: "HTML"
      })
    });
    const data = await res.json();
    if (!data.ok) console.warn("Telegram sendMessage failed:", data.description);
  } catch (e) {
    console.error("Failed to notify user:", e.message);
  }
}

// Helper: Forward success receipts to Telegram log channel
async function forwardToLogsChannel(text) {
  if (!BOT_TOKEN) return;
  try {
    let channelId = null;
    if (db) {
      try {
        const snap = await db.collection("settings").doc("logs_channel").get();
        if (snap.exists && snap.data().channel_id) channelId = snap.data().channel_id;
      } catch (err) {}
    }
    if (!channelId) channelId = process.env.LOG_CHANNEL_ID || process.env.ADMIN_CHAT_ID;
    if (!channelId) return;
    channelId = String(channelId).trim();
    if (/^\d{8,14}$/.test(channelId)) channelId = `-100${channelId}`;

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: channelId,
        text,
        parse_mode: "HTML"
      })
    });
  } catch (e) {}
}

// Helper: Get active Speed API key
async function getSpeedApiKey() {
  if (db) {
    try {
      const snap = await db.collection("settings").doc("speed").get();
      if (snap.exists) {
        const data = snap.data();
        const key = data.api_key || data.key || data.secret_key;
        if (key && sanitizeApiKey(key)) return sanitizeApiKey(key);
      }
      const snap2 = await db.collection("settings").doc("speed_key").get();
      if (snap2.exists) {
        const data = snap2.data();
        const key = data.api_key || data.key || data.secret_key;
        if (key && sanitizeApiKey(key)) return sanitizeApiKey(key);
      }
    } catch (e) {}
  }
  return sanitizeApiKey(process.env.SPEED_API_KEY || process.env.SPEED_SECRET_KEY || "");
}

// Helper: Resolve LNURL-pay address to BOLT11 invoice
async function resolveLnAddress(dest, amountSats) {
  if (dest.includes("@") && !dest.toLowerCase().includes(DOMAIN.toLowerCase())) {
    try {
      const [name, host] = dest.split("@");
      const res = await fetch(`https://${host}/.well-known/lnurlp/${name}`);
      const data = await res.json();
      if (data.callback) {
        const msats = Math.round(Number(amountSats) * 1000);
        const sep = data.callback.includes("?") ? "&" : "?";
        const cbRes = await fetch(`${data.callback}${sep}amount=${msats}`);
        const cbData = await cbRes.json();
        if (cbData.pr) return cbData.pr;
      }
    } catch (e) {}
  }
  return dest;
}

// Helper: Extract payment targets (invoice or crypto address)
function extractPaymentTarget(obj) {
  if (!obj) return null;

  if (typeof obj === "string") {
    const str = obj.trim();
    if (str.toLowerCase().startsWith("lnbc") || str.toLowerCase().startsWith("lightning:lnbc")) {
      return { type: "lightning", value: str };
    }
    if (str.startsWith("bc1") || str.startsWith("1") || str.startsWith("3") || str.toLowerCase().startsWith("bitcoin:")) {
      return { type: "onchain", value: str.replace(/^bitcoin:/i, "") };
    }
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
      for (const key of ["lightning", "onchain", "on-chain", "tron", "solana", "ethereum", "ton"]) {
        if (pm[key]) {
          if (pm[key].address) return { type: key, value: pm[key].address };
          if (pm[key].payment_request) return { type: "lightning", value: pm[key].payment_request };
          if (pm[key].uri) return { type: key, value: pm[key].uri };
        }
      }
    }
  }

  if (obj.payment_method_options) {
    if (obj.payment_method_options.lightning?.payment_request) {
      return { type: "lightning", value: obj.payment_method_options.lightning.payment_request };
    }
    if (obj.payment_method_options.on_chain?.address) {
      return { type: "onchain", value: obj.payment_method_options.on_chain.address };
    }
  }

  for (const key of Object.keys(obj)) {
    const res = extractPaymentTarget(obj[key]);
    if (res) return res;
  }

  if (obj.hosted_url || obj.url) return { type: "url", value: obj.hosted_url || obj.url };
  return null;
}

// Helper: Extract real amount received across all Speed API response formats
function extractPaidAmount(payment, invData) {
  if (!payment) return 0;

  const candidates = [
    payment.target_amount_paid,
    payment.amount_received,
    payment.total_amount_received,
    payment.paid_amount,
    payment.amount_paid,
    payment.total_amount_paid,
    payment.received_amount,
    payment.payments?.[0]?.target_amount_paid,
    payment.payments?.[0]?.amount_received,
    payment.payments?.[0]?.paid_amount,
    invData?.amount > 0 ? payment.target_amount : null,
    invData?.amount > 0 ? payment.amount : null,
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

// Speed Client Request
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

// Error extractor
function extractErrorMessage(data, status) {
  if (!data) return `Speed API returned HTTP ${status}`;
  if (typeof data === "string") return data;
  if (data.error && data.error.message) return data.error.message;
  if (typeof data.error === "string") return data.error;
  if (data.message) return data.message;
  if (Array.isArray(data.errors) && data.errors[0]) {
    return data.errors[0].message || JSON.stringify(data.errors[0]);
  }
  return `Speed API error (HTTP ${status})`;
}

// User wallet resolver
async function findUserWallet(identifiers) {
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
  const collectionsToCheck = ["users", "wallets"];

  for (const col of collectionsToCheck) {
    for (const docId of candidateIds) {
      const doc = await db.collection(col).doc(docId).get();
      if (doc.exists) {
        const data = doc.data();
        const bal = data.balance ?? data.sats ?? data.amount;
        if (bal !== undefined && bal !== null) {
          return { ref: doc.ref, id: doc.id, data, balance: Number(bal) || 0, collection: col };
        }
      }
    }
  }

  for (const col of collectionsToCheck) {
    for (const docId of candidateIds) {
      const doc = await db.collection(col).doc(docId).get();
      if (doc.exists) return { ref: doc.ref, id: doc.id, data: doc.data(), balance: 0, collection: col };
    }
  }

  const primary = candidateIds.find(c => !c.startsWith("user") && /^\d+$/.test(c)) || candidateIds[0] || "unknown";
  return { ref: db.collection("users").doc(primary), id: primary, data: {}, balance: 0, collection: "users" };
}

// Main Request Handler
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (!db) {
    return res.status(500).json({ success: false, error: "Firebase connection failed." });
  }

  const { action } = req.query;

  try {
    // ========================================================
    // 1. BALANCE
    // ========================================================
    if (action === "balance" && req.method === "GET") {
      const uid = req.query.user_id;
      const uname = req.query.username;
      const tid = req.query.telegram_id;

      const candidates = [uid, uname, tid, tid ? `user${tid}` : null];
      const wallet = await findUserWallet(candidates);

      return res.status(200).json({
        success: true,
        user_id: wallet ? wallet.id : uid,
        balance: wallet ? wallet.balance : 0,
        usdt_balance: wallet ? (Number(wallet.data.usdt_balance) || 0) : 0,
        usdc_balance: wallet ? (Number(wallet.data.usdc_balance) || 0) : 0
      });
    }

    // ========================================================
    // 2. TRANSACTION HISTORY
    // ========================================================
    if (action === "history" && req.method === "GET") {
      const uid = (req.query.user_id || req.query.username || "").toLowerCase().trim();
      const tid = req.query.telegram_id;

      const candidates = [uid, tid, tid ? `user${tid}` : null].filter(Boolean);
      const wallet = await findUserWallet(candidates);
      const queryUser = wallet ? wallet.id : uid;

      const snap = await db.collection("transactions").where("user_id", "==", queryUser).limit(20).get();
      const list = [];
      snap.forEach(d => list.push(d.data()));
      list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

      return res.status(200).json({ success: true, history: list.slice(0, 10) });
    }

    // ========================================================
    // 3. CREATE DEPOSIT INVOICE (Speed ID and TxID are identical)
    // ========================================================
    if (action === "create-payment" && req.method === "POST") {
      const { amount, user_id, username, telegram_id, target_currency, payment_method, network } = req.body;
      const uid = (user_id || username || (telegram_id ? `user${telegram_id}` : "")).toLowerCase().trim();

      if (!uid) return res.status(400).json({ success: false, error: "Missing user identification." });

      const apiKey = await getSpeedApiKey();
      if (!apiKey) return res.status(500).json({ success: false, error: "Speed API key is not configured." });

      const targetCurr = (target_currency || "SATS").toUpperCase();
      let payMethod = (payment_method || network || "lightning").toLowerCase();
      if (payMethod === "on-chain" || payMethod === "bitcoin" || payMethod === "onchain") {
        payMethod = "onchain";
      }

      const baseCurr = targetCurr === "SATS" ? "SATS" : "USD";
      const requestedAmount = Number(amount);
      const isOpenAmount = !requestedAmount || requestedAmount <= 0;

      let paymentData = null;
      let ok = false;
      let status = 400;
      let sourceEndpoint = "payments";

      // Open Amount Lightning -> Create Payrequest
      if (isOpenAmount && payMethod === "lightning") {
        const prRes = await speedRequest("payrequests", "POST", {
          currency: baseCurr,
          target_currency: targetCurr,
          description: `Pheizu deposit for ${uid}`
        }, apiKey);

        if (prRes.ok && prRes.data) {
          ok = true;
          status = prRes.status;
          paymentData = prRes.data;
          sourceEndpoint = "payrequests";
        }
      }

      // Open Amount On-chain -> Create Payment Address
      if (isOpenAmount && payMethod === "onchain") {
        const addrRes = await speedRequest("payment-addresses", "POST", {
          currency: baseCurr,
          target_currency: targetCurr,
          payment_method: "onchain",
          metadata: { user_id: uid, telegram_id: telegram_id ? String(telegram_id) : "" }
        }, apiKey);

        if (addrRes.ok && addrRes.data) {
          ok = true;
          status = addrRes.status;
          paymentData = addrRes.data;
          sourceEndpoint = "payment-addresses";
        }
      }

      // Specific Amount or Fallback
      if (!ok) {
        const speedBody = {
          currency: baseCurr,
          target_currency: targetCurr,
          payment_methods: [payMethod],
          amount: isOpenAmount ? 0 : requestedAmount,
          metadata: {
            user_id: uid,
            telegram_id: telegram_id ? String(telegram_id) : ""
          }
        };

        const res1 = await speedRequest("payments", "POST", speedBody, apiKey);
        ok = res1.ok;
        status = res1.status;
        paymentData = res1.data;
        sourceEndpoint = "payments";
      }

      if (!ok && status !== 201 && status !== 200) {
        const errorDetail = extractErrorMessage(paymentData, status);
        return res.status(status || 400).json({
          success: false,
          error: `[Speed ${status}] ${errorDetail}`
        });
      }

      const target = extractPaymentTarget(paymentData);
      const invoiceString = target ? target.value : null;

      if (!invoiceString) {
        return res.status(500).json({ success: false, error: "Speed did not return a valid payment address or invoice." });
      }

      const speedId = paymentData?.id || paymentData?.payrequest_id || paymentData?.invoice_id;
      const txId = speedId;
      const numericChatId = await resolveNumericTelegramId(uid, telegram_id);

      await db.collection("invoices").doc(txId).set({
        id: txId,
        tx_id: txId,
        speed_payment_id: speedId,
        speed_payrequest_id: paymentData?.payrequest_id || (speedId.startsWith("pr_") ? speedId : null),
        speed_source: sourceEndpoint,
        invoice: invoiceString,
        payment_type: target.type,
        user_id: uid,
        target_currency: targetCurr,
        payment_method: payMethod,
        telegram_id: numericChatId,
        amount: isOpenAmount ? 0 : requestedAmount,
        is_open_amount: isOpenAmount,
        is_paid: false,
        notified: false,
        created_at: new Date().toISOString()
      }, { merge: true });

      return res.status(200).json({
        success: true,
        id: txId,
        tx_id: txId,
        payment_type: target.type,
        target_currency: targetCurr,
        amount: isOpenAmount ? 0 : requestedAmount,
        is_open_amount: isOpenAmount,
        invoice: invoiceString
      });
    }

    // ========================================================
    // 4. CHECK DEPOSIT STATUS (INTERNAL BOT-TO-BOT & EXTERNAL)
    // ========================================================
    if (action === "check-status" && req.method === "GET") {
      const { payment_id, user_id, telegram_id } = req.query;
      if (!payment_id) return res.status(400).json({ success: false, error: "Missing payment_id" });

      let invRef = db.collection("invoices").doc(payment_id);
      let invDoc = await invRef.get();

      if (!invDoc.exists) {
        const snap = await db.collection("invoices").where("id", "==", payment_id).limit(1).get();
        if (!snap.empty) {
          invDoc = snap.docs[0];
          invRef = invDoc.ref;
        }
      }

      const invData = invDoc.exists ? invDoc.data() : null;
      const curr = invData?.target_currency || "SATS";
      const creditTarget = invData?.user_id || user_id || (telegram_id ? `user${telegram_id}` : "");
      const storedInvoice = invData?.invoice || "";
      const cleanInvoice = storedInvoice.replace(/^lightning:/i, "").replace(/^bitcoin:/i, "").trim();
      const payMethod = invData?.payment_method || "lightning";

      const wallet = await findUserWallet([creditTarget, telegram_id, invData?.telegram_id, user_id]);
      const targetNumericChatId = await resolveNumericTelegramId(creditTarget, telegram_id || invData?.telegram_id || wallet?.data?.telegram_id);

      // Return immediately if already paid (Internal bot-to-bot or cached settled payment)
      if (invData && invData.is_paid && Number(invData.amount || 0) > 0) {
        if (!invData.notified && targetNumericChatId) {
          const fromUser = invData.paid_by ? ` from @${invData.paid_by}` : '';
          await notifyTelegramUser(
            targetNumericChatId,
            `🎉 <b>Payment Received!</b>\n\n` +
            `⚡ <b>+${invData.amount} ${curr}</b>${fromUser} credited to your balance!\n` +
            `💰 <b>New Balance:</b> ${(wallet ? wallet.balance : invData.amount).toLocaleString()} sats\n` +
            `🆔 <b>TxID:</b> <code>${payment_id}</code>`
          );
          await invRef.set({ notified: true }, { merge: true });
        }

        return res.status(200).json({
          success: true,
          is_paid: true,
          status: "paid",
          tx_id: payment_id,
          amount: Number(invData.amount),
          balance: wallet ? wallet.balance : 0,
          currency: curr
        });
      }

      const apiKey = await getSpeedApiKey();
      const speedId = invData?.speed_payment_id || invData?.speed_payrequest_id || invData?.id || payment_id;

      let payment = null;
      let detectedAmount = 0;

      // 🔍 DISCOVERY 1: Check PayRequest payments
      if (speedId.startsWith("pr_") || invData?.speed_source === "payrequests" || invData?.speed_payrequest_id) {
        const prId = invData?.speed_payrequest_id || speedId;
        try {
          const prPayRes = await speedRequest(`payrequests/${prId}/payments`, "GET", null, apiKey);
          if (prPayRes.ok && prPayRes.data) {
            const list = prPayRes.data.data || prPayRes.data.items || prPayRes.data.payments || (Array.isArray(prPayRes.data) ? prPayRes.data : []);
            const paidItems = list.filter(p => ["paid", "succeeded", "completed", "confirmed"].includes(String(p.status).toLowerCase()));
            if (paidItems.length > 0) {
              payment = paidItems[0];
              detectedAmount = extractPaidAmount(paidItems[0], invData);
            }
          }
        } catch (e) {}
      }

      // 🔍 DISCOVERY 2: Official Speed Search API (POST /search/payments)
      if (!payment) {
        try {
          const searchRes = await speedRequest("search/payments", "POST", {
            query: "status:paid",
            limit: 15
          }, apiKey);

          if (searchRes.ok && searchRes.data) {
            const list = searchRes.data.data || searchRes.data.items || [];
            for (const p of list) {
              const matchesInvoice = cleanInvoice && (
                p.invoice === cleanInvoice ||
                p.payment_request === cleanInvoice ||
                p.payment_method_options?.lightning?.payment_request === cleanInvoice ||
                p.payment_method_options?.on_chain?.address === cleanInvoice
              );
              const matchesId = p.id === speedId || p.payrequest_id === speedId;

              if (matchesInvoice || matchesId) {
                payment = p;
                detectedAmount = extractPaidAmount(p, invData);
                break;
              }
            }
          }
        } catch (e) {}
      }

      // 🔍 DISCOVERY 3: Direct Payment check (/payments/:id)
      if (!payment) {
        try {
          const directPay = await speedRequest(`payments/${speedId}`, "GET", null, apiKey);
          if (directPay.ok && directPay.data && directPay.data.id) {
            payment = directPay.data;
            detectedAmount = extractPaidAmount(directPay.data, invData);
          }
        } catch (e) {}
      }

      // 🔍 DISCOVERY 4: Payment Address check (/payment-addresses/:id/payments)
      if (!payment && (speedId.startsWith("pa_") || invData?.speed_source === "payment-addresses")) {
        try {
          const paRes = await speedRequest(`payment-addresses/${speedId}/payments`, "GET", null, apiKey);
          if (paRes.ok && paRes.data) {
            const list = paRes.data.data || paRes.data.items || [];
            const paidItems = list.filter(p => ["paid", "succeeded", "completed", "confirmed"].includes(String(p.status).toLowerCase()));
            if (paidItems.length > 0) {
              payment = paidItems[0];
              detectedAmount = extractPaidAmount(paidItems[0], invData);
            }
          }
        } catch (e) {}
      }

      const rawStatus = String(
        payment?.status ||
        payment?.state ||
        payment?.payment_status ||
        payment?.payment?.status ||
        ""
      ).toLowerCase();

      // Strict paid validation
      const isConfirmedPaidStatus = [
        "paid",
        "succeeded",
        "successful",
        "completed",
        "confirmed",
        "settled"
      ].includes(rawStatus);

      const hasPaidFlag = payment?.paid === true || payment?.is_paid === true || !!payment?.paid_at || !!payment?.settled_at;

      const hasPayrequestFunds = (
        (speedId.startsWith("pr_") || invData?.speed_source === "payrequests") &&
        (Number(payment?.total_amount_received || 0) > 0 || Number(payment?.payment_count || 0) > 0)
      );

      const isPaid = (isConfirmedPaidStatus || hasPaidFlag || hasPayrequestFunds);
      const finalSats = detectedAmount > 0 ? detectedAmount : extractPaidAmount(payment, invData);

      // Process and credit ONLY when Speed genuinely confirms payment
      if (isPaid && finalSats > 0) {
        const finalCurr = curr || payment?.target_currency || "SATS";

        let updatedBal = 0;
        if (wallet) {
          const batch = db.batch();

          const oldRecordedAmt = Number(invData?.amount || 0);
          const delta = finalSats - oldRecordedAmt;

          if (invRef) {
            batch.set(invRef, {
              is_paid: true,
              notified: true,
              paid_at: new Date().toISOString(),
              amount: finalSats
            }, { merge: true });
          }

          if (delta > 0) {
            if (finalCurr === "SATS") {
              batch.set(wallet.ref, {
                balance: admin.firestore.FieldValue.increment(delta),
                updated_at: new Date().toISOString()
              }, { merge: true });
            } else if (finalCurr === "USDT") {
              batch.set(wallet.ref, {
                usdt_balance: admin.firestore.FieldValue.increment(delta),
                updated_at: new Date().toISOString()
              }, { merge: true });
            } else if (finalCurr === "USDC") {
              batch.set(wallet.ref, {
                usdc_balance: admin.firestore.FieldValue.increment(delta),
                updated_at: new Date().toISOString()
              }, { merge: true });
            }
          }

          batch.set(db.collection("transactions").doc(payment_id), {
            id: payment_id,
            tx_id: payment_id,
            type: "deposit",
            user_id: wallet.id,
            amount: finalSats,
            currency: finalCurr,
            status: "completed",
            created_at: new Date().toISOString()
          });

          await batch.commit().catch(() => {});
          updatedBal = wallet.balance + (finalCurr === "SATS" ? delta : 0);
        }

        if (targetNumericChatId) {
          await notifyTelegramUser(
            targetNumericChatId,
            `🎉 <b>Payment Received!</b>\n\n` +
            `⚡ <b>+${finalSats} ${finalCurr}</b> credited to your balance!\n` +
            `💰 <b>New Balance:</b> ${updatedBal.toLocaleString()} sats\n` +
            `🆔 <b>TxID:</b> <code>${payment_id}</code>`
          );
        }

        await forwardToLogsChannel(
          `✅ <b>Deposit Successful</b>\n` +
          `• User: @${wallet ? wallet.id : creditTarget}\n` +
          `• Amount: +${finalSats} ${finalCurr}\n` +
          `• New Balance: ${updatedBal.toLocaleString()} sats\n` +
          `• TxID: <code>${payment_id}</code>`
        );

        return res.status(200).json({
          success: true,
          is_paid: true,
          status: "paid",
          tx_id: payment_id,
          amount: finalSats,
          balance: updatedBal,
          currency: finalCurr
        });
      }

      return res.status(200).json({
        success: true,
        is_paid: false,
        status: rawStatus || "unpaid",
        tx_id: payment_id,
        amount: 0,
        balance: wallet ? wallet.balance : 0,
        currency: curr
      });
    }

    // ========================================================
    // 5. WITHDRAW / SEND (Prevents duplicate payout & supports internal transfer)
    // ========================================================
    if (action === "send" && req.method === "POST") {
      const { destination, amount, user_id, telegram_id, username, withdraw_method, network, currency, target_currency } = req.body;
      const sendAmount = Number(amount);
      const dest = (destination || "").trim();

      if (!dest || isNaN(sendAmount) || sendAmount <= 0) {
        return res.status(400).json({ success: false, error: "Invalid parameters." });
      }

      const cleanDest = dest.replace(/^lightning:/i, "").replace(/^bitcoin:/i, "").trim();

      // Check if invoice has already been paid
      if (dest.toLowerCase().startsWith("lnbc") || dest.toLowerCase().startsWith("lightning:lnbc") || dest.startsWith("bc1")) {
        const paidInvCheck = await db.collection("invoices")
          .where("invoice", "in", [dest, cleanDest, `lightning:${cleanDest}`])
          .where("is_paid", "==", true)
          .limit(1)
          .get();

        if (!paidInvCheck.empty) {
          return res.status(400).json({
            success: false,
            error: "This invoice has already been paid and cannot be paid again."
          });
        }

        const existingTxCheck = await db.collection("transactions")
          .where("destination", "==", dest)
          .where("status", "==", "completed")
          .limit(1)
          .get();

        if (!existingTxCheck.empty) {
          return res.status(400).json({
            success: false,
            error: "This destination has already been paid in a previous transaction."
          });
        }
      }

      const senderCandidates = [user_id, username, telegram_id, telegram_id ? `user${telegram_id}` : null];
      const senderWallet = await findUserWallet(senderCandidates);

      if (!senderWallet) {
        return res.status(400).json({ success: false, error: "Wallet not found." });
      }

      let method = (withdraw_method || network || "").toLowerCase();
      if (method === "on-chain" || method === "bitcoin" || method === "onchain") method = "onchain";

      if (!method) {
        if (dest.toLowerCase().startsWith("lnbc") || dest.includes("@")) {
          method = "lightning";
        } else if (dest.startsWith("bc1") || dest.startsWith("1") || dest.startsWith("3")) {
          method = "onchain";
        } else if (dest.startsWith("T")) {
          method = "tron";
        } else if (dest.startsWith("0x")) {
          method = "ethereum";
        } else {
          method = "lightning";
        }
      }

      const isUsdt = (currency === "USDT" || target_currency === "USDT" || method === "tron" || method === "ton");
      const isUsdc = (currency === "USDC" || target_currency === "USDC" || method === "solana");
      const curr = isUsdt ? "USDT" : (isUsdc ? "USDC" : "SATS");
      const targetCurr = target_currency || curr;

      const currentSats = Number(senderWallet.data.balance || 0);
      const currentUsdt = Number(senderWallet.data.usdt_balance || 0);
      const currentUsdc = Number(senderWallet.data.usdc_balance || 0);

      if (curr === "SATS" && sendAmount > currentSats) {
        return res.status(400).json({ success: false, error: `Insufficient SATS! You have ${currentSats.toLocaleString()} SATS.` });
      }
      if (curr === "USDT" && sendAmount > currentUsdt) {
        return res.status(400).json({ success: false, error: `Insufficient USDT! You have ${currentUsdt.toFixed(2)} USDT.` });
      }
      if (curr === "USDC" && sendAmount > currentUsdc) {
        return res.status(400).json({ success: false, error: `Insufficient USDC! You have ${currentUsdc.toFixed(2)} USDC.` });
      }

      let recipientUserId = null;
      let internalInvoiceDoc = null;

      // 1. Check if recipient is a Lightning Address on this domain
      if (dest.includes("@") && dest.toLowerCase().includes(DOMAIN.toLowerCase())) {
        recipientUserId = dest.split("@")[0].toLowerCase().trim();
      }

      // 2. Check if invoice belongs to an internal user in our system
      if (!recipientUserId) {
        const candidates = [dest, cleanDest, `lightning:${cleanDest}`];
        const invSnap = await db.collection("invoices")
          .where("invoice", "in", candidates)
          .where("is_paid", "==", false)
          .limit(1)
          .get();

        if (!invSnap.empty) {
          const inv = invSnap.docs[0];
          recipientUserId = inv.data().user_id;
          internalInvoiceDoc = inv.ref;
        }
      }

      // ⚡ INTERNAL BOT-TO-BOT TRANSFER
      if (recipientUserId) {
        if (recipientUserId === senderWallet.id) {
          return res.status(400).json({ success: false, error: "You cannot send payments to your own account." });
        }

        const recipientWallet = await findUserWallet([recipientUserId]);
        const txId = internalInvoiceDoc ? internalInvoiceDoc.id : `INT_${Date.now()}`;

        const batch = db.batch();

        if (curr === "SATS") {
          batch.set(senderWallet.ref, { balance: admin.firestore.FieldValue.increment(-sendAmount), updated_at: new Date().toISOString() }, { merge: true });
          batch.set(recipientWallet.ref, { balance: admin.firestore.FieldValue.increment(sendAmount), updated_at: new Date().toISOString() }, { merge: true });
        } else if (curr === "USDT") {
          batch.set(senderWallet.ref, { usdt_balance: admin.firestore.FieldValue.increment(-sendAmount), updated_at: new Date().toISOString() }, { merge: true });
          batch.set(recipientWallet.ref, { usdt_balance: admin.firestore.FieldValue.increment(sendAmount), updated_at: new Date().toISOString() }, { merge: true });
        } else if (curr === "USDC") {
          batch.set(senderWallet.ref, { usdc_balance: admin.firestore.FieldValue.increment(-sendAmount), updated_at: new Date().toISOString() }, { merge: true });
          batch.set(recipientWallet.ref, { usdc_balance: admin.firestore.FieldValue.increment(sendAmount), updated_at: new Date().toISOString() }, { merge: true });
        }

        let recipientTgId = null;

        if (internalInvoiceDoc) {
          const invData = (await internalInvoiceDoc.get()).data();
          recipientTgId = invData?.telegram_id;

          // Marks the invoice paid so the recipient's check-status triggers immediately
          batch.update(internalInvoiceDoc, {
            is_paid: true,
            notified: false,
            paid_at: new Date().toISOString(),
            paid_by: senderWallet.id,
            tx_id: txId,
            amount: sendAmount
          });
        }

        batch.set(db.collection("transactions").doc(`${txId}_send`), {
          id: `${txId}_send`,
          tx_id: txId,
          type: "transfer_sent",
          user_id: senderWallet.id,
          to: recipientWallet.id,
          amount: sendAmount,
          currency: curr,
          status: "completed",
          created_at: new Date().toISOString()
        });

        batch.set(db.collection("transactions").doc(`${txId}_recv`), {
          id: `${txId}_recv`,
          tx_id: txId,
          type: "transfer_received",
          user_id: recipientWallet.id,
          from: senderWallet.id,
          amount: sendAmount,
          currency: curr,
          status: "completed",
          created_at: new Date().toISOString()
        });

        await batch.commit();

        const targetChatId = await resolveNumericTelegramId(recipientWallet.id, recipientTgId || recipientWallet.data?.telegram_id);
        if (targetChatId) {
          await notifyTelegramUser(
            targetChatId,
            `🎉 <b>Payment Received!</b>\n\n` +
            `💰 <b>+${sendAmount} ${curr}</b> received from @${senderWallet.id}!\n` +
            `🆔 <b>TxID:</b> <code>${txId}</code>`
          );
        }

        await forwardToLogsChannel(
          `✅ <b>Internal Transfer Successful</b>\n` +
          `• From: @${senderWallet.id}\n` +
          `• To: @${recipientWallet.id}\n` +
          `• Amount: ${sendAmount} ${curr}\n` +
          `• TxID: <code>${txId}</code>`
        );

        return res.status(200).json({
          success: true,
          internal: true,
          tx_id: txId,
          recipient: recipientWallet.id,
          message: `Internal transfer of ${sendAmount} ${curr} completed.`
        });
      }

      // External Speed Withdrawal
      const apiKey = await getSpeedApiKey();
      if (!apiKey) {
        return res.status(500).json({ success: false, error: "Speed API key is not configured." });
      }

      let finalDest = dest;
      if (method === "lightning" && dest.includes("@")) {
        finalDest = await resolveLnAddress(dest, sendAmount);
      }

      let speedPayload = {
        amount: sendAmount,
        currency: "SATS",
        target_currency: targetCurr,
        withdraw_method: method,
        withdraw_request: finalDest,
        note: `Withdrawal by ${senderWallet.id}`
      };

      if (curr === "SATS") {
        speedPayload.currency = "SATS";
        speedPayload.target_currency = "SATS";
      }

      let { ok, status, data: sendData } = await speedRequest("send", "POST", speedPayload, apiKey);

      if (!ok && (status === 400 || status === 422)) {
        speedPayload.currency = targetCurr;
        const retry = await speedRequest("send", "POST", speedPayload, apiKey);
        if (retry.ok || retry.status === 200 || retry.status === 201) {
          ok = true;
          status = retry.status;
          sendData = retry.data;
        }
      }

      if (!ok && (status === 404 || status === 403)) {
        const retry = await speedRequest("instant_sends", "POST", {
          amount: sendAmount,
          currency: "SATS",
          target_currency: targetCurr,
          destination: finalDest,
          recipient: finalDest,
          payment_method: method
        }, apiKey);
        if (retry.ok || retry.status === 200 || retry.status === 201) {
          ok = true;
          status = retry.status;
          sendData = retry.data;
        }
      }

      if (!ok && status !== 200 && status !== 201) {
        const errorDetail = extractErrorMessage(sendData, status);
        return res.status(status || 400).json({
          success: false,
          error: `[Speed ${status}] ${errorDetail}`
        });
      }

      const speedTxId = sendData?.id || sendData?.payment_id || sendData?.tx_id;
      const txId = speedTxId;

      const updateData = { updated_at: new Date().toISOString() };
      let remainingBal = 0;

      if (curr === "SATS") {
        updateData.balance = admin.firestore.FieldValue.increment(-sendAmount);
        remainingBal = currentSats - sendAmount;
      } else if (curr === "USDT") {
        updateData.usdt_balance = admin.firestore.FieldValue.increment(-sendAmount);
        remainingBal = currentUsdt - sendAmount;
      } else if (curr === "USDC") {
        updateData.usdc_balance = admin.firestore.FieldValue.increment(-sendAmount);
        remainingBal = currentUsdc - sendAmount;
      }

      const batch = db.batch();
      batch.set(senderWallet.ref, updateData, { merge: true });

      batch.set(db.collection("transactions").doc(txId), {
        id: txId,
        tx_id: txId,
        type: "withdrawal",
        user_id: senderWallet.id,
        destination: dest,
        withdraw_method: method,
        amount: sendAmount,
        currency: curr,
        status: "completed",
        created_at: new Date().toISOString()
      });

      await batch.commit();

      await forwardToLogsChannel(
        `✅ <b>Withdrawal Successful</b>\n` +
        `• User: @${senderWallet.id}\n` +
        `• Amount: -${sendAmount} ${curr}\n` +
        `• Network: ${method.toUpperCase()}\n` +
        `• Destination: <code>${dest}</code>\n` +
        `• Remaining Balance: ${remainingBal} ${curr}\n` +
        `• TxID: <code>${txId}</code>`
      );

      return res.status(200).json({
        success: true,
        id: txId,
        tx_id: txId,
        remaining_balance: remainingBal,
        message: `Successfully sent ${sendAmount} ${curr}.`
      });
    }

    // ========================================================
    // 6. ADMIN: GET ALL DASHBOARD DATA
    // ========================================================
    if (action === "admin-get-data" && req.method === "GET") {
      const tid = req.query.telegram_id;
      const uname = req.query.username;
      if (!(await isAuthorizedAdminById(tid, uname))) {
        return res.status(403).json({ success: false, error: "Unauthorized access" });
      }

      const savedKey = await getSpeedApiKey();
      let logsChannel = "";
      let adminsList = [];

      if (db) {
        try {
          const chSnap = await db.collection("settings").doc("logs_channel").get();
          if (chSnap.exists && chSnap.data().channel_id) logsChannel = chSnap.data().channel_id;
        } catch(e) {}

        try {
          const admSnap = await db.collection("settings").doc("admins").get();
          if (admSnap.exists && Array.isArray(admSnap.data().list)) adminsList = admSnap.data().list;
        } catch(e) {}
      }

      const usersList = [];
      if (db) {
        const uSnap = await db.collection("users").get();
        for (const doc of uSnap.docs) {
          const d = doc.data();
          let sats = Number(d.balance ?? d.sats ?? d.amount ?? 0);
          let usdt = Number(d.usdt_balance ?? 0);
          let usdc = Number(d.usdc_balance ?? 0);

          try {
            const wDoc = await db.collection("wallets").doc(doc.id).get();
            if (wDoc.exists) {
              const wd = wDoc.data();
              sats = Math.max(sats, Number(wd.balance ?? wd.sats ?? wd.amount ?? 0));
              usdt = Math.max(usdt, Number(wd.usdt_balance ?? 0));
              usdc = Math.max(usdc, Number(wd.usdc_balance ?? 0));
            }
          } catch(e) {}

          usersList.push({
            user_id: doc.id,
            username: d.username || "",
            telegram_id: d.telegram_id || "",
            first_name: d.first_name || "",
            banned: Boolean(d.banned),
            sats,
            usdt,
            usdc
          });
        }
      }

      return res.status(200).json({
        success: true,
        speed_key: savedKey,
        logs_channel: logsChannel,
        admins_list: adminsList,
        users: usersList
      });
    }

    // ========================================================
    // 7. ADMIN: BROADCAST TO ALL USERS
    // ========================================================
    if (action === "admin-broadcast" && req.method === "POST") {
      const { text, telegram_id, username } = req.body;
      if (!(await isAuthorizedAdminById(telegram_id, username))) {
        return res.status(403).json({ success: false, error: "Unauthorized" });
      }
      if (!text || !text.trim()) {
        return res.status(400).json({ success: false, error: "Broadcast message text is required." });
      }
      if (!BOT_TOKEN) {
        return res.status(500).json({ success: false, error: "BOT_TOKEN is not configured." });
      }

      let sentCount = 0;
      let failedCount = 0;

      if (db) {
        const usersSnap = await db.collection("users").get();
        const recipientIds = new Set();

        usersSnap.forEach(doc => {
          const d = doc.data();
          if (d.telegram_id && /^\d+$/.test(String(d.telegram_id))) {
            recipientIds.add(String(d.telegram_id));
          }
        });

        for (const tId of recipientIds) {
          try {
            const bRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: tId,
                text: text,
                parse_mode: "HTML"
              })
            });
            const bData = await bRes.json();
            if (bData.ok) sentCount++;
            else failedCount++;
          } catch(e) {
            failedCount++;
          }
        }
      }

      return res.status(200).json({
        success: true,
        sent: sentCount,
        failed: failedCount,
        total: sentCount + failedCount
      });
    }

    // ========================================================
    // 8. ADMIN: CONFIGURATION SETTINGS
    // ========================================================
    if (action === "admin-save-key" && req.method === "POST") {
      const { api_key, telegram_id, username } = req.body;
      if (!(await isAuthorizedAdminById(telegram_id, username))) {
        return res.status(403).json({ success: false, error: "Unauthorized" });
      }
      if (!api_key) return res.status(400).json({ success: false, error: "API key is required" });

      if (db) {
        await db.collection("settings").doc("speed").set({ api_key: api_key.trim(), updated_at: new Date().toISOString() }, { merge: true });
      }
      return res.status(200).json({ success: true });
    }

    if (action === "admin-save-channel" && req.method === "POST") {
      const { channel_id, telegram_id, username } = req.body;
      if (!(await isAuthorizedAdminById(telegram_id, username))) {
        return res.status(403).json({ success: false, error: "Unauthorized" });
      }
      let chId = String(channel_id).trim();
      if (/^\d{8,14}$/.test(chId)) chId = `-100${chId}`;

      if (db) {
        await db.collection("settings").doc("logs_channel").set({ channel_id: chId, updated_at: new Date().toISOString() }, { merge: true });
      }
      return res.status(200).json({ success: true, channel_id: chId });
    }

    if (action === "admin-manage-admin" && req.method === "POST") {
      const { task, target_admin, telegram_id, username } = req.body;
      if (!(await isAuthorizedAdminById(telegram_id, username))) {
        return res.status(403).json({ success: false, error: "Unauthorized" });
      }
      const adminTarget = String(target_admin).trim().toLowerCase().replace(/^@/, "");

      if (db) {
        if (task === "add") {
          await db.collection("settings").doc("admins").set({ list: admin.firestore.FieldValue.arrayUnion(adminTarget) }, { merge: true });
        } else if (task === "remove") {
          await db.collection("settings").doc("admins").set({ list: admin.firestore.FieldValue.arrayRemove(adminTarget) }, { merge: true });
        }
      }
      return res.status(200).json({ success: true });
    }

    if (action === "admin-adjust-balance" && req.method === "POST") {
      const { target_user, asset, amount, type, telegram_id, username } = req.body;
      if (!(await isAuthorizedAdminById(telegram_id, username))) {
        return res.status(403).json({ success: false, error: "Unauthorized" });
      }
      const numAmt = Number(amount);
      if (!numAmt || numAmt <= 0) return res.status(400).json({ success: false, error: "Invalid amount" });

      const delta = (type === "deduct") ? -numAmt : numAmt;
      const target = String(target_user).toLowerCase().replace(/^@/, "");

      if (db) {
        const field = asset === "USDT" ? "usdt_balance" : (asset === "USDC" ? "usdc_balance" : "balance");
        await db.collection("users").doc(target).set({ [field]: admin.firestore.FieldValue.increment(delta) }, { merge: true });
        await db.collection("wallets").doc(target).set({ [field]: admin.firestore.FieldValue.increment(delta) }, { merge: true });
      }
      return res.status(200).json({ success: true, credited: delta });
    }

    if (action === "admin-manage-user" && req.method === "POST") {
      const { target_user, task, telegram_id, username } = req.body;
      if (!(await isAuthorizedAdminById(telegram_id, username))) {
        return res.status(403).json({ success: false, error: "Unauthorized" });
      }
      const target = String(target_user).toLowerCase().replace(/^@/, "");

      if (db) {
        if (task === "ban") {
          await db.collection("users").doc(target).set({ banned: true }, { merge: true });
        } else if (task === "unban") {
          await db.collection("users").doc(target).set({ banned: false }, { merge: true });
        } else if (task === "delete") {
          await db.collection("users").doc(target).delete();
          await db.collection("wallets").doc(target).delete();
        }
      }
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, error: "Invalid action." });
  } catch (err) {
    console.error("Wallet Handler Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
