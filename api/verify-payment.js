export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const {
      tx_ref,
      customer_email,
      products,
      currency = "NGN"
    } = req.body || {};

    if (
      !tx_ref ||
      !customer_email ||
      !Array.isArray(products) ||
      products.length === 0
    ) {
      return res.status(400).json({
        verified: false,
        error: "Missing transaction reference, customer email, or products"
      });
    }

    const catalog = {
      "Facebook 1": 2500,
      "Facebook 2": 3500,
      "Facebook 3": 23000,
      "Facebook 4": 100000,

      "TikTok 1": 1000,
      "TikTok 2": 4500,
      "TikTok 3": 10000,
      "TikTok 4": 50000,

      "Instagram 1": 2200,
      "Instagram 2": 5058,
      "Instagram 3": 10000,
      "Instagram 4": 43000,

      "Outlook 1": 120,
      "Outlook 12": 1100,

      "ExpressVPN": 4500,
      "Surfshark VPN": 6000,
      "PIA VPN": 3000,
      "HMA VPN": 4000,

      "SOCKS5 · 5 IPs": 6000
    };

    const cleanProducts = products.map((product) => {
      const name = String(product?.name || "");

      if (!Object.prototype.hasOwnProperty.call(catalog, name)) {
        throw new Error(`Unknown product: ${name}`);
      }

      return {
        name,
        price: catalog[name],
        category: String(product?.category || "")
      };
    });

    const expectedAmount = cleanProducts.reduce(
      (total, product) => total + product.price,
      0
    );

    /*
      STEP 1
      Verify the payment directly with Flutterwave.
    */

    const flutterwaveResponse = await fetch(
      `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(
        tx_ref
      )}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const flutterwaveResult = await flutterwaveResponse.json();

    if (
      !flutterwaveResponse.ok ||
      flutterwaveResult.status !== "success"
    ) {
      return res.status(400).json({
        verified: false,
        error: "Flutterwave could not verify this transaction"
      });
    }

    const payment = flutterwaveResult.data;

    const verified =
      payment.status === "successful" &&
      Number(payment.amount) === expectedAmount &&
      payment.currency === currency &&
      payment.tx_ref === tx_ref;

    if (!verified) {
      return res.status(400).json({
        verified: false,
        error: "Payment details did not match the order"
      });
    }

    /*
      STEP 2
      Create an Accora order number.
    */

    const orderNumber =
      "ACC-" +
      new Date()
        .toISOString()
        .slice(0, 10)
        .replace(/-/g, "") +
      "-" +
      Math.random()
        .toString(36)
        .slice(2, 7)
        .toUpperCase();

    /*
      STEP 3
      Save the verified order in Supabase.
    */

    const supabaseResponse = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/orders`,
      {
        method: "POST",

        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },

        body: JSON.stringify({
          order_number: orderNumber,
          customer_email: customer_email,
          products: cleanProducts,
          amount: expectedAmount,
          currency: currency,
          flutterwave_tx_ref: tx_ref,
          flutterwave_transaction_id: String(payment.id),
          payment_status: "PAID"
        })
      }
    );

    const supabaseResult = await supabaseResponse.json();

    if (!supabaseResponse.ok) {
      console.error(
        "SUPABASE ORDER ERROR:",
        supabaseResult
      );

      return res.status(500).json({
        verified: true,
        order_created: false,
        error: "Payment verified, but order creation failed",
        details: supabaseResult
      });
    }

    /*
      STEP 4
      Success.
    */

    return res.status(200).json({
      verified: true,
      order_created: true,
      order_number: orderNumber,
      customer_email: customer_email,
      amount: expectedAmount,
      currency: currency,
      transaction_id: payment.id,
      tx_ref: tx_ref
    });

  } catch (error) {
    console.error("VERIFY PAYMENT ERROR:", error);

    return res.status(500).json({
      verified: false,
      error: error.message || "Payment verification failed"
    });
  }
}
