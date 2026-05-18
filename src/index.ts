import { Hono } from 'hono'
import { fetch as signedFetch, calculateThumbprint } from '@hellocoop/httpsig'

// ── Env ────────────────────────────────────────────────────────────

interface Env {
  FREEZER_URL: string
  SHIPPER_ID: string
  DWK: string
  SIGNING_KEY: string // Ed25519 private JWK (JSON-serialized), secret
}

// ── Event shape ────────────────────────────────────────────────────

interface LogEvent {
  service: string
  event: string
  timestamp: string
  event_id: string
  level: number
  msg?: string
  [k: string]: unknown
}

// ── Key handling (cold-start cached) ───────────────────────────────

let signingKeyCache: JsonWebKey | undefined
let publicJwkCache: (JsonWebKey & { kid: string }) | undefined

function getSigningKey(env: Env): JsonWebKey {
  if (signingKeyCache) return signingKeyCache
  const parsed = JSON.parse(env.SIGNING_KEY) as JsonWebKey
  signingKeyCache = parsed
  return parsed
}

async function getPublicJwk(env: Env): Promise<JsonWebKey & { kid: string }> {
  if (publicJwkCache) return publicJwkCache
  const sk = getSigningKey(env)
  // Extract public members only — kid is the thumbprint per the
  // convention used by playground/whoami.
  const pub: JsonWebKey = { kty: sk.kty }
  if (sk.crv !== undefined) pub.crv = sk.crv
  if (sk.x !== undefined) pub.x = sk.x
  if (sk.y !== undefined) pub.y = sk.y
  if (sk.n !== undefined) pub.n = sk.n
  if (sk.e !== undefined) pub.e = sk.e
  const kid = await calculateThumbprint(pub)
  publicJwkCache = { ...pub, kid }
  return publicJwkCache
}

// ── HTTP routes (served on shipper.aauth.dev) ──────────────────────
//
// These exist so Freezer can verify our signatures: jwks_uri scheme
// resolves the public key by fetching
//   ${SHIPPER_ID}/.well-known/${DWK}    ->  aauth-resource.json
// then following the embedded jwks_uri to /.well-known/jwks.json.

const app = new Hono<{ Bindings: Env }>()

app.get('/.well-known/aauth-resource.json', (c) => {
  const id = c.env.SHIPPER_ID
  return c.json({
    issuer: id,
    jwks_uri: `${id}/.well-known/jwks.json`,
    client_name: 'AAuth Event Shipper',
    description: 'Cloudflare Worker that ships AAuth telemetry events to Freezer.',
  })
})

app.get('/.well-known/jwks.json', async (c) => {
  const publicJwk = await getPublicJwk(c.env)
  return c.json({ keys: [publicJwk] })
})

app.get('/', (c) => c.text('shipper.aauth.dev — AAuth event shipper. See /.well-known/aauth-resource.json'))

// ── Queue consumer (signs + POSTs to Freezer) ──────────────────────

async function postSignedToFreezer(env: Env, body: string): Promise<Response> {
  const signingKey = getSigningKey(env)
  const publicJwk = await getPublicJwk(env)

  // Defaults for a POST body components are
  //   ['@method', '@authority', '@path', 'content-type', 'signature-key']
  // We do NOT add content-digest — see EVENT-LOGGING-PLAN.md.
  const result = await signedFetch(env.FREEZER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body,
    signingKey,
    signatureKey: {
      type: 'jwks_uri',
      id: env.SHIPPER_ID,
      kid: publicJwk.kid,
      dwk: env.DWK,
    },
  })
  return result as Response
}

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<LogEvent>, env: Env): Promise<void> {
    // Per-message try/catch on the inner loop so a single poison
    // event can't fault the batch and force re-delivery of everything.
    const events: LogEvent[] = []
    const msgs: Message<LogEvent>[] = []
    for (const msg of batch.messages) {
      try {
        const e = msg.body
        if (!e || typeof e !== 'object' || typeof e.service !== 'string' || typeof e.event !== 'string') {
          console.error('poison_message_bad_shape', { event_id: e?.event_id })
          msg.ack()
          continue
        }
        events.push(e)
        msgs.push(msg)
      } catch (err) {
        console.error('poison_message_grouping_failed', { error: String(err) })
        msg.ack()
      }
    }

    if (events.length === 0) return

    console.log('shipper batch', {
      size: events.length,
      services: [...new Set(events.map(e => e.service))],
      freezer_url: env.FREEZER_URL,
    })

    let body: string
    try {
      body = events.map(e => JSON.stringify(e)).join('\n')
    } catch (err) {
      console.error('ndjson_serialize_failed', { error: String(err), count: msgs.length })
      for (const m of msgs) m.ack()
      return
    }

    let response: Response
    try {
      response = await postSignedToFreezer(env, body)
    } catch (err) {
      // Network error, signing-time failure (e.g. transient JWKS
      // discovery issue inside @hellocoop/httpsig). Could be transient.
      console.error('freezer_request_error', { error: String(err), count: msgs.length })
      for (const m of msgs) m.retry()
      return
    }

    if (response.ok) {
      console.log('freezer_accepted', { status: response.status, count: msgs.length })
      for (const m of msgs) m.ack()
      return
    }

    const detail = await response.text().catch(() => '')

    if (response.status >= 500 || response.status === 404) {
      // Transient. 5xx = server error. 404 = ingest endpoint not
      // deployed yet (or temporarily missing) — retry within the
      // ~1h budget rather than dropping the batch, since the
      // endpoint will likely come back and the same payload will
      // succeed unchanged.
      const tag = response.status === 404 ? 'freezer_404' : 'freezer_5xx'
      console.error(tag, {
        status: response.status,
        detail: detail.slice(0, 500),
        count: msgs.length,
      })
      for (const m of msgs) m.retry()
    } else {
      // Other 4xx (400, 401, 403, 413, 422, ...): Freezer received
      // the request and rejected the payload. Retrying won't help —
      // ack so we don't burn the retry budget on poison.
      console.error('freezer_4xx', {
        status: response.status,
        detail: detail.slice(0, 500),
        count: msgs.length,
      })
      for (const m of msgs) m.ack()
    }
  },
}
