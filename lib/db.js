// lib/db.js
// Supports Vercel KV / Upstash Redis if environment variables are set,
// and gracefully falls back to an in-memory Map for local testing.

let redisClient = null;

if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  try {
    const { Redis } = require('@upstash/redis');
    redisClient = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  } catch (err) {
    console.warn("Redis client failed to initialize, using memory fallback.", err.message);
  }
}

// Memory fallback for development
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

async function getBalance(userKey) {
  const key = `bal:${userKey}`;
  if (redisClient) {
    const val = await redisClient.get(key);
    return Number(val || 0);
  }
  return Number(memoryStore.get(key) || 0);
}

async function addBalance(userKey, amount) {
  const sats = Math.floor(Number(amount));
  if (sats <= 0) return await getBalance(userKey);
  const key = `bal:${userKey}`;
  if (redisClient) {
    const newBal = await redisClient.incrby(key, sats);
    return Number(newBal);
  }
  const current = Number(memoryStore.get(key) || 0);
  const updated = current + sats;
  memoryStore.set(key, updated);
  return updated;
}

async function deductBalance(userKey, amount) {
  const sats = Math.floor(Number(amount));
  if (sats <= 0) return await getBalance(userKey);
  const key = `bal:${userKey}`;
  if (redisClient) {
    const current = Number((await redisClient.get(key)) || 0);
    if (current < sats) {
      throw new Error(`Insufficient balance: You have ${current} sats, tried to spend ${sats} sats`);
    }
    const newBal = await redisClient.decrby(key, sats);
    return Number(newBal);
  }
  const current = Number(memoryStore.get(key) || 0);
  if (current < sats) {
    throw new Error(`Insufficient balance: You have ${current} sats, tried to spend ${sats} sats`);
  }
  const updated = current - sats;
  memoryStore.set(key, updated);
  return updated;
}

async function isPaymentProcessed(paymentId) {
  const key = `processed:${paymentId}`;
  if (redisClient) {
    const exists = await redisClient.get(key);
    return !!exists;
  }
  return memoryStore.has(key);
}

async function markPaymentProcessed(paymentId) {
  const key = `processed:${paymentId}`;
  if (redisClient) {
    await redisClient.set(key, "1", { ex: 86400 * 7 }); // Keep for 7 days
    return;
  }
  memoryStore.set(key, true);
}

module.exports = {
  normalizeUserKey,
  getBalance,
  addBalance,
  deductBalance,
  isPaymentProcessed,
  markPaymentProcessed
};
