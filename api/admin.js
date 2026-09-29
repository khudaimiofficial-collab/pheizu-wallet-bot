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
const MASTER_ADMIN_ID = "8960497898";
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;

function formatChannelId(raw) {
  if (!raw) return "";
  let clean = String(raw).trim();
  if (/^\d{8,16}$/.test(clean)) {
    clean = `-100${clean}`;
  } else if (/^-\d{8,16}$/.test(clean) && !clean.startsWith("-100")) {
    clean = `-100${clean.replace(/^-/, "")}`;
  }
  return clean;
}

async function isAuthorizedAdmin(telegramId, username) {
  const numId = String(telegramId || "").trim();
  const uname = String(username || "").toLowerCase().replace(/^@/, "").trim();
  if (numId === MASTER_ADMIN_ID || uname === "pheizu") return true;

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

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (!db) return res.status(500).json({ success: false, error: "Firebase unavailable." });

  const { action } = req.query;

  try {
    // 1. GET ALL DASHBOARD DATA (Users, Treasury, Config)
    if (action === "get-data" && req.method === "GET") {
      const { telegram_id, username } = req.query;
      if (!(await isAuthorizedAdmin(telegram_id, username))) {
        return res.status(403).json({ success: false, error: "Unauthorized access." });
      }

      let speedKey = "";
      let logsChannel = "";
      let adminsList = [];
      let treasuryData = { earned_sats: 0, earned_usdt: 0, earned_usdc: 0 };

      try {
        const cfgSnap = await db.collection("settings").doc("config").get();
        if (cfgSnap.exists) {
          speedKey = cfgSnap.data().speed_key || "";
          logsChannel = cfgSnap.data().logs_channel || "";
        }
        if (!speedKey) {
          const spSnap = await db.collection("settings").doc("speed").get();
          if (spSnap.exists) speedKey = spSnap.data().api_key || "";
        }
        if (!logsChannel) {
          const chSnap = await db.collection("settings").doc("logs_channel").get();
          if (chSnap.exists) logsChannel = chSnap.data().channel_id || "";
        }
        const admSnap = await db.collection("settings").doc("admins").get();
        if (admSnap.exists && Array.isArray(admSnap.data().list)) adminsList = admSnap.data().list;

        const trSnap = await db.collection("settings").doc("admin_treasury").get();
        if (trSnap.exists) treasuryData = trSnap.data();
      } catch (e) {}

      const userMap = new Map();

      const usersSnap = await db.collection("users").get();
      usersSnap.forEach(d => {
        const u = d.data();
        userMap.set(d.id, {
          user_id: d.id,
          username: u.username || "",
          telegram_id: u.telegram_id || "",
          first_name: u.first_name || "",
          banned: Boolean(u.banned),
          sats: Number(u.balance ?? u.sats ?? u.amount ?? 0),
          usdt: Number(u.usdt_balance ?? u.usdt ?? 0),
          usdc: Number(u.usdc_balance ?? u.usdc ?? 0),
          created_at: u.created_at || ""
        });
      });

      const walletsSnap = await db.collection("wallets").get();
      walletsSnap.forEach(d => {
        const w = d.data();
        if (userMap.has(d.id)) {
          const exist = userMap.get(d.id);
          exist.sats = Math.max(exist.sats, Number(w.balance ?? w.sats ?? w.amount ?? 0));
          exist.usdt = Math.max(exist.usdt, Number(w.usdt_balance ?? w.usdt ?? 0));
          exist.usdc = Math.max(exist.usdc, Number(w.usdc_balance ?? w.usdc ?? 0));
          exist.banned = exist.banned || Boolean(w.banned);
        } else {
          userMap.set(d.id, {
            user_id: d.id,
            username: w.username || d.id,
            telegram_id: w.telegram_id || "",
            first_name: w.first_name || "",
            banned: Boolean(w.banned),
            sats: Number(w.balance ?? w.sats ?? w.amount ?? 0),
            usdt: Number(w.usdt_balance ?? w.usdt ?? 0),
            usdc: Number(w.usdc_balance ?? w.usdc ?? 0),
            created_at: w.created_at || ""
          });
        }
      });

      const usersList = Array.from(userMap.values());

      return res.status(200).json({
        success: true,
        users: usersList,
        speed_key: speedKey,
        logs_channel: logsChannel,
        admins_list: adminsList,
        treasury: treasuryData
      });
    }

    // 2. BROADCAST TO ALL USERS
    if (action === "broadcast" && req.method === "POST") {
      const { text, telegram_id, username } = req.body;
      if (!(await isAuthorizedAdmin(telegram_id, username))) {
        return res.status(403).json({ success: false, error: "Unauthorized." });
      }
      if (!text || !text.trim()) {
        return res.status(400).json({ success: false, error: "Message text is required." });
      }
      if (!BOT_TOKEN) return res.status(500).json({ success: false, error: "BOT_TOKEN not configured." });

      const recipientIds = new Set();
      const uSnap = await db.collection("users").get();
      uSnap.forEach(doc => {
        const d = doc.data();
        if (!d.banned && d.telegram_id && /^\d+$/.test(String(d.telegram_id))) {
          recipientIds.add(String(d.telegram_id));
        }
      });

      const wSnap = await db.collection("wallets").get();
      wSnap.forEach(doc => {
        const d = doc.data();
        if (!d.banned && d.telegram_id && /^\d+$/.test(String(d.telegram_id))) {
          recipientIds.add(String(d.telegram_id));
        }
      });

      let sent = 0;
      let failed = 0;

      for (const tId of recipientIds) {
        try {
          const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: tId, text: text, parse_mode: "HTML" })
          });
          const bData = await resp.json();
          if (bData.ok) sent++;
          else failed++;
        } catch(e) {
          failed++;
        }
      }

      return res.status(200).json({ success: true, sent, failed, total: sent + failed });
    }

    // 3. SAVE SPEED API KEY
    if (action === "save-key" && req.method === "POST") {
      const { api_key, telegram_id, username } = req.body;
      if (!(await isAuthorizedAdmin(telegram_id, username))) {
        return res.status(403).json({ success: false, error: "Unauthorized." });
      }
      if (!api_key) return res.status(400).json({ success: false, error: "API key is required." });

      const clean = api_key.trim();
      await db.collection("settings").doc("config").set({ speed_key: clean }, { merge: true });
      await db.collection("settings").doc("speed").set({ api_key: clean }, { merge: true });
      return res.status(200).json({ success: true });
    }

    // 4. SAVE AND LIVE-PING LOGS CHANNEL
    if (action === "save-channel" && req.method === "POST") {
      const { channel_id, telegram_id, username } = req.body;
      if (!(await isAuthorizedAdmin(telegram_id, username))) {
        return res.status(403).json({ success: false, error: "Unauthorized." });
      }
      if (!channel_id) return res.status(400).json({ success: false, error: "Channel ID required." });

      const chId = formatChannelId(channel_id);

      if (!BOT_TOKEN) return res.status(500).json({ success: false, error: "BOT_TOKEN not set on server." });

      const pingRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chId,
          text: `⚡ <b>Pheizu Logs Channel Connected Successfully!</b>\n\n` +
                `• Connected by: @${username || telegram_id}\n` +
                `• Channel ID: <code>${chId}</code>\n` +
                `• Time: ${new Date().toUTCString()}`,
          parse_mode: "HTML"
        })
      });

      const pingData = await pingRes.json();
      if (!pingData.ok) {
        return res.status(400).json({
          success: false,
          error: `Telegram Error: ${pingData.description}. Ensure the bot is an Administrator with "Post Messages" permission in ${chId}.`
        });
      }

      await db.collection("settings").doc("config").set({ logs_channel: chId }, { merge: true });
      await db.collection("settings").doc("logs_channel").set({ channel_id: chId }, { merge: true });
      return res.status(200).json({ success: true, channel_id: chId });
    }

    // 5. MANAGE USER (BAN, UNBAN, CLEAN RESET DELETE)
    if (action === "manage-user" && req.method === "POST") {
      const { target_user, task, telegram_id, username } = req.body;
      if (!(await isAuthorizedAdmin(telegram_id, username))) {
        return res.status(403).json({ success: false, error: "Unauthorized." });
      }
      const target = String(target_user).toLowerCase().replace(/^@/, "");

      if (task === "ban") {
        await db.collection("users").doc(target).set({ banned: true }, { merge: true });
        await db.collection("wallets").doc(target).set({ banned: true }, { merge: true });
      } else if (task === "unban") {
        await db.collection("users").doc(target).set({ banned: false }, { merge: true });
        await db.collection("wallets").doc(target).set({ banned: false }, { merge: true });
      } else if (task === "delete") {
        await db.collection("users").doc(target).delete();
        await db.collection("wallets").doc(target).delete();

        const tgMatch = target.match(/\d+/);
        if (tgMatch) {
          await db.collection("users").doc(`user${tgMatch[0]}`).delete().catch(() => {});
          await db.collection("wallets").doc(`user${tgMatch[0]}`).delete().catch(() => {});
        }
      }

      return res.status(200).json({ success: true });
    }

    // 6. ADJUST BALANCE
    if (action === "adjust-balance" && req.method === "POST") {
      const { target_user, asset, amount, type, telegram_id, username } = req.body;
      if (!(await isAuthorizedAdmin(telegram_id, username))) {
        return res.status(403).json({ success: false, error: "Unauthorized." });
      }
      const numAmt = Number(amount);
      if (!numAmt || numAmt <= 0) return res.status(400).json({ success: false, error: "Invalid amount." });

      const delta = type === "deduct" ? -numAmt : numAmt;
      const target = String(target_user).toLowerCase().replace(/^@/, "");

      const field = asset === "USDT" ? "usdt_balance" : (asset === "USDC" ? "usdc_balance" : "balance");
      const altField = asset === "USDT" ? "usdt" : (asset === "USDC" ? "usdc" : "sats");

      await db.collection("users").doc(target).set({
        [field]: admin.firestore.FieldValue.increment(delta),
        [altField]: admin.firestore.FieldValue.increment(delta)
      }, { merge: true });

      await db.collection("wallets").doc(target).set({
        [field]: admin.firestore.FieldValue.increment(delta),
        [altField]: admin.firestore.FieldValue.increment(delta)
      }, { merge: true });

      return res.status(200).json({ success: true, delta });
    }

    // 7. MANAGE CO-ADMINS
    if (action === "manage-admin" && req.method === "POST") {
      const { task, target_admin, telegram_id, username } = req.body;
      if (!(await isAuthorizedAdmin(telegram_id, username))) {
        return res.status(403).json({ success: false, error: "Unauthorized." });
      }
      const cleanTarget = String(target_admin).trim().toLowerCase().replace(/^@/, "");

      if (task === "add") {
        await db.collection("settings").doc("admins").set({
          list: admin.firestore.FieldValue.arrayUnion(cleanTarget)
        }, { merge: true });
      } else if (task === "remove") {
        await db.collection("settings").doc("admins").set({
          list: admin.firestore.FieldValue.arrayRemove(cleanTarget)
        }, { merge: true });
      }

      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, error: "Invalid admin action." });
  } catch (err) {
    console.error("Admin API Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
