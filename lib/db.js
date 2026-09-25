// lib/db.js
const admin = require('firebase-admin');

let db = null;
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();

// Initialize Firebase Admin SDK
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

// Fallback in-memory map for local testing
const memoryStore = globalThis._walletMemoryStore || new Map();
globalThis._walletMemoryStore = memoryStore;

// Standardize user key across all channels
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

// Associate Telegram Chat ID with userKey for push notifications
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

// Send Instant Telegram Notification to user
async function notifyPaymentReceived(userKey, amountSats, newBalance) {
  if (!BOT_TOKEN) return;

  let chatId = null;

  // 1. Direct if userKey is user<id>
  if (/^user\d+$/i.test(userKey)) {
    chatId = userKey.replace(/^user/i, "");
  } else if (db) {
    // 2. Lookup telegram_id from Firestore document
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
    const text = 
      `🎉 <b>Payment Received!</b>\n\n` +
      `⚡ <b>+${Number(amountSats).toLocaleString()} sats</b> credited to your wallet!\n` +
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
    console.error("Failed to send Telegram notification:", err.message);
  }
}

// 1. Get Balance
async function getBalance(userKey) {
  if (db) {
    const doc = await db.collection('wallets').doc(userKey).get();
    if (!doc.exists) return 0;
    return Number(doc.data().balance || 0);
  }
  return Number(memoryStore.get(`bal:${userKey}`) || 0);
}

// 2. Add Satoshis
async function addBalance(userKey, amount) {
  const sats = Math.floor(Number(amount));
  if (sats <= 0) return await getBalance(userKey);

  if (db) {
    const docRef = db.collection('wallets').doc(userKey);
    await docRef.set({
      user_key: userKey,
      balance: admin.firestore.FieldValue.increment(sats),
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    const newBal = await getBalance(userKey);
    await notifyPaymentReceived(userKey, sats, newBal);
    return newBal;
  }

  const current = Number(memoryStore.get(`bal:${userKey}`) || 0);
  const updated = current + sats;
  memoryStore.set(`bal:${userKey}`, updated);
  await notifyPaymentReceived(userKey, sats, updated);
  return updated;
}

// 3. Deduct Satoshis (Atomic transaction to prevent overdraft)
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

// 4. Double-spend prevention
async function isPaymentProcessed(paymentId) {
  if (db) {
    const doc = await db.collection('processed_payments').doc(String(paymentId)).get();
    return doc.exists;
  }
  return memoryStore.has(`processed:${paymentId}`);
}

// 5. Mark payment as processed
async function markPaymentProcessed(paymentId) {
  if (db) {
    await db.collection('processed_payments').doc(String(paymentId)).set({
      payment_id: String(paymentId),
      processed_at: admin.firestore.FieldValue.serverTimestamp()
    });
    return;
  }
  memoryStore.set(`processed:${paymentId}`, true);
}

module.exports = {
  normalizeUserKey,
  saveUserTelegramId,
  notifyPaymentReceived,
  getBalance,
  addBalance,
  deductBalance,
  isPaymentProcessed,
  markPaymentProcessed
};
