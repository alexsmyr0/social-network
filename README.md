> **Social-network starting point:** This codebase was imported from real-time-forum.
> Start with [Social Network Context](docs/social-network/CONTEXT.md) for the current
> requirements and project state. The forum documentation below describes the inherited baseline.

# 🌐 Real-Time Forum

[![Go Version](https://img.shields.io/badge/Go-1.24+-00ADD8?style=flat-square&logo=go&logoColor=white)](https://golang.org)
[![JavaScript](https://img.shields.io/badge/Vanilla_JS-ES2026+-F7DF1E?style=flat-square&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Runtime](https://img.shields.io/badge/Bun-Runtime-000000?style=flat-square&logo=bun&logoColor=white)](https://bun.sh)
[![Linter](https://img.shields.io/badge/Biome-Linted-60A5FA?style=flat-square&logo=biome&logoColor=white)](https://biomejs.dev)
[![CI](https://img.shields.io/github/actions/workflow/status/ertval/real-time-forum/go.yml?style=flat-square&logo=github&logoColor=white)](https://github.com/ertval/real-time-forum/actions)

---

**Problem:** Traditional forums rely on page refreshes or periodic polling for updates, causing latency in live chat, presence status, and typing indicators.

**Solution:** A split-server Go and Vanilla JS Single-Page Application (SPA) driven by Gorilla WebSockets, handling typing indicators and presence channels concurrently via Go select-loops.

---

A powerhouse, production-grade **Real-Time Single-Page Application (SPA)**. Built with a high-performance Go backend and a cutting-edge Vanilla JavaScript (ES2026+) frontend. Experience seamless navigation, lightning-fast interactions, and live private messaging—all delivered through a single HTML document.

---

## 🚦 Project Status

All three delivery waves are **complete**; the project is in maintenance.

- **Foundations (Wave 1)**: ✅ Complete
- **Auth & Core Forum (Wave 2)**: ✅ Complete
- **Real-Time Chat (Wave 3)**: ✅ Complete
- **Bonus Features**: ✅ User profiles, DM image attachments

Check the [Ticket Tracker](docs/ticket-tracker.md) for detailed progress.

---

## ✨ Key Features

### 🔐 Secure Authentication
- **Universal Login**: Access via **Nickname** or **Email** with a secure password.
- **Extended Profiles**: Rich registration capturing age, gender, and full name.
- **Session Integrity**: Hardened `HttpOnly` session cookies—no fragile JWTs.
- **Global Auth Shell**: Persistent login/logout controls reachable from every corner of the app.
- **Zero Guest Access**: A private, authenticated-only community experience.

### 📜 Dynamic Content
- **Fluid Feed**: Paginated post exploration with category tagging and rich media.
- **Deep Conversations**: Detail-focused comment threads load on-demand, keeping the feed lean.
- **Draft Mastery**: Save your thoughts and polish your posts before they go live.
- **Rich Media**: Dedicated image upload support for both posts and comments.

### 💬 Real-Time Private Messaging
- **Dynamic Roster**: A persistent chat sidebar with live presence indicators.
- **Intelligent Sorting**: Users are ordered by latest activity or alphabetically for new connections.
- **Unread Badges**: An arriving message marks its conversation, and the roster heading carries a running total—so a new DM is visible even when its row is scrolled away.
- **Elastic History**: Infinite-scroll chat history loading (10-message batches) with smart throttling.
- **Live Delivery**: Instant message arrival via WebSockets—no refresh, no delay.
- **Self-Healing Socket**: A dropped connection reconnects on its own with exponential backoff.
- **Bonus Capabilities**: Send images in DMs and view full user profiles.

---

## 🛠️ Technical Excellence

### Backend Stack
- **Engine**: Go 1.24+ (Standard Library focus)
- **Database**: SQLite (ACID compliant persistence)
- **Real-Time**: `gorilla/websocket` for low-latency events
- **Security**: `bcrypt` hashing & `google/uuid` session tracking; case-insensitive account identifiers
- **Concurrency**: Advanced Goroutine/Channel patterns for maximum throughput

### Frontend Stack
- **Logic**: Vanilla JS (ES2026+) — zero frameworks (React/Vue/Angular)
- **Tooling**: **Bun** for speed, **Biome** for precision, **Vitest** for testing
- **Design**: Modern Clean Vertical Slices / Screaming Architecture
- **Performance**: Promise-based async operations and Proxy-driven state

---

## 🏗️ Architecture

```mermaid
graph TD
    Browser[Browser: Vanilla JS SPA] <-->|HTTP / WebSockets| Frontend[Frontend Proxy :3000]
    Frontend <-->|Proxy API & WS| Backend[Go API Backend :8080]
    Backend <-->|SQL / Transactions| SQLite[(SQLite Database)]
```

*   `cmd/` — Server entry points (Backend: :8080, Frontend: :3000)
*   `SPA/` — **The Frontend Core**: Domain-driven vertical slices (Auth, Feed, Post, Activity, Profile, Shell, Chat)
*   `internal/` — Decoupled business logic, persistence layers, and HTTP handlers
*   `web/` — Static frontend assets and browser startup validation wrappers
*   `data/` — SQLite transactional storage files
*   `docs/` — System Design, Product Requirements, and verification audit trails

> [!NOTE]
> The project utilizes a **Split-Server Topology**. The Frontend server (`:3000`) serves the SPA shell and proxies all `/api/` and `/ws` traffic to the Backend server (`:8080`).

---

## 🚀 Quick Start

### 📋 Prerequisites
- **Go 1.24+**
- **Bun** (Runtime & Package Manager)
- **Make**
- **SQLite**

### ⚡ Run the Stack
```bash
# 1. Install all dependencies
make deps

# 2. Launch both servers (Backend & Frontend)
make run

# 3. Verify Infrastructure (Sanity Checks)
make verify-infra
```
🔗 **Access the Forum**: [http://localhost:3000](http://localhost:3000)

### 🧪 Quality Control
```bash
make test          # The full CI gate (build, lint, gofmt, vet, Go, Vitest, Playwright)
make test-e2e      # Run only Playwright E2E tests
make lint          # Execute Biome static analysis
make format        # Standardize code formatting (Backend + Frontend)
make format-frontend # Fix Biome static analysis issues
```

**Run E2E through `make`, not Playwright directly.** `make test` / `make test-e2e`
are the supported local entry points: they free ports `3000` (frontend) and `8080`
(backend) and start a fresh server. The Playwright config sets `reuseExistingServer:
false`, so invoking `bun x playwright test` by hand while a dev server is already
running fails with a port-in-use error instead of silently reusing the existing
(possibly stale) instance. Stop your dev servers — or just use `make test-e2e`,
which handles cleanup for you.

### 🧪 Testing Tiers

The project follows a rigorous three-tier validation strategy:

| Tier | Purpose | Tools |
|:--- |:--- |:--- |
| **Unit** | Isolated component & helper logic | Vitest (JSDOM/Node) |
| **Integration** | Feature interactions & API contracts | Go `httptest` + Vitest |
| **E2E** | Full multi-step user journeys | Playwright (Headless Chrome) |

**Note**: Playwright browsers are automatically installed during `make deps`. If you encounter issues, run `bun x playwright install chromium`.

### 🌱 Database Seeding
Use the QA seed runner when you want a deterministic local dataset.

```bash
make seed-qa
```

By default this seeds:

```bash
./data/forum.db
```

You can also target a different SQLite file:

```bash
go run ./cmd/qa-seed --db-path /tmp/forum-seed-check.db
```

Important notes:
- The seed runner resets QA-owned tables and recreates the same users, posts, comments, reactions, and notifications each time.
- Bootstrap categories are not treated as QA sample data and are preserved separately.
- Do not reseed a database that is actively being used by a running backend process.
 

### 🧪 Test Credentials
For quick testing and QA, the following user is available in the default seed data:

| Role | Nickname / Email | Password |
|:--- |:--- |:--- |
| **Test User** | `tester` / `tester@example.com` | `password` |

---

## 📂 Documentation

Deep dive into the project's blueprints:

- 📖 **[docs/requirements.md](docs/requirements.md)**: The basic requirements document, source of truth for what the project should do.
- 📐 **[docs/SDS.md](docs/SDS.md)**: Detailed technical specifications.
- 📋 **[docs/audit.md](docs/audit.md)**: Success criteria and verification gate source of truth.
- 🤖 **[AGENTS.md](AGENTS.md)**: Essential guide for AI coding assistants.
- 🏗️ **[architecture.md](architecture.md)**: High-level structural overview.

---

## 🛰️ API at a Glance

| Method | Endpoint | Description |
|:--- |:--- |:--- |
| `POST` | `/api/v1/users/login` | Authenticate and start session |
| `POST` | `/api/v1/users/register` | Create account with profile data |
| `GET` | `/api/v1/users/me` | Bootstrap session verification |
| `GET` | `/api/v1/posts` | Fetch the paginated global feed |
| `GET` | `/api/v1/chats` | Retrieve roster with presence state |
| `GET` | `/ws` | WebSocket for live chat & events |

---

## Related

- [**ertval.github.io**](https://ertval.github.io) — Portfolio & CV
- [**two-tier-safe-ai-gate**](https://github.com/ertval/two-tier-safe-ai-gate) — Safe AI execution model (Go + Inngest + Omnigent)
- [**keel-multi-agent-pipeline**](https://github.com/ertval/keel-multi-agent-pipeline) — Multi-agent maritime intelligence (Python + LangGraph)
- [**social-network**](https://github.com/ertval/social-network) — Go vertical-slices full-stack monolith (Next.js)
- [**make-your-game**](https://github.com/ertval/make-your-game) — Pure JS ECS game engine
- [**real-time-forum**](https://github.com/ertval/real-time-forum) — Go + Vanilla JS real-time WebSocket SPA
- [**forum**](https://github.com/ertval/forum) — Go hexagonal architecture monolith (zero-dependency)

---

<div align="center">
  <sub>Built with ❤️ by the Real-Time Forum Team. Licensed under GPL-3.0.</sub>
</div>
