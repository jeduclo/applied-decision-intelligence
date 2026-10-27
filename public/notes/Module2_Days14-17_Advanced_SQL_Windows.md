# Module 2 · Analytical SQL with DuckDB
## Days 14–17: Advanced SQL, Common Table Expressions & Window Functions

**Audience:** MSc Economics students who completed Days 1–13
**Environment:** GitHub Codespaces · DuckDB CLI · the `macro.duckdb` warehouse from Day 13
**Time per day:** ~5 hours (including breaks and exercises)
**Goal by end of Day 17:** Students write readable multi-step SQL with CTEs. They compute growth rates, rankings, moving averages, running peaks and episode analysis entirely with window functions, and they build their first analytical table, `marts.policy_cycles`, inside the warehouse.

---

### Where we are

On Day 13 you built `macro.duckdb` with:

| Table | Contents |
|---|---|
| `raw.observations` | long table from the Day 10 pipeline: `date, series_id, value, source, name, fetched_at` |
| `raw.statcan_cpi` | full StatCan CPI table: `month, geo, component, cpi` |
| `raw.dim_series` | the series catalogue |

Everything you did in pandas on Days 5–7 (`shift`, `pct_change`, `rolling`, `expanding`, `groupby`), you'll now do in SQL. Each lesson includes a **pandas ↔ SQL** comparison so the new syntax maps onto ideas you already know.

### How to work these four days

- Write queries in `.sql` files under `day14/`, `day15/`, … and run them with `.read`.
- Keep experiments out of the tidy warehouse layers by using a **`scratch`** schema.
- Open the warehouse in read-write mode only while creating views, and remember that only one process can write at a time (Day 13).

```bash
cd /workspaces/macro-data-course
source .venv/bin/activate
python run_extract.py && python load_warehouse.py     # refresh data (optional)
duckdb macro.duckdb
```

```sql
.mode box
.timer on
CREATE SCHEMA IF NOT EXISTS scratch;
```

### One-time setup: put the BoC decision log in the warehouse

Days 15–17 use the decision log from Day 11. Load it into the `raw` schema:

```sql
.read day11/decisions.sql
CREATE OR REPLACE TABLE raw.boc_decisions AS SELECT * FROM boc_decisions;
DROP TABLE boc_decisions;
SELECT COUNT(*) FROM raw.boc_decisions;        -- 25
```

(On Day 17 you'll add this step to `load_warehouse.py` permanently.)

---

# DAY 14 — Common Table Expressions: Writing SQL in Steps

| Time | Block |
|---|---|
| 0:00 – 0:40 | 14.1 Why CTEs? From nested subqueries to named steps |
| 0:40 – 1:30 | 14.2 `WITH` syntax: one CTE, many CTEs |
| 1:30 – 1:45 | Break |
| 1:45 – 2:45 | 14.3 A cleaning chain: raw → typed → monthly |
| 2:45 – 3:30 | 14.4 Long ↔ wide: conditional aggregation, `PIVOT`, `UNPIVOT` |
| 3:30 – 3:45 | Break |
| 3:45 – 4:25 | 14.5 Recursive CTEs and date spines |
| 4:25 – 5:00 | 14.6 Mini-project: the `scratch.monthly_*` views |

---

## 14.1 Why CTEs? (40 min)

Question: *"For each series, show its latest value next to its average since 2020."* With only Day 12 tools, you'd nest subqueries:

```sql
SELECT l.name, l.latest_value, a.avg_since_2020
FROM (
    SELECT name, arg_max(value, date) AS latest_value
    FROM raw.observations
    GROUP BY name
) AS l
JOIN (
    SELECT name, AVG(value) AS avg_since_2020
    FROM raw.observations
    WHERE date >= '2020-01-01'
    GROUP BY name
) AS a USING (name)
ORDER BY l.name;
```

It works, but you have to read it inside-out. A **Common Table Expression** (CTE) names each step up front:

```sql
WITH latest AS (
    SELECT name, arg_max(value, date) AS latest_value
    FROM raw.observations
    GROUP BY name
),
averages AS (
    SELECT name, AVG(value) AS avg_since_2020
    FROM raw.observations
    WHERE date >= '2020-01-01'
    GROUP BY name
)
SELECT name, latest_value, ROUND(avg_since_2020, 3) AS avg_since_2020
FROM latest
JOIN averages USING (name)
ORDER BY name;
```

Now the query reads **top to bottom**, like a Python script:

```python
latest = ...
averages = ...
result = latest.merge(averages, on="name")
```

> **CTE = a named, temporary table that exists only for the duration of one query.** It's the SQL version of assigning an intermediate DataFrame to a variable.

---

## 14.2 `WITH` Syntax (50 min)

Create `day14/cte_basics.sql`.

### Example 1 — A single CTE

```sql
WITH rates AS (
    SELECT CAST(date AS DATE) AS date, value AS overnight_rate
    FROM raw.observations
    WHERE name = 'overnight_rate'
)
SELECT MIN(date) AS first_date, MAX(date) AS last_date,
       MIN(overnight_rate) AS lowest, MAX(overnight_rate) AS highest
FROM rates;
```

> **Why `CAST(date AS DATE)`?** Dates coming from pandas are stored as timestamps (date + time). For daily and monthly economic data, a plain `DATE` is simpler to compare and join. We cast once, in the first step, and never think about it again.

### Example 2 — Chained CTEs (each step uses the previous one)

```sql
WITH rates AS (
    SELECT CAST(date AS DATE) AS date, value AS overnight_rate
    FROM raw.observations
    WHERE name = 'overnight_rate'
),
yearly AS (
    SELECT year(date) AS yr,
           AVG(overnight_rate) AS avg_rate,
           MAX(overnight_rate) AS max_rate
    FROM rates
    GROUP BY yr
),
labelled AS (
    SELECT *,
           CASE WHEN avg_rate < 2.25  THEN 'Stimulative'
                WHEN avg_rate <= 2.75 THEN 'Neutral'
                ELSE 'Restrictive' END AS stance
    FROM yearly
)
SELECT * FROM labelled ORDER BY yr;
```

The rules:
- One `WITH` keyword, then CTEs separated by **commas**.
- No comma after the last CTE.
- A CTE can reference any CTE defined **above** it.
- The final `SELECT` is the query's output.

### Example 3 — Reusing one CTE twice

```sql
WITH decisions AS (
    SELECT * FROM raw.boc_decisions
),
hikes AS (SELECT COUNT(*) AS n FROM decisions WHERE change_bp > 0),
cuts  AS (SELECT COUNT(*) AS n FROM decisions WHERE change_bp < 0)
SELECT hikes.n AS hikes, cuts.n AS cuts
FROM hikes, cuts;                        -- one row each, so this cross join is safe
```

### CTE vs view vs table

| | Lives for | Use when |
|---|---|---|
| CTE | one query | organising steps inside a query |
| View | until dropped (stores the *query*) | a reusable definition others query |
| Table | until dropped (stores the *data*) | expensive results you query often |

In dbt (Days 31–40), every model is essentially a `SELECT` with CTEs, and dbt decides whether to materialise it as a view or a table.

### Try it 14.2

Using CTEs, find for each **year** the number of days the overnight rate was above 4% and the share of that year's observations this represents (as a percentage).

<details>
<summary>Solution</summary>

```sql
WITH rates AS (
    SELECT CAST(date AS DATE) AS date, value AS rate
    FROM raw.observations
    WHERE name = 'overnight_rate'
),
by_year AS (
    SELECT year(date) AS yr,
           COUNT(*)                             AS n_obs,
           COUNT(*) FILTER (WHERE rate > 4)     AS n_above_4
    FROM rates
    GROUP BY yr
)
SELECT yr, n_above_4, ROUND(100.0 * n_above_4 / n_obs, 1) AS pct_above_4
FROM by_year
WHERE n_above_4 > 0
ORDER BY yr;
```

`100.0` (not `100`) makes the division a decimal division.

</details>

---

## 14.3 A Cleaning Chain: raw → typed → monthly (60 min)

This is the most common real-world use of CTEs: a small **pipeline inside one query**. Create `day14/monthly_chain.sql`.

### Step 1 — Typed daily/monthly observations

```sql
WITH obs AS (
    SELECT CAST(date AS DATE) AS date, name, value
    FROM raw.observations
)
SELECT name, COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last
FROM obs
GROUP BY name
ORDER BY name;
```

### Step 2 — Collapse to monthly with the right rule for each series

Day 6 taught that aggregation must make economic sense: `last` for policy rates, `mean` for prices and yields.

```sql
WITH obs AS (
    SELECT CAST(date AS DATE) AS date, name, value
    FROM raw.observations
),
monthly AS (
    SELECT name,
           CAST(date_trunc('month', date) AS DATE) AS month,
           CASE
               WHEN name IN ('overnight_rate', 'fed_funds')
                   THEN arg_max(value, date)          -- value on the last day of the month
               ELSE AVG(value)                        -- monthly average
           END AS value,
           COUNT(*) AS n_obs_in_month
    FROM obs
    GROUP BY name, month
)
SELECT * FROM monthly
WHERE name IN ('overnight_rate', 'cad_usd')
ORDER BY name, month DESC
LIMIT 10;
```

| pandas (Day 6) | SQL |
|---|---|
| `s.resample("MS").last()` | `date_trunc('month', date)` + `arg_max(value, date)` |
| `s.resample("MS").mean()` | `date_trunc('month', date)` + `AVG(value)` |

> The `CASE` sits *outside* the aggregates. That's allowed because `name` is in the `GROUP BY`, so it has a single value per group.

### Step 3 — Label with the dimension table

```sql
WITH obs AS (
    SELECT CAST(date AS DATE) AS date, series_id, name, value
    FROM raw.observations
),
monthly AS (
    SELECT series_id, name,
           CAST(date_trunc('month', date) AS DATE) AS month,
           CASE WHEN name IN ('overnight_rate', 'fed_funds')
                THEN arg_max(value, date) ELSE AVG(value) END AS value
    FROM obs
    GROUP BY ALL
),
labelled AS (
    SELECT m.month, m.name, d.source, m.value
    FROM monthly AS m
    JOIN raw.dim_series AS d USING (series_id)
)
SELECT source, name, COUNT(*) AS months, MAX(month) AS latest_month
FROM labelled
GROUP BY ALL
ORDER BY source, name;
```

> **Debugging tip:** to inspect an intermediate step, change only the final line to `SELECT * FROM monthly LIMIT 20;`. That's the SQL equivalent of printing a variable halfway through a script.

---

## 14.4 Long ↔ Wide (45 min)

Our data is **long** (one row per month and series). For comparisons across series we want **wide** (one row per month). There are three ways to get there in SQL.

### Method 1 — Conditional aggregation (portable to any database)

```sql
WITH monthly AS (
    SELECT name,
           CAST(date_trunc('month', CAST(date AS DATE)) AS DATE) AS month,
           CASE WHEN name IN ('overnight_rate', 'fed_funds')
                THEN arg_max(value, date) ELSE AVG(value) END AS value
    FROM raw.observations
    GROUP BY ALL
)
SELECT month,
       MAX(value) FILTER (WHERE name = 'overnight_rate') AS overnight_rate,
       MAX(value) FILTER (WHERE name = 'fed_funds')      AS fed_funds,
       MAX(value) FILTER (WHERE name = 'yield_2yr')      AS yield_2yr,
       MAX(value) FILTER (WHERE name = 'yield_10yr')     AS yield_10yr
FROM monthly
GROUP BY month
ORDER BY month DESC
LIMIT 6;
```

Each `FILTER` picks the single value for that series in that month. `MAX` is just a way to turn "one value" into an aggregate.

### Method 2 — DuckDB's `PIVOT` statement

```sql
CREATE OR REPLACE TEMP TABLE monthly_long AS
SELECT name,
       CAST(date_trunc('month', CAST(date AS DATE)) AS DATE) AS month,
       CASE WHEN name IN ('overnight_rate', 'fed_funds')
            THEN arg_max(value, date) ELSE AVG(value) END AS value
FROM raw.observations
GROUP BY ALL;

PIVOT monthly_long ON name USING first(value) ORDER BY month DESC LIMIT 6;
```

`PIVOT` creates one column per distinct `name` automatically. That's convenient for exploration, but new series change the output's columns, which can surprise downstream code. For pipelines, prefer Method 1's explicit columns.

A `TEMP` table disappears when you close the session, which makes it handy for experiments.

### Method 3 — `UNPIVOT`: wide back to long

```sql
CREATE OR REPLACE TEMP TABLE monthly_wide AS
PIVOT monthly_long ON name USING first(value);

UNPIVOT monthly_wide
ON COLUMNS(* EXCLUDE (month))
INTO NAME name VALUE value
ORDER BY month DESC, name
LIMIT 10;
```

`COLUMNS(* EXCLUDE (month))` means "every column except `month`", a DuckDB shortcut you'll see again on Day 17.

| pandas (Day 6) | SQL |
|---|---|
| `df.pivot(index=..., columns=..., values=...)` | conditional aggregation or `PIVOT` |
| `df.melt(id_vars=...)` | `UNPIVOT` |

---

## 14.5 Recursive CTEs and Date Spines (40 min)

### Recursive CTEs: SQL's `while` loop

A `WITH RECURSIVE` CTE starts with a base row, then repeatedly applies a step to produce new rows until a condition stops it. Remember Day 2's doubling-time loop?

```sql
WITH RECURSIVE growth(year, level) AS (
    SELECT 0, 100.0                          -- base case
    UNION ALL
    SELECT year + 1, level * 1.02            -- step
    FROM growth
    WHERE level < 200                        -- stop condition
)
SELECT MAX(year) AS years_to_double FROM growth;     -- 36, same as Day 2
```

And the Day 2 exercise of cutting from 5.00% in 25bp steps down to the neutral band:

```sql
WITH RECURSIVE path(cut, rate) AS (
    SELECT 0, 5.00
    UNION ALL
    SELECT cut + 1, rate - 0.25 FROM path WHERE rate > 2.75
)
SELECT * FROM path;
```

> Recursive CTEs are powerful but rarely needed in everyday analytics. The next tool is used far more often.

### Date spines: a complete calendar

Economic time series should have **no missing periods** (Day 5's gap check). A *date spine* is a table containing every expected period. Compare your data against it to find holes:

```sql
SELECT CAST(month AS DATE) AS month
FROM range(DATE '2024-01-01', DATE '2025-01-01', INTERVAL 1 MONTH) AS t(month);
```

`range(start, stop, step)` excludes the stop value; `generate_series` includes it.

### Finding missing months per series

```sql
WITH monthly AS (
    SELECT DISTINCT name,
           CAST(date_trunc('month', CAST(date AS DATE)) AS DATE) AS month
    FROM raw.observations
),
spine AS (
    SELECT CAST(month AS DATE) AS month
    FROM range(DATE '2018-01-01', DATE '2025-01-01', INTERVAL 1 MONTH) AS t(month)
),
expected AS (
    SELECT s.name, sp.month
    FROM (SELECT DISTINCT name FROM monthly) AS s
    CROSS JOIN spine AS sp                     -- every series × every month
)
SELECT name, COUNT(*) AS missing_months, MIN(month) AS first_missing
FROM expected
ANTI JOIN monthly USING (name, month)
GROUP BY name
ORDER BY missing_months DESC;
```

The cross join builds *what should exist*; the anti-join (Day 12) finds *what doesn't*. Quarterly series such as US GDP will show gaps here, which is expected. Checks must respect each series' frequency. Day 17 revisits this with the `frequency` column of a richer dimension table.

---

## 14.6 Mini-Project: The `scratch.monthly_*` Views (35 min)

Create `day14/monthly_views.sql` that defines two **views** you'll reuse on Days 15–17:

1. `scratch.monthly_long`: columns `month, name, value`, using the aggregation rules from 14.3, for all series in `raw.observations`.
2. `scratch.monthly_wide`: one row per month from `2006-01-01`, with explicit columns `overnight_rate, fed_funds, yield_2yr, yield_10yr, cad_usd, wti, oecd_cli, unemployment_rate`, plus derived columns `boc_fed_diff`, `spread_10_2_bp` and `usd_cad`.

Then check the latest 3 rows against your Day 7 `latest_values.csv`.

<details>
<summary>Solution</summary>

```sql
CREATE OR REPLACE VIEW scratch.monthly_long AS
WITH obs AS (
    SELECT CAST(date AS DATE) AS date, name, value
    FROM raw.observations
)
SELECT CAST(date_trunc('month', date) AS DATE) AS month,
       name,
       CASE WHEN name IN ('overnight_rate', 'fed_funds')
            THEN arg_max(value, date) ELSE AVG(value) END AS value
FROM obs
GROUP BY ALL;


CREATE OR REPLACE VIEW scratch.monthly_wide AS
WITH wide AS (
    SELECT month,
           MAX(value) FILTER (WHERE name = 'overnight_rate')    AS overnight_rate,
           MAX(value) FILTER (WHERE name = 'fed_funds')         AS fed_funds,
           MAX(value) FILTER (WHERE name = 'yield_2yr')         AS yield_2yr,
           MAX(value) FILTER (WHERE name = 'yield_10yr')        AS yield_10yr,
           MAX(value) FILTER (WHERE name = 'cad_usd')           AS cad_usd,
           MAX(value) FILTER (WHERE name = 'wti')               AS wti,
           MAX(value) FILTER (WHERE name = 'oecd_cli')          AS oecd_cli,
           MAX(value) FILTER (WHERE name = 'unemployment_rate') AS unemployment_rate
    FROM scratch.monthly_long
    WHERE month >= DATE '2006-01-01'
    GROUP BY month
)
SELECT *,
       overnight_rate - fed_funds        AS boc_fed_diff,
       (yield_10yr - yield_2yr) * 100    AS spread_10_2_bp,
       1 / cad_usd                       AS usd_cad
FROM wide;


SELECT * FROM scratch.monthly_wide ORDER BY month DESC LIMIT 3;
```

A view can reference another view, so `monthly_wide` is built **on top of** `monthly_long`. That layering is exactly how dbt projects are organised.

</details>

### Day 14 checklist
- [ ] I can rewrite nested subqueries as readable, chained CTEs
- [ ] I can debug a CTE chain by selecting from an intermediate step
- [ ] I can aggregate daily data to monthly with economically sensible rules
- [ ] I can go long → wide (conditional aggregation, `PIVOT`) and back (`UNPIVOT`)
- [ ] I can build a date spine and find missing periods with a cross join + anti-join

```bash
git add .
git commit -m "Day 14: CTEs, monthly chain, pivots, date spines"
git push
```

---

# DAY 15 — Window Functions I: Keeping Rows While Looking Around

| Time | Block |
|---|---|
| 0:00 – 0:45 | 15.1 The idea: `GROUP BY` collapses, windows don't |
| 0:45 – 1:30 | 15.2 Aggregates over a window: deviations and shares |
| 1:30 – 1:45 | Break |
| 1:45 – 2:40 | 15.3 Ranking: `ROW_NUMBER`, `RANK`, `NTILE`, `QUALIFY` |
| 2:40 – 3:40 | 15.4 `LAG` and `LEAD`: looking backward and forward |
| 3:40 – 3:55 | Break |
| 3:55 – 4:25 | 15.5 Indexing to a base period: `FIRST_VALUE` |
| 4:25 – 5:00 | 15.6 Mini-project: which CPI components run hottest? |

---

## 15.1 The Idea (45 min)

Compare two questions:

1. *"What is the average overnight rate per year?"* → one row **per year** (`GROUP BY`)
2. *"For each month, how far is the rate from that year's average?"* → one row **per month**, but each row needs a group statistic

Question 2 needs a **window function**: a calculation across a set of related rows (the *window*) that **keeps every row**.

```
GROUP BY year                          Window: AVG(...) OVER (PARTITION BY year)
┌──────┬──────────┐                    ┌─────────┬──────┬──────────┐
│ year │ avg_rate │                    │ month   │ rate │ year_avg │
├──────┼──────────┤                    ├─────────┼──────┼──────────┤
│ 2024 │   4.40   │                    │ 2024-01 │ 5.00 │   4.40   │
│ 2025 │   2.60   │                    │ 2024-02 │ 5.00 │   4.40   │
└──────┴──────────┘                    │   ...   │ ...  │   ...    │
  rows collapse                        │ 2025-01 │ 3.00 │   2.60   │
                                       └─────────┴──────┴──────────┘
                                         rows kept, statistic attached
```

### Anatomy of a window function

```sql
function(...) OVER (
    PARTITION BY ...     -- split rows into independent groups (optional)
    ORDER BY ...         -- order within each group (needed for LAG, running totals...)
    ROWS BETWEEN ...     -- which neighbouring rows to include (Day 16)
)
```

| pandas | SQL window |
|---|---|
| `df.groupby("g")["x"].transform("mean")` | `AVG(x) OVER (PARTITION BY g)` |
| `df.groupby("g")["x"].shift(1)` | `LAG(x) OVER (PARTITION BY g ORDER BY t)` |
| `df.groupby("g")["x"].pct_change(12)` | `x / LAG(x, 12) OVER (...) - 1` |
| `df.groupby("g")["x"].rank()` | `RANK() OVER (PARTITION BY g ORDER BY x)` |
| `df.groupby("g")["x"].cumsum()` | `SUM(x) OVER (PARTITION BY g ORDER BY t)` |

### Your first window

Create `day15/windows_intro.sql`:

```sql
SELECT month,
       value AS rate,
       AVG(value) OVER (PARTITION BY year(month))           AS year_avg,
       value - AVG(value) OVER (PARTITION BY year(month))   AS deviation
FROM scratch.monthly_long
WHERE name = 'overnight_rate' AND month >= DATE '2024-01-01'
ORDER BY month;
```

An empty `OVER ()` means "the whole result is one window":

```sql
SELECT month, value,
       AVG(value) OVER () AS full_sample_avg
FROM scratch.monthly_long
WHERE name = 'overnight_rate'
ORDER BY month DESC
LIMIT 5;
```

---

## 15.2 Aggregates over a Window (45 min)

### Example 1 — z-scores: how unusual is each month?

```sql
WITH spread AS (
    SELECT month, spread_10_2_bp
    FROM scratch.monthly_wide
    WHERE spread_10_2_bp IS NOT NULL
)
SELECT month,
       ROUND(spread_10_2_bp, 0) AS spread_bp,
       ROUND((spread_10_2_bp - AVG(spread_10_2_bp) OVER ())
             / STDDEV_SAMP(spread_10_2_bp) OVER (), 2) AS z_score
FROM spread
ORDER BY z_score
LIMIT 5;                                 -- the most unusually inverted months
```

### Example 2 — Shares of a total

What share of the 2022–23 tightening did each decision contribute?

```sql
SELECT decision_date,
       change_bp,
       ROUND(100.0 * change_bp / SUM(change_bp) OVER (), 1) AS pct_of_total
FROM raw.boc_decisions
WHERE change_bp > 0
ORDER BY decision_date;
```

### Example 3 — Several partitions in one query

```sql
SELECT decision_date,
       change_bp,
       SUM(change_bp) OVER (PARTITION BY year(decision_date))  AS year_total_bp,
       COUNT(*)       OVER (PARTITION BY year(decision_date))  AS decisions_that_year,
       SUM(change_bp) OVER ()                                  AS all_time_net_bp
FROM raw.boc_decisions
ORDER BY decision_date;
```

### Try it 15.2

For national CPI All-items (`raw.statcan_cpi`, `geo = 'Canada'`), show for each month of 2024 the CPI level and its percentage deviation from that year's average level.

<details>
<summary>Solution</summary>

```sql
SELECT month, cpi,
       ROUND(100 * (cpi / AVG(cpi) OVER (PARTITION BY year(month)) - 1), 2) AS pct_vs_year_avg
FROM raw.statcan_cpi
WHERE geo = 'Canada' AND component = 'All-items'
  AND month BETWEEN DATE '2024-01-01' AND DATE '2024-12-01'
ORDER BY month;
```

Because this table is not seasonally adjusted, the pattern within the year partly reflects seasonality.

</details>

---

## 15.3 Ranking (55 min)

Create `day15/ranking.sql`.

### The ranking functions

| Function | Ties | Example with values 5, 5, 4 |
|---|---|---|
| `ROW_NUMBER()` | arbitrary, always unique | 1, 2, 3 |
| `RANK()` | same rank, then a gap | 1, 1, 3 |
| `DENSE_RANK()` | same rank, no gap | 1, 1, 2 |
| `NTILE(n)` | splits rows into *n* equal buckets | quartiles, deciles |

### Example 1 — The biggest BoC moves

```sql
SELECT decision_date, change_bp,
       ROW_NUMBER() OVER (ORDER BY ABS(change_bp) DESC) AS row_num,
       RANK()       OVER (ORDER BY ABS(change_bp) DESC) AS rnk,
       DENSE_RANK() OVER (ORDER BY ABS(change_bp) DESC) AS dense_rnk
FROM raw.boc_decisions
WHERE change_bp <> 0
ORDER BY rnk;
```

Look at how the three columns treat the many 50bp moves differently.

### Example 2 — The latest observation per series

A classic pattern: rank within each group, then keep rank 1.

```sql
WITH ranked AS (
    SELECT name, month, value,
           ROW_NUMBER() OVER (PARTITION BY name ORDER BY month DESC) AS rn
    FROM scratch.monthly_long
)
SELECT name, month, ROUND(value, 3) AS latest
FROM ranked
WHERE rn = 1
ORDER BY name;
```

### Example 3 — The same thing with `QUALIFY`

You can't filter on a window function in `WHERE`, because windows are computed *after* `WHERE` (remember the evaluation order from Day 12). Standard SQL therefore needs the CTE above. DuckDB offers `QUALIFY`, a `WHERE` for window results:

```sql
SELECT name, month, ROUND(value, 3) AS latest
FROM scratch.monthly_long
QUALIFY ROW_NUMBER() OVER (PARTITION BY name ORDER BY month DESC) = 1
ORDER BY name;
```

Updated evaluation order: `FROM → WHERE → GROUP BY → HAVING → window functions → QUALIFY → SELECT → ORDER BY → LIMIT`.

### Example 4 — Top-N per group

The three highest monthly WTI prices in each year since 2020:

```sql
SELECT year(month) AS yr, month, ROUND(value, 2) AS wti
FROM scratch.monthly_long
WHERE name = 'wti' AND month >= DATE '2020-01-01'
QUALIFY RANK() OVER (PARTITION BY year(month) ORDER BY value DESC) <= 3
ORDER BY yr, wti DESC;
```

### Example 5 — Quartiles of the policy-rate history

```sql
WITH q AS (
    SELECT month, value,
           NTILE(4) OVER (ORDER BY value) AS quartile
    FROM scratch.monthly_long
    WHERE name = 'overnight_rate'
)
SELECT quartile, MIN(value) AS from_rate, MAX(value) AS to_rate, COUNT(*) AS months
FROM q
GROUP BY quartile
ORDER BY quartile;
```

---

## 15.4 `LAG` and `LEAD` (60 min)

`LAG(x, n)` gets the value *n* rows **before** the current row; `LEAD(x, n)` gets the value *n* rows **after**. They're SQL's `shift(n)` and `shift(-n)`. Create `day15/lag_lead.sql`.

### Example 1 — Verifying the decision log

The `change_bp` column was typed in by hand. Does it agree with the rates?

```sql
SELECT decision_date,
       rate,
       LAG(rate) OVER (ORDER BY decision_date)                       AS previous_rate,
       change_bp                                                     AS recorded_bp,
       ROUND((rate - LAG(rate) OVER (ORDER BY decision_date)) * 100) AS computed_bp
FROM raw.boc_decisions
ORDER BY decision_date;
```

Now list only the disagreements. This is a real data-quality check:

```sql
WITH checked AS (
    SELECT decision_date, change_bp,
           ROUND((rate - LAG(rate) OVER (ORDER BY decision_date)) * 100) AS computed_bp
    FROM raw.boc_decisions
)
SELECT * FROM checked
WHERE computed_bp IS NOT NULL AND computed_bp <> change_bp;
```

The first row has no previous rate, so `LAG` returns `NULL`. `LAG(rate, 1, 0.25)` would supply a default instead (0.25% was the rate before March 2022).

### Example 2 — `LEAD`: time until the next decision

```sql
SELECT decision_date,
       LEAD(decision_date) OVER (ORDER BY decision_date)                 AS next_decision,
       LEAD(decision_date) OVER (ORDER BY decision_date) - decision_date AS days_to_next
FROM raw.boc_decisions
ORDER BY decision_date;
```

### Example 3 — Year-over-year inflation with `LAG(…, 12)`

```sql
SELECT month, cpi,
       ROUND(100 * (cpi / LAG(cpi, 12) OVER (ORDER BY month) - 1), 1) AS yoy
FROM raw.statcan_cpi
WHERE geo = 'Canada' AND component = 'All-items'
ORDER BY month DESC
LIMIT 13;
```

Compare with the latest value from your Day 5 fact sheet. It should match exactly.

### Example 4 — Many series at once with `PARTITION BY`

```sql
SELECT geo, month, cpi,
       ROUND(100 * (cpi / LAG(cpi, 12) OVER (PARTITION BY geo ORDER BY month) - 1), 1) AS yoy
FROM raw.statcan_cpi
WHERE component = 'All-items'
  AND geo IN ('Canada', 'Ontario', 'Quebec', 'Alberta')
QUALIFY month = MAX(month) OVER ()
ORDER BY yoy DESC;
```

Without `PARTITION BY geo`, `LAG` would compare Ontario with Quebec at the boundaries, the same bug that Day 6's `groupby("component")` avoided.

### Example 5 — A gap-safe YoY with a self-join

`LAG(cpi, 12)` means "12 **rows** back", not "12 **months** back". If a month is missing, every later value is wrong (Day 5). A self-join on the calendar is immune to gaps:

```sql
WITH cpi AS (
    SELECT month, cpi
    FROM raw.statcan_cpi
    WHERE geo = 'Canada' AND component = 'All-items'
)
SELECT cur.month, cur.cpi, prev.cpi AS cpi_year_ago,
       ROUND(100 * (cur.cpi / prev.cpi - 1), 1) AS yoy
FROM cpi AS cur
LEFT JOIN cpi AS prev
       ON prev.month = CAST(cur.month - INTERVAL 12 MONTH AS DATE)
ORDER BY cur.month DESC
LIMIT 5;
```

> **Which to use?** `LAG` is shorter and faster; the self-join is safer. If you have **proved** there are no gaps (Day 14's date spine), `LAG` is fine. Days 18–20 build this choice into the staging layer.

### Try it 15.4

For the monthly USD/CAD rate (`scratch.monthly_wide`), compute the month-over-month percentage change and list the five largest CAD depreciations (USD/CAD rising most).

<details>
<summary>Solution</summary>

```sql
SELECT month,
       ROUND(usd_cad, 4) AS usd_cad,
       ROUND(100 * (usd_cad / LAG(usd_cad) OVER (ORDER BY month) - 1), 2) AS mom_pct
FROM scratch.monthly_wide
WHERE usd_cad IS NOT NULL
QUALIFY mom_pct IS NOT NULL
ORDER BY mom_pct DESC
LIMIT 5;
```

</details>

---

## 15.5 Indexing to a Base Period: `FIRST_VALUE` (30 min)

The notebook's Module 05 "indicator race" rebases series to **January 2020 = 100** (`index_to_100`). In SQL:

```sql
WITH hs AS (
    SELECT month, component, cpi
    FROM raw.statcan_cpi
    WHERE geo = 'Canada'
      AND component IN ('All-items', 'Shelter', 'Food', 'Energy')
      AND month >= DATE '2020-01-01'           -- WHERE runs before the window!
)
SELECT month, component,
       ROUND(100 * cpi / FIRST_VALUE(cpi) OVER (PARTITION BY component ORDER BY month), 1)
           AS index_jan2020
FROM hs
QUALIFY month = MAX(month) OVER ()
ORDER BY index_jan2020 DESC;
```

Because `WHERE` is evaluated **before** window functions, `FIRST_VALUE` sees January 2020 as the first row. Move the date filter into `QUALIFY` instead and the base period changes to the start of the whole series. Try it to see the evaluation order in action.

> `LAST_VALUE` looks like the mirror image of `FIRST_VALUE` but has a trap involving *window frames*. It's the first topic on Day 16.

---

## 15.6 Mini-Project: Which CPI Components Run Hottest? (35 min)

Using `raw.statcan_cpi` for `geo = 'Canada'` and the eight major components used in the notebook's Module 05 (`Food`, `Shelter`, `Household operations, furnishings and equipment`, `Clothing and footwear`, `Transportation`, `Health and personal care`, `Recreation, education and reading`, `Alcoholic beverages, tobacco products and recreational cannabis`), plus `All-items`:

1. Compute YoY inflation per component (partitioned `LAG`).
2. For each month since 2021, rank the eight components from hottest (1) to coolest.
3. Count how many months each component ranked **#1** since 2021.
4. Show the latest month's ranking, with each component's YoY and its gap to All-items.

(Check the exact component names first with `SELECT DISTINCT component FROM raw.statcan_cpi ORDER BY 1;`, as StatCan labels are long and must match exactly.)

<details>
<summary>Solution</summary>

```sql
WITH base AS (
    SELECT month, component, cpi
    FROM raw.statcan_cpi
    WHERE geo = 'Canada'
      AND component IN ('All-items', 'Food', 'Shelter',
                        'Household operations, furnishings and equipment',
                        'Clothing and footwear', 'Transportation',
                        'Health and personal care',
                        'Recreation, education and reading',
                        'Alcoholic beverages, tobacco products and recreational cannabis')
),
yoy AS (
    SELECT month, component,
           100 * (cpi / LAG(cpi, 12) OVER (PARTITION BY component ORDER BY month) - 1) AS yoy
    FROM base
),
ranked AS (
    SELECT y.month, y.component, y.yoy,
           y.yoy - h.yoy AS gap_to_headline,
           RANK() OVER (PARTITION BY y.month ORDER BY y.yoy DESC) AS heat_rank
    FROM yoy AS y
    JOIN yoy AS h ON h.month = y.month AND h.component = 'All-items'
    WHERE y.component <> 'All-items'
      AND y.month >= DATE '2021-01-01'
      AND y.yoy IS NOT NULL
)
-- 3. Months at #1
SELECT component, COUNT(*) AS months_hottest
FROM ranked
WHERE heat_rank = 1
GROUP BY component
ORDER BY months_hottest DESC;

-- 4. Latest ranking: replace the final SELECT above with
-- SELECT component, ROUND(yoy, 1) AS yoy, ROUND(gap_to_headline, 1) AS gap, heat_rank
-- FROM ranked
-- QUALIFY month = MAX(month) OVER ()
-- ORDER BY heat_rank;
```

The self-join `yoy AS h` attaches the headline rate to every component row: a join between two copies of the same CTE.

</details>

### Day 15 checklist
- [ ] I can explain the difference between `GROUP BY` and a window function
- [ ] I can compute group statistics without collapsing rows (`AVG … OVER (PARTITION BY …)`)
- [ ] I can rank with `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `NTILE`, and filter with `QUALIFY`
- [ ] I can compute changes and growth rates with `LAG`/`LEAD`, correctly partitioned
- [ ] I know when a gap-safe self-join beats `LAG`
- [ ] I can rebase series to an index with `FIRST_VALUE`

```bash
git add .
git commit -m "Day 15: window functions — ranking, LAG/LEAD, indexing"
git push
```

---

# DAY 16 — Window Functions II: Frames, Moving Averages and Episodes

| Time | Block |
|---|---|
| 0:00 – 0:50 | 16.1 Window frames: choosing the neighbours |
| 0:50 – 1:40 | 16.2 Moving averages, momentum and rolling volatility |
| 1:40 – 1:55 | Break |
| 1:55 – 2:40 | 16.3 Running totals, running peaks and drawdowns |
| 2:40 – 3:20 | 16.4 Date-based frames with `RANGE` · 16.5 Named windows |
| 3:20 – 3:35 | Break |
| 3:35 – 4:20 | 16.6 Episodes: the gaps-and-islands technique |
| 4:20 – 5:00 | 16.7 Mini-project: yield-curve inversion episodes |

---

## 16.1 Window Frames (50 min)

With `ORDER BY` inside `OVER`, you can also say **which rows around the current one** the function should see. That set of rows is the **frame**.

```
                        month   value
                        ─────   ─────
2 PRECEDING  ────────►  Mar     2.9    ┐
1 PRECEDING  ────────►  Apr     2.6    │  ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
CURRENT ROW  ────────►  May     2.4    ┘  → a 3-month window
1 FOLLOWING             Jun     2.1
```

### Frame vocabulary

| Clause | Meaning |
|---|---|
| `ROWS BETWEEN 2 PRECEDING AND CURRENT ROW` | this row and the 2 before it |
| `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` | from the first row to here (running) |
| `ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING` | a centred 3-row window |
| `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING` | the whole partition |

### The default frame, and the `LAST_VALUE` trap

When you write `ORDER BY` inside `OVER` without a frame, the default is *"from the start up to the current row"*. That's why running totals work without extra syntax, but it breaks `LAST_VALUE`:

```sql
SELECT month, value,
       LAST_VALUE(value) OVER (ORDER BY month) AS last_default,          -- surprise!
       LAST_VALUE(value) OVER (ORDER BY month
           ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS last_true
FROM scratch.monthly_long
WHERE name = 'overnight_rate' AND month >= DATE '2025-01-01'
ORDER BY month;
```

With the default frame, the "last" row of each window is the current row, so `last_default` just repeats `value`. Spell out the frame whenever it matters.

---

## 16.2 Moving Averages, Momentum and Rolling Volatility (50 min)

Create `day16/rolling.sql`. We start from a CPI YoY CTE that we'll reuse all day:

```sql
WITH cpi AS (
    SELECT month, cpi,
           100 * (cpi / LAG(cpi, 12) OVER (ORDER BY month) - 1) AS yoy
    FROM raw.statcan_cpi
    WHERE geo = 'Canada' AND component = 'All-items'
)
SELECT month,
       ROUND(yoy, 2) AS yoy,
       ROUND(AVG(yoy) OVER (ORDER BY month
             ROWS BETWEEN 2 PRECEDING AND CURRENT ROW), 2)  AS yoy_ma3,
       ROUND(AVG(yoy) OVER (ORDER BY month
             ROWS BETWEEN 11 PRECEDING AND CURRENT ROW), 2) AS yoy_ma12
FROM cpi
WHERE yoy IS NOT NULL
ORDER BY month DESC
LIMIT 12;
```

pandas equivalent: `yoy.rolling(3).mean()` and `yoy.rolling(12).mean()`.

### `min_periods`: don't average too few observations

pandas' `rolling(12)` returns `NaN` until 12 values exist. SQL averages whatever is in the frame, so the first rows are averages of 1, 2, 3… values. Reproduce pandas' behaviour by counting:

```sql
WITH cpi AS (
    SELECT month,
           100 * (cpi / LAG(cpi, 12) OVER (ORDER BY month) - 1) AS yoy
    FROM raw.statcan_cpi
    WHERE geo = 'Canada' AND component = 'All-items'
      AND month >= DATE '2019-01-01'
)
SELECT month, ROUND(yoy, 2) AS yoy,
       CASE WHEN COUNT(yoy) OVER w12 = 12
            THEN ROUND(AVG(yoy) OVER w12, 2) END AS yoy_ma12
FROM cpi
WINDOW w12 AS (ORDER BY month ROWS BETWEEN 11 PRECEDING AND CURRENT ROW)
ORDER BY month
LIMIT 26;
```

(`WINDOW w12 AS (...)` names a window so you don't have to repeat it. More in 16.5.)

A `CASE` with no `ELSE` returns `NULL`. The notebook's housing-starts chart used `min_periods=1`, the opposite choice. Which is right depends on whether a partial average is meaningful for your chart.

### 3-month annualised inflation (momentum)

```sql
SELECT month, cpi,
       ROUND(100 * (POWER(cpi / LAG(cpi, 3) OVER (ORDER BY month), 4) - 1), 1) AS ann_3m
FROM raw.statcan_cpi
WHERE geo = 'Canada' AND component = 'All-items'
ORDER BY month DESC
LIMIT 6;
```

> As on Day 5: this table is **not seasonally adjusted**, so short-horizon annualised rates carry seasonal noise.

### Rolling volatility of the yield-curve spread

```sql
SELECT month,
       ROUND(spread_10_2_bp) AS spread_bp,
       ROUND(STDDEV_SAMP(spread_10_2_bp) OVER (ORDER BY month
             ROWS BETWEEN 35 PRECEDING AND CURRENT ROW), 1) AS vol_36m
FROM scratch.monthly_wide
WHERE spread_10_2_bp IS NOT NULL
ORDER BY month DESC
LIMIT 6;
```

---

## 16.3 Running Totals, Running Peaks and Drawdowns (45 min)

### Example 1 — Cumulative policy moves

```sql
SELECT decision_date, change_bp,
       SUM(change_bp) OVER (ORDER BY decision_date) AS cumulative_bp
FROM raw.boc_decisions
ORDER BY decision_date;
```

pandas: `.cumsum()`. The default frame (start → current row) makes this a running sum automatically.

### Example 2 — Resetting the running total each year

```sql
SELECT decision_date, change_bp,
       SUM(change_bp) OVER (PARTITION BY year(decision_date)
                            ORDER BY decision_date) AS ytd_bp
FROM raw.boc_decisions
ORDER BY decision_date;
```

### Example 3 — The running peak

Day 2's accumulator loop and Day 5's `expanding().max()`:

```sql
SELECT month,
       value AS rate,
       MAX(value) OVER (ORDER BY month
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS peak_so_far
FROM scratch.monthly_long
WHERE name = 'overnight_rate' AND month >= DATE '2022-01-01'
ORDER BY month;
```

### Example 4 — Drawdown: distance from the recent high

How far has the Canadian dollar fallen from its best level of the previous 12 months?

```sql
SELECT month,
       ROUND(cad_usd, 4) AS cad_usd,
       ROUND(MAX(cad_usd) OVER w, 4)                          AS high_12m,
       ROUND(100 * (cad_usd / MAX(cad_usd) OVER w - 1), 2)    AS drawdown_pct
FROM scratch.monthly_wide
WHERE cad_usd IS NOT NULL
WINDOW w AS (ORDER BY month ROWS BETWEEN 11 PRECEDING AND CURRENT ROW)
ORDER BY drawdown_pct
LIMIT 5;                                       -- the deepest drawdowns
```

### Try it 16.3

For the overnight rate since 2022, compute the running peak and the **number of basis points below the peak** each month. Which month first showed the rate 100bp below its peak?

<details>
<summary>Solution</summary>

```sql
WITH r AS (
    SELECT month, value AS rate,
           MAX(value) OVER (ORDER BY month
                            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS peak
    FROM scratch.monthly_long
    WHERE name = 'overnight_rate' AND month >= DATE '2022-01-01'
)
SELECT month, rate, peak, (peak - rate) * 100 AS bp_below_peak
FROM r
WHERE (peak - rate) * 100 >= 100
ORDER BY month
LIMIT 1;
```

</details>

---

## 16.4 Date-Based Frames with `RANGE` (25 min)

`ROWS` counts **rows**. If a month is missing, "11 preceding rows" silently covers 13 months. `RANGE` with an interval counts in **time** instead, so it's robust to gaps (the frame-level version of Day 15's self-join):

```sql
SELECT month,
       ROUND(value, 2) AS wti,
       ROUND(AVG(value) OVER (ORDER BY month
             RANGE BETWEEN INTERVAL 11 MONTH PRECEDING AND CURRENT ROW), 2) AS wti_avg_12m,
       COUNT(*) OVER (ORDER BY month
             RANGE BETWEEN INTERVAL 11 MONTH PRECEDING AND CURRENT ROW)    AS months_in_window
FROM scratch.monthly_long
WHERE name = 'wti'
ORDER BY month DESC
LIMIT 6;
```

Now delete a month to see the difference:

```sql
WITH gappy AS (
    SELECT month, value FROM scratch.monthly_long
    WHERE name = 'wti' AND month <> DATE '2025-06-01'      -- simulate a missing month
)
SELECT month,
       COUNT(*) OVER (ORDER BY month ROWS  BETWEEN 11 PRECEDING AND CURRENT ROW) AS rows_frame,
       COUNT(*) OVER (ORDER BY month RANGE BETWEEN INTERVAL 11 MONTH PRECEDING
                                           AND CURRENT ROW)                     AS range_frame
FROM gappy
WHERE month BETWEEN DATE '2025-05-01' AND DATE '2026-06-01'
ORDER BY month;
```

After the gap, the `ROWS` frame reaches back further in time; the `RANGE` frame covers exactly 12 calendar months and simply contains 11 observations.

---

## 16.5 Named Windows (15 min)

When several functions share a window definition, name it once with `WINDOW`:

```sql
SELECT month,
       ROUND(value, 2)             AS rate,
       ROUND(AVG(value) OVER w, 2) AS avg_12m,
       MIN(value) OVER w           AS min_12m,
       MAX(value) OVER w           AS max_12m
FROM scratch.monthly_long
WHERE name = 'fed_funds'
WINDOW w AS (ORDER BY month ROWS BETWEEN 11 PRECEDING AND CURRENT ROW)
ORDER BY month DESC
LIMIT 6;
```

This is the SQL equivalent of assigning a repeated expression to a variable: less typing, fewer inconsistencies.

---

## 16.6 Episodes: The Gaps-and-Islands Technique (45 min)

Economists constantly ask about **episodes**: *How long did inflation stay above 3%? When did each yield-curve inversion start and end?* These are consecutive runs ("islands") of rows sharing a condition. The technique takes three steps.

**Step 1 — Flag** each row with the condition.
**Step 2 — Mark changes:** 1 when the flag differs from the previous row's flag, else 0.
**Step 3 — Number the episodes** with a running sum of the change markers.

```
month    yoy   above_3  changed  episode_id (running sum)
2021-03  2.2   false    1        1
2021-04  3.4   true     1        2   ┐
2021-05  3.6   true     0        2   │ episode 2: above 3%
2021-06  3.1   true     0        2   ┘
2021-07  2.9   false    1        3
```

Create `day16/episodes.sql`:

```sql
WITH cpi AS (
    SELECT month,
           100 * (cpi / LAG(cpi, 12) OVER (ORDER BY month) - 1) AS yoy
    FROM raw.statcan_cpi
    WHERE geo = 'Canada' AND component = 'All-items'
      AND month >= DATE '1995-01-01'
),
flagged AS (                                                   -- step 1
    SELECT month, yoy, yoy > 3 AS above_3
    FROM cpi
    WHERE yoy IS NOT NULL
),
changes AS (                                                   -- step 2
    SELECT *,
           CASE WHEN above_3 = LAG(above_3) OVER (ORDER BY month) THEN 0 ELSE 1 END AS changed
    FROM flagged
),
episodes AS (                                                  -- step 3
    SELECT *, SUM(changed) OVER (ORDER BY month) AS episode_id
    FROM changes
)
SELECT episode_id,
       MIN(month)        AS start_month,
       MAX(month)        AS end_month,
       COUNT(*)          AS months,
       ROUND(MAX(yoy),1) AS peak_yoy
FROM episodes
WHERE above_3
GROUP BY episode_id
ORDER BY months DESC
LIMIT 5;
```

For the first row, `LAG` returns `NULL`, the comparison is not true, and the `CASE` returns 1, which correctly starts the first episode.

> This pattern works for any condition: recessions (negative growth), restrictive policy (real rate > 0), CAD below parity thresholds... Keep this query as a template.

---

## 16.7 Mini-Project: Yield-Curve Inversion Episodes (40 min)

An inverted curve (10-year yield below 2-year) is a well-known recession signal, and the notebook plots the spread in Module 02. Using `scratch.monthly_wide`:

1. Identify every episode in which `spread_10_2_bp < 0`.
2. For each episode report start month, end month, length in months, the most negative spread and the month it occurred.
3. Add the change in the overnight rate over the episode (rate at end minus rate at start).
4. Bonus: add the maximum unemployment rate in the 24 months **after** each episode ended. (Hint: a correlated subquery or a join on a date range.)

<details>
<summary>Solution</summary>

```sql
WITH base AS (
    SELECT month, spread_10_2_bp, overnight_rate, unemployment_rate,
           spread_10_2_bp < 0 AS inverted
    FROM scratch.monthly_wide
    WHERE spread_10_2_bp IS NOT NULL
),
changes AS (
    SELECT *,
           CASE WHEN inverted = LAG(inverted) OVER (ORDER BY month) THEN 0 ELSE 1 END AS changed
    FROM base
),
numbered AS (
    SELECT *, SUM(changed) OVER (ORDER BY month) AS episode_id
    FROM changes
),
episodes AS (
    SELECT episode_id,
           MIN(month)                                AS start_month,
           MAX(month)                                AS end_month,
           COUNT(*)                                  AS months,
           ROUND(MIN(spread_10_2_bp))                AS deepest_bp,
           arg_min(month, spread_10_2_bp)            AS deepest_month,
           arg_max(overnight_rate, month)
             - arg_min(overnight_rate, month)        AS rate_change_pp
    FROM numbered
    WHERE inverted
    GROUP BY episode_id
)
SELECT e.*,
       (SELECT MAX(unemployment_rate)
        FROM scratch.monthly_wide AS w
        WHERE w.month >  e.end_month
          AND w.month <= e.end_month + INTERVAL 24 MONTH) AS max_unemp_next_24m
FROM episodes AS e
ORDER BY start_month;
```

`arg_min(month, spread_10_2_bp)` returns the *month* at which the spread was lowest. The subquery in the final `SELECT` is **correlated**: it runs once per episode, using that episode's `end_month`.

Discuss: very short "episodes" of one or two months are often noise. How would you require at least 3 consecutive months? (Hint: filter the `episodes` CTE with `WHERE months >= 3`.)

</details>

### Day 16 checklist
- [ ] I can define window frames with `ROWS BETWEEN …` and avoid the `LAST_VALUE` trap
- [ ] I can compute moving averages (with a `min_periods` equivalent), momentum and rolling volatility
- [ ] I can compute running totals, running peaks and drawdowns
- [ ] I know when `RANGE` with an interval is safer than `ROWS`
- [ ] I can identify episodes with the gaps-and-islands technique

```bash
git add .
git commit -m "Day 16: frames, rolling stats, episodes"
git push
```

---

# DAY 17 — Advanced DuckDB Features and a First Analytical Mart

| Time | Block |
|---|---|
| 0:00 – 0:50 | 17.1 `ASOF` joins: matching the latest available value |
| 0:50 – 1:30 | 17.2 SQL macros: reusable functions |
| 1:30 – 1:45 | Break |
| 1:45 – 2:25 | 17.3 "Friendly SQL": `EXCLUDE`, `REPLACE`, `COLUMNS`, FROM-first |
| 2:25 – 3:05 | 17.4 Performance: `EXPLAIN ANALYZE` and good habits · 17.5 SQL style |
| 3:05 – 3:20 | Break |
| 3:20 – 4:40 | 17.6 Capstone: `marts.policy_cycles` |
| 4:40 – 5:00 | 17.7 Wiring it into the warehouse build · recap |

---

## 17.1 `ASOF` Joins (50 min)

Economic data rarely lines up perfectly. A policy decision on 2024-06-05 needs *the most recent* 2-year yield **on or before** that date. There may be no yield observation on the exact day (weekends, holidays). An **ASOF join** matches each row to the latest row that doesn't come after it.

```
decisions                    yields (daily)                    ASOF result
2024-06-05  ───────────────► 2024-06-04  3.92  (latest ≤ date) 2024-06-05 → 3.92
2024-07-24  ───────────────► 2024-07-24  3.60                  2024-07-24 → 3.60
```

Create `day17/asof.sql`:

### Example 1 — Market yields at each decision

```sql
WITH yields AS (
    SELECT CAST(date AS DATE) AS date, value AS yield_2yr
    FROM raw.observations
    WHERE name = 'yield_2yr'
)
SELECT d.decision_date, d.rate, d.change_bp,
       y.date AS yield_obs_date, y.yield_2yr
FROM raw.boc_decisions AS d
ASOF JOIN yields AS y
     ON d.decision_date >= y.date
ORDER BY d.decision_date;
```

The inequality in `ON` says "the yield date must not be after the decision date"; `ASOF` then picks the **closest** such row.

### Example 2 — How did markets move around decisions?

Compare the 2-year yield the day before a decision with the yield a week later:

```sql
WITH yields AS (
    SELECT CAST(date AS DATE) AS date, value AS y2
    FROM raw.observations
    WHERE name = 'yield_2yr'
),
before AS (
    SELECT d.decision_date, d.change_bp, y.y2 AS y2_before
    FROM raw.boc_decisions AS d
    ASOF JOIN yields AS y ON d.decision_date - INTERVAL 1 DAY >= y.date
),
after AS (
    SELECT d.decision_date, y.y2 AS y2_after
    FROM raw.boc_decisions AS d
    ASOF JOIN yields AS y ON d.decision_date + INTERVAL 7 DAY >= y.date
)
SELECT decision_date, change_bp,
       ROUND(y2_before, 2) AS y2_before,
       ROUND(y2_after, 2)  AS y2_week_after,
       ROUND((y2_after - y2_before) * 100) AS move_bp
FROM before JOIN after USING (decision_date)
ORDER BY decision_date;
```

> **Economist's caution:** a one-week window mixes the decision with other news. This is an *event-study* flavour, not causal identification. Causal methods come in Module 8 (Days 71–80).

### Example 3 — The CPI reading known at each decision (with a publication lag)

CPI for month *m* is published during month *m+1*. A rough "what was known" rule is to use the CPI of two months before the decision month:

```sql
WITH cpi AS (
    SELECT month,
           100 * (cpi / LAG(cpi, 12) OVER (ORDER BY month) - 1) AS yoy
    FROM raw.statcan_cpi
    WHERE geo = 'Canada' AND component = 'All-items'
)
SELECT d.decision_date, d.rate,
       c.month AS cpi_month_used,
       ROUND(c.yoy, 1) AS cpi_yoy,
       ROUND(d.rate - c.yoy, 2) AS real_rate_at_decision
FROM raw.boc_decisions AS d
ASOF JOIN cpi AS c
     ON CAST(date_trunc('month', d.decision_date) - INTERVAL 2 MONTH AS DATE) >= c.month
ORDER BY d.decision_date;
```

Thinking about *what was known when* (data **vintages** and publication lags) is essential for honest forecasting on Days 61–70.

---

## 17.2 SQL Macros: Reusable Functions (40 min)

You've typed `100 * (x / LAG(x, 12) OVER (...) - 1)` many times. DuckDB **macros** are SQL's version of Day 3 functions.

### Scalar macros

```sql
CREATE OR REPLACE MACRO pct_change(new_value, old_value) AS
    100 * (new_value / old_value - 1);

CREATE OR REPLACE MACRO annualise(ratio, periods) AS
    100 * (POWER(ratio, periods) - 1);

CREATE OR REPLACE MACRO stance(rate) AS
    CASE WHEN rate < 2.25 THEN 'Stimulative'
         WHEN rate <= 2.75 THEN 'Neutral'
         ELSE 'Restrictive' END;

SELECT pct_change(169.0, 164.1)      AS yoy,
       annualise(1.008, 4)           AS ann_growth,
       stance(2.25)                  AS current_stance;
```

Macros can take a window expression as an argument:

```sql
SELECT month, cpi,
       ROUND(pct_change(cpi, LAG(cpi, 12) OVER (ORDER BY month)), 1) AS yoy
FROM raw.statcan_cpi
WHERE geo = 'Canada' AND component = 'All-items'
ORDER BY month DESC
LIMIT 3;
```

### Table macros: parameterised queries

```sql
CREATE OR REPLACE MACRO series(series_name) AS TABLE
    SELECT month, value
    FROM scratch.monthly_long
    WHERE name = series_name;

SELECT * FROM series('fed_funds') ORDER BY month DESC LIMIT 3;
SELECT * FROM series('wti')       ORDER BY month DESC LIMIT 3;
```

> Macros created in a database file are saved with it. dbt has its own, more powerful macro system (Jinja, Days 34–37), but the idea of *write once, reuse everywhere* is the same.

---

## 17.3 "Friendly SQL" in DuckDB (40 min)

DuckDB adds conveniences to standard SQL. They save a lot of typing, but they may not exist in other databases, so know which parts of your SQL are portable.

```sql
-- FROM-first: quick look at a table
FROM raw.observations LIMIT 3;

-- EXCLUDE: all columns except some
SELECT * EXCLUDE (fetched_at, source) FROM raw.observations LIMIT 3;

-- REPLACE: modify a column in place
SELECT * REPLACE (ROUND(value, 2) AS value) FROM scratch.monthly_long LIMIT 3;

-- COLUMNS: apply an expression to every matching column (regex)
SELECT month, ROUND(COLUMNS('yield_.*|overnight_rate|fed_funds'), 2)
FROM scratch.monthly_wide
ORDER BY month DESC
LIMIT 3;

-- GROUP BY ALL / ORDER BY ALL
SELECT name, year(month) AS yr, AVG(value)
FROM scratch.monthly_long
GROUP BY ALL
ORDER BY ALL
LIMIT 5;

-- Column aliases reused in the same SELECT
SELECT overnight_rate - fed_funds AS diff,
       diff * 100                  AS diff_bp
FROM scratch.monthly_wide
ORDER BY month DESC
LIMIT 3;
```

| Feature | Portable? |
|---|---|
| CTEs, window functions, `CASE`, joins | ✓ standard SQL |
| `FILTER (WHERE …)` | ✓ in most modern databases |
| `QUALIFY` | some (Snowflake, BigQuery, DuckDB) |
| `EXCLUDE`, `REPLACE`, `COLUMNS`, `GROUP BY ALL`, `ASOF JOIN`, `arg_max` | mostly DuckDB-specific |

---

## 17.4 Performance Habits (25 min)

DuckDB is fast, but some habits matter as data grows.

### See what DuckDB actually did

```sql
EXPLAIN ANALYZE
SELECT geo, AVG(cpi)
FROM raw.statcan_cpi
WHERE component = 'All-items' AND month >= DATE '2020-01-01'
GROUP BY geo;
```

The output shows each operator, how many rows flowed through it and how long it took. Look for the **filter** happening early, near the scan.

### Habits

1. **Filter early.** Put `WHERE` conditions in the first CTE, so later steps process fewer rows.
2. **Select only the columns you need.** With Parquet, unused columns are never read (Day 13).
3. **Materialise expensive, reused results** as tables instead of recomputing views, which is dbt's `table` materialisation.
4. **Don't worry about indexes.** DuckDB's columnar engine rarely needs them for analytics.
5. **Beware fan-out joins** (Day 12): a row explosion is the most common cause of slow queries.

## 17.5 A Short SQL Style Guide (15 min)

Readable SQL is maintainable SQL. Adopt these conventions for the rest of the course:

```sql
-- 1. A header comment saying what the query produces and its grain
-- Output: one row per policy decision, with market context
WITH decisions AS (                              -- 2. CTE names are nouns: what they hold
    SELECT decision_date,                        -- 3. one column per line
           rate,
           change_bp
    FROM raw.boc_decisions
    WHERE decision_date >= DATE '2022-01-01'     -- 4. filter early
),

yields AS (
    SELECT CAST(date AS DATE) AS date,
           value              AS yield_2yr       -- 5. explicit, lowercase snake_case aliases
    FROM raw.observations
    WHERE name = 'yield_2yr'
)

SELECT d.decision_date,                          -- 6. qualify columns when joining
       d.change_bp,
       y.yield_2yr
FROM decisions AS d
ASOF JOIN yields AS y
     ON d.decision_date >= y.date
ORDER BY d.decision_date;
```

- **Grain:** always know (and write down) what one row represents.
- **Keywords in CAPITALS**, names in `snake_case`.
- **One idea per CTE.**
- An optional linter, `pip install sqlfluff`, can check style automatically. dbt projects often use it.

---

## 17.6 Capstone: `marts.policy_cycles` (80 min)

Build your first **mart**: a clean, analysis-ready table that answers a real question.

> *For each Bank of Canada tightening or easing cycle since 2022: when did it start and end, how many moves did it take, how large was it in total, and what were inflation, the real rate and the 2-year yield at the start and the end?*

### Definition of a cycle

- Only actual **moves** count (holds are ignored, so a pause doesn't end a cycle).
- A new cycle begins whenever a move's **direction** differs from the previous move's direction.

This is gaps-and-islands (Day 16) on the sequence of moves.

### Requirements

Create `sql/04_policy_cycles.sql` that:

1. Builds `marts.policy_cycles` with one row per cycle and these columns: `cycle_id`, `direction` ('Tightening' / 'Easing'), `start_date`, `end_date`, `n_moves`, `total_bp`, `rate_before`, `rate_after`, `duration_days`, `cpi_yoy_start`, `cpi_yoy_end`, `real_rate_start`, `real_rate_end`, `yield_2yr_start`, `yield_2yr_end`.
2. Uses CPI with a 2-month publication lag (17.1, Example 3) and the 2-year yield from the day before the first move and the day of the last move (ASOF joins).
3. Includes a header comment stating the table's grain.

Check your result against the notebook's decision log: the 2022–23 tightening should total **+475bp** (0.25% → 5.00%) and the 2024–25 easing **−275bp** (5.00% → 2.25%).

<details>
<summary>Solution</summary>

```sql
-- marts.policy_cycles
-- Grain: one row per BoC policy cycle (a run of moves in the same direction).
-- Holds are ignored when defining cycles. Source: raw.boc_decisions,
-- raw.statcan_cpi (Canada, All-items), raw.observations (yield_2yr).

CREATE SCHEMA IF NOT EXISTS marts;

CREATE OR REPLACE TABLE marts.policy_cycles AS
WITH moves AS (
    SELECT decision_date, rate, change_bp,
           CASE WHEN change_bp > 0 THEN 'Tightening' ELSE 'Easing' END AS direction
    FROM raw.boc_decisions
    WHERE change_bp <> 0
),

marked AS (
    SELECT *,
           CASE WHEN direction = LAG(direction) OVER (ORDER BY decision_date)
                THEN 0 ELSE 1 END AS new_cycle
    FROM moves
),

numbered AS (
    SELECT *, SUM(new_cycle) OVER (ORDER BY decision_date) AS cycle_id
    FROM marked
),

cycles AS (
    SELECT cycle_id,
           ANY_VALUE(direction)                                 AS direction,
           MIN(decision_date)                                   AS start_date,
           MAX(decision_date)                                   AS end_date,
           COUNT(*)                                             AS n_moves,
           SUM(change_bp)                                       AS total_bp,
           arg_min(rate, decision_date)
             - arg_min(change_bp, decision_date) / 100.0        AS rate_before,
           arg_max(rate, decision_date)                         AS rate_after
    FROM numbered
    GROUP BY cycle_id
),

cpi AS (
    SELECT month,
           100 * (cpi / LAG(cpi, 12) OVER (ORDER BY month) - 1) AS yoy
    FROM raw.statcan_cpi
    WHERE geo = 'Canada' AND component = 'All-items'
),

yields AS (
    SELECT CAST(date AS DATE) AS date, value AS yield_2yr
    FROM raw.observations
    WHERE name = 'yield_2yr'
),

with_cpi_start AS (
    SELECT c.*, p.yoy AS cpi_yoy_start
    FROM cycles AS c
    ASOF JOIN cpi AS p
         ON CAST(date_trunc('month', c.start_date) - INTERVAL 2 MONTH AS DATE) >= p.month
),

with_cpi_end AS (
    SELECT c.*, p.yoy AS cpi_yoy_end
    FROM with_cpi_start AS c
    ASOF JOIN cpi AS p
         ON CAST(date_trunc('month', c.end_date) - INTERVAL 2 MONTH AS DATE) >= p.month
),

with_yield_start AS (
    SELECT c.*, y.yield_2yr AS yield_2yr_start
    FROM with_cpi_end AS c
    ASOF JOIN yields AS y ON c.start_date - INTERVAL 1 DAY >= y.date
),

with_yield_end AS (
    SELECT c.*, y.yield_2yr AS yield_2yr_end
    FROM with_yield_start AS c
    ASOF JOIN yields AS y ON c.end_date >= y.date
)

SELECT cycle_id,
       direction,
       start_date,
       end_date,
       n_moves,
       total_bp,
       rate_before,
       rate_after,
       end_date - start_date                   AS duration_days,
       ROUND(cpi_yoy_start, 1)                 AS cpi_yoy_start,
       ROUND(cpi_yoy_end, 1)                   AS cpi_yoy_end,
       ROUND(rate_before - cpi_yoy_start, 2)   AS real_rate_start,
       ROUND(rate_after  - cpi_yoy_end, 2)     AS real_rate_end,
       ROUND(yield_2yr_start, 2)               AS yield_2yr_start,
       ROUND(yield_2yr_end, 2)                 AS yield_2yr_end
FROM with_yield_end
ORDER BY start_date;

SELECT * FROM marts.policy_cycles;
```

Notes:
- `rate_before` = the rate after the first move minus that first move. For the first cycle: 0.50 − 0.25 = 0.25%.
- `ANY_VALUE(direction)` picks the (identical) direction within each cycle.
- Each ASOF join adds one column, which keeps every step small and testable. You could collapse them, but readability wins.

</details>

### Discussion questions

1. The real rate at the **start** of the 2022 tightening was deeply negative. What does that say about the stance when hiking began?
2. Did the 2-year yield move more or less than the policy rate over each cycle? What does that suggest about how much the market anticipated?
3. How would the table change if a **hold** ended a cycle? Which definition is more useful for your research question?

---

## 17.7 Wiring It into the Warehouse Build (20 min)

Make the decision log and the mart part of the reproducible pipeline.

**1. Add the decision log to the raw layer.** Create `sql/02b_boc_decisions.sql` by copying `day11/decisions.sql` and changing the table name to `raw.boc_decisions`.

**2. Update `load_warehouse.py`** so the SQL files run in order:

```python
for sql_file in ["01_schemas.sql", "02_raw_tables.sql",
                 "02b_boc_decisions.sql", "04_policy_cycles.sql"]:
    run_sql_file(con, SQL_DIR / sql_file)
```

Put the `04_policy_cycles.sql` run **after** `raw.dim_series` is created and before the checks.

**3. Add checks for the mart** to the `CHECKS` dictionary:

```python
"policy cycles: moves don't add up": """
    SELECT COUNT(*) FROM marts.policy_cycles
    WHERE ROUND((rate_after - rate_before) * 100) <> total_bp
""",
"policy cycles: empty mart": """
    SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END FROM marts.policy_cycles
""",
```

**4. Rebuild and export:**

```bash
python load_warehouse.py
duckdb macro.duckdb -readonly -c "COPY marts.policy_cycles TO 'data/processed/policy_cycles.csv' (HEADER)"
```

The `-c` flag runs a single command and exits, which is handy in scripts.

### Recap: Module 2 so far

| Day | You can now… |
|---|---|
| 11 | query, filter, classify and aggregate in SQL |
| 12 | reason with relational algebra and join safely |
| 13 | load CSV/Parquet and build a layered warehouse |
| 14 | structure queries as readable CTE pipelines |
| 15 | rank, lag, lead and rebase with window functions |
| 16 | compute rolling statistics and detect episodes |
| 17 | align asynchronous data with ASOF joins, write macros, build a mart |

### Looking ahead: Days 18–20

You'll formalise everything into a proper **staging layer** for CPI and GDP. That means typed, gap-checked, documented views computing year-over-year changes and moving averages directly in SQL, feeding the macro data mart that dbt will manage from Day 31.

### Day 17 checklist
- [ ] I can align data with different timing using `ASOF JOIN`, including publication lags
- [ ] I can write scalar and table macros
- [ ] I know DuckDB's friendly-SQL shortcuts and which features are portable
- [ ] I can read an `EXPLAIN ANALYZE` plan and apply basic performance habits
- [ ] I write SQL in a consistent, documented style with a stated grain
- [ ] I built, validated and exported `marts.policy_cycles` as part of the warehouse build

```bash
git add .
git commit -m "Day 17: ASOF joins, macros, policy_cycles mart"
git push
```
