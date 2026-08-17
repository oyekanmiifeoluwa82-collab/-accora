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
    const message =
      data?.message ||
      data?.error_description ||
      data?.hint ||
      (typeof data === "string" ? data : "") ||
      `Supabase request failed with status ${response.status}`;
    throw new Error(message);
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
      .slice(2, 7)
      .toUpperCase()
  );
}
function cleanUserId(value) {
  return String(value || "").trim();
}
function cleanEmail(value) {
  return String(value || "").trim();
}
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, {
      success: false,
      error: "Method not allowed."
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
    const body = req.body || {};
    const action = body.action;
    const user_id = cleanUserId(body.user_id);
    const customer_email =
      cleanEmail(body.customer_email);
    if (!action) {
      return json(res, 400, {
        success: false,
        error: "Missing action."
      });
    }
    /*
    =====================================================
    BUY PRODUCT USING WALLET
    =====================================================
    */
    if (action === "buy") {
      const product_name =
        String(body.product_name || "").trim();
      const category =
        String(body.category || "").trim();
      const numericAmount =
        Number(body.amount);
      if (!user_id) {
        return json(res, 400, {
          success: false,
          error: "Missing user ID."
        });
      }
      if (!customer_email) {
        return json(res, 400, {
          success: false,
          error:
            "Customer email is required."
        });
      }
      if (!product_name) {
        return json(res, 400, {
          success: false,
          error:
            "Product name is required."
        });
      }
      if (
        !Number.isFinite(numericAmount) ||
        numericAmount <= 0
      ) {
        return json(res, 400, {
          success: false,
          error:
            "Invalid product amount."
        });
      }
      /*
      -----------------------------------------------------
      GET WALLET
      -----------------------------------------------------
      */
      const wallets = await supabase(
        `wallets?user_id=eq.${encodeURIComponent(
          user_id
        )}&select=user_id,balance&limit=1`
      );
      if (!Array.isArray(wallets) || !wallets.length) {
        return json(res, 400, {
          success: false,
          error: "Wallet not found."
        });
      }
      const oldBalance =
        Number(wallets[0].balance) || 0;
      /*
      -----------------------------------------------------
      CHECK BALANCE
      -----------------------------------------------------
      */
      if (oldBalance < numericAmount) {
        return json(res, 400, {
          success: false,
          error:
            "Insufficient wallet balance.",
          balance: oldBalance,
          required: numericAmount
        });
      }
      const newBalance =
        oldBalance - numericAmount;
      /*
      -----------------------------------------------------
      DEDUCT WALLET
      -----------------------------------------------------
      */
      await supabase(
        `wallets?user_id=eq.${encodeURIComponent(
          user_id
        )}`,
        {
          method: "PATCH",
          headers: {
            Prefer:
              "return=representation"
          },
          body: JSON.stringify({
            balance: newBalance,
            updated_at:
              new Date().toISOString()
          })
        }
      );
      let order = null;
      let transactionCreated = false;
      try {
        /*
        ---------------------------------------------------
        CREATE ORDER
        ---------------------------------------------------
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
              order_number:
                orderNumber,
              user_id:
                user_id,
              customer_email:
                customer_email,
              product_name:
                product_name,
              category:
                category || null,
              amount:
                numericAmount,
              status:
                "pending"
            })
          }
        );
        order =
          Array.isArray(orders)
            ? orders[0]
            : orders;
        /*
        ---------------------------------------------------
        RECORD WALLET TRANSACTION
        ---------------------------------------------------
        */
        await supabase(
          "wallet_transactions",
          {
            method: "POST",
            headers: {
              Prefer:
                "return=representation"
            },
            body: JSON.stringify({
              user_id:
                user_id,
              type:
                "debit",
              amount:
                numericAmount,
              balance_after:
                newBalance,
              reference:
                orderNumber,
              description:
                `Purchase: ${product_name}`
            })
          }
        );
        transactionCreated = true;
        /*
        ---------------------------------------------------
        NOTIFICATION
        ---------------------------------------------------
        Notification failure must NOT cancel
        an otherwise successful purchase.
        */
        try {
          await supabase(
            "notifications",
            {
              method: "POST",
              body: JSON.stringify({
                user_id:
                  user_id,
                title:
                  "Order received",
                message:
                  `Your order ${orderNumber} for ${product_name} has been received.`,
                type:
                  "order"
              })
            }
          );
        } catch (notificationError) {
          console.error(
            "Notification error:",
            notificationError
          );
        }
        /*
        ---------------------------------------------------
        SUCCESS
        ---------------------------------------------------
        */
        return json(res, 200, {
          success: true,
          order:
            order || null,
          order_number:
            order?.order_number ||
            orderNumber,
          balance:
            newBalance,
          charged:
            numericAmount
        });
      } catch (purchaseError) {
        /*
        ---------------------------------------------------
        ROLLBACK WALLET
        ---------------------------------------------------
        If order creation or transaction recording
        fails, put the money back.
        */
        console.error(
          "Purchase processing error:",
          purchaseError
        );
        try {
          await supabase(
            `wallets?user_id=eq.${encodeURIComponent(
              user_id
            )}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                balance:
                  oldBalance,
                updated_at:
                  new Date().toISOString()
              })
            }
          );
          console.log(
            "Wallet rollback successful."
          );
        } catch (rollbackError) {
          console.error(
            "CRITICAL: Wallet rollback failed:",
            rollbackError
          );
        }
        return json(res, 500, {
          success: false,
          error:
            purchaseError.message ||
            "Unable to complete purchase.",
          balance:
            oldBalance
        });
      }
    }
    /*
    =====================================================
    CUSTOMER ORDERS
    =====================================================
    */
    if (action === "my_orders") {
      if (!user_id) {
        return json(res, 400, {
          success: false,
          error: "Missing user ID."
        });
      }
      const orders = await supabase(
        `orders?user_id=eq.${encodeURIComponent(
          user_id
        )}&select=*&order=created_at.desc&limit=100`
      );
      return json(res, 200, {
        success: true,
        orders:
          Array.isArray(orders)
            ? orders
            : []
      });
    }
    /*
    =====================================================
    ADMIN: ALL ORDERS
    =====================================================
    */
    if (action === "all_orders") {
      const orders = await supabase(
        "orders?select=*&order=created_at.desc&limit=500"
      );
      return json(res, 200, {
        success: true,
        orders:
          Array.isArray(orders)
            ? orders
            : []
      });
    }
    /*
    =====================================================
    ADMIN: UPDATE ORDER
    =====================================================
    */
    if (action === "update_order") {
      const order_id =
        String(body.order_id || "").trim();
      const status =
        body.status;
      const delivery_details =
        body.delivery_details;
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
        delivery_details !==
        undefined
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
      ---------------------------------------------------
      GET UPDATED ORDER
      ---------------------------------------------------
      */
      const orderRows =
        await supabase(
          `orders?id=eq.${encodeURIComponent(
            order_id
          )}&select=user_id,order_number,product_name,status&limit=1`
        );
      const order =
        Array.isArray(orderRows)
          ? orderRows[0]
          : null;
      /*
      ---------------------------------------------------
      NOTIFY CUSTOMER
      ---------------------------------------------------
      */
      if (order?.user_id) {
        try {
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
        } catch (notificationError) {
          console.error(
            "Notification error:",
            notificationError
          );
        }
      }
      return json(res, 200, {
        success: true,
        order:
          Array.isArray(updated)
            ? updated[0]
            : updated
      });
    }
    /*
    =====================================================
    UNKNOWN ACTION
    =====================================================
    */
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
    /*
    IMPORTANT:
    Return the real error instead of only
    "Order request failed."
    */
    return json(res, 500, {
      success: false,
      error:
        error.message ||
        "Order request failed."
    });
  }
};
