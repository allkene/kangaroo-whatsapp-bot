const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      phone              VARCHAR(30)  PRIMARY KEY,
      customer_name      VARCHAR(255),
      session_id         UUID         NOT NULL DEFAULT gen_random_uuid(),
      first_message_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      last_activity      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      last_user_message  TEXT,
      last_bot_message   TEXT,
      completed          BOOLEAN      NOT NULL DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          SERIAL      PRIMARY KEY,
      phone       VARCHAR(30) NOT NULL REFERENCES conversations(phone) ON DELETE CASCADE,
      session_id  UUID        NOT NULL,
      role        VARCHAR(10) NOT NULL CHECK (role IN ('user', 'assistant')),
      content     TEXT        NOT NULL,
      manual      BOOLEAN     NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS messages_phone_session_idx
      ON messages (phone, session_id, created_at);

    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS address TEXT;
  `);
  console.log("[DB] Tablas listas");
}

module.exports = { pool, initDb };
