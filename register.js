/**
 * Registro del número de teléfono en WhatsApp Cloud API
 *
 * Pasos:
 *   1. node register.js request   → solicita código por SMS/voz
 *   2. node register.js verify    → ingresa el código recibido y lo verifica
 *   3. node register.js register  → registra el número con PIN de dos pasos
 *
 * Uso: node register.js <comando> [argumento]
 */

require("dotenv").config();
const axios = require("axios");

const { META_ACCESS_TOKEN, PHONE_NUMBER_ID } = process.env;

const BASE = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}`;
const HEADERS = {
  Authorization: `Bearer ${META_ACCESS_TOKEN}`,
  "Content-Type": "application/json",
};

// ── Validación básica ──────────────────────────────────────────
if (!META_ACCESS_TOKEN || META_ACCESS_TOKEN.startsWith("PENDIENTE")) {
  console.error(
    "\n[ERROR] META_ACCESS_TOKEN no configurado en .env\n" +
    "        Ve a developers.facebook.com → tu App → WhatsApp → API Setup\n" +
    "        y copia el token en el archivo .env antes de continuar.\n"
  );
  process.exit(1);
}

const [, , command, arg] = process.argv;

(async () => {
  try {
    switch (command) {

      // ── PASO 1: Solicitar código de verificación ──────────────
      case "request": {
        // method: SMS o VOICE
        const method = arg?.toUpperCase() || "SMS";
        console.log(`[1/3] Solicitando código de verificación por ${method}...`);

        const { data } = await axios.post(
          `${BASE}/request_code`,
          { code_method: method, language: "es" },
          { headers: HEADERS }
        );

        console.log("[OK] Código enviado:", JSON.stringify(data, null, 2));
        console.log('\nAhora ejecuta:  node register.js verify <CODIGO>');
        break;
      }

      // ── PASO 2: Verificar el código recibido ──────────────────
      case "verify": {
        if (!arg) {
          console.error("[ERROR] Debes pasar el código: node register.js verify 123456");
          process.exit(1);
        }
        console.log(`[2/3] Verificando código: ${arg} ...`);

        const { data } = await axios.post(
          `${BASE}/verify_code`,
          { code: arg },
          { headers: HEADERS }
        );

        console.log("[OK] Código verificado:", JSON.stringify(data, null, 2));
        console.log('\nAhora ejecuta:  node register.js register <PIN_6_DIGITOS>');
        break;
      }

      // ── PASO 3: Registrar el número ───────────────────────────
      case "register": {
        const pin = arg || "000000"; // PIN de dos pasos (cámbialo)
        if (pin.length !== 6 || !/^\d+$/.test(pin)) {
          console.error("[ERROR] El PIN debe tener exactamente 6 dígitos numéricos.");
          process.exit(1);
        }
        console.log(`[3/3] Registrando número con PIN ${pin} ...`);

        const { data } = await axios.post(
          `${BASE}/register`,
          { messaging_product: "whatsapp", pin },
          { headers: HEADERS }
        );

        console.log("[OK] Número registrado:", JSON.stringify(data, null, 2));
        console.log('\nEl número está listo. Arranca el servidor con:  npm start');
        break;
      }

      // ── Verificar estado actual del número ────────────────────
      case "status": {
        const { data } = await axios.get(BASE, {
          headers: HEADERS,
          params: { fields: "display_phone_number,verified_name,quality_rating,status,code_verification_status" },
        });
        console.log("[Estado del número]", JSON.stringify(data, null, 2));
        break;
      }

      default:
        console.log(
          "\nUso:\n" +
          "  node register.js status             → ver estado actual\n" +
          "  node register.js request [SMS|VOICE] → solicitar código\n" +
          "  node register.js verify  <CODIGO>    → verificar código\n" +
          "  node register.js register <PIN>       → registrar número\n"
        );
    }
  } catch (err) {
    const detail = err.response?.data ?? err.message;
    console.error("[ERROR]", JSON.stringify(detail, null, 2));
    process.exit(1);
  }
})();
