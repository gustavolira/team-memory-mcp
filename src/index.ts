#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID, createHash } from "crypto";
import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// --- Configuration ---

const DB_DIR = join(homedir(), ".team-memory");
const DB_PATH = join(DB_DIR, "memories.db");
const PG_URL = process.env.TEAM_MEMORY_DATABASE_URL;
const DEFAULT_HALF_LIFE_DAYS = 90;
const CONFIDENCE_FLOOR = 0.05;

// --- Pattern types ---

interface PatternRow {
  id: string;
  content: string;
  domain: string;
  tags: string;
  scope: string;
  scope_id: string;
  alpha: number;
  beta: number;
  created_at: string;
  last_confirmed_at: string;
  contributor: string;
}

// --- Storage interface ---

interface Storage {
  init(): Promise<void>;
  insert(id: string, content: string, domain: string, tags: string, scope: string, scopeId: string, contributor: string): Promise<void>;
  getById(id: string): Promise<PatternRow | undefined>;
  search(conditions: string[], params: unknown[]): Promise<PatternRow[]>;
  confirm(id: string): Promise<void>;
  correct(id: string, replacement?: string): Promise<void>;
  remove(id: string): Promise<void>;
}

// --- SQLite storage ---

function createSqliteStorage(): Storage {
  // Lazy import to avoid requiring better-sqlite3 when using PostgreSQL
  let db: import("better-sqlite3").Database;

  return {
    async init() {
      const Database = (await import("better-sqlite3")).default;
      if (!existsSync(DB_DIR)) {
        mkdirSync(DB_DIR, { recursive: true });
      }
      db = new Database(DB_PATH);
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      db.exec(`
        CREATE TABLE IF NOT EXISTS patterns (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          domain TEXT NOT NULL DEFAULT 'general',
          tags TEXT NOT NULL DEFAULT '[]',
          scope TEXT NOT NULL DEFAULT 'project',
          scope_id TEXT NOT NULL DEFAULT '',
          alpha INTEGER NOT NULL DEFAULT 2,
          beta INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_confirmed_at TEXT NOT NULL DEFAULT (datetime('now')),
          contributor TEXT NOT NULL DEFAULT 'unknown'
        );
        CREATE INDEX IF NOT EXISTS idx_patterns_domain ON patterns(domain);
        CREATE INDEX IF NOT EXISTS idx_patterns_scope ON patterns(scope, scope_id);
      `);
    },
    async insert(id, content, domain, tags, scope, scopeId, contributor) {
      db.prepare(
        "INSERT INTO patterns (id, content, domain, tags, scope, scope_id, contributor) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(id, content, domain, tags, scope, scopeId, contributor);
    },
    async getById(id) {
      return db.prepare("SELECT * FROM patterns WHERE id = ?").get(id) as PatternRow | undefined;
    },
    async search(conditions, params) {
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      return db.prepare(`SELECT * FROM patterns ${where}`).all(...params) as PatternRow[];
    },
    async confirm(id) {
      db.prepare("UPDATE patterns SET alpha = alpha + 1, last_confirmed_at = datetime('now') WHERE id = ?").run(id);
    },
    async correct(id, replacement?) {
      if (replacement) {
        db.prepare("UPDATE patterns SET beta = beta + 1, content = ? WHERE id = ?").run(replacement, id);
      } else {
        db.prepare("UPDATE patterns SET beta = beta + 1 WHERE id = ?").run(id);
      }
    },
    async remove(id) {
      db.prepare("DELETE FROM patterns WHERE id = ?").run(id);
    },
  };
}

// --- PostgreSQL storage ---

function createPgStorage(connectionString: string): Storage {
  let pool: import("pg").Pool;

  return {
    async init() {
      const pg = await import("pg");
      pool = new pg.default.Pool({ connectionString });
      await pool.query(`
        CREATE TABLE IF NOT EXISTS patterns (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          domain TEXT NOT NULL DEFAULT 'general',
          tags TEXT NOT NULL DEFAULT '[]',
          scope TEXT NOT NULL DEFAULT 'project',
          scope_id TEXT NOT NULL DEFAULT '',
          alpha INTEGER NOT NULL DEFAULT 2,
          beta INTEGER NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          contributor TEXT NOT NULL DEFAULT 'unknown'
        )
      `);
      await pool.query("CREATE INDEX IF NOT EXISTS idx_patterns_domain ON patterns(domain)");
      await pool.query("CREATE INDEX IF NOT EXISTS idx_patterns_scope ON patterns(scope, scope_id)");
    },
    async insert(id, content, domain, tags, scope, scopeId, contributor) {
      await pool.query(
        "INSERT INTO patterns (id, content, domain, tags, scope, scope_id, contributor) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [id, content, domain, tags, scope, scopeId, contributor]
      );
    },
    async getById(id) {
      const { rows } = await pool.query("SELECT * FROM patterns WHERE id = $1", [id]);
      return normalizeRow(rows[0]);
    },
    async search(conditions, params) {
      // Convert SQLite ? placeholders to PostgreSQL $N placeholders
      let paramIndex = 0;
      const pgConditions = conditions.map((c) =>
        c.replace(/\bLIKE\b/g, "ILIKE").replace(/\?/g, () => `$${++paramIndex}`)
      );
      const where = pgConditions.length > 0 ? `WHERE ${pgConditions.join(" AND ")}` : "";
      const { rows } = await pool.query(`SELECT * FROM patterns ${where}`, params);
      return rows.map(normalizeRow).filter((r): r is PatternRow => r !== undefined);
    },
    async confirm(id) {
      await pool.query("UPDATE patterns SET alpha = alpha + 1, last_confirmed_at = NOW() WHERE id = $1", [id]);
    },
    async correct(id, replacement?) {
      if (replacement) {
        await pool.query("UPDATE patterns SET beta = beta + 1, content = $1 WHERE id = $2", [replacement, id]);
      } else {
        await pool.query("UPDATE patterns SET beta = beta + 1 WHERE id = $1", [id]);
      }
    },
    async remove(id) {
      await pool.query("DELETE FROM patterns WHERE id = $1", [id]);
    },
  };
}

// Normalize PostgreSQL row (timestamps come as Date objects, need string)
function normalizeRow(row: Record<string, unknown> | undefined): PatternRow | undefined {
  if (!row) return undefined;
  return {
    ...row,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    last_confirmed_at: row.last_confirmed_at instanceof Date ? row.last_confirmed_at.toISOString() : String(row.last_confirmed_at),
  } as PatternRow;
}

// --- Bayesian confidence ---

function computeConfidence(
  alpha: number,
  beta: number,
  lastConfirmedAt: string,
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS
): number {
  const posterior = alpha / (alpha + beta);

  const ts = lastConfirmedAt.endsWith("Z") ? lastConfirmedAt : lastConfirmedAt.replace(" ", "T") + "Z";
  const lastConfirmed = new Date(ts).getTime();
  const now = Date.now();
  const ageDays = (now - lastConfirmed) / (1000 * 60 * 60 * 24);
  const decay = Math.pow(0.5, ageDays / halfLifeDays);

  const confidence = posterior * decay + CONFIDENCE_FLOOR * (1 - decay);
  return Math.round(confidence * 1000) / 1000;
}

// --- Project detection (cached) ---

let cachedProjectId: string | undefined;

function detectProjectId(): string {
  if (cachedProjectId !== undefined) return cachedProjectId;

  try {
    const remote = execSync("git remote get-url origin 2>/dev/null", {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    if (remote) {
      cachedProjectId = createHash("sha256").update(remote).digest("hex").slice(0, 12);
      return cachedProjectId;
    }
  } catch {
    // not in a git repo
  }
  try {
    const toplevel = execSync("git rev-parse --show-toplevel 2>/dev/null", {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    if (toplevel) {
      cachedProjectId = createHash("sha256").update(toplevel).digest("hex").slice(0, 12);
      return cachedProjectId;
    }
  } catch {
    // fallback
  }
  cachedProjectId = "global";
  return cachedProjectId;
}

// --- Contributor detection (cached) ---

let cachedContributor: string | undefined;

function detectContributor(): string {
  if (cachedContributor !== undefined) return cachedContributor;

  try {
    cachedContributor = execSync("git config user.name 2>/dev/null", {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    if (cachedContributor) return cachedContributor;
  } catch {
    // git not available
  }
  cachedContributor = "unknown";
  return cachedContributor;
}

// --- Helpers ---

function formatPattern(row: PatternRow) {
  return {
    id: row.id,
    content: row.content,
    domain: row.domain,
    tags: JSON.parse(row.tags),
    scope: row.scope,
    scope_id: row.scope_id,
    confidence: computeConfidence(row.alpha, row.beta, row.last_confirmed_at),
    confirmations: row.alpha - 1,
    corrections: row.beta - 1,
    created_at: row.created_at,
    last_confirmed_at: row.last_confirmed_at,
    contributor: row.contributor,
  };
}

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    _meta: {},
    isError: false,
  };
}

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    _meta: {},
    isError: true,
  };
}

// --- MCP Server ---

const storage: Storage = PG_URL ? createPgStorage(PG_URL) : createSqliteStorage();

const server = new McpServer({
  name: "team-memory",
  version: "1.0.0",
});

// Tool: store_pattern
server.tool(
  "store_pattern",
  "Store a learned engineering pattern with domain and tags for future retrieval",
  {
    content: z.string().describe("The pattern text (e.g., 'JDBI: use createQuery() for RETURNING clauses, not createUpdate()')"),
    domain: z.string().optional().describe("Category: quarkus, jdbi, flyway, testing, security, general"),
    tags: z.array(z.string()).optional().describe("Tags for filtering (e.g., ['jdbi', 'returning', 'repository'])"),
    scope: z.enum(["project", "global"]).optional().describe("Scope: 'project' (default) or 'global'"),
    contributor: z.string().optional().describe("Who contributed this pattern"),
  },
  async ({ content, domain, tags, scope, contributor }) => {
    try {
      const id = randomUUID();
      const scopeId = scope === "global" ? "global" : detectProjectId();
      await storage.insert(id, content, domain ?? "general", JSON.stringify(tags ?? []), scope ?? "project", scopeId, contributor ?? detectContributor());
      const row = await storage.getById(id);
      return ok(formatPattern(row!));
    } catch (e) {
      return err(`Failed to store pattern: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
);

// Tool: search_patterns
server.tool(
  "search_patterns",
  "Search for stored engineering patterns by keyword, domain, or tags. Returns results ranked by Bayesian confidence.",
  {
    query: z.string().optional().describe("Keyword to search in pattern content"),
    domain: z.string().optional().describe("Filter by domain (e.g., 'jdbi', 'quarkus')"),
    tags: z.array(z.string()).optional().describe("Filter by tags"),
    scope: z.enum(["project", "global", "all"]).optional().describe("Scope filter: 'project', 'global', or 'all' (default)"),
    min_confidence: z.number().optional().describe("Minimum confidence threshold (0.0-1.0, default 0.1)"),
    limit: z.number().optional().describe("Max results (default 10)"),
  },
  async ({ query, domain, tags, scope, min_confidence, limit }) => {
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (query) {
        conditions.push("content LIKE ?");
        params.push(`%${query}%`);
      }
      if (domain) {
        conditions.push("domain = ?");
        params.push(domain);
      }
      if (tags && tags.length > 0) {
        const tagConditions = tags.map(() => "tags LIKE ?");
        conditions.push(`(${tagConditions.join(" OR ")})`);
        tags.forEach((tag) => params.push(`%"${tag}"%`));
      }
      if (scope === "project") {
        conditions.push("scope = ?");
        params.push("project");
        conditions.push("scope_id = ?");
        params.push(detectProjectId());
      } else if (scope === "global") {
        conditions.push("scope = ?");
        params.push("global");
      } else if (scope !== "all") {
        // Default (undefined): current project + global patterns
        conditions.push("((scope = ? AND scope_id = ?) OR scope = ?)");
        params.push("project", detectProjectId(), "global");
      }
      // scope === "all": no filter, return all patterns

      const rows = await storage.search(conditions, params);
      const minConf = min_confidence ?? 0.1;
      const maxResults = limit ?? 10;

      const results = rows
        .map(formatPattern)
        .filter((p) => p.confidence >= minConf)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, maxResults);

      return ok({ count: results.length, patterns: results });
    } catch (e) {
      return err(`Failed to search patterns: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
);

// Tool: get_pattern
server.tool(
  "get_pattern",
  "Retrieve a specific pattern by ID",
  { id: z.string().describe("Pattern ID") },
  async ({ id }) => {
    try {
      const row = await storage.getById(id);
      if (!row) return err(`Pattern not found: ${id}`);
      return ok(formatPattern(row));
    } catch (e) {
      return err(`Failed to get pattern: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
);

// Tool: confirm_pattern
server.tool(
  "confirm_pattern",
  "Confirm that a pattern is valid and useful, increasing its confidence score",
  { id: z.string().describe("Pattern ID to confirm") },
  async ({ id }) => {
    try {
      const before = await storage.getById(id);
      if (!before) return err(`Pattern not found: ${id}`);

      await storage.confirm(id);

      const after = await storage.getById(id);
      if (!after) return err(`Pattern was deleted concurrently: ${id}`);
      return ok({
        message: "Pattern confirmed",
        previous_confidence: computeConfidence(before.alpha, before.beta, before.last_confirmed_at),
        new_confidence: formatPattern(after).confidence,
        pattern: formatPattern(after),
      });
    } catch (e) {
      return err(`Failed to confirm pattern: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
);

// Tool: correct_pattern
server.tool(
  "correct_pattern",
  "Mark a pattern as incorrect or outdated, decreasing its confidence. Optionally provide a corrected version.",
  {
    id: z.string().describe("Pattern ID to correct"),
    replacement: z.string().optional().describe("Corrected pattern text (if provided, updates the content)"),
  },
  async ({ id, replacement }) => {
    try {
      const before = await storage.getById(id);
      if (!before) return err(`Pattern not found: ${id}`);

      await storage.correct(id, replacement);

      const after = await storage.getById(id);
      if (!after) return err(`Pattern was deleted concurrently: ${id}`);
      return ok({
        message: replacement ? "Pattern corrected and updated" : "Pattern marked as incorrect",
        previous_confidence: computeConfidence(before.alpha, before.beta, before.last_confirmed_at),
        new_confidence: formatPattern(after).confidence,
        pattern: formatPattern(after),
      });
    } catch (e) {
      return err(`Failed to correct pattern: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
);

// Tool: forget_pattern
server.tool(
  "forget_pattern",
  "Delete a pattern permanently",
  { id: z.string().describe("Pattern ID to delete") },
  async ({ id }) => {
    try {
      const row = await storage.getById(id);
      if (!row) return err(`Pattern not found: ${id}`);
      await storage.remove(id);
      return ok({ message: "Pattern deleted", id, content: row.content });
    } catch (e) {
      return err(`Failed to delete pattern: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
);

// --- Start server ---

async function main() {
  await storage.init();
  const backend = PG_URL ? "PostgreSQL" : `SQLite (${DB_PATH})`;
  console.error(`[team-memory] Storage: ${backend}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[team-memory] MCP server running on stdio");
}

main().catch((error) => {
  console.error("[team-memory] Fatal error:", error);
  process.exit(1);
});
