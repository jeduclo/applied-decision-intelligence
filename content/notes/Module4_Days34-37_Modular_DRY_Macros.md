# Module 4 · Data Modeling with dbt
## Days 34–37: Modular Modeling, DRY Principles & dbt Macros

**Audience:** MSc Economics students who completed Days 1–33
**Environment:** GitHub Codespaces · course `.venv` · `macro_dbt` project (dev target) · `macro.duckdb`
**Time per day:** ~2.5 hours (including breaks and exercises)
**Goal by end of Day 37:** The `macro_dbt` project is **organised** (one staging model per source table, intermediate models by economic concept, marts by consumer), **DRY** (growth rates, aggregation rules and recession logic each written once as macros), **self-configuring** (series lists read from seeds with `run_query`) and **tested** (generic, singular, custom, unit tests and source freshness). It also includes an incremental model and a snapshot, ready for the macro data mart on Days 38–40.

---

### Where we are

After Day 33, `macro_dbt` rebuilds Module 2's staging and intermediate layers in `dev_*` schemas, verified by a regression analysis. But look at the code honestly:

| Smell | Where |
|---|---|
| One staging model reads **three** sources | `stg_macro__observations` |
| Growth-rate logic written **twice** (CPI, GDP), almost identically | `int_cpi__growth`, `int_gdp__growth` |
| Series list duplicated in `vars` **and** `seed_series.csv` | `int_rates__monthly` |
| Recession-overlap `EXISTS` copied between models | Days 20, monthly & quarterly |
| No tests inside dbt; Module 2's `run_tests.py` still does the checking | whole project |
| Flat folders that will not scale | `models/staging/`, `models/intermediate/` |

The four days fix these in order:

| Day | Theme |
|---|---|
| 34 | **Modular modeling:** layer rules, folder structure, grain, facts & dimensions |
| 35 | **DRY and macros:** reusable SQL, `run_query`, config from seeds |
| 36 | **Testing and packages:** generic, singular, custom and unit tests; `dbt_utils`; freshness |
| 37 | **Incremental models, snapshots, advanced DRY**, and project quality |

> Everything still runs in **dev** (`dev_*` schemas). Don't use `--target prod` until the cut-over on Days 38–40.

---

# DAY 34 — Modular Modeling

| Time | Block |
|---|---|
| 0:00 – 0:23 | 34.1 The rules of each layer |
| 0:23 – 0:50 | 34.2 Staging: one model per source table |
| 0:50 – 0:58 | Break |
| 0:58 – 1:20 | 34.3 Intermediate: organised by economic concept |
| 1:20 – 1:43 | 34.4 Marts: facts, dimensions and one-big-tables |
| 1:43 – 1:50 | Break |
| 1:50 – 2:08 | 34.5 DAG hygiene: rules that keep a project healthy |
| 2:08 – 2:30 | 34.6 Mini-project: restructure `macro_dbt` |

---

## 34.1 The Rules of Each Layer (23 min)

Modular modeling means breaking transformations into **small, single-purpose models**, each in the layer where it belongs. You already met the layers in Module 2. Here are the rules the dbt community uses, adapted to our project:

| Layer | Purpose | May do | May **not** do | Materialisation |
|---|---|---|---|---|
| **staging** `stg_<source>__<entity>` | Clean, faithful copy of **one** source table | rename, cast, standardise units, light filtering of junk | join other sources, aggregate, apply economics | view |
| **intermediate** `int_<concept>__<what>` | Reusable building blocks | join, aggregate, reshape, compute growth rates | read `source()` directly; serve dashboards | view (table if heavy) |
| **marts** `fct_…`, `dim_…`, panels | Finished products for **consumers** | combine intermediates, final naming | contain logic other marts need to repeat | table |

Three principles lie behind the rules:

1. **Single responsibility.** A model does one thing. If you describe it with "and", consider splitting it.
2. **Staging is the only door to raw data.** Only staging models call `source()`. When dlt renames a column, you fix **one** file.
3. **Downstream reuse.** If two marts need the same logic, it belongs upstream in an intermediate model (or a macro, Day 35), not copied into both.

> **Economist's analogy:** staging is *data cleaning*, intermediate is *constructing variables*, and marts are the *estimation samples* handed to different projects. You wouldn't compute inflation separately inside every regression script. You construct it once and merge it in.

---

## 34.2 Staging: One Model per Source Table (28 min)

`stg_macro__observations` breaks rule 2's spirit: it unions **three** source tables and joins a seed. Let's split it.

### New folder structure

```bash
cd macro_dbt
mkdir -p models/staging/{boc,fred,statcan,dlt}
git mv models/staging/stg_statcan__cpi.sql models/staging/statcan/
git mv models/staging/stg_statcan__gdp.sql models/staging/statcan/
```

Each provider folder gets its own sources file.

**`models/staging/boc/_boc__sources.yml`**

```yaml
version: 2

sources:
  - name: boc
    description: "Bank of Canada Valet data loaded by macro_ingest (dlt)."
    schema: raw_dlt
    tables:
      - name: observations
        identifier: boc_observations      # real table name in raw_dlt
        description: "Valet observations, long format, merged incrementally."
      - name: series_metadata
        identifier: boc_series_metadata
```

`identifier` lets the dbt name (`source('boc', 'observations')`) differ from the physical table name (`raw_dlt.boc_observations`). The code reads naturally, and the physical name lives in one place.

Create the equivalents:
- **`models/staging/fred/_fred__sources.yml`**: source `fred`, table `observations` → `fred_observations`.
- **`models/staging/statcan/_statcan__sources.yml`**: source `statcan`, tables `observations` → `statcan_observations`, `cpi_full` → `statcan_cpi_full`, `gdp_full` → `statcan_gdp_full`, `series_metadata` → `statcan_series_metadata`.
- **`models/staging/dlt/_dlt__sources.yml`**: source `dlt`, table `loads` → `_dlt_loads`.

Delete the old `models/staging/_sources.yml`, then update the two StatCan models: `source('raw_dlt', 'statcan_cpi_full')` → `source('statcan', 'cpi_full')`, and likewise for GDP.

### One staging model per source table

> **Question it answers:** How do I give each raw table exactly one clean staging model, organised by provider?
>
> **Other questions you can answer the same way:**
> - Where is the cleaning logic for FRED data?
> - Which model should I change if the BoC renames a field?

**`models/staging/boc/stg_boc__observations.sql`**

```sql
-- Grain: one row per BoC series × observation date
with source as (

    select * from {{ source('boc', 'observations') }}

)

select
    cast(date as date)  as obs_date,
    series_id,
    value,
    'boc'               as provider,
    _dlt_load_id        as load_id
from source
```

Create `stg_fred__observations.sql` and `stg_statcan__observations.sql` the same way (only the source and provider change; tomorrow a macro removes even that repetition).

**`models/staging/dlt/stg_dlt__loads.sql`**

```sql
-- Grain: one row per successful dlt load
select
    load_id,
    inserted_at    as loaded_at,
    status
from {{ source('dlt', 'loads') }}
```

Now delete `models/staging/stg_macro__observations.sql`. The union and the seed join move to the intermediate layer, where joining is allowed.

```bash
dbt ls --select staging
```

---

## 34.3 Intermediate: Organised by Economic Concept (23 min)

> **Question it answers:** How do I organise intermediate models by economic topic (CPI, GDP, rates) rather than by data source?
>
> **Other questions you can answer the same way:**
> - Where do I find every CPI calculation?

Group intermediate models by **concept**, not by source:

```bash
mkdir -p models/intermediate/{macro,cpi,gdp}
git mv models/intermediate/int_cpi__*.sql models/intermediate/cpi/
git mv models/intermediate/int_gdp__*.sql models/intermediate/gdp/
git mv models/intermediate/int_rates__*.sql models/intermediate/macro/
```

### The union moves here

> **Question it answers:** What are all observations from every provider, combined and labelled with their series information?
>
> **Other questions you can answer the same way:**
> - How many observations does each provider supply?

**`models/intermediate/macro/int_macro__observations.sql`**

```sql
-- Grain: one row per series × observation date, all providers, labelled with seed metadata
with unioned as (

    select * from {{ ref('stg_boc__observations') }}
    union all
    select * from {{ ref('stg_fred__observations') }}
    union all
    select * from {{ ref('stg_statcan__observations') }}

)

select
    u.obs_date,
    u.series_id,
    s.series_name,
    u.provider,
    u.value,
    s.frequency,
    s.monthly_agg,
    l.loaded_at
from unioned as u
join {{ ref('seed_series') }} as s using (series_id)
left join {{ ref('stg_dlt__loads') }} as l using (load_id)
```

Update `int_rates__monthly_long` to read `{{ ref('int_macro__observations') }}` instead of the deleted staging model.

### When to create a new intermediate model

| Split it out when… | Keep it as a CTE when… |
|---|---|
| two or more models need the same result | only one model uses it |
| the step is expensive and worth materialising | it's cheap |
| it has a clear economic meaning (e.g. "CPI growth rates") | it's a mechanical sub-step |
| testing it separately would catch real errors | testing it adds nothing |

### Naming: say what the model *is*

| ✗ Vague | ✓ Descriptive |
|---|---|
| `int_cpi_2` | `int_cpi__growth` |
| `int_temp_rates` | `int_rates__monthly_long` |
| `int_joined` | `int_macro__observations` |

### Ephemeral helpers

> **Question it answers:** How do I share a "CPI series that are still published" filter between models without storing it?
>
> **Other questions you can answer the same way:**
> - How do I exclude terminated CPI series everywhere at once?

A helper that just filters is a good **ephemeral** model (Day 32). Create `models/intermediate/cpi/int_cpi__active.sql`:

```sql
{{ config(materialized='ephemeral') }}
-- Grain: month × geography × component; non-terminated CPI series only
select month, geo, geo_code, geo_level, component, cpi
from {{ ref('stg_statcan__cpi') }}
where not is_terminated
```

Tomorrow's growth macro will read from it.

---

## 34.4 Marts: Facts, Dimensions and One-Big-Tables (23 min)

Marts are built for **consumers**: dashboards, forecasting models (Days 61–70), causal models (Days 71–80). Two design styles dominate.

### Dimensional (Kimball) style

| Type | Prefix | Contains | Our examples |
|---|---|---|---|
| **Fact** | `fct_` | measurements or events: many rows, numeric | `fct_observations` (every value), `fct_policy_decisions` |
| **Dimension** | `dim_` | descriptive entities: few rows, text | `dim_series`, `dim_geo`, `dim_date` |

Facts are joined to dimensions by keys: the star schema you built by hand on Day 12.

### One-big-table (OBT) style

> **Question it answers:** How do I give analysts one wide table with everything they need for each month?
>
> **Other questions you can answer the same way:**
> - Which marts should be wide tables, and which should be dimensional?

A single wide table with everything a consumer needs: our `macro_monthly` and `macro_quarterly` panels from Day 20. Dashboards and econometric software love these, because no joins are needed.

**In practice you use both:** dimensional models as the reusable core, and OBT panels built on top for specific consumers.

```bash
mkdir -p models/marts/{core,monetary}
```

### `dim_date`: a calendar dimension

> **Question it answers:** For any date, what are its year, quarter, month, month start and quarter start?
>
> **Other questions you can answer the same way:**
> - Which days fall in Q3 2024?
> - How do I join daily and monthly data on a calendar?

Every time-series project needs a calendar. Create `models/marts/core/dim_date.sql`:

```sql
-- Grain: one row per calendar day, 1990-01-01 to 2030-12-31
with spine as (

    select cast(range as date) as date_day
    from range(date '1990-01-01', date '2031-01-01', interval 1 day)

)

select
    date_day,
    year(date_day)                                    as year,
    quarter(date_day)                                 as quarter,
    month(date_day)                                   as month,
    cast(date_trunc('month', date_day) as date)       as month_start,
    cast(date_trunc('quarter', date_day) as date)     as quarter_start,
    dayofweek(date_day)                               as day_of_week,     -- 0 = Sunday
    dayofweek(date_day) in (0, 6)                     as is_weekend,
    exists (
        select 1 from {{ ref('seed_recession_bands') }} as b
        where date_day between b.start_date and b.end_date
    )                                                 as in_dated_recession
from spine
```

### `dim_series`: every series, described once

> **Question it answers:** For every series, what are its provider, frequency, aggregation rule, staleness limit and official label?
>
> **Other questions you can answer the same way:**
> - Which series are monthly?
> - What is the official description of each series?

`models/marts/core/dim_series.sql`:

```sql
-- Grain: one row per ingested series
select
    s.series_id,
    s.series_name,
    s.source           as provider,
    s.frequency,
    s.monthly_agg,
    s.max_staleness_days,
    coalesce(b.label, st.title)   as official_label
from {{ ref('seed_series') }} as s
left join {{ ref('stg_boc__series_metadata') }}     as b  using (series_id)
left join {{ ref('stg_statcan__series_metadata') }} as st on st.vector_id = s.series_id
```

(Create the two small `stg_*__series_metadata` staging models from their sources first. They're simple selects with renames.)

### Move the Day 17 mart

Port `sql/32_policy_cycles.sql` to `models/marts/monetary/policy_cycles.sql`. Replace `raw.boc_decisions` with `{{ ref('seed_boc_decisions') }}`, CPI with `{{ ref('int_cpi__growth') }}` (national All-items `yoy`), and yields with `{{ ref('int_macro__observations') }}` where `series_name = 'yield_2yr'`.

---

## 34.5 DAG Hygiene (18 min)

> **Question it answers:** Does only the staging layer read raw sources, and do marts avoid reading staging directly?
>
> **Other questions you can answer the same way:**
> - Are there shortcuts in my model graph that will cause trouble later?

Good projects follow a few structural rules. You can check each with `dbt ls` or the lineage graph.

| Rule | Why | Check |
|---|---|---|
| Only staging reads `source()` | one place to absorb raw changes | `grep -rn "source(" models/intermediate models/marts` should find nothing |
| Marts don't `ref()` staging directly | marts should be built from reusable intermediates | inspect `dbt ls --select +marts` |
| No model reads a mart to build an intermediate | layers flow one way | lineage graph: no arrows pointing "backwards" |
| Every model has a documented grain | prevents fan-outs and double counting | YAML descriptions (Day 36 tests enforce keys) |
| No long "daisy chains" of trivial models | each model must earn its place | lineage graph |

```bash
grep -rn "source(" models/intermediate models/marts || echo "✓ only staging reads sources"
dbt ls --select +marts --resource-type model
```

> The `dbt_project_evaluator` package automates dozens of such checks. It's worth exploring once your project grows. The table above covers what matters most.

---

## 34.6 Mini-Project: Restructure `macro_dbt` (23 min)

> **Question it answers:** How should the whole project be laid out so anyone can find any model quickly?
>
> **Other questions you can answer the same way:**
> - Where does a new model for housing data belong?

1. Finish the moves from 34.2–34.4 so the tree looks like this:

```
models/
├── staging/
│   ├── boc/      _boc__sources.yml, _boc__models.yml, stg_boc__observations.sql, stg_boc__series_metadata.sql
│   ├── fred/     _fred__sources.yml, _fred__models.yml, stg_fred__observations.sql
│   ├── statcan/  _statcan__sources.yml, _statcan__models.yml, stg_statcan__observations.sql,
│   │             stg_statcan__cpi.sql, stg_statcan__gdp.sql, stg_statcan__series_metadata.sql
│   └── dlt/      _dlt__sources.yml, stg_dlt__loads.sql
├── intermediate/
│   ├── macro/    int_macro__observations.sql, int_rates__monthly_long.sql, int_rates__monthly.sql
│   ├── cpi/      int_cpi__active.sql, int_cpi__growth.sql, int_cpi__smoothed.sql
│   └── gdp/      int_gdp__growth.sql
└── marts/
    ├── core/     dim_date.sql, dim_series.sql
    └── monetary/ policy_cycles.sql
```

2. Split the YAML documentation into one `_<folder>__models.yml` per folder.
3. `dbt build`: everything must succeed.
4. Re-run Day 33's `analyses/regression_vs_module2.sql`: zero differences (apart from explained dev filters).
5. Open the docs lineage graph and check the hygiene rules in 34.5.

### Day 34 checklist
- [ ] I can state what each layer may and may not do
- [ ] Each source table has exactly one staging model, and only staging reads sources
- [ ] Intermediate models are organised by economic concept, with descriptive names
- [ ] I understand facts vs dimensions vs one-big-tables, and built `dim_date` and `dim_series`
- [ ] The project passes the DAG hygiene checks

```bash
dbt build && cd .. && git add . && git commit -m "Day 34: modular restructure, dims, policy_cycles mart" && git push
```

---

# DAY 35 — DRY Principles and dbt Macros

| Time | Block |
|---|---|
| 0:00 – 0:15 | 35.1 DRY: spotting repetition worth removing |
| 0:15 – 0:40 | 35.2 Macro basics: small scalar macros |
| 0:40 – 0:48 | Break |
| 0:48 – 1:20 | 35.3 A model-generating macro: `growth_rates()` |
| 1:20 – 1:43 | 35.4 `run_query`: configuration from seeds |
| 1:43 – 1:50 | Break |
| 1:50 – 2:08 | 35.5 Debugging and documenting macros |
| 2:08 – 2:30 | 35.6 Mini-project: DRY the CPI, GDP and rates models |

---

## 35.1 DRY: Spotting Repetition Worth Removing (15 min)

**DRY** means **Don't Repeat Yourself**: every piece of knowledge should have one authoritative home. In our project, repeated *knowledge* includes:

| Knowledge | Currently written in |
|---|---|
| "Gap-safe growth = compare with the value exactly *n* periods earlier, else NULL" | `int_cpi__growth`, `int_gdp__growth` |
| "Policy rates aggregate by *last*, prices by *mean*" | `int_rates__monthly_long` (a `case`) |
| "A period is in recession if it overlaps a seed band" | `dim_date`, and later the monthly/quarterly marts |
| "Which series form the rates panel" | `vars.rate_series` **and** `seed_series.csv` |
| "Percentage change = 100 × (new/old − 1)" | many models |

But DRY has a limit. **Don't abstract two things just because their SQL looks similar.** Abstract when they share *meaning*, so that a change to one should always change the other. A macro that hides simple SQL behind ten parameters is worse than the repetition it removed.

> **Test for a good macro:** could you explain what it does to an economist in one sentence, without mentioning SQL?

---

## 35.2 Macro Basics: Small Scalar Macros (25 min)

A **macro** is a reusable piece of Jinja that returns text, usually a SQL fragment. You wrote one on Day 32 (`generate_schema_name`). Macros live in `macros/`.

### Syntax

```sql
{% macro macro_name(arg1, arg2='default') %}
    ... Jinja + SQL text ...
{% endmacro %}
```

Call it anywhere with `{{ macro_name(...) }}`.

### Example 1 — Percentage change

> **Question it answers:** How do I write the percent-change and annualisation formulas once and reuse them in every model?
>
> **Other questions you can answer the same way:**
> - How do I make sure every model computes growth the same way?

Create `macros/economics.sql`:

```sql
{% macro pct_change(new_value, old_value) -%}
    (100.0 * ({{ new_value }} / nullif({{ old_value }}, 0) - 1))
{%- endmacro %}


{% macro annualise(ratio, periods_per_year) -%}
    (100.0 * (power({{ ratio }}, {{ periods_per_year }}) - 1))
{%- endmacro %}


{% macro bp(pp_expression) -%}
    ({{ pp_expression }} * 100)
{%- endmacro %}
```

Use them:

```sql
select
    month,
    {{ pct_change('cpi', 'lag(cpi, 12) over (order by month)') }}  as yoy,
    {{ bp('yield_10yr - yield_2yr') }}                             as spread_bp
```

The arguments are **strings of SQL**, pasted into the template. The macro doesn't see data, only text (Day 33's "Jinja runs first").

`nullif(x, 0)` returns `NULL` when `x` is zero, so a zero base yields `NULL` instead of an error. It's a small robustness bonus now written once.

### Example 2 — Monthly aggregation rule

> **Question it answers:** What is each series' monthly value, using month-end for rates and averages for prices, with one shared rule?
>
> **Other questions you can answer the same way:**
> - How do I apply the right monthly aggregation to any series?

```sql
{% macro monthly_value(value_col, date_col, agg_col) -%}
    case
        when {{ agg_col }} = 'last' then arg_max({{ value_col }}, {{ date_col }})
        else avg({{ value_col }})
    end
{%- endmacro %}
```

### Example 3 — Recession overlap

> **Question it answers:** Does a given period overlap any official recession?
>
> **Other questions you can answer the same way:**
> - Which quarters or policy cycles fell during a recession?

Create `macros/calendar.sql`:

```sql
{% macro overlaps_recession(period_start, period_end) -%}
    exists (
        select 1
        from {{ ref('seed_recession_bands') }} as _rb
        where {{ period_start }} <= _rb.end_date
          and {{ period_end }}   >= _rb.start_date
    )
{%- endmacro %}
```

In `dim_date`:

```sql
    {{ overlaps_recession('date_day', 'date_day') }}   as in_dated_recession
```

And for a month (used on Days 38–40):

```sql
    {{ overlaps_recession('month', "cast(month + interval 1 month - interval 1 day as date)") }}
```

Because the macro calls `ref('seed_recession_bands')`, dbt records the dependency **in the model that calls it**, so the lineage graph stays correct.

### Try it 35.2

Write a macro `real_rate(nominal_col, inflation_col)` returning the approximate real rate, and a second one `real_rate_exact(...)` using the Fisher equation (Day 1). Test both with `dbt show --inline "select {{ real_rate('2.25', '3.0') }} as r, {{ real_rate_exact('2.25', '3.0') }} as r_exact"`.

<details>
<summary>Solution</summary>

```sql
{% macro real_rate(nominal_col, inflation_col) -%}
    ({{ nominal_col }} - {{ inflation_col }})
{%- endmacro %}

{% macro real_rate_exact(nominal_col, inflation_col) -%}
    (100.0 * ((1 + {{ nominal_col }} / 100.0) / (1 + {{ inflation_col }} / 100.0) - 1))
{%- endmacro %}
```

Expected: `r = -0.75`, `r_exact ≈ -0.728`. The same numbers as Day 1, now as reusable SQL.

</details>

---

## 35.3 A Model-Generating Macro: `growth_rates()` (33 min)

> **Question it answers:** How do I compute gap-safe growth rates for any series (monthly CPI or quarterly GDP) with one reusable macro?
>
> **Other questions you can answer the same way:**
> - What is YoY growth for any new series I add?

Day 33's `horizons` loop lived inside `int_cpi__growth`. GDP needs the same logic with quarters. Let's write it once.

Create `macros/growth_rates.sql`:

```sql
{#
  growth_rates(): gap-safe growth measures for any time series.

  relation      model/ref to read from
  value_col     column holding the level (e.g. 'cpi', 'real_gdp')
  date_col      period column (first day of month or quarter)
  partition_by  list of columns identifying each series (may be empty)
  horizons      list of {"name", "lag", "power"} (power = annualisation exponent)
  step_months   months per period: 1 for monthly, 3 for quarterly
  keep_cols     extra columns to carry through unchanged

  A measure is NULL unless the comparison period is exactly lag × step_months earlier.
#}
{% macro growth_rates(relation, value_col, date_col, partition_by=[], horizons=[],
                      step_months=1, keep_cols=[]) %}

with _base as (

    select * from {{ relation }}

),

_lagged as (

    select
        *,
        {%- for l in horizons | map(attribute='lag') | unique %}
        lag({{ value_col }}, {{ l }}) over _w  as _{{ value_col }}_l{{ l }},
        lag({{ date_col }}, {{ l }})  over _w  as _{{ date_col }}_l{{ l }}{{ ',' if not loop.last }}
        {%- endfor %}
    from _base
    window _w as (
        {% if partition_by %}partition by {{ partition_by | join(', ') }}{% endif %}
        order by {{ date_col }}
    )

)

select
    {{ date_col }},
    {%- for c in partition_by + keep_cols %}
    {{ c }},
    {%- endfor %}
    {{ value_col }},
    {%- for h in horizons %}
    case
        when _{{ date_col }}_l{{ h.lag }}
             = cast({{ date_col }} - interval {{ h.lag * step_months }} month as date)
        then {{ annualise(value_col ~ ' / _' ~ value_col ~ '_l' ~ h.lag, h.power) }}
    end as {{ h.name }}{{ ',' if not loop.last }}
    {%- endfor %}
from _lagged

{% endmacro %}
```

New Jinja features here:
- `{# … #}` at the top **documents the macro** for the next reader.
- `partition_by + keep_cols`: lists can be concatenated, as in Python.
- `value_col ~ ' / _' ~ …`: `~` is Jinja's **string concatenation**, used to build an argument for another macro (`annualise`). **Macros can call macros.**
- Internal names start with `_` (`_base`, `_w`, `_cpi_l12`) to avoid clashing with the caller's columns.

### Put the horizons in `vars`

> **Question it answers:** Where do I define which growth horizons (MoM, 3-month, YoY, QoQ…) are computed?
>
> **Other questions you can answer the same way:**
> - How do I add a 24-month growth rate everywhere?

In `dbt_project.yml`:

```yaml
vars:
  monthly_horizons:
    - {name: mom,    lag: 1,  power: 1}
    - {name: ann_3m, lag: 3,  power: 4}
    - {name: ann_6m, lag: 6,  power: 2}
    - {name: yoy,    lag: 12, power: 1}
  quarterly_horizons:
    - {name: real_qoq,     lag: 1, power: 1}
    - {name: real_qoq_ann, lag: 1, power: 4}
    - {name: real_yoy,     lag: 4, power: 1}
```

### The CPI growth model becomes six lines

> **Question it answers:** What are the CPI growth rates for every geography and component, from a six-line model?
>
> **Other questions you can answer the same way:**
> - What is the 6-month annualised inflation rate in each province?

```sql
-- models/intermediate/cpi/int_cpi__growth.sql
-- Grain: month × geography × component. Gap-safe growth rates (%).
{{ growth_rates(
    relation     = ref('int_cpi__active'),
    value_col    = 'cpi',
    date_col     = 'month',
    partition_by = ['geo', 'component'],
    keep_cols    = ['geo_code', 'geo_level'],
    horizons     = var('monthly_horizons'),
    step_months  = 1
) }}
```

```bash
dbt compile --select int_cpi__growth
dbt build --select int_cpi__growth+
```

Read the compiled SQL: it's the familiar Day 19 logic. Then re-run the regression analysis. Zero differences means the refactor preserved the numbers.

> **Column order note:** the macro outputs `date, partitions, keep_cols, value, measures`. If a downstream model used `select *` and relied on the old column order, it may break. That's one reason to prefer explicit column lists downstream.

---

## 35.4 `run_query`: Configuration from Seeds (23 min)

Day 33 left a known duplication: `vars.rate_series` repeats `seed_series.csv`. Jinja can **run a query at compile time** with `run_query` and use the result to write SQL.

### Step 1 — Mark panel membership in the seed

> **Question it answers:** Which series belong in the monthly rates panel?
>
> **Other questions you can answer the same way:**
> - How do I add or remove a series from the panel without editing SQL?

Add a column to `seeds/seed_series.csv`:

```csv
series_id,series_name,source,frequency,monthly_agg,max_staleness_days,in_rates_panel
V39079,overnight_rate,boc,daily,last,10,true
FXCADUSD,cad_usd,boc,daily,mean,10,true
BD.CDN.2YR.DQ.YLD,yield_2yr,boc,daily,mean,10,true
BD.CDN.10YR.DQ.YLD,yield_10yr,boc,daily,mean,10,true
FEDFUNDS,fed_funds,fred,monthly,last,75,true
DCOILWTICO,wti,fred,daily,mean,15,true
CANLOLITOAASTSAM,oecd_cli,fred,monthly,mean,120,true
v41690973,cpi_all_items,statcan,monthly,last,75,false
v2062815,unemployment_rate,statcan,monthly,last,60,true
```

and type it in `seeds/_seeds.yml` (`in_rates_panel: boolean`). Run `dbt seed --select seed_series`.

### Step 2 — A macro that reads the seed

> **Question it answers:** How can a model ask the database which series are in the panel when it is compiled?
>
> **Other questions you can answer the same way:**
> - How do I generate SQL from a list stored in a table?

Create `macros/get_series_names.sql`:

```sql
{% macro get_series_names(where=none) %}

    {% set query %}
        select series_name
        from {{ ref('seed_series') }}
        {% if where %}where {{ where }}{% endif %}
        order by series_name
    {% endset %}

    {% if execute %}
        {% set results = run_query(query) %}
        {% set names = results.columns[0].values() %}
    {% else %}
        {% set names = [] %}
    {% endif %}

    {{ return(names) }}

{% endmacro %}
```

New ideas:
- `{% set query %} … {% endset %}` captures a **block of text** into a variable.
- `run_query(query)` runs SQL against the target and returns a table. `.columns[0].values()` extracts the first column as a list.
- **`execute`** is `false` while dbt is *parsing* the project (building the DAG, when the database may not even be ready) and `true` when it actually *runs*. Always guard `run_query` with `{% if execute %}`.
- `{{ return(names) }}` makes the macro return a **Python-like value** (a list) instead of text.

### Step 3 — Use it

> **Question it answers:** What does the monthly rates panel look like, with columns generated automatically from the seed?
>
> **Other questions you can answer the same way:**
> - Will a new series appear as a column just by adding it to the seed?

```sql
-- models/intermediate/macro/int_rates__monthly.sql
-- depends_on: {{ ref('seed_series') }}
-- Grain: one row per month. Columns generated from seed_series (in_rates_panel = true).
{% set panel_series = get_series_names(where="in_rates_panel") %}

with wide as (

    select
        month,
        {%- for s in panel_series %}
        max(value) filter (where series_name = '{{ s }}') as {{ s }}{{ ',' if not loop.last }}
        {%- endfor %}
    from {{ ref('int_rates__monthly_long') }}
    group by month

)

select
    *,
    overnight_rate - fed_funds        as boc_fed_diff,
    {{ bp('yield_10yr - yield_2yr') }} as spread_10_2_bp,
    1 / cad_usd                       as usd_cad
from wide
```

The `-- depends_on:` comment is a recommended dbt pattern: it guarantees dbt registers the dependency on `seed_series`, so the seed is always built **before** this model.

Now remove `rate_series` from `vars`. Adding a series to the panel means **one CSV row**, the same file that already drives ingestion checks.

> **Trade-off:** `run_query` makes compilation depend on the database. A model can't compile until the seed exists, and every compile runs a small query. It's worth it for configuration tables like this; don't use it for anything large.

### Try it 35.4

Use `get_series_names(where="frequency = 'daily'")` inside `dbt show --inline` to print the daily series as a single comma-separated string.

<details>
<summary>Solution</summary>

```bash
dbt show --inline "select '{{ get_series_names(where=\"frequency = 'daily'\") | join(', ') }}' as daily_series"
```

</details>

---

## 35.5 Debugging and Documenting Macros (18 min)

### Seeing what a macro produced

- `dbt compile --select model` and read `target/compiled/...`: always the first step.
- `{{ log("panel series: " ~ panel_series, info=True) }}` prints to the terminal while dbt runs. Remove it once things work.
- `dbt run-operation <macro> --args '{...}'` runs a macro on its own (Day 37 uses this).

### Common errors

| Error | Usual cause |
|---|---|
| `'dict object' has no attribute 'lag'` | a horizon missing a key (typo in `vars`) |
| Syntax error near `,` or `from` | a trailing comma: check `loop.last` |
| Empty column list in compiled SQL | `run_query` used without `execute`, or the seed isn't built |
| `macro 'x' takes no keyword argument 'y'` | argument name mismatch |

### Documenting macros

> **Question it answers:** What does each macro do, and what arguments does it take?
>
> **Other questions you can answer the same way:**
> - How should a colleague call the growth_rates macro?

Create `macros/_macros.yml`:

```yaml
version: 2

macros:
  - name: growth_rates
    description: >
      Gap-safe growth measures for any time series. A measure is NULL unless the
      comparison period is exactly lag × step_months earlier. Annualisation via `power`.
    arguments:
      - name: relation
        type: relation
        description: "Model to read from (use ref())."
      - name: horizons
        type: list
        description: "List of {name, lag, power}; see vars.monthly_horizons."
      - name: step_months
        type: integer
        description: "1 for monthly data, 3 for quarterly."

  - name: get_series_names
    description: "Series names from seed_series, optionally filtered by a SQL condition."

  - name: overlaps_recession
    description: "True if [period_start, period_end] overlaps any band in seed_recession_bands."
```

Macro documentation appears on the docs site (`dbt docs generate`), next to the models that use it.

---

## 35.6 Mini-Project: DRY the CPI, GDP and Rates Models (23 min)

> **Question it answers:** How many lines of SQL did the macros save, and do CPI, GDP and rates models still give the same numbers?
>
> **Other questions you can answer the same way:**
> - Is the project smaller and easier to maintain now?

1. **GDP.** Split `int_gdp__growth` into:
   - `int_gdp__levels` (view): quarter, `real_gdp`, `nominal_gdp`, `gdp_deflator` (Day 20's first CTEs);
   - `int_gdp__growth`: `growth_rates(ref('int_gdp__levels'), 'real_gdp', 'quarter', horizons=var('quarterly_horizons'), step_months=3, keep_cols=['nominal_gdp', 'gdp_deflator'])`.
2. **Rates.** `int_rates__monthly_long` uses the `monthly_value` macro; `int_rates__monthly` uses `get_series_names`.
3. **Calendar.** `dim_date` uses `overlaps_recession`.
4. **Everywhere:** replace hand-written `100 * (a / b - 1)` with `pct_change`.
5. `dbt build` succeeds and the regression analysis shows no differences.
6. Count lines of SQL before and after:

```bash
git stash && find models -name "*.sql" | xargs cat | wc -l && git stash pop
find models macros -name "*.sql" | xargs cat | wc -l
```

<details>
<summary>Solution — <code>int_gdp__levels</code> and <code>int_gdp__growth</code></summary>

```sql
-- models/intermediate/gdp/int_gdp__levels.sql
-- Grain: one row per quarter (Canada, SAAR). Levels in $ millions; deflator 100 = base year.
select
    quarter,
    max(value) filter (where prices like 'Chained%')       as real_gdp,
    max(value) filter (where prices = 'Current prices')    as nominal_gdp,
    100 * nominal_gdp / real_gdp                           as gdp_deflator
from {{ ref('stg_statcan__gdp') }}
where estimate = 'Gross domestic product at market prices'
  and seasonal_adjustment = 'Seasonally adjusted at annual rates'
group by quarter
```

```sql
-- models/intermediate/gdp/int_gdp__growth.sql
-- Grain: one row per quarter. Gap-safe real GDP growth (%).
{{ growth_rates(
    relation    = ref('int_gdp__levels'),
    value_col   = 'real_gdp',
    date_col    = 'quarter',
    keep_cols   = ['nominal_gdp', 'gdp_deflator'],
    horizons    = var('quarterly_horizons'),
    step_months = 3
) }}
```

`100 * nominal_gdp / real_gdp` references two aliases from the same `select`, a DuckDB convenience (Day 17). Deflator growth and the 4-quarter moving average can be added in a small downstream model (`int_gdp__growth_extended`), or by calling `growth_rates` a second time on the deflator.

</details>

### Day 35 checklist
- [ ] I can tell repetition of *knowledge* (worth a macro) from coincidental similarity (not worth it)
- [ ] I write scalar macros with arguments and defaults, and macros that call macros
- [ ] `growth_rates()` generates gap-safe measures for monthly and quarterly data from `vars`
- [ ] I use `run_query` safely (`execute`, `depends_on`) to drive SQL from seeds
- [ ] I debug macros with compiled SQL and `log()`, and document them in YAML

```bash
dbt build && cd .. && git add . && git commit -m "Day 35: macros, growth_rates, run_query from seeds" && git push
```

---

# DAY 36 — Testing and Packages

| Time | Block |
|---|---|
| 0:00 – 0:25 | 36.1 Generic tests: `unique`, `not_null`, `accepted_values`, `relationships` |
| 0:25 – 0:45 | 36.2 Packages: installing `dbt_utils` |
| 0:45 – 0:53 | Break |
| 0:53 – 1:13 | 36.3 Singular tests: porting Module 2's SQL tests |
| 1:13 – 1:33 | 36.4 Custom generic tests: economic ranges |
| 1:33 – 1:40 | Break |
| 1:40 – 2:03 | 36.5 Unit tests: proving the growth macro is gap-safe |
| 2:03 – 2:18 | 36.6 Source freshness |
| 2:18 – 2:30 | 36.7 Wiring tests into the pipeline |

---

## 36.1 Generic Tests (25 min)

> **Question it answers:** Are CPI months never missing, geography levels always valid, and keys never duplicated?
>
> **Other questions you can answer the same way:**
> - Does any model contain nulls where it shouldn't?
> - Are all status flags known values?

A **data test** in dbt is exactly what you built on Day 18: a query that returns violating rows, where **zero rows = pass**. dbt ships four ready-made **generic** tests, applied in YAML:

| Test | Asserts |
|---|---|
| `unique` | no duplicate values in the column |
| `not_null` | no `NULL`s |
| `accepted_values` | values come from a list |
| `relationships` | every value exists in another model's column (a foreign key) |

Add tests to `models/staging/statcan/_statcan__models.yml`:

```yaml
version: 2

models:
  - name: stg_statcan__cpi
    description: "Typed StatCan CPI (18-10-0004-01), NSA. Grain: month × geo × component × index base."
    columns:
      - name: month
        data_tests: [not_null]
      - name: geo_level
        data_tests:
          - accepted_values:
              values: ['national', 'province', 'city']
      - name: cpi
        data_tests: [not_null]

  - name: stg_statcan__observations
    columns:
      - name: series_id
        data_tests:
          - not_null
          - relationships:
              to: ref('seed_series')
              field: series_id
```

And to `seeds/_seeds.yml`:

```yaml
  - name: seed_series
    columns:
      - name: series_id
        data_tests: [unique, not_null]
      - name: series_name
        data_tests: [unique, not_null]
      - name: monthly_agg
        data_tests:
          - accepted_values:
              values: ['last', 'mean']
```

Run:

```bash
dbt test --select stg_statcan__cpi stg_statcan__observations seed_series
```

The `relationships` test replaces Day 30's `series_without_seed.sql`: every ingested series must be described in the seed.

### Seeing failures

> **Question it answers:** Which exact rows broke a test?
>
> **Other questions you can answer the same way:**
> - Where are the duplicate CPI rows?

```bash
dbt test --select stg_statcan__cpi --store-failures
```

With `--store-failures`, dbt saves each failing test's rows in a table (in a schema like `dev_dbt_test__audit`), so you can query exactly *what* failed.

### Severity and thresholds

> **Question it answers:** Which problems should only warn me, and which should stop the build?
>
> **Other questions you can answer the same way:**
> - How do I accept a few unknown flags in old data but not in recent data?

```yaml
      - name: status_flag
        data_tests:
          - accepted_values:
              values: ['A', 'B', 'C', 'D', 'E', 'F', '..', 'x']
              config:
                severity: warn                 # report, don't fail
                where: "month >= date '2015-01-01'"
```

| Config | Effect |
|---|---|
| `severity: warn` | failures print as warnings; `dbt build` continues |
| `where:` | test only a subset of rows |
| `warn_if` / `error_if` | thresholds, e.g. `error_if: ">100"` |

(Check the status codes you actually see with `select distinct status_flag from …` and adjust the list. The purpose here is to notice *new* codes.)

> In dbt ≥ 1.8, tests are listed under `data_tests:`. Older projects use `tests:`, which still works.

---

## 36.2 Packages: Installing `dbt_utils` (20 min)

**Packages** are dbt projects you import: macros, tests and models written by others. The most widely used is `dbt_utils`.

Create `macro_dbt/packages.yml`:

```yaml
packages:
  - package: dbt-labs/dbt_utils
    version: [">=1.1.0", "<2.0.0"]
```

```bash
dbt deps
ls dbt_packages/
```

`dbt deps` downloads packages into `dbt_packages/` (already in `.gitignore`). Commit `packages.yml` and the generated `package-lock.yml` so everyone gets the same versions.

### Useful `dbt_utils` tests

> **Question it answers:** Is each month × geography × component × base combination unique, and are values within sensible ranges?
>
> **Other questions you can answer the same way:**
> - Are there gaps in a monthly series?
> - Is a composite key really unique?

```yaml
models:
  - name: stg_statcan__cpi
    data_tests:
      - dbt_utils.unique_combination_of_columns:          # composite primary key
          combination_of_columns: [month, geo, component, index_base]

  - name: int_cpi__growth
    columns:
      - name: month
        data_tests:
          - dbt_utils.sequential_values:                   # no missing months
              interval: 1
              datepart: month
              group_by_columns: ['geo', 'component']
              config:
                where: "geo_level in ('national', 'province') and component = 'All-items'"
      - name: yoy
        data_tests:
          - dbt_utils.accepted_range:
              min_value: -20
              max_value: 30
              config:
                where: "geo_level = 'national'"
```

| `dbt_utils` test | Replaces from Module 2 |
|---|---|
| `unique_combination_of_columns` | `cpi_unique_keys.sql` |
| `sequential_values` | `cpi_no_gaps_core.sql` |
| `accepted_range` | range checks |
| `expression_is_true` | any row-level rule, e.g. `"real_gdp > 0"` |
| `recency` | "the latest date is recent" (per model) |

### Useful `dbt_utils` macros

> **Question it answers:** How do I select all columns except a few, or build a calendar, without writing it by hand?
>
> **Other questions you can answer the same way:**
> - How do I drop technical columns from a model?

```sql
-- all columns except some
select {{ dbt_utils.star(from=ref('stg_boc__observations'), except=['load_id']) }}
from {{ ref('stg_boc__observations') }}

-- a calendar without hand-written range()
{{ dbt_utils.date_spine(datepart="day",
                        start_date="cast('1990-01-01' as date)",
                        end_date="cast('2031-01-01' as date)") }}

-- a hash key from several columns
{{ dbt_utils.generate_surrogate_key(['series_id', 'obs_date']) }}
```

### Try it 36.2

Rewrite `dim_date`'s `spine` CTE with `dbt_utils.date_spine`. It returns a column named `date_day`. Rebuild and check the row count is unchanged.

<details>
<summary>Solution</summary>

```sql
with spine as (

    {{ dbt_utils.date_spine(datepart="day",
                            start_date="cast('1990-01-01' as date)",
                            end_date="cast('2031-01-01' as date)") }}

)

select
    cast(date_day as date) as date_day,
    ...
```

</details>

---

## 36.3 Singular Tests: Porting Module 2's SQL Tests (20 min)

> **Question it answers:** Does each policy cycle's total basis points equal the change from the rate before to the rate after?
>
> **Other questions you can answer the same way:**
> - Do my derived numbers agree with each other?

A **singular test** is a `.sql` file in `tests/` returning violating rows: exactly the Day 18 format, now with `ref()`. Port the tests that don't fit a generic pattern.

**`tests/assert_policy_cycles_add_up.sql`**

```sql
-- Each cycle's total_bp must equal the change from rate_before to rate_after
select *
from {{ ref('policy_cycles') }}
where round((rate_after - rate_before) * 100) <> total_bp
```

**`tests/assert_series_fresh.sql`**

```sql
{{ config(severity='warn') }}
-- Each series' latest observation must be within its seed-defined staleness tolerance
select
    s.series_name,
    max(o.obs_date)          as latest,
    s.max_staleness_days
from {{ ref('seed_series') }} as s
left join {{ ref('int_macro__observations') }} as o using (series_id)
group by all
having max(o.obs_date) is null
    or max(o.obs_date) < current_date - s.max_staleness_days
```

**`tests/assert_policy_decisions_consistent.sql`**

```sql
-- The recorded change_bp must match the change in rate between decisions (Day 15)
with checked as (
    select
        decision_date,
        change_bp,
        round((rate - lag(rate) over (order by decision_date)) * 100) as computed_bp
    from {{ ref('seed_boc_decisions') }}
)
select * from checked
where computed_bp is not null and computed_bp <> change_bp
```

```bash
dbt test --select test_type:singular
```

`{{ config(severity='warn') }}` inside a test file plays the role of Day 18's `-- severity: warn` header, but understood natively by dbt.

---

## 36.4 Custom Generic Tests: Economic Ranges (20 min)

> **Question it answers:** Are inflation, unemployment and rates inside economically plausible ranges?
>
> **Other questions you can answer the same way:**
> - Did a units error turn 2.5% into 250%?
> - Is any rate negative where it shouldn't be?

When the same *kind* of check applies to many columns, write your own **generic test**. It's a special macro that receives the model and column.

Create `tests/generic/within_range.sql`:

```sql
{% test within_range(model, column_name, min_value, max_value) %}

select {{ column_name }} as offending_value, *
from {{ model }}
where {{ column_name }} is not null
  and ({{ column_name }} < {{ min_value }} or {{ column_name }} > {{ max_value }})

{% endtest %}
```

A second one, for a rule used all over macro data:

```sql
-- tests/generic/is_first_of_period.sql
{% test is_first_of_period(model, column_name, period='month') %}

select *
from {{ model }}
where {{ column_name }} <> cast(date_trunc('{{ period }}', {{ column_name }}) as date)

{% endtest %}
```

Use them like built-ins:

```yaml
  - name: int_rates__monthly
    columns:
      - name: month
        data_tests:
          - unique
          - is_first_of_period: {period: month}
      - name: overnight_rate
        data_tests:
          - within_range: {min_value: -1, max_value: 25}
      - name: unemployment_rate
        data_tests:
          - within_range: {min_value: 0, max_value: 100}      # the curriculum's classic rule
      - name: usd_cad
        data_tests:
          - within_range: {min_value: 0.8, max_value: 2.0}

  - name: int_gdp__growth
    columns:
      - name: quarter
        data_tests:
          - unique
          - is_first_of_period: {period: quarter}
      - name: real_qoq_ann
        data_tests:
          - within_range: {min_value: -60, max_value: 60}
```

> **Economic ranges are judgement calls.** Write the reason next to each range in the column's `description`. When a range fails, the question is *"is the data wrong, or has the economy done something unprecedented?"* The 2020 GDP swings would have broken a ±20% range. Great Expectations (Days 41–50) adds statistical profiling to support these judgements.

---

## 36.5 Unit Tests: Proving the Growth Macro Is Gap-Safe (23 min)

> **Question it answers:** Does the growth calculation return NULL after a missing quarter, and compare YoY exactly four quarters back?
>
> **Other questions you can answer the same way:**
> - Is my calculation logic right, independent of the real data?

Data tests check **real data**. **Unit tests** check **logic**, using tiny hand-made inputs with known answers (available in dbt ≥ 1.8). They're the SQL version of Day 10's `pytest` parser tests.

We'll prove three properties of `growth_rates()` via `int_gdp__growth`:
1. quarter-on-quarter growth is correct;
2. a **missing quarter** produces `NULL` instead of a wrong number;
3. year-on-year growth still works across the gap.

We pick levels whose ratios are exact in binary arithmetic (64 → 80 → 100 → 128), so expected values are exact and floating-point noise can't cause false failures.

Add to `models/intermediate/gdp/_gdp__models.yml`:

```yaml
unit_tests:
  - name: gdp_growth_is_gap_safe
    description: "qoq is NULL after a missing quarter; yoy compares exactly 4 quarters back."
    model: int_gdp__growth
    given:
      - input: ref('int_gdp__levels')
        rows:
          - {quarter: 2024-01-01, real_gdp: 64}
          - {quarter: 2024-04-01, real_gdp: 80}
          - {quarter: 2024-07-01, real_gdp: 100}
          # 2024-10-01 deliberately missing
          - {quarter: 2025-01-01, real_gdp: 128}
    expect:
      rows:
        - {quarter: 2024-01-01, real_qoq: null, real_yoy: null}
        - {quarter: 2024-04-01, real_qoq: 25,   real_yoy: null}
        - {quarter: 2024-07-01, real_qoq: 25,   real_yoy: null}
        - {quarter: 2025-01-01, real_qoq: null, real_yoy: 100}
```

```bash
dbt test --select "int_gdp__growth,test_type:unit"
```

- `given` **mocks** the model's inputs; your real data is not used.
- Columns not listed in `given` are filled with `NULL`; `expect` checks only the columns you list.
- Unit tests need the parent model to exist in the database (for its column types), so run `dbt build` once first.

Now **break the macro on purpose**: change `lag * step_months` to just `lag` and re-run. The test fails, because the quarter check now looks 1 month back instead of 3. Restore it. This is how you protect core logic when refactoring.

### Try it 36.5

Write a unit test for `int_rates__monthly_long` proving that `overnight_rate` takes the **last** value in a month while `cad_usd` takes the **mean**. Mock `ref('int_macro__observations')` with three daily rows of each series in one month.

<details>
<summary>Solution</summary>

```yaml
unit_tests:
  - name: monthly_aggregation_follows_seed_rule
    model: int_rates__monthly_long
    given:
      - input: ref('int_macro__observations')
        rows:
          - {obs_date: 2026-07-02, series_name: overnight_rate, monthly_agg: last, value: 2.50}
          - {obs_date: 2026-07-15, series_name: overnight_rate, monthly_agg: last, value: 2.50}
          - {obs_date: 2026-07-30, series_name: overnight_rate, monthly_agg: last, value: 2.25}
          - {obs_date: 2026-07-02, series_name: cad_usd,        monthly_agg: mean, value: 0.70}
          - {obs_date: 2026-07-15, series_name: cad_usd,        monthly_agg: mean, value: 0.72}
          - {obs_date: 2026-07-30, series_name: cad_usd,        monthly_agg: mean, value: 0.74}
    expect:
      rows:
        - {month: 2026-07-01, series_name: overnight_rate, value: 2.25}
        - {month: 2026-07-01, series_name: cad_usd,        value: 0.72}
```

If the mean shows a floating-point mismatch (e.g. `0.7199999…`), choose values whose mean is exact in binary, such as 0.5, 0.75 and 1.0.

</details>

---

## 36.6 Source Freshness (15 min)

> **Question it answers:** How long ago was each raw source loaded, and is any of it too old?
>
> **Other questions you can answer the same way:**
> - Did the BoC data stop updating?
> - When was FRED last loaded?

Is the **raw** data up to date? dbt can check how long ago each source was loaded. dlt's `_dlt_load_id` is a Unix timestamp stored as text, so we convert it.

In `models/staging/boc/_boc__sources.yml`, add to the source:

```yaml
sources:
  - name: boc
    schema: raw_dlt
    loaded_at_field: "to_timestamp(cast(_dlt_load_id as double))"
    freshness:
      warn_after: {count: 2, period: day}
      error_after: {count: 7, period: day}
    tables:
      - name: observations
        identifier: boc_observations
      - name: series_metadata
        identifier: boc_series_metadata
        freshness: null                  # metadata: no freshness check
```

(Newer dbt versions may suggest nesting `freshness` and `loaded_at_field` under `config:`. Follow the warning your version prints.)

```bash
dbt source freshness
```

| Check | Question it answers |
|---|---|
| `dbt source freshness` | "Did **ingestion** run recently?" |
| `assert_series_fresh` (36.3) | "Is each **series** as recent as its publication rhythm allows?" |

Both matter. A pipeline can run every day and still load stale data if a provider stops publishing.

---

## 36.7 Wiring Tests into the Pipeline (13 min)

> **Question it answers:** How do I make the pipeline stop before bad data reaches the marts?
>
> **Other questions you can answer the same way:**
> - Did today's build pass all tests?

`dbt build` runs seeds, models, snapshots **and tests** in DAG order. If a test fails with severity `error`, dbt **skips everything downstream** of the failing model, so bad data can't flow into marts.

Update `pipeline.sh` (repository root):

```bash
#!/usr/bin/env bash
# pipeline.sh — ingest → dbt build (models + tests) → legacy loader (until cut-over)
set -e
source .venv/bin/activate

python ingest.py || [ $? -eq 2 ]

cd macro_dbt
dbt source freshness || echo "⚠ freshness warnings — see above"
dbt build
cd ..

python load_warehouse.py          # Module 2 objects: retired at the Days 38–40 cut-over
python run_tests.py
echo "✓ Pipeline complete"
```

Retire each file in `sql/tests/` once an equivalent dbt test exists. By the end of Day 37 `run_tests.py` should only cover Module 2 objects still awaiting cut-over.

### Day 36 checklist
- [ ] I apply `unique`, `not_null`, `accepted_values` and `relationships` in YAML, with severities and `where`
- [ ] I install packages with `dbt deps` and use `dbt_utils` tests and macros
- [ ] Module 2's SQL tests are ported to singular or generic dbt tests
- [ ] I wrote custom generic tests for economic ranges and period alignment
- [ ] A unit test proves `growth_rates()` is gap-safe
- [ ] `dbt source freshness` checks ingestion recency; a singular test checks series staleness
- [ ] `dbt build` gates downstream models on test results

```bash
cd macro_dbt && dbt build && cd .. && git add . && git commit -m "Day 36: tests, dbt_utils, unit tests, freshness" && git push
```

---

# DAY 37 — Incremental Models, Snapshots and Project Quality

| Time | Block |
|---|---|
| 0:00 – 0:30 | 37.1 Incremental models |
| 0:30 – 0:50 | 37.2 Snapshots: tracking revisions inside the warehouse |
| 0:50 – 0:58 | Break |
| 0:58 – 1:20 | 37.3 Advanced DRY: generating staging models, `union_relations` |
| 1:20 – 1:35 | 37.4 Operational macros with `run-operation` |
| 1:35 – 1:43 | Break |
| 1:43 – 1:55 | 37.5 Project quality: conventions, linting, a review checklist |
| 1:55 – 2:30 | 37.6 Capstone: complete, DRY, tested intermediate layer |

---

## 37.1 Incremental Models (30 min)

A `table` model is rebuilt **completely** on every run. An **incremental** model processes only **new or changed rows** and merges them into the existing table. It's dlt's `merge` (Day 27), but inside the warehouse.

### Is it worth it here?

Honestly, for most of our models, **no**: DuckDB rebuilds them in seconds. But the pattern matters as data grows (daily data for hundreds of series, or tick data), and it teaches you to think carefully about **what "new" means**. We'll build one good example: a fact table of every observation.

### What counts as "new"? Use the load timestamp

> **Question it answers:** How do I process only observations that are new or revised since the last build?
>
> **Other questions you can answer the same way:**
> - How do I make large tables rebuild quickly every day?

Thanks to dlt's `merge`, a **revised** observation is rewritten with a **new load ID** (Day 27). So "rows loaded after my last run" captures both new observations **and** revisions. This is more robust than "dates after my latest date", which would miss revisions entirely.

Create `models/marts/core/fct_observations.sql`:

```sql
{{ config(
    materialized         = 'incremental',
    unique_key           = ['series_id', 'obs_date'],
    incremental_strategy = 'delete+insert',
    on_schema_change     = 'fail'
) }}

-- Grain: one row per series × observation date (all providers)
select
    {{ dbt_utils.generate_surrogate_key(['series_id', 'obs_date']) }}  as observation_key,
    series_id,
    series_name,
    provider,
    obs_date,
    value,
    loaded_at
from {{ ref('int_macro__observations') }}

{% if is_incremental() %}
where loaded_at > (select coalesce(max(loaded_at), timestamp '1900-01-01') from {{ this }})
{% endif %}
```

New Jinja pieces:

| Piece | Meaning |
|---|---|
| `is_incremental()` | `true` only when the table already exists and this isn't a full refresh |
| `{{ this }}` | the model's own existing table |
| `unique_key` | rows with these keys are replaced when they reappear |
| `incremental_strategy='delete+insert'` | delete matching keys, then insert the new batch |
| `on_schema_change='fail'` | stop if columns change; don't silently drift (Day 25's contract idea) |

### See it work

> **Question it answers:** How many rows does each incremental run actually process?
>
> **Other questions you can answer the same way:**
> - Did the latest build pick up the new data?

```bash
dbt run --select fct_observations                 # first run: builds the full table
dbt run --select fct_observations                 # second run: nothing new → inserts 0 rows
cd .. && python ingest.py && cd macro_dbt         # new data arrives
dbt run --select +fct_observations                # processes only newly loaded rows
cat target/run/macro_dbt/models/marts/core/fct_observations.sql
```

Read the executed SQL on an incremental run: a temporary batch, a `delete` of matching keys, then an `insert`.

### Full refresh

> **Question it answers:** How do I rebuild an incremental table from scratch after changing its logic?
>
> **Other questions you can answer the same way:**
> - How do I recover from a bad incremental build?

When logic changes, rebuild from scratch:

```bash
dbt run --select fct_observations --full-refresh
```

> **Incremental pitfalls to remember:** (1) rows *deleted* upstream are never deleted downstream; (2) late-arriving data with an old `loaded_at` would be missed; (3) any logic change needs `--full-refresh`. Add a test comparing row counts with the source (Try it 37.1). Our choice of `loaded_at` avoids pitfall 2 because dlt stamps every rewrite.

### Try it 37.1

Write a singular test `tests/assert_fct_observations_complete.sql` that fails if `fct_observations` has a different number of rows than `int_macro__observations`.

<details>
<summary>Solution</summary>

```sql
with a as (select count(*) as n from {{ ref('fct_observations') }}),
     b as (select count(*) as n from {{ ref('int_macro__observations') }})
select a.n as fct_rows, b.n as source_rows
from a, b
where a.n <> b.n
```

</details>

---

## 37.2 Snapshots: Tracking Revisions Inside the Warehouse (20 min)

> **Question it answers:** How has each month's national CPI value been revised over time, and when did each revision happen?
>
> **Other questions you can answer the same way:**
> - Which CPI months were revised in the last release?
> - What was the value before the revision?

On Day 27 you kept **vintages** in dlt with an append-only table. dbt offers a warehouse-side alternative: **snapshots**, which record how a row changes over time (a *type-2 slowly changing dimension*).

Create `snapshots/snap_cpi_national.sql`:

```sql
{% snapshot snap_cpi_national %}

{{ config(
    target_schema = 'snapshots',
    unique_key    = 'snapshot_key',
    strategy      = 'check',
    check_cols    = ['cpi']
) }}

-- One row per national CPI component × month; a new version whenever the value changes
select
    month || '|' || component   as snapshot_key,
    month,
    component,
    cpi
from {{ ref('stg_statcan__cpi') }}
where geo_code = 'CA'

{% endsnapshot %}
```

```bash
dbt snapshot
```

dbt adds `dbt_valid_from` and `dbt_valid_to` columns. The first run records every row as valid from now. On later runs, a row whose `cpi` changed gets its old version **closed** (`dbt_valid_to` set) and a new version **opened**.

Find every revision ever observed:

```sql
select month, component, cpi, dbt_valid_from, dbt_valid_to
from snapshots.snap_cpi_national
where snapshot_key in (
    select snapshot_key from snapshots.snap_cpi_national
    group by snapshot_key having count(*) > 1
)
order by snapshot_key, dbt_valid_from;
```

| Approach | Where | Captures |
|---|---|---|
| dlt append-only vintages (Day 27) | ingestion | exactly what each API call returned |
| dbt snapshot | warehouse | changes between successive `dbt snapshot` runs |

Snapshots only see what exists **when they run**, so schedule `dbt snapshot` with every pipeline run (`dbt build` includes snapshots). Newer dbt versions also let you define snapshots in YAML. The block syntax shown here works across versions.

> Why does this matter for economists? Forecast evaluation (Days 61–70) must use the data **as it was known at the time**, not today's revised figures. Snapshots let you reconstruct that.

---

## 37.3 Advanced DRY: Generating Staging Models, `union_relations` (23 min)

### A macro for identical staging models

> **Question it answers:** How do I generate the three almost identical provider staging models from one macro?
>
> **Other questions you can answer the same way:**
> - How do I add a fourth provider with one line?

The three `stg_<provider>__observations` models differ only in the source name:

```sql
-- macros/stg_observations.sql
{% macro stg_observations(source_name) %}

with source as (

    select * from {{ source(source_name, 'observations') }}

)

select
    cast(date as date)       as obs_date,
    series_id,
    value,
    '{{ source_name }}'      as provider,
    _dlt_load_id             as load_id
from source

{% endmacro %}
```

Each model file becomes one line:

```sql
-- models/staging/boc/stg_boc__observations.sql
-- Grain: one row per BoC series × observation date
{{ stg_observations('boc') }}
```

**Is this good DRY?** Yes here: the three models share *meaning* (dlt's standard observation schema) and must change together. It would be **bad** DRY if one provider later needed special handling. Then you'd write that model out in full rather than add an `if provider == ...` branch to the macro.

### `dbt_utils.union_relations`

> **Question it answers:** How do I combine all provider models even if their columns differ slightly?
>
> **Other questions you can answer the same way:**
> - How do I stack tables safely when one has an extra column?

Instead of hand-writing `union all` in `int_macro__observations`:

```sql
with unioned as (

    {{ dbt_utils.union_relations(relations=[
        ref('stg_boc__observations'),
        ref('stg_fred__observations'),
        ref('stg_statcan__observations')
    ]) }}

)
```

`union_relations` matches columns **by name** (like `UNION ALL BY NAME`, Day 12), fills missing columns with `NULL`, and adds a `_dbt_source_relation` column recording which model each row came from. Adding a fourth provider means adding one `ref()` to the list.

---

## 37.4 Operational Macros with `run-operation` (15 min)

Macros can also **do things** rather than generate model SQL: reports, maintenance, administration. Run them with `dbt run-operation`.

### A staleness report

> **Question it answers:** Which series are older than their allowed staleness, and what is their latest date?
>
> **Other questions you can answer the same way:**
> - Which indicators haven't updated this week?

Create `macros/ops/report_stale_series.sql`:

```sql
{% macro report_stale_series() %}

    {% set query %}
        select
            s.series_name,
            cast(max(o.obs_date) as varchar)  as latest,
            s.max_staleness_days
        from {{ ref('seed_series') }} as s
        left join {{ ref('int_macro__observations') }} as o using (series_id)
        group by all
        having max(o.obs_date) is null
            or max(o.obs_date) < current_date - s.max_staleness_days
        order by 1
    {% endset %}

    {% set rows = run_query(query) %}
    {% if rows | length == 0 %}
        {{ log("✓ All series are within their staleness tolerance.", info=True) }}
    {% else %}
        {% for r in rows %}
            {{ log("⚠ STALE: " ~ r[0] ~ " (latest " ~ r[1] ~ ", tolerance "
                   ~ r[2] ~ " days)", info=True) }}
        {% endfor %}
    {% endif %}

{% endmacro %}
```

```bash
dbt run-operation report_stale_series
```

### Cleaning up dev schemas

> **Question it answers:** How do I safely remove old development schemas, with a dry run first?
>
> **Other questions you can answer the same way:**
> - Which dev schemas are cluttering the warehouse?

```sql
-- macros/ops/drop_dev_schemas.sql
{% macro drop_dev_schemas(dry_run=true) %}
    {% if target.name != 'dev' %}
        {{ exceptions.raise_compiler_error("drop_dev_schemas only runs on the dev target") }}
    {% endif %}
    {% set schemas = run_query(
        "select distinct schema_name from information_schema.schemata where schema_name like 'dev%'"
    ).columns[0].values() %}
    {% for s in schemas %}
        {% if dry_run %}
            {{ log("would drop schema " ~ s, info=True) }}
        {% else %}
            {% do run_query("drop schema if exists " ~ s ~ " cascade") %}
            {{ log("dropped schema " ~ s, info=True) }}
        {% endif %}
    {% endfor %}
{% endmacro %}
```

```bash
dbt run-operation drop_dev_schemas                        # dry run: lists only
dbt run-operation drop_dev_schemas --args '{dry_run: false}'
dbt build                                                  # rebuild dev from scratch
```

Notice the **guard rails**: the macro refuses to run outside `dev`, and it defaults to a dry run. Any operational macro that deletes things should have both.

`{% do … %}` runs an expression for its side effect without printing anything.

---

## 37.5 Project Quality (13 min)

### Conventions, written down

> **Question it answers:** What naming, layering and testing rules should every model in this project follow?
>
> **Other questions you can answer the same way:**
> - How should I name a new intermediate model?

Add `macro_dbt/CONVENTIONS.md`:

```markdown
# macro_dbt conventions
- Layers: staging (views, 1 per source table) → intermediate (by concept) → marts (tables)
- Names: stg_<source>__<entity>, int_<concept>__<what>, fct_/dim_ for dimensional marts
- Only staging calls source(); marts never ref() staging directly
- Every model: grain comment at top + description in YAML
- Every model with a key: unique (or unique_combination_of_columns) + not_null tests
- Lowercase SQL, CTEs named as nouns, one column per line, trailing commas
- Constants in vars; series configuration in seeds; no hard-coded series lists
- Macros only for shared *meaning*; document every macro in _macros.yml
```

### Optional: automatic SQL linting

> **Question it answers:** How do I check SQL style automatically before committing?
>
> **Other questions you can answer the same way:**
> - Does my SQL follow the project's style rules?

```bash
pip install sqlfluff sqlfluff-templater-dbt
```

With a small `.sqlfluff` configuration (`templater = dbt`, `dialect = duckdb`), `sqlfluff lint models/` checks style, and can check it automatically before each commit. It's optional, but common in professional dbt teams.

### A review checklist for new models

- [ ] Correct layer and folder? Name follows conventions?
- [ ] Grain documented? Key tested for uniqueness?
- [ ] Reads only from the layer(s) it's allowed to?
- [ ] Materialisation justified?
- [ ] No duplicated logic that a macro or upstream model already provides?
- [ ] Regression-checked against the previous version, if it replaced something?

---

## 37.6 Capstone: A Complete, DRY, Tested Intermediate Layer (35 min)

> **Question it answers:** What are the smoothed inflation measures, base-effect projections and core proxies, built with reusable macros and fully tested?
>
> **Other questions you can answer the same way:**
> - Does the dbt intermediate layer match Module 2's numbers?

Finish porting the remaining Module 2 intermediate logic, applying everything from Days 34–37.

**Requirements:**
1. **`int_cpi__smoothed`**: moving averages with the `min_periods` rule (Day 19). Write a macro `rolling_avg(col, n_periods, partition_by, order_by, step='month')` that returns the `case when count(...) = n then avg(...) end` expression over a `range between interval (n-1) month preceding and current row` window, and use it for `yoy_ma3`, `yoy_ma12` and `mom_ma3`.
2. **`int_cpi__national_measures`**: port Day 19's model (headline, core ex food & energy, shelter/energy/food, median of majors, diffusion, contributions with residual, next-month-if-flat), using `pct_change` and `ref('seed_cpi_weights')`.
3. **`int_gdp__cycle_flags`**: technical recession + `overlaps_recession(quarter, quarter + 3 months − 1 day)`.
4. **Tests:** keys unique; `is_first_of_period`; `within_range` on headline YoY (−5, 20) and GDP growth; a unit test for `rolling_avg` proving that a 3-month average is `NULL` until 3 observations exist.
5. **Incremental + snapshot:** `fct_observations` and `snap_cpi_national` from 37.1–37.2 included in `dbt build`.
6. **Regression:** extend `analyses/regression_vs_module2.sql` with `int_cpi__national_measures` and `int_gdp__cycle_flags`, and get zero unexplained differences.
7. `dbt build` green; `dbt run-operation report_stale_series` runs; docs regenerated.

<details>
<summary>Solution — the <code>rolling_avg</code> macro and its use</summary>

```sql
-- macros/rolling_avg.sql
{#
  rolling_avg(): trailing moving average over n periods, NULL until n observations exist
  (pandas' rolling(n, min_periods=n)). Uses a RANGE frame, so gaps in the date column
  shrink the window instead of silently widening it (Day 16).
#}
{% macro rolling_avg(col, n_periods, order_by, partition_by=[], step='month') -%}
    case
        when count({{ col }}) over (
            {% if partition_by %}partition by {{ partition_by | join(', ') }}{% endif %}
            order by {{ order_by }}
            range between interval {{ n_periods - 1 }} {{ step }} preceding and current row
        ) = {{ n_periods }}
        then avg({{ col }}) over (
            {% if partition_by %}partition by {{ partition_by | join(', ') }}{% endif %}
            order by {{ order_by }}
            range between interval {{ n_periods - 1 }} {{ step }} preceding and current row
        )
    end
{%- endmacro %}
```

```sql
-- models/intermediate/cpi/int_cpi__smoothed.sql
-- Grain: month × geography × component. Adds moving averages and 12-month acceleration.
select
    *,
    {{ rolling_avg('yoy', 3,  'month', ['geo', 'component']) }}   as yoy_ma3,
    {{ rolling_avg('yoy', 12, 'month', ['geo', 'component']) }}   as yoy_ma12,
    {{ rolling_avg('mom', 3,  'month', ['geo', 'component']) }}   as mom_ma3,
    yoy - lag(yoy, 12) over (partition by geo, component order by month) as yoy_change_12m
from {{ ref('int_cpi__growth') }}
```

```yaml
unit_tests:
  - name: rolling_avg_respects_min_periods
    model: int_cpi__smoothed
    given:
      - input: ref('int_cpi__growth')
        rows:
          - {month: 2026-01-01, geo: Canada, component: All-items, yoy: 1.0, mom: 0.5}
          - {month: 2026-02-01, geo: Canada, component: All-items, yoy: 2.0, mom: 0.5}
          - {month: 2026-03-01, geo: Canada, component: All-items, yoy: 3.0, mom: 0.5}
    expect:
      rows:
        - {month: 2026-01-01, yoy_ma3: null}
        - {month: 2026-02-01, yoy_ma3: null}
        - {month: 2026-03-01, yoy_ma3: 2.0}
```

</details>

### Recap: Days 34–37

| Principle | How the project applies it |
|---|---|
| **Modularity** | one staging model per source table; intermediates by concept; marts by consumer |
| **Single source of truth** | seeds drive ingestion checks, panel columns and aggregation rules |
| **DRY** | `growth_rates`, `rolling_avg`, `pct_change`, `monthly_value`, `overlaps_recession`, `stg_observations` |
| **Tested logic** | unit tests for macros' economic rules |
| **Tested data** | generic, `dbt_utils`, custom and singular tests; source freshness |
| **Efficiency** | incremental `fct_observations` driven by dlt load timestamps |
| **History** | a snapshot recording CPI revisions |
| **Operability** | `run-operation` reports and guarded maintenance macros |

### Looking ahead: Days 38–40 — the macro data mart

- Join **yield curves** (2y, 5y, 10y GoC; term spreads) with **USD/CAD**, the BoC–Fed differential and oil to model an **open-economy dashboard schema**.
- Build `macro_monthly`, `macro_quarterly` and an open-economy mart with facts, dimensions and dashboard-ready panels.
- **Cut over** from Module 2 to dbt in **prod**, with a final regression test, and retire `load_warehouse.py`.

### Day 37 checklist
- [ ] I can build an incremental model, choose a sound definition of "new", and know its pitfalls
- [ ] I can snapshot a model to record revisions over time
- [ ] I generate identical staging models from one macro and union them with `union_relations`
- [ ] I write operational macros with guard rails and run them with `run-operation`
- [ ] My project has written conventions and a review checklist
- [ ] The intermediate layer is complete, DRY, tested and regression-checked against Module 2

```bash
cd macro_dbt && dbt build && dbt docs generate && cd ..
git add . && git commit -m "Day 37: incremental, snapshots, advanced DRY, complete intermediate layer" && git push
```
