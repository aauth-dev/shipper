# shipper

Cloudflare Worker that ships AAuth telemetry events to Freezer.

Consumes the `aauth-events` queue (fed by `playground.aauth.dev` and
`whoami.aauth.dev`), groups each batch into NDJSON, signs the POST
with AAuth HTTP Message Signatures using its own
`shipper.aauth.dev` identity (jwks_uri scheme), and sends to Freezer
ingest.

The Worker also serves its own `/.well-known/aauth-resource.json` and
`/.well-known/jwks.json` so Freezer can resolve the public key chain
to verify the signature.

## One-time setup

```bash
npm install
npm run generate-key                  # mint Ed25519 keypair, print JWK
npx wrangler secret put SIGNING_KEY   # paste the JWK
npx wrangler deploy
```

Then on Freezer side, allowlist `https://shipper.aauth.dev`.

## Verify

```bash
curl -s https://shipper.aauth.dev/.well-known/aauth-resource.json | jq .
curl -s https://shipper.aauth.dev/.well-known/jwks.json | jq .
npm run tail                          # watch live events as they ship
```

## Configuration

Set in `wrangler.toml`:

- `FREEZER_URL` — currently `https://freezer.hello-beta.net/api/v1/ingest`
- `SHIPPER_ID` — signer identity (`https://shipper.aauth.dev`)
- `DWK` — well-known path suffix (`aauth-resource.json`)

Secret:

- `SIGNING_KEY` — Ed25519 private JWK (JSON-serialized)

## Behavior

- Consumes `aauth-events` in batches up to 100 / 30s.
- POSTs each batch as one NDJSON request to `FREEZER_URL`.
- **2xx**: ack.
- **5xx**: retry (up to 12 × 300s = ~1 hour) then to DLQ
  (`aauth-events-dlq`).
- **4xx**: ack (poison — retrying won't help; Freezer rejected the
  payload).
- **Network / signing failure**: retry.

See `AAuth-dev/EVENT-LOGGING-PLAN.md` and
`AAuth-dev/FREEZER-INGEST-PLAN.md` for the broader design.
