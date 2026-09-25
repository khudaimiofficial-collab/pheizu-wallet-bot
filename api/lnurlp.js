// api/lnurlp.js

const SPEED_API_KEY = process.env.SPEED_API_KEY;

function getAuthHeader() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${Buffer.from(SPEED_API_KEY + ':').toString('base64')}`
  };
}

export default async function handler(req, res) {
  const { username, callback, amount } = req.query;
  const user = (username || '').toLowerCase().trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'pheizu-wallet-bot.vercel.app';
  const protocol = req.headers['x-forwarded-proto'] || 'https';

  if (!user) {
    return res.status(400).json({ status: 'ERROR', reason: 'Missing username in request' });
  }

  const metadata = JSON.stringify([
    ["text/plain", `Pay to ${user}@${host}`],
    ["text/identifier", `${user}@${host}`]
  ]);

  // -------------------------------------------------------------
  // STEP 1: LNURL-pay Discovery Request (Returns min/max & callback)
  // -------------------------------------------------------------
  if (!callback) {
    return res.status(200).json({
      tag: 'payRequest',
      callback: `${protocol}://${host}/api/lnurlp/cb/${user}`,
      maxSendable: 100000000, // 100,000 sats (in millisatoshis)
      minSendable: 1000,      // 1 sat (in millisatoshis)
      metadata: metadata,
      commentAllowed: 32
    });
  }

  // -------------------------------------------------------------
  // STEP 2: LNURL-pay Callback (Sender specifies amount)
  // -------------------------------------------------------------
  const millisats = Number(amount);
  if (!millisats || millisats < 1000) {
    return res.status(400).json({ status: 'ERROR', reason: 'Amount must be at least 1000 msats (1 sat)' });
  }

  const sats = Math.floor(millisats / 1000);

  try {
    // Generate Speed Lightning invoice tagged with the user's username
    const speedRes = await fetch('https://api.tryspeed.com/v1/payments', {
      method: 'POST',
      headers: getAuthHeader(),
      body: JSON.stringify({
        amount: sats,
        currency: 'SATS',
        target_currency: 'SATS',
        description: `Deposit to ${user}@${host}`,
        metadata: {
          user_id: user,
          username: user,
          type: 'deposit'
        }
      })
    });

    const data = await speedRes.json();

    if (!speedRes.ok || data.error) {
      return res.status(500).json({
        status: 'ERROR',
        reason: data.error?.message || 'Failed to generate invoice with Lightning provider'
      });
    }

    const pr =
      data.payment_request ||
      data.lightning_invoice ||
      data.invoice ||
      (data.payment_method_details?.lightning?.payment_request);

    if (!pr) {
      return res.status(500).json({ status: 'ERROR', reason: 'No invoice returned from provider' });
    }

    // Return LNURL-compliant response containing the bolt11 invoice
    return res.status(200).json({
      pr: pr,
      routes: []
    });
  } catch (err) {
    return res.status(500).json({ status: 'ERROR', reason: err.message });
  }
}
