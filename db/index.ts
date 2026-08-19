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
  // max:4 mantém mais de uma conexão em voo — um `max:1` fazia o pool inteiro
  // travar quando uma única consulta travava no banco em nuvem.
  client = postgres(url, {
    max: 4,
    idle_timeout: 20,
    connect_timeout: 10,
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
        CREATE INDEX IF NOT EXISTS rtc_chat_channel_idx
          ON rtc_chat (channel, time)
      `
      await sql`
        CREATE TABLE IF NOT EXISTS rtc_screen_tracks (
          client_id text PRIMARY KEY,
          track_ids jsonb NOT NULL
        )
      `
    })().catch((err) => {
      initPromise = null // permite tentar de novo na próxima chamada
      throw err
    })
  }
  return initPromise
}
