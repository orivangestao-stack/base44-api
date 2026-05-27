const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());

// Raw body needed for HMAC validation
app.use((req, res, next) => {
  let data = "";
  req.on("data", chunk => { data += chunk; });
  req.on("end", () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data); } catch { req.body = {}; }
    next();
  });
});

// ─────────────────────────────────────────
// ENV VARS (configure no Railway/Render/Vercel)
// ─────────────────────────────────────────
// BASE44_API_KEY        → chave de API do Base44 (veja abaixo como obter)
// YAMPI_SECRET_KEY      → secret key configurada na Yampi
// WHATSAPP_VERIFY_TOKEN → token de verificação do webhook Meta
// PORT                  → porta (padrão: 3000)

const BASE44_API_KEY = process.env.BASE44_API_KEY || "";
const YAMPI_SECRET_KEY = process.env.YAMPI_SECRET_KEY || "";
const WA_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "";
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────
// Base44 SDK client (service role)
// ─────────────────────────────────────────
const { createClient } = require("@base44/sdk");
const base44 = createClient({ apiKey: BASE44_API_KEY });
const db = base44.asServiceRole.entities;

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────
function mapYampiStatus(s) {
  const m = {
    pending: "pendente", waiting_payment: "pendente",
    paid: "em_andamento", in_production: "producao",
    ready_to_ship: "aguardando_envio",
    shipped: "enviado", delivered: "finalizado",
    cancelled: "cancelado", refunded: "cancelado",
  };
  return m[s] || "pendente";
}

function mapShippingStatus(s) {
  const m = {
    paid: "aguardando_envio", ready_to_ship: "aguardando_envio",
    shipped: "enviado", delivered: "entregue",
  };
  return m[s] || "aguardando_envio";
}

async function addYampiLog(action, status, message, count = 0) {
  try {
    const configs = await db.YampiConfig.list();
    if (!configs?.length) return;
    const cfg = configs[0];
    const logs = [{ date: new Date().toISOString(), action, status, message, count }, ...(cfg.sync_logs || [])].slice(0, 50);
    await db.YampiConfig.update(cfg.id, { sync_logs: logs, last_sync: new Date().toISOString() });
  } catch (e) { console.error("[Log] Failed:", e.message); }
}

async function invokeAI(prompt) {
  try {
    return await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt,
      response_json_schema: {
        type: "object",
        properties: {
          client_name: { type: "string" }, phone: { type: "string" },
          products: { type: "array", items: { type: "object", properties: {
            product_name: { type: "string" }, quantity: { type: "number" }, unit_price: { type: "number" }
          }}},
          total_value: { type: "number" }, payment_method: { type: "string" },
          shipping_type: { type: "string" }, address: { type: "string" },
          order_number: { type: "string" }, confidence: { type: "number" }
        }
      }
    });
  } catch { return null; }
}

// ═════════════════════════════════════════
// YAMPI WEBHOOK  POST /api/yampi/webhook
// ═════════════════════════════════════════
app.post("/api/yampi/webhook", async (req, res) => {
  console.log("[Yampi] Event:", req.body?.event, "| Order:", req.body?.resource?.id);

  // Validate HMAC signature
  if (YAMPI_SECRET_KEY) {
    const sig = req.headers["x-yampi-hmac-sha256"] || "";
    const expected = crypto.createHmac("sha256", YAMPI_SECRET_KEY).update(req.rawBody).digest("base64");
    if (sig && sig !== expected) {
      console.warn("[Yampi] Invalid signature");
      return res.status(401).json({ error: "Invalid signature" });
    }
  }

  const { event, resource } = req.body;
  if (!event || !resource) return res.status(400).json({ error: "Missing event or resource" });

  // ── order.paid ───────────────────────────
  if (event === "order.paid") {
    try {
      const exists = await db.Order.filter({ yampi_order_id: String(resource.id) });
      if (exists?.length) {
        await addYampiLog("order.paid", "info", `Pedido #${resource.number} já existe, ignorado.`);
        return res.json({ ok: true });
      }

      const customer = resource.customer || {};
      const shipping = resource.shipping_address || {};
      const shippingLine = resource.shipping_lines?.data?.[0] || {};

      const clientName = [customer.first_name, customer.last_name].filter(Boolean).join(" ") || "Cliente Yampi";
      const address = [shipping.street, shipping.number, shipping.complement, shipping.neighborhood, shipping.city, shipping.state].filter(Boolean).join(", ");

      const products = (resource.items?.data || []).map(i => ({
        product_name: i.title || i.name || "Produto",
        sku: i.sku || "",
        quantity: i.quantity || 1,
        unit_price: parseFloat(i.price || "0"),
        quantity_ready: 0,
      }));

      const order = await db.Order.create({
        yampi_order_id: String(resource.id),
        order_number: `YAMPI-${resource.number || resource.id}`,
        site_order_number: String(resource.number || resource.id),
        source: "yampi",
        client_name: clientName,
        phone: customer.phone || customer.cellphone || "",
        email: customer.email || "",
        cpf_cnpj: customer.cpf || "",
        address,
        cep: shipping.zipcode || "",
        city_state: [shipping.city, shipping.state].filter(Boolean).join(" / "),
        products,
        total_value: parseFloat(resource.value?.total || "0"),
        shipping_cost: parseFloat(shippingLine.value || "0"),
        carrier: shippingLine.delivery_company || "",
        payment_method: resource.payment_method?.method || "",
        payment_status: "pago",
        status: "aguardando_envio",
        shipping_status: "aguardando_envio",
        production_stage: "pagamento_confirmado",
        priority: "normal",
        is_packed: false,
        production_history: [{ stage: "pagamento_confirmado", date: new Date().toISOString(), responsible: "Yampi", notes: "Pedido criado via webhook order.paid" }],
        change_history: [{ date: new Date().toISOString(), field: "status", old_value: "", new_value: "aguardando_envio", user: "Yampi Webhook" }],
      });

      await addYampiLog("order.paid", "success", `Pedido #${resource.number} criado para ${clientName}.`, 1);
      console.log("[Yampi] Order created:", order.id);
    } catch (e) {
      console.error("[Yampi] order.paid error:", e.message);
      await addYampiLog("order.paid", "error", `Erro: ${e.message}`);
    }
    return res.json({ ok: true });
  }

  // ── order.status.updated ──────────────────
  if (event === "order.status.updated") {
    try {
      const existing = await db.Order.filter({ yampi_order_id: String(resource.id) });
      if (!existing?.length) {
        await addYampiLog("order.status.updated", "info", `Pedido Yampi #${resource.id} não encontrado.`);
        return res.json({ ok: true });
      }
      const order = existing[0];
      const yampiStatus = resource.status?.alias || resource.status?.slug || resource.status || "";
      const newStatus = mapYampiStatus(yampiStatus);

      await db.Order.update(order.id, {
        status: newStatus,
        shipping_status: mapShippingStatus(yampiStatus),
        ...(resource.tracking_code ? { tracking_code: resource.tracking_code, tracking_link: resource.tracking_url || "" } : {}),
        change_history: [...(order.change_history || []), { date: new Date().toISOString(), field: "status", old_value: order.status, new_value: newStatus, user: "Yampi Webhook" }],
      });

      await addYampiLog("order.status.updated", "success", `Pedido #${order.order_number} → ${newStatus}`);
    } catch (e) {
      console.error("[Yampi] order.status.updated error:", e.message);
      await addYampiLog("order.status.updated", "error", `Erro: ${e.message}`);
    }
    return res.json({ ok: true });
  }

  console.log("[Yampi] Unhandled event:", event);
  return res.json({ ok: true });
});


// ═════════════════════════════════════════
// WHATSAPP WEBHOOK
//   GET  /api/whatsapp/webhook  (verificação Meta)
//   POST /api/whatsapp/webhook  (mensagens)
// ═════════════════════════════════════════
app.get("/api/whatsapp/webhook", async (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  console.log("[WA] Verification:", { mode, token });

  if (mode === "subscribe" && challenge) {
    if (!WA_VERIFY_TOKEN || token === WA_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }
  return res.status(400).send("Bad Request");
});

app.post("/api/whatsapp/webhook", async (req, res) => {
  if (req.body?.object !== "whatsapp_business_account") return res.json({ ok: true });

  let autoCreate = true;
  try {
    const configs = await db.WhatsAppConfig.list();
    if (configs?.[0]) autoCreate = configs[0].auto_create_orders !== false;
  } catch {}

  for (const entry of req.body?.entry || []) {
    for (const change of entry?.changes || []) {
      const messages = change?.value?.messages || [];
      const contacts = change?.value?.contacts || [];

      for (const msg of messages) {
        if (msg.type !== "text") continue;
        const fromNumber = msg.from || "";
        const text = msg.text?.body || "";
        const contact = contacts.find(c => c.wa_id === fromNumber);
        const contactName = contact?.profile?.name || fromNumber;
        const receivedAt = msg.timestamp ? new Date(parseInt(msg.timestamp) * 1000).toISOString() : new Date().toISOString();

        console.log("[WA] Message from:", fromNumber, "|", text.substring(0, 60));

        // Parse with AI
        const parsed = await invokeAI(`Você é um assistente que extrai dados de pedidos de mensagens de WhatsApp em português.
Analise a mensagem abaixo e extraia as informações do pedido.
Mensagem: """\n${text}\n"""
Se não parecer um pedido, retorne confidence < 0.5.`);

        const confidence = parsed?.confidence || 0;
        const isOrder = confidence >= 0.75;

        const waMsg = await db.WhatsAppMessage.create({
          message_id: msg.id || `wa-${Date.now()}`,
          from_number: fromNumber,
          contact_name: contactName,
          body: text,
          received_at: receivedAt,
          status: isOrder ? (autoCreate ? "processando" : "revisao_necessaria") : "novo",
          confidence,
          parsed_data: parsed || {},
        });

        if (isOrder && autoCreate && parsed) {
          try {
            const products = (parsed.products || []).map(p => ({
              product_name: p.product_name || "Produto",
              sku: "", quantity: p.quantity || 1,
              unit_price: p.unit_price || 0, quantity_ready: 0,
            }));

            const order = await db.Order.create({
              whatsapp_message_id: waMsg.id,
              source: "whatsapp",
              client_name: parsed.client_name || contactName,
              phone: parsed.phone || fromNumber,
              address: parsed.address || "",
              products,
              total_value: parsed.total_value || 0,
              payment_method: parsed.payment_method || "",
              shipping_type: parsed.shipping_type || "",
              order_number: parsed.order_number || `WA-${Date.now()}`,
              status: "pendente",
              shipping_status: "aguardando_envio",
              production_stage: "pedido_recebido",
              payment_status: "pendente",
              priority: "normal",
              is_packed: false,
              production_history: [{ stage: "pedido_recebido", date: new Date().toISOString(), responsible: "WhatsApp Bot", notes: `Confiança: ${Math.round(confidence * 100)}%` }],
              change_history: [{ date: new Date().toISOString(), field: "status", old_value: "", new_value: "pendente", user: "WhatsApp Webhook" }],
            });

            await db.WhatsAppMessage.update(waMsg.id, { status: "pedido_criado", order_id: order.id });
            console.log("[WA] Order auto-created:", order.id);
          } catch (e) {
            console.error("[WA] Create order error:", e.message);
          }
        }
      }
    }
  }

  return res.json({ ok: true });
});

// ─────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", time: new Date().toISOString() }));
app.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));
