# Team Memory MCP

Shared team memory for AI coding agents. Bayesian confidence scoring with temporal decay. Works with **Claude Code**, **Devin**, **Cursor**, and any MCP-compatible client.

## The Problem

AI coding agents learn things during sessions — *"JDBI uses `createQuery()` for RETURNING clauses"*, *"always add `@RunOnVirtualThread` for blocking I/O in Quarkus"* — but that knowledge disappears when the session ends. The next session starts from zero. Multiply that across a team of engineers, each using AI agents independently, and you get the same mistakes rediscovered over and over.

## The Solution

Team Memory gives AI agents a persistent, shared knowledge store where engineering patterns are stored, validated by the team, and ranked by confidence over time.

1. Engineers or AI agents store patterns they discover during development
2. Each pattern starts with a confidence of ~0.667
3. Confirmations from team members increase confidence; corrections decrease it
4. Patterns not confirmed for 90 days gradually lose confidence (temporal decay)
5. Search results are ranked by confidence — well-validated patterns surface first

## How It Compares

We surveyed 10+ existing MCP memory servers before building this. No existing solution combines all four properties that matter for shared engineering knowledge:

| Capability | Team Memory | server-memory | mem0 | mcp-memory-service | Memento | Memorix | Graphiti/Zep |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Bayesian confidence** | Yes | — | — | — | Manual only | — | — |
| **Temporal decay** | 90d half-life | — | — | Consolidation | 30d half-life | — | Invalidation |
| **Confirmation tracking** | Per-pattern | — | — | access_count | — | — | — |
| **Team/shared memory** | PostgreSQL | — | Cloud API | Basic SSE | — | Yes | Groups (weak) |
| **Zero-config local** | SQLite | JSONL | — | SQLite | — | JSON | — |
| **Coding-pattern schema** | domain/tags/scope | — | — | — | — | — | — |

### Why Not Use an Existing Solution?

**[@modelcontextprotocol/server-memory](https://github.com/modelcontextprotocol/servers)** — Anthropic's official reference implementation. Knowledge graph stored in a flat JSONL file. No confidence scoring, no decay, no team support. Intentionally minimal.

**[mem0-mcp](https://github.com/mem0ai/mem0-mcp)** — Commercial platform (YC-backed, $24M raised) optimized for conversational memory. Has team scoping via user_id/agent_id, but confidence is LLM-based re-ranking — not a transparent probabilistic model. No way to query "how many times has this pattern been confirmed?" Cloud dependency and cost.

**[mcp-memory-service](https://github.com/doobidoo/mcp-memory-service)** — Most feature-rich OSS memory server (1,500+ stars). Has quality fields, access_count, and consolidation decay. But quality scoring is LLM-evaluated (opaque), team memory is basic SSE event propagation without access controls, and there's no confirmation count per memory.

**[Memento MCP](https://github.com/gannonh/memento-mcp)** — Neo4j-backed with configurable half-life decay on relations. Closest to our confidence model mathematically, but confidence values are manually assigned by the LLM rather than computed from evidence. Single-user only. Requires Neo4j infrastructure.

**[Memorix](https://github.com/AVIDS2/memorix)** — Best team collaboration primitives (file locks, task boards, messaging across IDEs). But no confidence scoring, no temporal decay, no observation count tracking.

**[Graphiti/Zep](https://github.com/getzep/graphiti)** — Academically rigorous bi-temporal knowledge graph (23k+ stars, published paper). Confidence is binary — facts are either valid or invalidated. No graduated confidence, no confirmation tracking. Requires Neo4j/FalkorDB.

### The Gap

No existing solution tracks: *"This pattern has been confirmed correct 47 times across 12 sessions by 5 different engineers."*

That's what Team Memory does. The confidence score is:
- **Transparent** — you can see exactly why a pattern has a given score
- **Evidence-based** — computed from confirmation and correction counts
- **Self-correcting** — unused patterns decay, wrong patterns get corrected
- **No LLM dependency** — pure math, no API calls for scoring

## Setup

### Prerequisites

- Node.js >= 18

### Install and Build

```bash
git clone https://github.com/gustavolira/team-memory-mcp.git
cd team-memory-mcp
npm install
npm run build
```

### Register with Claude Code

```bash
claude mcp add team-memory -- node /absolute/path/to/team-memory-mcp/build/index.js
```

### Register with Devin

Add the MCP server in Devin Settings > MCP Marketplace with the stdio command above.

### Register with Cursor

Add to your `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "team-memory": {
      "command": "node",
      "args": ["/absolute/path/to/team-memory-mcp/build/index.js"]
    }
  }
}
```

## Storage

### Local Mode (default)

SQLite database at `~/.team-memory/memories.db`. No external services required. Zero configuration.

### Shared Mode (PostgreSQL)

Set the `TEAM_MEMORY_DATABASE_URL` environment variable to connect to a centralized PostgreSQL instance:

```bash
export TEAM_MEMORY_DATABASE_URL=postgresql://user:password@host:5432/team_memory
```

When set, all agents and engineers on the team share the same memory store. The server auto-creates the required table and indexes on first run.

## MCP Tools

| Tool | Description |
|---|---|
| `store_pattern` | Save a learned pattern with domain, tags, and scope |
| `search_patterns` | Search by keyword, domain, or tags — ranked by confidence |
| `get_pattern` | Retrieve a specific pattern by ID |
| `confirm_pattern` | Mark a pattern as valid (+confidence) |
| `correct_pattern` | Mark as incorrect or provide replacement (-confidence) |
| `forget_pattern` | Delete a pattern permanently |

## Confidence Scoring

Uses a Beta-Bernoulli Bayesian model with temporal decay:

```
confidence = (alpha / (alpha + beta)) × decay + floor × (1 - decay)

alpha = 1 + confirmations    (starts at 2)
beta  = 1 + corrections      (starts at 1)
decay = 0.5 ^ (days_since_last_confirmation / 90)
floor = 0.05
```

| Event | Confidence |
|---|---|
| New pattern | **0.667** |
| +1 confirmation | **0.750** |
| +2 confirmations | **0.800** |
| +5 confirmations | **0.875** |
| +1 correction (no confirmations) | **0.500** |
| 90 days without confirmation | halved |
| 180 days without confirmation | ~25% of original |

## Scoping

Patterns can be scoped to:

- **project** (default) — tied to the current git repository (auto-detected from `git remote get-url origin`)
- **global** — available across all projects

Both project-scoped and global patterns are returned by default when searching.

## Features

- **Auto-detected contributor** — reads from `git config user.name`
- **Cached git detection** — project ID and contributor resolved once per session
- **Graceful error handling** — database errors return MCP error responses, never crash
- **Dual storage backends** — SQLite for local, PostgreSQL for team sharing
- **Zero configuration** — works out of the box, no env vars needed

## Usage Examples

```
"Remember: in Quarkus, always add @RunOnVirtualThread to resource methods that do blocking I/O"
→ AI calls store_pattern

"What patterns do we have for JDBI?"
→ AI calls search_patterns with query="JDBI"

"That JDBI pattern about createQuery is correct, I just confirmed it works"
→ AI calls confirm_pattern

"That pattern is outdated, the correct approach is now X"
→ AI calls correct_pattern with replacement
```

## Roadmap

- [ ] Semantic search via embeddings
- [ ] Auto-capture hooks for Claude Code
- [ ] Devin auto-recall at task start
- [ ] Web dashboard for pattern management
- [ ] Conflict resolution for contradicting patterns
- [ ] npm publish for `npx team-memory-mcp`

## Built With

- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server framework
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — Local SQLite storage
- [pg](https://github.com/brianc/node-postgres) — PostgreSQL client for shared mode
- [Zod](https://github.com/colinhacks/zod) — Schema validation

## License

MIT
