# Module 2 · Analytical SQL with DuckDB
## Days 18–20: Staging CPI & GDP — Growth Rates and Moving Averages in SQL

**Audience:** MSc Economics students who completed Days 1–17
**Environment:** GitHub Codespaces · DuckDB CLI · `macro.duckdb` warehouse
**Time per day:** ~2.5 hours (including breaks and exercises)
**Goal by end of Day 20:** Students turn raw Statistics Canada tables into a documented, tested, layered warehouse with `raw → staging → intermediate → marts` layers. It produces monthly inflation measures and quarterly GDP growth, computed and validated entirely in SQL, and rebuilt with one command. This closes Module 2 and sets up dlt (Module 3) and dbt (Module 4).

---

### Where we are

| Layer | What you have after Day 17 |
|---|---|
| `raw` | `observations`, `statcan_cpi` (4 columns), `dim_series`, `boc_decisions` |
| `scratch` | `monthly_long`, `monthly_wide` (experimental views) |
| `marts` | `policy_cycles` |

You already know every SQL technique needed. These three days are about **engineering discipline**: layers with clear jobs, naming conventions, documentation, automated tests, and correct economics (base effects, publication lags, chained dollars, annualisation).

### The layered architecture we're building

```
raw.*             exactly as downloaded (all text), nothing removed
   │
staging.stg_*     one view per source table: rename, cast, standardise; no economics
   │
intermediate.int_*  reusable economic building blocks: growth rates, smoothing
   │
marts.*           analysis-ready tables for dashboards, forecasting, causal work
```

This is the structure dbt formalises on Days 34–37. Building it by hand first means you'll understand what dbt automates.

### Naming conventions (dbt-style, used from now on)

| Pattern | Example | Meaning |
|---|---|---|
| `stg_<source>__<entity>` | `stg_statcan__cpi` | staging view for one source table |
| `int_<entity>__<verb/what>` | `int_cpi__growth` | intermediate building block |
| `seed_<name>` | `seed_geo` | small hand-maintained reference table |
| mart names: plain nouns | `macro_monthly` | final product |

Note the **double underscore** between source and entity.

### Target file layout (by end of Day 20)

```
sql/
├── 01_schemas.sql
├── 02_raw_tables.sql
├── 02b_boc_decisions.sql
├── 03_seeds.sql
├── 10_stg_statcan__cpi.sql
├── 11_stg_statcan__gdp.sql
├── 12_stg_macro__observations.sql
├── 20_int_cpi__growth.sql
├── 21_int_cpi__national_measures.sql
├── 22_int_gdp__growth.sql
├── 23_int_rates__monthly.sql
├── 30_macro_monthly.sql
├── 31_macro_quarterly.sql
├── 32_policy_cycles.sql          ← renamed from Day 17's 04_policy_cycles.sql
└── tests/
    ├── cpi_unique_keys.sql
    ├── cpi_no_gaps_core.sql
    └── ...
load_warehouse.py                 ← runs every sql/*.sql in order
run_tests.py                      ← runs every sql/tests/*.sql
pipeline.sh                       ← extract → load → test
```

Numbered prefixes make files run in dependency order when sorted. Rename Day 17's mart file now:

```bash
git mv sql/04_policy_cycles.sql sql/32_policy_cycles.sql
```

---

# DAY 18 — The Staging Layer: CPI

| Time | Block |
|---|---|
| 0:00 – 0:20 | 18.1 What staging is (and isn't) |
| 0:20 – 0:45 | 18.2 A proper raw layer: keep everything, as text |
| 0:45 – 0:53 | Break |
| 0:53 – 1:15 | 18.3 Profiling the raw CPI table |
| 1:15 – 1:40 | 18.4 Seeds: small reference tables |
| 1:40 – 1:48 | Break |
| 1:48 – 2:08 | 18.5 Building `staging.stg_statcan__cpi` |
| 2:08 – 2:30 | 18.6 Tests as queries · a test runner |

---

## 18.1 What Staging Is (and Isn't) (20 min)

A staging model is a **clean, faithful copy** of one source table. Its job is to make the data *easy and safe to use*, not to answer economic questions.

| Staging **does** | Staging **does not** |
|---|---|
| rename columns to `snake_case` | compute growth rates |
| cast text to proper types | join different sources |
| parse dates (`'2026-07'` → `DATE`) | aggregate to other frequencies |
| standardise units and labels | filter to "the series I need today" |
| attach reference data (e.g. province codes) | apply judgement (seasonal choices, trimming) |
| drop genuinely unusable rows, **documented** | |

Why be so strict? Because many downstream models will depend on staging. If a staging view quietly keeps only national data, the provincial analysis someone builds next month silently breaks. **Keep staging general; put decisions downstream.**

> **Grain.** Every model must state what one row represents. The grain of `stg_statcan__cpi` is *one row per month × geography × product group*.

---

## 18.2 A Proper Raw Layer: Keep Everything, as Text (25 min)

On Day 13, `raw.statcan_cpi` already renamed and filtered columns. That's staging work done too early. A professional raw layer keeps **every column exactly as delivered**, read as text so nothing is mis-parsed.

### Make sure you have both full tables

CPI was unzipped on Day 13. Download and unzip GDP (table 36-10-0104) with the Day 10 helper:

```bash
python - <<'EOF'
import sys
sys.path.insert(0, "day10")
from statcan_tables import download_table
import requests
download_table("36100104", requests.Session())
EOF
mkdir -p data/raw/statcan/36100104
unzip -o data/raw/statcan/36100104.zip -d data/raw/statcan/36100104
ls data/raw/statcan/*/
```

(`python - <<'EOF' ... EOF` runs a short Python snippet straight from the terminal.)

### Add full raw tables

Append to `sql/02_raw_tables.sql`:

```sql
-- Full StatCan tables, every column, all text. Grain = source file rows.
CREATE OR REPLACE TABLE raw.statcan_cpi_full AS
SELECT * FROM read_csv('data/raw/statcan/18100004/18100004.csv',
                       header = true, all_varchar = true);

CREATE OR REPLACE TABLE raw.statcan_gdp_full AS
SELECT * FROM read_csv('data/raw/statcan/36100104/36100104.csv',
                       header = true, all_varchar = true);
```

Run it in the CLI:

```bash
duckdb macro.duckdb
```

```sql
.mode box
.read sql/02_raw_tables.sql
DESCRIBE raw.statcan_cpi_full;
```

You'll see columns you haven't used yet:

| Column | Meaning | Why keep it |
|---|---|---|
| `UOM` | unit of measure, e.g. `2002=100` | tells you the index base |
| `SCALAR_FACTOR` | `units`, `thousands`, `millions` | essential for GDP levels |
| `VECTOR` | the series ID (Day 10) | a stable key across downloads |
| `STATUS` | data-quality flag (e.g. `E` = use with caution, `..` = not available) | quality awareness |
| `TERMINATED` | `t` if the series is discontinued | avoid dead series |
| `DECIMALS` | published precision | how to round for display |

> If `DESCRIBE` shows the first column with an odd prefix (a hidden byte-order mark, Day 13), note its exact name and use it in double quotes in the staging view.

---

## 18.3 Profiling the Raw CPI Table (23 min)

Before writing staging logic, **profile**: understand what's really in the data. Create `day18/profile_cpi.sql`.

```sql
-- How big, how old?
SELECT COUNT(*) AS n_rows, MIN(REF_DATE) AS first, MAX(REF_DATE) AS last
FROM raw.statcan_cpi_full;

-- Which geographies?
SELECT GEO, COUNT(*) AS n_rows
FROM raw.statcan_cpi_full
GROUP BY GEO
ORDER BY n_rows DESC;

-- Which index bases?
SELECT UOM, COUNT(*) AS n_rows
FROM raw.statcan_cpi_full
GROUP BY UOM;

-- Quality flags
SELECT STATUS, COUNT(*) AS n_rows
FROM raw.statcan_cpi_full
GROUP BY STATUS
ORDER BY n_rows DESC;

-- Values that won't convert to numbers
SELECT VALUE, COUNT(*) AS n_rows
FROM raw.statcan_cpi_full
WHERE TRY_CAST(VALUE AS DOUBLE) IS NULL
GROUP BY VALUE;

-- Discontinued series
SELECT COUNT(DISTINCT VECTOR) AS terminated_series
FROM raw.statcan_cpi_full
WHERE TERMINATED = 't';

-- How many product groups? (There are many more than the headline aggregates.)
SELECT COUNT(DISTINCT "Products and product groups") FROM raw.statcan_cpi_full;
```

### Try it 18.3

Answer with queries:
(a) Which geographies are **cities** rather than provinces? (Hint: city names contain a comma, e.g. `'Toronto, Ontario'`.)
(b) For `GEO = 'Canada'`, how many product groups have data for the latest month?
(c) Is `(REF_DATE, GEO, product group)` unique in the raw table?

<details>
<summary>Solution</summary>

```sql
-- (a)
SELECT DISTINCT GEO FROM raw.statcan_cpi_full WHERE GEO LIKE '%,%' ORDER BY GEO;

-- (b)
SELECT COUNT(DISTINCT "Products and product groups")
FROM raw.statcan_cpi_full
WHERE GEO = 'Canada'
  AND REF_DATE = (SELECT MAX(REF_DATE) FROM raw.statcan_cpi_full)
  AND TRY_CAST(VALUE AS DOUBLE) IS NOT NULL;

-- (c) Zero rows means unique
SELECT REF_DATE, GEO, "Products and product groups", COUNT(*) AS n
FROM raw.statcan_cpi_full
GROUP BY ALL
HAVING COUNT(*) > 1
LIMIT 5;
```

If (c) returns rows, look at their `UOM`: some series are published on more than one base period, and the key must then include the base. **Profiling tells you what the key really is.** Don't assume it.

</details>

---

## 18.4 Seeds: Small Reference Tables (25 min)

Some information doesn't come from any API: province codes, the notebook's recession dates, CPI basket weights. dbt calls these hand-maintained tables **seeds**. We'll keep them in `sql/03_seeds.sql`, in a dedicated schema so they're easy to find.

```sql
-- sql/03_seeds.sql — hand-maintained reference tables
CREATE SCHEMA IF NOT EXISTS seeds;

-- Grain: one row per geography used in national/provincial analysis
CREATE OR REPLACE TABLE seeds.seed_geo (
    geo        VARCHAR PRIMARY KEY,
    geo_code   VARCHAR NOT NULL,
    geo_level  VARCHAR NOT NULL,
    region     VARCHAR
);
INSERT INTO seeds.seed_geo VALUES
    ('Canada',                    'CA', 'national', NULL),
    ('Newfoundland and Labrador', 'NL', 'province', 'Atlantic'),
    ('Prince Edward Island',      'PE', 'province', 'Atlantic'),
    ('Nova Scotia',               'NS', 'province', 'Atlantic'),
    ('New Brunswick',             'NB', 'province', 'Atlantic'),
    ('Quebec',                    'QC', 'province', 'Central'),
    ('Ontario',                   'ON', 'province', 'Central'),
    ('Manitoba',                  'MB', 'province', 'Prairies'),
    ('Saskatchewan',              'SK', 'province', 'Prairies'),
    ('Alberta',                   'AB', 'province', 'West'),
    ('British Columbia',          'BC', 'province', 'West');

-- Grain: one row per recession band, as defined in the course notebook
CREATE OR REPLACE TABLE seeds.seed_recession_bands (
    label       VARCHAR PRIMARY KEY,
    start_date  DATE NOT NULL,
    end_date    DATE NOT NULL,
    CHECK (end_date >= start_date)
);
INSERT INTO seeds.seed_recession_bands VALUES
    ('GFC',              '2008-10-01', '2009-06-30'),
    ('Oil shock',        '2015-01-01', '2015-09-30'),
    ('COVID',            '2020-02-01', '2020-06-30'),
    ('Tariff recession', '2025-10-01', '2026-03-31');

-- Grain: one row per major CPI component.
-- Weights (%) as used in the course notebook's Module 05. Illustrative only:
-- official basket weights are published in StatCan table 18-10-0007-01.
-- 'Energy' is omitted because it overlaps Shelter and Transportation.
CREATE OR REPLACE TABLE seeds.seed_cpi_weights (
    component  VARCHAR PRIMARY KEY,
    weight_pct DOUBLE NOT NULL CHECK (weight_pct > 0 AND weight_pct < 100)
);
INSERT INTO seeds.seed_cpi_weights VALUES
    ('Shelter',                                          29.0),
    ('Transportation',                                   16.0),
    ('Food',                                             15.9),
    ('Household operations, furnishings and equipment',  14.0),
    ('Recreation, education and reading',                10.4),
    ('Health and personal care',                          5.4),
    ('Clothing and footwear',                             5.0);
```

Run it with `.read sql/03_seeds.sql`, then add the schema to `sql/01_schemas.sql`:

```sql
CREATE SCHEMA IF NOT EXISTS seeds;
CREATE SCHEMA IF NOT EXISTS intermediate;
```

> **Seeds are code.** Because they live in a `.sql` file in Git, every change to a weight or a recession date is versioned and reviewable. That's much better than a spreadsheet on someone's desktop.

### Documenting tables inside the database

DuckDB stores comments with your tables so the documentation travels with the data:

```sql
COMMENT ON TABLE seeds.seed_cpi_weights IS
    'Illustrative CPI weights from the course notebook; see StatCan 18-10-0007-01 for official weights.';

SELECT schema_name, table_name, comment
FROM duckdb_tables()
WHERE comment IS NOT NULL;
```

---

## 18.5 Building `staging.stg_statcan__cpi` (20 min)

Create `sql/10_stg_statcan__cpi.sql`. Notice the structure, which you'll reuse for every staging model: **source → renamed → final**.

```sql
-- staging.stg_statcan__cpi
-- Source:  raw.statcan_cpi_full (StatCan table 18-10-0004-01, CPI, monthly, NSA)
-- Grain:   one row per month × geography × product group
-- Notes:   rows without a numeric value are dropped (not available / suppressed).
--          Terminated series are kept but flagged.

CREATE OR REPLACE VIEW staging.stg_statcan__cpi AS
WITH source AS (
    SELECT * FROM raw.statcan_cpi_full
),

renamed AS (
    SELECT
        CAST(REF_DATE || '-01' AS DATE)          AS month,
        GEO                                      AS geo,
        "Products and product groups"            AS component,
        VECTOR                                   AS vector_id,
        UOM                                      AS index_base,
        TRY_CAST(VALUE AS DOUBLE)                AS cpi,
        NULLIF(TRIM(STATUS), '')                 AS status_flag,
        COALESCE(TERMINATED = 't', false)        AS is_terminated
    FROM source
)

SELECT r.month,
       r.geo,
       g.geo_code,
       COALESCE(g.geo_level, 'city')             AS geo_level,
       r.component,
       r.vector_id,
       r.index_base,
       r.cpi,
       r.status_flag,
       r.is_terminated
FROM renamed AS r
LEFT JOIN seeds.seed_geo AS g USING (geo)
WHERE r.cpi IS NOT NULL;

COMMENT ON VIEW staging.stg_statcan__cpi IS
    'CPI (18-10-0004-01), typed. Grain: month × geo × component. NSA.';
```

Run and inspect:

```sql
.read sql/10_stg_statcan__cpi.sql
DESCRIBE staging.stg_statcan__cpi;

SELECT geo_level, COUNT(DISTINCT geo) AS n_geos, COUNT(*) AS n_rows
FROM staging.stg_statcan__cpi
GROUP BY geo_level;

SELECT * FROM staging.stg_statcan__cpi
WHERE geo_code = 'CA' AND component = 'All-items'
ORDER BY month DESC
LIMIT 3;
```

Why is this a **view** and not a table? Staging is cheap to recompute from raw, and views never go stale. You'll materialise tables at the mart level.

---

## 18.6 Tests as Queries · A Test Runner (23 min)

Here's a simple and powerful convention, the one dbt uses: **a test is a query that returns the rows that violate a rule. Zero rows = pass.**

Create the folder `sql/tests/` and add these files. The first line of each file declares its **severity**:
- `error`: the pipeline should stop
- `warn`: report it but continue

**`sql/tests/cpi_unique_keys.sql`**

```sql
-- severity: error
-- Each month × geo × component × base must appear once
SELECT month, geo, component, index_base, COUNT(*) AS n
FROM staging.stg_statcan__cpi
GROUP BY ALL
HAVING COUNT(*) > 1
```

**`sql/tests/cpi_positive_values.sql`**

```sql
-- severity: error
SELECT * FROM staging.stg_statcan__cpi WHERE cpi <= 0
```

**`sql/tests/cpi_no_gaps_core.sql`**

```sql
-- severity: error
-- National and provincial All-items series must have no missing months.
-- A series spanning N months from first to last must have exactly N rows.
SELECT geo, component,
       MIN(month) AS first_month,
       MAX(month) AS last_month,
       date_diff('month', MIN(month), MAX(month)) + 1 AS expected_rows,
       COUNT(*)                                       AS actual_rows
FROM staging.stg_statcan__cpi
WHERE geo_level IN ('national', 'province')
  AND component = 'All-items'
GROUP BY geo, component
HAVING date_diff('month', MIN(month), MAX(month)) + 1 <> COUNT(*)
```

That's a gap test without building a calendar spine: if there are no gaps, the count equals the number of months between first and last.

**`sql/tests/cpi_freshness.sql`**

```sql
-- severity: warn
-- The latest national CPI should be at most 3 months old
SELECT MAX(month) AS latest_month
FROM staging.stg_statcan__cpi
WHERE geo_code = 'CA' AND component = 'All-items'
HAVING MAX(month) < CAST(current_date - INTERVAL 3 MONTH AS DATE)
```

> Don't end test files with a semicolon. The runner wraps each query inside another query.

### The test runner: `run_tests.py` (repository root)

```python
"""run_tests.py — run every sql/tests/*.sql against macro.duckdb.

A test passes when its query returns zero rows.
The first line '-- severity: error|warn' controls whether a failure stops the pipeline.
"""
import sys
from pathlib import Path

import duckdb

TEST_DIR = Path("sql/tests")


def severity_of(sql_text):
    first = sql_text.strip().splitlines()[0].lower()
    return "warn" if "severity: warn" in first else "error"


def main():
    con = duckdb.connect("macro.duckdb", read_only=True)
    errors = warnings = 0

    for path in sorted(TEST_DIR.glob("*.sql")):
        sql = path.read_text().strip().rstrip(";")
        severity = severity_of(sql)
        try:
            n = con.execute(f"SELECT COUNT(*) FROM ({sql}) AS t").fetchone()[0]
        except Exception as e:
            print(f"  ✗ ERROR  {path.stem}: query failed — {e}")
            errors += 1
            continue

        if n == 0:
            print(f"  ✓ pass   {path.stem}")
        elif severity == "warn":
            print(f"  ! warn   {path.stem}: {n} row(s)")
            warnings += 1
        else:
            print(f"  ✗ FAIL   {path.stem}: {n} row(s)")
            errors += 1

    con.close()
    print(f"\n{errors} error(s), {warnings} warning(s)")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
```

```bash
.quit                      # leave the CLI first (one writer at a time)
python run_tests.py
```

When a test fails, investigate with the **same query** in the CLI; it shows you exactly which rows break the rule.

### Day 18 checklist
- [ ] I can explain what belongs in staging and what doesn't
- [ ] My raw layer keeps every source column, as text
- [ ] I profile a table before modelling it, and verify its real key
- [ ] I maintain reference data as versioned seeds, with comments in the database
- [ ] My staging view follows source → renamed → final and states its grain
- [ ] My tests are queries returning violations, run automatically with severities

```bash
git add .
git commit -m "Day 18: raw full tables, seeds, stg_statcan__cpi, SQL tests"
git push
```

---

# DAY 19 — Intermediate Models: Inflation Measures in SQL

| Time | Block |
|---|---|
| 0:00 – 0:30 | 19.1 `int_cpi__growth`: gap-safe growth rates for every series |
| 0:30 – 0:50 | 19.2 Smoothing: moving averages and acceleration |
| 0:50 – 0:58 | Break |
| 0:58 – 1:20 | 19.3 Base effects: what next month's inflation will do mechanically |
| 1:20 – 1:43 | 19.4 Core measures, median and diffusion |
| 1:43 – 1:50 | Break |
| 1:50 – 2:10 | 19.5 Contributions to headline inflation |
| 2:10 – 2:30 | 19.6 Mini-project: `int_cpi__national_measures` + tests |

---

## 19.1 `int_cpi__growth`: Gap-Safe Growth Rates (30 min)

On Day 15 you had two choices: `LAG(cpi, 12)` (fast, but wrong if a month is missing) or a self-join (safe, but heavier). Here's a third technique that gets both: **lag the date too, and only compute the rate when the lagged date is exactly right.**

Create `sql/20_int_cpi__growth.sql`:

```sql
-- intermediate.int_cpi__growth
-- Grain:  one row per month × geography × component (same as staging)
-- Adds:   mom, ann_3m, ann_6m, yoy (all %), each NULL unless the comparison
--         month is exactly 1/3/6/12 months earlier (gap-safe).

CREATE OR REPLACE VIEW intermediate.int_cpi__growth AS
WITH base AS (
    SELECT month, geo, geo_code, geo_level, component, cpi
    FROM staging.stg_statcan__cpi
    WHERE NOT is_terminated
),

lagged AS (
    SELECT *,
           LAG(cpi, 1)    OVER w AS cpi_l1,   LAG(month, 1)  OVER w AS month_l1,
           LAG(cpi, 3)    OVER w AS cpi_l3,   LAG(month, 3)  OVER w AS month_l3,
           LAG(cpi, 6)    OVER w AS cpi_l6,   LAG(month, 6)  OVER w AS month_l6,
           LAG(cpi, 12)   OVER w AS cpi_l12,  LAG(month, 12) OVER w AS month_l12
    FROM base
    WINDOW w AS (PARTITION BY geo, component ORDER BY month)
)

SELECT month, geo, geo_code, geo_level, component, cpi,
       CASE WHEN month_l1 = CAST(month - INTERVAL 1 MONTH AS DATE)
            THEN 100 * (cpi / cpi_l1 - 1) END                    AS mom,
       CASE WHEN month_l3 = CAST(month - INTERVAL 3 MONTH AS DATE)
            THEN 100 * (POWER(cpi / cpi_l3, 4) - 1) END          AS ann_3m,
       CASE WHEN month_l6 = CAST(month - INTERVAL 6 MONTH AS DATE)
            THEN 100 * (POWER(cpi / cpi_l6, 2) - 1) END          AS ann_6m,
       CASE WHEN month_l12 = CAST(month - INTERVAL 12 MONTH AS DATE)
            THEN 100 * (cpi / cpi_l12 - 1) END                   AS yoy
FROM lagged;
```

Understanding the annualisation exponents:

| Measure | Formula | Why |
|---|---|---|
| `mom` | (P<sub>t</sub>/P<sub>t−1</sub> − 1) | one month's change, not annualised |
| `ann_3m` | (P<sub>t</sub>/P<sub>t−3</sub>)<sup>4</sup> − 1 | four 3-month periods per year |
| `ann_6m` | (P<sub>t</sub>/P<sub>t−6</sub>)<sup>2</sup> − 1 | two 6-month periods per year |
| `yoy` | P<sub>t</sub>/P<sub>t−12</sub> − 1 | already a 12-month change |

> **Seasonality reminder:** table 18-10-0004 is **not seasonally adjusted**. `yoy` is robust to seasonality; `mom`, `ann_3m` and `ann_6m` are not. The BoC and StatCan publish seasonally adjusted series for short-horizon analysis. We keep NSA-based momentum here as a teaching tool and label it clearly in the marts.

### Check it against published figures

```sql
.read sql/01_schemas.sql
.read sql/20_int_cpi__growth.sql

SELECT month, cpi, ROUND(mom, 1) AS mom, ROUND(yoy, 1) AS yoy
FROM intermediate.int_cpi__growth
WHERE geo_code = 'CA' AND component = 'All-items'
ORDER BY month DESC
LIMIT 6;
```

StatCan computes published percentage changes from the **rounded** index levels, which is exactly what this table contains. So your `yoy` rounded to one decimal should match the Daily release precisely. Compare with the notebook's "Latest CPI YoY" printout too.

> **Round only for display.** Keep full precision in the models; round in the final `SELECT` of a report. Rounding early and then computing again compounds errors.

### Try it 19.1

Delete (in a CTE) the row for one mid-2024 month of national All-items and show that `yoy` for the month 12 months later becomes `NULL` instead of wrong.

<details>
<summary>Solution</summary>

```sql
WITH gappy AS (
    SELECT month, cpi
    FROM staging.stg_statcan__cpi
    WHERE geo_code = 'CA' AND component = 'All-items'
      AND month <> DATE '2024-06-01'
),
lagged AS (
    SELECT *, LAG(cpi, 12) OVER (ORDER BY month)   AS cpi_l12,
              LAG(month, 12) OVER (ORDER BY month) AS month_l12
    FROM gappy
)
SELECT month,
       100 * (cpi / cpi_l12 - 1) AS naive_yoy,
       CASE WHEN month_l12 = CAST(month - INTERVAL 12 MONTH AS DATE)
            THEN 100 * (cpi / cpi_l12 - 1) END AS safe_yoy
FROM lagged
WHERE month BETWEEN DATE '2025-05-01' AND DATE '2025-08-01'
ORDER BY month;
```

After the gap, `naive_yoy` silently compares with the wrong month (a 13-month change), while `safe_yoy` is `NULL`. A missing value you can see beats a wrong value you can't.

</details>

---

## 19.2 Smoothing: Moving Averages and Acceleration (20 min)

We layer smoothing on top of growth rates in a second view, keeping each model focused.

Add to `sql/20_int_cpi__growth.sql`:

```sql
-- intermediate.int_cpi__smoothed
-- Grain: month × geo × component. Adds moving averages of yoy and its 12-month change.
CREATE OR REPLACE VIEW intermediate.int_cpi__smoothed AS
SELECT *,
       CASE WHEN COUNT(yoy) OVER w3 = 3   THEN AVG(yoy) OVER w3  END AS yoy_ma3,
       CASE WHEN COUNT(yoy) OVER w12 = 12 THEN AVG(yoy) OVER w12 END AS yoy_ma12,
       CASE WHEN COUNT(mom) OVER w3 = 3   THEN AVG(mom) OVER w3  END AS mom_ma3,
       yoy - LAG(yoy, 12) OVER w_lag                                  AS yoy_change_12m
FROM intermediate.int_cpi__growth
WINDOW w_lag AS (PARTITION BY geo, component ORDER BY month),
       w3    AS (PARTITION BY geo, component ORDER BY month
                 RANGE BETWEEN INTERVAL 2 MONTH PRECEDING AND CURRENT ROW),
       w12   AS (PARTITION BY geo, component ORDER BY month
                 RANGE BETWEEN INTERVAL 11 MONTH PRECEDING AND CURRENT ROW);
```

Three techniques from Day 16 combine here:
- **`RANGE` with intervals**, so a window always covers the right calendar months;
- **`COUNT(...) = n`**, pandas' `min_periods`, so partial windows give `NULL`;
- **named windows**, keeping the definitions readable.

`yoy_change_12m` measures **acceleration**: is inflation higher or lower than a year ago, in percentage points?

```sql
SELECT month, ROUND(yoy, 1) AS yoy, ROUND(yoy_ma3, 2) AS ma3,
       ROUND(yoy_ma12, 2) AS ma12, ROUND(yoy_change_12m, 1) AS accel_pp
FROM intermediate.int_cpi__smoothed
WHERE geo_code = 'CA' AND component = 'All-items'
ORDER BY month DESC
LIMIT 6;
```

---

## 19.3 Base Effects (23 min)

Why does YoY inflation sometimes jump even when prices barely move this month? Because YoY also depends on what happened **a year ago**. That's the **base effect**.

Year-over-year inflation is (approximately) the sum of the last 12 monthly changes:

**yoy<sub>t</sub> ≈ mom<sub>t</sub> + mom<sub>t−1</sub> + … + mom<sub>t−11</sub>**

Next month, one new monthly change enters the window and the change from 12 months ago **drops out**. If a big increase drops out, YoY falls mechanically.

### A useful projection: next month's YoY if prices stay flat

If the index is unchanged next month (P<sub>t+1</sub> = P<sub>t</sub>), then:

**yoy<sub>t+1</sub> = P<sub>t</sub> / P<sub>t−11</sub> − 1**

Create `day19/base_effects.sql`:

```sql
WITH s AS (
    SELECT month, cpi, mom, yoy,
           LAG(cpi, 11) OVER w   AS cpi_l11,
           LAG(month, 11) OVER w AS month_l11,
           LAG(mom, 11) OVER w   AS mom_dropping_out     -- leaves the window next month
    FROM intermediate.int_cpi__growth
    WHERE geo_code = 'CA' AND component = 'All-items'
    WINDOW w AS (ORDER BY month)
)
SELECT month,
       ROUND(yoy, 1)                                          AS yoy,
       ROUND(mom_dropping_out, 2)                             AS mom_leaving_window,
       ROUND(CASE WHEN month_l11 = CAST(month - INTERVAL 11 MONTH AS DATE)
                  THEN 100 * (cpi / cpi_l11 - 1) END, 1)      AS next_yoy_if_flat
FROM s
ORDER BY month DESC
LIMIT 6;
```

How to read it: if `next_yoy_if_flat` is well below today's `yoy`, a large monthly increase is about to leave the window, and headline inflation will fall *unless* this month's price change is large.

### Try it 19.3

Check the approximation: for the latest month, compare `yoy` with the **sum of the last 12 `mom` values**. How big is the gap, and why isn't it zero?

<details>
<summary>Solution</summary>

```sql
SELECT month, ROUND(yoy, 2) AS yoy,
       ROUND(SUM(mom) OVER (ORDER BY month ROWS BETWEEN 11 PRECEDING AND CURRENT ROW), 2)
           AS sum_12_mom
FROM intermediate.int_cpi__growth
WHERE geo_code = 'CA' AND component = 'All-items'
QUALIFY month = MAX(month) OVER ()
```

The gap is small but non-zero because growth **compounds**: the exact relation is 1 + yoy = Π(1 + mom). Summing simple rates ignores the cross-terms, the same compound-vs-simple distinction as Day 1's annualisation example.

</details>

---

## 19.4 Core Measures, Median and Diffusion (23 min)

Headline CPI is volatile (energy, food). Central banks watch **core** measures. The BoC's preferred measures, CPI-trim and CPI-median, are computed from about 55 detailed components with seasonally adjusted data and official weights. We'll build simpler **teaching proxies** from what we have, and label them honestly.

### Step 1 — Find the exclusion aggregates StatCan publishes

```sql
SELECT DISTINCT component
FROM staging.stg_statcan__cpi
WHERE geo_code = 'CA' AND component ILIKE 'All-items excluding%'
ORDER BY component;
```

You'll see aggregates such as *All-items excluding food and energy*. Use the exact labels your query returns in the next steps.

### Step 2 — A median across major components (a teaching proxy)

```sql
WITH majors AS (
    SELECT g.month, g.component, g.yoy
    FROM intermediate.int_cpi__growth AS g
    JOIN seeds.seed_cpi_weights AS w USING (component)       -- the 7 major groups
    WHERE g.geo_code = 'CA' AND g.yoy IS NOT NULL
)
SELECT month,
       ROUND(MEDIAN(yoy), 2)                          AS median_major_yoy,
       ROUND(MIN(yoy), 1)                             AS min_yoy,
       ROUND(MAX(yoy), 1)                             AS max_yoy,
       COUNT(*)                                       AS n_components
FROM majors
GROUP BY month
ORDER BY month DESC
LIMIT 6;
```

Joining to the seed table is a neat way to say "only these components". The list of components now lives in one place, not in every query.

### Step 3 — Diffusion: how broad-based is inflation?

A **diffusion index** is the share of components above a threshold. High diffusion means price pressure is broad, not driven by one or two categories.

```sql
WITH majors AS (
    SELECT g.month, g.yoy
    FROM intermediate.int_cpi__growth AS g
    JOIN seeds.seed_cpi_weights USING (component)
    WHERE g.geo_code = 'CA' AND g.yoy IS NOT NULL
)
SELECT month,
       ROUND(100.0 * COUNT(*) FILTER (WHERE yoy > 3) / COUNT(*), 0) AS pct_above_3,
       ROUND(100.0 * COUNT(*) FILTER (WHERE yoy < 1) / COUNT(*), 0) AS pct_below_1
FROM majors
GROUP BY month
ORDER BY month DESC
LIMIT 12;
```

> With only seven components, this index is coarse. Applied to the hundreds of detailed product groups in the full table, it becomes a serious indicator. Try it as a stretch goal (hint: filter to leaf-level components carefully, since aggregates would double-count).

---

## 19.5 Contributions to Headline Inflation (20 min)

The notebook's Module 05 stacks each component's **contribution**: `yoy × weight / 100`. Let's reproduce it and quantify how far the approximation is from the headline.

```sql
WITH comp AS (
    SELECT g.month, g.component, g.yoy, w.weight_pct,
           g.yoy * w.weight_pct / 100 AS contribution_pp
    FROM intermediate.int_cpi__growth AS g
    JOIN seeds.seed_cpi_weights AS w USING (component)
    WHERE g.geo_code = 'CA' AND g.yoy IS NOT NULL
),
headline AS (
    SELECT month, yoy AS headline_yoy
    FROM intermediate.int_cpi__growth
    WHERE geo_code = 'CA' AND component = 'All-items'
)
SELECT c.month,
       ROUND(h.headline_yoy, 2)                           AS headline_yoy,
       ROUND(SUM(c.contribution_pp), 2)                   AS sum_of_contributions,
       ROUND(h.headline_yoy - SUM(c.contribution_pp), 2)  AS residual,
       ROUND(SUM(c.weight_pct), 1)                        AS weights_covered
FROM comp AS c
JOIN headline AS h USING (month)
GROUP BY c.month, h.headline_yoy
ORDER BY c.month DESC
LIMIT 6;
```

Why the residual isn't zero:
1. The seven weights cover about 96% of the basket (alcohol and tobacco are missing).
2. The weights are illustrative and fixed, while official ones are updated with each basket revision.
3. The exact method uses **price-updated** weights (each component's weight adjusted by its relative price change since the basket reference period).

> **Lesson:** always show the residual. A decomposition that silently doesn't add up misleads readers; one that reports its residual is honest and checkable.

### Pivot for charting

```sql
WITH comp AS (
    SELECT g.month, g.component, g.yoy * w.weight_pct / 100 AS contribution_pp
    FROM intermediate.int_cpi__growth AS g
    JOIN seeds.seed_cpi_weights AS w USING (component)
    WHERE g.geo_code = 'CA' AND g.month >= DATE '2021-01-01'
)
PIVOT comp ON component USING first(ROUND(contribution_pp, 2))
ORDER BY month DESC
LIMIT 3;
```

---

## 19.6 Mini-Project: `int_cpi__national_measures` + Tests (20 min)

Create `sql/21_int_cpi__national_measures.sql` defining a **wide, national, monthly** view with one row per month. It should include:

| Column | Definition |
|---|---|
| `month` | |
| `cpi_headline` | All-items index level |
| `headline_yoy`, `headline_mom`, `headline_ann_3m` | from `int_cpi__growth` |
| `headline_yoy_ma3`, `headline_yoy_ma12`, `headline_accel_12m` | from `int_cpi__smoothed` |
| `core_ex_fe_yoy` | All-items excluding food and energy, YoY |
| `shelter_yoy`, `energy_yoy`, `food_yoy` | |
| `median_major_yoy`, `diffusion_above_3` | 19.4 |
| `contrib_sum`, `contrib_residual` | 19.5 |
| `next_yoy_if_flat` | 19.3 |

Then add two tests:
- `sql/tests/national_measures_unique_month.sql` (error): `month` unique.
- `sql/tests/national_measures_yoy_range.sql` (error): `headline_yoy` between −5 and 20 when not null.

<details>
<summary>Solution</summary>

```sql
-- intermediate.int_cpi__national_measures
-- Grain: one row per month (Canada). All rates in %.
-- Momentum measures (mom, ann_3m) are based on NSA data — interpret with care.

CREATE OR REPLACE VIEW intermediate.int_cpi__national_measures AS
WITH nat AS (
    SELECT * FROM intermediate.int_cpi__smoothed WHERE geo_code = 'CA'
),

headline AS (
    SELECT month,
           cpi                AS cpi_headline,
           yoy                AS headline_yoy,
           mom                AS headline_mom,
           ann_3m             AS headline_ann_3m,
           yoy_ma3            AS headline_yoy_ma3,
           yoy_ma12           AS headline_yoy_ma12,
           yoy_change_12m     AS headline_accel_12m,
           LAG(cpi, 11)   OVER (ORDER BY month) AS cpi_l11,
           LAG(month, 11) OVER (ORDER BY month) AS month_l11
    FROM nat
    WHERE component = 'All-items'
),

components AS (
    SELECT month,
           MAX(yoy) FILTER (WHERE component = 'All-items excluding food and energy') AS core_ex_fe_yoy,
           MAX(yoy) FILTER (WHERE component = 'Shelter')                             AS shelter_yoy,
           MAX(yoy) FILTER (WHERE component = 'Energy')                              AS energy_yoy,
           MAX(yoy) FILTER (WHERE component = 'Food')                                AS food_yoy
    FROM nat
    GROUP BY month
),

majors AS (
    SELECT n.month,
           MEDIAN(n.yoy)                                                 AS median_major_yoy,
           100.0 * COUNT(*) FILTER (WHERE n.yoy > 3) / COUNT(*)          AS diffusion_above_3,
           SUM(n.yoy * w.weight_pct / 100)                               AS contrib_sum
    FROM nat AS n
    JOIN seeds.seed_cpi_weights AS w USING (component)
    WHERE n.yoy IS NOT NULL
    GROUP BY n.month
)

SELECT h.month,
       h.cpi_headline,
       h.headline_yoy,
       h.headline_mom,
       h.headline_ann_3m,
       h.headline_yoy_ma3,
       h.headline_yoy_ma12,
       h.headline_accel_12m,
       c.core_ex_fe_yoy,
       c.shelter_yoy,
       c.energy_yoy,
       c.food_yoy,
       m.median_major_yoy,
       m.diffusion_above_3,
       m.contrib_sum,
       h.headline_yoy - m.contrib_sum                                    AS contrib_residual,
       CASE WHEN h.month_l11 = CAST(h.month - INTERVAL 11 MONTH AS DATE)
            THEN 100 * (h.cpi_headline / h.cpi_l11 - 1) END              AS next_yoy_if_flat
FROM headline AS h
LEFT JOIN components AS c USING (month)
LEFT JOIN majors     AS m USING (month);
```

```sql
-- sql/tests/national_measures_unique_month.sql
-- severity: error
SELECT month, COUNT(*) FROM intermediate.int_cpi__national_measures
GROUP BY month HAVING COUNT(*) > 1
```

```sql
-- sql/tests/national_measures_yoy_range.sql
-- severity: error
SELECT month, headline_yoy FROM intermediate.int_cpi__national_measures
WHERE headline_yoy IS NOT NULL AND (headline_yoy < -5 OR headline_yoy > 20)
```

Using `LEFT JOIN` from `headline` guarantees exactly one row per headline month, even for months where a component is missing, so the unique-month test protects against accidental fan-out.

</details>

### Day 19 checklist
- [ ] I compute gap-safe growth rates by lagging the date alongside the value
- [ ] I annualise correctly and know which measures are sensitive to seasonality
- [ ] I layer smoothing models on top of growth models
- [ ] I can explain and quantify base effects
- [ ] I can build (and honestly label) median, diffusion and contribution measures, showing residuals
- [ ] My intermediate models are tested for uniqueness and plausible ranges

```bash
python run_tests.py
git add .
git commit -m "Day 19: CPI growth, smoothing, base effects, national measures"
git push
```

---

# DAY 20 — GDP, Mixed Frequencies and the Module 2 Capstone

| Time | Block |
|---|---|
| 0:00 – 0:23 | 20.1 Profiling and staging GDP |
| 0:23 – 0:50 | 20.2 `int_gdp__growth`: quarterly growth done right |
| 0:50 – 0:58 | Break |
| 0:58 – 1:15 | 20.3 Recession flags: rules of thumb vs dated cycles |
| 1:15 – 1:35 | 20.4 Formalising the rates panel |
| 1:35 – 1:43 | Break |
| 1:43 – 2:15 | 20.5 Capstone: `marts.macro_monthly` and `marts.macro_quarterly` |
| 2:15 – 2:30 | 20.6 One-command pipeline · Module 2 recap |

---

## 20.1 Profiling and Staging GDP (23 min)

### Profile first

```sql
SELECT DISTINCT "Estimates" FROM raw.statcan_gdp_full ORDER BY 1;
SELECT DISTINCT "Prices" FROM raw.statcan_gdp_full ORDER BY 1;
SELECT DISTINCT "Seasonal adjustment" FROM raw.statcan_gdp_full ORDER BY 1;
SELECT DISTINCT UOM, SCALAR_FACTOR FROM raw.statcan_gdp_full;
SELECT MIN(REF_DATE), MAX(REF_DATE) FROM raw.statcan_gdp_full;
```

Things to notice:
- **Estimates** lists the expenditure components: household consumption, government spending, business investment, exports, imports, and GDP itself.
- **Prices** distinguishes *current prices* (nominal), *chained dollars* (real) and price indexes. Note the exact labels; the chained-dollar reference year changes when StatCan rebases.
- **SCALAR_FACTOR** tells you values are in **millions** of dollars.
- Quarterly `REF_DATE` looks like `2026-04`, the **first month** of the quarter (Day 7).

### `sql/11_stg_statcan__gdp.sql`

```sql
-- staging.stg_statcan__gdp
-- Source:  raw.statcan_gdp_full (StatCan 36-10-0104-01, GDP expenditure-based, quarterly)
-- Grain:   one row per quarter × estimate × prices × seasonal adjustment
-- Units:   value_millions (dollars, millions) or index, see `unit`

CREATE OR REPLACE VIEW staging.stg_statcan__gdp AS
WITH source AS (
    SELECT * FROM raw.statcan_gdp_full
),

renamed AS (
    SELECT
        CAST(REF_DATE || '-01' AS DATE)      AS quarter,
        TRIM("Estimates")                    AS estimate,
        TRIM("Prices")                       AS prices,
        TRIM("Seasonal adjustment")          AS seasonal_adjustment,
        UOM                                  AS unit,
        SCALAR_FACTOR                        AS scalar_factor,
        VECTOR                               AS vector_id,
        TRY_CAST(VALUE AS DOUBLE)            AS value,
        NULLIF(TRIM(STATUS), '')             AS status_flag
    FROM source
    WHERE GEO = 'Canada'
)

SELECT * FROM renamed WHERE value IS NOT NULL;
```

Add tests:

```sql
-- sql/tests/gdp_unique_keys.sql
-- severity: error
SELECT quarter, estimate, prices, seasonal_adjustment, COUNT(*)
FROM staging.stg_statcan__gdp
GROUP BY ALL HAVING COUNT(*) > 1
```

```sql
-- sql/tests/gdp_quarter_starts.sql
-- severity: error
-- Quarterly dates must be Jan/Apr/Jul/Oct 1st
SELECT DISTINCT quarter FROM staging.stg_statcan__gdp
WHERE month(quarter) NOT IN (1, 4, 7, 10) OR day(quarter) <> 1
```

---

## 20.2 `int_gdp__growth`: Quarterly Growth Done Right (28 min)

Create `sql/22_int_gdp__growth.sql`. Check the exact `prices` labels from your profiling and adjust the two constants if needed.

```sql
-- intermediate.int_gdp__growth
-- Grain:  one row per quarter (Canada, seasonally adjusted at annual rates)
-- Adds:   real GDP growth (qoq, annualised compound & simple, yoy),
--         nominal growth, implicit GDP deflator and its inflation.

CREATE OR REPLACE VIEW intermediate.int_gdp__growth AS
WITH gdp AS (
    SELECT quarter,
           MAX(value) FILTER (WHERE prices LIKE 'Chained%')      AS real_gdp,
           MAX(value) FILTER (WHERE prices = 'Current prices')   AS nominal_gdp
    FROM staging.stg_statcan__gdp
    WHERE estimate = 'Gross domestic product at market prices'
      AND seasonal_adjustment = 'Seasonally adjusted at annual rates'
    GROUP BY quarter
),

with_deflator AS (
    SELECT *, 100 * nominal_gdp / real_gdp AS gdp_deflator
    FROM gdp
),

lagged AS (
    SELECT *,
           LAG(real_gdp, 1)     OVER w AS real_l1,
           LAG(real_gdp, 4)     OVER w AS real_l4,
           LAG(nominal_gdp, 4)  OVER w AS nominal_l4,
           LAG(gdp_deflator, 4) OVER w AS deflator_l4,
           LAG(quarter, 1)      OVER w AS quarter_l1,
           LAG(quarter, 4)      OVER w AS quarter_l4
    FROM with_deflator
    WINDOW w AS (ORDER BY quarter)
),

growth AS (
    SELECT quarter, real_gdp, nominal_gdp, gdp_deflator,
           CASE WHEN quarter_l1 = CAST(quarter - INTERVAL 3 MONTH AS DATE)
                THEN 100 * (real_gdp / real_l1 - 1) END                   AS real_qoq,
           CASE WHEN quarter_l1 = CAST(quarter - INTERVAL 3 MONTH AS DATE)
                THEN 100 * (POWER(real_gdp / real_l1, 4) - 1) END         AS real_qoq_ann,
           CASE WHEN quarter_l1 = CAST(quarter - INTERVAL 3 MONTH AS DATE)
                THEN 400 * (real_gdp / real_l1 - 1) END                   AS real_qoq_ann_simple,
           CASE WHEN quarter_l4 = CAST(quarter - INTERVAL 12 MONTH AS DATE)
                THEN 100 * (real_gdp / real_l4 - 1) END                   AS real_yoy,
           CASE WHEN quarter_l4 = CAST(quarter - INTERVAL 12 MONTH AS DATE)
                THEN 100 * (nominal_gdp / nominal_l4 - 1) END             AS nominal_yoy,
           CASE WHEN quarter_l4 = CAST(quarter - INTERVAL 12 MONTH AS DATE)
                THEN 100 * (gdp_deflator / deflator_l4 - 1) END           AS deflator_yoy
    FROM lagged
)

SELECT *,
       CASE WHEN COUNT(real_qoq_ann) OVER w4 = 4
            THEN AVG(real_qoq_ann) OVER w4 END                            AS real_qoq_ann_ma4
FROM growth
WINDOW w4 AS (ORDER BY quarter RANGE BETWEEN INTERVAL 9 MONTH PRECEDING AND CURRENT ROW);
```

Notes on the economics:
- **SAAR**: StatCan publishes quarterly GDP "seasonally adjusted at annual rates", meaning the quarterly *level* is multiplied by 4. Growth rates are unaffected by that scaling.
- **Compound vs simple annualisation**: the notebook uses `pct_change() * 400` (simple). We keep both, so you can see the difference, which is largest in extreme quarters such as 2020.
- **Implicit deflator** = nominal ÷ real × 100. Its growth is economy-wide inflation (including investment and exports), a useful comparison with CPI.
- The 4-quarter window uses `RANGE … 9 MONTH PRECEDING`: four quarter-start dates span 9 months.

```sql
SELECT quarter,
       ROUND(real_qoq_ann, 1)        AS qoq_ann,
       ROUND(real_qoq_ann_simple, 1) AS qoq_ann_simple,
       ROUND(real_yoy, 1)            AS yoy,
       ROUND(deflator_yoy, 1)        AS deflator_yoy
FROM intermediate.int_gdp__growth
ORDER BY quarter DESC
LIMIT 6;
```

### A word on chained dollars

Real GDP components in **chained** dollars are **not additive**: consumption + investment + … doesn't exactly equal chained real GDP, except in the reference year. That's why StatCan publishes separate *contributions to percent change*. If you ever compute growth contributions from chained components yourself, you'll get a residual. Report it, just as with CPI (19.5).

### Try it 20.2

Which five quarters since 2000 had the largest gap between compound and simple annualised growth? What do they have in common?

<details>
<summary>Solution</summary>

```sql
SELECT quarter,
       ROUND(real_qoq_ann, 1)                               AS compound,
       ROUND(real_qoq_ann_simple, 1)                        AS simple,
       ROUND(ABS(real_qoq_ann - real_qoq_ann_simple), 2)    AS gap
FROM intermediate.int_gdp__growth
WHERE quarter >= DATE '2000-01-01'
ORDER BY gap DESC NULLS LAST
LIMIT 5;
```

They are the most extreme quarters (the 2020 collapse and rebound, the 2008–09 recession). Compounding matters most when quarterly growth is large in absolute value.

</details>

---

## 20.3 Recession Flags: Rules of Thumb vs Dated Cycles (18 min)

A popular rule of thumb calls a **technical recession** two consecutive quarters of negative real GDP growth. Economists who date business cycles (the C.D. Howe Institute's Business Cycle Council in Canada, used by the notebook) look at depth, duration and breadth, so the two can disagree.

Add to `sql/22_int_gdp__growth.sql`:

```sql
-- intermediate.int_gdp__cycle_flags
-- Grain: one row per quarter
CREATE OR REPLACE VIEW intermediate.int_gdp__cycle_flags AS
WITH g AS (
    SELECT quarter, real_qoq,
           real_qoq < 0                               AS is_negative,
           LAG(real_qoq)  OVER (ORDER BY quarter) < 0 AS prev_negative,
           LEAD(real_qoq) OVER (ORDER BY quarter) < 0 AS next_negative
    FROM intermediate.int_gdp__growth
)
SELECT g.quarter,
       g.real_qoq,
       COALESCE(g.is_negative AND (g.prev_negative OR g.next_negative), false)
                                                   AS technical_recession,
       EXISTS (
           SELECT 1 FROM seeds.seed_recession_bands AS b
           WHERE g.quarter <= b.end_date
             AND CAST(g.quarter + INTERVAL 3 MONTH - INTERVAL 1 DAY AS DATE) >= b.start_date
       )                                           AS in_dated_recession
FROM g;
```

- A quarter is flagged `technical_recession` if it's negative **and** its neighbour before or after is also negative, so both quarters of each pair are flagged.
- `in_dated_recession` checks whether the quarter **overlaps** a band in the seed table. Two date ranges overlap when each starts before the other ends.

Compare the two definitions:

```sql
SELECT quarter, ROUND(real_qoq, 2) AS qoq, technical_recession, in_dated_recession
FROM intermediate.int_gdp__cycle_flags
WHERE technical_recession OR in_dated_recession
ORDER BY quarter;
```

> **Discussion:** where do they disagree, and why? A recession can be dated without two negative quarters, and a technical recession may be too shallow or brief to be dated. The notebook's "Oil shock" band of 2015 is a good case to look at. Definitions are choices, so seed them, document them and test them.

---

## 20.4 Formalising the Rates Panel (20 min)

The `scratch.monthly_*` views from Day 14 did useful work, but `scratch` is for experiments. Let's promote them properly.

**`sql/12_stg_macro__observations.sql`**: staging for the Day 10 pipeline output:

```sql
-- staging.stg_macro__observations
-- Source: raw.observations (macro_extract pipeline: BoC, FRED, StatCan vectors)
-- Grain:  one row per series × observation date
CREATE OR REPLACE VIEW staging.stg_macro__observations AS
SELECT CAST(date AS DATE)  AS obs_date,
       series_id,
       name                AS series_name,
       source,
       value,
       fetched_at
FROM raw.observations;
```

**`sql/23_int_rates__monthly.sql`**: monthly aggregation with explicit rules, then wide:

```sql
-- intermediate.int_rates__monthly
-- Grain: one row per month. Policy rates = last value in month; others = monthly mean.
CREATE OR REPLACE VIEW intermediate.int_rates__monthly AS
WITH monthly_long AS (
    SELECT CAST(date_trunc('month', obs_date) AS DATE) AS month,
           series_name,
           CASE WHEN series_name IN ('overnight_rate', 'fed_funds')
                THEN arg_max(value, obs_date)
                ELSE AVG(value) END                    AS value
    FROM staging.stg_macro__observations
    GROUP BY ALL
),

wide AS (
    SELECT month,
           MAX(value) FILTER (WHERE series_name = 'overnight_rate')    AS overnight_rate,
           MAX(value) FILTER (WHERE series_name = 'fed_funds')         AS fed_funds,
           MAX(value) FILTER (WHERE series_name = 'yield_2yr')         AS yield_2yr,
           MAX(value) FILTER (WHERE series_name = 'yield_10yr')        AS yield_10yr,
           MAX(value) FILTER (WHERE series_name = 'cad_usd')           AS cad_usd,
           MAX(value) FILTER (WHERE series_name = 'wti')               AS wti,
           MAX(value) FILTER (WHERE series_name = 'oecd_cli')          AS oecd_cli,
           MAX(value) FILTER (WHERE series_name = 'unemployment_rate') AS unemployment_rate
    FROM monthly_long
    GROUP BY month
)

SELECT *,
       overnight_rate - fed_funds       AS boc_fed_diff,
       (yield_10yr - yield_2yr) * 100   AS spread_10_2_bp,
       1 / cad_usd                      AS usd_cad
FROM wide;
```

> Could the aggregation rule live in a seed (`seed_series_rules` with `series_name, monthly_agg`) instead of a `CASE`? Yes, and that's the better design once you have dozens of series. Try it as a stretch goal.

---

## 20.5 Capstone: The Macro Marts (33 min)

Marts are **tables** (materialised), built for consumers: the dashboard layer (as in the notebook), forecasting (Days 61–70) and causal models (Days 71–80).

### `sql/30_macro_monthly.sql`

**Requirements:**
- Grain: one row per month from 2006-01-01.
- Columns: everything from `int_rates__monthly`; the key CPI measures from `int_cpi__national_measures`; `real_rate` (overnight − headline YoY) and `real_rate_core` (overnight − core ex food & energy YoY); `in_dated_recession` (month overlaps a seed band).
- A header comment and `COMMENT ON TABLE`.

<details>
<summary>Solution</summary>

```sql
-- marts.macro_monthly
-- Grain:  one row per month, Canada, from 2006-01.
-- Use:    dashboards (notebook Modules 01–06), forecasting features.
-- Notes:  CPI momentum measures are NSA-based. Real rates use contemporaneous CPI
--         (ignores the publication lag — see marts.policy_cycles for a lag-aware version).

CREATE OR REPLACE TABLE marts.macro_monthly AS
WITH rates AS (
    SELECT * FROM intermediate.int_rates__monthly
    WHERE month >= DATE '2006-01-01'
),

cpi AS (
    SELECT month, headline_yoy, headline_ann_3m, headline_yoy_ma3, headline_yoy_ma12,
           core_ex_fe_yoy, shelter_yoy, energy_yoy, food_yoy,
           median_major_yoy, diffusion_above_3, next_yoy_if_flat
    FROM intermediate.int_cpi__national_measures
),

joined AS (
    SELECT r.*, c.* EXCLUDE (month)
    FROM rates AS r
    LEFT JOIN cpi AS c USING (month)
)

SELECT j.*,
       j.overnight_rate - j.headline_yoy    AS real_rate,
       j.overnight_rate - j.core_ex_fe_yoy  AS real_rate_core,
       EXISTS (
           SELECT 1 FROM seeds.seed_recession_bands AS b
           WHERE j.month <= b.end_date
             AND CAST(j.month + INTERVAL 1 MONTH - INTERVAL 1 DAY AS DATE) >= b.start_date
       )                                    AS in_dated_recession
FROM joined AS j
ORDER BY month;

COMMENT ON TABLE marts.macro_monthly IS
    'Monthly Canadian macro panel: rates, FX, oil, CPI measures, real rates. Grain: month.';
```

`c.* EXCLUDE (month)` avoids a duplicate `month` column: DuckDB's friendly SQL from Day 17.

</details>

### `sql/31_macro_quarterly.sql`

**Requirements:**
- Grain: one row per quarter from 2006.
- All columns from `int_gdp__growth` and `int_gdp__cycle_flags`.
- Quarterly **averages** of `overnight_rate`, `headline_yoy`, `core_ex_fe_yoy`, `real_rate`, `unemployment_rate`, `usd_cad` and `spread_10_2_bp` from `marts.macro_monthly`, only for **complete quarters** (3 months of data); otherwise `NULL`.
- `real_gdp_trillions`: real GDP converted from millions for readability.

<details>
<summary>Solution</summary>

```sql
-- marts.macro_quarterly
-- Grain:  one row per quarter, Canada, from 2006-Q1.
-- Monthly indicators are quarterly averages over complete quarters only.

CREATE OR REPLACE TABLE marts.macro_quarterly AS
WITH monthly_to_quarter AS (
    SELECT CAST(date_trunc('quarter', month) AS DATE) AS quarter,
           COUNT(headline_yoy)                         AS months_with_cpi,
           AVG(overnight_rate)                         AS overnight_rate_avg,
           AVG(headline_yoy)                           AS headline_yoy_avg,
           AVG(core_ex_fe_yoy)                         AS core_ex_fe_yoy_avg,
           AVG(real_rate)                              AS real_rate_avg,
           AVG(unemployment_rate)                      AS unemployment_rate_avg,
           AVG(usd_cad)                                AS usd_cad_avg,
           AVG(spread_10_2_bp)                         AS spread_10_2_bp_avg
    FROM marts.macro_monthly
    GROUP BY 1
),

complete AS (
    SELECT quarter,
           COLUMNS(* EXCLUDE (quarter, months_with_cpi))
    FROM monthly_to_quarter
    WHERE months_with_cpi = 3
)

SELECT g.quarter,
       year(g.quarter)                    AS yr,
       quarter(g.quarter)                 AS qtr,
       g.real_gdp / 1e6                   AS real_gdp_trillions,
       g.* EXCLUDE (quarter),
       f.technical_recession,
       f.in_dated_recession,
       c.* EXCLUDE (quarter)
FROM intermediate.int_gdp__growth       AS g
LEFT JOIN intermediate.int_gdp__cycle_flags AS f USING (quarter)
LEFT JOIN complete                      AS c USING (quarter)
WHERE g.quarter >= DATE '2006-01-01'
ORDER BY g.quarter;

COMMENT ON TABLE marts.macro_quarterly IS
    'Quarterly Canadian macro panel: GDP growth, deflator, recession flags, quarterly averages.';
```

Why only complete quarters? If only July CPI is out, a "Q3 average" would really be a July value, a classic source of misleading charts and forecasting leakage.

</details>

### Mart tests

```sql
-- sql/tests/macro_monthly_unique.sql
-- severity: error
SELECT month, COUNT(*) FROM marts.macro_monthly GROUP BY month HAVING COUNT(*) > 1
```

```sql
-- sql/tests/macro_monthly_no_gaps.sql
-- severity: error
SELECT MIN(month), MAX(month), COUNT(*)
FROM marts.macro_monthly
HAVING date_diff('month', MIN(month), MAX(month)) + 1 <> COUNT(*)
```

```sql
-- sql/tests/macro_quarterly_growth_range.sql
-- severity: error
-- Even 2020's extremes fall well inside ±60% annualised
SELECT quarter, real_qoq_ann FROM marts.macro_quarterly
WHERE real_qoq_ann IS NOT NULL AND ABS(real_qoq_ann) > 60
```

```sql
-- sql/tests/macro_monthly_real_rate_range.sql
-- severity: warn
SELECT month, real_rate FROM marts.macro_monthly
WHERE real_rate IS NOT NULL AND ABS(real_rate) > 15
```

---

## 20.6 One-Command Pipeline · Module 2 Recap (15 min)

### Update `load_warehouse.py` to run every SQL file in order

Replace the hard-coded list from Day 17 with:

```python
for path in sorted(SQL_DIR.glob("*.sql")):
    run_sql_file(con, path)
```

Only files directly in `sql/` match (not `sql/tests/`), and the numeric prefixes guarantee the order: schemas → raw → seeds → staging → intermediate → marts. Keep the `raw.dim_series` creation from Day 13 **before** this loop, and move the Python `CHECKS` from Days 13 and 17 into `sql/tests/` files so all tests live in one place.

Then export the marts for the dashboard notebook:

```python
import os
os.makedirs("data/marts", exist_ok=True)
for table in ["macro_monthly", "macro_quarterly", "policy_cycles"]:
    con.execute(f"COPY marts.{table} TO 'data/marts/{table}.parquet' (FORMAT parquet)")
```

### `pipeline.sh`: extract → load → test

```bash
#!/usr/bin/env bash
# pipeline.sh — rebuild everything. Stops at the first failing step.
set -e
source .venv/bin/activate
python run_extract.py
python load_warehouse.py
python run_tests.py
echo "✓ Pipeline complete: data/marts/ is up to date"
```

```bash
chmod +x pipeline.sh
./pipeline.sh
```

`set -e` makes the script stop as soon as any command fails. This works because every Python script returns a meaningful exit code (Day 10).

> **Note:** `run_extract.py` exits with code 2 when some series fail. Under `set -e` that stops the pipeline. Is that what you want? Discuss, then decide (for example, `python run_extract.py || [ $? -eq 2 ]` tolerates partial failures). Prefect (Days 51–60) gives you much finer control over exactly these decisions.

### Using the marts in the notebook

In the course notebook (or a new one), Cells 3–5 can now be replaced by:

```python
import pandas as pd
monthly = pd.read_parquet("data/marts/macro_monthly.parquet")
quarterly = pd.read_parquet("data/marts/macro_quarterly.parquet")
```

Every chart in Modules 01–06 then draws from tested, documented tables instead of ad-hoc transformations.

### Module 2 recap

```
APIs ──► macro_extract (Days 8–10)
          │
          ▼
      raw.*        all columns, as text                      Day 13, 18
          │
      seeds.*      geo codes, recession bands, weights       Day 18
          │
      staging.*    stg_statcan__cpi, stg_statcan__gdp,        Days 18, 20
                   stg_macro__observations
          │
      intermediate.*  int_cpi__growth / __smoothed /          Days 19–20
                      __national_measures, int_gdp__growth /
                      __cycle_flags, int_rates__monthly
          │
      marts.*      macro_monthly, macro_quarterly,            Days 17, 20
                   policy_cycles
          │
      sql/tests/*  uniqueness, gaps, ranges, freshness        Days 18–20
```

### What still hurts, and what fixes it next

| Pain point today | Fixed by |
|---|---|
| Hand-written extractors, manual schema handling, full reloads | **dlt**, Days 21–30 |
| Numbered SQL files, manual dependency order, hand-rolled tests | **dbt**, Days 31–40 |
| Tests only check what we thought of; no profiling reports | **Great Expectations**, Days 41–50 |
| `pipeline.sh` has no retries, schedule or monitoring | **Prefect**, Days 51–60 |

### Day 20 checklist
- [ ] I profiled and staged the GDP table, including units and labels
- [ ] I compute quarterly growth (qoq, annualised compound and simple, yoy), the deflator and 4-quarter averages, gap-safely
- [ ] I can compare rule-of-thumb and dated recession definitions
- [ ] I promoted scratch work into proper staging and intermediate models
- [ ] I built monthly and quarterly marts, avoiding incomplete-quarter averages
- [ ] One command extracts, builds, tests and exports everything

```bash
./pipeline.sh
git add .
git commit -m "Day 20: GDP staging, macro marts, one-command pipeline — Module 2 complete"
git push
```
