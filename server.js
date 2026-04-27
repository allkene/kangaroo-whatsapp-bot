require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const {
  META_ACCESS_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  GROQ_API_KEY,
  PORT = 3000,
} = process.env;

// ──────────────────────────────────────────────
// MEMORIA DE CONVERSACIÓN POR USUARIO
// Clave: número de teléfono | Valor: { messages: [], lastActivity: timestamp }
// Se limpia automáticamente tras 24h de inactividad
// ──────────────────────────────────────────────
const conversations = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

function getHistory(phone) {
  const session = conversations.get(phone);
  if (!session) return [];
  // Si pasaron más de 24h, sesión expirada
  if (Date.now() - session.lastActivity > SESSION_TTL_MS) {
    conversations.delete(phone);
    return [];
  }
  return session.messages;
}

function saveHistory(phone, messages) {
  conversations.set(phone, { messages, lastActivity: Date.now() });
}

function clearHistory(phone) {
  conversations.delete(phone);
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
  const history = getHistory(phone);

  // Agrega el nuevo mensaje del usuario al historial
  const updatedHistory = [...history, { role: "user", content: userMessage }];

  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.1-8b-instant",
        max_tokens: 1024,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...updatedHistory,
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

    // Guarda historial completo (usuario + respuesta del asistente)
    saveHistory(phone, [
      ...updatedHistory,
      { role: "assistant", content: assistantReply },
    ]);

    // Si la respuesta contiene el cierre, limpia la sesión después de 5 min
    // para que el técnico pueda reabrir una nueva conversación si es necesario
    if (assistantReply.includes("técnico de Kangaroo Multiservice te contactará pronto")) {
      setTimeout(() => clearHistory(phone), 5 * 60 * 1000);
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
app.get("/sessions", (req, res) => {
  const active = [];
  for (const [phone, session] of conversations.entries()) {
    active.push({
      phone,
      turns: session.messages.length,
      lastActivity: new Date(session.lastActivity).toISOString(),
    });
  }
  res.json({ activeSessions: active.length, sessions: active });
});

// ──────────────────────────────────────────────
// ARRANCAR SERVIDOR
// ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Servidor] WhatsApp bot escuchando en puerto ${PORT}`);
  console.log(`[Config]   Phone Number ID: ${PHONE_NUMBER_ID}`);
  console.log(`[Config]   Verify Token:    ${VERIFY_TOKEN}`);
});
