# Module 5 · Quality Assurance with Great Expectations
## Days 44–47: Expectation Suites, Profiling Datasets, Checkpoints & Automated Data Docs

**Audience:** MSc Economics students who completed Days 1–43
**Environment:** GitHub Codespaces · `.venv-gx` · the `quality/` GX project connected to `macro.duckdb` (Day 43)
**Time per day:** ~2.5 hours (including breaks and exercises)
**Goal by end of Day 47:** The data quality plan from Day 41 is fully **executable**. Expectation suites are generated from reviewed YAML specifications ("suites as code"), and profiling of the actual data proposes thresholds that economists confirm. Checkpoints separate **critical** from **warning** checks, and every run produces a browsable **Data Docs** website plus a validation **history** you can query and trend in DuckDB.

---

### Where we are

After Day 43 you have:

| Piece | File |
|---|---|
| A quality plan with IDs, dimensions, severities, owners | `quality/DATA_QUALITY_PLAN.md` |
| A file-based GX project | `quality/gx/` |
| DuckDB data source, table/query assets, whole-table and monthly batch definitions | `quality/setup_gx.py` |
| A handful of critical checks run one by one | `quality/smoke_check.py` |

What's missing is **structure**. Expectations are scattered in a Python list, there's no separation of critical from warning checks, no reusable validation runs, no human-readable output, and no memory of past results.

| Day | Theme |
|---|---|
| 44 | **Expectation suites:** design principles, suites-as-code from YAML specs, reading suite results |
| 45 | **Profiling datasets:** let the data propose expectations, and let economists decide |
| 46 | **Validation definitions & checkpoints:** critical vs warning runs, actions, exit codes |
| 47 | **Automated Data Docs & history:** a quality website and a queryable record of every run |

### Target structure (by end of Day 47)

```
quality/
├── DATA_QUALITY_PLAN.md
├── requirements-gx.txt
├── gx_helpers.py
├── setup_gx.py              ← data source, assets, batch definitions (Day 43, extended)
├── specs/                   ← NEW: reviewed expectation specifications (YAML), one per asset
│   ├── unemployment_rate.yml
│   ├── unemployment_rate_changes.yml
│   ├── stg_statcan__cpi.yml
│   ├── macro_monthly.yml
│   ├── fct_open_economy_daily.yml
│   ├── raw_statcan_cpi_full.yml
│   ├── cpi_vector_vs_table_mismatches.yml
│   └── drafts/              ← profiler output, awaiting review
├── build_suites.py          ← NEW: specs → suites → validation definitions → checkpoints
├── profile_assets.py        ← NEW: profiling + draft expectations
├── run_checkpoints.py       ← NEW: run critical/warning checkpoints, report, record history
├── run_quality.sh           ← NEW: one command for the whole quality layer
└── gx/                      ← GX Data Context (suites, definitions, checkpoints, Data Docs)
data/quality/runs/*.parquet  ← NEW: validation history (not committed)
```

Always activate the GX environment first:

```bash
cd /workspaces/macro-data-course
source .venv-gx/bin/activate
pip install pyyaml pyarrow && pip freeze > quality/requirements-gx.txt
```

---

# DAY 44 — Expectation Suites

| Time | Block |
|---|---|
| 0:00 – 0:23 | 44.1 Designing suites: granularity, naming, severity |
| 0:23 – 0:45 | 44.2 Suites as code: YAML specifications |
| 0:45 – 0:53 | Break |
| 0:53 – 1:20 | 44.3 A suite builder that regenerates deterministically |
| 1:20 – 1:43 | 44.4 Writing specs for the core assets |
| 1:43 – 1:50 | Break |
| 1:50 – 2:10 | 44.5 Reading suite results programmatically |
| 2:10 – 2:30 | 44.6 Mini-project: every plan check in a spec |

---

## 44.1 Designing Suites (23 min)

An **expectation suite** is a named collection of expectations validated together against one batch. How you group expectations into suites decides how useful your results are.

### Three design principles

**1. One asset per suite.** A suite describes one kind of data. Don't mix CPI and exchange-rate expectations; they fail for different reasons and have different owners.

**2. Split by severity.** A run should be able to answer "may we publish?" (critical) separately from "should someone take a look?" (warning). The simplest robust way is **two suites per asset**:

```
unemployment_rate__critical    ← definitions: 0–100%, not null, no duplicate months
unemployment_rate__warning     ← history-based: typical ranges, distributions
```

**3. Every expectation traces back to the plan.** Each expectation carries `meta` with its plan ID, dimension, owner and rationale, so a failure in Data Docs immediately tells a reader *why the check exists*.

### Naming convention

| Object | Pattern | Example |
|---|---|---|
| Suite | `<asset>__<severity>` | `macro_monthly__critical` |
| Validation definition | `<asset>__<severity>__<batch>` | `stg_statcan__cpi__critical__by_month` |
| Checkpoint | `<severity>` (or `<severity>_<scope>`) | `critical`, `warning` |

This mirrors dbt's double-underscore naming (Day 34), so names carry their meaning.

### What goes where?

| Put it in **critical** when… | Put it in **warning** when… |
|---|---|
| it follows from a **definition** (a rate is 0–100%) | it follows from **history** (changes are usually below 1.5pp) |
| a failure means the data is **wrong** | a failure means the data is **unusual** |
| publishing would mislead consumers | a human should review before trusting |
| it rarely or never fails legitimately | genuine economic events can trigger it (2008, 2020) |

---

## 44.2 Suites as Code: YAML Specifications (23 min)

On Day 42 you built suites in Python by calling `add_expectation` repeatedly, and noticed that re-running could create duplicates. The professional fix is to **declare** expectations in reviewable files and **generate** suites from them.

Why YAML specs?
- **Reviewable:** an economist can read and approve `min_value: 0, max_value: 100` without reading Python.
- **Diffable:** `git diff quality/specs/` shows exactly which thresholds changed and when.
- **Deterministic:** suites are regenerated from specs every time, so there's no drift and no duplicates.
- **Linked to the plan:** each item carries its plan ID.

It's the same idea as dbt's YAML tests (Day 36) and dlt's `config.toml` (Day 23): **configuration as data, reviewed like code.**

### A spec file

Create `quality/specs/unemployment_rate.yml`:

```yaml
# Expectations for the StatCan unemployment rate (vector v2062815, monthly, SA)
asset: unemployment_rate
batch_definition: full
owner: macro-team

critical:
  - type: ExpectColumnValuesToNotBeNull
    kwargs: {column: value}
    meta:
      plan_id: Q01a
      dimension: completeness
      rationale: "Every published month must have a value."

  - type: ExpectColumnValuesToBeBetween
    kwargs: {column: value, min_value: 0, max_value: 100}
    meta:
      plan_id: Q01
      dimension: validity
      rationale: "A rate is a share of the labour force: it cannot be below 0% or above 100%."

  - type: ExpectColumnValuesToBeUnique
    kwargs: {column: obs_date}
    meta:
      plan_id: Q02a
      dimension: uniqueness
      rationale: "One observation per month."

warning:
  - type: ExpectColumnValuesToBeBetween
    kwargs: {column: value, min_value: 2.5, max_value: 16, mostly: 0.999}
    meta:
      plan_id: Q11
      dimension: plausibility
      rationale: >
        Canada's unemployment rate has historically stayed within roughly this band
        (confirm with the Day 45 profile). Values outside deserve review, not rejection.
```

Structure of each item:

| Key | Meaning |
|---|---|
| `type` | the GX expectation class name (as in `gx.expectations.<type>`) |
| `kwargs` | its arguments, exactly as you'd pass them in Python |
| `meta` | free-form metadata: plan ID, dimension, rationale (rendered in Data Docs) |

The `warning` range above is a **placeholder**. On Day 45 you'll replace it with values derived from the data profile.

---

## 44.3 A Suite Builder That Regenerates Deterministically (28 min)

Create `quality/build_suites.py`. On each run it:

1. reads every `specs/*.yml` file;
2. **deletes** any existing suite with the same name, then recreates it from the spec (no duplicates, no drift);
3. saves the suite as JSON in `gx/expectations/`.

(On Day 46 the same script also creates validation definitions and checkpoints.)

```python
"""Build GX expectation suites from YAML specifications in quality/specs/.

Suites are regenerated from scratch on every run, so the specs are the single
source of truth. Usage:  python quality/build_suites.py
"""
import great_expectations as gx
import yaml

from gx_helpers import PROJECT_ROOT, get_context

SPEC_DIR = PROJECT_ROOT / "specs"
SEVERITIES = ("critical", "warning")


def load_specs():
    """Yield (spec_name, spec_dict) for every top-level YAML spec (not drafts)."""
    for path in sorted(SPEC_DIR.glob("*.yml")):
        with open(path) as f:
            spec = yaml.safe_load(f)
        if "asset" not in spec:
            raise ValueError(f"{path.name}: missing 'asset'")
        yield path.stem, spec


def build_expectation(item, owner=None):
    """Turn one spec item into a GX Expectation object."""
    try:
        cls = getattr(gx.expectations, item["type"])
    except AttributeError:
        raise ValueError(f"Unknown expectation type: {item['type']}")
    meta = dict(item.get("meta", {}))
    if owner:
        meta.setdefault("owner", owner)
    return cls(**item.get("kwargs", {}), meta=meta)


def rebuild_suite(context, name, items, owner=None):
    """Delete (if present) and recreate a suite from spec items."""
    try:
        context.suites.delete(name)
    except Exception:
        pass
    suite = context.suites.add(gx.ExpectationSuite(name=name))
    for item in items:
        suite.add_expectation(build_expectation(item, owner))
    suite.save()
    return suite


def main():
    context = get_context()
    built = []
    for spec_name, spec in load_specs():
        for severity in SEVERITIES:
            items = spec.get(severity) or []
            if items:
                name = f"{spec['asset']}__{severity}"
                rebuild_suite(context, name, items, spec.get("owner"))
                built.append((name, len(items)))
    for name, n in built:
        print(f"✓ {name:<55} {n} expectation(s)")


if __name__ == "__main__":
    main()
```

Key techniques:
- **`getattr(gx.expectations, item["type"])`** looks up a class **by its name as text**. That's what lets a YAML file say `ExpectColumnValuesToBeBetween` and Python create the right object. A typo in the YAML raises a clear error.
- **`cls(**item.get("kwargs", {}), meta=meta)`**: `**` unpacks a dictionary into keyword arguments. `{"column": "value", "min_value": 0}` becomes `column="value", min_value=0`.
- **Delete, then recreate** guarantees the stored suite equals the spec.

```bash
python quality/build_suites.py
ls quality/gx/expectations/
cat quality/gx/expectations/unemployment_rate__critical.json | head -40
```

> Once Day 46 adds validation definitions that *reference* suites, deleting a suite first requires deleting what references it. The Day 46 version of this script handles that order: checkpoints → validation definitions → suites, then rebuilds in reverse.

---

## 44.4 Writing Specs for the Core Assets (23 min)

Write specs for the assets registered on Day 43. Here are two complete examples, followed by guidance for the rest.

### `quality/specs/macro_monthly.yml`: a mart consumers read

```yaml
asset: macro_monthly
batch_definition: full
owner: macro-team

critical:
  - type: ExpectTableColumnsToMatchSet
    kwargs:
      column_set: [month, overnight_rate, fed_funds, yield_2yr, yield_10yr, usd_cad,
                   unemployment_rate, headline_yoy, core_ex_fe_yoy, real_rate]
      exact_match: false
    meta: {plan_id: Q20, dimension: validity,
           rationale: "Columns the dashboards depend on (exposures, Day 40) must exist."}

  - type: ExpectColumnValuesToBeUnique
    kwargs: {column: month}
    meta: {plan_id: Q07, dimension: uniqueness}

  - type: ExpectColumnValuesToNotBeNull
    kwargs: {column: month}
    meta: {plan_id: Q07, dimension: completeness}

  - type: ExpectColumnValuesToBeBetween
    kwargs: {column: unemployment_rate, min_value: 0, max_value: 100}
    meta: {plan_id: Q01m, dimension: validity}

  - type: ExpectColumnValuesToBeBetween
    kwargs: {column: overnight_rate, min_value: -1, max_value: 25}
    meta: {plan_id: Q21, dimension: validity}

  - type: ExpectTableRowCountToBeBetween
    kwargs: {min_value: 240}
    meta: {plan_id: Q22, dimension: completeness,
           rationale: "Panel starts 2006-01; at least 20 years of months must be present."}

warning:
  - type: ExpectColumnValuesToBeBetween
    kwargs: {column: headline_yoy, min_value: -3, max_value: 10, mostly: 0.99}
    meta: {plan_id: Q23, dimension: plausibility}

  - type: ExpectColumnMeanToBeBetween
    kwargs: {column: yield_10yr, min_value: 1, max_value: 8}
    meta: {plan_id: Q24, dimension: plausibility,
           rationale: "Catches unit errors (0.0375 instead of 3.75), Day 41 Story 1."}
```

### `quality/specs/cpi_vector_vs_table_mismatches.yml`: the consistency check

```yaml
asset: cpi_vector_vs_table_mismatches
batch_definition: full
owner: macro-team

critical:
  - type: ExpectTableRowCountToEqual
    kwargs: {value: 0}
    meta:
      plan_id: Q04
      dimension: consistency
      rationale: >
        CPI All-items from the WDS vector and from the full table must agree for every
        month present in both. Rows in this asset are disagreements.
```

### Guidance for the remaining specs

| Spec | Critical (definitions) | Warning (history, Day 45 will calibrate) |
|---|---|---|
| `stg_statcan__cpi.yml` (batch `by_month`) | `cpi` not null and > 0; compound key unique (`month, geo, component, index_base`); `geo_level` in {national, province, city} | row count of the month within a typical band |
| `fct_open_economy_daily.yml` | `date_day` unique/not null; correlations in [−1, 1]; `usd_cad` in (0.8, 2.0) | `usd_cad_logret` within ±3% with `mostly: 0.999`; vol within a historical band |
| `raw_statcan_cpi_full.yml` | required columns present; `ref_date` not null with length 7 | share of rows with a status flag within a typical range |

### Try it 44.4

Write the **critical** part of `quality/specs/stg_statcan__cpi.yml`, using `batch_definition: by_month` (the latest month only).

<details>
<summary>Solution</summary>

```yaml
asset: stg_statcan__cpi
batch_definition: by_month
owner: macro-team

critical:
  - type: ExpectColumnValuesToNotBeNull
    kwargs: {column: cpi}
    meta: {plan_id: Q09, dimension: completeness}

  - type: ExpectColumnValuesToBeBetween
    kwargs: {column: cpi, min_value: 0, strict_min: true}
    meta: {plan_id: Q09, dimension: validity, rationale: "A price index is positive."}

  - type: ExpectCompoundColumnsToBeUnique
    kwargs: {column_list: [month, geo, component, index_base]}
    meta: {plan_id: Q05, dimension: uniqueness}

  - type: ExpectColumnValuesToBeInSet
    kwargs: {column: geo_level, value_set: [national, province, city]}
    meta: {plan_id: Q25, dimension: validity}
```

Q05 is **also** a dbt test (Day 36). Duplicating it in GX is justified here because GX validates the **latest month as a batch** and records its history in Data Docs. If you prefer not to duplicate, drop it and note "covered by dbt" in the plan.

</details>

---

## 44.5 Reading Suite Results Programmatically (20 min)

Validating a whole suite returns an **`ExpectationSuiteValidationResult`**. Knowing its structure lets you build reports, alerts and history.

Create `quality/day44_inspect_results.py`:

```python
from gx_helpers import get_context

context = get_context()
ds = context.data_sources.get("macro_duckdb")
batch = ds.get_asset("macro_monthly").get_batch_definition("full").get_batch()

suite = context.suites.get("macro_monthly__critical")
res = batch.validate(suite, result_format="SUMMARY")

print("Suite success:", res.success)
print("Statistics:", res.statistics)          # evaluated, successful, unsuccessful, success_percent

for r in res.results:                          # one ExpectationValidationResult per expectation
    cfg = r.expectation_config
    meta = cfg.meta or {}
    detail = r.result.get("unexpected_count", r.result.get("observed_value"))
    print(f"{'✓' if r.success else '✗'} [{meta.get('plan_id', '-'):<5}] "
          f"{meta.get('dimension', ''):<13} {cfg.type:<40} "
          f"{cfg.kwargs.get('column', ''):<20} {detail}")
```

| Attribute | Contains |
|---|---|
| `res.success` | `True` only if **every** expectation passed |
| `res.statistics` | counts and `success_percent` |
| `res.results` | a list of per-expectation results |
| `r.expectation_config.type` / `.kwargs` / `.meta` | what was checked, with which parameters, and why |
| `r.result` | details: `unexpected_count`, `unexpected_percent`, `partial_unexpected_list`, or `observed_value` for aggregate expectations |

### Grouping by quality dimension

Because every expectation carries `meta.dimension`, you can report quality the way the Day 41 plan thinks about it:

```python
from collections import Counter

by_dim, failed_dim = Counter(), Counter()
for r in res.results:
    dim = (r.expectation_config.meta or {}).get("dimension", "unknown")
    by_dim[dim] += 1
    failed_dim[dim] += 0 if r.success else 1

for dim in sorted(by_dim):
    print(f"{dim:<14} {by_dim[dim] - failed_dim[dim]}/{by_dim[dim]} passing")
```

---

## 44.6 Mini-Project: Every Plan Check in a Spec (20 min)

1. Write specs for all assets in the table in 44.4, so that **every** GX-assigned check in `DATA_QUALITY_PLAN.md` appears in exactly one spec with its plan ID.
2. Run `python quality/build_suites.py` and confirm one suite per asset and severity.
3. Write `quality/day44_plan_coverage.py`, which reads the plan's check table and the specs and prints any GX-assigned plan ID that has **no** expectation. A quality plan that isn't implemented is just a wish.

<details>
<summary>Solution — plan coverage check</summary>

```python
"""List GX-assigned plan IDs that have no expectation in any spec."""
import re

import yaml

from gx_helpers import PROJECT_ROOT

plan = (PROJECT_ROOT / "DATA_QUALITY_PLAN.md").read_text()
# Rows look like: | Q01 | asset | dimension | ... | GX (Day 43) |
planned_gx = {m.group(1) for m in re.finditer(r"^\|\s*(Q\d+)\s*\|.*\|\s*GX", plan, re.M)}

implemented = set()
for path in (PROJECT_ROOT / "specs").glob("*.yml"):
    spec = yaml.safe_load(path.read_text())
    for sev in ("critical", "warning"):
        for item in spec.get(sev) or []:
            pid = (item.get("meta") or {}).get("plan_id", "")
            implemented.add(re.match(r"Q\d+", pid).group(0) if re.match(r"Q\d+", pid) else pid)

missing = sorted(planned_gx - implemented)
print("Planned for GX:", len(planned_gx), "| implemented:", len(planned_gx & implemented))
print("Missing:", missing or "none ✓")
```

`re` is Python's regular-expression module. The pattern `^\|\s*(Q\d+)\s*\|.*\|\s*GX` finds table rows starting with a plan ID and assigned to GX. Plan IDs with suffixes (`Q01a`, `Q01m`) count towards their base ID.

</details>

### Day 44 checklist
- [ ] My suites follow one-asset-per-suite and critical/warning separation, with consistent names
- [ ] Every expectation lives in a reviewed YAML spec with plan ID, dimension and rationale
- [ ] `build_suites.py` regenerates suites deterministically from specs
- [ ] I can read suite results programmatically and report by quality dimension
- [ ] A coverage script proves every GX-assigned plan check is implemented

```bash
git add quality/ && git commit -m "Day 44: suites as code from YAML specs" && git push
```

---

# DAY 45 — Profiling Datasets

| Time | Block |
|---|---|
| 0:00 – 0:18 | 45.1 What profiling is, and what it isn't |
| 0:18 – 0:40 | 45.2 Fast profiles with DuckDB `SUMMARIZE` |
| 0:40 – 0:48 | Break |
| 0:48 – 1:20 | 45.3 A profiler that drafts expectations |
| 1:20 – 1:40 | 45.4 Profiling changes, not just levels |
| 1:40 – 1:48 | Break |
| 1:48 – 2:08 | 45.5 Distributional expectations: catching unit errors and drift |
| 2:08 – 2:30 | 45.6 Mini-project: review drafts into final specs |

---

## 45.1 What Profiling Is, and What It Isn't (18 min)

**Profiling** means systematically describing a dataset: for each column, its type, completeness, range, distribution, cardinality and typical values. It answers *"what does this data normally look like?"*, the knowledge you need to write **warning**-level expectations sensibly.

| Profiling **does** | Profiling **does not** |
|---|---|
| summarise history: min, max, quantiles, nulls, distinct values | tell you what's *correct* |
| propose thresholds that match past behaviour | know that 2020 was a pandemic |
| reveal surprises (unexpected nulls, odd codes, suspicious extremes) | protect you if history already contains errors |

> **Profiling proposes; economists decide.** A profile of a series containing a past unit error would happily propose a range that *includes* the error. Every drafted expectation must be reviewed by someone who knows the economics.

Older versions of GX shipped automatic profilers ("Data Assistants"). GX 1.x Core focuses on expectations and validation, so we'll build a small, transparent profiler of our own with DuckDB, which is fast, easy to understand, and gives full control.

---

## 45.2 Fast Profiles with DuckDB `SUMMARIZE` (23 min)

Recall Day 13: `SUMMARIZE` computes a profile of every column in one statement. Quality scripts always open the warehouse **read-only**.

Create `quality/day45_profile_basics.py`:

```python
import duckdb
import pandas as pd

from gx_helpers import PROJECT_ROOT

DB = str(PROJECT_ROOT.parent / "macro.duckdb")
pd.set_option("display.width", 200, "display.max_columns", 20)

with duckdb.connect(DB, read_only=True) as con:
    prof = con.sql("summarize select * from marts.macro_monthly").df()

print(prof[["column_name", "column_type", "min", "max", "avg", "std",
            "q25", "q50", "q75", "approx_unique", "null_percentage", "count"]])
```

Read the output column by column and note anything surprising:
- **`null_percentage`**: which columns have gaps, and why? (US yields before FRED coverage? CAD/USD before 2017, Day 6?)
- **`min` / `max`**: any value that makes an economist frown?
- **`approx_unique`** vs **`count`**: is `month` unique (as it must be)?

### Quantiles beyond the quartiles

`SUMMARIZE` gives quartiles. For thresholds we need the **tails**:

```python
with duckdb.connect(DB, read_only=True) as con:
    tails = con.sql("""
        select
            quantile_cont(unemployment_rate, [0.001, 0.01, 0.5, 0.99, 0.999]) as unemp_q,
            quantile_cont(headline_yoy,      [0.001, 0.01, 0.5, 0.99, 0.999]) as cpi_q
        from marts.macro_monthly
    """).fetchone()
print(tails)
```

`quantile_cont(col, [list])` returns several quantiles at once as a list.

### Try it 45.2

Profile `raw_dlt.statcan_cpi_full` (a large, all-text table). Which columns have the lowest cardinality? What distinct values does `status` take, and how often? Why is this raw-layer profile useful for the **boundary** suite?

<details>
<summary>Solution</summary>

```python
with duckdb.connect(DB, read_only=True) as con:
    print(con.sql("summarize select * from raw_dlt.statcan_cpi_full")
             .df()[["column_name", "approx_unique", "null_percentage"]])
    print(con.sql("""select status, count(*) as n from raw_dlt.statcan_cpi_full
                     group by 1 order by n desc""").df())
```

Low-cardinality columns (`uom`, `status`, `terminated`, `scalar_factor`, `geo`) are perfect candidates for **`ExpectColumnValuesToBeInSet`** at the boundary: if StatCan introduces a new status code or unit, you'll know immediately. The frequency of each status code gives a baseline for a **warning** on "share of rows flagged".

</details>

---

## 45.3 A Profiler That Drafts Expectations (33 min)

Now automate the step from profile to **draft** expectations, written as a YAML spec in `specs/drafts/` for human review.

### The drafting rules

| Observed in the profile | Drafted expectation | Severity |
|---|---|---|
| a column with no nulls | `ExpectColumnValuesToNotBeNull` | critical *(review!)* |
| distinct count equals row count | `ExpectColumnValuesToBeUnique` | critical *(review!)* |
| text column with ≤ 20 distinct values | `ExpectColumnValuesToBeInSet` (observed values) | warning |
| numeric column | `ExpectColumnValuesToBeBetween` [p0.1 − margin, p99.9 + margin], `mostly: 0.999` | warning |
| numeric column | `ExpectColumnMeanToBeBetween` [mean ÷ 3, mean × 3] when the mean is positive | warning |
| any table | `ExpectTableRowCountToBeBetween` [0.9 × rows, —] | warning |

The margins are deliberately **generous**. Warnings should flag the genuinely unusual, not normal variation.

Create `quality/profile_assets.py`:

```python
"""Profile warehouse relations with DuckDB and draft GX expectation specs for review.

Usage:  python quality/profile_assets.py macro_monthly=marts.macro_monthly ...
Writes: quality/specs/drafts/<asset>.yml
"""
import sys

import duckdb
import yaml

from gx_helpers import PROJECT_ROOT

DB = str(PROJECT_ROOT.parent / "macro.duckdb")
DRAFT_DIR = PROJECT_ROOT / "specs" / "drafts"
NUMERIC = ("TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "FLOAT", "DOUBLE", "DECIMAL")


def is_numeric(col_type):
    return col_type.upper().startswith(NUMERIC)


def draft_for(con, asset, relation, margin=0.10):
    prof = con.sql(f"summarize select * from {relation}").df()
    n_rows = int(prof["count"].iloc[0])
    critical, warning = [], []

    for _, c in prof.iterrows():
        col, typ = c["column_name"], str(c["column_type"])
        if col.startswith("_"):                              # skip technical columns
            continue
        null_pct = float(c["null_percentage"])
        tag = {"plan_id": "DRAFT", "source": "profiler", "review": "REQUIRED"}

        if null_pct == 0:
            critical.append({"type": "ExpectColumnValuesToNotBeNull",
                             "kwargs": {"column": col},
                             "meta": {**tag, "dimension": "completeness"}})

        if int(c["approx_unique"]) >= n_rows and n_rows > 0:
            exact = con.sql(f"select count(distinct {col}) = count(*) from {relation}").fetchone()[0]
            if exact:
                critical.append({"type": "ExpectColumnValuesToBeUnique",
                                 "kwargs": {"column": col},
                                 "meta": {**tag, "dimension": "uniqueness"}})

        if is_numeric(typ):
            lo, hi, mean = con.sql(f"""
                select quantile_cont({col}, 0.001), quantile_cont({col}, 0.999), avg({col})
                from {relation} where {col} is not null
            """).fetchone()
            if lo is not None:
                pad = margin * (hi - lo if hi > lo else abs(hi) or 1)
                warning.append({"type": "ExpectColumnValuesToBeBetween",
                                "kwargs": {"column": col, "min_value": round(lo - pad, 4),
                                           "max_value": round(hi + pad, 4), "mostly": 0.999},
                                "meta": {**tag, "dimension": "plausibility",
                                         "observed_p001_p999": [round(lo, 4), round(hi, 4)]}})
                if mean and mean > 0:
                    warning.append({"type": "ExpectColumnMeanToBeBetween",
                                    "kwargs": {"column": col, "min_value": round(mean / 3, 4),
                                               "max_value": round(mean * 3, 4)},
                                    "meta": {**tag, "dimension": "plausibility",
                                             "observed_mean": round(mean, 4)}})

        elif typ.upper() in ("VARCHAR", "TEXT") and int(c["approx_unique"]) <= 20:
            values = [r[0] for r in con.sql(
                f"select distinct {col} from {relation} where {col} is not null order by 1"
            ).fetchall()]
            warning.append({"type": "ExpectColumnValuesToBeInSet",
                            "kwargs": {"column": col, "value_set": values},
                            "meta": {**tag, "dimension": "validity"}})

    warning.append({"type": "ExpectTableRowCountToBeBetween",
                    "kwargs": {"min_value": int(0.9 * n_rows)},
                    "meta": {"plan_id": "DRAFT", "dimension": "completeness",
                             "observed_rows": n_rows}})

    return {"asset": asset, "batch_definition": "full", "owner": "macro-team",
            "critical": critical, "warning": warning}


def main(pairs):
    DRAFT_DIR.mkdir(parents=True, exist_ok=True)
    with duckdb.connect(DB, read_only=True) as con:
        for pair in pairs:
            asset, relation = pair.split("=")
            spec = draft_for(con, asset, relation)
            path = DRAFT_DIR / f"{asset}.yml"
            with open(path, "w") as f:
                f.write(f"# DRAFT generated by profile_assets.py from {relation}.\n"
                        "# REVIEW every item: profiles describe history, not correctness.\n")
                yaml.safe_dump(spec, f, sort_keys=False, allow_unicode=True)
            print(f"✓ {path.relative_to(PROJECT_ROOT)}  "
                  f"({len(spec['critical'])} critical, {len(spec['warning'])} warning drafts)")


if __name__ == "__main__":
    main(sys.argv[1:] or ["macro_monthly=marts.macro_monthly"])
```

Run it:

```bash
python quality/profile_assets.py \
    macro_monthly=marts.macro_monthly \
    fct_open_economy_daily=marts.fct_open_economy_daily
cat quality/specs/drafts/macro_monthly.yml | head -60
```

Draft files live in `specs/drafts/`, which `build_suites.py` **ignores** because it only reads `specs/*.yml`. Nothing drafted goes live until a person moves it.

> **Look critically at the drafts.** The profiler will propose `not_null` on columns that are complete *today* but have legitimately missing history, and ranges for *derived* columns that are meaningless to constrain. Reviewing drafts is the real work, and it's economists' work.

---

## 45.4 Profiling Changes, Not Just Levels (20 min)

Day 41's Story 5 (an unemployment jump from 6.4% to 16.4%) passes every **level** check. Plausibility lives in **changes**.

### A query asset of changes

Add to `QUERY_ASSETS` in `quality/setup_gx.py`:

```python
    "unemployment_rate_changes": """
        select obs_date,
               value,
               value - lag(value) over (order by obs_date) as change_pp
        from intermediate.int_macro__observations
        where series_name = 'unemployment_rate'
    """,
```

and give it a monthly batch definition on `obs_date` (in `MONTHLY_PARTITIONS`). Re-run `python quality/setup_gx.py`.

### Profile the changes

```python
with duckdb.connect(DB, read_only=True) as con:
    print(con.sql("""
        with u as (
            select obs_date, value - lag(value) over (order by obs_date) as change_pp
            from intermediate.int_macro__observations
            where series_name = 'unemployment_rate'
        )
        select
            round(quantile_cont(abs(change_pp), 0.95), 2)  as p95,
            round(quantile_cont(abs(change_pp), 0.99), 2)  as p99,
            round(quantile_cont(abs(change_pp), 0.995), 2) as p995,
            round(max(abs(change_pp)), 2)                  as max_abs,
            count(*) filter (where abs(change_pp) > 1.5)   as months_above_1_5
        from u
    """).df())
```

### The spec, with a deliberate two-level design

`quality/specs/unemployment_rate_changes.yml`:

```yaml
asset: unemployment_rate_changes
batch_definition: full
owner: macro-team

warning:
  - type: ExpectColumnValuesToBeBetween
    kwargs: {column: change_pp, min_value: -1.5, max_value: 1.5, mostly: 0.99}
    meta:
      plan_id: Q03
      dimension: plausibility
      rationale: >
        Over the full history, at least 99% of monthly changes are within ±1.5pp
        (calibrated from the Day 45 profile). Tolerates rare genuine shocks (e.g. 2020);
        fails if large jumps become common.
```

And for the **newest** month, which is what a daily pipeline cares about, a stricter check on the monthly batch. Add a second spec file, `quality/specs/unemployment_rate_changes_latest.yml`:

```yaml
asset: unemployment_rate_changes
batch_definition: by_month          # latest month only
owner: macro-team

warning:
  - type: ExpectColumnValuesToBeBetween
    kwargs: {column: change_pp, min_value: -1.5, max_value: 1.5}
    meta:
      plan_id: Q03b
      dimension: plausibility
      rationale: "A new month moving more than 1.5pp needs human confirmation before briefing."
```

Two spec files for the same asset but different batches: one judges **history**, the other **news**. To keep suite names unique, the builder (Day 46 version) will include the batch in the suite name when a spec's batch isn't `full`.

> **Why is "change_pp of the latest month" computed correctly on a monthly batch?** The `lag()` is calculated in the query **before** GX filters to one month, so the latest row still knows the previous month's value. Order of operations matters, just as with `WHERE` before window functions (Day 15).

---

## 45.5 Distributional Expectations: Catching Unit Errors and Drift (20 min)

Row-level ranges miss errors that shift the **whole distribution**. Aggregate expectations catch them.

| Expectation | Catches |
|---|---|
| `ExpectColumnMeanToBeBetween` | unit errors (×100, ÷100), level shifts |
| `ExpectColumnStdevToBeBetween` | volatility suddenly vanishing (a stuck feed) or exploding |
| `ExpectColumnQuantileValuesToBeBetween` | shape changes in part of the distribution |
| `ExpectColumnUniqueValueCountToBeBetween` | a series that stops varying (e.g. forward-fill gone wrong) |
| `ExpectColumnValueZScoresToBeLessThan` | individual outliers relative to the column's own mean and std |

### Example: a quantile fingerprint for USD/CAD daily returns

```yaml
  - type: ExpectColumnQuantileValuesToBeBetween
    kwargs:
      column: usd_cad_logret
      quantile_ranges:
        quantiles: [0.05, 0.5, 0.95]
        value_ranges: [[-0.012, -0.002], [-0.001, 0.001], [0.002, 0.012]]
    meta:
      plan_id: Q26
      dimension: plausibility
      rationale: >
        Typical daily FX moves: roughly ±0.5% at the 5th/95th percentiles, median near zero.
        Ranges calibrated from the Day 45 profile (adjust to your data).
```

(Replace the numbers with those from your own profile: `quantile_cont(usd_cad_logret, [0.05, 0.5, 0.95])`.)

### Example: detecting a "stuck" series

If ingestion accidentally forward-fills one value for months, the **number of distinct values** in a recent window collapses. A query asset of the last 60 business days plus:

```yaml
  - type: ExpectColumnUniqueValueCountToBeBetween
    kwargs: {column: usd_cad, min_value: 30}
    meta: {plan_id: Q27, dimension: timeliness,
           rationale: "Over 60 business days USD/CAD should take many distinct values; few means a stuck feed."}
```

### Try it 45.5

Simulate a unit error in pandas: take `macro_monthly`, divide `yield_10yr` by 100, validate the Q24 mean expectation (`ExpectColumnMeanToBeBetween(column="yield_10yr", min_value=1, max_value=8)`) against the modified DataFrame with the pandas fallback from Day 43, and confirm it fails while the row-level range check from 44.4 (−1 to 25) still passes.

<details>
<summary>Solution</summary>

```python
import duckdb
import great_expectations as gx
from gx_helpers import get_context, PROJECT_ROOT

context = get_context()
with duckdb.connect(str(PROJECT_ROOT.parent / "macro.duckdb"), read_only=True) as con:
    df = con.sql("select month, yield_10yr from marts.macro_monthly").df()
df["yield_10yr"] = df["yield_10yr"] / 100            # the simulated unit error

try:
    src = context.data_sources.get("pandas_fallback")
except Exception:
    src = context.data_sources.add_pandas(name="pandas_fallback")
try:
    asset = src.get_asset("unit_error_test")
except Exception:
    asset = src.add_dataframe_asset(name="unit_error_test")
try:
    bd = asset.get_batch_definition("whole")
except Exception:
    bd = asset.add_batch_definition_whole_dataframe(name="whole")
batch = bd.get_batch(batch_parameters={"dataframe": df})

E = gx.expectations
print("range  :", batch.validate(E.ExpectColumnValuesToBeBetween(
    column="yield_10yr", min_value=-1, max_value=25)).success)        # True: missed!
print("mean   :", batch.validate(E.ExpectColumnMeanToBeBetween(
    column="yield_10yr", min_value=1, max_value=8)).success)          # False: caught
```

</details>

---

## 45.6 Mini-Project: Review Drafts into Final Specs (23 min)

1. Profile every GX asset: `python quality/profile_assets.py asset=schema.table ...` for the table assets (for query assets, profile the underlying query in DuckDB by hand, as in 45.4).
2. For each draft, create or update the **final** spec in `specs/` by:
   - **keeping** items that match a plan check, and assigning the real plan ID;
   - **editing** thresholds using economic judgement (round sensibly; widen where history is short);
   - **deleting** items that constrain meaningless things (e.g. ranges on IDs, not-null on columns with legitimate historical gaps);
   - **adding** a `rationale` to every kept item.
3. Record your review decisions in `quality/specs/REVIEW_LOG.md`: *what the profiler proposed, what you kept, changed or removed, and why.*
4. Run `python quality/build_suites.py`.

Here is an example `REVIEW_LOG.md` entry:

```markdown
## macro_monthly — 2026-09-30 (reviewer: A. Economist)
- DRAFT not_null(us_yield_5yr): REMOVED — FRED coverage starts later than panel start; gaps are legitimate.
- DRAFT between(headline_yoy, -1.3, 9.1): CHANGED to [-3, 10], mostly 0.99 (Q23) — history too short
  to rule out deflation deeper than 2009.
- DRAFT mean(yield_10yr, 0.9, 8.1): KEPT as [1, 8] (Q24) — unit-error detector.
- DRAFT in_set(...): none (no low-cardinality text columns).
```

### Day 45 checklist
- [ ] I can profile any relation quickly with `SUMMARIZE` and tail quantiles
- [ ] `profile_assets.py` drafts expectations into `specs/drafts/`, never directly into live suites
- [ ] I profile **changes** as well as levels, and check plausibility on both history and the newest month
- [ ] I use aggregate expectations (mean, stdev, quantiles, unique counts) to catch unit errors and stuck feeds
- [ ] Every live threshold has a rationale, and my review decisions are logged

```bash
git add quality/ && git commit -m "Day 45: profiling, draft expectations, reviewed specs" && git push
```

---

# DAY 46 — Validation Definitions and Checkpoints

| Time | Block |
|---|---|
| 0:00 – 0:23 | 46.1 Validation definitions: data + suite, saved |
| 0:23 – 0:50 | 46.2 Checkpoints and actions |
| 0:50 – 0:58 | Break |
| 0:58 – 1:25 | 46.3 Extending the builder: specs → suites → definitions → checkpoints |
| 1:25 – 1:45 | 46.4 Running checkpoints and interpreting results |
| 1:45 – 1:53 | Break |
| 1:53 – 2:08 | 46.5 Notifications |
| 2:08 – 2:30 | 46.6 Mini-project: `run_checkpoints.py` with exit codes |

---

## 46.1 Validation Definitions (23 min)

So far you've validated by fetching a batch and calling `batch.validate(suite)` yourself. A **validation definition** saves that pairing (*this data* + *this suite*) as a named, reusable object in the project.

```python
import great_expectations as gx
from gx_helpers import get_context

context = get_context()
ds = context.data_sources.get("macro_duckdb")

batch_def = ds.get_asset("macro_monthly").get_batch_definition("full")
suite = context.suites.get("macro_monthly__critical")

vd = context.validation_definitions.add(
    gx.ValidationDefinition(name="macro_monthly__critical__full", data=batch_def, suite=suite)
)
result = vd.run()
print(vd.name, "→", result.success)
```

It's stored in `quality/gx/validation_definitions/`, so any script or scheduler can run it by name:

```python
vd = context.validation_definitions.get("macro_monthly__critical__full")
print(vd.run().success)
```

For a monthly batch definition, pass `batch_parameters` to choose a month; omit them for the latest:

```python
context.validation_definitions.get("stg_statcan__cpi__critical__by_month").run(
    batch_parameters={"year": 2026, "month": 7})
```

---

## 46.2 Checkpoints and Actions (28 min)

A **checkpoint** runs one or more validation definitions **and then does something with the results**, through **actions**.

```
Checkpoint "critical"
 ├── validation definitions:  every <asset>__critical__<batch>
 ├── result_format:           SUMMARY
 └── actions:
      ├── UpdateDataDocsAction      → rebuild the Data Docs website (Day 47)
      └── (optional) notification   → Slack / Teams / e-mail on failure
```

### Creating checkpoints

```python
import great_expectations as gx

critical_vds = [vd for vd in context.validation_definitions.all()
                if "__critical__" in vd.name]

checkpoint = context.checkpoints.add(gx.Checkpoint(
    name="critical",
    validation_definitions=critical_vds,
    actions=[gx.checkpoints.UpdateDataDocsAction(name="update_data_docs")],
    result_format={"result_format": "SUMMARY"},
))

result = checkpoint.run()
print("Critical checkpoint success:", result.success)
```

> Depending on your GX 1.x release, the actions module may be `gx.checkpoint` or `gx.checkpoints`. If one import fails, try the other: `from great_expectations.checkpoint import UpdateDataDocsAction`.

### Why two checkpoints?

| Checkpoint | Contains | Pipeline response on failure |
|---|---|---|
| `critical` | all `__critical__` validation definitions | **stop**: don't publish marts; alert immediately |
| `warning` | all `__warning__` validation definitions | publish, but flag and alert for review |

This turns the severity column of your Day 41 plan into **pipeline behaviour**.

### Result formats at checkpoint level

`result_format={"result_format": "SUMMARY"}` keeps results informative but compact. Use `COMPLETE` only when debugging a specific failure, because on large tables it can store many unexpected values.

---

## 46.3 Extending the Builder (28 min)

Upgrade `quality/build_suites.py` so that one command regenerates **everything** from the specs, in a safe order:

```
delete:  checkpoints → validation definitions → suites     (things that reference others go first)
create:  suites → validation definitions → checkpoints
```

Replace `main()` and add helpers:

```python
import great_expectations as gx


def suite_name_for(spec, severity):
    """<asset>__<severity>, plus __<batch> when the spec targets a non-default batch."""
    batch = spec.get("batch_definition", "full")
    suffix = "" if batch == "full" else f"__{batch}"
    return f"{spec['asset']}__{severity}{suffix}"


def clear_all(context):
    for cp in list(context.checkpoints.all()):
        context.checkpoints.delete(name=cp.name)
    for vd in list(context.validation_definitions.all()):
        context.validation_definitions.delete(name=vd.name)
    for s in list(context.suites.all()):
        context.suites.delete(name=s.name)


def main():
    context = get_context()
    ds = context.data_sources.get("macro_duckdb")
    clear_all(context)

    vds = {"critical": [], "warning": []}
    for spec_name, spec in load_specs():
        batch_name = spec.get("batch_definition", "full")
        batch_def = ds.get_asset(spec["asset"]).get_batch_definition(batch_name)
        for severity in SEVERITIES:
            items = spec.get(severity) or []
            if not items:
                continue
            s_name = suite_name_for(spec, severity)
            suite = rebuild_suite(context, s_name, items, spec.get("owner"))
            vd = context.validation_definitions.add(gx.ValidationDefinition(
                name=f"{s_name}__{batch_name}" if batch_name == "full" else s_name,
                data=batch_def, suite=suite))
            vds[severity].append(vd)
            print(f"✓ {vd.name:<60} {len(items)} expectation(s)")

    for severity, defs in vds.items():
        if defs:
            context.checkpoints.add(gx.Checkpoint(
                name=severity,
                validation_definitions=defs,
                actions=[gx.checkpoints.UpdateDataDocsAction(name="update_data_docs")],
                result_format={"result_format": "SUMMARY"},
            ))
            print(f"✓ checkpoint '{severity}' with {len(defs)} validation definition(s)")
```

```bash
python quality/build_suites.py
ls quality/gx/checkpoints quality/gx/validation_definitions
```

Everything GX runs is now **derived from the specs**. Changing a threshold means editing YAML, reviewing the diff, and re-running the builder.

---

## 46.4 Running Checkpoints and Interpreting Results (20 min)

```python
from gx_helpers import get_context

context = get_context()
result = context.checkpoints.get("critical").run()

print("Checkpoint success:", result.success)
for identifier, vr in result.run_results.items():
    stats = vr.statistics
    print(f"{'✓' if vr.success else '✗'} {vr.suite_name:<55} "
          f"{stats['successful_expectations']}/{stats['evaluated_expectations']}")
    for r in vr.results:
        if not r.success:
            cfg = r.expectation_config
            meta = cfg.meta or {}
            print(f"     ✗ [{meta.get('plan_id')}] {cfg.type} {cfg.kwargs.get('column', '')}"
                  f" → {r.result.get('unexpected_count', r.result.get('observed_value'))}"
                  f" | {meta.get('rationale', '')[:80]}")
```

`result.run_results` is a dictionary: one entry per validation definition, each holding the suite-level result you met on Day 44. Printing the **rationale** next to each failure turns a cryptic red cross into an actionable message.

### Try it 46.4

Temporarily edit `specs/fct_open_economy_daily.yml` so that one critical expectation must fail (e.g. `usd_cad` max 1.2). Rebuild, run the `critical` checkpoint, and check that your report names the plan ID and rationale. Then restore the spec and rebuild. This is the "break it on purpose" habit from Day 29.

---

## 46.5 Notifications (15 min)

GX includes notification actions (for example `SlackNotificationAction` and `MicrosoftTeamsNotificationAction`) that post a summary when a checkpoint fails:

```python
from great_expectations.checkpoint import SlackNotificationAction

notify = SlackNotificationAction(
    name="notify_on_failure",
    slack_webhook="${SLACK_WEBHOOK_URL}",       # substituted from env / config_variables.yml
    notify_on="failure",
    show_failed_expectations=True,
)
```

Add it to a checkpoint's `actions` list. Never write the webhook URL itself into code or YAML: it's a secret (Day 23).

**Our choice:** we already have a pipeline-wide `notify()` helper and alert policy from Day 29. To keep **one** alerting channel with one set of rules (and avoid alert fatigue), `run_checkpoints.py` builds its own message from the results and calls a small notifier using the same `NOTIFICATIONS__WEBHOOK_URL`. GX's built-in actions are a good alternative when GX runs on its own.

---

## 46.6 Mini-Project: `run_checkpoints.py` with Exit Codes (23 min)

Create `quality/run_checkpoints.py`:

1. Runs the `critical` checkpoint, then the `warning` checkpoint.
2. Prints a compact report: per suite, passed/evaluated; per failure, plan ID, expectation, column, detail, rationale.
3. Sends **one** alert message if anything failed (critical first).
4. Exits with **0** = all passed, **1** = a critical failure (do not publish), **2** = warnings only (publish, review).

These exit codes follow the same convention as `ingest.py` (Day 30).

<details>
<summary>Solution</summary>

```python
"""Run critical and warning checkpoints, report, alert, and exit with a meaningful code.

Exit codes: 0 all passed · 1 critical failure · 2 warnings only
"""
import os
import sys

import requests

from gx_helpers import get_context


def summarise(checkpoint_result):
    lines, failed = [], 0
    for vr in checkpoint_result.run_results.values():
        s = vr.statistics
        lines.append(f"  {'✓' if vr.success else '✗'} {vr.suite_name}: "
                     f"{s['successful_expectations']}/{s['evaluated_expectations']}")
        for r in vr.results:
            if r.success:
                continue
            failed += 1
            cfg, meta = r.expectation_config, (r.expectation_config.meta or {})
            detail = r.result.get("unexpected_count", r.result.get("observed_value"))
            lines.append(f"      ✗ [{meta.get('plan_id', '-')}] {cfg.type} "
                         f"{cfg.kwargs.get('column', '')} → {detail}")
            if meta.get("rationale"):
                lines.append(f"        why it matters: {meta['rationale'].strip()[:120]}")
    return failed, lines


def notify(message):
    url = os.environ.get("NOTIFICATIONS__WEBHOOK_URL")
    if not url:
        print(f"[ALERT]\n{message}")
        return
    try:
        requests.post(url, json={"text": message}, timeout=10)
    except Exception as e:
        print(f"[ALERT not delivered: {e}]\n{message}")


def main():
    context = get_context()
    report, outcome = [], {}

    for name in ("critical", "warning"):
        try:
            result = context.checkpoints.get(name).run()
        except Exception as e:
            report.append(f"✗ checkpoint '{name}' could not run: {e}")
            outcome[name] = 1
            continue
        failed, lines = summarise(result)
        outcome[name] = failed
        report.append(f"{'✓' if failed == 0 else '✗'} checkpoint '{name}': "
                      f"{failed} failing expectation(s)")
        report.extend(lines)

    text = "\n".join(report)
    print(text)

    if outcome.get("critical"):
        notify("⛔ Data quality: CRITICAL failures — marts should not be published.\n" + text)
        sys.exit(1)
    if outcome.get("warning"):
        notify("⚠ Data quality: warnings need review.\n" + text)
        sys.exit(2)
    print("\n✓ All data quality checks passed")


if __name__ == "__main__":
    main()
```

</details>

```bash
python quality/build_suites.py
python quality/run_checkpoints.py; echo "exit code: $?"
```

### Day 46 checklist
- [ ] I can create, save and run validation definitions, for whole tables and specific months
- [ ] Separate `critical` and `warning` checkpoints turn plan severities into pipeline behaviour
- [ ] One builder regenerates suites, definitions and checkpoints from specs in a safe order
- [ ] I can interpret checkpoint results and report failures with plan IDs and rationales
- [ ] Alerts go through one channel; exit codes are 0 / 1 (critical) / 2 (warnings)

```bash
git add quality/ && git commit -m "Day 46: validation definitions, checkpoints, run_checkpoints" && git push
```

---

# DAY 47 — Automated Data Docs and Validation History

| Time | Block |
|---|---|
| 0:00 – 0:25 | 47.1 Building and browsing Data Docs |
| 0:25 – 0:48 | 47.2 Making Data Docs readable for economists |
| 0:48 – 0:55 | Break |
| 0:55 – 1:20 | 47.3 A queryable validation history |
| 1:20 – 1:40 | 47.4 Trends: is data quality getting better or worse? |
| 1:40 – 1:48 | Break |
| 1:48 – 2:03 | 47.5 Connecting Data Docs, dbt docs and the pipeline |
| 2:03 – 2:30 | 47.6 Capstone: `run_quality.sh` and a guided review |

---

## 47.1 Building and Browsing Data Docs (25 min)

**Data Docs** is a static website that GX generates from your suites and validation results. Your checkpoints already rebuild it via `UpdateDataDocsAction`. You can also build it directly:

```python
from gx_helpers import get_context
context = get_context()
context.build_data_docs()
print(context.get_docs_sites_urls())
```

The site is written to `quality/gx/uncommitted/data_docs/local_site/`. Codespaces has no desktop browser, so serve the folder over a forwarded port:

```bash
python -m http.server 8081 --directory quality/gx/uncommitted/data_docs/local_site
```

Codespaces offers to open port 8081 in your browser. Stop the server with `Ctrl+C`.

### A guided tour

| Page | Shows | Use it to… |
|---|---|---|
| **Home / index** | every suite and every validation run, newest first, with pass/fail | see at a glance whether today's run is green |
| **Expectation suite pages** | each expectation in plain English, with parameters | review *what* we promise about each asset |
| **Validation result pages** | one run: each expectation's outcome, observed values, unexpected examples | investigate *what* failed and *by how much* |

Open a failed run (from Try it 46.4, if you kept it) and follow a failure from the index to the exact unexpected values.

> Data Docs contains data values (e.g. unexpected examples). That's why it lives under `uncommitted/`: treat it like the data itself. Share it deliberately, not by committing it to a public repository.

---

## 47.2 Making Data Docs Readable for Economists (23 min)

Data Docs renders expectations as sentences (*"values must be between 0 and 100"*). Three things make them genuinely useful to non-engineers.

**1. Descriptive names.** `unemployment_rate__critical` reads better than `suite_3`. The naming convention from Day 44 already pays off here.

**2. Rich `meta`.** Everything in an expectation's `meta` is displayed with it. The `plan_id`, `dimension`, `owner` and `rationale` fields from your specs appear right next to each check, so a reader sees *why* a rule exists and *who* to ask.

**3. Notes in markdown.** Data Docs has long supported a special `notes` entry in `meta`, rendered as formatted text. Add it for your most important expectations:

```yaml
  - type: ExpectColumnValuesToBeBetween
    kwargs: {column: value, min_value: 0, max_value: 100}
    meta:
      plan_id: Q01
      dimension: validity
      rationale: "A rate is a share of the labour force."
      notes:
        format: markdown
        content:
          - "**Source:** StatCan Labour Force Survey (vector v2062815), seasonally adjusted."
          - "**If this fails:** do not publish; check `raw_dlt.statcan_observations` for the vector."
```

(If your GX version doesn't render `notes`, the content still appears under `meta` in the rendered page.)

### A suite-level description

Suites can carry `meta` too. Give `rebuild_suite` a `description` argument and pass `spec.get("description", "")` from `main()`, so each suite page opens with a sentence explaining its purpose:

```python
def rebuild_suite(context, name, items, owner=None, description=""):
    try:
        context.suites.delete(name)
    except Exception:
        pass
    suite = context.suites.add(gx.ExpectationSuite(
        name=name, meta={"description": description, "owner": owner}))
    for item in items:
        suite.add_expectation(build_expectation(item, owner))
    suite.save()
    return suite
```

and add a `description:` line to each spec, e.g. *"Monthly unemployment rate as published by StatCan (LFS, SA). Critical checks follow from definitions."*

---

## 47.3 A Queryable Validation History (25 min)

Data Docs shows runs one by one. Economists and managers also ask **trend** questions: *Which checks fail most often? Are warnings increasing since StatCan changed its release schedule? Did quality improve after the Day 30 migration?* For that we need validation results **as data**.

Extend `run_checkpoints.py` to append one row per expectation per run to a Parquet file, one file per run:

```python
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

HISTORY_DIR = Path(__file__).resolve().parent.parent / "data" / "quality" / "runs"


def history_rows(checkpoint_name, checkpoint_result, run_time):
    rows = []
    for vr in checkpoint_result.run_results.values():
        for r in vr.results:
            cfg = r.expectation_config
            meta = cfg.meta or {}
            res = r.result or {}
            observed = res.get("observed_value")
            rows.append({
                "run_time": run_time,
                "checkpoint": checkpoint_name,
                "suite": vr.suite_name,
                "asset": vr.suite_name.split("__")[0],
                "plan_id": meta.get("plan_id"),
                "dimension": meta.get("dimension"),
                "expectation_type": cfg.type,
                "column_name": cfg.kwargs.get("column"),
                "success": bool(r.success),
                "element_count": res.get("element_count"),
                "unexpected_count": res.get("unexpected_count"),
                "unexpected_percent": res.get("unexpected_percent"),
                "observed_value": None if observed is None else str(observed),
            })
    return rows


def save_history(rows, run_time):
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    path = HISTORY_DIR / f"run_{run_time:%Y%m%dT%H%M%S}.parquet"
    pd.DataFrame(rows).to_parquet(path, index=False)
    return path
```

In `main()`, set `run_time = datetime.now(timezone.utc)` once, collect `history_rows(...)` for each checkpoint, and call `save_history(...)` **before** exiting, so failed runs are recorded too.

Design choices:
- **One file per run** makes appending trivial and safe: no read-modify-write of a growing file.
- **Parquet** keeps types (Day 13), and DuckDB reads a whole folder with a glob.
- `observed_value` is stored as **text** because it can be a number, a list or a dict, depending on the expectation.
- `data/quality/` is under `data/`, which is already git-ignored (Day 4).

Run the checkpoints a few times (break and restore a spec in between) to create some history.

---

## 47.4 Trends: Is Data Quality Getting Better or Worse? (20 min)

Query the history directly with DuckDB (from either environment):

```bash
duckdb -c "
select checkpoint,
       date_trunc('day', run_time)                  as day,
       count(*)                                     as checks,
       count(*) filter (where not success)          as failures,
       round(100.0 * avg(success::int), 1)          as pct_passing
from 'data/quality/runs/*.parquet'
group by all
order by day desc, checkpoint"
```

### Which checks fail most often?

```sql
select plan_id, asset, expectation_type, column_name,
       count(*)                             as runs,
       count(*) filter (where not success)  as failed_runs,
       max(run_time) filter (where not success) as last_failure
from 'data/quality/runs/*.parquet'
group by all
having count(*) filter (where not success) > 0
order by failed_runs desc;
```

### Quality by dimension over time

```sql
select dimension,
       date_trunc('week', run_time)          as week,
       round(100.0 * avg(success::int), 1)   as pct_passing
from 'data/quality/runs/*.parquet'
group by all
order by week desc, dimension;
```

### Into the warehouse with dbt (a preview of integration)

Because the history is Parquet, dbt-duckdb can read it as a **source**, putting quality results on the lineage graph and in the marts. In `macro_dbt/models/staging/quality/_quality__sources.yml`:

```yaml
version: 2

sources:
  - name: quality
    description: "Great Expectations validation history (quality/run_checkpoints.py)."
    meta:
      external_location: "../data/quality/runs/*.parquet"
    tables:
      - name: gx_results
```

Then `models/staging/quality/stg_quality__gx_results.sql` can `select * from {{ source('quality', 'gx_results') }}` and a small mart can summarise pass rates per asset for the macro cockpit (Day 39's KPI table). We'll wire this in fully on Days 48–50.

> **Why track quality over time?** A single run tells you whether *today's* data is usable. The trend tells you whether your **sources and pipeline** are healthy, which is exactly what you need when deciding whether to trust a new data provider or justify engineering time.

---

## 47.5 Connecting Data Docs, dbt Docs and the Pipeline (15 min)

### Cross-link the two documentation sites

Readers of dbt docs (Day 40) should know quality results exist. Add to the `__overview__` doc block in `macro_dbt/models/docs.md`:

```markdown
**Data quality:** every mart and key raw table is validated by Great Expectations.
See the Data Docs site (served from `quality/gx/uncommitted/data_docs/local_site`)
and the quality plan in `quality/DATA_QUALITY_PLAN.md`.
```

And declare Data Docs as an **exposure** consuming the validated models, so the lineage graph shows that quality checks depend on them:

```yaml
  - name: gx_data_docs
    label: "Great Expectations Data Docs"
    type: application
    maturity: medium
    description: "Validation of raw, staging and mart tables against the data quality plan."
    depends_on:
      - ref('stg_statcan__cpi')
      - ref('int_macro__observations')
      - ref('macro_monthly')
      - ref('fct_open_economy_daily')
    owner:
      name: Macro Data Course team
```

### Where quality runs in the pipeline

```
ingest.py (dlt)  →  dbt build --target prod  →  run_checkpoints.py (GX)  →  publish / alert
                                                   │
                                                   ├─ exit 0: publish marts
                                                   ├─ exit 2: publish, flag for review
                                                   └─ exit 1: do NOT publish; alert
```

On Days 48–50 we'll refine this so that GX validates **incoming StatCan data before dbt transforms it**, and so that "publishing" really depends on the result.

---

## 47.6 Capstone: `run_quality.sh` and a Guided Review (28 min)

### One command for the quality layer

Create `quality/run_quality.sh`:

```bash
#!/usr/bin/env bash
# run_quality.sh — (re)build GX objects from specs, run checkpoints, build Data Docs.
# Exit code is that of run_checkpoints.py: 0 ok · 1 critical · 2 warnings.
set -u
cd "$(dirname "$0")/.."                       # repository root
source .venv-gx/bin/activate
export MACRO_DUCKDB_URL="${MACRO_DUCKDB_URL:-duckdb:///$(pwd)/macro.duckdb}"

python quality/setup_gx.py      || exit 1
python quality/build_suites.py  || exit 1
python quality/run_checkpoints.py
status=$?

(cd quality && python -c "from gx_helpers import get_context; get_context().build_data_docs()")

echo "Data Docs: quality/gx/uncommitted/data_docs/local_site/index.html"
exit $status
```

```bash
chmod +x quality/run_quality.sh
./quality/run_quality.sh; echo "exit code: $?"
```

Notes:
- `set -u` stops on undefined variables, but not on non-zero exit codes, because we *want* to build Data Docs even after a failed validation, then return the validation's exit code.
- `${MACRO_DUCKDB_URL:-...}` uses the existing variable if set, and otherwise a default. That's shell syntax for "value or default".

### Hook it into the main pipeline

Add to the end of `pipeline.sh` (Day 40), after the dbt build:

```bash
./quality/run_quality.sh
quality_status=$?
if [ $quality_status -eq 1 ]; then
    echo "⛔ Critical data quality failure — see Data Docs. Marts must not be used."
    exit 1
fi
[ $quality_status -eq 2 ] && echo "⚠ Data quality warnings — review Data Docs."
echo "✓ Pipeline and quality checks complete"
```

### A guided review for a non-technical reader

Write `quality/HOW_TO_READ_DATA_QUALITY.md` (about one page) for an economist colleague who has never seen GX. It should explain:

1. how to open Data Docs, and what green and red mean;
2. the difference between **critical** and **warning**, with one example of each from our data;
3. how to find **why** a check exists (plan ID, rationale) and **who** owns it;
4. how to see whether quality is improving (the trend queries from 47.4);
5. what to do when something is red: the escalation path from the quality plan.

Then ask a classmate to follow the document **without your help** and note where they got stuck. Revise accordingly. Documentation that hasn't been tested on a real reader is like code that hasn't been run.

### Recap: Days 44–47

| Capability | Built |
|---|---|
| Suites organised by asset and severity, linked to the plan | naming convention, `meta` |
| Expectations as reviewed configuration | `specs/*.yml`, `build_suites.py`, `REVIEW_LOG.md` |
| Data-driven thresholds with human judgement | `profile_assets.py`, drafts, change profiling |
| Distributional checks for unit errors and stuck feeds | mean, stdev, quantiles, unique counts |
| Reusable validation runs with actions | validation definitions, `critical`/`warning` checkpoints |
| Pipeline-aware outcomes | `run_checkpoints.py` exit codes 0/1/2, one alert channel |
| Human-readable evidence | Data Docs with rationales and notes |
| Quality as data | Parquet history, DuckDB trend queries, dbt source preview |

### Looking ahead: Days 48–50

- Add the **full Labour Force Survey** table as a new StatCan source and validate it **at the boundary**, before dbt runs.
- Encode the curriculum's two headline contracts precisely: **unemployment rates between 0 and 100%** for every geography, sex and age group, and **dates continuous without gaps**, per series.
- Use **batch-level validation of each new release** and decide what happens to a bad release: quarantine, reject or publish with a flag.
- Wire GX into the pipeline with dbt reading the quality history, ready for Prefect orchestration in Module 6.

### Day 47 checklist
- [ ] I can build, serve and navigate Data Docs, and I treat them as containing data
- [ ] Expectations and suites carry rationales and notes that non-engineers can follow
- [ ] Every checkpoint run appends a queryable history, including failed runs
- [ ] I can analyse quality trends by check, asset and dimension in DuckDB
- [ ] Data Docs and dbt docs cross-reference each other; Data Docs is a dbt exposure
- [ ] `run_quality.sh` runs the whole quality layer and gates the pipeline via exit codes
- [ ] A colleague can read our data quality results using my guide

```bash
git add quality/ macro_dbt/ pipeline.sh
git commit -m "Day 47: Data Docs, validation history, run_quality.sh"
git push
```
