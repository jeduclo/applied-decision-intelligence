# Module 2 · Analytical SQL with DuckDB
## Days 11–13: The DuckDB CLI, Relational Algebra & Loading External Files

**Audience:** MSc Economics students who completed Module 1 (Days 1–10)
**Environment:** GitHub Codespaces with the course `.venv`
**Time per day:** ~2.5 hours (including breaks and exercises)
**Goal by end of Day 13:** Students can query CSV and Parquet files directly with SQL. They understand the relational operations behind every query, and they build a persistent DuckDB warehouse (`macro.duckdb`) loaded from their Day 10 `macro_extract` pipeline, ready for the window functions and CTEs of Days 14–17.

---

### Why SQL, and why now?

In Module 1 you learned to reshape data with pandas. SQL is the other universal language of data. It's what dbt (Days 31–40) is written in, what Great Expectations (Days 41–50) validates, and what almost every organisation's data lives behind.

**DuckDB** is an analytical database that runs *inside* your program, with no server to install or manage. It reads CSV and Parquet files directly and is extremely fast on the kind of aggregations economists run all day.

| Tool | Best at |
|---|---|
| Spreadsheet | Small tables, quick eyeballing |
| pandas | Flexible transformations in Python |
| **DuckDB (SQL)** | Declarative queries, large files, joins, reproducible transformations, sharing logic with non-Python users |

You don't have to choose: on Day 13 you'll pass data freely between pandas and DuckDB.

### Target folder structure (added over Days 11–13)

```
macro-data-course/
├── macro.duckdb                ← your persistent warehouse (not committed)
├── load_warehouse.py           ← Day 13 capstone
├── sql/
│   ├── 01_schemas.sql
│   ├── 02_raw_tables.sql
│   └── 03_checks.sql
├── day11/
├── day12/
└── day13/
```

Add the database files to `.gitignore`:

```
macro.duckdb
*.duckdb
*.duckdb.wal
```

---

# DAY 11 — First Steps with SQL in the DuckDB CLI

| Time | Block |
|---|---|
| 0:00 – 0:18 | 11.1 Installing DuckDB and first contact |
| 0:18 – 0:38 | 11.2 Tables: `CREATE TABLE` and `INSERT` |
| 0:38 – 0:45 | Break |
| 0:45 – 1:15 | 11.3 `SELECT`, `WHERE`, `ORDER BY`, `LIMIT` |
| 1:15 – 1:35 | 11.4 `CASE WHEN`: classification in SQL |
| 1:35 – 1:43 | Break |
| 1:43 – 2:00 | 11.5 Data types, `CAST`, `TRY_CAST` and dates |
| 2:00 – 2:20 | 11.6 Aggregation: `GROUP BY` and `HAVING` |
| 2:20 – 2:30 | 11.7 Mini-project: the BoC decision log |

---

## 11.1 Installing DuckDB and First Contact (18 min)

### Step 1 — Install the command-line interface (CLI)

In the Codespaces terminal:

```bash
cd /workspaces/macro-data-course
curl https://install.duckdb.org | sh
```

The installer tells you where it put the program (usually `~/.duckdb/cli/latest/duckdb`). Add that folder to your `PATH` so you can type `duckdb` anywhere:

```bash
echo 'export PATH="$HOME/.duckdb/cli/latest:$PATH"' >> ~/.bashrc
source ~/.bashrc
duckdb --version
```

<details>
<summary>Alternative: install from GitHub releases</summary>

```bash
wget https://github.com/duckdb/duckdb/releases/latest/download/duckdb_cli-linux-amd64.zip
unzip duckdb_cli-linux-amd64.zip -d ~/.local/bin
rm duckdb_cli-linux-amd64.zip
duckdb --version
```

</details>

Also install the Python package now; we'll use it on Day 13:

```bash
source .venv/bin/activate
pip install duckdb
pip freeze > requirements.txt
```

### Step 2 — Your first queries

Start DuckDB **in memory** (nothing is saved):

```bash
duckdb
```

The prompt changes to `D`. SQL statements end with a semicolon `;`.

```sql
SELECT 2.25 - 3.0;
SELECT 2.25 - 3.0 AS real_rate;
SELECT (1 + 0.0225) / (1 + 0.03) - 1 AS real_rate_exact;
SELECT 3180 * POWER(1.015, 5) AS gdp_in_5_years;
```

These are the Day 1 calculations, now in SQL. `AS` gives a result column a name, called an **alias**.

### Step 3 — Dot commands (CLI settings, not SQL)

Commands starting with `.` control the CLI itself and don't need a semicolon:

| Command | Does |
|---|---|
| `.help` | list all dot commands |
| `.mode box` | pretty table output (try also `line`, `csv`, `markdown`) |
| `.timer on` | show how long each query takes |
| `.tables` | list tables |
| `.schema` | show table definitions |
| `.read file.sql` | run SQL from a file |
| `.quit` | exit (or `Ctrl+D`) |

```sql
.mode box
.timer on
SELECT 'Hello, DuckDB' AS greeting, 2026 AS year;
```

### Step 4 — A persistent database file

Exit with `.quit`, then open (or create) a database **file**:

```bash
duckdb day11/practice.duckdb
```

Anything you create is now saved to that file and will still be there next time.

> **Working style for Days 11–12:** write SQL in a `.sql` file in VS Code (you get syntax highlighting and can save your work), then run it in the CLI with `.read day11/filename.sql`. For quick experiments, type directly at the `D` prompt.

---

## 11.2 Tables: `CREATE TABLE` and `INSERT` (20 min)

A **table** is a DataFrame with a fixed schema: every column has a name and a declared type. Create `day11/provinces.sql`:

```sql
-- Provincial fiscal positions FY2026 (% of provincial GDP) — from the course notebook
CREATE OR REPLACE TABLE provinces (
    province        VARCHAR,
    region          VARCHAR,
    balance_pct_gdp DOUBLE
);

INSERT INTO provinces VALUES
    ('BC', 'West',     -0.8),
    ('AB', 'West',      0.2),
    ('SK', 'Prairies',  0.5),
    ('MB', 'Prairies', -0.9),
    ('ON', 'Central',  -1.4),
    ('QC', 'Central',  -1.2),
    ('NB', 'Atlantic', -0.5),
    ('NS', 'Atlantic', -0.3),
    ('PE', 'Atlantic', -0.7),
    ('NL', 'Atlantic',  0.1);
```

Run it:

```sql
.read day11/provinces.sql
.tables
DESCRIBE provinces;
SELECT * FROM provinces;
```

Notes:
- `--` starts a comment (like `#` in Python).
- Text values use **single quotes** `'BC'`. Double quotes are for column *names* that contain spaces (Day 13).
- `CREATE OR REPLACE` lets you rerun the file without "table already exists" errors.
- SQL keywords are case-insensitive. Writing them in CAPITALS is a convention that makes queries easier to read.

Now a second table: the notebook's BoC decision log. Create `day11/decisions.sql`:

```sql
CREATE OR REPLACE TABLE boc_decisions (
    decision_date DATE,
    rate          DOUBLE,
    change_bp     INTEGER,
    note          VARCHAR
);

INSERT INTO boc_decisions VALUES
    ('2022-03-02', 0.50,   25, 'First 2022 hike'),
    ('2022-04-13', 1.00,   50, 'Accelerating'),
    ('2022-06-01', 1.50,   50, NULL),
    ('2022-07-13', 2.50,  100, 'Jumbo hike'),
    ('2022-09-07', 3.25,   75, NULL),
    ('2022-10-26', 3.75,   50, NULL),
    ('2022-12-07', 4.25,   50, NULL),
    ('2023-01-25', 4.25,    0, 'Conditional pause'),
    ('2023-03-08', 4.25,    0, NULL),
    ('2023-04-12', 4.25,    0, NULL),
    ('2023-06-07', 4.75,   50, 'Resumed hiking'),
    ('2023-07-12', 5.00,   25, 'Peak rate'),
    ('2023-09-06', 5.00,    0, NULL),
    ('2024-06-05', 4.75,  -25, 'First cut'),
    ('2024-07-24', 4.50,  -25, NULL),
    ('2024-09-04', 4.25,  -25, NULL),
    ('2024-10-23', 3.75,  -50, 'Accelerating cuts'),
    ('2024-12-11', 3.25,  -50, NULL),
    ('2025-01-29', 3.00,  -25, NULL),
    ('2025-03-12', 2.75,  -25, NULL),
    ('2025-04-16', 2.25,  -50, 'Tariff shock'),
    ('2025-06-04', 2.25,    0, NULL),
    ('2025-07-30', 2.25,    0, NULL),
    ('2025-09-10', 2.25,    0, NULL),
    ('2025-10-29', 2.25,    0, 'Current hold');
```

> The notebook stored changes as text (`"+25bp"`, `"Hold"`). Here we store `change_bp` as a **number**, with `0` for holds, so we can do arithmetic on it. Choosing good types when you design a table saves effort in every later query.

`NULL` is SQL's missing value, the equivalent of pandas' `NaN`.

---

## 11.3 `SELECT`, `WHERE`, `ORDER BY`, `LIMIT` (30 min)

Create `day11/select_basics.sql` and try each query in turn.

### Example 1 — Choosing columns (projection)

```sql
SELECT province, balance_pct_gdp FROM provinces;

SELECT province,
       balance_pct_gdp,
       balance_pct_gdp * 100 AS balance_bp          -- a calculated column
FROM provinces;
```

### Example 2 — Choosing rows (filtering)

```sql
SELECT * FROM provinces WHERE balance_pct_gdp > 0;

SELECT * FROM provinces
WHERE region = 'Atlantic' AND balance_pct_gdp < 0;

SELECT * FROM provinces
WHERE region IN ('West', 'Prairies');

SELECT * FROM provinces
WHERE balance_pct_gdp BETWEEN -1.0 AND -0.5;        -- inclusive at both ends
```

| SQL | pandas equivalent (Day 4) |
|---|---|
| `WHERE x > 0` | `df[df["x"] > 0]` |
| `AND` / `OR` / `NOT` | `&` / `\|` / `~` |
| `IN ('a', 'b')` | `.isin(["a", "b"])` |
| `BETWEEN a AND b` | `.between(a, b)` |

### Example 3 — Missing values need `IS NULL`

```sql
SELECT * FROM boc_decisions WHERE note IS NULL;
SELECT * FROM boc_decisions WHERE note IS NOT NULL;

-- Wrong! NULL is never "equal" to anything, not even NULL:
SELECT * FROM boc_decisions WHERE note = NULL;      -- returns zero rows
```

### Example 4 — Text patterns

```sql
SELECT * FROM boc_decisions WHERE note LIKE '%hike%';     -- % = any characters
SELECT * FROM boc_decisions WHERE note ILIKE '%CUT%';     -- ILIKE ignores case
```

### Example 5 — Sorting and limiting

```sql
SELECT * FROM provinces ORDER BY balance_pct_gdp;               -- worst first
SELECT * FROM provinces ORDER BY balance_pct_gdp DESC LIMIT 3;  -- top 3
SELECT * FROM provinces ORDER BY region, balance_pct_gdp;       -- two keys
```

### Example 6 — Unique values

```sql
SELECT DISTINCT region FROM provinces ORDER BY region;
```

### Try it 11.3

Write queries to find:
(a) all rate **cuts** (negative `change_bp`), newest first;
(b) decisions in 2023 (hint: `decision_date BETWEEN '2023-01-01' AND '2023-12-31'`);
(c) the three largest moves in absolute size (hint: `ABS()`).

<details>
<summary>Solution</summary>

```sql
-- (a)
SELECT * FROM boc_decisions WHERE change_bp < 0 ORDER BY decision_date DESC;

-- (b)
SELECT * FROM boc_decisions
WHERE decision_date BETWEEN '2023-01-01' AND '2023-12-31';

-- (c)
SELECT decision_date, change_bp
FROM boc_decisions
ORDER BY ABS(change_bp) DESC
LIMIT 3;
```

</details>

---

## 11.4 `CASE WHEN`: Classification in SQL (20 min)

`CASE WHEN` is SQL's `if / elif / else`. It's the same logic as your Day 3 `classify_stance` function.

### Example 1 — Policy stance

```sql
SELECT decision_date,
       rate,
       CASE
           WHEN rate < 2.25  THEN 'Stimulative'
           WHEN rate <= 2.75 THEN 'Neutral'
           ELSE 'Restrictive'
       END AS stance
FROM boc_decisions
ORDER BY decision_date;
```

As in Python, conditions are checked **top to bottom** and the first match wins.

### Example 2 — Direction of each decision

```sql
SELECT decision_date,
       change_bp,
       CASE
           WHEN change_bp > 0 THEN 'Hike'
           WHEN change_bp < 0 THEN 'Cut'
           ELSE 'Hold'
       END AS action
FROM boc_decisions;
```

### Example 3 — Replacing missing values with `COALESCE`

```sql
SELECT decision_date,
       COALESCE(note, '—') AS note        -- first non-NULL value
FROM boc_decisions;
```

### Try it 11.4

Classify provinces as `'Surplus'` (> 0), `'Small deficit'` (between −0.5 and 0) or `'Large deficit'`, matching the Day 4 `fiscal_status` function. Sort from best to worst.

<details>
<summary>Solution</summary>

```sql
SELECT province,
       balance_pct_gdp,
       CASE
           WHEN balance_pct_gdp > 0     THEN 'Surplus'
           WHEN balance_pct_gdp >= -0.5 THEN 'Small deficit'
           ELSE 'Large deficit'
       END AS status
FROM provinces
ORDER BY balance_pct_gdp DESC;
```

</details>

---

## 11.5 Data Types, `CAST`, `TRY_CAST` and Dates (18 min)

### Common types

| DuckDB type | Holds | Python/pandas analogue |
|---|---|---|
| `INTEGER`, `BIGINT` | whole numbers | `int` |
| `DOUBLE` | decimals | `float` |
| `DECIMAL(10,2)` | exact decimals (e.g. money) | — |
| `VARCHAR` | text | `str` |
| `BOOLEAN` | true/false | `bool` |
| `DATE` | calendar date | `Timestamp` (date only) |
| `TIMESTAMP` | date + time | `Timestamp` |

### Converting types

```sql
SELECT CAST('2.25' AS DOUBLE) + 1;          -- 3.25
SELECT '2.25'::DOUBLE + 1;                  -- shorthand, same result

SELECT CAST('Bank holiday' AS DOUBLE);      -- ERROR
SELECT TRY_CAST('Bank holiday' AS DOUBLE);  -- NULL — no error
```

`TRY_CAST` is SQL's version of `pd.to_numeric(errors="coerce")`. We rely on it on Day 13 to clean raw BoC files.

### Working with dates

```sql
SELECT DATE '2024-06-05' - DATE '2023-07-12' AS days_between;       -- 329
SELECT date_diff('month', DATE '2023-07-12', DATE '2024-06-05');    -- months
SELECT year(DATE '2024-06-05'), month(DATE '2024-06-05'), quarter(DATE '2024-06-05');
SELECT date_trunc('month', DATE '2024-06-05');                      -- 2024-06-01
SELECT date_trunc('quarter', DATE '2024-06-05');                    -- 2024-04-01
SELECT DATE '2024-06-05' + INTERVAL 3 MONTH;
SELECT strftime(DATE '2024-06-05', '%B %Y');                        -- June 2024
```

`date_trunc('month', …)` does the same job as the notebook's `.dt.to_period("M").dt.to_timestamp()`: it moves every date to the start of its month.

```sql
SELECT decision_date,
       year(decision_date)                  AS yr,
       date_trunc('quarter', decision_date) AS quarter_start
FROM boc_decisions;
```

---

## 11.6 Aggregation: `GROUP BY` and `HAVING` (20 min)

### Example 1 — Whole-table summaries

```sql
SELECT COUNT(*)                 AS n_decisions,
       MIN(rate)                AS min_rate,
       MAX(rate)                AS peak_rate,
       ROUND(AVG(rate), 2)      AS avg_rate,
       SUM(change_bp)           AS net_change_bp
FROM boc_decisions;
```

### Example 2 — Per-group summaries

```sql
SELECT year(decision_date) AS yr,
       COUNT(*)            AS n_decisions,
       SUM(change_bp)      AS net_change_bp,
       MAX(rate)           AS max_rate
FROM boc_decisions
GROUP BY yr
ORDER BY yr;
```

This is `df.groupby(df["date"].dt.year).agg(...)` from Day 6.

> **The golden rule of `GROUP BY`:** every column in `SELECT` must either appear in `GROUP BY` or be wrapped in an aggregate function (`COUNT`, `SUM`, `AVG`, `MIN`, `MAX`...). DuckDB's shortcut `GROUP BY ALL` groups by every non-aggregated column automatically.

### Example 3 — Counting within a group with a condition

```sql
SELECT year(decision_date)                   AS yr,
       COUNT(*) FILTER (WHERE change_bp > 0) AS hikes,
       COUNT(*) FILTER (WHERE change_bp < 0) AS cuts,
       COUNT(*) FILTER (WHERE change_bp = 0) AS holds
FROM boc_decisions
GROUP BY ALL
ORDER BY yr;
```

### Example 4 — Filtering groups with `HAVING`

`WHERE` filters **rows before** grouping; `HAVING` filters **groups after** aggregation.

```sql
SELECT region,
       COUNT(*)                        AS n_provinces,
       ROUND(AVG(balance_pct_gdp), 2)  AS avg_balance
FROM provinces
GROUP BY region
HAVING AVG(balance_pct_gdp) < 0
ORDER BY avg_balance;
```

---

## 11.7 Mini-Project: The BoC Decision Log (10 min)

Create `day11/decision_log.sql` answering:

1. How many hikes, cuts and holds were there in total?
2. What was the total tightening in 2022–2023 and the total easing since 2024?
3. How many days passed between the first 2022 hike and the peak rate?
4. List each year with its first and last policy rate (hint: `MIN`/`MAX` on `decision_date`, or DuckDB's `arg_min(rate, decision_date)` / `arg_max(rate, decision_date)`).

<details>
<summary>Solution</summary>

```sql
-- 1
SELECT CASE WHEN change_bp > 0 THEN 'Hike'
            WHEN change_bp < 0 THEN 'Cut' ELSE 'Hold' END AS action,
       COUNT(*) AS n
FROM boc_decisions
GROUP BY action;

-- 2
SELECT SUM(change_bp) FILTER (WHERE decision_date < '2024-01-01')  AS tightening_bp,
       SUM(change_bp) FILTER (WHERE decision_date >= '2024-01-01') AS easing_bp
FROM boc_decisions;

-- 3
SELECT MAX(decision_date) FILTER (WHERE note = 'Peak rate')
     - MIN(decision_date) AS days_first_hike_to_peak
FROM boc_decisions;

-- 4
SELECT year(decision_date)                 AS yr,
       arg_min(rate, decision_date)        AS first_rate,
       arg_max(rate, decision_date)        AS last_rate
FROM boc_decisions
GROUP BY yr
ORDER BY yr;
```

`arg_max(rate, decision_date)` means *"the `rate` on the row where `decision_date` is largest"*. It's a DuckDB convenience that standard SQL lacks.

</details>

### Day 11 checklist
- [ ] I can open DuckDB in memory or with a database file, and use dot commands
- [ ] I can create tables with typed columns and insert rows
- [ ] I can filter (`WHERE`), sort (`ORDER BY`), limit and classify (`CASE WHEN`)
- [ ] I handle `NULL` correctly with `IS NULL` and `COALESCE`
- [ ] I can convert types (`CAST`, `TRY_CAST`) and manipulate dates
- [ ] I can aggregate with `GROUP BY`, `FILTER` and `HAVING`

```bash
git add .
git commit -m "Day 11: DuckDB CLI and SQL basics"
git push
```

---

# DAY 12 — Relational Algebra: The Logic Behind Every Query

| Time | Block |
|---|---|
| 0:00 – 0:20 | 12.1 The relational model: tables, keys and constraints |
| 0:20 – 0:45 | 12.2 The core operations: σ, π, ρ |
| 0:45 – 0:53 | Break |
| 0:53 – 1:15 | 12.3 Set operations: ∪, ∩, − |
| 1:15 – 1:50 | 12.4 Products and joins: ×, ⋈ and their variants |
| 1:50 – 1:58 | Break |
| 1:58 – 2:13 | 12.5 How SQL is evaluated · 12.6 Subqueries |
| 2:13 – 2:30 | 12.7 Mini-project: a star schema for macro series |

Open a fresh database for today:

```bash
duckdb day12/relational.duckdb
```

```sql
.mode box
.read day11/provinces.sql
.read day11/decisions.sql
```

---

## 12.1 The Relational Model (20 min)

In 1970, Edgar F. Codd proposed storing data as **relations**: sets of rows sharing the same columns. Every SQL database since is built on his ideas, and knowing the vocabulary helps you reason about queries precisely.

| Relational term | SQL term | pandas term |
|---|---|---|
| relation | table | DataFrame |
| tuple | row | row |
| attribute | column | column |
| domain | data type | dtype |
| key | primary key | a unique index |

### Keys: what makes a row unique?

A **primary key** is the column (or combination of columns) that identifies each row uniquely:

| Table | Primary key |
|---|---|
| `provinces` | `province` |
| `boc_decisions` | `decision_date` |
| a long observations table | (`series_id`, `date`), a **composite** key |

Remember Day 10's `validate()`, which rejected duplicate `(series_id, date)` rows? You were enforcing a composite primary key by hand.

### Constraints: let the database enforce the rules

Create `day12/constraints.sql`:

```sql
CREATE OR REPLACE TABLE labour_market (
    ref_month         DATE    NOT NULL,
    province          VARCHAR NOT NULL,
    unemployment_rate DOUBLE  CHECK (unemployment_rate BETWEEN 0 AND 100),
    PRIMARY KEY (ref_month, province)
);

INSERT INTO labour_market VALUES ('2026-07-01', 'ON', 7.1);   -- ok
INSERT INTO labour_market VALUES ('2026-07-01', 'ON', 7.2);   -- duplicate key → error
INSERT INTO labour_market VALUES ('2026-07-01', 'QC', 540);   -- CHECK fails → error
INSERT INTO labour_market VALUES (NULL, 'BC', 5.9);           -- NOT NULL → error
```

Run each `INSERT` separately and read the error messages. The CHECK constraint is exactly the notebook curriculum's rule *"unemployment rates remain between 0–100%"*. On Days 48–50 you'll express the same idea in Great Expectations.

> Constraints guard data **as it enters**. Checks like Day 7's `check_panel` inspect data **after the fact**. Good pipelines use both.

---

## 12.2 The Core Operations: σ, π, ρ (25 min)

Relational algebra describes queries as operations that take tables in and return a table out. Because the output is always a table, operations can be **chained**, much like pandas methods.

### Selection σ — keep rows meeting a condition

**σ**<sub>balance < 0</sub>(provinces)

```sql
SELECT * FROM provinces WHERE balance_pct_gdp < 0;
```

### Projection π — keep certain columns

**π**<sub>province, balance</sub>(provinces)

```sql
SELECT province, balance_pct_gdp FROM provinces;
```

> **A subtle point:** in pure relational algebra a relation is a *set*, so projection removes duplicate rows. SQL keeps duplicates unless you ask otherwise. Compare these two:

```sql
SELECT region FROM provinces;            -- 10 rows (a "bag")
SELECT DISTINCT region FROM provinces;   -- 4 rows  (a true set)
```

### Rename ρ — rename columns or tables

**ρ**<sub>bal ← balance_pct_gdp</sub>(provinces)

```sql
SELECT province, balance_pct_gdp AS bal FROM provinces AS p;
```

### Composition — operations nest

**π**<sub>province</sub>(**σ**<sub>region='Atlantic'</sub>(provinces))

"Filter to Atlantic, then keep the province column":

```sql
SELECT province FROM provinces WHERE region = 'Atlantic';
```

### Aggregation γ (an extension to the original algebra)

**γ**<sub>region; AVG(balance)</sub>(provinces)

```sql
SELECT region, AVG(balance_pct_gdp) FROM provinces GROUP BY region;
```

### Translation table

| Operation | Symbol | SQL | pandas |
|---|---|---|---|
| Selection | σ | `WHERE` | `df[mask]` |
| Projection | π | `SELECT cols` | `df[["a", "b"]]` |
| Rename | ρ | `AS` | `.rename()` |
| Aggregation | γ | `GROUP BY` | `.groupby().agg()` |
| Union | ∪ | `UNION` | `pd.concat` + `drop_duplicates` |
| Intersection | ∩ | `INTERSECT` | inner `merge` on all columns |
| Difference | − | `EXCEPT` | anti-join (see 12.4) |
| Cartesian product | × | `CROSS JOIN` | `merge(how="cross")` |
| Join | ⋈ | `JOIN ... ON` | `merge` |

### Try it 12.2

Write the relational-algebra expression and the SQL for: *"the names of provinces in the West or Prairies with a surplus."*

<details>
<summary>Solution</summary>

**π**<sub>province</sub>(**σ**<sub>(region='West' ∨ region='Prairies') ∧ balance > 0</sub>(provinces))

```sql
SELECT province
FROM provinces
WHERE region IN ('West', 'Prairies') AND balance_pct_gdp > 0;
```

Result: AB, SK.

</details>

---

## 12.3 Set Operations: ∪, ∩, − (23 min)

Set operations combine two tables **with the same columns**. Create `day12/sets.sql`:

```sql
CREATE OR REPLACE TABLE surplus_2026 AS
    SELECT province FROM provinces WHERE balance_pct_gdp > 0;

-- Illustrative: provinces that balanced their budget in the previous year
CREATE OR REPLACE TABLE surplus_2025 (province VARCHAR);
INSERT INTO surplus_2025 VALUES ('AB'), ('SK'), ('QC');
```

### Union ∪ — in either year

```sql
SELECT province FROM surplus_2025
UNION                                   -- removes duplicates (a true set union)
SELECT province FROM surplus_2026;

SELECT province FROM surplus_2025
UNION ALL                               -- keeps duplicates; faster
SELECT province FROM surplus_2026;
```

### Intersection ∩ — in both years

```sql
SELECT province FROM surplus_2025
INTERSECT
SELECT province FROM surplus_2026;
```

### Difference − — in one but not the other

```sql
-- Lost their surplus
SELECT province FROM surplus_2025
EXCEPT
SELECT province FROM surplus_2026;

-- Newly in surplus
SELECT province FROM surplus_2026
EXCEPT
SELECT province FROM surplus_2025;
```

> **Order matters for `EXCEPT`**, just as A − B ≠ B − A.

### A DuckDB convenience: `UNION BY NAME`

Standard `UNION` matches columns by **position**, which is a common source of silent bugs. DuckDB can match by **name** instead:

```sql
SELECT 'boc' AS source, 2.25 AS rate
UNION ALL BY NAME
SELECT 3.63 AS rate, 'fed' AS source;      -- columns in a different order: still correct
```

This is what you want when stacking extracts from several sources, as in Day 10's `pd.concat`.

---

## 12.4 Products and Joins (35 min)

### The Cartesian product × — every combination

```sql
CREATE OR REPLACE TABLE scenarios (scenario VARCHAR, gdp_growth DOUBLE);
INSERT INTO scenarios VALUES ('Base', 1.8), ('Downside', -0.5);

CREATE OR REPLACE TABLE rate_paths (path VARCHAR, terminal_rate DOUBLE);
INSERT INTO rate_paths VALUES ('Hold', 2.25), ('Cut', 1.75), ('Hike', 2.75);

SELECT * FROM scenarios CROSS JOIN rate_paths;     -- 2 × 3 = 6 rows
```

Cross joins are useful for scenario grids. They're also why a join with a **missing or wrong join condition** can explode your row count.

### A join ⋈ is a product followed by a selection

**R ⋈<sub>R.k = S.k</sub> S = σ<sub>R.k = S.k</sub>(R × S)**

Set up two small tables of monthly rates (illustrative values). Note that the months don't fully overlap:

```sql
CREATE OR REPLACE TABLE boc_monthly (month DATE, overnight_rate DOUBLE);
INSERT INTO boc_monthly VALUES
    ('2026-03-01', 2.25), ('2026-04-01', 2.25), ('2026-05-01', 2.25),
    ('2026-06-01', 2.25), ('2026-07-01', 2.25), ('2026-08-01', 2.25);

CREATE OR REPLACE TABLE fed_monthly (month DATE, fed_funds DOUBLE);
INSERT INTO fed_monthly VALUES
    ('2026-02-01', 3.64), ('2026-03-01', 3.64), ('2026-04-01', 3.63),
    ('2026-05-01', 3.63), ('2026-06-01', 3.63), ('2026-07-01', 3.63);
```

### Inner join — months in **both**

```sql
SELECT b.month,
       b.overnight_rate,
       f.fed_funds,
       b.overnight_rate - f.fed_funds AS boc_fed_diff
FROM boc_monthly AS b
JOIN fed_monthly AS f ON b.month = f.month
ORDER BY b.month;
```

`b` and `f` are **table aliases** (ρ again) that keep queries short. When both tables share the key's name, `USING` is a neater form:

```sql
SELECT month, overnight_rate, fed_funds
FROM boc_monthly JOIN fed_monthly USING (month);
```

### Left, right and full outer joins

```sql
-- Every BoC month; Fed values where available (August has none yet)
SELECT * FROM boc_monthly LEFT JOIN fed_monthly USING (month) ORDER BY month;

-- Every month from either table
SELECT * FROM boc_monthly FULL OUTER JOIN fed_monthly USING (month) ORDER BY month;
```

| Join | Keeps | pandas `how=` |
|---|---|---|
| `JOIN` / `INNER JOIN` | matches only | `"inner"` |
| `LEFT JOIN` | all left rows | `"left"` |
| `RIGHT JOIN` | all right rows | `"right"` |
| `FULL OUTER JOIN` | all rows from both | `"outer"` |
| `CROSS JOIN` | every combination | `"cross"` |

### Semi-join and anti-join: filtering by another table

A **semi-join** keeps rows of A that have a match in B, without adding B's columns. An **anti-join** keeps rows of A with **no** match. DuckDB supports both directly:

```sql
-- BoC months that have Fed data
SELECT * FROM boc_monthly SEMI JOIN fed_monthly USING (month);

-- BoC months MISSING Fed data — a classic data-quality check
SELECT * FROM boc_monthly ANTI JOIN fed_monthly USING (month);
```

The anti-join is what Day 6's `merge(..., indicator=True)` diagnostic was doing. Here it takes one line.

### The fan-out trap: joining on a non-unique key

```sql
CREATE OR REPLACE TABLE regional_notes (region VARCHAR, note VARCHAR);
INSERT INTO regional_notes VALUES
    ('Atlantic', 'Fisheries exposure'),
    ('Atlantic', 'Ageing population'),     -- a second row for the same region!
    ('West',     'Energy exposure');

SELECT COUNT(*) FROM provinces;                                    -- 10
SELECT COUNT(*) FROM provinces JOIN regional_notes USING (region); -- more than you'd think
```

Each Atlantic province matched **two** notes, so it now appears twice. Any `SUM` over that result would double-count. Always know whether your join key is **unique** on the side you're joining to.

> **Habit:** after every join, compare row counts before and after. If the count grew unexpectedly, you have a fan-out.

### Try it 12.4

(a) Find regions that appear in `provinces` but have **no** entry in `regional_notes`.
(b) Produce one row per province with *all* its notes combined into a single text field, so there is no fan-out. (Hint: aggregate first with `string_agg(note, '; ')`, then join.)

<details>
<summary>Solution</summary>

```sql
-- (a)
SELECT DISTINCT region FROM provinces ANTI JOIN regional_notes USING (region);

-- (b)
SELECT p.province, p.region, n.notes
FROM provinces AS p
LEFT JOIN (
    SELECT region, string_agg(note, '; ') AS notes
    FROM regional_notes
    GROUP BY region
) AS n USING (region)
ORDER BY p.province;
```

Aggregating `regional_notes` to one row per region first makes `region` unique, so the join can't fan out.

</details>

---

## 12.5 How SQL Is Evaluated (8 min)

You *write* SQL in one order, but the database *evaluates* it in another:

| Written order | Logical evaluation order |
|---|---|
| 1. `SELECT` | 5 |
| 2. `FROM` / `JOIN` | **1** — build the combined table |
| 3. `WHERE` | **2** — filter rows (σ) |
| 4. `GROUP BY` | **3** — form groups (γ) |
| 5. `HAVING` | **4** — filter groups |
| 6. `ORDER BY` | 6 |
| 7. `LIMIT` | 7 |

This explains several puzzling rules:
- You can't use an aggregate like `AVG(x)` in `WHERE`, because groups don't exist yet at step 2. Use `HAVING`.
- In standard SQL, aliases defined in `SELECT` can't be used in `WHERE`. (DuckDB is friendlier and allows it, but don't count on this in other databases.)

Behind the scenes DuckDB rewrites your query into an efficient plan. You can inspect it:

```sql
EXPLAIN
SELECT region, AVG(balance_pct_gdp)
FROM provinces
WHERE balance_pct_gdp < 0
GROUP BY region;
```

You'll see the relational operators (filter, projection, aggregate) arranged as a tree.

---

## 12.6 Subqueries (8 min)

A query's result is a table, so it can be used inside another query.

```sql
-- Scalar subquery: provinces worse than the average
SELECT province, balance_pct_gdp
FROM provinces
WHERE balance_pct_gdp < (SELECT AVG(balance_pct_gdp) FROM provinces);

-- IN subquery: decisions taken at the peak rate
SELECT *
FROM boc_decisions
WHERE rate = (SELECT MAX(rate) FROM boc_decisions);
```

Nested subqueries quickly become hard to read. On Days 14–17 you'll learn **Common Table Expressions** (`WITH ...`), which name each step, like variables in Python.

---

## 12.7 Mini-Project: A Star Schema for Macro Series (18 min)

Analytical databases often separate:
- a **fact table**: many rows of measurements (`series_id`, `date`, `value`);
- **dimension tables**: few rows describing the facts (series names, units, sources).

Joining them gives labelled data without repeating descriptions millions of times. This is the design dbt marts use on Days 38–40.

Create `day12/star_schema.sql`:

```sql
-- Dimension: one row per series (the Day 10 catalogue, with more detail)
CREATE OR REPLACE TABLE dim_series (
    series_id  VARCHAR PRIMARY KEY,
    name       VARCHAR NOT NULL,
    source     VARCHAR NOT NULL,
    frequency  VARCHAR,
    unit       VARCHAR
);

INSERT INTO dim_series VALUES
    ('V39079',    'overnight_rate', 'boc',     'daily',   'percent'),
    ('FEDFUNDS',  'fed_funds',      'fred',    'monthly', 'percent'),
    ('v41690973', 'cpi_all_items',  'statcan', 'monthly', 'index 2002=100');

-- Fact: one row per series per date (illustrative values)
CREATE OR REPLACE TABLE fact_observations (
    series_id VARCHAR,
    obs_date  DATE,
    value     DOUBLE,
    PRIMARY KEY (series_id, obs_date)
);

INSERT INTO fact_observations VALUES
    ('V39079',   '2026-07-01', 2.25), ('V39079',   '2026-08-01', 2.25),
    ('FEDFUNDS', '2026-07-01', 3.63), ('FEDFUNDS', '2026-08-01', 3.63),
    ('v41690973','2026-06-01', 168.2),('v41690973','2026-07-01', 169.0),
    ('XYZ999',   '2026-07-01', 1.0);     -- orphan: no matching dimension row!
```

**Tasks:**
1. Join facts to the dimension to show `name`, `source`, `unit`, `obs_date` and `value`.
2. Count observations per `source`.
3. Find **orphan** facts with no matching series (anti-join).
4. Find series in the dimension with **no** observations.
5. Write the relational-algebra expression for task 1.

<details>
<summary>Solution</summary>

```sql
-- 1
SELECT d.name, d.source, d.unit, f.obs_date, f.value
FROM fact_observations AS f
JOIN dim_series AS d USING (series_id)
ORDER BY d.name, f.obs_date;

-- 2
SELECT d.source, COUNT(*) AS n_obs
FROM fact_observations AS f
JOIN dim_series AS d USING (series_id)
GROUP BY d.source;

-- 3
SELECT * FROM fact_observations ANTI JOIN dim_series USING (series_id);

-- 4
SELECT * FROM dim_series ANTI JOIN fact_observations USING (series_id);

-- 5: π_{name, source, unit, obs_date, value}( fact_observations ⋈_{series_id} dim_series )
```

Notice that the inner join in task 1 **silently dropped** the orphan row `XYZ999`. That's why task 3's check matters. In a production pipeline you'd enforce this with a *foreign key* or a test (dbt's `relationships` test, Days 34–37).

</details>

### Day 12 checklist
- [ ] I can identify primary keys (including composite keys) and add constraints
- [ ] I can express queries with σ, π, ρ, γ and translate between algebra, SQL and pandas
- [ ] I can use `UNION`, `INTERSECT`, `EXCEPT` and `UNION BY NAME`
- [ ] I can choose the right join, and use semi- and anti-joins for checks
- [ ] I check row counts after joins to catch fan-outs
- [ ] I understand SQL's logical evaluation order

```bash
git add .
git commit -m "Day 12: relational algebra, joins, star schema"
git push
```

---

# DAY 13 — Loading External CSV and Parquet Files

| Time | Block |
|---|---|
| 0:00 – 0:25 | 13.1 Querying files directly |
| 0:25 – 0:55 | 13.2 Taming messy CSVs: BoC, FRED and StatCan |
| 0:55 – 1:03 | Break |
| 1:03 – 1:25 | 13.3 Parquet: columnar storage |
| 1:25 – 1:45 | 13.4 Persisting data: schemas, tables and views |
| 1:45 – 1:53 | Break |
| 1:53 – 2:10 | 13.5 DuckDB from Python |
| 2:10 – 2:30 | 13.6 Capstone: `load_warehouse.py` |

**Before you start**, make sure these files exist (rerun earlier scripts if needed):

```bash
ls data/staging/observations.parquet          # from Day 10: python run_extract.py
ls data/*.csv                                  # from Day 4:  python get_course_data.py
ls data/raw/statcan/18100004.zip               # from Day 10, section 10.3
```

Then unzip the full CPI table for today's large-file exercises:

```bash
mkdir -p data/raw/statcan/18100004
unzip -o data/raw/statcan/18100004.zip -d data/raw/statcan/18100004
ls -lh data/raw/statcan/18100004
```

---

## 13.1 Querying Files Directly (25 min)

This is DuckDB's superpower: **a file path can be used like a table**, with no import step. Start an in-memory session from the repository root:

```bash
duckdb
```

```sql
.mode box
.timer on
```

### Example 1 — Parquet in one line

```sql
SELECT * FROM 'data/staging/observations.parquet' LIMIT 5;
```

### Example 2 — Inspect before you trust

```sql
DESCRIBE SELECT * FROM 'data/staging/observations.parquet';

SELECT name, source, COUNT(*) AS n, MIN(date) AS first, MAX(date) AS latest
FROM 'data/staging/observations.parquet'
GROUP BY ALL
ORDER BY source, name;

SUMMARIZE SELECT * FROM 'data/staging/observations.parquet';
```

`SUMMARIZE` is DuckDB's `df.describe()`: types, min/max, distinct counts and null percentages for every column.

### Example 3 — CSV files

```sql
SELECT * FROM 'data/statcan_cpi.csv' LIMIT 5;
DESCRIBE SELECT * FROM 'data/statcan_cpi.csv';
```

DuckDB **sniffs** the CSV: it guesses the delimiter, whether there's a header, and each column's type. Check what it decided before building on it.

### Example 4 — The explicit reader functions

The short form `FROM 'file.csv'` calls these functions behind the scenes. Use them directly when you need options:

```sql
SELECT * FROM read_csv('data/statcan_cpi.csv', header = true) LIMIT 3;
SELECT * FROM read_parquet('data/staging/observations.parquet') LIMIT 3;
```

### Example 5 — Quoting column names with spaces

StatCan column names contain spaces, so wrap them in **double quotes**:

```sql
SELECT REF_DATE, "Products and product groups" AS component, VALUE
FROM 'data/statcan_cpi.csv'
WHERE "Products and product groups" = 'All-items'
ORDER BY REF_DATE DESC
LIMIT 5;
```

> **Quotes in SQL:** `'single'` for text values, `"double"` for identifiers (column/table names). Mixing them up is the most common beginner error.

### Try it 13.1

Using the staging Parquet file, find the latest value and date of every series whose `source` is `'boc'`. (Hint: `arg_max(value, date)` from Day 11.)

<details>
<summary>Solution</summary>

```sql
SELECT name,
       arg_max(value, date) AS latest_value,
       MAX(date)            AS latest_date
FROM 'data/staging/observations.parquet'
WHERE source = 'boc'
GROUP BY name
ORDER BY name;
```

</details>

---

## 13.2 Taming Messy CSVs (30 min)

### Case 1 — Raw BoC files with text values (from Day 4)

```sql
DESCRIBE SELECT * FROM 'data/boc_overnight.csv';
```

If any row contains text such as `Bank holiday`, the `value` column is detected as `VARCHAR`. Clean it with `TRY_CAST`, the SQL version of Day 5's `pd.to_numeric(errors="coerce")`:

```sql
SELECT CAST(date AS DATE)          AS date,
       TRY_CAST(value AS DOUBLE)   AS overnight_rate
FROM read_csv('data/boc_overnight.csv', all_varchar = true)
WHERE TRY_CAST(value AS DOUBLE) IS NOT NULL
ORDER BY date DESC
LIMIT 5;
```

`all_varchar = true` reads every column as text, so nothing is guessed wrongly. You then convert each column deliberately. For raw layers, this "read everything as text, cast explicitly" approach is the safest pattern.

### Case 2 — Telling DuckDB the types yourself

```sql
SELECT *
FROM read_csv('data/boc_cad_usd.csv',
              header  = true,
              columns = {'date': 'DATE', 'value': 'VARCHAR'})
LIMIT 5;
```

### Case 3 — FRED's changing headers

The FRED CSV's first column may be `DATE` or `observation_date`, and the value column is named after the series. Rename columns by position with a table alias:

```sql
SELECT date, TRY_CAST(value AS DOUBLE) AS fed_funds
FROM read_csv('data/fred_fedfunds.csv', all_varchar = true) AS t(date, value)
ORDER BY date DESC
LIMIT 5;
```

`AS t(date, value)` renames the columns in order. That's ρ from Day 12, and the same trick as `df.columns = ["date", ...]` in the notebook's `fred_fetch`.

### Case 4 — Many files at once with glob patterns

Day 10 saved one raw file per fetch under `data/raw/fred/<SERIES>/<timestamp>.csv`. A **glob** (`*`) reads them all, and `filename = true` records where each row came from:

```sql
SELECT filename, COUNT(*) AS n_rows
FROM read_csv('data/raw/fred/*/*.csv', all_varchar = true,
              union_by_name = true, filename = true)
GROUP BY filename
ORDER BY filename;
```

`union_by_name = true` lets files with different column names be stacked, like `UNION ALL BY NAME` from Day 12.

### Case 5 — The full StatCan CPI table (1M+ rows)

```sql
SELECT COUNT(*) FROM 'data/raw/statcan/18100004/18100004.csv';

DESCRIBE SELECT * FROM 'data/raw/statcan/18100004/18100004.csv';

SELECT CAST(REF_DATE || '-01' AS DATE) AS month,
       GEO                            AS geo,
       "Products and product groups"  AS component,
       VALUE                          AS cpi
FROM 'data/raw/statcan/18100004/18100004.csv'
WHERE GEO IN ('Canada', 'Ontario', 'Quebec', 'British Columbia', 'Alberta')
  AND "Products and product groups" = 'All-items'
  AND REF_DATE >= '2020-01'
ORDER BY month DESC, geo
LIMIT 10;
```

Note the `.timer` output: DuckDB scans over a million rows in a fraction of a second.

`REF_DATE || '-01'` joins text together (`||` is SQL's string concatenation), turning `'2026-07'` into `'2026-07-01'` so it can be cast to a `DATE`.

> If the first column name looks odd (e.g. `"﻿REF_DATE"`), the file has a hidden byte-order mark (BOM). That's the same issue the notebook fixes with `encoding="utf-8-sig"`. Recent DuckDB versions handle it automatically. If yours doesn't, run `DESCRIBE` and copy the exact column name in double quotes.

### Speed comparison with pandas (optional, 5 min)

Create `day13/speed_test.py`:

```python
import time
import duckdb
import pandas as pd

PATH = "data/raw/statcan/18100004/18100004.csv"

t0 = time.perf_counter()
df = pd.read_csv(PATH, low_memory=False, encoding="utf-8-sig")
df.columns = df.columns.str.strip()
out_pd = df[(df["GEO"] == "Canada") &
            (df["Products and product groups"] == "All-items")]
print(f"pandas: {time.perf_counter() - t0:.2f}s, {len(out_pd)} rows")

t0 = time.perf_counter()
out_db = duckdb.sql(f"""
    SELECT * FROM '{PATH}'
    WHERE GEO = 'Canada' AND "Products and product groups" = 'All-items'
""").df()
print(f"duckdb: {time.perf_counter() - t0:.2f}s, {len(out_db)} rows")
```

```bash
python day13/speed_test.py
```

DuckDB reads only the columns and rows it needs and uses all CPU cores, while pandas loads everything into memory first.

---

## 13.3 Parquet: Columnar Storage (23 min)

### Row-oriented vs column-oriented

```
CSV (row by row)                         Parquet (column by column)
2026-06-01,V39079,2.25,boc               date:      2026-06-01, 2026-07-01, ...
2026-07-01,V39079,2.25,boc               series_id: V39079, V39079, ...
...                                      value:     2.25, 2.25, ...
                                         source:    boc, boc, ...
```

Analytical queries usually touch **few columns but many rows** (e.g. the average of `value`). Parquet lets DuckDB read only those columns, and similar values stored together compress extremely well. Parquet also stores the **types**, so dates stay dates.

### Example 1 — Inspecting a Parquet file

```sql
SELECT * FROM parquet_schema('data/staging/observations.parquet');
SELECT row_group_id, num_values, compression
FROM parquet_metadata('data/staging/observations.parquet')
LIMIT 5;
```

### Example 2 — Writing Parquet with `COPY`

Convert the cleaned national CPI to Parquet and compare file sizes:

```sql
COPY (
    SELECT CAST(REF_DATE || '-01' AS DATE)  AS month,
           GEO                             AS geo,
           "Products and product groups"   AS component,
           VALUE                           AS cpi
    FROM 'data/raw/statcan/18100004/18100004.csv'
    WHERE VALUE IS NOT NULL
) TO 'data/staging/cpi_all.parquet' (FORMAT parquet);
```

```bash
ls -lh data/raw/statcan/18100004/18100004.csv data/staging/cpi_all.parquet
```

The Parquet file is typically many times smaller.

### Example 3 — Partitioned output

Large datasets are often split into folders by a key column, called **partitioning**:

```sql
COPY (SELECT * FROM 'data/staging/observations.parquet')
TO 'data/staging/observations_by_source'
(FORMAT parquet, PARTITION_BY (source), OVERWRITE_OR_IGNORE);
```

```bash
find data/staging/observations_by_source -name "*.parquet"
```

You'll see folders like `source=boc/`, `source=fred/`. Read them back, and DuckDB turns folder names into a column (**hive partitioning**):

```sql
SELECT source, COUNT(*)
FROM read_parquet('data/staging/observations_by_source/*/*.parquet',
                  hive_partitioning = true)
GROUP BY source;
```

Filtering on `source` now skips entire folders without opening them.

| Format | Use it for |
|---|---|
| CSV | exchanging with Excel/Stata, human inspection, raw downloads |
| Parquet | everything analytical: staging, marts, sharing between tools |
| DuckDB file | a persistent, queryable warehouse with many tables (next block) |

---

## 13.4 Persisting Data: Schemas, Tables and Views (20 min)

Querying files is great for exploration. For a reliable pipeline we build a **warehouse**: one DuckDB file with organised, named tables.

### Schemas: folders for tables

We'll use a layered structure that mirrors the rest of the course:

| Schema | Contains | Built on |
|---|---|---|
| `raw` | data as extracted, minimal changes | Days 10, 13 |
| `staging` | cleaned, typed, renamed | Days 14–20, dbt |
| `marts` | analysis-ready tables | Days 38–40 |

### Setting up

Create `sql/01_schemas.sql`:

```sql
CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS staging;
CREATE SCHEMA IF NOT EXISTS marts;
```

Create `sql/02_raw_tables.sql`:

```sql
-- Long observations from the Day 10 pipeline
CREATE OR REPLACE TABLE raw.observations AS
SELECT * FROM 'data/staging/observations.parquet';

-- Full StatCan CPI, national and provincial, all components
CREATE OR REPLACE TABLE raw.statcan_cpi AS
SELECT CAST(REF_DATE || '-01' AS DATE)  AS month,
       GEO                             AS geo,
       "Products and product groups"   AS component,
       VALUE                           AS cpi
FROM 'data/raw/statcan/18100004/18100004.csv'
WHERE VALUE IS NOT NULL;
```

Open the warehouse and run both files:

```bash
duckdb macro.duckdb
```

```sql
.mode box
.read sql/01_schemas.sql
.read sql/02_raw_tables.sql
.tables
SELECT COUNT(*) FROM raw.observations;
SELECT COUNT(*) FROM raw.statcan_cpi;
```

`CREATE TABLE ... AS SELECT` (often shortened to **CTAS**) creates and fills a table in one step.

### Tables vs views

A **table** stores data. A **view** stores a *query* and runs it every time you select from it.

```sql
CREATE OR REPLACE VIEW staging.policy_rates AS
SELECT date, name, value
FROM raw.observations
WHERE name IN ('overnight_rate', 'fed_funds');

SELECT name, COUNT(*), MAX(date) FROM staging.policy_rates GROUP BY name;
```

| | Table | View |
|---|---|---|
| Storage | uses disk | almost none |
| Freshness | as of when it was built | always current |
| Speed | fast to query | recomputed each time |

dbt calls this choice a **materialisation** (Days 31–33). You're already making it.

### Appending new data with `INSERT INTO ... SELECT`

```sql
INSERT INTO raw.observations
SELECT * FROM 'data/staging/observations.parquet'
WHERE date > (SELECT MAX(date) FROM raw.observations);
```

This is a simple **incremental load**: add only rows newer than what you have. Think about what could go wrong here (revisions to old values? a series that lags the others?). `dlt` handles these cases properly on Days 24–27.

> **One writer at a time:** a DuckDB file can be opened for writing by only one process. If Python reports that the database is locked, `.quit` your CLI session first.

---

## 13.5 DuckDB from Python (18 min)

Everything you've done in the CLI works from Python, and DuckDB and pandas exchange data effortlessly. Create `day13/duck_python.py`.

### Example 1 — Querying and getting a DataFrame back

```python
import duckdb

con = duckdb.connect("macro.duckdb", read_only=True)

df = con.sql("""
    SELECT name, COUNT(*) AS n, MAX(date) AS latest
    FROM raw.observations
    GROUP BY name
    ORDER BY name
""").df()                     # .df() converts the result to pandas

print(df)
```

### Example 2 — Parameters: never paste values into SQL strings

```python
series_name = "overnight_rate"

rates = con.execute(
    "SELECT date, value FROM raw.observations WHERE name = ? ORDER BY date",
    [series_name],
).df()
print(rates.tail())
```

The `?` placeholder is filled safely by DuckDB. Building SQL with f-strings from user input invites errors and *SQL injection*, a classic security hole.

### Example 3 — SQL on a pandas DataFrame

DuckDB can query a DataFrame **by its Python variable name**:

```python
import pandas as pd

provinces = pd.DataFrame({
    "province": ["BC", "AB", "SK", "ON", "QC"],
    "balance_pct_gdp": [-0.8, 0.2, 0.5, -1.4, -1.2],
})

print(duckdb.sql("""
    SELECT province, balance_pct_gdp
    FROM provinces
    WHERE balance_pct_gdp < 0
    ORDER BY balance_pct_gdp
""").df())
```

Use whichever tool expresses each step more clearly. Many analysts do heavy filtering and joining in SQL, then modelling and plotting in pandas.

### Example 4 — Rebuilding a Day 7 series in SQL

```python
cpi_yoy_input = con.sql("""
    SELECT month, cpi
    FROM raw.statcan_cpi
    WHERE geo = 'Canada' AND component = 'All-items'
    ORDER BY month
""").df().set_index("month")["cpi"]

yoy = cpi_yoy_input.pct_change(12) * 100
print(f"Latest CPI YoY: {yoy.iloc[-1]:.1f}%")
con.close()
```

Computing the YoY change *inside* SQL needs window functions. That's the first topic on Day 14.

---

## 13.6 Capstone: `load_warehouse.py` (20 min)

Build a script that anyone can run to recreate the warehouse from scratch, reusing your SQL files.

**Requirements:**
1. Connect to `macro.duckdb` (read-write).
2. Run `sql/01_schemas.sql` and `sql/02_raw_tables.sql`.
3. Create `raw.dim_series` from the Day 10 `CATALOG` (a pandas DataFrame, Example 3 style).
4. Run quality checks in SQL (put them in `sql/03_checks.sql` or in Python):
   - no duplicate `(series_id, date)` in `raw.observations`;
   - no orphan `series_id` in `raw.observations` missing from `raw.dim_series` (anti-join, Day 12);
   - policy rates between −1 and 25.
5. Print a summary table of row counts per table.
6. Exit with a non-zero code if any check fails (Day 10).

<details>
<summary>Solution</summary>

```python
"""load_warehouse.py — (re)build macro.duckdb from raw files.

Run from the repository root:  python load_warehouse.py
"""
import sys
from pathlib import Path

import duckdb
import pandas as pd

from macro_extract.catalog import CATALOG

DB = "macro.duckdb"
SQL_DIR = Path("sql")


def run_sql_file(con, path):
    print(f"→ running {path}")
    con.execute(path.read_text())


CHECKS = {
    "duplicate (series_id, date) rows": """
        SELECT COUNT(*) FROM (
            SELECT series_id, date FROM raw.observations
            GROUP BY ALL HAVING COUNT(*) > 1
        )
    """,
    "observations with no matching series": """
        SELECT COUNT(*) FROM raw.observations
        ANTI JOIN raw.dim_series USING (series_id)
    """,
    "policy rates outside [-1, 25]": """
        SELECT COUNT(*) FROM raw.observations
        WHERE name IN ('overnight_rate', 'fed_funds')
          AND (value < -1 OR value > 25)
    """,
}


def main():
    con = duckdb.connect(DB)

    run_sql_file(con, SQL_DIR / "01_schemas.sql")
    run_sql_file(con, SQL_DIR / "02_raw_tables.sql")

    dim_series = pd.DataFrame(CATALOG, columns=["source", "series_id", "name"])
    con.execute("CREATE OR REPLACE TABLE raw.dim_series AS SELECT * FROM dim_series")
    print(f"→ raw.dim_series: {len(dim_series)} series")

    failures = 0
    print("\nQuality checks:")
    for label, sql in CHECKS.items():
        n = con.execute(sql).fetchone()[0]
        status = "✓" if n == 0 else "✗"
        print(f"  {status} {label}: {n}")
        failures += n > 0

    print("\nTable sizes:")
    print(con.sql("""
        SELECT table_schema || '.' || table_name AS table_name,
               estimated_size                   AS approx_rows
        FROM duckdb_tables()
        ORDER BY table_name
    """).df().to_string(index=False))

    con.close()
    if failures:
        print(f"\n{failures} check(s) failed.")
        sys.exit(1)
    print("\n✓ Warehouse built successfully.")


if __name__ == "__main__":
    main()
```

`con.execute(...)` runs a file with several statements separated by semicolons. `fetchone()[0]` pulls the single number out of a one-cell result.

</details>

Run it (close any open CLI session on `macro.duckdb` first):

```bash
python load_warehouse.py
```

Then explore the result in the CLI:

```bash
duckdb macro.duckdb -readonly
```

```sql
.tables
SELECT * FROM raw.dim_series;
SELECT o.name, d.source, COUNT(*) AS n
FROM raw.observations AS o JOIN raw.dim_series AS d USING (series_id)
GROUP BY ALL;
```

### Stretch goals

- Add `raw.statcan_gdp` from `data/statcan_gdp.csv` to `02_raw_tables.sql`.
- Add a check that every monthly series has **no missing months** in 2018–2024. (Hint: generate the expected months with `SELECT * FROM range(DATE '2018-01-01', DATE '2025-01-01', INTERVAL 1 MONTH)` and anti-join.)
- Chain the whole pipeline: `python run_extract.py && python load_warehouse.py`. The `&&` runs the second command only if the first succeeds, which is why exit codes matter.

### Recap: the pipeline so far

```
APIs (BoC, FRED, StatCan)
   │  python run_extract.py          ← Days 8–10
   ▼
data/raw/…  +  data/staging/observations.parquet
   │  python load_warehouse.py       ← Day 13
   ▼
macro.duckdb   raw.*  (staging.*, marts.* coming soon)
```

### Looking ahead: Days 14–17

Next you'll compute YoY inflation, moving averages and running peaks **inside SQL** with window functions:

```sql
SELECT month, cpi,
       100 * (cpi / LAG(cpi, 12) OVER (ORDER BY month) - 1) AS yoy
FROM raw.statcan_cpi
WHERE geo = 'Canada' AND component = 'All-items';
```

You'll also structure longer queries with Common Table Expressions (`WITH ...`), the SQL counterpart of breaking code into named steps.

### Day 13 checklist
- [ ] I can query CSV and Parquet files directly and inspect them with `DESCRIBE` and `SUMMARIZE`
- [ ] I clean messy CSVs with `all_varchar`, explicit column types, `TRY_CAST` and positional renaming
- [ ] I can read many files at once with glob patterns
- [ ] I understand why Parquet is faster and smaller, and can write partitioned Parquet
- [ ] I organise a warehouse into `raw`, `staging` and `marts` schemas and choose between tables and views
- [ ] I can use DuckDB from Python with parameters and pass DataFrames both ways
- [ ] One command rebuilds and validates my warehouse

```bash
git add .
git status            # macro.duckdb and data/ should NOT be listed
git commit -m "Day 13: loading CSV/Parquet, warehouse build script"
git push
```
