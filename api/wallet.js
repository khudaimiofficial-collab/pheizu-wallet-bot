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

// Helper: Clean and format API key (strips quotes, whitespace, and prefixes)
function sanitizeApiKey(raw) {
  if (!raw) return "";
  return String(raw)
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^Bearer\s+/i, "")
    .replace(/^Basic\s+/i, "")
    .trim();
}

// Helper: Send Single Telegram Notification to User
async function notifyTelegramUser(telegramId, message) {
  if (!BOT_TOKEN || !telegramId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: String(telegramId),
        text: message,
        parse_mode: "HTML"
      })
    });
  } catch (e) {
    console.error("Failed to notify user:", e.message);
  }
}

// Helper: Forward Wallet Events to Telegram Logs Channel (SUCCESS ONLY)
async function forwardToLogsChannel(text) {
  if (!BOT_TOKEN) return;
  try {
    let channelId = null;
    if (db) {
      try {
        const snap = await db.collection("settings").doc("logs_channel").get();
        if (snap.exists && snap.data().channel_id) {
          channelId = snap.data().channel_id;
        }
      } catch (err) {}
    }

    if (!channelId) {
      channelId = process.env.LOG_CHANNEL_ID || process.env.ADMIN_CHAT_ID;
    }

    if (!channelId) return;

    channelId = String(channelId).trim();
    if (/^\d{8,14}$/.test(channelId)) channelId = `-100${channelId}`;

    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: channelId,
        text: text,
        parse_mode: "HTML"
      })
    });

    const result = await res.json();
    if (!result.ok) {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: channelId,
          text: text.replace(/<[^>]*>?/gm, "")
        })
      });
    }
  } catch (e) {
    console.error("forwardToLogsChannel error:", e.message);
  }
}

// Helper: Get active Speed API key from DB or Env
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
    } catch (e) {
      console.warn("Could not read API key from DB:", e.message);
    }
  }
  return sanitizeApiKey(process.env.SPEED_API_KEY || process.env.SPEED_SECRET_KEY || "");
}

// Helper: Resolve Lightning Address (LNURL-pay) to BOLT11 invoice
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
    } catch (e) {
      console.warn("LNURL resolve error, passing original destination:", e.message);
    }
  }
  return dest;
}

// Universal extractor for payment targets
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
    if (str.startsWith("T") && str.length >= 30) {
      return { type: "tron", value: str };
    }
    if (str.startsWith("0x") && str.length === 42) {
      return { type: "ethereum", value: str };
    }
    return null;
  }

  if (typeof obj !== "object") return null;

  if (obj.payment_request && typeof obj.payment_request === "string") {
    return { type: "lightning", value: obj.payment_request };
  }
  if (obj.invoice && typeof obj.invoice === "string") {
    return { type: "lightning", value: obj.invoice };
  }
  if (obj.address && typeof obj.address === "string") {
    return { type: "address", value: obj.address };
  }
  if (obj.uri && typeof obj.uri === "string") {
    return { type: "uri", value: obj.uri };
  }

  if (Array.isArray(obj.payment_methods)) {
    for (const pm of obj.payment_methods) {
      for (const key of ["lightning", "onchain", "tron", "solana", "ethereum"]) {
        if (pm[key]) {
          if (pm[key].address) return { type: key, value: pm[key].address };
          if (pm[key].payment_request) return { type: "lightning", value: pm[key].payment_request };
          if (pm[key].uri) return { type: key, value: pm[key].uri };
        }
      }
    }
  }

  for (const key of Object.keys(obj)) {
    const res = extractPaymentTarget(obj[key]);
    if (res) return res;
  }

  if (obj.hosted_url || obj.url) {
    return { type: "url", value: obj.hosted_url || obj.url };
  }

  return null;
}

// Speed Client with proper Basic Auth
async function speedRequest(path, method, body, apiKey) {
  const cleanKey = sanitizeApiKey(apiKey);
  if (!cleanKey) {
    return { ok: false, status: 401, data: { message: "No Speed API key provided" } };
  }

  // Speed API authentication: Basic Auth with API key as username and empty password
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

// Smart Wallet Resolver
async function findUserWallet(identifiers) {
  if (!db) return null;

  const rawList = [];
  for (const id of identifiers) {
    if (!id) continue;
    const s = String(id).trim().toLowerCase().replace(/^@/, "");
    rawList.push(s);
    if (s.startsWith("user") && /^\d+$/.test(s.slice(4))) {
      rawList.push(s.slice(4));
    }
    if (/^\d+$/.test(s)) {
      rawList.push(`user${s}`);
    }
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
          return {
            ref: doc.ref,
            id: doc.id,
            data,
            balance: Number(bal) || 0,
            collection: col
          };
        }
      }
    }
  }

  for (const col of collectionsToCheck) {
    for (const docId of candidateIds) {
      const doc = await db.collection(col).doc(docId).get();
      if (doc.exists) {
        return {
          ref: doc.ref,
          id: doc.id,
          data: doc.data(),
          balance: 0,
          collection: col
        };
      }
    }
  }

  for (const col of collectionsToCheck) {
    for (const cid of candidateIds) {
      const numId = cid.replace(/^user/, "");
      if (/^\d+$/.test(numId)) {
        const snap = await db.collection(col).where("telegram_id", "==", numId).limit(1).get();
        if (!snap.empty) {
          const doc = snap.docs[0];
          const data = doc.data();
          const bal = data.balance ?? data.sats ?? data.amount;
          return {
            ref: doc.ref,
            id: doc.id,
            data,
            balance: Number(bal) || 0,
            collection: col
          };
        }
      }
    }
  }

  const primary = candidateIds.find(c => !c.startsWith("user") && /^\d+$/.test(c)) || candidateIds[0] || "unknown";
  return {
    ref: db.collection("users").doc(primary),
    id: primary,
    data: {},
    balance: 0,
    collection: "users"
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (!db) {
    return res.status(500).json({ 
      success: false, 
      error: "Firebase connection failed. Verify FIREBASE_SERVICE_ACCOUNT variable." 
    });
  }

  const { action } = req.query;

  try {
    // ========================================================
    // 1. GET BALANCE
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

      const snap = await db.collection("transactions")
        .where("user_id", "==", queryUser)
        .limit(20)
        .get();

      const list = [];
      snap.forEach(d => list.push(d.data()));
      list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

      return res.status(200).json({
        success: true,
        history: list.slice(0, 10)
      });
    }

    // ========================================================
    // 3. CREATE DEPOSIT INVOICE
    // ========================================================
    if (action === "create-payment" && req.method === "POST") {
      const { amount, user_id, username, telegram_id, target_currency, payment_method, network } = req.body;
      const uid = (user_id || username || (telegram_id ? `user${telegram_id}` : "")).toLowerCase().trim();

      if (!uid) {
        return res.status(400).json({ success: false, error: "Missing user identification." });
      }

      const apiKey = await getSpeedApiKey();
      if (!apiKey) {
        return res.status(500).json({ 
          success: false, 
          error: "Speed API key is not configured. Admin can set it using '🔑 Set Speed Key'." 
        });
      }

      const targetCurr = (target_currency || "SATS").toUpperCase();
      let payMethod = (payment_method || network || "lightning").toLowerCase();
      if (payMethod === "on-chain" || payMethod === "on_chain" || payMethod === "bitcoin") payMethod = "onchain";
      const baseCurr = targetCurr === "SATS" ? "SATS" : "USD";

      const isOpenAmount = !amount || Number(amount) <= 0;

      let paymentData = null;
      let ok = false;
      let status = 400;
      let sourceEndpoint = "payments";

      if (isOpenAmount) {
        const prRes = await speedRequest("payrequests", "POST", {
          currency: baseCurr,
          target_currency: targetCurr,
          description: `Open deposit to ${uid}`
        }, apiKey);

        if (prRes.ok && prRes.data) {
          ok = true;
          status = prRes.status;
          paymentData = prRes.data;
          sourceEndpoint = "payrequests";
        }
      }

      if (!ok) {
        const speedBody = {
          currency: baseCurr,
          target_currency: targetCurr,
          payment_methods: [payMethod],
          metadata: {
            user_id: uid,
            telegram_id: telegram_id ? String(telegram_id) : ""
          }
        };

        if (isOpenAmount) {
          speedBody.amount = 0;
        } else {
          speedBody.amount = Number(amount);
        }

        const res1 = await speedRequest("payments", "POST", speedBody, apiKey);
        ok = res1.ok;
        status = res1.status;
        paymentData = res1.data;
        sourceEndpoint = "payments";

        if (!ok && (status === 400 || status === 422)) {
          const retry = await speedRequest("payments", "POST", {
            currency: baseCurr,
            target_currency: targetCurr,
            payment_methods: ["onchain"],
            metadata: speedBody.metadata,
            ...(isOpenAmount ? { amount: 0 } : { amount: Number(amount) })
          }, apiKey);

          if (retry.ok && retry.data) {
            ok = true;
            status = retry.status;
            paymentData = retry.data;
          }
        }
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
        return res.status(500).json({
          success: false,
          error: "Speed did not return a valid payment address or invoice."
        });
      }

      const txId = paymentData?.id || paymentData?.payrequest_id || paymentData?.invoice_id || `py_${Date.now()}`;

      // Save user mapping so check-status ALWAYS knows user's telegram_id
      const finalTgId = telegram_id ? String(telegram_id) : null;

      await db.collection("invoices").doc(txId).set({
        id: txId,
        speed_payment_id: paymentData?.id || null,
        speed_payrequest_id: paymentData?.payrequest_id || null,
        speed_invoice_id: paymentData?.invoice_id || null,
        speed_source: sourceEndpoint,
        invoice: invoiceString,
        payment_type: target.type,
        user_id: uid,
        target_currency: targetCurr,
        payment_method: payMethod,
        telegram_id: finalTgId,
        amount: isOpenAmount ? 0 : Number(amount),
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
        amount: isOpenAmount ? 0 : Number(amount),
        is_open_amount: isOpenAmount,
        invoice: invoiceString
      });
    }

    // ========================================================
    // 4. CHECK DEPOSIT STATUS — GUARANTEED TELEGRAM NOTIFICATION
    // ========================================================
    if (action === "check-status" && req.method === "GET") {
      const { payment_id, user_id, telegram_id } = req.query;

      if (!payment_id) {
        return res.status(400).json({ success: false, error: "Missing payment_id" });
      }

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
      const isOpenAmount = invData?.is_open_amount || Number(invData?.amount || 0) === 0;
      let sats = Number(invData?.amount || 0);
      const curr = invData?.target_currency || "SATS";
      const creditTarget = invData?.user_id || user_id || (telegram_id ? `user${telegram_id}` : "");
      
      const storedInvoice = invData?.invoice || "";
      const payMethod = invData?.payment_method || "lightning";

      const wallet = await findUserWallet([creditTarget, telegram_id, invData?.telegram_id, user_id]);

      // Resolve Telegram Chat ID from all possible candidate locations
      let targetTgId = invData?.telegram_id || telegram_id || wallet?.data?.telegram_id;
      if (!targetTgId && wallet?.id && /^\d+$/.test(wallet.id)) {
        targetTgId = wallet.id;
      }

      // If already credited, ensure notification was dispatched at least once
      if (invData && invData.is_paid) {
        if (!invData.notified && targetTgId) {
          await notifyTelegramUser(
            targetTgId,
            `🎉 <b>Payment Received!</b>\n\n` +
            `⚡ <b>+${sats} ${curr}</b> credited to your balance!\n` +
            `💰 <b>New Balance:</b> ${(wallet ? wallet.balance : sats).toLocaleString()} sats\n` +
            `🆔 <b>TxID:</b> <code>${payment_id}</code>`
          );
          await invRef.set({ notified: true }, { merge: true });
        }

        return res.status(200).json({
          success: true,
          is_paid: true,
          tx_id: payment_id,
          amount: sats,
          balance: wallet ? wallet.balance : 0,
          currency: curr
        });
      }

      const apiKey = await getSpeedApiKey();
      const speedId =
        invData?.speed_payrequest_id ||
        invData?.speed_invoice_id ||
        invData?.speed_payment_id ||
        invData?.id ||
        payment_id;

      // Try Speed endpoints
      let payment = null;
      const endpointsToTry = [];

      if (payMethod === "lightning") {
        endpointsToTry.push(`payrequests/${speedId}`);
        endpointsToTry.push(`invoices/${speedId}`);
        endpointsToTry.push(`lightning_invoices/${speedId}`);
        endpointsToTry.push(`payments/${speedId}`);
      } else {
        endpointsToTry.push(`payments/${speedId}`);
        endpointsToTry.push(`invoices/${speedId}`);
        endpointsToTry.push(`payrequests/${speedId}`);
      }

      for (const ep of endpointsToTry) {
        try {
          const r = await speedRequest(ep, "GET", null, apiKey);
          if (r.ok && r.data && (r.data.id || r.data.status || r.data.state || r.data.paid_at)) {
            payment = r.data;
            break;
          }
        } catch (e) {}
      }

      // Fallback search by invoice
      if (!payment && storedInvoice) {
        try {
          const shortInvoice = storedInvoice.substring(0, 60);
          const search = await speedRequest(`payments?search=${encodeURIComponent(shortInvoice)}`, "GET", null, apiKey);
          if (search.ok && search.data) {
            const list = search.data.data || search.data.items || search.data.results || [];
            if (Array.isArray(list) && list.length > 0) {
              payment = list[0];
            }
          }
        } catch (e) {}
      }

      const rawStatus = String(
        payment?.status ||
        payment?.state ||
        payment?.payment_status ||
        payment?.payment?.status ||
        payment?.invoice?.status ||
        ""
      ).toLowerCase();

      const paidStatuses = ["paid", "succeeded", "successful", "completed", "confirmed", "settled", "complete"];
      const alreadyLandedStatuses = ["confirming", "processing", "detected", "unconfirmed", "in_progress", "in-progress"];
      const isLightningPayment = payMethod === "lightning";

      const isPaid =
        paidStatuses.includes(rawStatus) ||
        (isLightningPayment && alreadyLandedStatuses.includes(rawStatus));

      const hasPaidFlag =
        payment?.paid === true ||
        payment?.is_paid === true ||
        !!payment?.paid_at ||
        !!payment?.completed_at ||
        !!payment?.settled_at;

      const amountPaid = Number(
        payment?.amount_paid ||
        payment?.amount_received ||
        payment?.paid_amount ||
        payment?.amount ||
        0
      );

      // Credit user & send bot chat message
      if ((isPaid || hasPaidFlag) && wallet) {
        let finalSats = amountPaid > 0 ? amountPaid : sats;

        if (finalSats <= 0) {
          return res.status(200).json({
            success: true,
            is_paid: false,
            status: "processing",
            tx_id: payment_id,
            amount: 0,
            is_open_amount: isOpenAmount,
            balance: wallet.balance,
            currency: curr
          });
        }

        const finalCurr = curr || payment?.target_currency || "SATS";
        const batch = db.batch();

        if (invRef) {
          batch.set(invRef, {
            is_paid: true,
            notified: true,
            paid_at: new Date().toISOString(),
            amount: finalSats
          }, { merge: true });
        }

        if (finalCurr === "SATS") {
          batch.set(wallet.ref, {
            balance: admin.firestore.FieldValue.increment(finalSats),
            updated_at: new Date().toISOString()
          }, { merge: true });
        } else if (finalCurr === "USDT") {
          batch.set(wallet.ref, {
            usdt_balance: admin.firestore.FieldValue.increment(finalSats),
            updated_at: new Date().toISOString()
          }, { merge: true });
        } else if (finalCurr === "USDC") {
          batch.set(wallet.ref, {
            usdc_balance: admin.firestore.FieldValue.increment(finalSats),
            updated_at: new Date().toISOString()
          }, { merge: true });
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

        await batch.commit();

        const updatedBal = wallet.balance + (finalCurr === "SATS" ? finalSats : 0);

        // 🔥 Dispatches message to user's Telegram Chat
        if (targetTgId) {
          await notifyTelegramUser(
            targetTgId,
            `🎉 <b>Payment Received!</b>\n\n` +
            `⚡ <b>+${finalSats} ${finalCurr}</b> credited to your balance!\n` +
            `💰 <b>New Balance:</b> ${updatedBal.toLocaleString()} sats\n` +
            `🆔 <b>TxID:</b> <code>${payment_id}</code>`
          );
        }

        await forwardToLogsChannel(
          `✅ <b>Deposit Successful</b>\n` +
          `• User: @${wallet.id}\n` +
          `• Amount: +${finalSats} ${finalCurr}\n` +
          `• New Balance: ${updatedBal.toLocaleString()} sats\n` +
          `• TxID: <code>${payment_id}</code>`
        );

        return res.status(200).json({
          success: true,
          is_paid: true,
          tx_id: payment_id,
          amount: finalSats,
          balance: updatedBal,
          currency: finalCurr
        });
      }

      return res.status(200).json({
        success: true,
        is_paid: false,
        status: rawStatus || "pending",
        tx_id: payment_id,
        amount: sats,
        is_open_amount: isOpenAmount,
        balance: wallet ? wallet.balance : 0,
        currency: curr
      });
    }

    // ========================================================
    // 5. WITHDRAW / SEND
    // ========================================================
    if (action === "send" && req.method === "POST") {
      const { destination, amount, user_id, telegram_id, username, withdraw_method, network, currency, target_currency } = req.body;
      const sendAmount = Number(amount);
      const dest = (destination || "").trim();

      if (!dest || isNaN(sendAmount) || sendAmount <= 0) {
        return res.status(400).json({ success: false, error: "Invalid parameters." });
      }

      const senderCandidates = [user_id, username, telegram_id, telegram_id ? `user${telegram_id}` : null];
      const senderWallet = await findUserWallet(senderCandidates);

      if (!senderWallet) {
        return res.status(400).json({ success: false, error: "Wallet not found." });
      }

      let method = (withdraw_method || network || "").toLowerCase();
      if (method === "on-chain" || method === "on_chain" || method === "bitcoin") method = "onchain";

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

      const isUsdt = (currency === "USDT" || target_currency === "USDT" || method === "tron");
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

      if (dest.includes("@") && dest.toLowerCase().includes(DOMAIN.toLowerCase())) {
        recipientUserId = dest.split("@")[0].toLowerCase().trim();
      }

      if (!recipientUserId) {
        const invSnap = await db.collection("invoices")
          .where("invoice", "==", dest)
          .where("is_paid", "==", false)
          .limit(1)
          .get();

        if (!invSnap.empty) {
          const inv = invSnap.docs[0];
          recipientUserId = inv.data().user_id;
          internalInvoiceDoc = inv.ref;
        }
      }

      // Internal Transfer
      if (recipientUserId) {
        if (recipientUserId === senderWallet.id) {
          return res.status(400).json({ success: false, error: "You cannot send payments to your own account." });
        }

        const recipientWallet = await findUserWallet([recipientUserId]);
        const txId = internalInvoiceDoc ? internalInvoiceDoc.id : `INT_${Date.now()}_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

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

          batch.update(internalInvoiceDoc, {
            is_paid: true,
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

        const targetChatId = recipientTgId || recipientWallet.data?.telegram_id;
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

      // External Withdrawal
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

      const txId = sendData?.id || `send_${Date.now()}`;
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

    return res.status(400).json({ success: false, error: "Invalid action." });
  } catch (err) {
    console.error("Wallet Handler Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
