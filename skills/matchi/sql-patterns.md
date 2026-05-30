# DuckDB SQL Patterns for Reconciliation

A cookbook of DuckDB idioms that come up repeatedly in matchi work. Each pattern includes a snippet, when to use it, and when not to.

## Loading data

`upload_dataset` already wraps the loaders (`sheet` arg covers the XLSX-per-sheet case). If you need to inspect a file before registering it, you generally can't — `run_sql` is restricted to registered tables. Load first, then explore.

If a CSV has a non-standard delimiter or decimal separator, mention it in the upload call (or pass the override via the loader). For reference, the DuckDB readers accept:

```sql
read_csv_auto('path.csv', delim=';', decimal_separator=',', quote='"')
read_xlsx('path.xlsx', sheet='Sheet1')
```

**When to use:** during upload/registration only.
**When not to use:** never call these directly in `run_sql` — the tool restricts to registered tables.

## Schema discovery

```sql
SELECT column_name, column_type FROM (DESCRIBE my_table);
```

or

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'my_table'
ORDER BY ordinal_position;
```

**Use:** at the start of every reconciliation, on every table.

## Row counts and key health

```sql
SELECT
  COUNT(*)                                AS rows,
  COUNT(DISTINCT ref)                     AS distinct_refs,
  COUNT(*) FILTER (WHERE ref IS NULL)     AS null_refs,
  COUNT(*) FILTER (WHERE TRIM(ref) = '')  AS empty_refs
FROM my_table;
```

Tells you in one query whether the key is usable. If `distinct_refs / rows < 0.95`, duplicates exist; investigate before joining.

## Sampling

```sql
SELECT * FROM my_table USING SAMPLE 10;           -- 10 random rows
SELECT * FROM my_table USING SAMPLE 5 PERCENT;    -- proportional sample
SELECT * FROM my_table ORDER BY random() LIMIT 10; -- non-reservoir random
```

**Use:** `USING SAMPLE 10` is your go-to for eyeballing data. Faster than `LIMIT 10` for large tables and not biased toward the first rows.

## Anti-join (rows in A not in B)

Two equivalent forms:

```sql
-- LEFT JOIN + NULL filter
SELECT a.* FROM table_a a LEFT JOIN table_b b ON a.key = b.key WHERE b.key IS NULL;

-- NOT EXISTS
SELECT a.* FROM table_a a WHERE NOT EXISTS (SELECT 1 FROM table_b b WHERE b.key = a.key);
```

**Use `LEFT JOIN ... IS NULL`** as the default. It's readable and DuckDB optimizes it well.
**Use `NOT EXISTS`** when `table_b` has a complex predicate or when `table_b.key` can be null (NULL-safe comparison needed).

Note: `run_match` derives the unmatched sides internally — you don't need to write the anti-join. But during discovery you'll often write one to size up the gap.

## Deduplication with row_number

```sql
SELECT * FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY ref ORDER BY posted_at DESC) AS rn
  FROM bank_statement
) WHERE rn = 1;
```

Or with the cleaner `QUALIFY`:

```sql
SELECT *
FROM bank_statement
QUALIFY ROW_NUMBER() OVER (PARTITION BY ref ORDER BY posted_at DESC) = 1;
```

**Use:** to pick the latest row per key when duplicates are legitimate (e.g. corrections that supersede earlier entries).
**Don't use:** to hide data quality issues. If duplicates aren't supposed to exist, flag them in your summary.

## Date arithmetic

```sql
DATEDIFF('day', a.date, b.date)             -- whole days
EPOCH(a.posted_at - b.posted_at)            -- seconds (TIMESTAMP - TIMESTAMP)
a.date + INTERVAL 3 DAY                     -- date offset
date_trunc('month', a.posted_at)            -- first day of month
strptime(s, '%d/%m/%Y')                     -- parse string to date
strftime(d, '%Y-%m-%d')                     -- format date to string
TRY_CAST(s AS DATE)                         -- attempt auto-parse, NULL on failure
```

**Tolerance pattern:**

```sql
WHERE ABS(DATEDIFF('day', a.date, b.date)) <= 3
-- or
WHERE b.date BETWEEN a.date - INTERVAL 1 DAY AND a.date + INTERVAL 3 DAY
```

The `BETWEEN` form is friendlier to range optimizations.

## Regex

```sql
regexp_matches(col, '^INV-\\d+$')            -- boolean
regexp_extract(col, 'INV-(\\d+)', 1)         -- capture group 1
regexp_replace(col, '[^0-9]', '', 'g')       -- strip non-digits
regexp_replace(col, '\\s+', ' ', 'g')        -- collapse whitespace
regexp_full_match(col, '^\\d{10}$')          -- exact match
```

**Use:** extracting embedded references from free-text descriptions, normalizing reference formats, parsing currency strings.

```sql
-- Pull invoice number from a payment memo
regexp_extract(b.description, 'INV[/-]?(\\d{4,})', 1)

-- Parse "Rp 1.234.567,00" to a number
TRY_CAST(
  regexp_replace(replace(col, '.', ''), '[^0-9,-]', '', 'g')
  AS DOUBLE
) / 1.0  -- handle the comma-decimal locale separately if needed
```

## String normalization

```sql
UPPER(TRIM(col))
REPLACE(col, '/', '-')
REPLACE(REPLACE(col, '/', '-'), ' ', '')
lower(regexp_replace(col, '[^a-z0-9]', '', 'g'))   -- alphanumeric fingerprint
```

For a stable join key, layer them:

```sql
UPPER(REPLACE(REPLACE(TRIM(col), '/', '-'), ' ', ''))
```

Apply the *same* transformation on both sides of the join.

## Fuzzy similarity

```sql
levenshtein(a, b)                                  -- edit distance, lower = closer
jaro_winkler_similarity(lower(a), lower(b))        -- 0.0..1.0, higher = closer
soundex(col)                                       -- phonetic bucket
```

**Use thresholds:**
- Reference numbers: `levenshtein(a, b) <= 1` (one typo)
- Vendor/counterparty names: `jaro_winkler_similarity(lower(a), lower(b)) > 0.90`
- Free-text descriptions: don't fuzzy-match these; extract structured tokens first

**Don't use** as the *only* join condition — pair with an exact key (date bucket, amount bucket, account ID) to keep the search space sane.

## Tolerance comparisons

```sql
ABS(a.amount - b.amount) < 0.01                            -- one cent
ABS(a.amount - b.amount) / NULLIF(ABS(a.amount), 0) < 0.01 -- 1% relative
ABS(a.amount * fx.rate - b.amount) < 1.0                   -- absolute, in target currency
```

Always wrap the divisor in `NULLIF(..., 0)` to avoid division-by-zero on zero-amount rows.

## Bucketed range joins (performance)

Pure tolerance joins (`ABS(a.x - b.x) < tol`) force a cross product. To get a hash-join, add an equality on a bucket:

```sql
SELECT a.id, b.id
FROM table_a a JOIN table_b b
  ON a.ref = b.ref
 AND date_trunc('day', a.posted_at) = date_trunc('day', b.posted_at)
WHERE ABS(EPOCH(a.posted_at - b.posted_at)) < 86400
```

The `date_trunc` equality lets DuckDB hash-partition; the `EPOCH` filter refines.

**Use:** when either side has > ~50k rows and tolerance joins are slow.
**Don't use:** for tiny tables — the bucket adds complexity without benefit.

## NULL handling

```sql
COALESCE(col, 'UNKNOWN')                       -- replace null
COALESCE(col1, col2, col3)                     -- first non-null
a.col IS NOT DISTINCT FROM b.col               -- NULL-safe equality
```

`IS NOT DISTINCT FROM` is critical when joining on columns that can be null on both sides — plain `=` treats `NULL = NULL` as false.

## Aggregation with filters

```sql
SELECT
  COUNT(*) FILTER (WHERE status = 'matched')   AS matched_count,
  SUM(amount) FILTER (WHERE side = 'CR')       AS total_credit,
  SUM(amount) FILTER (WHERE side = 'DR')       AS total_debit
FROM postings;
```

Cleaner than `CASE WHEN ... THEN ... END` inside the aggregate.

## Window aggregations

```sql
SUM(amount) OVER (PARTITION BY account ORDER BY posted_at
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance,
LAG(amount) OVER (PARTITION BY account ORDER BY posted_at)         AS prev_amount,
ROW_NUMBER() OVER (PARTITION BY ref ORDER BY posted_at DESC)       AS rn
```

**Use:** computing running balances, detecting duplicates, picking the latest entry per key.

## List aggregation

```sql
SELECT
  payment_ref,
  string_agg(invoice_no, ', ' ORDER BY invoice_no) AS invoices,
  LIST(invoice_no ORDER BY invoice_no)             AS invoice_list,
  SUM(amount)                                      AS total
FROM invoices GROUP BY payment_ref;
```

`string_agg` returns a delimited string; `LIST` returns a DuckDB array. Use `string_agg` in match output for readability; use `LIST` when you need to feed the values to another query.

## JSON extraction

```sql
json_extract(col, '$.field')                    -- returns JSON
json_extract_string(col, '$.address.city')      -- returns VARCHAR (preferred for matching)
```

Common when a "description" column contains JSON-encoded metadata.

## Pivot / unpivot

```sql
-- Wide to long
UNPIVOT my_table ON jan, feb, mar, apr
INTO NAME month VALUE amount;

-- Long to wide
PIVOT my_table ON month USING SUM(amount);
```

**Use:** when one source is monthly buckets and the other is row-per-transaction. `UNPIVOT` the buckets to get one row per period.

## Many-to-one collapse

```sql
WITH paid AS (
  SELECT payment_ref, SUM(amount) AS total, COUNT(*) AS n
  FROM invoices
  GROUP BY payment_ref
)
SELECT a.id, b.payment_ref, b.n AS n_invoices
FROM bank a JOIN paid b ON a.ref = b.payment_ref
WHERE ABS(a.amount - b.total) < 0.01;
```

**Use:** when one side is the aggregate of N rows on the other.

## Multi-leg netting

```sql
WITH legs AS (
  SELECT clearing_ref,
         SUM(CASE WHEN side='CR' THEN amount ELSE -amount END) AS net
  FROM gl WHERE account = 'CLEARING' GROUP BY clearing_ref
)
SELECT a.id, b.clearing_ref
FROM bank a JOIN legs b ON a.ref = b.clearing_ref
WHERE ABS(a.amount - b.net) < 0.01;
```

## Currency conversion in joins

```sql
SELECT a.id, b.id
FROM ic_a a
JOIN fx ON a.currency = fx.from_ccy AND fx.to_ccy = 'IDR' AND fx.rate_date = a.posted_date
JOIN ic_b b ON a.ref = b.ref
WHERE ABS(a.amount * fx.rate - b.amount) < 1.0;  -- 1 IDR tolerance
```

## EXCEPT / INTERSECT

```sql
SELECT ref FROM table_a EXCEPT SELECT ref FROM table_b;     -- refs only in A
SELECT ref FROM table_a INTERSECT SELECT ref FROM table_b;  -- refs in both
```

**Use:** quick set comparisons during discovery.

## Self-join for duplicates

```sql
SELECT a.* FROM my_table a JOIN my_table b
  ON a.key = b.key AND a.rowid < b.rowid;
```

Returns one row per duplicate pair without doubling.

## QUALIFY (filter after window)

```sql
SELECT * FROM bank_statement
QUALIFY ROW_NUMBER() OVER (PARTITION BY ref ORDER BY posted_at DESC) = 1;
```

`QUALIFY` is to window functions what `HAVING` is to aggregates — much cleaner than wrapping in a subquery.

## TRY_CAST

```sql
TRY_CAST(col AS DATE)
TRY_CAST(col AS DOUBLE)
TRY_CAST(col AS BIGINT)
```

Returns `NULL` on failure instead of throwing. Use for messy columns where some rows aren't parseable; combine with `COUNT(*) FILTER (WHERE TRY_CAST(col AS DATE) IS NULL)` to size the problem.

## Common reconciliation join templates

**Key + amount tolerance:**

```sql
SELECT a.id, b.id FROM a JOIN b ON UPPER(TRIM(a.ref)) = UPPER(TRIM(b.ref))
WHERE ABS(a.amount - b.amount) < 0.01;
```

**Key + date tolerance:**

```sql
SELECT a.id, b.id FROM a JOIN b ON a.ref = b.ref
WHERE ABS(DATEDIFF('day', a.date, b.date)) <= 3;
```

**Fuzzy name + amount:**

```sql
SELECT a.id, b.id FROM a JOIN b
  ON jaro_winkler_similarity(lower(a.vendor), lower(b.vendor)) > 0.90
 AND date_trunc('month', a.date) = date_trunc('month', b.date)
WHERE ABS(a.amount - b.amount) < 0.01;
```

**Extracted reference from memo:**

```sql
SELECT a.id, b.id FROM a JOIN b
  ON a.ref = regexp_extract(b.description, 'REF[:\\-]?\\s*(\\w+)', 1);
```

**Batch payment matches N invoices:**

```sql
WITH grp AS (
  SELECT payment_ref, SUM(amount) AS total
  FROM invoices GROUP BY payment_ref
)
SELECT a.payment_ref, grp.total
FROM bank_payments a JOIN grp ON a.ref = grp.payment_ref
WHERE ABS(a.amount - grp.total) < 0.01;
```

## Things to avoid

- `SELECT *` from a giant table without `LIMIT` — `run_sql` caps at 20 rows, but the planner still scans.
- Amount equality in `JOIN ... ON`. Move it to `WHERE` so you can compute `ABS(a.amount - b.amount)` as an output for diagnosis.
- `LIKE '%...%'` on multi-million-row tables — no index, full scan.
- Date math on `VARCHAR` date columns — `TRY_CAST` first.
- Cross joins by accident (missing `ON` clause). DuckDB will warn but still try; abort with `LIMIT 0` first if unsure.
