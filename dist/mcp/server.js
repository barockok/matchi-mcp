// src/mcp/server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";

// src/shared/hash.ts
import { createHash } from "crypto";
function workspaceHash(cwd) {
  return createHash("sha1").update(cwd).digest("hex").slice(0, 12);
}

// src/mcp/autospawn.ts
import { spawn } from "child_process";
import { setTimeout as sleep } from "timers/promises";
import { fileURLToPath } from "url";
import { dirname as dirname2, resolve } from "path";
import { existsSync as existsSync3 } from "fs";

// src/mcp/http-client.ts
import { existsSync, readFileSync } from "fs";

// src/shared/paths.ts
import { homedir } from "os";
import { join } from "path";
function matchiHome() {
  return process.env.MATCHI_HOME ?? join(homedir(), ".matchi");
}
function workspaceDir(hash) {
  return join(matchiHome(), "workspaces", hash);
}
function daemonInfoPath() {
  return join(matchiHome(), "daemon.json");
}
function workspaceTokenPath(hash) {
  return join(workspaceDir(hash), ".token");
}

// src/mcp/http-client.ts
var DaemonClient = class {
  constructor(port, hash) {
    this.port = port;
    this.hash = hash;
  }
  port;
  hash;
  token() {
    const p = workspaceTokenPath(this.hash);
    if (!existsSync(p)) throw new Error(`workspace token missing at ${p}`);
    return readFileSync(p, "utf8").trim();
  }
  async call(toolName, args, jobId) {
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${this.token()}`
    };
    if (jobId) headers["x-matchi-job-id"] = jobId;
    const r = await fetch(
      `http://127.0.0.1:${this.port}/v1/workspaces/${this.hash}/tools/${toolName}`,
      { method: "POST", headers, body: JSON.stringify(args ?? {}) }
    );
    return r.json();
  }
  streamUrl(jobId) {
    return `http://127.0.0.1:${this.port}/v1/workspaces/${this.hash}/stream?id=${jobId}`;
  }
  bearer() {
    return this.token();
  }
};
function readDaemonInfoFromFs() {
  const p = daemonInfoPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// src/daemon/lifecycle.ts
import { writeFileSync, readFileSync as readFileSync2, existsSync as existsSync2, unlinkSync, mkdirSync } from "fs";
import { dirname } from "path";
import { createServer } from "net";
function isDaemonAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// src/mcp/autospawn.ts
var DAEMON_BIN = (() => {
  const here = dirname2(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "bin", "matchi-daemon.js");
})();
async function healthOk(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`);
    return r.ok;
  } catch {
    return false;
  }
}
async function ensureDaemon() {
  let info = readDaemonInfoFromFs();
  if (info && isDaemonAlive(info.pid) && await healthOk(info.port)) {
    return info;
  }
  const child = spawn(process.execPath, [DAEMON_BIN], {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    info = readDaemonInfoFromFs();
    if (info && await healthOk(info.port)) return info;
  }
  throw new Error("matchi-daemon failed to start within 10s");
}
async function ensureToken(port, hash) {
  if (existsSync3(workspaceTokenPath(hash))) return;
  try {
    await fetch(`http://127.0.0.1:${port}/v1/workspaces/${hash}/touch`, { method: "GET" });
  } catch {
  }
  if (!existsSync3(workspaceTokenPath(hash))) {
    throw new Error("failed to materialize workspace token after handshake probe");
  }
}

// src/mcp/tools.ts
import { zodToJsonSchema } from "zod-to-json-schema";

// src/daemon/tools/upload-dataset.ts
import { z } from "zod";
import { existsSync as existsSync4 } from "fs";
import { extname, basename } from "path";
var ALLOWED_EXT = /* @__PURE__ */ new Set([".csv", ".xlsx", ".parquet"]);
var uploadDatasetSchema = z.object({
  path: z.string(),
  alias: z.string().optional(),
  sheet: z.string().optional(),
  materialize: z.boolean().optional(),
  description: z.string().optional()
});
var uploadDataset = {
  name: "upload_dataset",
  schema: uploadDatasetSchema,
  async run({ path, alias, sheet, materialize }, ctx) {
    if (!existsSync4(path)) {
      return { ok: false, error: { code: "not_found", message: `file ${path} does not exist` } };
    }
    const ext = extname(path).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return {
        ok: false,
        error: { code: "unsupported_format", message: `expected .csv/.xlsx/.parquet, got ${ext}` }
      };
    }
    if (sheet && ext !== ".xlsx") {
      return { ok: false, error: { code: "sheet_unsupported", message: "sheet arg only valid for .xlsx" } };
    }
    const baseName = (alias ?? basename(path, ext)).replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
    const shouldMaterialize = materialize ?? ext === ".xlsx";
    const object = shouldMaterialize ? "TABLE" : "VIEW";
    const escapedPath = path.replace(/'/g, "''");
    const reader = ext === ".csv" ? `read_csv_auto('${escapedPath}')` : ext === ".parquet" ? `read_parquet('${escapedPath}')` : `read_xlsx('${escapedPath}'${sheet ? `, sheet='${sheet.replace(/'/g, "''")}'` : ""})`;
    try {
      if (ext === ".xlsx") {
        await ctx.ws.data.execute(`INSTALL excel; LOAD excel;`);
      }
      await ctx.ws.data.execute(`CREATE OR REPLACE ${object} ${baseName} AS SELECT * FROM ${reader}`);
    } catch (e) {
      return {
        ok: false,
        error: { code: "ingestion_failed", message: e instanceof Error ? e.message : String(e) }
      };
    }
    const countRows = await ctx.ws.data.query(`SELECT COUNT(*)::INT AS n FROM ${baseName}`);
    const cols = await ctx.ws.data.query(`DESCRIBE ${baseName}`);
    return {
      ok: true,
      data: {
        table_name: baseName,
        rows: Number(countRows[0]?.n ?? 0),
        columns: cols.map((c) => ({ name: c.column_name, type: c.column_type })),
        mode: object.toLowerCase()
      }
    };
  }
};

// src/daemon/tools/list-sources.ts
import { z as z2 } from "zod";
var listSourcesSchema = z2.object({
  description: z2.string().optional()
});
var listSources = {
  name: "list_sources",
  schema: listSourcesSchema,
  async run(_args, ctx) {
    const rows = await ctx.ws.data.query(
      `SELECT table_name, table_type
       FROM information_schema.tables
       WHERE table_schema = 'main'
       ORDER BY table_name`
    );
    const out = [];
    for (const r of rows) {
      if (r.table_name.startsWith("_")) continue;
      try {
        const countRows = await ctx.ws.data.query(
          `SELECT COUNT(*)::INT AS n FROM ${r.table_name}`
        );
        const cols = await ctx.ws.data.query(`DESCRIBE ${r.table_name}`);
        out.push({
          table: r.table_name,
          rows: Number(countRows[0]?.n ?? 0),
          columns: cols.map((c) => ({ name: c.column_name, type: c.column_type })),
          is_view: r.table_type === "VIEW"
        });
      } catch {
      }
    }
    return { ok: true, data: { sources: out } };
  }
};

// src/daemon/tools/run-sql.ts
import { z as z3 } from "zod";
var MAX_ROWS = 20;
var MAX_STRING_LENGTH = 120;
var MAX_BATCH_SIZE = 10;
var MAX_BATCH_PAYLOAD = 2e4;
var DANGEROUS_KEYWORDS = /\b(DROP|DELETE|INSERT|UPDATE|ALTER|CREATE|TRUNCATE|REPLACE|ATTACH|COPY|EXPORT|CALL)\b/i;
var batchItemSchema = z3.object({
  sql: z3.string(),
  limit: z3.number().optional(),
  count_only: z3.boolean().optional(),
  description: z3.string().optional()
});
var runSqlSchema = z3.object({
  sql: z3.string().optional(),
  limit: z3.number().optional(),
  count_only: z3.boolean().optional(),
  queries: z3.array(batchItemSchema).max(MAX_BATCH_SIZE).optional(),
  description: z3.string().optional()
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

// src/daemon/tools/run-match.ts
import { z as z4 } from "zod";
import { mkdirSync as mkdirSync2 } from "fs";
import { join as join2 } from "path";
var runMatchSchema = z4.object({
  matched_sql: z4.string(),
  a: z4.string(),
  b: z4.string(),
  description: z4.string().optional()
});
var MAX_STR_LEN = 100;
var PREVIEW_CAP = 200;
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
async function runMatchCore(args, ctx) {
  const { matched_sql, a, b } = args;
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
  const matchTempTable = `_match_temp_${Date.now()}`;
  try {
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
  const run = ctx.recon.addRun({
    name: `Match ${tableA} vs ${tableB}`,
    datasetIdA: tableA,
    datasetIdB: tableB,
    joinKey: "custom_sql",
    config: { matched_sql: matchedSql }
  });
  const exportDir = join2(ctx.ws.dir, "exports", run.id);
  mkdirSync2(exportDir, { recursive: true });
  const unmatchedAPath = join2(exportDir, `unmatched_${tableA}.csv`);
  const unmatchedBPath = join2(exportDir, `unmatched_${tableB}.csv`);
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
  const previewA = unmatchedACount > 0 ? truncateRowStrings(await ctx.ws.data.query(`${unmatchedASql} LIMIT ${PREVIEW_CAP}`)) : [];
  const previewB = unmatchedBCount > 0 ? truncateRowStrings(await ctx.ws.data.query(`${unmatchedBSql} LIMIT ${PREVIEW_CAP}`)) : [];
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
    matchedPairs: [],
    exceptionsA: previewA,
    exceptionsB: previewB,
    exportDir,
    unmatchedAPath: unmatchedACount > 0 ? unmatchedAPath : void 0,
    unmatchedBPath: unmatchedBCount > 0 ? unmatchedBPath : void 0
  });
  return {
    ok: true,
    data: {
      matched: matchedCount,
      unmatched_a_total: unmatchedACount,
      unmatched_b_total: unmatchedBCount,
      unmatched_a_preview: previewA,
      unmatched_b_preview: previewB,
      match_run_id: run.id
    }
  };
}
var runMatch = {
  name: "run_match",
  schema: runMatchSchema,
  run: runMatchCore
};

// src/daemon/tools/recall-known-mistakes.ts
import { z as z5 } from "zod";
var recallKnownMistakesSchema = z5.object({}).strict();
var recallKnownMistakes = {
  name: "recall_known_mistakes",
  schema: recallKnownMistakesSchema,
  async run(_args, ctx) {
    const patterns = await ctx.errorMemory.getTopPatterns(10);
    return { ok: true, data: { patterns } };
  }
};

// src/daemon/tools/save-recipe.ts
import { z as z6 } from "zod";
var saveRecipeSchema = z6.object({
  name: z6.string().min(1).max(128),
  match_sql: z6.string().min(1),
  sources: z6.array(
    z6.object({
      alias: z6.string(),
      table: z6.string()
    })
  ).min(2).max(2),
  description: z6.string().optional(),
  overwrite: z6.boolean().optional()
});
var saveRecipe = {
  name: "save_recipe",
  schema: saveRecipeSchema,
  async run({ name, match_sql, sources, description, overwrite }, ctx) {
    const existing = await ctx.recipe.getRecipe(name);
    if (existing && !overwrite) {
      return {
        ok: false,
        error: {
          code: "recipe_exists",
          message: `recipe '${name}' already exists; pass overwrite:true or delete it first`
        }
      };
    }
    if (existing) await ctx.recipe.deleteRecipe(name);
    await ctx.recipe.addRecipe({ name, match_sql, sources, description: description ?? null });
    return { ok: true, data: { name } };
  }
};

// src/daemon/tools/list-recipes.ts
import { z as z7 } from "zod";
var listRecipesSchema = z7.object({
  description: z7.string().optional()
});
var listRecipes = {
  name: "list_recipes",
  schema: listRecipesSchema,
  async run(_args, ctx) {
    const rows = await ctx.recipe.listRecipes();
    return {
      ok: true,
      data: {
        recipes: rows.map((r) => ({
          name: r.name,
          description: r.description,
          source_aliases: r.sources.map((s) => s.alias),
          match_sql: r.match_sql,
          created_at: r.created_at,
          last_run_at: r.last_run_at,
          last_match_rate: r.last_match_rate,
          run_count: r.run_count
        }))
      }
    };
  }
};

// src/daemon/tools/apply-recipe.ts
import { z as z8 } from "zod";
var applyRecipeSchema = z8.object({
  name: z8.string(),
  description: z8.string().optional()
});
var applyRecipe = {
  name: "apply_recipe",
  schema: applyRecipeSchema,
  async run({ name }, ctx) {
    const recipe = await ctx.recipe.getRecipe(name);
    if (!recipe) {
      return { ok: false, error: { code: "recipe_not_found", message: `no recipe '${name}'` } };
    }
    const sources = await ctx.ws.data.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'`
    );
    const existing = new Set(sources.map((s) => s.table_name));
    const missing = recipe.sources.filter((s) => !existing.has(s.table)).map((s) => s.alias);
    if (missing.length > 0) {
      return {
        ok: false,
        error: {
          code: "sources_missing",
          message: `recipe needs sources not in workspace: ${missing.join(", ")}`,
          hint: "upload_dataset(...) for each missing source first"
        }
      };
    }
    const [a, b] = recipe.sources;
    const result = await runMatchCore(
      { matched_sql: recipe.match_sql, a: a.table, b: b.table },
      ctx
    );
    if (result.ok) {
      const total = result.data.matched + Math.max(result.data.unmatched_a_total, result.data.unmatched_b_total);
      const matchRate = total > 0 ? result.data.matched / total : 0;
      await ctx.recipe.recordRun(name, matchRate);
    }
    return result;
  }
};

// src/daemon/tools/index.ts
var TOOLS = {
  upload_dataset: uploadDataset,
  list_sources: listSources,
  run_sql: runSql,
  run_match: runMatch,
  recall_known_mistakes: recallKnownMistakes,
  save_recipe: saveRecipe,
  list_recipes: listRecipes,
  apply_recipe: applyRecipe
};

// src/mcp/tools.ts
var DESCRIPTIONS = {
  upload_dataset: "Register a local CSV/XLSX/Parquet file as a DuckDB view (zero-copy) or materialized table. Optional `sheet` for .xlsx; optional `materialize:true` for a snapshot table.",
  list_sources: "List all datasets in the workspace (tables and views). Each entry includes row count, column types, and an `is_view` flag.",
  run_sql: "Execute a read-only DuckDB SQL query (or up to 10 batched queries). Caps results at 20 rows; DROP/DELETE/INSERT/UPDATE/ALTER/CREATE/TRUNCATE/REPLACE/ATTACH/COPY/EXPORT/CALL are blocked.",
  run_match: "Run a reconciliation: provide matched_sql that joins datasets aliased as a and b. Returns matched count, unmatched totals, and an inline preview of up to 200 unmatched rows per side.",
  recall_known_mistakes: "Return the top-10 patterns the agent has previously tripped over in this workspace. Call once at session start.",
  save_recipe: "Persist a reusable recipe (match_sql + source aliases) under a name. Use at the end of a successful recon so next month you can call apply_recipe instead of re-deriving.",
  list_recipes: "List saved recipes in this workspace. Each entry includes name, description, source aliases, match_sql, and last-run stats.",
  apply_recipe: "Re-run a saved recipe. Returns the same shape as run_match. Fails with code 'sources_missing' if any source alias is not in the current workspace."
};
function jsonSchemaFor(schema) {
  const out = zodToJsonSchema(schema, { target: "jsonSchema7" });
  if ("$schema" in out) delete out.$schema;
  return out;
}
function listMcpTools() {
  return Object.entries(TOOLS).map(([name, tool]) => ({
    name,
    description: DESCRIPTIONS[name] ?? `Matchi tool: ${name}`,
    inputSchema: jsonSchemaFor(tool.schema)
  }));
}

// src/mcp/server.ts
async function main() {
  const hash = workspaceHash(process.cwd());
  const info = await ensureDaemon();
  await ensureToken(info.port, hash);
  const client = new DaemonClient(info.port, hash);
  const server = new Server(
    { name: "matchi", version: info.version },
    { capabilities: { tools: {} } }
  );
  const tools = listMcpTools();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const jobId = randomUUID();
    const result = await client.call(name, args ?? {}, jobId);
    const isError = typeof result === "object" && result !== null && result.ok === false;
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError
    };
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch((err) => {
  console.error("matchi fatal:", err);
  process.exit(1);
});
export {
  main
};
//# sourceMappingURL=server.js.map