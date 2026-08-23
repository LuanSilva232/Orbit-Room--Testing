import 'server-only'

import postgres, { Sql } from 'postgres'

// Cliente compartilhado com o banco em nuvem (Reactus/PostgreSQL).
// Em ambientes serverless (Vercel) o estado precisa morar num banco central,
// pois cada invocação pode cair numa instância diferente.
let client: Sql | null = null
let initPromise: Promise<void> | null = null

export function getSql(): Sql {
  if (client) return client
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL não configurada')
  // prepare:false evita prepared statements reutilizados de forma incorreta atrás de poolers.
  // max: mantém várias conexões em voo. Um pool muito pequeno (ex.: max:4) satura
  // sob rajada de usuários simultâneos e pode ficar com conexões presas, travando
  // todas as requisições com banco. O pool em nuvem aceita bem mais de 20 conexões.
  // max_lifetime recicla conexões periodicamente, evitando que conexões antigas/
  // quebradas fiquem presas no pool para sempre.
  client = postgres(url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    max_lifetime: 30 * 60,
    prepare: false,
  })
  return client
}

/** Garante que as tabelas existam (idempotente — seguro em cada instância). */
export function ensureDb(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const sql = getSql()
      await sql`
        CREATE TABLE IF NOT EXISTS rtc_clients (
          client_id  text PRIMARY KEY,
          name       text NOT NULL,
          photo      text,
          bio        text,
          channel    text NOT NULL,
          joined_at  bigint NOT NULL,
          last_seen  bigint NOT NULL
        )
      `
      await sql`
        ALTER TABLE rtc_clients
          ADD COLUMN IF NOT EXISTS left_at bigint
      `
      await sql`
        ALTER TABLE rtc_clients
          ADD COLUMN IF NOT EXISTS single_since bigint
      `
      await sql`
        ALTER TABLE rtc_clients
          ADD COLUMN IF NOT EXISTS cover text
      `
      await sql`
        ALTER TABLE rtc_clients
          ADD COLUMN IF NOT EXISTS user_id text
      `
      await sql`
        ALTER TABLE rtc_clients
          ADD COLUMN IF NOT EXISTS delete_scheduled_at bigint
      `
      await sql`
        ALTER TABLE rtc_clients
          ADD COLUMN IF NOT EXISTS last_ip text
      `
      await sql`
        ALTER TABLE rtc_clients
          ADD COLUMN IF NOT EXISTS device text
      `
      await sql`
        CREATE TABLE IF NOT EXISTS rtc_mailbox (
          id        bigserial PRIMARY KEY,
          to_client text NOT NULL,
          payload   jsonb NOT NULL
        )
      `
      await sql`
        CREATE INDEX IF NOT EXISTS rtc_mailbox_to_idx
          ON rtc_mailbox (to_client, id)
      `
      await sql`
        CREATE TABLE IF NOT EXISTS rtc_chat (
          id        text PRIMARY KEY,
          channel   text NOT NULL,
          member_id text,
          author    text NOT NULL,
          text      text NOT NULL,
          time      bigint NOT NULL,
          type      text,
          audio_url text,
          photo     text,
          bio       text
        )
      `
      await sql`
        ALTER TABLE rtc_chat
          ADD COLUMN IF NOT EXISTS cover text
      `
      await sql`
        ALTER TABLE rtc_chat
          ADD COLUMN IF NOT EXISTS is_anonymous boolean NOT NULL DEFAULT false
      `
      await sql`
        ALTER TABLE rtc_chat
          ADD COLUMN IF NOT EXISTS user_id text
      `
      await sql`
        ALTER TABLE rtc_chat
          ADD COLUMN IF NOT EXISTS expires_at bigint
      `
      await sql`
        CREATE INDEX IF NOT EXISTS rtc_chat_channel_idx
          ON rtc_chat (channel, time)
      `
      await sql`
        CREATE TABLE IF NOT EXISTS rtc_screen_tracks (
          client_id text PRIMARY KEY,
          track_ids jsonb NOT NULL
        )
      `
      // --- Contas de usuário (login com Google) ---
      await sql`
        CREATE TABLE IF NOT EXISTS users (
          id                 text PRIMARY KEY,
          email              text NOT NULL UNIQUE,
          email_verified_at  bigint,
          password_hash      text,
          status             text NOT NULL DEFAULT 'active',
          display_name       text,
          bio                text,
          photo              text,
          cover              text,
          rooms              jsonb NOT NULL DEFAULT '[]'::jsonb,
          created_at         bigint NOT NULL,
          updated_at         bigint NOT NULL
        )
      `
      await sql`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS cover text
      `
      await sql`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS delete_scheduled_at bigint
      `
      await sql`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS last_ip text
      `
      // --- Sistema social (amigos, convites e seguidores) ---
      // Código de amigo de 6 caracteres (letras + números), único por conta.
      await sql`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS friend_code text
      `
      await sql`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS privacy_show_online boolean NOT NULL DEFAULT true
      `
      await sql`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS privacy_show_lastseen boolean NOT NULL DEFAULT true
      `
      await sql`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS privacy_show_room boolean NOT NULL DEFAULT true
      `
      await sql`
        CREATE TABLE IF NOT EXISTS social_requests (
          id         text PRIMARY KEY,
          from_id    text NOT NULL,
          to_id      text NOT NULL,
          status     text NOT NULL DEFAULT 'pending',
          created_at bigint NOT NULL,
          UNIQUE (from_id, to_id)
        )
      `
      await sql`
        CREATE INDEX IF NOT EXISTS social_requests_to_idx
          ON social_requests (to_id, status)
      `
      await sql`
        CREATE TABLE IF NOT EXISTS social_friends (
          user_a  text NOT NULL,
          user_b  text NOT NULL,
          created_at bigint NOT NULL,
          PRIMARY KEY (user_a, user_b)
        )
      `
      await sql`
        CREATE TABLE IF NOT EXISTS social_follows (
          follower_id text NOT NULL,
          followee_id text NOT NULL,
          created_at   bigint NOT NULL,
          PRIMARY KEY (follower_id, followee_id)
        )
      `
      await sql`
        CREATE TABLE IF NOT EXISTS rooms (
          id         text PRIMARY KEY,
          name       text NOT NULL,
          is_private boolean NOT NULL DEFAULT false,
          owner_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          password   text,
          created_at bigint NOT NULL
        )
      `
      await sql`
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS password text
      `
      await sql`
        ALTER TABLE rooms ADD COLUMN IF NOT EXISTS capacity integer NOT NULL DEFAULT 0
      `
      await sql`
        CREATE INDEX IF NOT EXISTS rooms_owner_idx
          ON rooms (owner_id)
      `
      await sql`
        CREATE INDEX IF NOT EXISTS rooms_public_idx
          ON rooms (is_private)
      `
      await sql`
        CREATE TABLE IF NOT EXISTS room_invites (
          id         text PRIMARY KEY,
          room_id    text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          from_id    text NOT NULL,
          to_id      text NOT NULL,
          created_at bigint NOT NULL
        )
      `
      await sql`
        CREATE INDEX IF NOT EXISTS room_invites_to_idx
          ON room_invites (to_id, created_at)
      `
      await sql`
        ALTER TABLE room_invites
          ADD COLUMN IF NOT EXISTS expires_at bigint
      `
      await sql`
        CREATE TABLE IF NOT EXISTS oauth_accounts (
          id                 text PRIMARY KEY,
          user_id            text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider           text NOT NULL,
          provider_subject   text NOT NULL,
          created_at         bigint NOT NULL,
          UNIQUE (provider, provider_subject)
        )
      `
      await sql`
        CREATE INDEX IF NOT EXISTS oauth_accounts_user_idx
          ON oauth_accounts (user_id)
      `
      await sql`
        CREATE TABLE IF NOT EXISTS sessions (
          id         text PRIMARY KEY,
          user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash text NOT NULL UNIQUE,
          created_at bigint NOT NULL,
          expires_at bigint NOT NULL
        )
      `
      await sql`
        CREATE INDEX IF NOT EXISTS sessions_user_idx
          ON sessions (user_id)
      `
      await sql`
        CREATE TABLE IF NOT EXISTS oauth_states (
          id            text PRIMARY KEY,
          state         text NOT NULL UNIQUE,
          code_verifier text NOT NULL,
          redirect_to   text NOT NULL DEFAULT '/',
          created_at    bigint NOT NULL,
          expires_at    bigint NOT NULL
        )
      `
    })().catch((err) => {
      initPromise = null // permite tentar de novo na próxima chamada
      throw err
    })
  }
  return initPromise
}
