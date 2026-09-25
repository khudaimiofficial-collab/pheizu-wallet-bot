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

async function notifyPaymentReceived(userKey, amountSats, newBalance) {
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

async function getBalance(userKey) {
  if (db) {
    const doc = await db.collection('wallets').doc(userKey).get();
    if (!doc.exists) return 0;
    return Number(doc.data().balance || 0);
  }
  return Number(memoryStore.get(`bal:${userKey}`) || 0);
}

/**
 * ATOMIC CLAIM & CREDIT:
 * Guarantees a payment ID is credited EXACTLY ONCE, even under high concurrency.
 * Returns { success: true, alreadyProcessed: false, newBalance } on first claim.
 * Returns { success: true, alreadyProcessed: true } if duplicate.
 */
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
      // Read payment record first
      const paymentDoc = await transaction.get(paymentDocRef);
      if (paymentDoc.exists) {
        // ALREADY PROCESSED - Exit immediately!
        return { success: true, alreadyProcessed: true };
      }

      // Read current balance
      const walletDoc = await transaction.get(walletDocRef);
      const currentBal = walletDoc.exists ? Number(walletDoc.data().balance || 0) : 0;
      const newBal = currentBal + sats;

      // Write both atomically
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

  // Fallback for memory store
  if (memoryStore.has(`processed:${pId}`)) {
    return { success: true, alreadyProcessed: true };
  }
  memoryStore.set(`processed:${pId}`, true);

  const current = Number(memoryStore.get(`bal:${userKey}`) || 0);
  const updated = current + sats;
  memoryStore.set(`bal:${userKey}`, updated);
  return { success: true, alreadyProcessed: false, newBalance: updated };
}

// Deduct balance with overdraft protection
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

module.exports = {
  normalizeUserKey,
  saveUserTelegramId,
  notifyPaymentReceived,
  getBalance,
  claimPaymentAndCredit,
  deductBalance
};
