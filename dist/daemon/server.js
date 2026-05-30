// src/daemon/server.ts
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { readFileSync as readFileSync3 } from "fs";
import { fileURLToPath } from "url";
import { dirname, join as join4 } from "path";

// src/daemon/workspace.ts
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { randomBytes } from "crypto";

// src/shared/paths.ts
import { homedir } from "os";
import { join } from "path";
function matchiHome() {
  return process.env.MATCHI_HOME ?? join(homedir(), ".matchi");
}
function workspaceDir(hash) {
  return join(matchiHome(), "workspaces", hash);
}
function workspaceTokenPath(hash) {
  return join(workspaceDir(hash), ".token");
}
function workspaceDuckdbPath(hash) {
  return join(workspaceDir(hash), "data.duckdb");
}
function workspaceMetaPath(hash) {
  return join(workspaceDir(hash), "meta.duckdb");
}

// src/daemon/db/engine.ts
import { DuckDBInstance } from "@duckdb/node-api";
var Engine = class {
  constructor(dbPath) {
    this.dbPath = dbPath;
  }
  dbPath;
  instance = null;
  connection = null;
  async init() {
    if (this.connection) return;
    this.instance = await DuckDBInstance.create(this.dbPath);
    this.connection = await this.instance.connect();
  }
  async query(sql) {
    if (!this.connection) throw new Error("Engine not initialized");
    const reader = await this.connection.runAndReadAll(sql);
    const columns = reader.columnNames();
    const rows = reader.getRows();
    return rows.map((row) => {
      const obj = {};
      columns.forEach((col, i) => {
        const val = row[i];
        if (typeof val === "bigint") {
          obj[col] = val >= -9007199254740991n && val <= 9007199254740991n ? Number(val) : val.toString();
        } else {
          obj[col] = val;
        }
      });
      return obj;
    });
  }
  async execute(sql) {
    if (!this.connection) throw new Error("Engine not initialized");
    await this.connection.run(sql);
  }
  async close() {
    if (this.connection) {
      try {
        await this.connection.closeSync?.();
      } catch {
      }
      try {
        await this.connection.disconnectSync?.();
      } catch {
      }
      try {
        await this.connection.close?.();
      } catch {
      }
      this.connection = null;
    }
    if (this.instance) {
      const inst = this.instance;
      try {
        await inst.closeSync?.();
      } catch {
      }
      try {
        await inst.terminateSync?.();
      } catch {
      }
      try {
        await inst.close?.();
      } catch {
      }
      this.instance = null;
    }
  }
};

// src/daemon/workspace.ts
var WorkspaceRegistry = class {
  constructor(opts) {
    this.opts = opts;
  }
  opts;
  workspaces = /* @__PURE__ */ new Map();
  async touch(hash) {
    const cached = this.workspaces.get(hash);
    if (cached) {
      cached.lastActivity = Date.now();
      return cached;
    }
    const dir = workspaceDir(hash);
    mkdirSync(dir, { recursive: true });
    const tokPath = workspaceTokenPath(hash);
    let token;
    if (existsSync(tokPath)) {
      token = readFileSync(tokPath, "utf8").trim();
    } else {
      token = randomBytes(32).toString("hex");
      writeFileSync(tokPath, token, { mode: 384 });
      chmodSync(tokPath, 384);
    }
    const data = new Engine(workspaceDuckdbPath(hash));
    const meta = new Engine(workspaceMetaPath(hash));
    await data.init();
    await meta.init();
    const ws = { hash, token, dir, data, meta, lastActivity: Date.now() };
    this.workspaces.set(hash, ws);
    return ws;
  }
  verifyToken(hash, token) {
    const ws = this.workspaces.get(hash);
    if (!ws) return false;
    return ws.token === token;
  }
  list() {
    return [...this.workspaces.values()];
  }
  async closeAll() {
    for (const ws of this.workspaces.values()) {
      await ws.data.close();
      await ws.meta.close();
    }
    this.workspaces.clear();
  }
  msSinceLastActivity() {
    if (this.workspaces.size === 0) return Infinity;
    const newest = Math.max(...[...this.workspaces.values()].map((w) => w.lastActivity));
    return Date.now() - newest;
  }
};

// src/daemon/progress.ts
import { EventEmitter } from "events";
var ProgressBus = class extends EventEmitter {
  emitProgress(jobId, phase, payload) {
    this.emit(`job:${jobId}`, { phase, payload, ts: Date.now() });
  }
  subscribe(jobId, cb) {
    const handler = (e) => cb(e);
    this.on(`job:${jobId}`, handler);
    return () => this.off(`job:${jobId}`, handler);
  }
};

// src/daemon/stores/recon-store.ts
import { randomUUID } from "crypto";
import { appendFileSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2, existsSync as existsSync2 } from "fs";
import { join as join2 } from "path";
var ReconStore = class {
  constructor(engine, options = {}) {
    this.engine = engine;
    this.auditDir = options.auditDir ?? null;
    this.auditFile = this.auditDir ? join2(this.auditDir, "audit-trail.jsonl") : null;
  }
  engine;
  runs = /* @__PURE__ */ new Map();
  matchResults = /* @__PURE__ */ new Map();
  initialized = false;
  auditDir;
  auditFile;
  esc(s) {
    return s.replace(/'/g, "''");
  }
  async init() {
    if (this.initialized) return;
    await this.engine.execute(`
      CREATE TABLE IF NOT EXISTS recon_runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        datasets TEXT DEFAULT '[]',
        status TEXT DEFAULT 'pending',
        trigger TEXT DEFAULT 'chat',
        recipe_id TEXT,
        matched INTEGER DEFAULT 0,
        unmatched_files TEXT DEFAULT '[]',
        match_rate REAL DEFAULT 0,
        matched_sql TEXT,
        text_summary TEXT,
        error TEXT,
        created_at TIMESTAMP DEFAULT current_timestamp
      )
    `);
    this.initialized = true;
  }
  async persistRun(run, extras) {
    await this.init();
    const matchRate = run.summary ? Math.round(run.summary.matched / Math.max(run.summary.totalA, 1) * 1e3) / 10 : 0;
    await this.engine.execute(`
      INSERT INTO recon_runs (id, name, datasets, status, trigger, recipe_id, matched, unmatched_files, match_rate, matched_sql, error, created_at)
      VALUES (
        '${this.esc(run.id)}',
        '${this.esc(run.name)}',
        '${this.esc(JSON.stringify(extras.datasets))}',
        '${this.esc(run.status)}',
        '${this.esc(extras.trigger)}',
        ${extras.recipeId ? `'${this.esc(extras.recipeId)}'` : "NULL"},
        ${run.summary?.matched ?? 0},
        '${this.esc(JSON.stringify(extras.unmatchedFiles))}',
        ${matchRate},
        ${extras.matchedSql ? `'${this.esc(extras.matchedSql)}'` : "NULL"},
        ${run.error ? `'${this.esc(run.error)}'` : "NULL"},
        '${run.createdAt}'
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        matched = EXCLUDED.matched,
        unmatched_files = EXCLUDED.unmatched_files,
        match_rate = EXCLUDED.match_rate,
        trigger = EXCLUDED.trigger,
        recipe_id = EXCLUDED.recipe_id,
        error = EXCLUDED.error
    `);
  }
  async updateSummaryText(runId, summary) {
    await this.init();
    await this.engine.execute(`UPDATE recon_runs SET text_summary = '${this.esc(summary)}' WHERE id = '${this.esc(runId)}'`);
  }
  async listPersistedRuns(limit = 20) {
    await this.init();
    return this.engine.query(`SELECT * FROM recon_runs ORDER BY created_at DESC LIMIT ${limit}`);
  }
  async getPersistedRun(id) {
    await this.init();
    const rows = await this.engine.query(`SELECT * FROM recon_runs WHERE id = '${this.esc(id)}'`);
    return rows.length > 0 ? rows[0] : null;
  }
  addRun(params) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const run = {
      id: randomUUID(),
      name: params.name,
      datasetIdA: params.datasetIdA,
      datasetIdB: params.datasetIdB,
      joinKey: params.joinKey,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      config: params.config
    };
    this.runs.set(run.id, run);
    return run;
  }
  getRun(id) {
    return this.runs.get(id);
  }
  listRuns() {
    return Array.from(this.runs.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }
  updateRun(id, data) {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Run not found: ${id}`);
    const updated = { ...run, ...data, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
    this.runs.set(id, updated);
    return updated;
  }
  setMatchResult(runId, result) {
    this.matchResults.set(runId, result);
  }
  getMatchResult(runId) {
    return this.matchResults.get(runId);
  }
  getExceptions(runId, side, limit = 20, offset = 0) {
    const result = this.matchResults.get(runId);
    if (!result) return [];
    let exceptions;
    if (side === "A") {
      exceptions = result.exceptionsA;
    } else if (side === "B") {
      exceptions = result.exceptionsB;
    } else {
      exceptions = [
        ...result.exceptionsA.map((r) => ({ ...r, _side: "A" })),
        ...result.exceptionsB.map((r) => ({ ...r, _side: "B" }))
      ];
    }
    return exceptions.slice(offset, offset + limit);
  }
  audit(action, runId, details) {
    if (!this.auditDir || !this.auditFile) return;
    mkdirSync2(this.auditDir, { recursive: true });
    const run = runId ? this.runs.get(runId) : void 0;
    const entry = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      action,
      runId,
      runName: run?.name,
      datasetA: run?.datasetIdA,
      datasetB: run?.datasetIdB,
      matched: run?.summary?.matched,
      exceptions: run?.summary?.exceptions,
      matchRate: run?.summary ? Math.round(run.summary.matched / Math.max(run.summary.totalA, 1) * 1e3) / 10 : void 0,
      details
    };
    appendFileSync(this.auditFile, JSON.stringify(entry) + "\n");
  }
  getAuditLog(limit = 50) {
    if (!this.auditFile || !existsSync2(this.auditFile)) return [];
    const lines = readFileSync2(this.auditFile, "utf-8").split("\n").filter((l) => l.trim());
    return lines.slice(-limit).map((l) => JSON.parse(l)).reverse();
  }
};

// src/daemon/stores/recipe-store.ts
import { randomUUID as randomUUID2 } from "crypto";
var esc = (s) => s.replace(/'/g, "''");
var RecipeStore = class {
  constructor(engine) {
    this.engine = engine;
  }
  engine;
  initialized = false;
  async init() {
    if (this.initialized) return;
    await this.engine.execute(`
      CREATE TABLE IF NOT EXISTS recipes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        matched_sql TEXT NOT NULL,
        dataset_a_pattern TEXT,
        dataset_b_pattern TEXT,
        match_rate DOUBLE,
        matched_count INTEGER,
        total_count INTEGER,
        status TEXT DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_at TEXT,
        run_count INTEGER DEFAULT 0
      )
    `);
    this.initialized = true;
  }
  async addRecipe(params) {
    await this.init();
    const id = randomUUID2();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const matchRate = params.matched_count != null && params.total_count ? params.matched_count / params.total_count : null;
    await this.engine.execute(`
      INSERT INTO recipes (id, name, matched_sql, dataset_a_pattern, dataset_b_pattern, match_rate, matched_count, total_count, status, created_at, updated_at, last_run_at, run_count)
      VALUES (
        '${esc(id)}',
        '${esc(params.name)}',
        '${esc(params.matched_sql)}',
        '${esc(params.dataset_a_pattern)}',
        '${esc(params.dataset_b_pattern)}',
        ${matchRate ?? "NULL"},
        ${params.matched_count ?? "NULL"},
        ${params.total_count ?? "NULL"},
        'active',
        '${now}',
        '${now}',
        NULL,
        0
      )
    `);
    return {
      id,
      name: params.name,
      matched_sql: params.matched_sql,
      dataset_a_pattern: params.dataset_a_pattern,
      dataset_b_pattern: params.dataset_b_pattern,
      match_rate: matchRate,
      matched_count: params.matched_count ?? null,
      total_count: params.total_count ?? null,
      status: "active",
      created_at: now,
      updated_at: now,
      last_run_at: null,
      run_count: 0
    };
  }
  async getRecipe(id) {
    await this.init();
    const rows = await this.engine.query(`SELECT * FROM recipes WHERE id = '${esc(id)}'`);
    return rows.length > 0 ? rows[0] : null;
  }
  async listRecipes() {
    await this.init();
    const rows = await this.engine.query(`SELECT * FROM recipes WHERE status = 'active' ORDER BY updated_at DESC`);
    return rows;
  }
  async deleteRecipe(id) {
    await this.init();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await this.engine.execute(`UPDATE recipes SET status = 'archived', updated_at = '${now}' WHERE id = '${esc(id)}'`);
  }
  async recordRun(id, matchRate) {
    await this.init();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const matchRateClause = matchRate != null ? `, match_rate = ${matchRate}` : "";
    await this.engine.execute(`UPDATE recipes SET run_count = run_count + 1, last_run_at = '${now}', updated_at = '${now}'${matchRateClause} WHERE id = '${esc(id)}'`);
  }
};

// src/daemon/stores/error-memory-store.ts
import { randomUUID as randomUUID3 } from "crypto";
var MAX_MSG_LEN = 200;
var MAX_PROMPT_CHARS = 500;
var EXPIRY_DAYS = 30;
function truncate(s, max) {
  return s.length > max ? s.slice(0, max) : s;
}
function classifyError(message) {
  if (/SQL syntax error|Parser Error/i.test(message)) return "syntax";
  if (/does not exist|not found|no such/i.test(message)) return "not_found";
  if (/disallowed keywords|invalid/i.test(message)) return "validation";
  return "other";
}
var esc2 = (s) => s.replace(/'/g, "''");
var ErrorMemoryStore = class {
  constructor(engine) {
    this.engine = engine;
  }
  engine;
  initialized = false;
  async init() {
    if (this.initialized) return;
    await this.engine.execute(`
      CREATE TABLE IF NOT EXISTS error_patterns (
        id TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        error_category TEXT NOT NULL,
        latest_error_message TEXT NOT NULL,
        latest_input_summary TEXT NOT NULL,
        correction_input_summary TEXT,
        correction_lesson TEXT,
        occurrence_count INTEGER DEFAULT 1,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      )
    `);
    this.initialized = true;
  }
  async recordError(toolName, errorMessage, inputSummary) {
    await this.init();
    const category = classifyError(errorMessage);
    const msg = truncate(errorMessage, MAX_MSG_LEN);
    const input = truncate(inputSummary, MAX_MSG_LEN);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const existing = await this.engine.query(
      `SELECT id FROM error_patterns WHERE tool_name = '${esc2(toolName)}' AND error_category = '${esc2(category)}'`
    );
    if (existing.length > 0) {
      await this.engine.execute(
        `UPDATE error_patterns SET occurrence_count = occurrence_count + 1, latest_error_message = '${esc2(msg)}', latest_input_summary = '${esc2(input)}', last_seen_at = '${now}' WHERE id = '${esc2(String(existing[0].id))}'`
      );
    } else {
      const id = randomUUID3();
      await this.engine.execute(
        `INSERT INTO error_patterns (id, tool_name, error_category, latest_error_message, latest_input_summary, occurrence_count, first_seen_at, last_seen_at) VALUES ('${esc2(id)}', '${esc2(toolName)}', '${esc2(category)}', '${esc2(msg)}', '${esc2(input)}', 1, '${now}', '${now}')`
      );
    }
  }
  async recordCorrection(toolName, correctionInputSummary) {
    await this.init();
    const corrInput = truncate(correctionInputSummary, MAX_MSG_LEN);
    const rows = await this.engine.query(
      `SELECT id, latest_input_summary FROM error_patterns WHERE tool_name = '${esc2(toolName)}' AND correction_lesson IS NULL ORDER BY last_seen_at DESC LIMIT 1`
    );
    if (rows.length === 0) return;
    const pattern = rows[0];
    const lesson = truncate(`Instead of ${String(pattern.latest_input_summary).slice(0, 60)}, use ${corrInput.slice(0, 60)}`, MAX_MSG_LEN);
    await this.engine.execute(
      `UPDATE error_patterns SET correction_input_summary = '${esc2(corrInput)}', correction_lesson = '${esc2(lesson)}' WHERE id = '${esc2(String(pattern.id))}'`
    );
  }
  async getTopPatterns(limit) {
    await this.init();
    const rows = await this.engine.query(
      `SELECT * FROM error_patterns ORDER BY occurrence_count DESC, last_seen_at DESC LIMIT ${limit}`
    );
    return rows;
  }
  async expireOldPatterns() {
    await this.init();
    const cutoff = new Date(Date.now() - EXPIRY_DAYS * 24 * 60 * 60 * 1e3).toISOString();
    await this.engine.execute(`DELETE FROM error_patterns WHERE last_seen_at < '${cutoff}'`);
  }
  async buildPromptSection() {
    await this.expireOldPatterns();
    const patterns = await this.getTopPatterns(10);
    if (patterns.length === 0) return "";
    let section = "\n## Common Mistakes to Avoid\n\nBased on past sessions, avoid these mistakes:\n\n";
    for (const p of patterns) {
      let line = `- [${p.tool_name}] ${p.error_category}: "${p.latest_error_message}"`;
      if (p.correction_lesson) {
        line += ` \u2192 Fix: ${p.correction_lesson}`;
      }
      line += ` (seen ${p.occurrence_count}x)
`;
      if (section.length + line.length > MAX_PROMPT_CHARS) break;
      section += line;
    }
    return section;
  }
  async listAll() {
    await this.init();
    return await this.engine.query(
      `SELECT * FROM error_patterns ORDER BY last_seen_at DESC`
    );
  }
  async deletePattern(id) {
    await this.init();
    await this.engine.execute(`DELETE FROM error_patterns WHERE id = '${esc2(id)}'`);
  }
};

// src/daemon/auth.ts
function makeAuthHook(registry) {
  return async (req, reply) => {
    const params = req.params;
    const hash = params.hash;
    if (!hash) return;
    await registry.touch(hash);
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized", message: "missing bearer" } });
    }
    const token = auth.slice(7);
    if (!registry.verifyToken(hash, token)) {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized", message: "bad token" } });
    }
  };
}

// src/daemon/routes/health.ts
var healthRoutes = async (fastify) => {
  const f = fastify;
  f.get("/healthz", async () => {
    return {
      ok: true,
      version: f.matchiVersion,
      uptime_s: Math.floor((Date.now() - f.startedAt) / 1e3)
    };
  });
};

// src/daemon/routes/tools.ts
import { randomUUID as randomUUID4 } from "crypto";

// src/daemon/tools/run-sql.ts
import { z } from "zod";
var MAX_ROWS = 20;
var MAX_STRING_LENGTH = 120;
var MAX_BATCH_SIZE = 10;
var MAX_BATCH_PAYLOAD = 2e4;
var DANGEROUS_KEYWORDS = /\b(DROP|DELETE|INSERT|UPDATE|ALTER|CREATE|TRUNCATE|REPLACE|ATTACH|COPY|EXPORT|CALL)\b/i;
var batchItemSchema = z.object({
  sql: z.string(),
  limit: z.number().optional(),
  count_only: z.boolean().optional(),
  description: z.string().optional()
});
var runSqlSchema = z.object({
  sql: z.string().optional(),
  limit: z.number().optional(),
  count_only: z.boolean().optional(),
  queries: z.array(batchItemSchema).max(MAX_BATCH_SIZE).optional(),
  description: z.string().optional()
}).refine((v) => typeof v.sql === "string" !== Array.isArray(v.queries), {
  message: "provide exactly one of sql|queries"
});
function truncateStrings(rows) {
  return rows.map((row) => {
    const out = {};
    for (const [key, val] of Object.entries(row)) {
      if (typeof val === "string" && val.length > MAX_STRING_LENGTH) {
        out[key] = val.slice(0, MAX_STRING_LENGTH) + "...";
      } else if (typeof val === "bigint") {
        out[key] = Number(val);
      } else {
        out[key] = val;
      }
    }
    return out;
  });
}
async function executeSingleQuery(ctx, sql, limit, countOnly) {
  const cleaned = sql.trim().replace(/;+$/, "");
  if (DANGEROUS_KEYWORDS.test(cleaned)) {
    return {
      ok: false,
      code: "dangerous_keyword",
      message: "Query contains disallowed keywords (DROP, DELETE, INSERT, UPDATE, ALTER, CREATE, TRUNCATE, REPLACE, ATTACH, COPY, EXPORT, CALL)"
    };
  }
  try {
    await ctx.ws.data.query(`EXPLAIN ${cleaned}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "query_failed",
      message: `SQL syntax error: ${msg}. Fix the query and try again.`
    };
  }
  if (countOnly) {
    const result = await ctx.ws.data.query(`SELECT COUNT(*) as total FROM (${cleaned}) _counted`);
    return { ok: true, result: { rows: [], totalRows: Number(result[0]?.total ?? 0), truncated: false } };
  }
  const cappedLimit = Math.min(Math.max(limit, 1), MAX_ROWS);
  const queryToRun = `SELECT * FROM (${cleaned}) _q LIMIT ${cappedLimit}`;
  const countResult = await ctx.ws.data.query(`SELECT COUNT(*) as total FROM (${cleaned}) _counted`);
  const totalRows = Number(countResult[0]?.total ?? 0);
  let rows;
  try {
    rows = await ctx.ws.data.query(queryToRun);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "query_failed", message: msg };
  }
  return {
    ok: true,
    result: {
      rows: truncateStrings(rows),
      totalRows,
      truncated: totalRows > rows.length
    }
  };
}
var runSql = {
  name: "run_sql",
  schema: runSqlSchema,
  async run(args, ctx) {
    if (Array.isArray(args.queries)) {
      const queries = args.queries;
      if (queries.length === 0) {
        return { ok: false, error: { code: "batch_too_large", message: "queries array must contain at least 1 query" } };
      }
      if (queries.length > MAX_BATCH_SIZE) {
        return {
          ok: false,
          error: { code: "batch_too_large", message: `queries array exceeds maximum batch size of ${MAX_BATCH_SIZE}` }
        };
      }
      const results = [];
      let cumulativePayloadSize = 0;
      for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        const limit2 = q.limit != null ? Math.min(Math.max(Number(q.limit), 1), MAX_ROWS) : MAX_ROWS;
        const countOnly2 = Boolean(q.count_only);
        const desc = q.description && q.description.length > 200 ? q.description.slice(0, 200) : q.description || null;
        if (ctx.jobId) {
          ctx.bus.emitProgress(ctx.jobId, "query", {
            index: i + 1,
            total: queries.length,
            description: desc
          });
        }
        const queryResult = await executeSingleQuery(ctx, q.sql, limit2, countOnly2);
        const batchResult = queryResult.ok ? {
          index: i,
          sql: q.sql,
          description: desc,
          status: "success",
          rows: queryResult.result.rows,
          totalRows: queryResult.result.totalRows,
          truncated: queryResult.result.truncated,
          error: null
        } : {
          index: i,
          sql: q.sql,
          description: desc,
          status: "error",
          rows: [],
          totalRows: 0,
          truncated: false,
          error: queryResult.message
        };
        const resultJson = JSON.stringify(batchResult);
        if (cumulativePayloadSize + resultJson.length > MAX_BATCH_PAYLOAD && batchResult.rows.length > 0) {
          const available = MAX_BATCH_PAYLOAD - cumulativePayloadSize;
          while (batchResult.rows.length > 1) {
            batchResult.rows.pop();
            batchResult.truncated = true;
            if (JSON.stringify(batchResult).length <= available) break;
          }
        }
        cumulativePayloadSize += JSON.stringify(batchResult).length;
        results.push(batchResult);
      }
      return {
        ok: true,
        data: {
          results,
          totalQueries: queries.length,
          successCount: results.filter((r) => r.status === "success").length,
          errorCount: results.filter((r) => r.status === "error").length
        }
      };
    }
    if (typeof args.sql !== "string") {
      return { ok: false, error: { code: "query_failed", message: "Either sql (string) or queries (array) is required" } };
    }
    const countOnly = Boolean(args.count_only);
    const limit = Math.min(Math.max(Number(args.limit) || MAX_ROWS, 1), MAX_ROWS);
    const single = await executeSingleQuery(ctx, args.sql, limit, countOnly);
    if (!single.ok) {
      return { ok: false, error: { code: single.code, message: single.message } };
    }
    if (countOnly) {
      return { ok: true, data: { totalRows: single.result.totalRows } };
    }
    return { ok: true, data: single.result };
  }
};

// src/daemon/tools/list-sources.ts
import { z as z2 } from "zod";
var listSourcesSchema = z2.object({
  description: z2.string().optional()
});
async function ensureSourcesTable(ctx) {
  await ctx.ws.meta.execute(
    `CREATE TABLE IF NOT EXISTS sources (name TEXT PRIMARY KEY, alias TEXT, uploaded_at BIGINT)`
  );
}
var listSources = {
  name: "list_sources",
  schema: listSourcesSchema,
  async run(_args, ctx) {
    await ensureSourcesTable(ctx);
    const registered = await ctx.ws.meta.query(
      `SELECT name, alias, uploaded_at FROM sources ORDER BY uploaded_at DESC`
    );
    const sources = [];
    for (const row of registered) {
      const table = row.name;
      try {
        const cols = await ctx.ws.data.query(`DESCRIBE ${table}`);
        const countRows = await ctx.ws.data.query(
          `SELECT COUNT(*)::INT AS n FROM ${table}`
        );
        sources.push({
          table,
          alias: row.alias ?? null,
          rows: Number(countRows[0]?.n ?? 0),
          columns: cols.map((c) => ({ name: c.column_name, type: c.column_type })),
          uploaded_at: row.uploaded_at == null ? null : typeof row.uploaded_at === "bigint" ? Number(row.uploaded_at) : row.uploaded_at
        });
      } catch {
      }
    }
    return { ok: true, data: { sources } };
  }
};

// src/daemon/tools/load-sheet.ts
import { z as z3 } from "zod";
import { existsSync as existsSync3 } from "fs";
import { basename, extname } from "path";

// src/shared/hash.ts
import { createHash } from "crypto";
function workspaceHash(cwd) {
  return createHash("sha1").update(cwd).digest("hex").slice(0, 12);
}

// src/daemon/tools/load-sheet.ts
var loadSheetSchema = z3.object({
  path: z3.string(),
  sheet: z3.string(),
  alias: z3.string().optional(),
  description: z3.string().optional()
});
var loadSheet = {
  name: "load_sheet",
  schema: loadSheetSchema,
  async run({ path, sheet, alias }, ctx) {
    if (!existsSync3(path)) {
      return { ok: false, error: { code: "not_found", message: `file ${path} does not exist` } };
    }
    const ext = extname(path).toLowerCase();
    if (ext !== ".xlsx") {
      return { ok: false, error: { code: "unsupported_format", message: `expected .xlsx, got ${ext}` } };
    }
    const baseName = (alias ?? `${basename(path, ext)}_${sheet}`).replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
    const table = `xlsx_${baseName}_${workspaceHash(path + ":" + sheet).slice(0, 8)}`;
    const escapedPath = path.replace(/'/g, "''");
    const escapedSheet = sheet.replace(/'/g, "''");
    try {
      await ctx.ws.data.execute(`INSTALL excel; LOAD excel;`);
      await ctx.ws.data.execute(
        `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_xlsx('${escapedPath}', sheet='${escapedSheet}')`
      );
    } catch (e) {
      return {
        ok: false,
        error: { code: "ingestion_failed", message: e instanceof Error ? e.message : String(e) }
      };
    }
    const countRows = await ctx.ws.data.query(`SELECT COUNT(*)::INT AS n FROM ${table}`);
    const cols = await ctx.ws.data.query(`DESCRIBE ${table}`);
    await ctx.ws.meta.execute(
      `CREATE TABLE IF NOT EXISTS sources (name TEXT PRIMARY KEY, alias TEXT, uploaded_at BIGINT)`
    );
    const aliasLiteral = alias ? `'${alias.replace(/'/g, "''")}'` : "NULL";
    await ctx.ws.meta.execute(
      `INSERT OR REPLACE INTO sources VALUES ('${table}', ${aliasLiteral}, ${Date.now()})`
    );
    return {
      ok: true,
      data: {
        table_name: table,
        rows: Number(countRows[0]?.n ?? 0),
        columns: cols.map((c) => ({ name: c.column_name, type: c.column_type }))
      }
    };
  }
};

// src/daemon/tools/run-match.ts
import { z as z4 } from "zod";
import { mkdirSync as mkdirSync3 } from "fs";
import { join as join3 } from "path";
var runMatchSchema = z4.object({
  matched_sql: z4.string(),
  a: z4.string(),
  b: z4.string(),
  description: z4.string().optional()
});
var MAX_STR_LEN = 100;
function truncateRowStrings(rows) {
  return rows.map((row) => {
    const out = {};
    for (const [key, val] of Object.entries(row)) {
      if (typeof val === "string" && val.length > MAX_STR_LEN) {
        out[key] = val.slice(0, MAX_STR_LEN) + "...";
      } else if (typeof val === "bigint") {
        out[key] = Number(val);
      } else {
        out[key] = val;
      }
    }
    return out;
  });
}
function sanitizeIdentifier(name) {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error(`Invalid identifier: ${name}`);
  return name;
}
var runMatch = {
  name: "run_match",
  schema: runMatchSchema,
  async run({ matched_sql, a, b }, ctx) {
    let tableA;
    let tableB;
    try {
      tableA = sanitizeIdentifier(a);
      tableB = sanitizeIdentifier(b);
    } catch (e) {
      return {
        ok: false,
        error: { code: "invalid_identifier", message: e instanceof Error ? e.message : String(e) }
      };
    }
    try {
      await ctx.ws.data.query(`SELECT 1 FROM "${tableA}" LIMIT 0`);
    } catch {
      return { ok: false, error: { code: "not_found", message: `dataset ${tableA} does not exist; upload it first` } };
    }
    try {
      await ctx.ws.data.query(`SELECT 1 FROM "${tableB}" LIMIT 0`);
    } catch {
      return { ok: false, error: { code: "not_found", message: `dataset ${tableB} does not exist; upload it first` } };
    }
    const matchedSql = matched_sql.trim().replace(/;+$/, "");
    const emit = (phase, payload) => {
      if (ctx.jobId) ctx.bus.emitProgress(ctx.jobId, phase, payload);
    };
    emit("validating");
    const matchTempTable = `_match_temp_${Date.now()}`;
    try {
      emit("matching");
      await ctx.ws.data.execute(`CREATE TABLE "${matchTempTable}" AS ${matchedSql}`);
    } catch (createErr) {
      const errMsg = createErr instanceof Error ? createErr.message : String(createErr);
      return {
        ok: false,
        error: { code: "match_sql_failed", message: errMsg, hint: "matched_sql must alias datasets as a and b" }
      };
    }
    const matchedCntRows = await ctx.ws.data.query(`SELECT COUNT(*) as cnt FROM "${matchTempTable}"`);
    const matchedCount = Number(matchedCntRows[0]?.cnt ?? 0);
    const matchCols = await ctx.ws.data.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = '${matchTempTable}'`
    );
    const matchColNames = new Set(matchCols.map((r) => String(r.column_name)));
    const aColsResult = await ctx.ws.data.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableA}'`
    );
    const aJoinCols = aColsResult.map((r) => String(r.column_name)).filter((c) => matchColNames.has(c));
    const bColsResult = await ctx.ws.data.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableB}'`
    );
    const bJoinCols = bColsResult.map((r) => String(r.column_name)).filter((c) => matchColNames.has(c));
    try {
      await ctx.ws.data.execute(`DROP TABLE IF EXISTS "${matchTempTable}"`);
    } catch {
    }
    emit("computing_unmatched");
    let unmatchedASql;
    let unmatchedBSql;
    if (aJoinCols.length > 0) {
      const aJoin = aJoinCols.map((c) => `"${tableA}"."${c}" = _m."${c}"`).join(" AND ");
      unmatchedASql = `WITH _matched AS (${matchedSql}) SELECT * FROM "${tableA}" WHERE NOT EXISTS (SELECT 1 FROM _matched _m WHERE ${aJoin})`;
    } else {
      unmatchedASql = `SELECT * FROM "${tableA}" WHERE FALSE`;
    }
    if (bJoinCols.length > 0) {
      const bJoin = bJoinCols.map((c) => `"${tableB}"."${c}" = _m."${c}"`).join(" AND ");
      unmatchedBSql = `WITH _matched AS (${matchedSql}) SELECT * FROM "${tableB}" WHERE NOT EXISTS (SELECT 1 FROM _matched _m WHERE ${bJoin})`;
    } else {
      unmatchedBSql = `SELECT * FROM "${tableB}" WHERE FALSE`;
    }
    const leftOnly = await ctx.ws.data.query(`SELECT COUNT(*) as cnt FROM (${unmatchedASql}) _ua`);
    const unmatchedACount = Number(leftOnly[0]?.cnt ?? 0);
    const rightOnly = await ctx.ws.data.query(`SELECT COUNT(*) as cnt FROM (${unmatchedBSql}) _ub`);
    const unmatchedBCount = Number(rightOnly[0]?.cnt ?? 0);
    emit("persisting");
    const run = ctx.recon.addRun({
      name: `Match ${tableA} vs ${tableB}`,
      datasetIdA: tableA,
      datasetIdB: tableB,
      joinKey: "custom_sql",
      config: { matched_sql: matchedSql }
    });
    const exportDir = join3(ctx.ws.dir, "exports", run.id);
    mkdirSync3(exportDir, { recursive: true });
    const unmatchedAPath = join3(exportDir, `unmatched_${tableA}.csv`);
    const unmatchedBPath = join3(exportDir, `unmatched_${tableB}.csv`);
    if (unmatchedACount > 0) {
      await ctx.ws.data.execute(
        `COPY (${unmatchedASql}) TO '${unmatchedAPath.replace(/'/g, "''")}' (HEADER, DELIMITER ',')`
      );
    }
    if (unmatchedBCount > 0) {
      await ctx.ws.data.execute(
        `COPY (${unmatchedBSql}) TO '${unmatchedBPath.replace(/'/g, "''")}' (HEADER, DELIMITER ',')`
      );
    }
    const sampleMatched = await ctx.ws.data.query(`${matchedSql} LIMIT 5`);
    const sampleExceptionsA = unmatchedACount > 0 ? truncateRowStrings(await ctx.ws.data.query(`${unmatchedASql} LIMIT 3`)) : [];
    const sampleExceptionsB = unmatchedBCount > 0 ? truncateRowStrings(await ctx.ws.data.query(`${unmatchedBSql} LIMIT 3`)) : [];
    const allExceptionsA = unmatchedACount > 0 ? truncateRowStrings(await ctx.ws.data.query(unmatchedASql)) : [];
    const allExceptionsB = unmatchedBCount > 0 ? truncateRowStrings(await ctx.ws.data.query(unmatchedBSql)) : [];
    const updatedRun = ctx.recon.updateRun(run.id, {
      status: "completed",
      summary: {
        totalA: matchedCount + unmatchedACount,
        totalB: matchedCount + unmatchedBCount,
        matched: matchedCount,
        unmatchedA: unmatchedACount,
        unmatchedB: unmatchedBCount,
        exceptions: unmatchedACount + unmatchedBCount
      }
    });
    ctx.recon.audit("match_completed", run.id, `${matchedCount} matched, ${unmatchedACount + unmatchedBCount} exceptions`);
    await ctx.recon.persistRun(updatedRun, {
      datasets: [
        { role: "primary", id: tableA, name: tableA, row_count: matchedCount + unmatchedACount },
        { role: "secondary", id: tableB, name: tableB, row_count: matchedCount + unmatchedBCount }
      ],
      unmatchedFiles: [
        ...unmatchedACount > 0 ? [{ dataset_id: tableA, path: unmatchedAPath, count: unmatchedACount }] : [],
        ...unmatchedBCount > 0 ? [{ dataset_id: tableB, path: unmatchedBPath, count: unmatchedBCount }] : []
      ],
      matchedSql,
      trigger: "chat"
    }).catch((err) => console.error("Failed to persist run:", err));
    ctx.recon.setMatchResult(run.id, {
      runId: run.id,
      matchedPairs: sampleMatched.map((r) => ({ rowA: r, rowB: r })),
      exceptionsA: allExceptionsA,
      exceptionsB: allExceptionsB,
      exportDir,
      unmatchedAPath: unmatchedACount > 0 ? unmatchedAPath : void 0,
      unmatchedBPath: unmatchedBCount > 0 ? unmatchedBPath : void 0
    });
    return {
      ok: true,
      data: {
        matchRunId: run.id,
        matched: matchedCount,
        unmatchedA: unmatchedACount,
        unmatchedB: unmatchedBCount,
        totalExceptions: unmatchedACount + unmatchedBCount,
        unmatchedAFile: unmatchedACount > 0 ? unmatchedAPath : null,
        unmatchedBFile: unmatchedBCount > 0 ? unmatchedBPath : null,
        sampleMatched: truncateRowStrings(sampleMatched),
        sampleExceptionsA,
        sampleExceptionsB
      }
    };
  }
};

// src/daemon/tools/get-exceptions.ts
import { z as z5 } from "zod";
var getExceptionsSchema = z5.object({
  match_run_id: z5.string(),
  side: z5.enum(["a", "b", "all"]).default("all"),
  page: z5.number().int().min(0).default(0),
  page_size: z5.number().int().min(1).max(200).default(50),
  description: z5.string().optional()
});
var getExceptions = {
  name: "get_exceptions",
  schema: getExceptionsSchema,
  async run(args, ctx) {
    const run = ctx.recon.getRun(args.match_run_id);
    const result = ctx.recon.getMatchResult(args.match_run_id);
    if (!run || !result) {
      return { ok: false, error: { code: "not_found", message: `match run not found: ${args.match_run_id}` } };
    }
    const upperSide = args.side === "a" ? "A" : args.side === "b" ? "B" : "all";
    const offset = args.page * args.page_size;
    const exceptions = ctx.recon.getExceptions(args.match_run_id, upperSide, args.page_size, offset);
    const total = run.summary ? args.side === "a" ? run.summary.unmatchedA : args.side === "b" ? run.summary.unmatchedB : run.summary.exceptions : 0;
    return {
      ok: true,
      data: {
        match_run_id: args.match_run_id,
        side: args.side,
        page: args.page,
        page_size: args.page_size,
        exceptions,
        total
      }
    };
  }
};

// src/daemon/tools/upload-dataset.ts
import { z as z6 } from "zod";
import { existsSync as existsSync4 } from "fs";
import { extname as extname2, basename as basename2 } from "path";
var uploadDatasetSchema = z6.object({
  path: z6.string(),
  alias: z6.string().optional(),
  description: z6.string().optional()
});
var uploadDataset = {
  name: "upload_dataset",
  schema: uploadDatasetSchema,
  async run({ path, alias }, ctx) {
    if (!existsSync4(path)) {
      return { ok: false, error: { code: "not_found", message: `file ${path} does not exist` } };
    }
    const ext = extname2(path).toLowerCase();
    if (ext !== ".csv" && ext !== ".xlsx") {
      return {
        ok: false,
        error: { code: "unsupported_format", message: `expected .csv or .xlsx, got ${ext}` }
      };
    }
    const baseName = (alias ?? basename2(path, ext)).replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
    const table = `${ext === ".csv" ? "csv" : "xlsx"}_${baseName}_${workspaceHash(path).slice(0, 8)}`;
    const escaped = path.replace(/'/g, "''");
    try {
      if (ext === ".csv") {
        await ctx.ws.data.execute(
          `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_csv_auto('${escaped}')`
        );
      } else {
        await ctx.ws.data.execute(`INSTALL excel; LOAD excel;`);
        await ctx.ws.data.execute(
          `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_xlsx('${escaped}')`
        );
      }
    } catch (e) {
      return {
        ok: false,
        error: { code: "ingestion_failed", message: e instanceof Error ? e.message : String(e) }
      };
    }
    const countRows = await ctx.ws.data.query(`SELECT COUNT(*)::INT AS n FROM ${table}`);
    const cols = await ctx.ws.data.query(`DESCRIBE ${table}`);
    await ctx.ws.meta.execute(
      `CREATE TABLE IF NOT EXISTS sources (name TEXT PRIMARY KEY, alias TEXT, uploaded_at BIGINT)`
    );
    const aliasLiteral = alias ? `'${alias.replace(/'/g, "''")}'` : "NULL";
    await ctx.ws.meta.execute(
      `INSERT OR REPLACE INTO sources VALUES ('${table}', ${aliasLiteral}, ${Date.now()})`
    );
    return {
      ok: true,
      data: {
        table_name: table,
        rows: Number(countRows[0]?.n ?? 0),
        columns: cols.map((c) => ({ name: c.column_name, type: c.column_type }))
      }
    };
  }
};

// src/daemon/tools/recall-known-mistakes.ts
import { z as z7 } from "zod";
var recallKnownMistakesSchema = z7.object({}).strict();
var recallKnownMistakes = {
  name: "recall_known_mistakes",
  schema: recallKnownMistakesSchema,
  async run(_args, ctx) {
    const patterns = await ctx.errorMemory.getTopPatterns(10);
    return { ok: true, data: { patterns } };
  }
};

// src/daemon/tools/index.ts
var TOOLS = {
  upload_dataset: uploadDataset,
  list_sources: listSources,
  load_sheet: loadSheet,
  run_sql: runSql,
  run_match: runMatch,
  get_exceptions: getExceptions,
  recall_known_mistakes: recallKnownMistakes
};

// src/daemon/routes/tools.ts
var toolsRoutes = async (fastify) => {
  const f = fastify;
  f.post(
    "/workspaces/:hash/tools/:name",
    async (req, reply) => {
      const { hash, name } = req.params;
      const tool = TOOLS[name];
      if (!tool) {
        return reply.code(404).send({ ok: false, error: { code: "unknown_tool", message: `no tool '${name}'` } });
      }
      const parse = tool.schema.safeParse(req.body);
      if (!parse.success) {
        return reply.code(400).send({ ok: false, error: { code: "invalid_args", message: parse.error.message } });
      }
      const stores = await f.storesFor(hash);
      const jobId = req.headers["x-matchi-job-id"] ?? randomUUID4();
      const ctx = { ...stores, bus: f.bus, jobId };
      try {
        const result = await tool.run(parse.data, ctx);
        return result;
      } catch (e) {
        return reply.code(500).send({
          ok: false,
          error: { code: "tool_threw", message: e instanceof Error ? e.message : String(e) }
        });
      }
    }
  );
};

// src/daemon/routes/stream.ts
var streamRoutes = async (fastify) => {
  const f = fastify;
  f.get(
    "/workspaces/:hash/stream",
    async (req, reply) => {
      const jobId = req.query.id;
      if (!jobId) {
        return reply.code(400).send({ ok: false, error: { code: "missing_job_id", message: "id query param required" } });
      }
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      const unsubscribe = f.bus.subscribe(jobId, (event) => {
        reply.raw.write(`event: progress
data: ${JSON.stringify(event)}

`);
      });
      const heartbeat = setInterval(() => {
        reply.raw.write(`: heartbeat

`);
      }, 15e3);
      heartbeat.unref();
      req.raw.on("close", () => {
        unsubscribe();
        clearInterval(heartbeat);
        try {
          reply.raw.end();
        } catch {
        }
      });
      return reply;
    }
  );
};

// src/daemon/routes/state.ts
var stateRoutes = async (fastify) => {
  const f = fastify;
  f.get("/workspaces/:hash/state", async (req) => {
    const { hash } = req.params;
    const stores = await f.storesFor(hash);
    const sources = await stores.ws.meta.query(`SELECT name, alias, uploaded_at FROM sources`).catch(() => []);
    let runs = [];
    try {
      runs = stores.recon.listRuns();
    } catch {
      runs = [];
    }
    return { ok: true, data: { sources, runs: runs.slice(0, 10) } };
  });
  f.post("/shutdown", async (_req, reply) => {
    reply.send({ ok: true, data: { shutting_down: true } });
    setTimeout(() => f.close().then(() => process.exit(0)), 50);
  });
};

// src/daemon/server.ts
async function buildServer(opts) {
  const fastify = Fastify({ logger: opts.logger ?? false });
  await fastify.register(sensible);
  const registry = new WorkspaceRegistry({ idleTimeoutMs: opts.idleTimeoutMs });
  const bus = new ProgressBus();
  let version = "0.0.0";
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join4(here, "..", "..", "package.json");
    version = JSON.parse(readFileSync3(pkgPath, "utf8")).version;
  } catch {
  }
  fastify.registry = registry;
  fastify.bus = bus;
  fastify.matchiVersion = version;
  fastify.startedAt = Date.now();
  const storesCache = /* @__PURE__ */ new Map();
  fastify.storesFor = async (hash) => {
    const existing = storesCache.get(hash);
    if (existing) return existing;
    const ws = await registry.touch(hash);
    const recon = new ReconStore(ws.meta);
    await recon.init();
    const recipe = new RecipeStore(ws.meta);
    await recipe.init();
    const errorMemory = new ErrorMemoryStore(ws.meta);
    await errorMemory.init();
    const stores = { ws, recon, recipe, errorMemory };
    storesCache.set(hash, stores);
    return stores;
  };
  fastify.addHook("preHandler", makeAuthHook(registry));
  await fastify.register(healthRoutes);
  await fastify.register(toolsRoutes, { prefix: "/v1" });
  await fastify.register(streamRoutes, { prefix: "/v1" });
  await fastify.register(stateRoutes, { prefix: "/v1" });
  fastify.addHook("onClose", async () => {
    await registry.closeAll();
    storesCache.clear();
  });
  return fastify;
}
export {
  buildServer
};
//# sourceMappingURL=server.js.map