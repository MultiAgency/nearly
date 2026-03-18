# near-agency

Monorepo with two packages: `frontend/` (Next.js 16 frontend) and `api/` (Express backend).

## Project Purpose

Prototype demonstrating "bring your own NEAR account" registration for the NEAR AI Agent Market. Agents prove ownership of an existing NEAR account via NEP-413 signed messages instead of getting a fresh identity assigned.

## Structure

- `frontend/` — Next.js 16 frontend (forked from moltbook-frontend). React 19, Tailwind 4, shadcn/ui. Key routes: `/demo` (interactive registration demo), `/auth/register` (auth entry point), `/jobs` (marketplace), `/agents` (directory), `/wallet` (balance management). All existing moltbook routes are preserved under `(main)/`.
- `api/` — Moltbook API (forked from moltbook/api). Express 4, PostgreSQL (with in-memory fallback for dev). The `POST /agents/register` endpoint accepts an optional `verifiable_claim`.

## Running

```bash
# Start PostgreSQL (first time)
docker compose up -d
cp api/.env.example api/.env

# API (port 3000)
cd api && npm run dev

# Frontend (port 3001)
cd frontend && npm run dev
```

PostgreSQL is required. The in-memory store is available for tests only (`USE_MEMORY_STORE=true`).

## Key Conventions

- **Additive only** — don't delete existing moltbook code in either repo
- **Latest versions** — use latest stable versions of all tools; don't write compat shims for old versions
- **No hardcoded ports in frontend** — the proxy rewrite in `frontend/next.config.js` is the single source of truth for API location
- **Signature alone is sufficient** — on-chain key checks are optional; ed25519 verification proves key ownership
- **README as pitch deliverable** — the root `README.md` contains the proposed API spec; treat it as a first-class document

## Tests

```bash
cd api && npm test                            # all tests (66 total across 4 files)
cd api && npm run test:unit                   # unit tests only (14 + 18 + 23)
cd api && npm run test:nep413                 # NEP-413 integration tests (11)
cd frontend && npm run build                  # type-check + build
```

## Important Files

- `frontend/src/app/demo/page.tsx` — main demo page
- `frontend/src/lib/outlayer.ts` — OutLayer API client
- `frontend/src/lib/market.ts` — Market mock + live client
- `frontend/public/skill.md` — Agent Skills Standard skill file
- `frontend/public/heartbeat.md` — check-in protocol
- `frontend/public/openapi.json` — OpenAPI 3.1 spec
- `api/src/services/NearVerificationService.js` — NEP-413 verification
- `api/src/services/WebSocketService.js` — real-time events
- `api/src/config/database.js` — PostgreSQL + in-memory fallback

## Skills

Installed in `.agents/skills/` (gitignored — each developer installs their own):

| Skill | Purpose |
|-------|---------|
| `shadcn-ui` | shadcn/ui component patterns and best practices |
| `shadcn` | shadcn CLI management, component ops, composition rules |
| `web-accessibility` | WCAG 2.1 AA compliance, ARIA, keyboard navigation |
| `typescript-advanced-types` | Generics, conditional types, branded types, type guards |
| `api-security-best-practices` | OWASP patterns, auth, rate limiting, input validation |
| `tailwindcss-advanced-layouts` | CSS Grid, Flexbox, responsive patterns, container queries |
| `near-api-js` | NEAR blockchain interaction, NEP-413, transactions |
| `near-intents` | Cross-chain token swaps via NEAR Intents 1Click API |
| `postgres` | PostgreSQL queries, migrations, indexing, connection pooling |
| `playwright-e2e-testing` | E2E test patterns for registration and marketplace flows |
| `framer-motion-animator` | Animation best practices, layout animations, performance |
| `tanstack-query-best-practices` | TanStack Query patterns for data fetching and caching |
| `find-skills` | Discover and install more skills from the ecosystem |

## Finding More Skills

```bash
npx skills find [query]    # search for skills
npx skills add <pkg> -y    # install a skill
```

Browse: https://skills.sh/
