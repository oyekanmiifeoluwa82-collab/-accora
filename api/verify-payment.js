// api/verify-payment.js

const crypto = require("crypto");

const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

function json(res, status, body) {
  return res.status(status).json(body);
}

function makeOrderNumber() {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `ACC-${stamp}-${random}`;
}

function money(amount) {
  return `₦${Number(amount || 0).toLocaleString("en-NG")}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

async function verifyFlutterwave(txRef) {
  const response = await fetch(
    `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${FLW_SECRET_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.message || "Flutterwave verification failed."
    );
  }

  return data;
}

async function supabaseInsert(table, row) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify(row)
    }
  );

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      `Supabase ${table} insert failed: ${
        data?.message ||
        data?.hint ||
        text ||
        response.statusText
      }`
    );
  }

  return Array.isArray(data) ? data[0] : data;
}

async function sendEmail({ to, subject, html }) {
  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "ACCORA Orders <onboarding@resend.dev>",
        to: [to],
        subject,
        html
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.message || "Email sending failed."
    );
  }

  return data;
}

module.exports = async function handler(req, res) {

  if (req.method !== "POST") {
    return json(res, 405, {
      verified: false,
      error: "Method not allowed."
    });
  }

  if (
    !FLW_SECRET_KEY ||
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY ||
    !RESEND_API_KEY ||
    !ADMIN_EMAIL
  ) {
    console.error(
      "Missing required environment variables."
    );

    return json(res, 500, {
      verified: false,
      error: "Server configuration is incomplete."
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
      return json(res, 400, {
        verified: false,
        error:
          "Missing transaction reference, customer email, or products."
      });
    }

    const verification =
      await verifyFlutterwave(tx_ref);

    const payment =
      verification?.data;

    if (!payment) {
      return json(res, 400, {
        verified: false,
        error:
          "Flutterwave returned no payment data."
      });
    }

    const expectedAmount =
      products.reduce(
        (total, product) =>
          total + Number(product.price || 0),
        0
      );

    const paidAmount =
      Number(payment.amount || 0);

    const paidCurrency =
      String(payment.currency || "")
        .toUpperCase();

    if (
      payment.status !== "successful" ||
      paidAmount < expectedAmount ||
      paidCurrency !==
        String(currency).toUpperCase()
    ) {

      console.error(
        "Payment mismatch:",
        {
          tx_ref,
          paymentStatus:
            payment.status,
          paidAmount,
          expectedAmount,
          paidCurrency
        }
      );

      return json(res, 400, {
        verified: false,
        error:
          "Payment could not be verified."
      });
    }

    const orderNumber =
      makeOrderNumber();

    const order =
      await supabaseInsert(
        "orders",
        {
          order_number:
            orderNumber,

          customer_email:
            customer_email,

          amount:
            expectedAmount,

          currency:
            currency,

          tx_ref:
            tx_ref,

          payment_status:
            "successful"
        }
      );

    const orderId =
      order?.id;

    if (orderId) {

      for (const product of products) {

        await supabaseInsert(
          "order_items",
          {
            order_id:
              orderId,

            product_name:
              product.name,

            category:
              product.category || null,

            price:
              Number(product.price || 0),

            quantity:
              1
          }
        );

      }
    }

    const productRows =
      products
        .map(
          (p) => `
          <tr>
            <td style="padding:8px 0;border-bottom:1px solid #eee;">
              ${escapeHtml(p.name)}
            </td>

            <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;">
              ${money(p.price)}
            </td>
          </tr>
        `
        )
        .join("");

    // EMAIL TO YOU
    await sendEmail({
      to: ADMIN_EMAIL,

      subject:
        `NEW ACCORA ORDER ${orderNumber} • ${money(expectedAmount)}`,

      html: `
        <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#111;">

          <h2>New ACCORA Order</h2>

          <p>
            Payment has been verified successfully.
            This order needs delivery.
          </p>

          <div style="background:#f6f6f6;border-radius:12px;padding:16px;margin:18px 0;">

            <p>
              <strong>Order:</strong>
              ${escapeHtml(orderNumber)}
            </p>

            <p>
              <strong>Customer:</strong>
              ${escapeHtml(customer_email)}
            </p>

            <p>
              <strong>Flutterwave reference:</strong>
              ${escapeHtml(tx_ref)}
            </p>

            <p>
              <strong>Payment:</strong>
              Successful
            </p>

          </div>

          <h3>Products</h3>

          <table style="width:100%;border-collapse:collapse;">
            ${productRows}
          </table>

          <h2>
            Total:
            ${money(expectedAmount)}
          </h2>

          <p style="color:#666;">
            ACTION REQUIRED:
            Deliver this order to the customer.
          </p>

        </div>
      `
    });

    // EMAIL TO CUSTOMER
    await sendEmail({
      to: customer_email,

      subject:
        `ACCORA order confirmed • ${orderNumber}`,

      html: `
        <div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#111;">

          <h2>ACCORA Order Confirmed</h2>

          <p>
            Your payment was successfully verified.
          </p>

          <div style="background:#f6f6f6;border-radius:12px;padding:16px;margin:18px 0;">

            <p>
              <strong>Order number:</strong>
              ${escapeHtml(orderNumber)}
            </p>

            <p>
              <strong>Total paid:</strong>
              ${money(expectedAmount)}
            </p>

            <p>
              <strong>Status:</strong>
              Payment successful
            </p>

          </div>

          <p>
            Your digital order will be delivered
            to this email after processing.
          </p>

          <p style="color:#666;">
            Keep your order number for support.
          </p>

        </div>
      `
    });

    return json(res, 200, {
      verified: true,
      order_number:
        orderNumber,
      order_id:
        orderId || null,
      message:
        "Payment verified and order notifications sent."
    });

  } catch (error) {

    console.error(
      "verify-payment error:",
      error
    );

    return json(res, 500, {
      verified: false,
      error:
        "Payment was received, but order processing is still being completed."
    });
  }
};
