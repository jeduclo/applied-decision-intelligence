# Module 5 · Quality Assurance with Great Expectations
## Days 41–43: Data Quality Principles, Data Contexts & Connecting to DuckDB

**Audience:** MSc Economics students who completed Modules 1–4 (Days 1–40)
**Environment:** GitHub Codespaces · `macro.duckdb` in production (dbt cut-over, Day 40) · a new, separate `.venv-gx`
**Time per day:** ~2.5 hours (including breaks and exercises)
**Goal by end of Day 43:** Students can reason about data quality systematically (dimensions, contracts, severities, ownership). They write a **data quality plan** for the macro warehouse, set up a **Great Expectations (GX) project**, connect it to DuckDB tables at every layer (`raw_dlt`, `staging`, `marts`), and run first validations against real Canadian data, including a cross-source consistency check.

---

### Why another quality tool? We already have tests…

You've built quality checks at every stage:

| Where | Tool | What it checks | Day |
|---|---|---|---|
| Ingestion | dlt schema contracts, Pydantic | shape and types of incoming records | 25 |
| Ingestion | resilience layer | HTTP failures, bad payloads, StatCan `FAILED` items | 29 |
| Warehouse | dbt tests | keys, ranges, relationships, gaps, freshness | 36 |
| Warehouse | dbt contracts | mart column names and types | 40 |

These are **rules you thought of**, expressed in developer tools. Great Expectations adds:

1. **Expectations as a shared, readable contract**: "unemployment rate between 0 and 100%" as a declarative statement that economists, not just engineers, can read and review.
2. **Rich validation results**: not just pass/fail, but *how many* rows failed, *which* values, and *what share*.
3. **Data Docs**: a human-readable website of expectations and validation history (Days 44–47).
4. **Validation at boundaries and on batches**: checking each newly arrived month of StatCan data, independent of how it's transformed later (Days 48–50).
5. **Distributional checks**: means, quantiles and z-scores, not just row-by-row rules.

> GX doesn't replace dbt tests. **dbt tests protect the transformation logic; GX protects the data contract with the outside world and with consumers.** Many teams use both, and you will too.

### The plan for Module 5

| Days | Focus |
|---|---|
| **41–43** | Principles, a quality plan, GX installation, data contexts, DuckDB connection, first validations |
| 44–47 | Expectation suites, profiling datasets, checkpoints, automated Data Docs |
| 48–50 | Validating incoming StatCan data (unemployment 0–100%, continuous dates), integration with the pipeline |

### Target structure (by end of Day 43)

```
macro-data-course/
├── .venv/                      ← dlt + dbt (Modules 3–4)
├── .venv-gx/                   ← NEW: Great Expectations environment
├── quality/                    ← NEW: the GX project
│   ├── DATA_QUALITY_PLAN.md
│   ├── requirements-gx.txt
│   ├── gx/                     ← created by GX (the Data Context)
│   │   ├── great_expectations.yml
│   │   ├── expectations/
│   │   ├── validation_definitions/
│   │   ├── checkpoints/
│   │   └── uncommitted/        ← local-only: config variables, Data Docs, results
│   ├── gx_helpers.py
│   ├── setup_gx.py
│   └── smoke_check.py
```

---

# DAY 41 — Data Quality Principles

| Time | Block |
|---|---|
| 0:00 – 0:20 | 41.1 Why data quality matters: five macro failure stories |
| 0:20 – 0:45 | 41.2 The dimensions of data quality |
| 0:45 – 0:53 | Break |
| 0:53 – 1:15 | 41.3 Contract-driven data engineering |
| 1:15 – 1:40 | 41.4 Auditing our pipeline: coverage and gaps |
| 1:40 – 1:48 | Break |
| 1:48 – 2:10 | 41.5 Rules vs statistics: setting thresholds from history |
| 2:10 – 2:30 | 41.6 Mini-project: the data quality plan |

Today uses only DuckDB and your existing warehouse. GX arrives tomorrow. **Principles first, tools second.**

---

## 41.1 Why Data Quality Matters: Five Macro Failure Stories (20 min)

Each story is a realistic pattern. For each, ask: *would our pipeline have caught it, and where?*

**Story 1 — The unit error.** An API starts reporting a yield as `0.0375` instead of `3.75` (a decimal instead of a percent). Types are still `DOUBLE` and nothing is null. The real-rate chart suddenly shows policy at −3%.

**Story 2 — The stale series.** A provider pauses a series. Ingestion "succeeds" every day, with zero new rows, and the dashboard proudly displays a two-month-old unemployment rate as "latest".

**Story 3 — The silent revision.** StatCan revises six months of an LFS series. The pipeline absorbs the new values (Day 27's merge), and last week's briefing no longer matches today's numbers, with no record of why.

**Story 4 — The cross-source disagreement.** CPI All-items arrives through two paths: the WDS vector (Day 10) and the full table (Day 18). After a partial refresh they disagree for the latest month. Which is right?

**Story 5 — The plausible-looking outlier.** A monthly unemployment rate jumps from 6.4% to 16.4%: a keying error at the source, or a typo in a manual seed. It's inside 0–100%, so range checks pass.

### Try it 41.1

Fill in the table for our pipeline as it stands after Day 40.

| Story | Caught? | By what? |
|---|---|---|
| 1 Unit error | | |
| 2 Stale series | | |
| 3 Silent revision | | |
| 4 Cross-source disagreement | | |
| 5 Plausible outlier | | |

<details>
<summary>Suggested answers</summary>

| Story | Caught? | By what? |
|---|---|---|
| 1 | Partly | `within_range` on yields (−2, 20) passes 0.0375! It would only be caught by a distributional check (the mean suddenly drops by ~100×) or a change check (a jump of −3.7pp in one day) |
| 2 | Yes | `assert_series_fresh` (dbt, severity warn) and `dbt source freshness` (Day 36) |
| 3 | Partly | values update and the CPI snapshot records revisions (Day 37), but there is no alert and no LFS snapshot |
| 4 | **No** | nothing compares the two CPI paths |
| 5 | **No** | range checks pass; no check on the size of month-to-month changes |

That's exactly the gap GX will fill: **distributional**, **change-based** and **cross-source** expectations, with readable reports.

</details>

---

## 41.2 The Dimensions of Data Quality (25 min)

"Good data" means different things. Practitioners break it into **dimensions**, each needing different checks:

| Dimension | Question | Macro example | Typical check |
|---|---|---|---|
| **Completeness** | Is everything there? | every month since 1976 for LFS unemployment | no gaps; not-null; expected row count |
| **Validity** | Do values obey the rules of their domain? | a rate is between 0 and 100% | ranges, allowed sets, formats |
| **Uniqueness** | Is each entity recorded once? | one CPI value per month × geo × component | unique keys |
| **Consistency** | Do related values agree? | vector CPI = full-table CPI; components vs headline | cross-field and cross-source comparisons |
| **Accuracy** | Does it reflect reality? | our CPI YoY = StatCan's published figure | reconciliation with an authoritative reference |
| **Timeliness** | Is it recent enough for its purpose? | latest CPI ≤ ~2 months old | freshness, staleness per series |
| **Plausibility** | Is it believable given history? | no 10pp monthly jump in unemployment | change limits, z-scores, distribution drift |
| **Integrity** | Do references resolve? | every `series_id` exists in `seed_series` | relationships |

Notes:
- **Accuracy is the hardest.** You rarely have an independent "truth". Reconciliation against published headline figures (e.g. the CPI YoY in StatCan's *Daily* release) is the practical proxy.
- **Plausibility is where economists add the most value.** Only someone who knows the economy can say that a 3pp monthly jump in unemployment is only plausible in April 2020.
- Dimensions **interact**: a stale value (timeliness) can also make a consistency check fail.

### Try it 41.2

For each column, name the two most important dimensions and one concrete check:
(a) `usd_cad` in `fct_open_economy_daily`; (b) `headline_yoy` in `macro_monthly`; (c) `status_flag` in `stg_statcan__cpi`.

<details>
<summary>Suggested answers</summary>

(a) Validity (0.8–2.0) and plausibility (daily log change below ~5% in absolute value). (b) Accuracy (matches the published figure for the latest month) and consistency (close to the weighted sum of components, with a bounded residual; Day 19). (c) Validity (value in StatCan's documented set of status codes) and, as a signal, the share of flagged values (a sudden increase of `E` "use with caution" flags deserves attention).

</details>

---

## 41.3 Contract-Driven Data Engineering (23 min)

A **data contract** is an agreement between a **producer** and a **consumer** of data about what the data will look like and how it will behave.

```
Producer ───────── contract ─────────► Consumer
(StatCan, dlt,       • schema               (dashboards, forecasting,
 dbt models)         • semantics            causal models, analysts)
                     • quality expectations
                     • freshness (SLA)
                     • owner & escalation
```

### The elements of a contract

| Element | Example for `macro_monthly` |
|---|---|
| **Schema** | columns and types (dbt contract, Day 40) |
| **Semantics** | "`usd_cad` = CAD per USD, month-end" (doc blocks, Day 40) |
| **Quality expectations** | "no missing months since 2006; `unemployment_rate` in [0, 100]; `headline_yoy` in [−5, 20]" |
| **Freshness / SLA** | "updated by 10:00 ET on the day after a StatCan CPI release" |
| **Ownership** | "Macro data team; escalate via the pipeline alert channel" |
| **Change process** | "breaking changes announced one week ahead; versioned" |

### Why "contract-driven"?

In contract-driven engineering, you write the **expectations first**, as an explicit, reviewed agreement, and then build and monitor pipelines against them. Three consequences:

1. **Quality becomes testable.** "Good data" stops being a feeling and becomes a list of executable expectations.
2. **Failures have owners.** Each expectation says who acts when it fails, and how urgently.
3. **Change is negotiated.** A producer can't silently rename a column or change a unit, because the contract (and the validation) would break.

> **Great Expectations is a tool for writing the *quality* part of such contracts in executable form.** The expectations you'll write are readable statements, *"expect column `value` values to be between 0 and 100"*, that double as documentation.

### Severity: not every failure is equal

| Severity | Meaning | Example | Pipeline response |
|---|---|---|---|
| **Critical** | data is wrong or unusable | duplicate months; unit error | stop publication; alert immediately |
| **Warning** | suspicious, needs a human look | a large but possible jump | publish with a flag; alert |
| **Info** | worth tracking | share of `E`-flagged values rising | record in reports only |

---

## 41.4 Auditing Our Pipeline: Coverage and Gaps (25 min)

Before adding checks, **map what exists**. Open the DuckDB CLI on the production warehouse:

```bash
cd /workspaces/macro-data-course
duckdb macro.duckdb -readonly
```

### Inventory: what does dbt already test?

```bash
cd macro_dbt && source ../.venv/bin/activate
dbt ls --resource-type test --output name | sed 's/_[0-9a-f]\{10\}$//' | sort | head -60
cd ..
```

Group the tests by dimension. You'll find strong coverage of **uniqueness**, **integrity** and **validity** (ranges), some **timeliness**, and almost nothing for **consistency across sources**, **plausibility of changes** or **accuracy**.

### Prototype the missing checks in SQL

A quality check is ultimately a query. Prototype each gap in DuckDB **before** encoding it in GX.

**Consistency: do the two CPI paths agree?**

```sql
select
    v.obs_date,
    v.value     as cpi_vector,
    t.cpi       as cpi_table,
    v.value - t.cpi as diff
from intermediate.int_macro__observations as v
join staging.stg_statcan__cpi as t
  on t.month = v.obs_date and t.geo_code = 'CA' and t.component = 'All-items'
where v.series_name = 'cpi_all_items'
  and abs(v.value - t.cpi) > 1e-9
order by v.obs_date desc;
```

Zero rows is ideal. If the vector has a **newer** month than the table (the table wasn't republished yet, Day 30's change detection), that's a **timing** difference, not an error. The expectation must handle it, for example by comparing only months present in both, which the inner join already does.

**Plausibility: how large are monthly changes in unemployment?**

```sql
with u as (
    select obs_date, value,
           value - lag(value) over (order by obs_date) as change_pp
    from intermediate.int_macro__observations
    where series_name = 'unemployment_rate'
)
select obs_date, value, round(change_pp, 1) as change_pp
from u
order by abs(change_pp) desc nulls last
limit 10;
```

You'll see the spring-2020 pandemic months at the top, then a long tail of small changes. This distribution tells you where to set a plausibility threshold (next block).

**Timeliness: latest date per series, in one view**

```sql
select s.series_name, s.frequency, max(o.obs_date) as latest,
       current_date - max(o.obs_date) as age_days, s.max_staleness_days
from seeds.seed_series as s
left join intermediate.int_macro__observations as o using (series_id)
group by all
order by age_days desc;
```

---

## 41.5 Rules vs Statistics: Setting Thresholds from History (23 min)

Two kinds of expectations:

| Rule-based | Statistical |
|---|---|
| derived from **definitions** | derived from **history** |
| "a rate is between 0 and 100%" | "monthly changes above 1.5pp occur in <1% of months" |
| never changes | should be recalibrated as history grows |
| failures are almost always errors | failures may be genuine economic events |

For statistical checks, use **quantiles** of historical behaviour rather than guesses.

```sql
with u as (
    select value - lag(value) over (order by obs_date) as change_pp
    from intermediate.int_macro__observations
    where series_name = 'unemployment_rate'
)
select
    round(quantile_cont(abs(change_pp), 0.50), 2)  as p50,
    round(quantile_cont(abs(change_pp), 0.95), 2)  as p95,
    round(quantile_cont(abs(change_pp), 0.99), 2)  as p99,
    round(max(abs(change_pp)), 2)                  as max_abs_change
from u
where change_pp is not null;
```

### The `mostly` idea

Real economies have genuine extremes (2008, 2020). A check like *"monthly change below 1.5pp"* would fail during COVID. That's not bad data, it's history. GX solves this with **`mostly`**: an expectation passes if at least a given share of rows satisfy it.

| Formulation | Behaviour |
|---|---|
| `abs(change) ≤ 1.5` for **all** months | fails forever because of 2020 |
| `abs(change) ≤ 1.5` for **99.5%** of months (`mostly=0.995`) | tolerates rare genuine extremes; flags when extremes become common |
| `abs(change) ≤ 1.5` for the **latest month** only, severity *warning* | flags a new jump for human review |

> **Economist's rule:** use rule-based checks for **definitions** (critical), statistical checks with `mostly` for **history** (warnings), and always let a human confirm a statistical alarm before calling it an error.

### Try it 41.5

Compute the 99th percentile of the absolute **daily log return** of USD/CAD from `marts.fct_open_economy_daily`, and propose a plausibility threshold for a single day's move.

<details>
<summary>Solution</summary>

```sql
select
    round(100 * quantile_cont(abs(usd_cad_logret), 0.99), 2)  as p99_pct,
    round(100 * max(abs(usd_cad_logret)), 2)                  as max_pct
from marts.fct_open_economy_daily
where usd_cad_logret is not null;
```

The typical 99th percentile is on the order of one to two percent. A threshold of a few percent for a **warning**, with `mostly` close to 1 over history, would flag unusual days (e.g. crisis days) for review without failing the pipeline.

</details>

---

## 41.6 Mini-Project: The Data Quality Plan (20 min)

Create `quality/DATA_QUALITY_PLAN.md`. This document is the **specification** for everything you'll build on Days 42–50. Fill in at least 12 checks covering every dimension from 41.2.

```bash
mkdir -p quality
```

Use this template:

```markdown
# Data Quality Plan — Canadian Macro Warehouse

## Scope
Assets protected: raw_dlt (StatCan, BoC, FRED), staging, intermediate, marts.
Consumers: notebook dashboards (exposures), forecasting (Days 61–70), causal models (Days 71–80).

## Severity levels
- CRITICAL: stop publication, alert immediately
- WARNING: publish, flag, alert for review
- INFO: record in Data Docs only

## Checks
| ID | Asset | Dimension | Expectation (plain English) | Type | Severity | Owner | Implemented in |
|----|-------|-----------|-----------------------------|------|----------|-------|----------------|
| Q01 | unemployment_rate (StatCan vector) | Validity | value between 0 and 100 | rule | CRITICAL | macro team | GX (Day 43) |
| Q02 | unemployment_rate | Completeness | no missing months since first observation | rule | CRITICAL | macro team | GX (Day 48) |
| Q03 | unemployment_rate | Plausibility | monthly change ≤ 1.5pp for 99.5% of months | statistical | WARNING | macro team | GX (Day 45) |
| Q04 | CPI vector vs full table | Consistency | equal for every month present in both | rule | CRITICAL | macro team | GX (Day 43) |
| Q05 | stg_statcan__cpi | Uniqueness | one row per month × geo × component × base | rule | CRITICAL | macro team | dbt (Day 36) |
| Q06 | … | Timeliness | … | … | … | … | … |
| … | | | | | | | |

## Open questions
- Who confirms statistical alarms, and within what time?
- How are StatCan revisions communicated to dashboard users?
```

Guidance:
- Where dbt **already** covers a check, say so. Don't duplicate it in GX without a reason.
- Every **CRITICAL** check should be rule-based (definitions), and every **statistical** check should usually be a **WARNING**.
- Include at least one **accuracy** check (e.g. latest CPI YoY equals the figure published in StatCan's *Daily*, entered manually in a small reference file).

### Day 41 checklist
- [ ] I can analyse a data failure by dimension and say where it would be caught
- [ ] I can explain the parts of a data contract and why contract-driven engineering helps
- [ ] I audited existing dbt tests and prototyped missing checks in SQL
- [ ] I set statistical thresholds from historical quantiles, and understand `mostly`
- [ ] `quality/DATA_QUALITY_PLAN.md` lists ≥ 12 checks with dimension, severity, owner and tool

```bash
git add quality/DATA_QUALITY_PLAN.md
git commit -m "Day 41: data quality principles and plan"
git push
```

---

# DAY 42 — Installing Great Expectations and Initializing a Data Context

| Time | Block |
|---|---|
| 0:00 – 0:20 | 42.1 A separate environment, and why |
| 0:20 – 0:40 | 42.2 The GX mental model |
| 0:40 – 0:48 | Break |
| 0:48 – 1:13 | 42.3 A first validation in an ephemeral context |
| 1:13 – 1:38 | 42.4 Anatomy of an expectation and its result |
| 1:38 – 1:45 | Break |
| 1:45 – 2:08 | 42.5 A file-based Data Context: the GX project |
| 2:08 – 2:30 | 42.6 Mini-project: validating the BoC decision log |

---

## 42.1 A Separate Environment, and Why (20 min)

dlt, dbt and GX are large libraries with many dependencies. Installing them all into one environment risks **version conflicts**: one tool needs version X of a shared library, another needs Y. The robust solution is the one you learned on Day 3: **one virtual environment per tool family**.

```bash
cd /workspaces/macro-data-course
python -m venv .venv-gx
source .venv-gx/bin/activate
pip install --upgrade pip
pip install great_expectations duckdb duckdb-engine pandas
pip freeze > quality/requirements-gx.txt
python -c "import great_expectations as gx; print(gx.__version__)"
```

- `great_expectations`: GX Core, the open-source library.
- `duckdb-engine`: lets GX (which talks to SQL databases through *SQLAlchemy*) connect to DuckDB.

Add `.venv-gx/` to `.gitignore`.

| Environment | Used for | Activate with |
|---|---|---|
| `.venv` | dlt ingestion, dbt | `source .venv/bin/activate` |
| `.venv-gx` | Great Expectations | `source .venv-gx/bin/activate` |

> ⚠️ **Version warning.** GX changed substantially at version **1.0**. Many tutorials online still show the older API (`great_expectations init` on the command line, "Data Assistants", `context.sources.add_...`). This course uses the **1.x Python API** (`gx.get_context(mode=...)`, `context.data_sources.add_...`, `gx.expectations.Expect...`). If you find code online, check which version it targets.

---

## 42.2 The GX Mental Model (20 min)

GX organises everything in a hierarchy. Learn these words and the rest of the module becomes straightforward.

```
Data Context  ── the GX project: configuration + stored objects
│
├── Data Source        how to connect         e.g. "macro_duckdb" (SQL connection)
│   └── Data Asset     what to read           e.g. table staging.stg_statcan__cpi
│       └── Batch Definition   which slice    e.g. the whole table, or one month
│           └── Batch          the actual data at validation time
│
├── Expectation        one testable statement  "values in column X are between 0 and 100"
├── Expectation Suite  a named group of expectations for one asset
│
├── Validation Definition  = Batch Definition + Expectation Suite
├── Checkpoint             runs validation definitions + actions (Days 44–47)
│   └── Actions            e.g. update Data Docs, send a notification
│
└── Data Docs          generated website of expectations and results (Days 44–47)
```

### Mapping GX to what you know

| GX concept | Closest thing you already know |
|---|---|
| Data Context | a dbt project (`dbt_project.yml`) |
| Data Source | a dbt profile / connection |
| Data Asset | a dbt source table or model |
| Batch Definition | a `where` clause selecting part of a table |
| Expectation | a dbt generic test with parameters |
| Expectation Suite | the tests in one model's YAML file |
| Checkpoint | `dbt test --select …` plus what to do with results |
| Data Docs | `dbt docs`, but for test results over time |

---

## 42.3 A First Validation in an Ephemeral Context (25 min)

An **ephemeral** context lives only in memory: nothing is saved. It's perfect for learning.

Create `quality/day42_first_steps.py`:

```python
import great_expectations as gx
import pandas as pd

# 1. An in-memory Data Context
context = gx.get_context(mode="ephemeral")

# 2. Some data: the notebook's provincial fiscal positions (Day 4)
df = pd.DataFrame({
    "province": ["BC", "AB", "SK", "MB", "ON", "QC", "NB", "NS", "PE", "NL"],
    "balance_pct_gdp": [-0.8, 0.2, 0.5, -0.9, -1.4, -1.2, -0.5, -0.3, -0.7, 0.1],
})

# 3. Data Source → Data Asset → Batch Definition → Batch
source = context.data_sources.add_pandas(name="pandas_lab")
asset = source.add_dataframe_asset(name="provinces")
batch_definition = asset.add_batch_definition_whole_dataframe(name="whole")
batch = batch_definition.get_batch(batch_parameters={"dataframe": df})

print(batch.head())

# 4. An expectation, validated against the batch
expectation = gx.expectations.ExpectColumnValuesToBeBetween(
    column="balance_pct_gdp", min_value=-5, max_value=5
)
result = batch.validate(expectation)
print("Success:", result.success)
print(result.result)
```

```bash
source .venv-gx/bin/activate
python quality/day42_first_steps.py
```

You just wrote your first **executable data contract clause**: *provincial balances lie between −5% and +5% of GDP.*

### Make it fail on purpose

Change Ontario's value to `-14.0` (a slipped decimal point: a unit error, like Story 1) and run again. Now read `result.result`:

```
{'element_count': 10, 'unexpected_count': 1, 'unexpected_percent': 10.0,
 'partial_unexpected_list': [-14.0], ...}
```

GX tells you **how many** rows failed, **what share**, and **which values**, far more than a pass/fail flag.

---

## 42.4 Anatomy of an Expectation and Its Result (25 min)

### The parts of an expectation

```python
gx.expectations.ExpectColumnValuesToBeBetween(
    column="value",          # what it applies to
    min_value=0,             # parameters of the rule
    max_value=100,
    mostly=0.99,             # optional: minimum share of rows that must pass
    meta={"dimension": "validity", "severity": "critical", "plan_id": "Q01"},
)
```

- **Class names read as sentences**: `ExpectColumnValuesToBeBetween` = "expect column values to be between…".
- **`mostly`** (Day 41.5) tolerates a share of failures.
- **`meta`** is free-form metadata. We'll use it to link each expectation to the **quality plan** (ID, dimension, severity). It appears in Data Docs.

### Families of expectations

| Family | Examples | Macro use |
|---|---|---|
| **Table-level** | `ExpectTableRowCountToBeBetween`, `ExpectTableRowCountToEqual`, `ExpectTableColumnsToMatchSet` | "at least 500 months"; "zero mismatches"; "required columns present" |
| **Column map** (row by row) | `ExpectColumnValuesToNotBeNull`, `ExpectColumnValuesToBeBetween`, `ExpectColumnValuesToBeInSet`, `ExpectColumnValuesToBeUnique` | validity, completeness |
| **Column aggregate** (whole column) | `ExpectColumnMeanToBeBetween`, `ExpectColumnMaxToBeBetween`, `ExpectColumnMedianToBeBetween`, `ExpectColumnStdevToBeBetween` | distributional checks: they catch Story 1's unit error! |
| **Multi-column** | `ExpectCompoundColumnsToBeUnique`, `ExpectColumnPairValuesAToBeGreaterThanB` | composite keys; `end_date ≥ start_date` |

### Result formats

```python
result = batch.validate(expectation, result_format="COMPLETE")
```

| `result_format` | Returns |
|---|---|
| `BOOLEAN_ONLY` | just success/failure (fastest) |
| `BASIC` | counts and a few unexpected values |
| `SUMMARY` | counts, partial unexpected list, value counts |
| `COMPLETE` | every unexpected value, and (for some sources) the rows |

Use `SUMMARY` by default. `COMPLETE` can be large on big tables.

### Validating several expectations at once: a first suite

```python
suite = gx.ExpectationSuite(name="provinces_suite")
suite.add_expectation(gx.expectations.ExpectColumnValuesToNotBeNull(column="province"))
suite.add_expectation(gx.expectations.ExpectColumnValuesToBeUnique(column="province"))
suite.add_expectation(gx.expectations.ExpectColumnValuesToBeInSet(
    column="province",
    value_set=["BC", "AB", "SK", "MB", "ON", "QC", "NB", "NS", "PE", "NL"]))
suite.add_expectation(gx.expectations.ExpectColumnValuesToBeBetween(
    column="balance_pct_gdp", min_value=-5, max_value=5))
suite.add_expectation(gx.expectations.ExpectTableRowCountToEqual(value=10))

suite = context.suites.add(suite)          # register with the context
results = batch.validate(suite)

print("Suite success:", results.success)
for r in results.results:
    print(f"{'✓' if r.success else '✗'} {r.expectation_config.type}")
```

Suites get the full treatment on Days 44–47.

### Try it 42.4

Add an **aggregate** expectation to the suite that would catch a *unit* error across the whole column, even if every individual value stayed inside ±5. (Hint: what happens to the mean if all values are accidentally divided by 100?)

<details>
<summary>Solution</summary>

```python
suite.add_expectation(gx.expectations.ExpectColumnStdevToBeBetween(
    column="balance_pct_gdp", min_value=0.2, max_value=3,
    meta={"dimension": "plausibility", "note": "catches /100 or ×100 unit errors"}))
```

If every value were divided by 100, individual values would still lie inside ±5 and the mean would move only slightly towards zero, but the **standard deviation** would fall from about 0.6 to about 0.006, far below 0.2. Aggregate expectations catch errors that row-level ranges can't.

</details>

---

## 42.5 A File-Based Data Context: the GX Project (23 min)

An ephemeral context forgets everything. For real work, GX stores its configuration and objects **on disk**, in a folder you commit to Git, just like the dbt project.

```python
# quality/day42_init_project.py
import great_expectations as gx

context = gx.get_context(mode="file", project_root_dir="quality")
print(type(context).__name__)
print("Project root:", context.root_directory)
```

```bash
python quality/day42_init_project.py
find quality/gx -maxdepth 2 | sort
```

GX created `quality/gx/`:

| Path | Contains | Commit? |
|---|---|---|
| `great_expectations.yml` | project configuration (data sources, stores) | ✓ |
| `expectations/` | expectation suites, saved as JSON | ✓ |
| `validation_definitions/` | saved validation definitions | ✓ |
| `checkpoints/` | saved checkpoints | ✓ |
| `plugins/` | custom code (advanced) | ✓ |
| `uncommitted/` | **local only**: config variables (secrets), Data Docs site, validation results | ✗ |

GX writes its own `.gitignore` inside `gx/` to exclude `uncommitted/`. Confirm with:

```bash
cat quality/gx/.gitignore
git status quality/
```

Running `gx.get_context(mode="file", project_root_dir="quality")` a second time **loads** the existing project instead of creating a new one, so every later script starts with this same line.

### A helper module for the project

Create `quality/gx_helpers.py`. Every script in `quality/` will import it:

```python
"""Shared helpers for the macro GX project."""
from pathlib import Path

import great_expectations as gx

PROJECT_ROOT = Path(__file__).resolve().parent          # .../quality


def get_context():
    """Load (or create) the file-based Data Context in quality/gx."""
    return gx.get_context(mode="file", project_root_dir=str(PROJECT_ROOT))


def get_or_add_suite(context, name):
    """Return the named suite, creating it if it doesn't exist yet."""
    try:
        return context.suites.get(name)
    except Exception:
        return context.suites.add(gx.ExpectationSuite(name=name))
```

`Path(__file__).resolve().parent` is the folder containing this file, so the helper works no matter which directory you run scripts from.

---

## 42.6 Mini-Project: Validating the BoC Decision Log (23 min)

The decision log (`macro_dbt/seeds/seed_boc_decisions.csv`) is **hand-maintained**, the kind of data most prone to typos. Write `quality/day42_decisions.py` that:

1. Loads the file context with `gx_helpers.get_context()`.
2. Reads the CSV with pandas (`parse_dates=["decision_date"]`).
3. Registers a pandas data source `seeds_pandas`, asset `boc_decisions`, and a whole-dataframe batch definition (reuse them if they already exist).
4. Builds and saves a suite `boc_decisions_suite` with at least six expectations:
   - `decision_date` not null and unique;
   - `rate` between 0 and 10;
   - `change_bp` in the set of multiples of 25 from −100 to +100;
   - at least 25 rows;
   - columns exactly `decision_date, rate, change_bp, note`;
   - (**stretch**) `rate` never negative *and* `change_bp` consistent with the previous rate. Try it and discover why that isn't a single-row expectation. (Answer: it needs row ordering, so it belongs in a SQL-backed check or in dbt, as on Day 36.)
5. Validates, prints each expectation's result, and exits with code 1 if the suite fails.

<details>
<summary>Solution</summary>

```python
"""Validate the hand-maintained BoC decision log seed."""
import sys

import great_expectations as gx
import pandas as pd

from gx_helpers import PROJECT_ROOT, get_context, get_or_add_suite

CSV = PROJECT_ROOT.parent / "macro_dbt" / "seeds" / "seed_boc_decisions.csv"

context = get_context()
df = pd.read_csv(CSV, parse_dates=["decision_date"])

# Data source → asset → batch definition (get or add, so the script can re-run)
try:
    source = context.data_sources.get("seeds_pandas")
except Exception:
    source = context.data_sources.add_pandas(name="seeds_pandas")
try:
    asset = source.get_asset("boc_decisions")
except Exception:
    asset = source.add_dataframe_asset(name="boc_decisions")
try:
    batch_def = asset.get_batch_definition("whole")
except Exception:
    batch_def = asset.add_batch_definition_whole_dataframe(name="whole")

batch = batch_def.get_batch(batch_parameters={"dataframe": df})

suite = get_or_add_suite(context, "boc_decisions_suite")
E = gx.expectations
for exp in [
    E.ExpectColumnValuesToNotBeNull(column="decision_date"),
    E.ExpectColumnValuesToBeUnique(column="decision_date"),
    E.ExpectColumnValuesToBeBetween(column="rate", min_value=0, max_value=10),
    E.ExpectColumnValuesToBeInSet(column="change_bp",
                                  value_set=list(range(-100, 101, 25))),
    E.ExpectTableRowCountToBeBetween(min_value=25),
    E.ExpectTableColumnsToMatchSet(column_set=["decision_date", "rate", "change_bp", "note"],
                                   exact_match=True),
]:
    suite.add_expectation(exp)
suite.save()

results = batch.validate(suite)
for r in results.results:
    print(f"{'✓' if r.success else '✗'} {r.expectation_config.type} "
          f"{r.expectation_config.kwargs.get('column', '')}")
print("Suite success:", results.success)
sys.exit(0 if results.success else 1)
```

Run it twice. The second run reuses the data source and suite. Look at `quality/gx/expectations/boc_decisions_suite.json`: your suite is now a **versionable file**. Note that re-adding the same expectation on each run can create duplicates in some versions; if you see that, build the suite once in a setup script (as on Day 43) and only *validate* in the check script.

Then introduce a typo in the CSV (e.g. `change_bp` of `-30`), re-run, read the output, and restore the file.

</details>

### Day 42 checklist
- [ ] GX runs in its own environment, and I know why separate environments prevent conflicts
- [ ] I can explain Data Context, Data Source, Data Asset, Batch Definition, Batch, Expectation, Suite
- [ ] I can validate an expectation in an ephemeral context and read the detailed result
- [ ] I know the expectation families (table, column map, aggregate, multi-column) and `result_format`
- [ ] I created a file-based Data Context and know what to commit and what stays in `uncommitted/`
- [ ] I validated the BoC decision log with a saved suite and a meaningful exit code

```bash
git add quality/ .gitignore
git commit -m "Day 42: GX environment, context, first suites"
git push
```

---

# DAY 43 — Connecting GX to DuckDB

| Time | Block |
|---|---|
| 0:00 – 0:23 | 43.1 A SQL data source for DuckDB, with configuration variables |
| 0:23 – 0:48 | 43.2 Table assets at every layer |
| 0:48 – 0:55 | Break |
| 0:55 – 1:18 | 43.3 Query assets: validating derived views |
| 1:18 – 1:40 | 43.4 Batch definitions: validating one month at a time |
| 1:40 – 1:48 | Break |
| 1:48 – 2:03 | 43.5 SQL vs pandas: where the work happens |
| 2:03 – 2:30 | 43.6 Capstone: `setup_gx.py` + `smoke_check.py` |

---

## 43.1 A SQL Data Source for DuckDB (23 min)

GX connects to SQL databases through **SQLAlchemy connection strings**. For DuckDB, the format is:

```
duckdb:////absolute/path/to/macro.duckdb      (four slashes = absolute path)
duckdb:///relative/path/macro.duckdb          (three slashes = relative path)
```

### Keep the path out of the project file

Hard-coding a path in `great_expectations.yml` would break on another machine. GX substitutes **`${VARIABLE}`** placeholders from environment variables, or from `gx/uncommitted/config_variables.yml` (never committed). It's the same idea as dlt's secrets on Day 23.

```bash
export MACRO_DUCKDB_URL="duckdb:////workspaces/macro-data-course/macro.duckdb"
```

To make it permanent, add that line to `~/.bashrc`, or create a Codespaces secret named `MACRO_DUCKDB_URL`. For databases with passwords (Postgres, Snowflake, …), this mechanism is how credentials stay out of Git.

### Register the data source

Create `quality/day43_connect.py`:

```python
from gx_helpers import get_context

context = get_context()

try:
    ds = context.data_sources.get("macro_duckdb")
except Exception:
    ds = context.data_sources.add_sql(
        name="macro_duckdb",
        connection_string="${MACRO_DUCKDB_URL}",
    )

print(ds)
```

```bash
source .venv-gx/bin/activate
python quality/day43_connect.py
grep -A3 macro_duckdb quality/gx/great_expectations.yml
```

The YAML stores the **placeholder**, not the path. Commit it safely.

> **One writer at a time, again.** GX only **reads**, but DuckDB still needs other processes not to hold a write lock. Run GX **after** ingestion and dbt have finished, never at the same time. On Days 48–50 the pipeline enforces this order. If you see a lock error, close any open DuckDB CLI session or running dbt command.

---

## 43.2 Table Assets at Every Layer (25 min)

A **table asset** points GX at one table or view. Add assets for each layer we want to protect:

```python
ASSETS = [
    # name in GX                 schema          table
    ("raw_statcan_observations", "raw_dlt",      "statcan_observations"),
    ("raw_statcan_cpi_full",     "raw_dlt",      "statcan_cpi_full"),
    ("stg_statcan__cpi",         "staging",      "stg_statcan__cpi"),
    ("int_macro__observations",  "intermediate", "int_macro__observations"),
    ("macro_monthly",            "marts",        "macro_monthly"),
    ("fct_open_economy_daily",   "marts",        "fct_open_economy_daily"),
]

for asset_name, schema, table in ASSETS:
    try:
        ds.get_asset(asset_name)
    except Exception:
        ds.add_table_asset(name=asset_name, schema_name=schema, table_name=table)
    print("✓", asset_name)
```

### Why validate at several layers?

| Layer | Question GX answers there |
|---|---|
| `raw_dlt` | *Did the provider send what the contract promises?* (the boundary with the outside world) |
| `staging` / `intermediate` | *Did our cleaning preserve the data's meaning?* |
| `marts` | *Is what consumers see correct, complete and fresh?* |

Validating **raw** data is the heart of Days 48–50: problems are cheapest to catch before they flow through dozens of models.

### Your first SQL-backed validation

```python
import great_expectations as gx

asset = ds.get_asset("macro_monthly")
try:
    bd = asset.get_batch_definition("full")
except Exception:
    bd = asset.add_batch_definition_whole_table(name="full")

batch = bd.get_batch()
print(batch.head())

result = batch.validate(gx.expectations.ExpectColumnValuesToBeBetween(
    column="unemployment_rate", min_value=0, max_value=100))
print("Unemployment 0–100%:", result.success, result.result.get("unexpected_count"))
```

GX **translates the expectation into SQL** and DuckDB does the work: the table never gets loaded into Python. That's why SQL data sources scale to large tables.

### Validating raw text data

`raw_dlt.statcan_cpi_full` stores **every column as text** (Day 18: raw layers never guess types). Expectations still work, and a raw asset is the right place to check **formats**:

```python
raw = ds.get_asset("raw_statcan_cpi_full")
try:
    raw_bd = raw.get_batch_definition("full")
except Exception:
    raw_bd = raw.add_batch_definition_whole_table(name="full")
raw_batch = raw_bd.get_batch()

for exp in [
    gx.expectations.ExpectColumnValuesToNotBeNull(column="ref_date"),
    gx.expectations.ExpectColumnValueLengthsToEqual(column="ref_date", value=7),   # 'YYYY-MM'
    gx.expectations.ExpectTableColumnsToMatchSet(
        column_set=["ref_date", "geo", "products_and_product_groups", "uom",
                    "vector", "value", "status"],
        exact_match=False),                                   # at least these columns exist
]:
    r = raw_batch.validate(exp)
    print(f"{'✓' if r.success else '✗'} {exp.type}")
```

The column-set expectation is a **contract on the provider's schema**: if StatCan renames a column, GX reports it at the boundary, before dbt fails in a confusing way three models later.

---

## 43.3 Query Assets: Validating Derived Views (23 min)

Sometimes the thing you want to validate isn't a table but a **question**: "the unemployment series only", or "the months where the two CPI paths disagree". A **query asset** wraps a SQL query.

### One series from the long table

```python
UNEMP_SQL = """
    select obs_date, value
    from intermediate.int_macro__observations
    where series_name = 'unemployment_rate'
"""
try:
    unemp = ds.get_asset("unemployment_rate")
except Exception:
    unemp = ds.add_query_asset(name="unemployment_rate", query=UNEMP_SQL)
```

### The consistency trick: validate a query of *violations*

Recall the "test = query returning violations" pattern (Days 18 and 36). In GX, wrap the violations query as an asset and expect **zero rows**:

```python
CPI_MISMATCH_SQL = """
    select v.obs_date, v.value as cpi_vector, t.cpi as cpi_table
    from intermediate.int_macro__observations as v
    join staging.stg_statcan__cpi as t
      on t.month = v.obs_date and t.geo_code = 'CA' and t.component = 'All-items'
    where v.series_name = 'cpi_all_items'
      and abs(v.value - t.cpi) > 1e-9
"""
try:
    mismatch = ds.get_asset("cpi_vector_vs_table_mismatches")
except Exception:
    mismatch = ds.add_query_asset(name="cpi_vector_vs_table_mismatches", query=CPI_MISMATCH_SQL)

bd = mismatch.add_batch_definition_whole_table(name="full")
result = bd.get_batch().validate(gx.expectations.ExpectTableRowCountToEqual(
    value=0, meta={"plan_id": "Q04", "dimension": "consistency", "severity": "critical"}))
print("CPI paths consistent:", result.success)
```

This implements plan check **Q04** from Day 41, a check that no dbt test covered.

> **Query assets vs dbt models.** If a derived view is useful beyond quality checks, it belongs in dbt (tested, documented, on the lineage graph). Query assets are best for **quality-specific** questions like "rows that violate X", which nobody else consumes.

---

## 43.4 Batch Definitions: Validating One Month at a Time (23 min)

A **whole-table** batch validates all history on every run. That's fine for small tables, but often you want to validate **only the newest data**, the month that just arrived, for three reasons:

1. **Speed:** checking one month is cheaper than 50 years.
2. **Signal:** a failure in the latest batch is *news*; a failure in 1987 is old news you've already accepted (with `mostly`).
3. **Accountability:** results per batch build a validation **history** (Data Docs, Days 44–47).

GX can partition a table asset by a date column:

```python
asset = ds.get_asset("stg_statcan__cpi")
try:
    monthly_bd = asset.get_batch_definition("by_month")
except Exception:
    monthly_bd = asset.add_batch_definition_monthly(name="by_month", column="month")

# Validate one specific month
batch = monthly_bd.get_batch(batch_parameters={"year": 2026, "month": 7})
print(batch.head())
print(batch.validate(gx.expectations.ExpectColumnValuesToBeBetween(
    column="cpi", min_value=0, max_value=1000)).success)
```

Without `batch_parameters`, `get_batch()` returns the **most recent** partition, which is exactly what a daily pipeline wants.

| Batch definition | Selects | Use |
|---|---|---|
| `add_batch_definition_whole_table` | all rows | small tables; full-history checks |
| `add_batch_definition_yearly(column=...)` | one year | annual reviews |
| `add_batch_definition_monthly(column=...)` | one month | monthly StatCan releases |
| `add_batch_definition_daily(column=...)` | one day | daily market data |

### Try it 43.4

Add a monthly batch definition to the `unemployment_rate` query asset (column `obs_date`) and validate the **latest** month: value between 0 and 100 and not null. Then validate **April 2020** explicitly. What's special about it?

<details>
<summary>Solution</summary>

```python
unemp = ds.get_asset("unemployment_rate")
try:
    ubd = unemp.get_batch_definition("by_month")
except Exception:
    ubd = unemp.add_batch_definition_monthly(name="by_month", column="obs_date")

for params in [None, {"year": 2020, "month": 4}]:
    b = ubd.get_batch(batch_parameters=params) if params else ubd.get_batch()
    r = b.validate(gx.expectations.ExpectColumnValuesToBeBetween(
        column="value", min_value=0, max_value=100))
    print(params or "latest", r.success, b.head()["value"].tolist())
```

April 2020 is valid (inside 0–100%), but it's one of the largest monthly jumps in the series' history. A **range** check passes, while a **plausibility** check on changes (Day 45) would flag it for review. That's precisely the distinction between the validity and plausibility dimensions.

</details>

---

## 43.5 SQL vs pandas: Where the Work Happens (15 min)

You now know two ways to point GX at DuckDB data:

| | **SQL data source** (`add_sql`) | **pandas data source** (query with `duckdb`, then `add_pandas`) |
|---|---|---|
| Where computation runs | inside DuckDB (GX generates SQL) | in Python memory |
| Scales to large tables | ✓ | limited by RAM |
| Expectation coverage | most expectations; a few are pandas-only (e.g. some regex/string types, depending on the dialect) | the widest coverage |
| Setup | connection string + `duckdb-engine` | just a DataFrame |
| Best for | production validation of tables and views | small data, seeds, special expectations, **fallback** |

### The fallback pattern

If a particular expectation isn't supported for DuckDB in your GX version, or you hit a connection issue, validate a **DataFrame** instead:

```python
import duckdb
import great_expectations as gx
from gx_helpers import get_context, PROJECT_ROOT

context = get_context()
con = duckdb.connect(str(PROJECT_ROOT.parent / "macro.duckdb"), read_only=True)
df = con.sql("select month, headline_yoy, unemployment_rate from marts.macro_monthly").df()
con.close()

try:
    src = context.data_sources.get("pandas_fallback")
except Exception:
    src = context.data_sources.add_pandas(name="pandas_fallback")
try:
    asset = src.get_asset("macro_monthly_df")
except Exception:
    asset = src.add_dataframe_asset(name="macro_monthly_df")
try:
    bd = asset.get_batch_definition("whole")
except Exception:
    bd = asset.add_batch_definition_whole_dataframe(name="whole")

batch = bd.get_batch(batch_parameters={"dataframe": df})
print(batch.validate(gx.expectations.ExpectColumnValuesToMatchRegex(
    column="month", regex=r"^\d{4}-\d{2}-01")).success)   # dates as text would need casting first
```

`read_only=True` means this script can't accidentally modify the warehouse. Use it for every quality script that opens DuckDB directly.

(The regex example is illustrative. `month` is a date, so for a format check you'd first convert it to a string, e.g. `df["month"].astype(str)`. Try it.)

---

## 43.6 Capstone: `setup_gx.py` + `smoke_check.py` (28 min)

Build two scripts that turn today's experiments into a reproducible foundation:

- **`quality/setup_gx.py`**: *idempotent* (safe to run many times). It registers the data source, all assets and batch definitions. Run it whenever the setup changes.
- **`quality/smoke_check.py`**: runs a handful of critical expectations from the quality plan against **production** data, prints a report, and exits non-zero on any failure.

This mirrors dbt's split between *project definition* and *running* (`dbt build`), and Day 23's split between *configuration* and *execution*.

**Requirements for `smoke_check.py`** (plan IDs from Day 41):

| Plan ID | Asset | Expectation |
|---|---|---|
| Q01 | `unemployment_rate` (query) | values between 0 and 100 |
| Q04 | `cpi_vector_vs_table_mismatches` (query) | row count equals 0 |
| Q07 | `macro_monthly` | `month` unique and not null |
| Q08 | `fct_open_economy_daily` | `usd_cad` between 0.8 and 2.0 |
| Q09 | `stg_statcan__cpi` latest month | `cpi` not null, > 0 |
| Q10 | `raw_statcan_cpi_full` | required columns present (schema contract at the boundary) |

<details>
<summary>Solution — <code>quality/setup_gx.py</code></summary>

```python
"""Idempotently register the DuckDB data source, assets and batch definitions."""
from gx_helpers import get_context

TABLE_ASSETS = [
    ("raw_statcan_observations", "raw_dlt",      "statcan_observations"),
    ("raw_statcan_cpi_full",     "raw_dlt",      "statcan_cpi_full"),
    ("stg_statcan__cpi",         "staging",      "stg_statcan__cpi"),
    ("int_macro__observations",  "intermediate", "int_macro__observations"),
    ("macro_monthly",            "marts",        "macro_monthly"),
    ("fct_open_economy_daily",   "marts",        "fct_open_economy_daily"),
]

QUERY_ASSETS = {
    "unemployment_rate": """
        select obs_date, value
        from intermediate.int_macro__observations
        where series_name = 'unemployment_rate'
    """,
    "cpi_vector_vs_table_mismatches": """
        select v.obs_date, v.value as cpi_vector, t.cpi as cpi_table
        from intermediate.int_macro__observations as v
        join staging.stg_statcan__cpi as t
          on t.month = v.obs_date and t.geo_code = 'CA' and t.component = 'All-items'
        where v.series_name = 'cpi_all_items' and abs(v.value - t.cpi) > 1e-9
    """,
}

MONTHLY_PARTITIONS = {"stg_statcan__cpi": "month", "unemployment_rate": "obs_date"}


def main():
    context = get_context()

    try:
        ds = context.data_sources.get("macro_duckdb")
    except Exception:
        ds = context.data_sources.add_sql(name="macro_duckdb",
                                          connection_string="${MACRO_DUCKDB_URL}")

    for name, schema, table in TABLE_ASSETS:
        try:
            asset = ds.get_asset(name)
        except Exception:
            asset = ds.add_table_asset(name=name, schema_name=schema, table_name=table)
        ensure_batch_definitions(asset, MONTHLY_PARTITIONS.get(name))

    for name, sql in QUERY_ASSETS.items():
        try:
            asset = ds.get_asset(name)
        except Exception:
            asset = ds.add_query_asset(name=name, query=sql)
        ensure_batch_definitions(asset, MONTHLY_PARTITIONS.get(name))

    print("✓ GX setup complete:",
          sorted(a.name for a in ds.assets))


def ensure_batch_definitions(asset, month_column=None):
    try:
        asset.get_batch_definition("full")
    except Exception:
        asset.add_batch_definition_whole_table(name="full")
    if month_column:
        try:
            asset.get_batch_definition("by_month")
        except Exception:
            asset.add_batch_definition_monthly(name="by_month", column=month_column)


if __name__ == "__main__":
    main()
```

</details>

<details>
<summary>Solution — <code>quality/smoke_check.py</code></summary>

```python
"""Run critical smoke checks from the data quality plan against production data."""
import sys

import great_expectations as gx

from gx_helpers import get_context

E = gx.expectations

CHECKS = [
    # (plan_id, asset, batch_definition, expectation)
    ("Q01", "unemployment_rate", "full",
     E.ExpectColumnValuesToBeBetween(column="value", min_value=0, max_value=100)),
    ("Q04", "cpi_vector_vs_table_mismatches", "full",
     E.ExpectTableRowCountToEqual(value=0)),
    ("Q07", "macro_monthly", "full",
     E.ExpectColumnValuesToBeUnique(column="month")),
    ("Q07", "macro_monthly", "full",
     E.ExpectColumnValuesToNotBeNull(column="month")),
    ("Q08", "fct_open_economy_daily", "full",
     E.ExpectColumnValuesToBeBetween(column="usd_cad", min_value=0.8, max_value=2.0)),
    ("Q09", "stg_statcan__cpi", "by_month",            # latest month only
     E.ExpectColumnValuesToBeBetween(column="cpi", min_value=0, strict_min=True)),
    ("Q10", "raw_statcan_cpi_full", "full",
     E.ExpectTableColumnsToMatchSet(
         column_set=["ref_date", "geo", "products_and_product_groups", "uom",
                     "vector", "value", "status"], exact_match=False)),
]


def main():
    context = get_context()
    ds = context.data_sources.get("macro_duckdb")
    failures = 0

    print(f"{'ID':<5} {'asset':<34} {'expectation':<42} result")
    for plan_id, asset_name, bd_name, exp in CHECKS:
        batch = ds.get_asset(asset_name).get_batch_definition(bd_name).get_batch()
        r = batch.validate(exp, result_format="SUMMARY")
        detail = r.result.get("unexpected_count", r.result.get("observed_value", ""))
        print(f"{plan_id:<5} {asset_name:<34} {exp.type:<42} "
              f"{'✓' if r.success else '✗'} {detail}")
        failures += 0 if r.success else 1

    print(f"\n{failures} failing check(s)")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
```

</details>

Run them:

```bash
source .venv-gx/bin/activate
python quality/setup_gx.py
python quality/setup_gx.py          # second run: nothing new created (idempotent)
python quality/smoke_check.py; echo "exit code: $?"
```

### Break it on purpose

Prove the checks work before trusting them:

1. In `smoke_check.py`, temporarily set Q08's `max_value` to `1.2`, run, observe the failure and the count of offending days, then restore it.
2. **Consistency failure:** in a DuckDB session (with nothing else running), create a temporary copy that disagrees, point a *test* query asset at it, and confirm `ExpectTableRowCountToEqual(0)` fails. Then drop the copy. Never edit production tables to test.

### Recap: Days 41–43

| You can now… | Built |
|---|---|
| analyse failures by quality dimension and severity | Day 41 stories and audit |
| write a contract-style quality plan with owners and tools | `DATA_QUALITY_PLAN.md` |
| separate tool environments to avoid dependency conflicts | `.venv-gx` |
| explain and use the GX object model | ephemeral and file contexts |
| connect GX to DuckDB with configuration variables | `macro_duckdb` data source |
| validate tables, derived queries and single months at every layer | table, query and monthly assets |
| run critical checks reproducibly with exit codes | `setup_gx.py`, `smoke_check.py` |

### Looking ahead: Days 44–47

- **Expectation suites** per asset, organised by the quality plan, with `meta` linking every expectation to its plan ID, dimension and severity.
- **Profiling datasets** to *derive* sensible expectations (ranges, distributions, allowed values) from history.
- **Validation definitions and checkpoints** with actions.
- **Automated Data Docs**: a browsable website of expectations and validation results for economists and managers, not just engineers.

### Day 43 checklist
- [ ] GX connects to DuckDB through a `${MACRO_DUCKDB_URL}` placeholder; no paths or secrets are committed
- [ ] I registered table assets in `raw_dlt`, `staging`, `intermediate` and `marts`, and know why each layer matters
- [ ] I use query assets for quality-specific questions, including a zero-rows consistency check
- [ ] I can validate the latest month, or any chosen month, with monthly batch definitions
- [ ] I know when to use SQL vs pandas data sources, and have a read-only fallback
- [ ] `setup_gx.py` is idempotent; `smoke_check.py` enforces critical plan checks with an exit code

```bash
git add quality/ .gitignore
git status                          # quality/gx/uncommitted must NOT be listed
git commit -m "Day 43: GX connected to DuckDB, assets, batch definitions, smoke checks"
git push
```
