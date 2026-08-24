# Architecture

How the Mind Block monorepo is laid out, what each piece is responsible for, and
how a request travels through the system. For the domain entities themselves,
read [CANONICAL_DOMAIN_MODEL.md](./CANONICAL_DOMAIN_MODEL.md), which is the
authoritative specification.

---

## 1. High-level shape

```text
                 +---------------------------+
                 |  Frontend (Next.js 16)    |
                 |  App Router, React 19,    |
                 |  Redux Toolkit, Tailwind  |
                 +-------------+-------------+
                               | HTTPS / JSON
                               v
                 +---------------------------+          +--------------+
                 |  Backend (NestJS 11)      |<-------->|  PostgreSQL  |
                 |  REST API, JWT auth,      |  TypeORM +--------------+
                 |  domain modules, Swagger  |
                 +---+----------+-------+----+           +--------------+
                     |          |<------------------->|    Redis     |
                     |          |             ioredis +--------------+
          +----------+-----+  +-+---------------------+-+
          v                v  v                         v
+------------------+  +---------------------+  +------------------------+
| Stellar wallet   |  | AI Services         |  | Blockchain Service     |
| auth & linking   |  | (planned — no code  |  | (Soroban contract,     |
| (off-chain)      |  |  in the repo yet)   |  |  on-chain rewards)     |
+---------+--------+  +---------------------+  +-----------+------------+
          ^                                                |
          | Freighter, xBull, Albedo                       v
+------------------+                            +----------------------+
| Player's wallet  |                            | StarkNet / Soroban   |
+------------------+                            +----------------------+
```

The frontend never talks to the database. All scoring, verification, and reward
eligibility are decided by the backend, which is the single authority.

---

## 2. Repository layout

```text
mindBlock_app/
├── backend/          NestJS API (TypeScript)
│   ├── src/
│   │   ├── analytics/          Event tracking, funnels, retention
│   │   ├── auth/               Sign-in, JWT, guest sessions, wallet + Google auth
│   │   ├── blockchain/         Stellar wallet linking and on-chain interaction
│   │   ├── categories/         Puzzle categories
│   │   ├── challenge-attempt/  Per-challenge execution ledger
│   │   ├── common/             Filters, middleware, pagination, shared helpers
│   │   ├── config/             appConfig and databaseConfig registrations
│   │   ├── database/migrations/ TypeORM migrations
│   │   ├── domain/             Canonical enums and domain interfaces
│   │   ├── game-sessions/      Play-through lifecycle
│   │   ├── health/             Liveness, readiness, detailed health
│   │   ├── progress/           Progress history and statistics
│   │   ├── puzzles/            Puzzle content
│   │   ├── quests/             Daily quest system
│   │   ├── redis/              Redis client provider
│   │   ├── rewards/            Reward logic
│   │   ├── roles/              Role decorator and guard
│   │   ├── score/              Scoring helpers
│   │   ├── streak/             Daily streak tracking
│   │   ├── users/              User accounts and profiles
│   │   ├── app.module.ts       Root module and global middleware wiring
│   │   └── main.ts             Bootstrap, Swagger, CORS, graceful shutdown
│   ├── test/                   E2E specs
│   └── data-source.ts          Standalone TypeORM CLI data source
├── frontend/         Next.js App Router client
│   ├── app/                    Routes: auth, dashboard, puzzles, quiz, streak, ...
│   ├── components/, src/components/  UI components
│   ├── features/, lib/features/      Feature-scoped state and logic
│   ├── lib/                    api clients, stellar helpers, analytics, utils
│   ├── hooks/, providers/, styles/
│   └── docs/                   Design tokens and onboarding integration notes
├── contract/         Soroban smart contract (Rust)
├── shared/           Cross-package types and legacy network config
├── docs/             This documentation set
└── .github/workflows/ CI and CI/CD pipelines
```

The root `package.json` declares npm workspaces. `frontend` and `backend` are
the two that exist today; the `contracts` and `middleware` entries in that list
are historical and do not correspond to directories (the Rust crate lives in
`contract/`, singular, and is built by cargo rather than npm).

---

## 3. Backend

### Framework and layering

NestJS 11 with the standard module / controller / provider layering:

- **Module** wires a feature's dependencies (`puzzles.module.ts`).
- **Controller** owns HTTP: routing, DTO binding, Swagger annotations (`puzzles.controller.ts`).
- **Provider / service** holds business logic. Larger features split logic into one provider per use case under `providers/` (see `auth/providers/` and `analytics/providers/`).
- **Entity** is the TypeORM persistence model (`entities/*.entity.ts`).
- **DTO** defines and validates the request and response contract with `class-validator` (`dtos/*.dto.ts`).

Keep HTTP concerns in controllers and business rules in providers; controllers
should stay thin.

### Request lifecycle

```text
HTTP request
  -> CorrelationIdMiddleware   stamps a correlation ID for tracing
  -> GeolocationMiddleware     resolves coarse location from the IP (geoip-lite)
  -> JwtAuthMiddleware         verifies the bearer token, unless the route is public
  -> Guards                    RolesGuard, AnalyticsAdminGuard where declared
  -> ValidationPipe (global)   whitelist + forbidNonWhitelisted + transform
  -> Controller handler
  -> Provider / service        business rules
  -> TypeORM repository        PostgreSQL
  -> Response
  (any throw) -> AllExceptionsFilter -> structured JSON error
```

Public prefixes excluded from `JwtAuthMiddleware` are `/auth/*`, `/api`,
`/docs`, and `/health`. Everything else needs a token. See
[API.md](./API.md#authentication).

### Cross-cutting concerns

| Concern | Implementation |
| ------- | -------------- |
| Configuration | `@nestjs/config` with `registerAs` namespaces: `appConfig`, `database`, `jwt`. Global module, loaded from `backend/.env`. |
| Persistence | TypeORM over PostgreSQL, configured asynchronously in `app.module.ts`. `DATABASE_URL` takes priority over the discrete `DATABASE_*` variables. |
| Caching and sessions | `ioredis` through a single `REDIS_CLIENT` provider in `redis/redis.provider.ts`. |
| Auth | JWT access and refresh tokens, plus Stellar wallet signatures and Google OAuth. |
| Authorization | `@Roles()` decorator with `RolesGuard`; analytics has its own admin guard. |
| Rate limiting | `@nestjs/throttler`, applied per route with `@Throttle`. |
| Scheduled work | `@nestjs/schedule` (`ScheduleModule.forRoot()`), for example daily quest rollovers. |
| Events | `@nestjs/event-emitter`, so side effects such as progress updates, streak evaluation, and reward minting stay decoupled from the request path. |
| Documentation | `@nestjs/swagger`, served at `/api`. |
| Error handling | `AllExceptionsFilter` catches every throwable, not only `HttpException`. |
| Shutdown | `SIGTERM` and `SIGINT` flip health checks to unhealthy, wait for load balancers to drain, then close the app. |

### Domain flow

A typical play-through:

```text
POST /game-sessions            create a GameSession (authenticated or guest)
POST /challenge-attempts       open an attempt for a challenge in that session
POST /challenge-attempts/submit  answer; the backend grades it
  -> emits domain events: progress update, streak evaluation, reward check
PATCH /game-sessions/:id/status  close the session with score and XP
GET  /progress/stats           read back aggregates
```

Guest players get the same flow through a guest session (15 minutes, at most two
hints) and can convert to a real account via `POST /auth/convert-guest` without
losing progress.

---

## 4. Authentication architecture

Four ways to sign in exist today, all funneling into the same JWT machinery.

| Method | Route(s) | Mechanism |
| ------ | -------- | --------- |
| Email + password | `POST /auth/register`, `POST /auth/signIn` | bcryptjs (salt rounds 10); unknown email and wrong password return the identical error, with a dummy-hash compare to flatten timing differences. Both routes throttled to 5 req/min/IP. |
| Google OAuth | `POST /auth/google-authentication` | The client obtains a Google ID token; the backend verifies it with `google-auth-library`'s `OAuth2Client.verifyIdToken` and matches or auto-provisions the user by `googleId`. No server-side redirect flow; the installed `passport-google-oauth20` package is currently unused. |
| Stellar wallet signature | `GET /auth/stellar-wallet-nonce`, `POST /auth/stellar-wallet-login` | Single-use nonce (format `stellar_nonce_{timestamp}_{random}_{suffix}`, 5-minute TTL). The client signs `Stellar Signed Message:\n{nonce}` with their wallet; the backend hashes it with SHA-256 and verifies the ed25519 signature via `stellar-sdk`. Unknown wallets are auto-registered (`stellar_user_{last6}`, provider `wallet`). Returns an access token only — no refresh token or session row. |
| Guest session | `POST /auth/guest-session`, `POST /auth/convert-guest` | In-memory session (`guest_{uuid}`) valid 15 minutes with at most 2 hints (`POST /auth/guest-session/:sessionId/hint`). Conversion flips the role to USER in place. |

### Tokens and sessions

- **JWT**: access tokens default to 3600 s, refresh tokens to 7 days, signed
  with `JWT_SECRET` and audience/issuer claims; `JwtStrategy` validates every
  Bearer token.
- **Refresh rotation**: only the SHA-256 hash of the refresh token is stored,
  in the `Session` entity. Refreshing invalidates the old session row and mints
  a new pair; `logout` deactivates one session, `logout-all` deactivates all.
- **Redis blacklist**: `JwtAuthMiddleware` consults a per-token blacklist key
  before verifying. Nothing writes those keys yet — DB session rows are the
  effective revocation mechanism today.
- **Password reset**: a random 32-byte hex token is stored hashed with a
  1-hour expiry and delivered by SMTP (`MAIL_*` configuration).
- **Rate limiting**: a global 10 req/min throttler applies everywhere, with
  stricter per-route limits on credential endpoints.

> **Known limitation.** Guest sessions, conversion state, and login nonces live
> in in-memory Maps: they do not survive restarts and are not safe across
> multiple instances. Moving them to Redis is straightforward when needed.

---

## 5. Game-session architecture

A `GameSession` is one play-through. Its lifecycle is a strict state machine —
transitions live in the `SESSION_TRANSITIONS` map in
`game-sessions.service.ts`, and an illegal transition is rejected with a `400`.

```text
CREATED ──> ACTIVE ──> PAUSED ──> ACTIVE
              │  │        │
              │  │        └──> ABANDONED / EXPIRED
              │  └──> COMPLETED / ABANDONED / EXPIRED
              └──> (COMPLETED, EXPIRED, ABANDONED are terminal)
```

Status values (`GameSessionStatus`): `CREATED`, `ACTIVE`, `PAUSED`,
`COMPLETED`, `EXPIRED`, `ABANDONED`.

The owning client drives transitions via `PATCH /game-sessions/:id/status`
(ownership checked, including guest play through a `guestId`). On the first
`ACTIVE` the backend stamps `startedAt`; terminal states stamp `completedAt`.
When a session completes, `SessionSummaryProvider.buildCompletionStats`
recomputes everything from persisted `ChallengeAttempt` rows — total score, XP
(`XP_PER_SCORE_POINT = 1`, a documented placeholder), accuracy percentage,
time spent, and per-category performance stored as jsonb — then updates the
streak and evaluates reward eligibility. Client-supplied score/XP values are
fallbacks used only when a session has zero tracked attempts. A scheduled
helper, `expireIdleSessions(30)`, sweeps stale `ACTIVE`/`PAUSED` sessions to
`EXPIRED`.

---

## 6. Challenge lifecycle

Each answered puzzle is a `ChallengeAttempt` with status `AttemptStatus`:
`STARTED`, `SUBMITTED`, `CORRECT`, `INCORRECT`, `EXPIRED`. (`SUBMITTED` is
defined but never assigned; grading moves an attempt straight from `STARTED` to
`CORRECT` or `INCORRECT`.)

```text
POST /challenge-attempts            open attempt (STARTED)
POST /challenge-attempts/submit     grade answer -> CORRECT | INCORRECT
PATCH /challenge-attempts/hint      increments hintsUsed (max enforced upstream)
PATCH /challenge-attempts/reveal    solution shown -> INCORRECT, score zeroed
PATCH /challenge-attempts/:id/expire  -> EXPIRED
```

Submission runs in a TypeORM transaction holding a `pessimistic_write` lock on
the attempt row and is idempotent: replaying a graded submission returns the
cached result (`isDuplicateReplay`) instead of re-awarding anything. Answers
are graded by case-insensitive trimmed comparison against
`puzzle.correctAnswer`. Correct answers earn
`round(basePoints * (1 + bonus))` where the speed bonus is
`((timeLimit - timeSpent) / timeLimit) * 0.5` — up to +50%. Revealing the
solution forfeits the score immediately.

On a correct answer, in the same transaction: `XpLevelService.addXp(score)`
(XP equals score, 1:1), a `UserProgress` row is written, and the next
same-difficulty challenge is selected pseudo-randomly, excluding already
attempted puzzles. When the session's `challengeCount` target is reached
(default 5), the attempt is flagged `sessionCompleted`.

---

## 7. Progress tracking

Every graded submission appends one `UserProgress` row (user, puzzle/category,
optional daily quest link, correctness, answer, points earned, time spent).
The primary write path is inside the attempt transaction described above — a
direct service call, not event-driven, today. Reads are served by
`GET /progress` (paginated history), `GET /progress/stats` (totals, accuracy,
points, time), and `GET /progress/category/:id` (per-category breakdown).

A secondary pipeline in `progress-calculation.provider.ts` adds streak
multipliers (+10% at a 3-day streak, +25% at 7 days) and daily-quest completion
bonuses on its own path.

---

## 8. Reward architecture

Rewards are currently **eligibility-only**. `RewardService.checkEligibility({score, xp, correct})`
returns `{eligible, reason}`: ineligible if the answer was wrong or the score
is below `MINIMUM_SCORE_FOR_REWARD` (100); eligible otherwise. The verdict is
persisted on the completed session as `rewardEligible` / `rewardReason`.

No minting, transfer, reward record persistence, or chain call exists yet —
the richer canonical reward types (TOKEN, NFT, BADGE) in `src/domain` are
aspirational. Wiring eligibility results to on-chain redemption is the next
step (see [Blockchain integration](#9-blockchain-integration)).

---

## 9. Blockchain integration

Two distinct concerns, deliberately kept apart:

### Wallet linking and wallet authentication (off-chain, shipped)

- `users.stellarWallet` associates a wallet address with an account; it is set
  during wallet login (see [Authentication](#4-authentication-architecture)).
- `POST /blockchain/wallet/link` validates the address string and emits
  `wallet_linked` / `wallet_link_failed` events, consumed by the analytics
  listener into `analytics_events`. It performs no chain interaction.
- Login signature verification is pure ed25519 over a server-issued nonce —
  the smart contract is not involved.

### Soroban contract (on-chain, partially wired)

`contract/` is a Soroban contract built with `soroban-sdk` 23 and deployed to
the Stellar testnet; it backs on-chain rewards for challenge completion. The
release profile is tuned for wasm size (`opt-level = "z"`, LTO, symbols
stripped, `panic = "abort"`), and `ed25519-dalek` is pinned to `=2.2.0` for
reasons explained in its `Cargo.toml`.

The backend carries the configuration (`STELLAR_SECRET_KEY`,
`STELLAR_CONTRACT_ID`, `STELLAR_RPC_URL` defaulting to the public testnet RPC,
and `STELLAR_NETWORK_PASSPHRASE`) and `stellar-sdk`, but the dedicated
providers — register-player, submit-puzzle, get-player, sync-xp-milestone —
are still pending. Until they land, nothing in the runtime talks to the
contract.

---

## 10. AI integration (planned)

The target architecture reserves an AI Services slot beside the backend. There
is **no AI code in the repository today** — no LLM SDKs, no generation or hint
services. Planned roles are puzzle generation, difficulty tuning, and hint
assistance. When implementation starts it should live behind its own NestJS
module with the usual provider-per-use-case layering, and this section should
be updated to describe what actually shipped.

---

## 11. Frontend

- **Next.js 16 App Router** with React 19; routes are directories under `frontend/app/`.
- **State**: Redux Toolkit with `react-redux` for app state, TanStack Query for server state.
- **Styling**: Tailwind CSS v4 with `class-variance-authority`, `clsx`, and `tailwind-merge`; design tokens are documented in `frontend/docs/DESIGN_TOKENS.md`.
- **UI primitives**: Radix (avatar, slot, tabs), `lucide-react` icons, `framer-motion` animation, `recharts` charts, `@monaco-editor/react` for coding challenges.
- **Wallets**: `@stellar/freighter-api` plus `stellar-sdk`; wallet helpers live in `frontend/lib/stellar/`.
- **API access**: `frontend/lib/api/` against `NEXT_PUBLIC_API_URL`.

The backend is the source of truth for scoring, so the client renders state and
submits intent rather than computing outcomes.

---

## 12. Data stores

### PostgreSQL

The system of record: users, puzzles, categories, game sessions, challenge
attempts, progress, quests, streaks, analytics events. Accessed only through
TypeORM repositories.

Schema management is currently in transition: local development leans on
`synchronize`, while `backend/src/database/migrations/` holds explicit
migrations. The caveats are spelled out in
[DEVELOPMENT.md](./DEVELOPMENT.md#9-migrations).

### Redis

Session and token state for the JWT middleware, including blacklisting, plus
caching for hot reads. A missing `REDIS_URL` is fatal at boot by design, so
failures show up immediately rather than at first cache read.

---

## 13. External services

| Service | Used for | Configuration |
| ------- | -------- | ------------- |
| PostgreSQL ≥ 14 | System of record | `DATABASE_URL` or discrete `DATABASE_*` variables |
| Redis ≥ 6 | Token/session cache, GeoIP result cache | `REDIS_URL` (required at boot) |
| Google Identity | Verifying OAuth ID tokens at sign-in | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` |
| SMTP relay | Password-reset email delivery | `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, `MAIL_USER`, `MAIL_PASSWORD`, `MAIL_FROM_NAME`, `MAIL_FROM_ADDRESS` |
| Stellar public RPC (testnet) | Soroban deployment/RPC target | `STELLAR_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE`, `STELLAR_CONTRACT_ID`, `STELLAR_SECRET_KEY` |
| geoip-lite (bundled MaxMind DB) | Offline IP-to-country lookup for geolocation middleware | None — ships as a local dataset |

Hosting (Render for the backend, Vercel for the frontend) is covered under
[Deployment](#16-deployment).

---

## 14. Development environments

Prerequisites: Node.js 20.x LTS, npm 10 (workspaces), PostgreSQL ≥ 14,
Redis ≥ 6. Rust with the `wasm32-unknown-unknown` target and the Stellar CLI
are only required for `contract/` work. Docker is typically used as one-off
containers (`postgres:16` on 5432, `redis:7` on 6379) rather than a compose
stack.

- **Backend**: `cd backend && npm run start:dev` — serves on port 3000 with
  Swagger at `/api` and health at `/health`. With `DATABASE_SYNC=true`,
  TypeORM creates the schema on first boot, which is the normal local setup.
- **Frontend**: `cd frontend && npm run dev` (Next.js + Turbopack; falls back
  to port 3001 when 3000 is taken). Point `NEXT_PUBLIC_API_URL` at the backend
  via `frontend/.env.local`. Root-level `npm run dev:backend` /
  `npm run dev:frontend` wrap the two.
- **Contract**: build/test with cargo from `contract/`; deploy to testnet with
  the Stellar CLI.

Migration workflows and their current rough edges are documented in
[DEVELOPMENT.md §9](./DEVELOPMENT.md#9-migrations); environment variables are
catalogued in [ENVIRONMENT.md](./ENVIRONMENT.md).

---

## 15. Communication between services

- **Frontend ⇄ Backend**: synchronous HTTPS + JSON REST with Bearer JWTs. No
  websockets or SSE anywhere yet.
- **Backend ⇄ PostgreSQL**: exclusively through TypeORM repositories.
- **Backend ⇄ Redis**: a single shared ioredis client (`REDIS_CLIENT`).
- **Inside the backend**: `EventEmitter2` domain events decouple side effects
  (progress, streaks, analytics listeners) from request handlers;
  `@nestjs/schedule` cron jobs perform nightly analytics rollups.
- **Backend ⇄ Chain**: planned Soroban provider calls over the Stellar RPC
  (see [Blockchain integration](#9-blockchain-integration)).

---

## 16. Deployment

| Component | Host | Notes |
| --------- | ---- | ----- |
| Backend | Render | Uses `DATABASE_URL`; `npm run build` then `npm run start:prod`. |
| Frontend | Vercel | `next build`; `NEXT_PUBLIC_API_URL` points at the Render backend. |
| Contract | Stellar testnet | Deployed with the Stellar CLI. |

`/health/ready` is the readiness probe; it reports unhealthy during shutdown so
traffic drains before the process exits.

---

## 17. Conventions that shape the code

1. **Relative imports only.** Absolute `src/...` imports are rejected by CI.
2. **DTOs are the contract.** `forbidNonWhitelisted` means an undeclared field is a `400`, so every accepted field must exist on a DTO.
3. **One provider per use case.** Prefer a new provider over growing a service past its purpose.
4. **Events for side effects.** Progress, streaks, achievements, and minting react to domain events instead of being inlined into request handlers.
5. **Backend decides.** Never move scoring or reward eligibility into the client.
6. **Swagger annotations are mandatory** on new endpoints, so `/api` stays complete.

---

## 18. Where does a new feature belong?

Use this decision list to place new work:

- **Pure UI/UX change** (layout, styling, client-only interactions) → a route
  under `frontend/app/` or a component in `frontend/components/`.
- **New player-facing capability with data** → a new NestJS module under
  `backend/src/<feature>/` following the module / controller / providers /
  entities / dtos layering, registered in `app.module.ts`.
- **Cross-cutting plumbing** (filters, middleware, pagination helpers) →
  `backend/src/common/`.
- **Scoring or grading rule changes** → the challenge-attempt validation and
  score helpers on the backend — never the client.
- **Reactions to things that already happen** (email, analytics, notifications)
  → an event listener subscribed to the relevant domain event, not inline
  calls in the triggering handler.
- **Smart-contract logic** → the `contract/` Rust crate plus a backend
  provider to invoke it; document any new variables in ENVIRONMENT.md.
- **Documentation** → `docs/`, alongside this file.

---

## 19. Where to go next

| Question | Document |
| -------- | -------- |
| How do I run this locally? | [DEVELOPMENT.md](./DEVELOPMENT.md) |
| What configuration does it need? | [ENVIRONMENT.md](./ENVIRONMENT.md) |
| What endpoints exist? | [API.md](./API.md) |
| How do I test my change? | [TESTING.md](./TESTING.md) |
| What are the domain entities? | [CANONICAL_DOMAIN_MODEL.md](./CANONICAL_DOMAIN_MODEL.md) |
| How do I contribute? | [CONTRIBUTING.md](../CONTRIBUTING.md) |
