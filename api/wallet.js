// api/wallet.js
const SPEED_API_KEY = process.env.SPEED_API_KEY;

function getAuthHeader() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${Buffer.from(SPEED_API_KEY + ':').toString('base64')}`
  };
}

// Calculates isolated balance for a specific user directly from Speed's records
async function calculateUserBalance(userId, username) {
  const cleanId = String(userId || '').trim().toLowerCase();
  const cleanUser = String(username || '').trim().toLowerCase();

  // Fetch recent payments from Speed (up to 100)
  const res = await fetch('https://api.tryspeed.com/v1/payments?limit=100', {
    headers: getAuthHeader()
  });
  const json = await res.json();

  if (!res.ok || !Array.isArray(json.data)) {
    return 0;
  }

  let totalDeposits = 0;
  let totalWithdrawals = 0;

  for (const p of json.data) {
    const isPaid = p.status === 'paid' || p.status === 'successful';
    if (!isPaid) continue;

    const meta = p.metadata || {};
    const metaUser = String(meta.user_id || '').toLowerCase();
    const metaUsername = String(meta.username || '').toLowerCase();

    // Check if this payment belongs to this user
    const belongsToUser =
      (cleanId && (metaUser === cleanId || metaUsername === cleanId)) ||
      (cleanUser && (metaUser === cleanUser || metaUsername === cleanUser));

    if (belongsToUser) {
      const amt = Number(p.amount || 0);
      if (meta.type === 'withdrawal') {
        totalWithdrawals += amt;
      } else {
        // Default to deposit/incoming
        totalDeposits += amt;
      }
    }
  }

  const balance = totalDeposits - totalWithdrawals;
  return Math.max(0, balance);
}

export default async function handler(req, res) {
  const { action } = req.query;

  try {
    // -----------------------------------------------------------------
    // 1. BALANCE: Isolated per user
    // -----------------------------------------------------------------
    if (action === 'balance') {
      const { user_id, username } = req.query;
      if (!user_id && !username) {
        return res.status(200).json({ success: true, balance: 0 });
      }

      const balance = await calculateUserBalance(user_id, username);
      return res.status(200).json({ success: true, balance });
    }

    // -----------------------------------------------------------------
    // 2. CREATE DEPOSIT INVOICE (Tagged with user_id)
    // -----------------------------------------------------------------
    if (action === 'create-payment' && req.method === 'POST') {
      const { amount, user_id, username } = req.body;
      const sats = Math.floor(Number(amount));

      if (!sats || sats <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid satoshi amount' });
      }

      const speedRes = await fetch('https://api.tryspeed.com/v1/payments', {
        method: 'POST',
        headers: getAuthHeader(),
        body: JSON.stringify({
          amount: sats,
          currency: 'SATS',
          target_currency: 'SATS',
          description: `Deposit by @${username || user_id}`,
          metadata: {
            user_id: String(user_id || username),
            username: String(username || ''),
            type: 'deposit'
          }
        })
      });

      const data = await speedRes.json();
      if (!speedRes.ok || data.error) {
        return res.status(400).json({ success: false, error: data.error?.message || 'Invoice failed' });
      }

      const invoice =
        data.payment_request ||
        data.lightning_invoice ||
        data.invoice ||
        (data.payment_method_details?.lightning?.payment_request);

      return res.status(200).json({
        success: true,
        id: data.id,
        invoice: invoice
      });
    }

    // -----------------------------------------------------------------
    // 3. CHECK STATUS OF INVOICE
    // -----------------------------------------------------------------
    if (action === 'check-status') {
      const { payment_id } = req.query;
      if (!payment_id) return res.status(400).json({ error: 'Missing payment_id' });

      const speedRes = await fetch(`https://api.tryspeed.com/v1/payments/${payment_id}`, {
        headers: getAuthHeader()
      });
      const data = await speedRes.json();
      const isPaid = data.status === 'paid' || data.status === 'successful';

      return res.status(200).json({ success: true, is_paid: Boolean(isPaid) });
    }

    // -----------------------------------------------------------------
    // 4. SEND SATS: Protected by user's individual balance
    // -----------------------------------------------------------------
    if (action === 'send' && req.method === 'POST') {
      const { destination, amount, user_id, username } = req.body;
      const sats = Math.floor(Number(amount));

      if (!destination || !sats || sats <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid destination or amount' });
      }

      // Check this specific user's balance
      const userBalance = await calculateUserBalance(user_id, username);

      if (userBalance < sats) {
        return res.status(400).json({
          success: false,
          error: `Insufficient user balance. You have ${userBalance} sats, trying to send ${sats} sats.`
        });
      }

      // Execute withdrawal
      const sendRes = await fetch('https://api.tryspeed.com/v1/payments/send', {
        method: 'POST',
        headers: getAuthHeader(),
        body: JSON.stringify({
          destination: destination,
          amount: sats,
          currency: 'SATS',
          metadata: {
            user_id: String(user_id || username),
            username: String(username || ''),
            type: 'withdrawal'
          }
        })
      });

      const sendData = await sendRes.json();
      if (!sendRes.ok || sendData.error) {
        return res.status(400).json({
          success: false,
          error: sendData.error?.message || 'Payment broadcast failed'
        });
      }

      return res.status(200).json({ success: true, payment: sendData });
    }

    return res.status(404).json({ error: 'Action not found' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
