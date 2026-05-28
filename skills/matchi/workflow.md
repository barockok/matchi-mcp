# Matchi Workflow — Detailed Patterns

This document is the long-form companion to `SKILL.md`. It explains *why* each step matters and walks through patterns that come up repeatedly in real financial reconciliation work. Read this when the headline workflow isn't enough — when match rates are stuck, when one side has more rows than the other, when dates won't line up, or when the data shape is genuinely strange.

## 1. Discovery checklist

Discovery is where reconciliation is won or lost. The match SQL is mechanical once you know the data; the failures almost always trace back to skipped discovery.

Run these probes in priority order. Batch them with `run_sql({queries: [...]})`.

**1.1 Schema and types**

```sql
SELECT column_name, column_type FROM (DESCRIBE bank_statement);
```

Tells you whether `amount` is `DOUBLE` or `VARCHAR` (often the latter for CSV imports with commas/currency symbols), whether `posted_at` is `TIMESTAMP` or a string, and whether the reference column is `VARCHAR` or `BIGINT`. If a "date" column is `VARCHAR`, expect `strptime` work.

**1.2 Row counts and key uniqueness**

```sql
SELECT COUNT(*) AS rows,
       COUNT(DISTINCT txn_ref) AS distinct_refs,
       COUNT(*) FILTER (WHERE txn_ref IS NULL) AS null_refs
FROM bank_statement;
```

If `distinct_refs < rows` you have duplicate keys — match SQL must either deduplicate first or accept M:N. If `null_refs` is non-zero those rows will never match on `txn_ref`; consider a fallback key (counterparty + amount + date).

**1.3 Date range**

```sql
SELECT MIN(posted_at), MAX(posted_at) FROM bank_statement;
```

Two sources covering different periods can never reach 100%. Catching this in discovery saves you from chasing phantom exceptions.

**1.4 Sample rows**

```sql
SELECT * FROM bank_statement USING SAMPLE 10;
```

Eyeball the data. Look for:
- leading/trailing whitespace
- mixed case in reference fields
- delimiter variations (`INV-2026-001` vs `INV/2026/001`)
- amounts stored with currency prefix (`"Rp 1.234.567,00"`)
- system codes mixed into description fields

**1.5 Format variation probe**

```sql
SELECT DISTINCT LEFT(txn_ref, 5) AS prefix, COUNT(*)
FROM bank_statement
GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
```

Surfaces the *families* of references in the data. If you see `INV-`, `inv-`, `IN-`, `INVOICE` you'll need normalization in the join.

## 2. Choosing keys

A reconciliation key is anything that identifies the same economic event in both systems. There is no universal recipe — the right key depends on what the two systems agree on.

**Natural keys.** A shared business identifier — invoice number, payment reference, transaction ID. Best when both sides write the same value. Watch for delimiter and case drift.

**Surrogate keys.** Internal IDs from one system embedded in the other (e.g. a CRM account ID written into the bank memo). Usually requires `regexp_extract` to pull it out.

**Composite keys.** When no single field is unique — common in intercompany or batch settlement files. Combine `(date, counterparty, amount)` or `(period, account, gl_code)`. Build the composite expression once in a CTE and join on it.

**Derived keys.** Normalize before joining:

```sql
UPPER(REPLACE(REPLACE(TRIM(a.ref), '/', '-'), ' ', '')) = UPPER(REPLACE(REPLACE(TRIM(b.ref), '/', '-'), ' ', ''))
```

If the derived key works, freeze it in a CTE and use it everywhere downstream — readability matters when iterating.

**Test uniqueness before joining.** Always:

```sql
SELECT key_expr, COUNT(*) FROM table_a GROUP BY 1 HAVING COUNT(*) > 1 LIMIT 5;
```

If your key isn't unique on one side and you don't account for it, `run_match` will silently produce inflated matched counts.

## 3. Tolerance bands

Bank statements and GLs rarely agree to the last cent. You need tolerance bands, but they need to be defensible.

**Amount tolerance.** Default `< 0.01` (one cent). Widen only when you understand *why* the difference exists:
- FX rounding: `< 1.00` for IDR-converted USD lines
- WHT/PPh 23 (Indonesia): 2% of gross — match net to gross minus withholding
- Bank fees deducted at source: usually a flat amount or fixed percentage
- Penny rounding on aggregations: scale tolerance with the number of underlying rows

Never put amount equality directly in the join's `ON` clause. Match on keys, then compute `ABS(a.amount - b.amount)` as an output column and filter in `WHERE`. This lets you see *how close* unmatched rows are.

**Date tolerance.** `EPOCH(a.posted_at - b.posted_at)` gives seconds; `DATEDIFF('day', a.date, b.date)` gives whole days. Typical windows:
- Bank vs GL: same day, sometimes T+1
- E-commerce settlement: T+1 to T+3
- International wires: T+1 to T+5
- Cheque clearing: up to T+7

When in doubt, look at the *distribution* of date deltas for matched rows — if 80% are 0 days and 15% are 1-3 days, your tolerance is 3.

**Why precision matters.** Currency math in IDR rarely has fractional rupiah but USD/EUR/SGD lines do. A `DOUBLE` comparison is fine inside `< 0.01`, but for exact equality use `ROUND(amount, 2)`.

## 4. Many-to-one and one-to-many

The single most common cause of bad reconciliations: one bank transaction settles N invoices, or one journal entry is split across N bank lines.

**Pattern A — pre-collapse before matching.** When N invoices net to one payment:

```sql
WITH paid_invoices AS (
  SELECT payment_ref, SUM(amount) AS total, COUNT(*) AS n_invoices
  FROM invoices
  GROUP BY payment_ref
)
SELECT a.id, b.payment_ref
FROM bank_payments AS a
JOIN paid_invoices AS b ON a.ref = b.payment_ref
WHERE ABS(a.amount - b.total) < 0.01
```

Pre-collapse the *many* side, then match 1:1. The output preserves the link so you can drill into which invoices were settled.

**Pattern B — explode then match.** When one settlement line splits into multiple GL postings on the other side, you may need to expand the bank line into N synthetic rows. Rare; prefer Pattern A.

**Pattern C — accept M:N.** Sometimes the relationship is genuinely many-to-many (refund offsets, partial payments across multiple invoices). Match on a composite (payer, period) and accept that aggregate amounts must reconcile, not individual lines. Document this clearly in the summary.

## 5. Multi-leg matches

Some GL postings travel in pairs — debit a clearing account, credit cash. The bank only sees the cash leg. To reconcile, you have to chain through the clearing account.

```sql
WITH clearing_net AS (
  SELECT clearing_ref,
         SUM(CASE WHEN side = 'CR' THEN amount ELSE -amount END) AS net_amount,
         MAX(posted_at) AS posted_at
  FROM gl_postings
  WHERE account = 'CLEARING_001'
  GROUP BY clearing_ref
)
SELECT a.id, b.clearing_ref
FROM bank_statement AS a
JOIN clearing_net AS b ON UPPER(TRIM(a.ref)) = UPPER(TRIM(b.clearing_ref))
WHERE ABS(a.amount - b.net_amount) < 0.01
```

Net the legs in a CTE, then match the net against the bank. When legs don't net cleanly, there's an out-of-period entry or a missing leg — surface those as exceptions.

## 6. Intercompany

Intercompany reconciliations have two specific complications:

**Symmetry.** Entity A's receivable should equal Entity B's payable, sign-flipped. Always compare `a.amount + b.amount ≈ 0` (or `ABS(a.amount) ≈ ABS(b.amount)` if signs aren't reliable).

**FX.** When the two entities post in different currencies, you need a rate table:

```sql
SELECT a.entity_a_id, b.entity_b_id
FROM ic_a AS a
JOIN fx_rates AS fx ON a.currency = fx.from_ccy AND fx.to_ccy = 'IDR' AND fx.rate_date = a.posted_date
JOIN ic_b AS b ON a.ref = b.ref
WHERE ABS(a.amount * fx.rate + b.amount) < 1000  -- 1000 IDR tolerance on translated value
```

Ask the user whether to use posting-date rates or month-end rates — this is a policy choice, not a SQL choice.

## 7. Settlement lag

Two systems rarely timestamp the same event identically. The bank books on settlement; the ERP books on capture. Common pattern:

```sql
SELECT a.id, b.id
FROM bank_statement AS a
JOIN gl_postings AS b
  ON UPPER(TRIM(a.ref)) = UPPER(TRIM(b.ref))
WHERE b.posted_at BETWEEN a.posted_at - INTERVAL 1 DAY AND a.posted_at + INTERVAL 3 DAY
  AND ABS(a.amount - b.amount) < 0.01
```

Asymmetric window — most settlement lag is forward (GL posts before bank settles), so the window leans positive. When you see unmatched rows clustered exactly at the window edge, widen by another day and re-run.

## 8. Counterparty normalization

Vendor and customer names are the most polluted fields in any dataset. Patterns that work:

```sql
-- Strip corporate suffixes
regexp_replace(
  lower(trim(vendor)),
  '\\s+(pt|cv|ltd|llc|inc|corp|gmbh|sdn bhd|tbk)\\.?\\s*$',
  '', 'g'
)

-- Strip non-alphanumeric for fingerprint comparison
regexp_replace(lower(vendor), '[^a-z0-9]', '', 'g')

-- Fuzzy match on cleaned strings
jaro_winkler_similarity(
  regexp_replace(lower(a.vendor), '[^a-z0-9]', '', 'g'),
  regexp_replace(lower(b.vendor), '[^a-z0-9]', '', 'g')
) > 0.90
```

For Indonesian data, strip `PT`, `CV`, `Tbk`, `Persero`. Use `> 0.90` for vendor names (lots of common substrings); `> 0.85` is too loose and produces false matches.

## 9. Volume considerations

When either side has more than ~100k rows, naive joins blow up. Tactics:

**Pre-filter on date range.** Restrict both sides to overlapping periods *before* the join:

```sql
WITH a_window AS (SELECT * FROM bank_statement WHERE posted_at >= '2026-01-01' AND posted_at < '2026-02-01'),
     b_window AS (SELECT * FROM gl_postings WHERE posted_at >= '2026-01-01' AND posted_at < '2026-02-01')
SELECT a.id, b.id FROM a_window a JOIN b_window b ON ...
```

**Bucket range joins.** Hash-join only works on equality. To get a tolerance join to run fast, create a bucket column:

```sql
SELECT a.id, b.id
FROM a JOIN b
  ON a.ref = b.ref
 AND date_trunc('day', a.posted_at) = date_trunc('day', b.posted_at)
WHERE ABS(EPOCH(a.posted_at - b.posted_at)) < 86400
```

The `date_trunc` equality lets DuckDB hash-join, then the `EPOCH` filter refines within the bucket.

**Sample first.** For exploratory matches on huge tables, `USING SAMPLE 10000` on one side; once the match logic is right, run the full thing through `run_match`.

## 10. What "good" looks like

Match rate targets vary by domain. If you're below these, look for systemic issues — not just one-off exceptions:

- **Bank ↔ GL (intra-day, small business):** >98%. Anything below means a feed is broken or a manual entry process is failing.
- **Bank ↔ GL (multi-currency, multi-entity):** >95%. The 5% is usually FX timing and accrual reversals.
- **AR ↔ invoices:** >97%. Unmatched is usually credit notes or short payments.
- **AP ↔ vendor statements:** >90%. Vendor statements are noisy; expect timing and disputed-amount exceptions.
- **Marketplace ↔ settlement (Tokopedia, Shopee, etc.):** >95%. Refunds and adjustments make up the rest.
- **P2P lending (loan disbursements + repayments):** ~85%. Genuinely messy data — partial repayments, restructured loans, write-offs.
- **Intercompany:** >99% in steady state, but month-end can drop sharply during cutover.
- **Bank nightmare scenarios (legacy core banking, multiple branches):** ~75-85% on first pass is realistic.

When match rate plateaus, the question is no longer "how do I match more?" but "what is the *story* of the unmatched?" Group exceptions by type — timing, missing reference, amount delta — and present those categories to the user. They decide whether to widen tolerance, request more data, or accept the residual.

## 11. Reading tool errors

The MCP tools return `{ok: false, error: {code, message}}` on failure. Common codes:

- `INVALID_SQL` — your query didn't parse. Read the message; fix the SQL.
- `DDL_BLOCKED` / `DML_BLOCKED` — you tried `CREATE`/`UPDATE`/`DELETE`. Use `run_sql` for reads only; persistence happens in `run_match`.
- `TABLE_NOT_FOUND` — your alias doesn't match a registered source. Call `list_sources`.
- `ROW_LIMIT_EXCEEDED` — your query returned more than 20 rows. Add `LIMIT` or aggregate.
- `MATCH_SQL_MISSING_ALIAS` — your `run_match` SQL didn't alias the two sources as `a` and `b`.

If you see the same error twice on the same tool call, stop and reconsider. Don't loop.

## 12. When to ask the user

Ask before continuing if:
- The two sources cover obviously different periods
- A "key" column has >20% nulls
- Currency or sign conventions are unclear (positive = credit or debit?)
- An auxiliary table (FX rates, mapping table, whitelist) is implied but not provided
- The match rate is dramatically lower than the domain target and you've exhausted obvious normalizations

Frame the question concretely: "I found 1,247 unmatched bank rows that look like Tokopedia settlements posted with T+3 lag. Want me to widen the date window, or treat those as a separate recon?"
