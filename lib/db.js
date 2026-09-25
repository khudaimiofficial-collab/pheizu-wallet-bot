// lib/db.js
const admin = require('firebase-admin');

let db = null;
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();

function initFirebase() {
  if (admin.apps.length > 0) {
    return admin.firestore();
  }

  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
      const serviceAccount = raw.startsWith('{')
        ? JSON.parse(raw)
        : JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      return admin.firestore();
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID.trim(),
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL.trim(),
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        })
      });
      return admin.firestore();
    }
  } catch (err) {
    console.error("Firebase initialization failed:", err.message);
  }
  return null;
}

db = initFirebase();

const memoryStore = globalThis._walletMemoryStore || new Map();
globalThis._walletMemoryStore = memoryStore;

function normalizeUserKey(userInput, fallbackId = "") {
  if (!userInput && !fallbackId) return "guest";
  if (typeof userInput === "object" && userInput !== null) {
    if (userInput.username) return userInput.username.toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (userInput.id) return `user${userInput.id}`;
    return "guest";
  }
  const clean = String(userInput).trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (clean) return clean;
  if (fallbackId) return `user${String(fallbackId).trim()}`;
  return "guest";
}

async function saveUserTelegramId(userKey, telegramId) {
  if (!telegramId) return;
  const tgId = String(telegramId).trim();
  if (db) {
    const docRef = db.collection('wallets').doc(userKey);
    await docRef.set({ telegram_id: tgId }, { merge: true });
  } else {
    memoryStore.set(`tgid:${userKey}`, tgId);
  }
}

async function notifyPaymentReceived(userKey, amountSats, newBalance, senderInfo = "") {
  if (!BOT_TOKEN) return;

  let chatId = null;
  if (/^user\d+$/i.test(userKey)) {
    chatId = userKey.replace(/^user/i, "");
  } else if (db) {
    try {
      const doc = await db.collection('wallets').doc(userKey).get();
      if (doc.exists && doc.data()?.telegram_id) {
        chatId = doc.data().telegram_id;
      }
    } catch (e) {}
  } else {
    chatId = memoryStore.get(`tgid:${userKey}`);
  }

  if (!chatId) return;

  try {
    const fromText = senderInfo ? ` from <b>${senderInfo}</b>` : "";
    const text = 
      `🎉 <b>Payment Received!</b>\n\n` +
      `⚡ <b>+${Number(amountSats).toLocaleString()} sats</b> credited to your wallet${fromText}!\n` +
      `💰 <b>New Balance:</b> <code>${Number(newBalance).toLocaleString()} sats</code>`;

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: "HTML"
      })
    });
  } catch (err) {
    console.error("[Notify] Error sending Telegram message:", err.message);
  }
}

async function getBalance(userKey) {
  if (db) {
    const doc = await db.collection('wallets').doc(userKey).get();
    if (!doc.exists) return 0;
    return Number(doc.data().balance || 0);
  }
  return Number(memoryStore.get(`bal:${userKey}`) || 0);
}

// Atomic claim & credit
async function claimPaymentAndCredit(paymentId, userKey, amountSats) {
  const sats = Math.floor(Number(amountSats));
  if (sats <= 0 || !paymentId) {
    return { success: false, reason: "Invalid amount or payment ID" };
  }

  const pId = String(paymentId).trim();

  if (db) {
    const paymentDocRef = db.collection('processed_payments').doc(pId);
    const walletDocRef = db.collection('wallets').doc(userKey);

    return await db.runTransaction(async (transaction) => {
      const paymentDoc = await transaction.get(paymentDocRef);
      if (paymentDoc.exists) {
        return { success: true, alreadyProcessed: true };
      }

      const walletDoc = await transaction.get(walletDocRef);
      const currentBal = walletDoc.exists ? Number(walletDoc.data().balance || 0) : 0;
      const newBal = currentBal + sats;

      transaction.set(paymentDocRef, {
        payment_id: pId,
        user_key: userKey,
        amount: sats,
        processed_at: admin.firestore.FieldValue.serverTimestamp()
      });

      transaction.set(walletDocRef, {
        user_key: userKey,
        balance: newBal,
        updated_at: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      return { success: true, alreadyProcessed: false, newBalance: newBal };
    });
  }

  if (memoryStore.has(`processed:${pId}`)) {
    return { success: true, alreadyProcessed: true };
  }
  memoryStore.set(`processed:${pId}`, true);

  const current = Number(memoryStore.get(`bal:${userKey}`) || 0);
  const updated = current + sats;
  memoryStore.set(`bal:${userKey}`, updated);
  return { success: true, alreadyProcessed: false, newBalance: updated };
}

// Add/refund balance helper
async function addBalance(userKey, amount) {
  const sats = Math.floor(Number(amount));
  if (sats <= 0) return await getBalance(userKey);
  const transId = `add_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const res = await claimPaymentAndCredit(transId, userKey, sats);
  return res.newBalance || (await getBalance(userKey));
}

// Deduct balance
async function deductBalance(userKey, amount) {
  const sats = Math.floor(Number(amount));
  if (sats <= 0) return await getBalance(userKey);

  if (db) {
    const docRef = db.collection('wallets').doc(userKey);

    return await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      const current = doc.exists ? Number(doc.data().balance || 0) : 0;

      if (current < sats) {
        throw new Error(`Insufficient balance: You have ${current} sats, tried to spend ${sats} sats`);
      }

      const updated = current - sats;
      transaction.set(docRef, {
        user_key: userKey,
        balance: updated,
        updated_at: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      return updated;
    });
  }

  const current = Number(memoryStore.get(`bal:${userKey}`) || 0);
  if (current < sats) {
    throw new Error(`Insufficient balance: You have ${current} sats, tried to spend ${sats} sats`);
  }
  const updated = current - sats;
  memoryStore.set(`bal:${userKey}`, updated);
  return updated;
}

// Internal zero-fee transfer between two bot users
async function internalTransfer(fromUserKey, toUserKey, amountSats) {
  const sats = Math.floor(Number(amountSats));
  if (sats <= 0) throw new Error("Invalid transfer amount.");
  if (fromUserKey === toUserKey) throw new Error("You cannot send sats to yourself.");

  if (db) {
    const fromRef = db.collection('wallets').doc(fromUserKey);
    const toRef = db.collection('wallets').doc(toUserKey);

    return await db.runTransaction(async (transaction) => {
      const fromDoc = await transaction.get(fromRef);
      const currentFromBal = fromDoc.exists ? Number(fromDoc.data().balance || 0) : 0;

      if (currentFromBal < sats) {
        throw new Error(`Insufficient balance: You have ${currentFromBal} sats, needed ${sats} sats.`);
      }

      const toDoc = await transaction.get(toRef);
      const currentToBal = toDoc.exists ? Number(toDoc.data().balance || 0) : 0;

      const newFromBal = currentFromBal - sats;
      const newToBal = currentToBal + sats;

      transaction.set(fromRef, {
        user_key: fromUserKey,
        balance: newFromBal,
        updated_at: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      transaction.set(toRef, {
        user_key: toUserKey,
        balance: newToBal,
        updated_at: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      return { newFromBal, newToBal };
    });
  }

  const currentFromBal = Number(memoryStore.get(`bal:${fromUserKey}`) || 0);
  if (currentFromBal < sats) throw new Error(`Insufficient balance.`);
  const currentToBal = Number(memoryStore.get(`bal:${toUserKey}`) || 0);
  memoryStore.set(`bal:${fromUserKey}`, currentFromBal - sats);
  memoryStore.set(`bal:${toUserKey}`, currentToBal + sats);
  return { newFromBal: currentFromBal - sats, newToBal: currentToBal + sats };
}

// Track pending deposits created via Lightning Address
async function savePendingDeposit(paymentId, userKey, sats) {
  if (db) {
    await db.collection('pending_deposits').doc(paymentId).set({
      payment_id: paymentId,
      user_key: userKey,
      amount: Number(sats),
      created_at: Date.now()
    });
  } else {
    memoryStore.set(`pending:${paymentId}`, { user_key: userKey, amount: sats });
  }
}

// Check pending deposits for a user
async function checkPendingDeposits(userKey, speedRequestFunc) {
  if (!db) return;
  try {
    const snapshot = await db.collection('pending_deposits')
      .where('user_key', '==', userKey)
      .limit(5)
      .get();

    if (snapshot.empty) return;

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const pId = data.payment_id;
      const sats = Number(data.amount);

      try {
        const check = await speedRequestFunc(`payments/${pId}`, "GET");
        const st = (check.status || "").toLowerCase();

        if (st === "succeeded" || st === "paid") {
          const res = await claimPaymentAndCredit(pId, userKey, sats);
          if (!res.alreadyProcessed) {
            await notifyPaymentReceived(userKey, sats, res.newBalance);
          }
          await doc.ref.delete();
        } else if (st === "expired" || st === "canceled" || st === "failed") {
          await doc.ref.delete();
        }
      } catch (err) {}
    }
  } catch (err) {}
}

module.exports = {
  normalizeUserKey,
  saveUserTelegramId,
  notifyPaymentReceived,
  getBalance,
  addBalance,
  claimPaymentAndCredit,
  deductBalance,
  internalTransfer,
  savePendingDeposit,
  checkPendingDeposits
};
