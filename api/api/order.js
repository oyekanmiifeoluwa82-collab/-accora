const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

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

function makeOrderNumber() {
  return (
    "ACC-" +
    Date.now().toString().slice(-8) +
    "-" +
    Math.random()
      .toString(36)
      .slice(2, 6)
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
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    return json(res, 500, {
      success: false,
      error:
        "Server configuration is incomplete."
    });
  }

  try {

    const {
      action,
      user_id,
      customer_email,
      product_name,
      category,
      amount
    } = req.body || {};

    if (!action || !user_id) {
      return json(res, 400, {
        success: false,
        error:
          "Missing action or user ID."
      });
    }

    /*
      BUY PRODUCT
    */

    if (action === "buy") {

      const numericAmount = Number(amount);

      if (
        !Number.isFinite(numericAmount) ||
        numericAmount <= 0
      ) {
        return json(res, 400, {
          success: false,
          error: "Invalid product amount."
        });
      }

      if (!product_name) {
        return json(res, 400, {
          success: false,
          error: "Product name is required."
        });
      }

      /*
        Get wallet
      */

      const wallets = await supabase(
        `wallets?user_id=eq.${encodeURIComponent(
          user_id
        )}&select=user_id,balance`
      );

      if (!wallets?.length) {
        return json(res, 400, {
          success: false,
          error:
            "Wallet not found."
        });
      }

      const balance =
        Number(wallets[0].balance) || 0;

      if (balance < numericAmount) {
        return json(res, 400, {
          success: false,
          error:
            "Insufficient wallet balance.",
          balance
        });
      }

      const newBalance =
        balance - numericAmount;

      /*
        Deduct wallet
      */

      await supabase(
        `wallets?user_id=eq.${encodeURIComponent(
          user_id
        )}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            balance: newBalance,
            updated_at:
              new Date().toISOString()
          })
        }
      );

      /*
        Create order
      */

      const orderNumber =
        makeOrderNumber();

      const orders = await supabase(
        "orders",
        {
          method: "POST",
          headers: {
            Prefer:
              "return=representation"
          },
          body: JSON.stringify({
            order_number: orderNumber,
            user_id,
            customer_email:
              customer_email || null,
            product_name,
            category:
              category || null,
            amount: numericAmount,
            status: "pending"
          })
        }
      );

      /*
        Record wallet transaction
      */

      await supabase(
        "wallet_transactions",
        {
          method: "POST",
          body: JSON.stringify({
            user_id,
            type: "debit",
            amount: numericAmount,
            balance_after:
              newBalance,
            reference:
              orderNumber,
            description:
              `Purchase: ${product_name}`
          })
        }
      );

      /*
        Notify customer
      */

      await supabase(
        "notifications",
        {
          method: "POST",
          body: JSON.stringify({
            user_id,
            title:
              "Order received",
            message:
              `Your order ${orderNumber} for ${product_name} has been received.`,
            type: "order"
          })
        }
      );

      return json(res, 200, {
        success: true,
        order:
          orders?.[0] || null,
        order_number:
          orderNumber,
        balance:
          newBalance
      });
    }

    /*
      CUSTOMER ORDERS
    */

    if (action === "my_orders") {

      const orders = await supabase(
        `orders?user_id=eq.${encodeURIComponent(
          user_id
        )}&select=*&order=created_at.desc&limit=100`
      );

      return json(res, 200, {
        success: true,
        orders: orders || []
      });
    }

    /*
      ADMIN: ALL ORDERS
    */

    if (action === "all_orders") {

      const orders = await supabase(
        "orders?select=*&order=created_at.desc&limit=500"
      );

      return json(res, 200, {
        success: true,
        orders: orders || []
      });
    }

    /*
      ADMIN: UPDATE ORDER
    */

    if (action === "update_order") {

      const {
        order_id,
        status,
        delivery_details
      } = req.body || {};

      if (!order_id) {
        return json(res, 400, {
          success: false,
          error:
            "Missing order ID."
        });
      }

      const update = {};

      if (status) {
        update.status = status;
      }

      if (
        delivery_details !== undefined
      ) {
        update.delivery_details =
          delivery_details;
      }

      update.updated_at =
        new Date().toISOString();

      const updated =
        await supabase(
          `orders?id=eq.${encodeURIComponent(
            order_id
          )}`,
          {
            method: "PATCH",
            headers: {
              Prefer:
                "return=representation"
            },
            body:
              JSON.stringify(update)
          }
        );

      /*
        Notify customer when
        order status changes
      */

      const orderRows =
        await supabase(
          `orders?id=eq.${encodeURIComponent(
            order_id
          )}&select=user_id,order_number,product_name,status`
        );

      const order =
        orderRows?.[0];

      if (order?.user_id) {

        await supabase(
          "notifications",
          {
            method: "POST",
            body: JSON.stringify({
              user_id:
                order.user_id,
              title:
                `Order ${order.status}`,
              message:
                `Your order ${order.order_number} (${order.product_name}) is now ${order.status}.`,
              type:
                "order"
            })
          }
        );
      }

      return json(res, 200, {
        success: true,
        order:
          updated?.[0] || null
      });
    }

    return json(res, 400, {
      success: false,
      error:
        "Unknown order action."
    });

  } catch (error) {

    console.error(
      "Order API error:",
      error
    );

    return json(res, 500, {
      success: false,
      error:
        "Order request failed."
    });
  }
};
