require("dotenv").config();
const express = require("express");
const axios = require("axios");
const path = require("path");
const { pool, initDb } = require("./db");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const {
  META_ACCESS_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  GROQ_API_KEY,
  PORT = 3000,
} = process.env;

// ──────────────────────────────────────────────
// CAPA DE DATOS — PostgreSQL
// ──────────────────────────────────────────────

function extractCustomerName(messages) {
  const patterns = [
    /me llamo\s+([A-Za-záéíóúÁÉÍÓÚñÑ]+(?:\s+[A-Za-záéíóúÁÉÍÓÚñÑ]+)?)/i,
    /mi nombre es\s+([A-Za-záéíóúÁÉÍÓÚñÑ]+(?:\s+[A-Za-záéíóúÁÉÍÓÚñÑ]+)?)/i,
    /soy\s+([A-Za-záéíóúÁÉÍÓÚñÑ]+(?:\s+[A-Za-záéíóúÁÉÍÓÚñÑ]+)?)/i,
    /^([A-Za-záéíóúÁÉÍÓÚñÑ]+(?:\s+[A-Za-záéíóúÁÉÍÓÚñÑ]+)?),?\s+(?:quisiera|necesito|quiero)/i,
  ];
  const bareNamePattern = /^([A-Za-záéíóúÁÉÍÓÚñÑ]+(?:\s+[A-Za-záéíóúÁÉÍÓÚñÑ]+)?)$/i;

  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const pattern of patterns) {
      const match = msg.content.match(pattern);
      if (match) return match[1].trim();
    }
    // Solo aplicar el patrón de nombre suelto si el mensaje tiene 4 palabras o menos
    if (msg.content.trim().split(/\s+/).length <= 4) {
      const match = msg.content.trim().match(bareNamePattern);
      if (match) return match[1].trim();
    }
  }
  return null;
}

// Returns messages for the current active session (respects 24h TTL for bot context)
async function getHistory(phone) {
  const { rows } = await pool.query(
    `SELECT m.role, m.content, m.manual
     FROM messages m
     JOIN conversations c ON c.phone = m.phone AND c.session_id = m.session_id
     WHERE m.phone = $1
       AND c.last_activity > NOW() - INTERVAL '24 hours'
     ORDER BY m.created_at`,
    [phone]
  );
  return rows;
}

// Appends one message and updates conversation metadata.
// Auto-resets the session if the phone has been inactive for more than 24h.
async function appendMessage(phone, role, content, manual = false) {
  const { rows: [conv] } = await pool.query(
    `INSERT INTO conversations (phone)
     VALUES ($1)
     ON CONFLICT (phone) DO UPDATE SET
       session_id       = CASE WHEN conversations.last_activity < NOW() - INTERVAL '24 hours'
                               THEN gen_random_uuid() ELSE conversations.session_id END,
       first_message_at = CASE WHEN conversations.last_activity < NOW() - INTERVAL '24 hours'
                               THEN NOW() ELSE conversations.first_message_at END,
       completed        = CASE WHEN conversations.last_activity < NOW() - INTERVAL '24 hours'
                               THEN false ELSE conversations.completed END
     RETURNING session_id`,
    [phone]
  );

  await pool.query(
    `INSERT INTO messages (phone, session_id, role, content, manual)
     VALUES ($1, $2, $3, $4, $5)`,
    [phone, conv.session_id, role, content, manual]
  );

  if (role === "user") {
    const name = extractCustomerName([{ role: "user", content }]);
    await pool.query(
      `UPDATE conversations
       SET last_activity     = NOW(),
           last_user_message = $1,
           customer_name     = COALESCE(customer_name, $2)
       WHERE phone = $3`,
      [content, name, phone]
    );
  } else {
    const isClosing = content.includes("técnico de Kangaroo Multiservice te contactará pronto");
    await pool.query(
      `UPDATE conversations
       SET last_activity    = NOW(),
           last_bot_message = $1,
           completed        = completed OR $2
       WHERE phone = $3`,
      [content, isClosing, phone]
    );
  }
}

// Starts a fresh session for the phone while preserving historical messages in the DB.
async function resetSession(phone) {
  await pool.query(
    `UPDATE conversations
     SET session_id        = gen_random_uuid(),
         completed         = false,
         first_message_at  = NOW(),
         last_user_message = NULL,
         last_bot_message  = NULL
     WHERE phone = $1`,
    [phone]
  );
  console.log(`[Session] Sesión reiniciada para ${phone}`);
}

const SYSTEM_PROMPT = `Eres el Asistente Virtual de Kangaroo Multiservice, empresa de servicios del hogar en La Romana y Bayahibe, República Dominicana.

Servicios que ofrecemos: plomería, electricidad, aires acondicionados, mantenimiento de piscinas y jacuzzis, e instalación de cámaras de seguridad.

IDENTIDAD: Preséntate siempre como "Asistente de Kangaroo Multiservice". Nunca inventes ni uses un nombre de cliente que no haya proporcionado.

RECOPILACIÓN DE INFORMACIÓN: Debes recopilar de forma natural y conversacional los siguientes datos. NO repitas preguntas sobre datos que el cliente ya proporcionó:
1. Nombre del cliente
2. Servicio que necesita
3. Dirección en La Romana o Bayahibe
4. Descripción del problema

URGENCIAS: Si el cliente menciona palabras como "inundación", "agua por todos lados", "corto circuito", "incendio", "emergencia", "urgente", "no hay luz", "se quemó", u otras señales de urgencia, responde con prioridad máxima, expresa que es urgente y dile que un técnico será enviado de inmediato.

CIERRE: Cuando ya tengas los 4 datos (nombre, servicio, dirección y descripción), confirma con un mensaje de cierre que incluya:
- Un resumen de la solicitud
- La frase: "Un técnico de Kangaroo Multiservice te contactará pronto."
- Agradecimiento por contactar la empresa

REGLAS:
- Responde siempre en español
- Sé amable, cálido y profesional
- Evita Markdown (no uses *, #, -, etc.) ya que WhatsApp no lo renderiza
- Sé conciso, máximo 3 párrafos por mensaje
- Si el cliente pregunta por algo fuera de los servicios ofrecidos, explica amablemente que no puedes ayudar con eso`;

// ──────────────────────────────────────────────
// 1. WEBHOOK VERIFICATION (GET)
// ──────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[Webhook] Verificación exitosa");
    return res.status(200).send(challenge);
  }

  console.warn("[Webhook] Token de verificación incorrecto");
  res.sendStatus(403);
});

// ──────────────────────────────────────────────
// 2. RECIBIR MENSAJES ENTRANTES (POST)
// ──────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object !== "whatsapp_business_account") return;

    const entry   = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;

    if (value?.statuses) return;

    const messages = value?.messages;
    if (!messages?.length) return;

    const message = messages[0];
    const from    = message.from;

    if (message.type !== "text") {
      await sendWhatsAppMessage(from, "Solo puedo procesar mensajes de texto. Por favor escríbeme tu consulta.");
      return;
    }

    const userText = message.text.body.trim();
    console.log(`[Mensaje] De ${from}: "${userText}"`);

    await markAsRead(message.id);

    const reply = await askGroq(from, userText);
    await sendWhatsAppMessage(from, reply);

  } catch (err) {
    console.error("[Error POST /webhook]", err.response?.data || err.message);
  }
});

// ──────────────────────────────────────────────
// 3. LLAMAR A GROQ CON HISTORIAL DE CONVERSACIÓN
// ──────────────────────────────────────────────
async function askGroq(phone, userMessage) {
  const history = await getHistory(phone);

  const { rows: [convData] } = await pool.query(
    `SELECT customer_name FROM conversations WHERE phone = $1`,
    [phone]
  );
  const savedName = convData?.customer_name;

  const systemPrompt = savedName
    ? `${SYSTEM_PROMPT}\n\nIMPORTANTE: Ya conoces a este cliente. Su nombre es ${savedName}. Salúdalo por su nombre desde el inicio y NO vuelvas a pedírselo.`
    : SYSTEM_PROMPT;

  await appendMessage(phone, "user", userMessage);

  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.1-8b-instant",
        max_tokens: 1024,
        messages: [
          { role: "system", content: systemPrompt },
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: userMessage },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const assistantReply = response.data.choices[0].message.content;
    await appendMessage(phone, "assistant", assistantReply);

    if (assistantReply.includes("técnico de Kangaroo Multiservice te contactará pronto")) {
      setTimeout(() => resetSession(phone), 5 * 60 * 1000);
    }

    return assistantReply;
  } catch (err) {
    console.error("[Groq] Error:", err.response?.data || err.message);
    return "Lo siento, ocurrió un error. Por favor intenta de nuevo en un momento.";
  }
}

// ──────────────────────────────────────────────
// 4. ENVIAR MENSAJE POR WHATSAPP BUSINESS API
// ──────────────────────────────────────────────
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

  try {
    const { data } = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${META_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(`[WhatsApp] Enviado a ${to} | message_id: ${data.messages?.[0]?.id}`);
  } catch (err) {
    const detail = err.response?.data?.error ?? err.message;
    console.error(`[WhatsApp] ERROR enviando a ${to}:`, JSON.stringify(detail, null, 2));
    throw err;
  }
}

// ──────────────────────────────────────────────
// 5. MARCAR MENSAJE COMO LEÍDO
// ──────────────────────────────────────────────
async function markAsRead(messageId) {
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    },
    {
      headers: {
        Authorization: `Bearer ${META_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  ).catch(() => {});
}

// ──────────────────────────────────────────────
// TEST ENDPOINT — GET /test?to=NUMERO
// ──────────────────────────────────────────────
app.get("/test", async (req, res) => {
  const to = req.query.to;
  if (!to) return res.status(400).json({ error: "Falta el parámetro ?to=NUMERO" });

  try {
    await sendWhatsAppMessage(to, "Prueba del bot ✓ — Asistente de Kangaroo Multiservice funcionando.");
    res.json({ ok: true, to });
  } catch (err) {
    res.status(500).json({ error: err.response?.data ?? err.message });
  }
});

// DEBUG — ver sesiones activas: GET /sessions
app.get("/sessions", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.phone, COUNT(m.id) AS turns, c.last_activity
       FROM conversations c
       LEFT JOIN messages m ON m.phone = c.phone AND m.session_id = c.session_id
       WHERE c.last_activity > NOW() - INTERVAL '24 hours'
       GROUP BY c.phone, c.last_activity
       ORDER BY c.last_activity DESC`
    );
    res.json({
      activeSessions: rows.length,
      sessions: rows.map((r) => ({
        phone: r.phone,
        turns: Number(r.turns),
        lastActivity: r.last_activity,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// DASHBOARD — GET /dashboard
// ──────────────────────────────────────────────
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// ──────────────────────────────────────────────
// API — GET /api/conversations
// ──────────────────────────────────────────────
app.get("/api/conversations", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         c.phone,
         c.customer_name                                AS "customerName",
         c.last_user_message                            AS "lastUserMessage",
         c.last_bot_message                             AS "lastBotMessage",
         EXTRACT(EPOCH FROM c.last_activity)    * 1000  AS "lastActivity",
         EXTRACT(EPOCH FROM c.first_message_at) * 1000  AS "firstMessageAt",
         c.completed,
         COALESCE(
           json_agg(
             json_build_object('role', m.role, 'content', m.content, 'manual', m.manual)
             ORDER BY m.created_at
           ) FILTER (WHERE m.id IS NOT NULL),
           '[]'
         ) AS messages
       FROM conversations c
       LEFT JOIN messages m ON m.phone = c.phone AND m.session_id = c.session_id
       WHERE c.last_activity > NOW() - INTERVAL '7 days'
       GROUP BY c.phone, c.customer_name, c.last_user_message, c.last_bot_message,
                c.last_activity, c.first_message_at, c.completed
       ORDER BY c.last_activity DESC`
    );

    const conversations = rows.map((r) => ({
      ...r,
      lastActivity:   Number(r.lastActivity),
      firstMessageAt: Number(r.firstMessageAt),
      turns: (r.messages || []).filter((m) => m.role === "user").length,
      status: r.completed ? "completed" : "active",
    }));

    res.json({ total: conversations.length, conversations });
  } catch (err) {
    console.error("[API /api/conversations]", err);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────
// API — POST /api/send  (respuesta manual del agente)
// ──────────────────────────────────────────────
app.post("/api/send", async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message?.trim()) {
    return res.status(400).json({ error: "Se requieren phone y message" });
  }
  try {
    await sendWhatsAppMessage(phone, message.trim());
    await appendMessage(phone, "assistant", message.trim(), true);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.response?.data ?? err.message });
  }
});

// ──────────────────────────────────────────────
// ARRANCAR SERVIDOR
// ──────────────────────────────────────────────
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`[Servidor] WhatsApp bot escuchando en puerto ${PORT}`);
    console.log(`[Config]   Phone Number ID: ${PHONE_NUMBER_ID}`);
    console.log(`[Config]   Verify Token:    ${VERIFY_TOKEN}`);
  });
}

start().catch((err) => {
  console.error("[Fatal] No se pudo iniciar el servidor:", err.message);
  process.exit(1);
});
