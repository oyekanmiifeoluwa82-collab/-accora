const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;

function json(res, status, body) {
  return res.status(status).json(body);
}

async function supabase(path, options = {}) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization:
          `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    }
  );

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      data?.message ||
      data?.hint ||
      text ||
      "Supabase request failed"
    );
  }

  return data;
}

async function verifyFlutterwave(txRef) {
  const response = await fetch(
    `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`,
    {
      headers: {
        Authorization:
          `Bearer ${FLW_SECRET_KEY}`
      }
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.message ||
      "Flutterwave verification failed"
    );
  }

  return data;
}

function makeReference() {
  return (
    "ACC-WALLET-" +
    Date.now() +
    "-" +
    crypto
      .randomBytes(3)
      .toString("hex")
      .toUpperCase()
  );
}

module.exports = async function handler(req, res) {

  if (req.method !== "POST") {
    return json(res, 405, {
      success: false,
      error: "Method not allowed"
    });
  }

  if (
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY ||
    !FLW_SECRET_KEY
  ) {
    return json(res, 500, {
      success: false,
      error:
        "Wallet server configuration is incomplete."
    });
  }

  try {

    const {
      action,
      user_id,
      tx_ref,
      amount,
      currency = "NGN"
    } = req.body || {};

    if (!action || !user_id) {
      return json(res, 400, {
        success: false,
        error:
          "Missing wallet action or user ID."
      });
    }

    /*
      GET WALLET BALANCE
    */

    if (action === "balance") {

      const rows = await supabase(
        `wallets?user_id=eq.${encodeURIComponent(user_id)}&select=user_id,balance,updated_at`
      );

      const wallet =
        Array.isArray(rows) && rows.length
          ? rows[0]
          : null;

      if (!wallet) {

        await supabase("wallets", {
          method: "POST",
          headers: {
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            user_id,
            balance: 0
          })
        });

        return json(res, 200, {
          success: true,
          balance: 0
        });
      }

      return json(res, 200, {
        success: true,
        balance:
          Number(wallet.balance) || 0
      });
    }

    /*
      WALLET TRANSACTION HISTORY
    */

    if (action === "transactions") {

      const rows = await supabase(
        `wallet_transactions?user_id=eq.${encodeURIComponent(user_id)}&select=*&order=created_at.desc&limit=100`
      );

      return json(res, 200, {
        success: true,
        transactions: rows || []
      });
    }

    /*
      CREATE WALLET TOP-UP
    */

    if (action === "create_topup") {

      const numericAmount =
        Number(amount);

      if (
        !Number.isFinite(numericAmount) ||
        numericAmount < 100
      ) {
        return json(res, 400, {
          success: false,
          error:
            "Minimum wallet top-up is ₦100."
        });
      }

      const reference =
        tx_ref || makeReference();

      await supabase("wallet_topups", {
        method: "POST",
        headers: {
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          user_id,
          tx_ref: reference,
          amount: numericAmount,
          status: "pending"
        })
      });

      return json(res, 200, {
        success: true,
        tx_ref: reference,
        amount: numericAmount
      });
    }

    /*
      VERIFY WALLET TOP-UP
    */

    if (action === "verify_topup") {

      if (!tx_ref) {
        return json(res, 400, {
          success: false,
          error:
            "Missing transaction reference."
        });
      }

      const verification =
        await verifyFlutterwave(tx_ref);

      const payment =
        verification?.data;

      if (!payment) {
        return json(res, 400, {
          success: false,
          error:
            "No payment data returned."
        });
      }

      if (
        payment.status !== "successful" ||
        String(payment.currency)
          .toUpperCase() !==
          String(currency).toUpperCase()
      ) {

        return json(res, 400, {
          success: false,
          error:
            "Wallet payment was not successful."
        });
      }

      const topups =
        await supabase(
          `wallet_topups?tx_ref=eq.${encodeURIComponent(tx_ref)}&user_id=eq.${encodeURIComponent(user_id)}&select=*`
        );

      if (!topups?.length) {
        return json(res, 404, {
          success: false,
          error:
            "Wallet top-up was not found."
        });
      }

      const topup = topups[0];

      if (topup.status === "successful") {

        const existing =
          await supabase(
            `wallets?user_id=eq.${encodeURIComponent(user_id)}&select=balance`
          );

        return json(res, 200, {
          success: true,
          balance:
            Number(existing?.[0]?.balance || 0)
        });
      }

      const expected =
        Number(topup.amount);

      const paid =
        Number(payment.amount);

      if (paid < expected) {
        return json(res, 400, {
          success: false,
          error:
            "Paid amount is less than the wallet top-up."
        });
      }

      const wallets =
        await supabase(
          `wallets?user_id=eq.${encodeURIComponent(user_id)}&select=balance`
        );

      let oldBalance =
        Number(wallets?.[0]?.balance || 0);

      const newBalance =
        oldBalance + expected;

      if (!wallets?.length) {

        await supabase("wallets", {
          method: "POST",
          body: JSON.stringify({
            user_id,
            balance: newBalance
          })
        });

      } else {

        await supabase(
          `wallets?user_id=eq.${encodeURIComponent(user_id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              balance: newBalance,
              updated_at:
                new Date().toISOString()
            })
          }
        );
      }

      await supabase(
        `wallet_topups?id=eq.${encodeURIComponent(topup.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            status: "successful",
            flutterwave_id:
              String(payment.id || ""),
            completed_at:
              new Date().toISOString()
          })
        }
      );

      await supabase(
        "wallet_transactions",
        {
          method: "POST",
          body: JSON.stringify({
            user_id,
            type: "credit",
            amount: expected,
            balance_after: newBalance,
            reference: tx_ref,
            description:
              "Wallet top-up via Flutterwave"
          })
        }
      );

      return json(res, 200, {
        success: true,
        balance: newBalance,
        amount: expected
      });
    }

    return json(res, 400, {
      success: false,
      error:
        "Unknown wallet action."
    });

  } catch (error) {

    console.error(
      "Wallet API error:",
      error
    );

    return json(res, 500, {
      success: false,
      error:
        "Wallet request failed."
    });
  }
};
