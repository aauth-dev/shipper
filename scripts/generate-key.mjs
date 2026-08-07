#!/usr/bin/env node

// Generate an Ed25519 key pair for AAuth signature signing.
// Run: node scripts/generate-key.mjs
// Then set as a Cloudflare secret: wrangler secret put SIGNING_KEY

import { webcrypto } from 'node:crypto'

const keyPair = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
const privateJwk = await webcrypto.subtle.exportKey('jwk', keyPair.privateKey)
// httpsig 2.0 (draft -08, RFC 9864) requires a fully-specified alg on
// every JWK; WebCrypto's exportKey does not set it.
privateJwk.alg = 'Ed25519'

console.log('Private JWK (set as SIGNING_KEY secret):')
console.log(JSON.stringify(privateJwk))
