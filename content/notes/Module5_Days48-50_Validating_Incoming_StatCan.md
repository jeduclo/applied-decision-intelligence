# Module 5 · Quality Assurance with Great Expectations
## Days 48–50: Validating Incoming Statistics Canada Data — Unemployment Rates in 0–100% and Continuous Dates, with Write–Audit–Publish

**Audience:** MSc Economics students who completed Days 1–47
**Environment:** GitHub Codespaces · `.venv` (dlt, dbt) · `.venv-gx` (GX) · `macro.duckdb` · the `quality/` project from Days 42–47
**Time per day:** ~2.5 hours (including breaks and exercises)
**Goal by end of Day 50:** New StatCan releases (the full Labour Force Survey table, plus CPI and GDP) no longer flow straight into the warehouse. They're **written** to a holding area, **audited** by Great Expectations against a precise contract, and only then **published**, or **quarantined** with an alert. The contract encodes the curriculum's headline rules exactly: *unemployment rates remain between 0 and 100%* and *dates are continuous without gaps*. It adds accounting identities, cross-source checks and release-completeness checks. dbt builds provincial labour-market marts from published data only, and the warehouse records data quality as a KPI.

---

### Where we are

| Layer | Status after Day 47 |
|---|---|
| APIs → `raw_dlt` | dlt, incremental, contracts, resilient (Modules 3) |
| Full StatCan tables | downloaded when republished, loaded **directly** into `raw_dlt` (Day 30) |
| `raw_dlt` → marts | dbt in prod (Module 4) |
| Quality | GX validates staging/marts **after** dbt runs; critical/warning checkpoints; Data Docs; history (Days 44–47) |

There's one remaining weakness: **a bad StatCan release lands in `raw_dlt` before anyone checks it.** By the time GX looks at the marts, dbt has already rebuilt them from the bad data. These three days move validation to the **boundary**.

| Day | Theme |
|---|---|
| 48 | **Write–Audit–Publish:** add the LFS table, a holding area, a boundary contract |
| 49 | **The headline contracts:** rates in 0–100%, continuous dates, identities, cross-source and revision checks |
| 50 | **Publish or quarantine**, fault injection, dbt labour-market marts, quality as a KPI, the final pipeline |

---

# DAY 48 — Write–Audit–Publish and the Boundary Contract

| Time | Block |
|---|---|
| 0:00 – 0:20 | 48.1 Why validate at the boundary: Write–Audit–Publish |
| 0:20 – 0:45 | 48.2 Adding the Labour Force Survey table |
| 0:45 – 0:53 | Break |
| 0:53 – 1:18 | 48.3 The *write* step: loading into `raw_incoming` |
| 1:18 – 1:40 | 48.4 Profiling the raw LFS table |
| 1:40 – 1:48 | Break |
| 1:48 – 2:08 | 48.5 The boundary contract spec |
| 2:08 – 2:30 | 48.6 Checkpoint groups and a first `validate_incoming.py` |

---

## 48.1 Why Validate at the Boundary: Write–Audit–Publish (20 min)

Imagine StatCan publishes an LFS table in which, due to a processing error, one province's unemployment rate is `64.0` instead of `6.4`. With today's pipeline:

```
StatCan ──► raw_dlt (replaced!) ──► dbt rebuilds 20 models ──► marts ──► GX flags it ──► …too late
                                                                         dashboards already updated
```

The last *good* LFS data is gone from `raw_dlt` (the table was replaced), and every dependent model now contains the error.

### The Write–Audit–Publish (WAP) pattern

WAP is a widely used data-engineering pattern for exactly this problem:

```
            WRITE                    AUDIT                         PUBLISH
StatCan ──► raw_incoming.<table> ──► GX boundary checkpoint ──┬──► raw_dlt.<table>   (pass / warnings)
                                                              │
                                                              └──► raw_quarantine.<table>__<ts>  (critical failure)
                                                                   + alert; raw_dlt keeps last good data
```

| Step | What happens | Who sees the data |
|---|---|---|
| **Write** | new data lands in a separate holding schema | nobody downstream |
| **Audit** | GX validates it against the contract | quality checks only |
| **Publish** | only audited data replaces the production raw table | dbt and every consumer |
| **Quarantine** | failed data is kept for investigation, never published | data team only |

Properties this gives you:
- **The warehouse stays consistent.** A bad release can't partially overwrite good data.
- **Downstream keeps working.** dbt builds from the last good release, slightly stale but correct, and freshness warnings (Day 36) say so honestly.
- **Evidence is preserved.** The quarantined table shows exactly what StatCan sent.

> **Economist's analogy:** a journal's peer review. Submissions (write) are reviewed (audit) before appearing in the published issue (publish); rejected ones are archived, not printed. Readers only ever see reviewed work.

---

## 48.2 Adding the Labour Force Survey Table (25 min)

The course notebook (Cell 4) reads **table 14-10-0287-01**, *Labour force characteristics by province, monthly*. Its structure:

| Dimension (column) | Examples |
|---|---|
| `GEO` | Canada, the ten provinces |
| `Labour force characteristics` | Population, Labour force, Employment, Unemployment, Unemployment rate, Participation rate, Employment rate, … |
| `Gender` (older releases: `Sex`) | Total - Gender, Men+, Women+ |
| `Age group` | 15 years and over, 15 to 24 years, 25 to 54 years, 55 years and over, … |
| `Statistics` | Estimate, standard errors of the estimate and of changes |
| `Data type` | Seasonally adjusted, Unadjusted, and possibly others: check the profile |
| `UOM` | Persons (thousands), Percentage, … |

> **Notice `Gender` vs `Sex`.** The notebook handles both with an `if "Gender" in lfs.columns … elif "Sex" …` branch. That's a real schema change StatCan made to its tables. Our boundary contract will make such a change **visible and deliberate** instead of silently patched.

The table is large (the notebook reports over five million rows) because it crosses every dimension. That's fine for DuckDB, and a realistic test for your pipeline.

### Configuration

In `.dlt/config.toml`, extend the full-table list from Day 30:

```toml
[sources.statcan_tables]
tables = { "18100004" = "statcan_cpi_full", "36100104" = "statcan_gdp_full", "14100287" = "statcan_lfs_full" }
```

### Take full tables out of the direct path

From today, full tables go through WAP. `ingest.py` keeps loading API series (BoC, FRED, StatCan vectors) directly, but skips `statcan_tables`:

```bash
python ingest.py --only boc,fred,statcan
```

We'll update `pipeline.sh` accordingly on Day 50.

---

## 48.3 The *Write* Step: Loading into `raw_incoming` (25 min)

Create `ingest_statcan_tables.py` at the repository root (runs in `.venv`). Today it only **writes**; Day 50 adds audit and publish.

```python
"""ingest_statcan_tables.py — Write–Audit–Publish for full StatCan tables.

Day 48: WRITE step only (load changed tables into raw_incoming).
Usage:  python ingest_statcan_tables.py [--full-refresh]
"""
import os
import sys

import dlt
import duckdb

from macro_ingest.statcan_tables import current_release_times, statcan_tables_source

DB = os.environ.get("MACRO_DUCKDB_PATH", "macro.duckdb")
FULL_REFRESH = "--full-refresh" in sys.argv


def published_release_times():
    """Last *published* releaseTime per product, from raw_dlt.statcan_releases."""
    try:
        with duckdb.connect(DB, read_only=True) as con:
            rows = con.sql("""select product_id, max(release_time)
                              from raw_dlt.statcan_releases group by 1""").fetchall()
        return {str(pid): rt for pid, rt in rows}
    except Exception:
        return {}


def changed_tables():
    tables = dlt.config["sources.statcan_tables.tables"]
    current = current_release_times(tables.keys())
    published = published_release_times()
    changed = {pid: name for pid, name in tables.items()
               if FULL_REFRESH or current.get(pid) != published.get(pid)}
    return changed, current


def write_incoming(changed):
    """WRITE: load changed tables into the holding schema raw_incoming."""
    pipeline = dlt.pipeline(pipeline_name="statcan_incoming",
                            destination="duckdb", dataset_name="raw_incoming")
    info = pipeline.run(statcan_tables_source(tables=changed))
    info.raise_on_failed_jobs()


def main():
    changed, current = changed_tables()
    if not changed:
        print("✓ No StatCan table republished since last publish — nothing to do.")
        return 0
    print("Changed tables:", changed)
    write_incoming(changed)
    print("✓ Written to raw_incoming:", ", ".join(changed.values()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Notes:
- A **separate dlt pipeline** (`statcan_incoming`) and **dataset** (`raw_incoming`) keep holding-area state apart from production (`macro_ingest` → `raw_dlt`).
- The comparison now uses the last **published** release, not the last *loaded* one. A release that was downloaded but quarantined counts as "not yet published", so it's retried when StatCan republishes.
- `MACRO_DUCKDB_PATH` is the same variable dbt uses (Day 31), so one setting points every tool at the warehouse.

Run it (the first run downloads all three tables, including the large LFS file):

```bash
source .venv/bin/activate
python ingest_statcan_tables.py --full-refresh
duckdb macro.duckdb -readonly -c "select table_name from information_schema.tables where table_schema = 'raw_incoming'"
```

---

## 48.4 Profiling the Raw LFS Table (23 min)

Profile before writing any contract (Day 45). Everything in `raw_incoming` is **text** (Day 18's raw-layer rule).

```bash
duckdb macro.duckdb -readonly
```

```sql
.mode box
DESCRIBE raw_incoming.statcan_lfs_full;
SELECT count(*) FROM raw_incoming.statcan_lfs_full;

-- The dimensions and their members
SELECT labour_force_characteristics, uom, count(*) AS n
FROM raw_incoming.statcan_lfs_full GROUP BY ALL ORDER BY 1;

SELECT statistics, count(*) FROM raw_incoming.statcan_lfs_full GROUP BY 1;
SELECT data_type,  count(*) FROM raw_incoming.statcan_lfs_full GROUP BY 1;
SELECT gender,     count(*) FROM raw_incoming.statcan_lfs_full GROUP BY 1;   -- or `sex` in older data
SELECT age_group,  count(*) FROM raw_incoming.statcan_lfs_full GROUP BY 1 ORDER BY 1;

-- Quality flags, and how they relate to missing values
SELECT status, value IS NULL AS value_missing, count(*) AS n
FROM raw_incoming.statcan_lfs_full GROUP BY ALL ORDER BY n DESC;

-- Period coverage
SELECT min(ref_date), max(ref_date), count(DISTINCT ref_date) FROM raw_incoming.statcan_lfs_full;

-- Is (vector, ref_date) a key?
SELECT count(*) AS rows, count(DISTINCT (vector, ref_date)) AS distinct_keys
FROM raw_incoming.statcan_lfs_full;
```

Record your findings in `quality/specs/incoming/LFS_PROFILE_NOTES.md`: exact member names, the status codes and whether they coincide with missing values, the first month, the number of rows, and whether `(vector, ref_date)` is unique. **Every threshold tomorrow depends on these notes.** Column names above assume dlt's snake_case normalisation (Day 24). Adjust to what `DESCRIBE` shows.

### Try it 48.4

Answer with SQL: (a) Which characteristics are **rates** (UOM a percentage)? (b) What's the smallest labour force (in thousands) among Estimate rows, and for which province/age group? Why does that matter for checking rounding-based identities on Day 49?

<details>
<summary>Solution</summary>

```sql
-- (a)
SELECT DISTINCT labour_force_characteristics, uom
FROM raw_incoming.statcan_lfs_full
WHERE uom ILIKE '%percent%' OR uom ILIKE '%rate%';

-- (b)
SELECT geo, age_group, gender, ref_date, try_cast(value AS DOUBLE) AS lf_thousands
FROM raw_incoming.statcan_lfs_full
WHERE labour_force_characteristics = 'Labour force' AND statistics = 'Estimate'
  AND try_cast(value AS DOUBLE) IS NOT NULL
ORDER BY lf_thousands
LIMIT 5;
```

Small cells (e.g. a youth group in Prince Edward Island) have labour forces of only a few thousand people. Values are published **rounded to 0.1 thousand**, so recomputing a rate from rounded counts can differ from the published rate by much more than 0.1pp in small cells. Identity checks must use **tolerances that respect rounding**, or they'll raise false alarms.

</details>

---

## 48.5 The Boundary Contract Spec (20 min)

The boundary contract asks: **did StatCan deliver a well-formed table of the kind we expect?** It checks structure, formats and keys, not economics yet.

Create the folder `quality/specs/incoming/` and the file `quality/specs/incoming/lfs_boundary.yml`:

```yaml
description: >
  Boundary contract for StatCan table 14-10-0287-01 (LFS) as delivered, before publication.
  All columns are text in the raw layer. Structural checks only.
asset: incoming_statcan_lfs_full
batch_definition: full
checkpoint_group: incoming_lfs
owner: macro-team

critical:
  - type: ExpectTableColumnsToMatchSet
    kwargs:
      column_set: [ref_date, geo, labour_force_characteristics, gender, age_group,
                   statistics, data_type, uom, vector, value, status]
      exact_match: false
    meta:
      plan_id: B01
      dimension: validity
      rationale: >
        Columns our staging model depends on. If StatCan renames a dimension (e.g. Gender ↔ Sex),
        the release is quarantined until staging is deliberately updated.

  - type: ExpectColumnValuesToNotBeNull
    kwargs: {column: ref_date}
    meta: {plan_id: B02, dimension: completeness}

  - type: ExpectColumnValueLengthsToEqual
    kwargs: {column: ref_date, value: 7}
    meta: {plan_id: B03, dimension: validity, rationale: "Monthly reference periods are 'YYYY-MM'."}

  - type: ExpectCompoundColumnsToBeUnique
    kwargs: {column_list: [vector, ref_date]}
    meta: {plan_id: B04, dimension: uniqueness,
           rationale: "Each series (vector) has exactly one value per month."}

  - type: ExpectColumnValuesToNotBeNull
    kwargs: {column: vector}
    meta: {plan_id: B05, dimension: completeness}

warning:
  - type: ExpectColumnValuesToBeInSet
    kwargs: {column: statistics, value_set: ["Estimate", "Standard error of estimate",
                                              "Standard error of month-to-month change",
                                              "Standard error of year-over-year change"]}
    meta: {plan_id: B06, dimension: validity,
           rationale: "Replace with the exact members from LFS_PROFILE_NOTES.md."}

  - type: ExpectTableRowCountToBeBetween
    kwargs: {min_value: 4500000}
    meta: {plan_id: B07, dimension: completeness,
           rationale: "Set to ~90% of the profiled row count; a much smaller table suggests a truncated download."}
```

> Replace the member lists and row counts with **your** profile's values. The values above are illustrative placeholders.

### Why these are the right boundary checks

| Check | Failure it catches |
|---|---|
| B01 required columns | a renamed dimension (Gender/Sex), a dropped column |
| B03 period format | a change to quarterly (`YYYY-Qn`) or daily periods |
| B04 unique key | duplicated rows from a botched export |
| B07 row count | a truncated download (network failure mid-file) |

---

## 48.6 Checkpoint Groups and a First `validate_incoming.py` (23 min)

### Register the incoming asset

Add to `quality/setup_gx.py` (Day 43):

```python
INCOMING_TABLES = [
    ("incoming_statcan_lfs_full", "raw_incoming", "statcan_lfs_full"),
    ("incoming_statcan_cpi_full", "raw_incoming", "statcan_cpi_full"),
    ("incoming_statcan_gdp_full", "raw_incoming", "statcan_gdp_full"),
]
TABLE_ASSETS += INCOMING_TABLES
```

> **First-time order matters.** GX checks that a table exists when registering it. That's why `raw_incoming` was loaded in 48.3 *before* running setup. On later runs the tables always exist, because WAP keeps the last incoming copy in place.

### Group checkpoints by purpose

Until now, all suites fed two checkpoints: `critical` and `warning` (Day 46). Incoming-data suites must run **separately**, per table, at audit time. Add an optional `checkpoint_group` to specs, and let the builder name checkpoints `<group>_<severity>`:

In `quality/build_suites.py`:

```python
def load_specs():
    """Top-level specs and specs in subfolders (e.g. specs/incoming/), excluding drafts."""
    for path in sorted(SPEC_DIR.rglob("*.yml")):
        if "drafts" in path.parts:
            continue
        with open(path) as f:
            spec = yaml.safe_load(f)
        if not isinstance(spec, dict) or "asset" not in spec:
            continue
        yield path.stem, spec
```

and in `main()`, key the collected validation definitions by `(group, severity)`:

```python
    vds = {}                                               # (group, severity) → [definitions]
    ...
            group = spec.get("checkpoint_group", "")
            vds.setdefault((group, severity), []).append(vd)
    ...
    for (group, severity), defs in vds.items():
        name = f"{group}_{severity}" if group else severity
        context.checkpoints.add(gx.Checkpoint(
            name=name, validation_definitions=defs,
            actions=[gx.checkpoints.UpdateDataDocsAction(name="update_data_docs")],
            result_format={"result_format": "SUMMARY"}))
        print(f"✓ checkpoint '{name}' with {len(defs)} validation definition(s)")
```

Existing specs have no `checkpoint_group`, so the warehouse checkpoints keep their names (`critical`, `warning`). The LFS boundary spec produces `incoming_lfs_critical` and `incoming_lfs_warning`.

### A first `validate_incoming.py`

Create `quality/validate_incoming.py` (runs in `.venv-gx`). It reuses the Day 46–47 functions:

```python
"""Audit one incoming StatCan table with its checkpoint group.

Usage:  python quality/validate_incoming.py statcan_lfs_full
Exit:   0 pass · 1 critical failure · 2 warnings only
"""
import sys
from datetime import datetime, timezone

from gx_helpers import get_context
from run_checkpoints import history_rows, save_history, summarise

GROUPS = {
    "statcan_lfs_full": "incoming_lfs",
    "statcan_cpi_full": "incoming_cpi",
    "statcan_gdp_full": "incoming_gdp",
}


def main(table):
    group = GROUPS[table]
    context = get_context()
    run_time = datetime.now(timezone.utc)
    outcome, rows = {}, []

    for severity in ("critical", "warning"):
        try:
            cp = context.checkpoints.get(f"{group}_{severity}")
        except Exception:
            continue                                     # no suite of this severity yet
        result = cp.run()
        failed, lines = summarise(result)
        outcome[severity] = failed
        rows += history_rows(cp.name, result, run_time)
        print(f"{'✓' if failed == 0 else '✗'} {cp.name}: {failed} failing expectation(s)")
        print("\n".join(lines))

    if rows:
        save_history(rows, run_time)
    context.build_data_docs()

    if outcome.get("critical"):
        return 1
    if outcome.get("warning"):
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
```

```bash
source .venv-gx/bin/activate
python quality/setup_gx.py
python quality/build_suites.py
python quality/validate_incoming.py statcan_lfs_full; echo "exit: $?"
```

### Day 48 checklist
- [ ] I can explain Write–Audit–Publish and why it keeps the warehouse consistent
- [ ] Full StatCan tables (CPI, GDP, LFS) load into `raw_incoming`, compared against the last *published* release
- [ ] I profiled the raw LFS table and recorded member names, status codes, coverage and keys
- [ ] A boundary contract checks required columns, formats, keys and size
- [ ] Specs can declare a `checkpoint_group`; incoming tables have their own checkpoints
- [ ] `validate_incoming.py` audits one table and returns 0 / 1 / 2

```bash
deactivate; git add . && git commit -m "Day 48: WAP write step, LFS boundary contract, incoming checkpoints" && git push
```

---

# DAY 49 — The Headline Contracts

| Time | Block |
|---|---|
| 0:00 – 0:28 | 49.1 "Unemployment rates remain between 0 and 100%", precisely |
| 0:28 – 0:55 | 49.2 "Dates are continuous without gaps", precisely |
| 0:55 – 1:03 | Break |
| 1:03 – 1:28 | 49.3 Accounting identities: consistency within the release |
| 1:28 – 1:45 | 49.4 Cross-source and cross-release checks |
| 1:45 – 1:53 | Break |
| 1:53 – 2:10 | 49.5 Diagnostic analyses: from red cross to explanation |
| 2:10 – 2:30 | 49.6 Mini-project: the complete LFS contract |

All checks today follow one design: a **query asset** that shapes the raw text into what the rule needs, plus **expectations** on it. Add each query to `QUERY_ASSETS` in `quality/setup_gx.py`, with a whole-table batch definition, and write its spec in `quality/specs/incoming/` with `checkpoint_group: incoming_lfs`.

---

## 49.1 "Unemployment Rates Remain Between 0 and 100%", Precisely (28 min)

The curriculum's rule sounds simple, but turning it into a check forces precise decisions:

| Question | Our decision |
|---|---|
| Which rows are "rates"? | characteristics measured in percent: Unemployment rate, Participation rate, Employment rate (from the profile) |
| Estimates only? | yes: **standard errors** are not rates and get their own rule (≥ 0) |
| All geographies, genders, ages, data types? | **yes**: every published rate, not just the national headline |
| What about suppressed values (`value` null)? | not a range violation, but completeness is checked separately (below) |
| Text that isn't a number? | a separate critical check: every non-null value must parse |

### The query asset

```python
"incoming_lfs_rates": """
    select ref_date, geo, gender, age_group, data_type,
           labour_force_characteristics as characteristic,
           try_cast(value as double)    as rate
    from raw_incoming.statcan_lfs_full
    where statistics = 'Estimate'
      and labour_force_characteristics in
          ('Unemployment rate', 'Participation rate', 'Employment rate')
""",

"incoming_lfs_unparseable_values": """
    select vector, ref_date, value
    from raw_incoming.statcan_lfs_full
    where value is not null and try_cast(value as double) is null
""",

"incoming_lfs_standard_errors": """
    select vector, ref_date, statistics, try_cast(value as double) as se
    from raw_incoming.statcan_lfs_full
    where statistics <> 'Estimate'
""",
```

### The spec: `quality/specs/incoming/lfs_rates.yml`

```yaml
description: "Labour-market rates in the incoming LFS release. The curriculum's 0–100% contract."
asset: incoming_lfs_rates
batch_definition: full
checkpoint_group: incoming_lfs
owner: macro-team

critical:
  - type: ExpectColumnValuesToBeBetween
    kwargs: {column: rate, min_value: 0, max_value: 100}
    meta:
      plan_id: L01
      dimension: validity
      rationale: >
        Unemployment, participation and employment rates are shares of a population:
        every published estimate, for every province, gender, age group and data type,
        must lie between 0% and 100%.
      notes:
        format: markdown
        content:
          - "**If this fails:** the release is quarantined; inspect `raw_quarantine`."

  - type: ExpectTableRowCountToBeBetween
    kwargs: {min_value: 1000}
    meta: {plan_id: L02, dimension: completeness,
           rationale: "Guards against a filter silently matching nothing (renamed members)."}

warning:
  - type: ExpectColumnValuesToBeBetween
    kwargs: {column: rate, min_value: 0.5, max_value: 85, mostly: 0.999}
    meta: {plan_id: L03, dimension: plausibility,
           rationale: "Rates near 0% or near 100% are possible in tiny cells but deserve a look."}
```

And two short specs, `lfs_parseable.yml` (critical: `ExpectTableRowCountToEqual: {value: 0}` on `incoming_lfs_unparseable_values`) and `lfs_standard_errors.yml` (critical: `se ≥ 0`).

> **L02 is subtle but important.** If StatCan renamed "Unemployment rate" to "Unemployment rate (%)", the query would return **zero rows**, and *every* range check on zero rows passes. A minimum row count turns "nothing to check" into a failure. Always pair filtered checks with a row-count check.

### Suppression rule (completeness)

Missing values must be explained by a status code. From your profile, list the codes that accompany missing values (for example `..` or `x`):

```python
"incoming_lfs_unexplained_missing": """
    select vector, ref_date, status
    from raw_incoming.statcan_lfs_full
    where value is null
      and coalesce(trim(status), '') not in ('..', 'x', 'F')
""",
```

Spec: `ExpectTableRowCountToEqual: {value: 0}`, severity **warning** (plan L04). Adjust the code list to your profile.

---

## 49.2 "Dates Are Continuous Without Gaps", Precisely (28 min)

Again, precision first:

| Question | Our decision |
|---|---|
| Gaps in what? | **rows** (reference periods), per **series**, where a series is a `vector` |
| Suppressed values? | a row with a missing value is still a period that exists, so it's not a gap. Value completeness is 49.1's suppression rule |
| Terminated series? | excluded: they're *expected* to stop |
| Between what dates? | each series' own first and last month |

We check **three** aspects of continuity.

### (a) No internal gaps per series

The counting trick from Day 18: if a series spans *N* months from first to last, it must have exactly *N* distinct months.

```python
"incoming_lfs_series_gaps": """
    with s as (
        select vector, cast(ref_date || '-01' as date) as month
        from raw_incoming.statcan_lfs_full
        where coalesce(terminated, '') <> 't'
    )
    select vector,
           min(month)                                    as first_month,
           max(month)                                    as last_month,
           date_diff('month', min(month), max(month)) + 1 as expected_months,
           count(distinct month)                         as actual_months
    from s
    group by vector
    having date_diff('month', min(month), max(month)) + 1 <> count(distinct month)
""",
```

### (b) Release completeness: every active series reaches the latest month

A release where *most* series end in the newest month but some stop a month earlier is incomplete, even if no series has an internal gap.

```python
"incoming_lfs_series_not_at_latest": """
    with last_by_series as (
        select vector, max(ref_date) as last_ref
        from raw_incoming.statcan_lfs_full
        where coalesce(terminated, '') <> 't'
        group by vector
    )
    select vector, last_ref,
           (select max(ref_date) from raw_incoming.statcan_lfs_full) as release_latest
    from last_by_series
    where last_ref < (select max(ref_date) from raw_incoming.statcan_lfs_full)
""",
```

(`ref_date` is `'YYYY-MM'` text, which sorts correctly as text. That's one reason ISO-style date formats are so convenient.)

### (c) No future periods, and a fresh latest period

```python
"incoming_lfs_period_bounds": """
    select max(cast(ref_date || '-01' as date))                       as latest_month,
           date_diff('month', max(cast(ref_date || '-01' as date)),
                     cast(date_trunc('month', current_date) as date)) as months_behind
    from raw_incoming.statcan_lfs_full
""",
```

### The spec: `quality/specs/incoming/lfs_continuity.yml` (three assets, three small specs)

```yaml
# lfs_continuity_gaps.yml
description: "No missing months inside any active LFS series — the curriculum's continuity contract."
asset: incoming_lfs_series_gaps
batch_definition: full
checkpoint_group: incoming_lfs
owner: macro-team
critical:
  - type: ExpectTableRowCountToEqual
    kwargs: {value: 0}
    meta:
      plan_id: L10
      dimension: completeness
      rationale: >
        Every active series must have one row for every month between its first and last
        observation. A gap breaks year-over-year calculations (Day 5, Day 19).
```

```yaml
# lfs_continuity_latest.yml
asset: incoming_lfs_series_not_at_latest
batch_definition: full
checkpoint_group: incoming_lfs
owner: macro-team
critical:
  - type: ExpectTableRowCountToEqual
    kwargs: {value: 0}
    meta: {plan_id: L11, dimension: completeness,
           rationale: "A release must update every active series to the same latest month."}
```

```yaml
# lfs_continuity_bounds.yml
asset: incoming_lfs_period_bounds
batch_definition: full
checkpoint_group: incoming_lfs
owner: macro-team
critical:
  - type: ExpectColumnValuesToBeBetween
    kwargs: {column: months_behind, min_value: 0}
    meta: {plan_id: L12, dimension: validity, rationale: "No reference period in the future."}
warning:
  - type: ExpectColumnValuesToBeBetween
    kwargs: {column: months_behind, max_value: 2}
    meta: {plan_id: L13, dimension: timeliness,
           rationale: >
             The LFS is usually released early in the month after the reference month,
             so the latest period should be at most ~2 months behind today.}
```

### Try it 49.2

Why do we check continuity on **rows** (periods) rather than **non-missing values**? Construct a small example where a gap check on non-missing values would raise a false alarm.

<details>
<summary>Answer</summary>

Suppose a youth unemployment rate for a small province is suppressed (`x`) in one month because too few respondents fell in that cell. The **row** for that month exists, with an empty value and a status code. A value-based gap check would call it a "missing month", but it's a legitimate, documented confidentiality suppression. Checking continuity on rows, and completeness of values separately via the suppression rule, keeps the two concepts apart and avoids false alarms.

</details>

---

## 49.3 Accounting Identities: Consistency Within the Release (25 min)

Labour-market statistics obey definitions that link characteristics together. These make powerful **consistency** checks, because a processing error in one characteristic breaks the identity.

| Identity | Definition |
|---|---|
| Labour force = Employment + Unemployment | who is in the labour force |
| Unemployment rate = 100 × Unemployment ÷ Labour force | the headline rate |
| Participation rate = 100 × Labour force ÷ Population | labour-force participation |

Published values are **rounded** (counts to 0.1 thousand, rates to 0.1pp), so recomputed values won't match exactly, especially in small cells (Try it 48.4). We use **two tiers**:

| Tier | Tolerance | Severity | Catches |
|---|---|---|---|
| gross error | ±2pp for rates; ±1 thousand for counts | critical | misaligned columns, swapped characteristics, unit errors |
| rounding-consistent | ±0.3pp for rates, for at least 99% of cells | warning | subtler processing issues |

### The query asset

```python
"incoming_lfs_identities": """
    with e as (
        select ref_date, geo, gender, age_group, data_type,
               labour_force_characteristics as lfc,
               try_cast(value as double)    as v
        from raw_incoming.statcan_lfs_full
        where statistics = 'Estimate'
    ),
    w as (
        select ref_date, geo, gender, age_group, data_type,
               max(v) filter (where lfc = 'Population')          as pop,
               max(v) filter (where lfc = 'Labour force')        as lf,
               max(v) filter (where lfc = 'Employment')          as emp,
               max(v) filter (where lfc = 'Unemployment')        as unemp,
               max(v) filter (where lfc = 'Unemployment rate')   as ur,
               max(v) filter (where lfc = 'Participation rate')  as pr
        from e
        group by all
    )
    select *,
           lf - (emp + unemp)                      as lf_error_thousands,
           ur - 100 * unemp / nullif(lf, 0)        as ur_error_pp,
           pr - 100 * lf / nullif(pop, 0)          as pr_error_pp
    from w
    where lf is not null and emp is not null and unemp is not null
""",
```

This is the conditional-aggregation pivot from Day 14, applied to raw text on the fly.

### The spec: `quality/specs/incoming/lfs_identities.yml`

```yaml
description: "Accounting identities linking LFS characteristics, with rounding-aware tolerances."
asset: incoming_lfs_identities
batch_definition: full
checkpoint_group: incoming_lfs
owner: macro-team

critical:
  - type: ExpectColumnValuesToBeBetween
    kwargs: {column: lf_error_thousands, min_value: -1, max_value: 1}
    meta: {plan_id: L20, dimension: consistency,
           rationale: "Labour force = employment + unemployment; >1,000 persons off means a real error."}
  - type: ExpectColumnValuesToBeBetween
    kwargs: {column: ur_error_pp, min_value: -2, max_value: 2}
    meta: {plan_id: L21, dimension: consistency,
           rationale: "Published unemployment rate must match unemployment ÷ labour force (gross-error tier)."}
  - type: ExpectColumnValuesToBeBetween
    kwargs: {column: pr_error_pp, min_value: -2, max_value: 2}
    meta: {plan_id: L22, dimension: consistency}

warning:
  - type: ExpectColumnValuesToBeBetween
    kwargs: {column: ur_error_pp, min_value: -0.3, max_value: 0.3, mostly: 0.99}
    meta: {plan_id: L23, dimension: consistency,
           rationale: >
             Rounding of published counts explains small differences, largest in small cells.
             More than 1% of cells beyond ±0.3pp suggests a processing issue.}
```

Profile the error columns first (`quantile_cont(abs(ur_error_pp), [0.5, 0.99, 0.999])`) and adjust the tolerances. The goal is **zero false alarms on a good release** while still catching real errors.

> **Economist's note:** identities are among the strongest quality checks available, because they're true **by definition**, not by statistical tendency. National accounts (GDP = C + I + G + NX, up to chained-dollar non-additivity; Day 20) and price indexes (weighted components; Day 19) offer similar checks. Look for them in every dataset you validate.

---

## 49.4 Cross-Source and Cross-Release Checks (18 min)

### Cross-source: the vector we ingest vs the full table

Since Day 10 we've fetched the national unemployment rate as **vector v2062815**, and on Day 10 you verified its title by hand. The full LFS table contains the same vector, so we can check that the two paths agree **and** that the vector belongs to this table.

```python
"incoming_lfs_vector_check": """
    select t.ref_date,
           try_cast(t.value as double)                 as table_value,
           o.value                                     as vector_value,
           abs(try_cast(t.value as double) - o.value)  as abs_diff
    from raw_incoming.statcan_lfs_full as t
    join raw_dlt.statcan_observations as o
      on o.series_id = t.vector
     and o.date = cast(t.ref_date || '-01' as date)
    where t.vector = 'v2062815'
""",
```

Spec (`lfs_vector_check.yml`):
- **critical** `ExpectColumnValuesToBeBetween(column="abs_diff", max_value=1e-9)`: the two sources agree (plan L30);
- **critical** `ExpectTableRowCountToBeBetween(min_value=100)`: the vector really is in this table, with a long overlap (plan L31). If it isn't, the join returns nothing and L30 would pass vacuously.

(As on Day 41, a newer month in one source than the other isn't a disagreement: the inner join only compares months present in both.)

### Cross-release: how much did this release revise?

StatCan revises LFS estimates, and seasonally adjusted series are typically revised each **January** for recent years. Compare the incoming release with the **currently published** one:

```python
"incoming_lfs_revisions": """
    select n.vector, n.ref_date, n.geo,
           try_cast(o.value as double) as published_value,
           try_cast(n.value as double) as incoming_value,
           abs(try_cast(n.value as double) - try_cast(o.value as double)) as abs_revision_pp
    from raw_incoming.statcan_lfs_full as n
    join raw_dlt.statcan_lfs_full      as o using (vector, ref_date)
    where n.labour_force_characteristics = 'Unemployment rate'
      and n.statistics = 'Estimate'
      and abs(try_cast(n.value as double) - try_cast(o.value as double)) > 0.3
""",
```

Spec: **warning** `ExpectTableRowCountToEqual(value=0)` (plan L32), with a rationale that makes the calendar explicit:

```yaml
    meta:
      plan_id: L32
      dimension: consistency
      rationale: >
        Outside the annual seasonal-adjustment revision (typically January), published
        unemployment rates should rarely be revised by more than 0.3pp. In January this
        warning is expected: review and acknowledge it in the release log.
```

> This asset needs a **published** `raw_dlt.statcan_lfs_full` to compare against, so register it **after** the first successful publish (Day 50). It's a warning, never critical: revisions are a normal part of official statistics, and our job is to make them **visible**, not to block them.

---

## 49.5 Diagnostic Analyses: from Red Cross to Explanation (18 min)

A failing expectation says *that* something is wrong; the person on call needs to know *where* and *why*. Keep diagnostic queries next to the specs, in `quality/diagnostics/`, one per critical check.

**`quality/diagnostics/lfs_missing_months.sql`**: which months are missing, for which series (for L10):

```sql
-- Lists every missing month inside every active LFS series in raw_incoming.
with s as (
    select vector, cast(ref_date || '-01' as date) as month
    from raw_incoming.statcan_lfs_full
    where coalesce(terminated, '') <> 't'
),
bounds as (
    select vector, min(month) as first_month, max(month) as last_month
    from s group by vector
),
expected as (
    select b.vector, cast(m.month as date) as month
    from bounds as b,
         range(b.first_month, b.last_month + interval 1 month, interval 1 month) as m(month)
)
select e.vector, e.month
from expected as e
anti join s using (vector, month)
order by e.vector, e.month
limit 100;
```

The date-spine plus anti-join technique is from Day 14. `range(...)` here is a **lateral** table function: it's evaluated once per row of `bounds`, producing each series' own calendar.

**`quality/diagnostics/lfs_identity_outliers.sql`**: the worst identity violations with their context (for L20–L23):

```sql
-- Paste the incoming_lfs_identities query as a CTE named ident, then:
select ref_date, geo, gender, age_group, data_type, lf, emp, unemp, ur,
       round(ur_error_pp, 2) as ur_error_pp
from ident
order by abs(ur_error_pp) desc nulls last
limit 20;
```

Reference each diagnostic in its spec's `notes`, so Data Docs tells the reader **which query to run next**:

```yaml
      notes:
        format: markdown
        content:
          - "**Diagnose with:** `quality/diagnostics/lfs_missing_months.sql`"
```

---

## 49.6 Mini-Project: The Complete LFS Contract (20 min)

1. Add every query asset from today to `quality/setup_gx.py` (except `incoming_lfs_revisions`, which comes after the first publish).
2. Write all specs in `quality/specs/incoming/` with `checkpoint_group: incoming_lfs`, calibrated to your profile.
3. Add the checks to `DATA_QUALITY_PLAN.md` (IDs B01–B07, L01–L32), each with dimension, severity and owner.
4. Rebuild and audit:

```bash
source .venv-gx/bin/activate
python quality/setup_gx.py && python quality/build_suites.py
python quality/validate_incoming.py statcan_lfs_full; echo "exit: $?"
```

5. **Goal: a genuine release passes all critical checks.** If a critical check fails on real data, decide *with evidence* (diagnostics) whether the data is wrong or the check is miscalibrated, and write the decision in `quality/specs/REVIEW_LOG.md`.
6. Write lighter contracts for `incoming_cpi` and `incoming_gdp`: the boundary structure (required columns, `ref_date` format, unique `(vector, ref_date)`, row count) plus continuity per vector. The LFS queries are templates, since only the table name and dimension names change.

### Day 49 checklist
- [ ] "Rates between 0 and 100%" is implemented for every published rate, with a row-count guard and separate rules for standard errors and suppressed values
- [ ] "Dates continuous" is implemented per series (internal gaps), per release (all series reach the latest month) and against the calendar (no future periods, freshness)
- [ ] Accounting identities are checked with rounding-aware, two-tier tolerances
- [ ] The ingested vector is checked against the full table; revisions are measured against the published release
- [ ] Every critical check has a diagnostic query referenced in its notes
- [ ] A genuine release passes all critical checks; calibration decisions are logged

```bash
git add quality/ && git commit -m "Day 49: LFS contract — rates, continuity, identities, cross-source" && git push
```

---

# DAY 50 — Publish or Quarantine, and Closing the Loop

| Time | Block |
|---|---|
| 0:00 – 0:28 | 50.1 Completing WAP: audit in a separate process, publish or quarantine |
| 0:28 – 0:53 | 50.2 Fault injection: prove the gate works |
| 0:53 – 1:00 | Break |
| 1:00 – 1:28 | 50.3 dbt: labour-market marts from published data |
| 1:28 – 1:45 | 50.4 Data quality as a warehouse KPI |
| 1:45 – 1:53 | Break |
| 1:53 – 2:15 | 50.5 The final pipeline and runbook |
| 2:15 – 2:30 | 50.6 Module 5 recap and bridge to orchestration |

---

## 50.1 Completing WAP (28 min)

Two design decisions shape the final orchestrator.

**1. Audit in a separate process.** GX runs in `.venv-gx` (Day 42). The orchestrator runs in `.venv` (dlt). So the orchestrator calls GX as a **subprocess**. This also solves a subtle DuckDB issue: two different database engines in one process can't both open the same file, but separate processes can take turns. When the subprocess ends, its connection and lock are gone.

**2. Publish atomically per table; record the marker afterwards.** Copy `raw_incoming.<table>` → `raw_dlt.<table>` inside one DuckDB transaction. Then record the release as published (Day 30's rule: *markers after success*).

Replace `main()` in `ingest_statcan_tables.py` and add:

```python
import subprocess
from datetime import datetime, timezone

from macro_ingest.resilience import notify

GX_PYTHON = ".venv-gx/bin/python"


def audit(table):
    """AUDIT: run the GX checkpoint group for one incoming table in the GX environment."""
    proc = subprocess.run([GX_PYTHON, "quality/validate_incoming.py", table])
    return proc.returncode                          # 0 pass · 1 critical · 2 warnings


def publish(con, table):
    """PUBLISH: atomically replace the production raw table with the audited copy."""
    con.execute("begin transaction")
    con.execute(f"create or replace table raw_dlt.{table} as select * from raw_incoming.{table}")
    con.execute("commit")


def quarantine(con, table, stamp):
    """QUARANTINE: keep the failed release for investigation; production is untouched."""
    con.execute("create schema if not exists raw_quarantine")
    con.execute(f"create or replace table raw_quarantine.{table}__{stamp} "
                f"as select * from raw_incoming.{table}")


def record_published(current, product_ids):
    pipeline = dlt.pipeline(pipeline_name="macro_ingest", destination="duckdb",
                            dataset_name="raw_dlt")
    now = datetime.now(timezone.utc)
    pipeline.run([{"product_id": pid, "release_time": current.get(pid), "loaded_at": now}
                  for pid in product_ids],
                 table_name="statcan_releases", write_disposition="append")


def main():
    changed, current = changed_tables()
    if not changed:
        print("✓ No StatCan table republished since last publish — nothing to do.")
        return 0

    write_incoming(changed)                                           # WRITE
    verdicts = {pid: audit(table) for pid, table in changed.items()}  # AUDIT

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    published, quarantined, warned = [], [], []
    with duckdb.connect(DB) as con:                                   # PUBLISH / QUARANTINE
        for pid, table in changed.items():
            if verdicts[pid] in (0, 2):
                publish(con, table)
                published.append(pid)
                if verdicts[pid] == 2:
                    warned.append(table)
            else:
                quarantine(con, table, stamp)
                quarantined.append(table)

    if published:
        record_published(current, published)                          # markers after success

    print(f"published: {[changed[p] for p in published]} | quarantined: {quarantined}")
    if quarantined:
        notify(f"⛔ StatCan release QUARANTINED: {quarantined}. Production keeps the last good "
               f"release. Inspect raw_quarantine.*__{stamp} and Data Docs.")
    elif warned:
        notify(f"⚠ StatCan release published with warnings: {warned}. Review Data Docs.")

    if quarantined and not published:
        return 1
    if quarantined or warned:
        return 2
    return 0
```

### Why is this safe?

| Failure point | What production sees |
|---|---|
| download fails during WRITE | nothing changes (`raw_incoming` is incomplete, but unused) |
| audit fails (critical) | nothing changes; the release is quarantined; alert |
| publish transaction fails midway | the transaction rolls back; the old table remains |
| marker recording fails after publish | data is published; the next run re-publishes the same release (harmless, idempotent) |

> The table names in the SQL come from **your own configuration**, not from user input, so building SQL with f-strings is acceptable here. Never do this with values that come from outside (Day 13's SQL-injection warning).

### First publish

```bash
source .venv/bin/activate
python ingest_statcan_tables.py --full-refresh; echo "exit: $?"
duckdb macro.duckdb -readonly -c "select * from raw_dlt.statcan_releases order by loaded_at desc limit 5"
```

Now that `raw_dlt.statcan_lfs_full` exists, register the **revisions** asset (49.4) and its spec, and rebuild the GX objects.

---

## 50.2 Fault Injection: Prove the Gate Works (25 min)

A safety gate you haven't seen close is a hope, not a gate. Following Day 29's habit, **inject faults deliberately**, only into `raw_incoming`, and confirm the audit catches each one.

Create `quality/chaos_incoming.py` (runs in `.venv-gx`; it only modifies the holding schema):

```python
"""Inject deliberate faults into raw_incoming.statcan_lfs_full to test the audit.

NEVER run against raw_dlt. Usage: python quality/chaos_incoming.py <scenario>
Restore afterwards with:  python ingest_statcan_tables.py --full-refresh  (from .venv)
"""
import sys

import duckdb

from gx_helpers import PROJECT_ROOT

DB = str(PROJECT_ROOT.parent / "macro.duckdb")
T = "raw_incoming.statcan_lfs_full"

SCENARIOS = {
    # Unit error: one unemployment rate ×10 → L01 (0–100%) must fail
    "rate_out_of_range": f"""
        update {T} set value = '64.0'
        where rowid = (select min(rowid) from {T}
                       where labour_force_characteristics = 'Unemployment rate'
                         and statistics = 'Estimate' and try_cast(value as double) between 6 and 7)
    """,
    # Missing month inside one series (its 13th month) → L10 (continuity) must fail
    "gap_in_series": f"""
        delete from {T}
        where (vector, ref_date) = (
            select vector, ref_date from {T}
            where vector = (select min(vector) from {T})
            order by ref_date limit 1 offset 12)
    """,
    # Renamed dimension (Gender → Sex) → B01 (required columns) must fail
    "renamed_column": f"alter table {T} rename column gender to sex",
    # Identity broken: unemployment count doubled in one cell → L20/L21 must fail
    "identity_broken": f"""
        update {T} set value = cast(try_cast(value as double) * 2 as varchar)
        where rowid = (select min(rowid) from {T}
                       where labour_force_characteristics = 'Unemployment'
                         and statistics = 'Estimate' and try_cast(value as double) > 100)
    """,
}

if __name__ == "__main__":
    scenario = sys.argv[1]
    with duckdb.connect(DB) as con:
        for statement in SCENARIOS[scenario].split(";"):
            if statement.strip():
                con.execute(statement)
    print(f"⚡ injected scenario '{scenario}' into {T}")
```

(`rowid` is DuckDB's internal row number, a handy way to target exactly one row. The `gap_in_series` scenario deletes the 13th month of one series, **inside** its range, so it creates a genuine internal gap rather than just shortening the series.)

### The test protocol

For each scenario:

```bash
source .venv-gx/bin/activate
python quality/chaos_incoming.py rate_out_of_range
python quality/validate_incoming.py statcan_lfs_full; echo "exit: $?"   # expect 1, naming L01
deactivate

source .venv && python ingest_statcan_tables.py --full-refresh           # restore raw_incoming
```

Record the results in `quality/CHAOS_RESULTS.md`:

| Scenario | Expected failing check | Observed | Exit code | Pass? |
|---|---|---|---|---|
| rate_out_of_range | L01 | | | |
| gap_in_series | L10 | | | |
| renamed_column | B01 (and the queries depending on `gender`) | | | |
| identity_broken | L20 / L21 | | | |

Then run **one** scenario through the full orchestrator to see the quarantine path end to end:

```bash
# (inside ingest_statcan_tables.py, temporarily skip write_incoming() so the injected data is audited)
python ingest_statcan_tables.py --full-refresh; echo "exit: $?"
duckdb macro.duckdb -readonly -c "select table_name from information_schema.tables where table_schema = 'raw_quarantine'"
```

Confirm that `raw_dlt.statcan_lfs_full` is **unchanged**, a quarantine table exists, and an alert was printed or sent. Then restore the `write_incoming()` call.

> **Notice what `renamed_column` teaches.** In the notebook, a Gender/Sex rename was absorbed silently by an `if/elif`. Here it stops publication and alerts. The right response is then deliberate: update `stg_statcan__lfs` to the new name, adjust the contract, and re-run. The contract turns a silent patch into a reviewed decision.

---

## 50.3 dbt: Labour-Market Marts from Published Data (28 min)

Now the warehouse can build on the audited LFS table.

### Source and staging

Add to `macro_dbt/models/staging/statcan/_statcan__sources.yml`:

```yaml
      - name: lfs_full
        identifier: statcan_lfs_full
        description: "StatCan 14-10-0287-01 (LFS), published only after passing the GX incoming audit (WAP)."
```

`macro_dbt/models/staging/statcan/stg_statcan__lfs.sql`:

```sql
-- Source: raw_dlt.statcan_lfs_full (audited; WAP)
-- Grain:  one row per month × geography × characteristic × gender × age group × statistic × data type
with source as (

    select * from {{ source('statcan', 'lfs_full') }}

),

renamed as (

    select
        cast(ref_date || '-01' as date)       as month,
        geo,
        labour_force_characteristics          as characteristic,
        gender,
        age_group,
        statistics                            as statistic,
        data_type,
        uom                                   as unit,
        vector                                as vector_id,
        try_cast(value as double)             as value,
        nullif(trim(status), '')              as status_flag,
        coalesce(terminated = 't', false)     as is_terminated
    from source

)

select r.*, g.geo_code, coalesce(g.geo_level, 'other') as geo_level
from renamed as r
left join {{ ref('seed_geo') }} as g using (geo)
```

### Intermediate: the headline labour-market panel

`macro_dbt/models/intermediate/labour/int_lfs__headline.sql`:

```sql
-- Grain: one row per month × geography (Canada + provinces).
-- Seasonally adjusted estimates, all genders, 15 years and over.
select
    month,
    geo,
    geo_code,
    max(value) filter (where characteristic = 'Unemployment rate')   as unemployment_rate,
    max(value) filter (where characteristic = 'Participation rate')  as participation_rate,
    max(value) filter (where characteristic = 'Employment rate')     as employment_rate,
    max(value) filter (where characteristic = 'Employment')          as employment_thousands,
    max(value) filter (where characteristic = 'Labour force')        as labour_force_thousands
from {{ ref('stg_statcan__lfs') }}
where statistic = 'Estimate'
  and data_type = 'Seasonally adjusted'
  and age_group = '15 years and over'
  and gender    = 'Total - Gender'
  and geo_level in ('national', 'province')
group by all
```

(Use the exact member names from your profile notes.)

### Mart: provincial labour markets

`macro_dbt/models/marts/labour/lfs_provincial_monthly.sql`:

```sql
-- Grain: one row per month × geography. Dashboard mart for provincial labour markets.
with h as (

    select * from {{ ref('int_lfs__headline') }}

),

national as (

    select month, unemployment_rate as national_unemployment_rate
    from h where geo_code = 'CA'

)

select
    h.*,
    h.unemployment_rate - n.national_unemployment_rate                       as ur_gap_vs_canada_pp,
    h.unemployment_rate
      - lag(h.unemployment_rate, 12) over (partition by h.geo order by h.month) as ur_change_12m_pp,
    {{ pct_change('h.employment_thousands',
                  'lag(h.employment_thousands, 12) over (partition by h.geo order by h.month)') }}
                                                                             as employment_growth_yoy
from h
left join national as n using (month)
```

Tests in `_labour__models.yml`, reusing Module 4's tools:

```yaml
version: 2

models:
  - name: lfs_provincial_monthly
    description: "Provincial and national labour-market indicators (LFS, SA, 15+, all genders)."
    data_tests:
      - dbt_utils.unique_combination_of_columns:
          combination_of_columns: [month, geo]
    columns:
      - name: month
        data_tests:
          - is_first_of_period: {period: month}
          - dbt_utils.sequential_values:
              interval: 1
              datepart: month
              group_by_columns: ['geo']
      - name: unemployment_rate
        data_tests:
          - within_range: {min_value: 0, max_value: 100}
      - name: participation_rate
        data_tests:
          - within_range: {min_value: 0, max_value: 100}
```

Yes, 0–100% and continuity appear **again**, now at the mart. Defence in depth: GX guards the **boundary** (what StatCan sent), dbt guards the **transformation** (what we built). If a future staging change broke continuity, dbt would catch it even though the raw data was fine.

Add the mart to the `rates_fx_dashboard` or a new `labour_dashboard` **exposure** (Day 40), then:

```bash
cd macro_dbt && source ../.venv/bin/activate
dbt build --target prod --select +lfs_provincial_monthly
```

---

## 50.4 Data Quality as a Warehouse KPI (18 min)

On Day 47 you previewed reading the GX history into dbt. Let's finish it, so that data quality appears in the **macro cockpit** next to the economic KPIs.

`macro_dbt/models/staging/quality/_quality__sources.yml` (from Day 47), then `stg_quality__gx_results.sql`:

```sql
-- Grain: one row per expectation per GX run
select
    cast(run_time as timestamp)   as run_time,
    checkpoint,
    suite,
    asset,
    plan_id,
    dimension,
    expectation_type,
    column_name,
    success,
    unexpected_count
from {{ source('quality', 'gx_results') }}
```

`macro_dbt/models/marts/quality/quality_latest.sql`:

```sql
-- Grain: one row per checkpoint, for its most recent run.
with latest as (

    select checkpoint, max(run_time) as run_time
    from {{ ref('stg_quality__gx_results') }}
    group by checkpoint

)

select
    r.checkpoint,
    r.run_time,
    count(*)                                         as checks,
    count(*) filter (where not r.success)            as failures,
    round(100.0 * avg(r.success::int), 1)            as pct_passing,
    list(distinct r.plan_id) filter (where not r.success) as failing_plan_ids
from {{ ref('stg_quality__gx_results') }} as r
join latest using (checkpoint, run_time)
group by all
```

Add a KPI to `macro_kpis` (Day 39): a union branch with pillar `P0 Data quality`, KPI *"% warehouse checks passing"*, taken from `quality_latest` where `checkpoint = 'critical'`, with signal `negative` below 100. Now the one-screen status says not only *how the economy is doing* but *how much to trust the numbers*.

> **Ordering matters.** `quality_latest` reads the history written by GX runs. In the final pipeline (next block), the warehouse GX checks run **after** dbt. So the KPI shows the *previous* run's warehouse checks, plus the *current* run's incoming audits. Say so in the model's description. It's a trade-off, not a bug.

---

## 50.5 The Final Pipeline and Runbook (23 min)

### `pipeline.sh`: the complete flow after Module 5

```bash
#!/usr/bin/env bash
# pipeline.sh — APIs → WAP StatCan tables → dbt → warehouse quality → docs
set -e
cd "$(dirname "$0")"
source .venv/bin/activate
export MACRO_DUCKDB_PATH="${MACRO_DUCKDB_PATH:-macro.duckdb}"
export MACRO_DUCKDB_URL="${MACRO_DUCKDB_URL:-duckdb:///$(pwd)/macro.duckdb}"

# 1. API series (BoC, FRED, StatCan vectors): direct, incremental, contracted
python ingest.py --only boc,fred,statcan || [ $? -eq 2 ]

# 2. Full StatCan tables: WRITE → AUDIT (GX) → PUBLISH or QUARANTINE
python ingest_statcan_tables.py || [ $? -eq 2 ]          # 2 = some warnings/quarantine; warehouse stays consistent

# 3. Transform & test (dbt, prod) — builds only from published data
mkdir -p data/marts
( cd macro_dbt && dbt deps --quiet && dbt build --target prod && dbt docs generate --target prod )

# 4. Warehouse quality (GX critical/warning checkpoints, Data Docs, history)
set +e
./quality/run_quality.sh
quality_status=$?
set -e
if [ $quality_status -eq 1 ]; then
    echo "⛔ Critical warehouse quality failure — marts must not be used. See Data Docs."
    exit 1
fi
[ $quality_status -eq 2 ] && echo "⚠ Quality warnings — review Data Docs."

echo "✓ Pipeline complete"
```

The flow at a glance:

```
BoC · FRED · StatCan vectors ──► ingest.py ─────────────────────────────► raw_dlt.*_observations
StatCan full tables ────────────► ingest_statcan_tables.py
                                    WRITE  raw_incoming.*
                                    AUDIT  GX incoming_* checkpoints (0–100%, continuity, identities…)
                                    PUBLISH raw_dlt.statcan_*_full   │  QUARANTINE raw_quarantine.*
                                                                       ▼
                                         dbt build (prod): staging → intermediate → marts (+ dbt tests)
                                                                       ▼
                                         GX critical/warning on staging & marts → Data Docs, history
                                                                       ▼
                                         data/marts/*.parquet → dashboards · macro_kpis (incl. quality)
```

### Runbook additions

Append to `RUNBOOK.md` (Day 30):

```markdown
## StatCan release quarantined
1. Read the alert: which table, which timestamp.
2. Open Data Docs → latest `incoming_<table>_critical` run → failing expectations and their plan IDs.
3. Run the diagnostic query named in the failing expectation's notes, against
   `raw_quarantine.<table>__<timestamp>` (edit the table name in the query).
4. Decide, and write the decision in quality/specs/REVIEW_LOG.md:
   a) **StatCan error** → keep quarantined; production stays on the previous release.
      Re-check when StatCan republishes (the next release is audited automatically).
   b) **Legitimate change** (e.g. dimension renamed, new member) → update staging and the
      contract spec in one reviewed change; re-run `python ingest_statcan_tables.py --full-refresh`.
   c) **Miscalibrated check** → adjust the threshold with evidence; re-run.
5. Never publish a quarantined table by hand without a written, reviewed decision.

## Chaos testing (quarterly)
Run every scenario in quality/chaos_incoming.py against raw_incoming and update CHAOS_RESULTS.md.
```

### Final check

```bash
./pipeline.sh; echo "exit: $?"
```

---

## 50.6 Module 5 Recap and Bridge to Orchestration (15 min)

### What you built in Module 5 (Days 41–50)

| Days | Capability |
|---|---|
| 41 | quality dimensions, contracts, severities; a data quality plan |
| 42–43 | GX environment, data context, DuckDB data source, assets at every layer, smoke checks |
| 44 | suites as code from reviewed YAML specs, linked to the plan |
| 45 | profiling that drafts expectations; economists calibrate; checks on changes and distributions |
| 46 | validation definitions, critical/warning checkpoints, exit codes, one alert channel |
| 47 | Data Docs for non-engineers; a queryable history; trends |
| 48 | Write–Audit–Publish; the LFS table; a boundary contract; checkpoint groups |
| 49 | 0–100% rates and continuous dates, precisely; identities; cross-source and revision checks; diagnostics |
| 50 | publish or quarantine; fault injection; labour-market marts; quality as a KPI; the complete pipeline |

### Defence in depth: where each safeguard lives

| Safeguard | Tool | Question |
|---|---|---|
| resilient extraction | dlt + resilience layer (Module 3) | *Did we receive the data?* |
| schema contracts | dlt (Day 25) | *Does it have the shape we expect?* |
| **boundary audit (WAP)** | **GX (Days 48–50)** | ***Is this release fit to publish?*** |
| transformation tests | dbt (Day 36) | *Did our models preserve meaning?* |
| mart contracts | dbt (Day 40) | *Is the product's shape stable?* |
| warehouse validation | GX (Days 44–47) | *Is what consumers see correct and fresh?* |
| quality KPI | dbt + GX history | *How much should decision-makers trust today's numbers?* |

### What still hurts: the case for orchestration

`pipeline.sh` works, but look at what it can't do:

| Limitation | Example |
|---|---|
| no schedule | someone must run it; LFS release days aren't known in advance |
| all-or-nothing retries | a flaky FRED call reruns the *whole* pipeline |
| no visibility | "Did last night's run succeed? How long did the audit take?" means reading logs |
| no concurrency control | two overlapping runs would fight over the DuckDB lock |
| exit-code juggling | `|| [ $? -eq 2 ]` and `set +e` are fragile ways to express decisions |

**Module 6 (Days 51–60): Prefect.** Each step becomes a **task** inside a **flow**, with per-task retries, caching, scheduling, logging and a UI. On Days 58–60 you'll orchestrate the daily refresh, linking dlt extraction, the WAP audit, dbt transformations and GX validation, triggered by StatCan's release signals from Day 27.

### Day 50 checklist
- [ ] The orchestrator writes, audits (GX in a separate process), and publishes or quarantines each table atomically
- [ ] Release markers are recorded only after successful publication
- [ ] Every fault-injection scenario is caught by the intended check, and production data stays untouched
- [ ] dbt builds provincial labour-market marts from audited data, with the 0–100% and continuity rules re-tested at the mart
- [ ] Data quality appears as a KPI in the macro cockpit, with its timing documented
- [ ] `pipeline.sh` runs the complete flow, and the runbook explains how to handle a quarantined release

```bash
git add .
git commit -m "Day 50: WAP publish/quarantine, chaos tests, LFS marts, quality KPI — Module 5 complete"
git push
```
