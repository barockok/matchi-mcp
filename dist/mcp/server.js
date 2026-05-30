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
    await fetch(`http://127.0.0.1:${port}/v1/workspaces/${hash}/state`, { method: "GET" });
  } catch {
  }
  if (!existsSync3(workspaceTokenPath(hash))) {
    throw new Error("failed to materialize workspace token after handshake probe");
  }
}

// src/mcp/tools.ts
import { zodToJsonSchema } from "zod-to-json-schema";

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
import { existsSync as existsSync4 } from "fs";
import { basename, extname } from "path";
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
    if (!existsSync4(path)) {
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
import { mkdirSync as mkdirSync2 } from "fs";
import { join as join2 } from "path";
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
import { existsSync as existsSync5 } from "fs";
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
    if (!existsSync5(path)) {
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

// src/mcp/tools.ts
var DESCRIPTIONS = {
  upload_dataset: "Load a local CSV or XLSX file into the workspace DuckDB. Returns the table name, row count, and column list.",
  list_sources: "List all datasets registered in the current workspace.",
  load_sheet: "Load a specific sheet from an XLSX file into the workspace DuckDB.",
  run_sql: "Execute a read-only DuckDB SQL query (or up to 10 batched queries). Caps results at 20 rows; DROP/DELETE/INSERT/UPDATE/ALTER/CREATE/TRUNCATE/REPLACE/ATTACH/COPY/EXPORT/CALL are blocked.",
  run_match: "Run a reconciliation: provide matched_sql that joins datasets aliased as a and b. Streams progress and persists matched + unmatched results.",
  get_exceptions: "Page through unmatched rows from the most recent run_match for one side.",
  recall_known_mistakes: "Return the top-10 patterns the agent has previously tripped over in this workspace. Call once at session start."
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