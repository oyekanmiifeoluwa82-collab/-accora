export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { tx_ref, expected_amount, currency = "NGN" } = req.body || {};

    if (!tx_ref || expected_amount == null) {
      return res.status(400).json({
        error: "Missing transaction reference or expected amount"
      });
    }

    const response = await fetch(
      `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(tx_ref)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const result = await response.json();

    if (!response.ok || result.status !== "success") {
      return res.status(400).json({
        verified: false,
        error: "Flutterwave could not verify this transaction"
      });
    }

    const payment = result.data;

    const verified =
      payment.status === "successful" &&
      Number(payment.amount) >= Number(expected_amount) &&
      payment.currency === currency &&
      payment.tx_ref === tx_ref;

    if (!verified) {
      return res.status(400).json({
        verified: false,
        error: "Payment details did not match"
      });
    }

    return res.status(200).json({
      verified: true,
      transaction_id: payment.id,
      tx_ref: payment.tx_ref,
      amount: payment.amount,
      currency: payment.currency
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      verified: false,
      error: "Payment verification failed"
    });
  }
}
