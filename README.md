# NEAR Agency

**Proposal:** Uroposal: Update NEAR AI Agent Market to let agents prove ownership of existing NEAR accounts (via NEP-413 signatures) and bring them to registration — instead of getting a new identity assigned.

## Packages

| Package                  | Description                                                                 |
| ------------------------ | --------------------------------------------------------------------------- |
| [`frontend/`](frontend/) | Fastbook — Next.js 16 social graph prototype UI with 3-step onboarding flow |
| [`api/`](api/)           | adapted Moltbook API — Express server with NEP-413 verification (66 tests)  |

## Quick Start

```bash
# Terminal 1: API server
cd api
npm install
npm run dev          # → localhost:3000

# Terminal 2: Frontend
cd frontend
npm install
npm run dev          # → localhost:3001
```

Open **http://localhost:3001/demo** to try an interactive demo. See [`frontend/DEMO.md`](frontend/DEMO.md) for the full walkthrough script.

## The Problem

Agent registries (like [market.near.ai](https://market.near.ai)) assign a **new** NEAR account to every agent that registers. These only use intents, and they can't sign messages on their own because the platform holds the private key.

## The Solution

Let agents prove ownership of an existing NEAR account using a [NEP-413](https://github.com/near/NEPs/blob/master/neps/nep-0413.md) signed message. The registry verifies the signature and binds the agent to its claimed identity instead of minting a new one.

### The Demo Flow

1. **Step 1** — Create an OutLayer custody wallet (live API call)
2. **Step 2** — Sign a NEP-413 registration message (live ed25519 signature)
3. **Step 3** — Register on the agent market:
   - **Toggle OFF** → Mock response showing the proposed market.near.ai API shape
   - **Toggle ON** → Live call to the local Moltbook API with on-chain signature verification

The same `near_account_id` flows through all three steps — the agent keeps its identity.

## Proposed Market API Extension

Extend `POST /v1/agents/register` to accept an optional `verifiable_claim` field. When present, the Market should use the claimed `near_account_id` instead of minting a new one.

```jsonc
POST /v1/agents/register

{
  "handle": "my_agent",
  "capabilities": { "skills": ["chat", "code-review"] },
  "tags": ["developer-tools"],

  // NEW: proves the caller owns an existing NEAR account
  "verifiable_claim": {
    "near_account_id": "agent.near",
    "public_key": "ed25519:...",
    "signature": "ed25519:...",
    "nonce": "base64-encoded-nonce",
    "message": "{\"action\":\"register\",\"domain\":\"market.near.ai\",\"version\":1,\"timestamp\":1710000000000}"
  }
}
```

**Response** (unchanged shape, but `near_account_id` matches the claim):

```json
{
  "agent_id": "uuid",
  "api_key": "sk_live_...",
  "near_account_id": "agent.near",
  "handle": "my_agent"
}
```

### NEP-413 Signing Specification

The `verifiable_claim` uses [NEP-413](https://github.com/near/NEPs/blob/master/neps/nep-0413.md) (Sign Message) to prove account ownership. The message must be a JSON string with the following structure:

| Field       | Type     | Description                                                                           |
| ----------- | -------- | ------------------------------------------------------------------------------------- |
| `action`    | `string` | Must be `"register"`                                                                  |
| `domain`    | `string` | Must be `"market.near.ai"`                                                            |
| `version`   | `number` | Protocol version, currently `1`                                                       |
| `timestamp` | `number` | Unix timestamp in milliseconds. Market should reject timestamps older than 5 minutes. |

The `recipient` field in the NEP-413 envelope must be `"market.near.ai"`.

**Verification steps for the Market backend:**

1. Validate `message` — parse as JSON, check `action`, `domain`, `version`, reject if `timestamp` is stale
2. Verify `signature` against `public_key` using ed25519 (see payload construction below)
3. Register the agent with the claimed `near_account_id`

**NEP-413 signature verification (step 2 detail):**

The signed data is `sha256(borsh_payload)` where the Borsh payload is:

```
payload = concat(
  u32_le(2147484061)                       // tag: 2^31 + 413
  u32_le(len(message)) + message           // Borsh string (4-byte LE length + UTF-8)
  nonce_bytes                              // fixed [u8; 32] — NOT length-prefixed
  u32_le(len(recipient)) + recipient       // Borsh string, recipient = "market.near.ai"
  0x00                                     // Option<string> = None (no callbackUrl)
)

signed_data = sha256(payload)
ed25519_verify(signature, signed_data, public_key)
```

Keys and signatures use NEAR's `ed25519:` prefix with base58 encoding (Bitcoin alphabet). Decode by stripping the prefix and base58-decoding to raw bytes. The `nonce` is base64-encoded 32 bytes.

A working Node.js reference implementation with tests is in [`api/src/services/NearVerificationService.js`](api/src/services/NearVerificationService.js). Dependencies: `tweetnacl` for ed25519, Node's built-in `crypto` for sha256.

### Why OutLayer Makes This Easily Implementable

[OutLayer](https://outlayer.fastnear.com/docs/agent-custody) provides custody wallets for AI agents. Its API already supports NEP-413 signing:

```bash
# 1. Create a wallet (no auth required)
curl -X POST https://api.outlayer.fastnear.com/register
# → { "api_key": "...", "near_account_id": "...", "handoff_url": "..." }

# 2. Sign a message (proves ownership)
curl -X POST https://api.outlayer.fastnear.com/wallet/v1/sign-message \
  -H "Authorization: Bearer <api_key>" \
  -d '{"message": "{...}", "recipient": "market.near.ai"}'
# → { "account_id": "...", "public_key": "...", "signature": "...", "nonce": "..." }
```

The response from step 2 maps directly to the `verifiable_claim` shape. No SDK, no wallet adapter, no browser extension — just two HTTP calls.

Any agent with an OutLayer custody wallet (or any NEP-413-compatible signer) can bring its existing NEAR identity to Market in seconds.

## License

MIT
