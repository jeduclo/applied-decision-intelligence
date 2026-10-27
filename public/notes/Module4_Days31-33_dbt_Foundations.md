# Module 4 · Data Modeling with dbt
## Days 31–33: Project Initialization, Materializations & Basic Jinja Templating

**Audience:** MSc Economics students who completed Modules 1–3 (Days 1–30)
**Environment:** GitHub Codespaces · course `.venv` · `macro.duckdb` fed by `ingest.py` (dlt → `raw_dlt`)
**Time per day:** ~5 hours (including breaks and exercises)
**Goal by end of Day 33:** Students have a working dbt project, `macro_dbt`, that rebuilds the Module 2 staging and intermediate layers from `raw_dlt`. dbt works out the build order itself, materialisations are chosen deliberately, reference data is managed as seeds, and repetitive SQL is generated with Jinja. It all runs **alongside** the Module 2 warehouse in separate `dev_*` schemas, so nothing breaks while you learn.

---

### Why dbt, and why now?

In Module 2 you built a layered warehouse by hand. It works, but you felt the friction:

| Module 2 (hand-built) | dbt |
|---|---|
| Files numbered `10_`, `20_`, `30_` so they run in the right order | Order **inferred** from `ref()` — no numbering |
| `CREATE OR REPLACE VIEW …` boilerplate in every file | You write only the `SELECT`; dbt writes the DDL |
| Changing view ↔ table means rewriting the file | One configuration word: `materialized` |
| `load_warehouse.py` + `run_tests.py` written by you | `dbt run`, `dbt test`, `dbt build` |
| Seeds as `INSERT INTO … VALUES` | Seeds as CSV files, loaded with `dbt seed` |
| Documentation in SQL comments | Documentation site with a lineage graph |
| Copy-pasted SQL patterns (growth rates, pivots) | Jinja templates and macros |
| One environment | `dev` and `prod` targets from the same code |

> **The key idea:** dbt is a **compiler and runner for `SELECT` statements**. You write `SELECT`s that reference other models; dbt compiles them into plain SQL, works out the dependency graph, and runs `CREATE VIEW`/`CREATE TABLE` in the right order.

Everything you learned in Module 2 (layers, naming, CTE style, window functions, gap-safe growth rates, tests as queries) carries over **unchanged**. dbt just removes the plumbing.

### The plan for Module 4

| Days | Focus |
|---|---|
| **31–33** | Project setup, `source()`/`ref()`, materialisations, seeds, Jinja basics. Port staging + intermediate. |
| 34–37 | Modular modelling, DRY principles, macros, tests, packages |
| 38–40 | The open-economy macro data mart (yield curves × USD/CAD), docs, cut-over to production |

### Target structure (by end of Day 33)

```
macro-data-course/
├── macro.duckdb
├── ingest.py                      ← Module 3 (unchanged)
└── macro_dbt/                     ← NEW: the dbt project
    ├── dbt_project.yml
    ├── profiles.yml
    ├── seeds/
    │   ├── seed_geo.csv
    │   ├── seed_series.csv
    │   ├── seed_recession_bands.csv
    │   ├── seed_cpi_weights.csv
    │   ├── seed_boc_decisions.csv
    │   └── _seeds.yml
    ├── models/
    │   ├── staging/
    │   │   ├── _sources.yml
    │   │   ├── _staging.yml
    │   │   ├── stg_statcan__cpi.sql
    │   │   ├── stg_statcan__gdp.sql
    │   │   └── stg_macro__observations.sql
    │   └── intermediate/
    │       ├── int_cpi__growth.sql
    │       ├── int_cpi__smoothed.sql
    │       ├── int_gdp__growth.sql
    │       └── int_rates__monthly.sql
    ├── macros/
    │   └── generate_schema_name.sql
    └── analyses/
```

---

# DAY 31 — Your First dbt Project

| Time | Block |
|---|---|
| 0:00 – 0:30 | 31.1 Installing dbt with the DuckDB adapter |
| 0:30 – 1:20 | 31.2 Creating the project: `dbt_project.yml` and `profiles.yml` |
| 1:20 – 1:35 | Break |
| 1:35 – 2:20 | 31.3 Sources: telling dbt where raw data lives |
| 2:20 – 3:10 | 31.4 Your first models and `dbt run` |
| 3:10 – 3:25 | Break |
| 3:25 – 4:10 | 31.5 `ref()` and the DAG: selecting what to build |
| 4:10 – 5:00 | 31.6 Compiled SQL, `dbt show`, and a regression check |

---

## 31.1 Installing dbt with the DuckDB Adapter (30 min)

dbt talks to each database through an **adapter**. For DuckDB we use the community adapter `dbt-duckdb`, which also installs `dbt-core`.

```bash
cd /workspaces/macro-data-course
source .venv/bin/activate
pip install dbt-duckdb
pip freeze > requirements.txt
dbt --version
```

The output lists the `dbt-core` version and the installed `duckdb` plugin. Note both in your notes: the dbt documentation is versioned, so always read the version matching yours.

> dbt Labs also develops a newer engine ("Fusion") alongside the open-source `dbt-core`. This course uses `dbt-core` + `dbt-duckdb`, which is free, open source and runs entirely inside your Codespace. The SQL and project concepts carry over.

**Recommended:** install the VS Code extension **"dbt Power User"** for syntax highlighting of Jinja-SQL, go-to-definition on `ref()`, and lineage previews. It's optional, since everything today works from the terminal.

---

## 31.2 Creating the Project (50 min)

### Step 1 — Scaffold

```bash
dbt init macro_dbt --skip-profile-setup
cd macro_dbt
ls -R
```

`dbt init` creates a skeleton: `dbt_project.yml`, folders (`models/`, `seeds/`, `macros/`, `tests/`, `analyses/`, `snapshots/`) and an example model. Delete the example:

```bash
rm -rf models/example
mkdir -p models/staging models/intermediate models/marts
```

Add dbt's working folders to the repository's `.gitignore`:

```
macro_dbt/target/
macro_dbt/dbt_packages/
macro_dbt/logs/
```

### Step 2 — `dbt_project.yml`: the project's settings

Replace its content with:

```yaml
name: macro_dbt
version: "1.0.0"
config-version: 2
profile: macro_dbt              # which connection profile to use (next step)

model-paths: ["models"]
seed-paths: ["seeds"]
macro-paths: ["macros"]
test-paths: ["tests"]
analysis-paths: ["analyses"]
snapshot-paths: ["snapshots"]

target-path: "target"           # compiled SQL and run artefacts
clean-targets: ["target", "dbt_packages"]

models:
  macro_dbt:
    +materialized: view         # default for every model (Day 32 refines this)
```

YAML (like TOML on Day 23) is a settings format where **indentation means nesting**. Use spaces, never tabs. The `+` prefix marks a *configuration* (as opposed to a folder name).

### Step 3 — `profiles.yml`: how to connect

dbt looks for `profiles.yml` in the current folder before looking in `~/.dbt/`. Keeping it **in the project** makes the setup reproducible for everyone. There are no secrets here: a DuckDB connection is just a file path.

Create `macro_dbt/profiles.yml`:

```yaml
macro_dbt:
  target: dev                       # default target
  outputs:
    dev:
      type: duckdb
      path: "{{ env_var('MACRO_DUCKDB_PATH', '../macro.duckdb') }}"
      schema: dev                   # base schema for dev builds
      threads: 4
    prod:
      type: duckdb
      path: "{{ env_var('MACRO_DUCKDB_PATH', '../macro.duckdb') }}"
      schema: main
      threads: 4
```

- A **target** is a named environment. `dev` is where you experiment; `prod` is what dashboards read. Same code, different destinations, just as on Day 23.
- `{{ env_var('MACRO_DUCKDB_PATH', '../macro.duckdb') }}` is your first piece of **Jinja**: read an environment variable, with a default. The path is relative to where you run dbt (the `macro_dbt/` folder).
- Both targets point to the same file for now. They are kept apart by **schema names**: dev models will land in `dev_*` schemas (Day 32).

### Step 4 — Check the connection

```bash
dbt debug
```

You want to see `All checks passed!`. If you see a lock error, quit any open `duckdb macro.duckdb` session first: DuckDB still allows only one writer (Day 13).

---

## 31.3 Sources: Telling dbt Where Raw Data Lives (45 min)

dbt distinguishes two kinds of inputs:

| | Created by | Referenced with |
|---|---|---|
| **Source** | something outside dbt (here: dlt) | `{{ source('raw_dlt', 'boc_observations') }}` |
| **Model** | dbt itself | `{{ ref('stg_macro__observations') }}` |

Declaring sources gives you one place to rename, document and (later) test raw tables, and puts them on the lineage graph.

Create `models/staging/_sources.yml`:

```yaml
version: 2

sources:
  - name: raw_dlt
    description: "Raw tables loaded by macro_ingest (dlt), Module 3."
    schema: raw_dlt
    tables:
      - name: boc_observations
        description: "Bank of Canada Valet observations, long format, merged incrementally."
      - name: fred_observations
        description: "FRED graph CSV observations, long format."
      - name: statcan_observations
        description: "StatCan WDS vector observations, long format."
      - name: statcan_cpi_full
        description: "Full StatCan table 18-10-0004-01 (CPI), all columns as text."
      - name: statcan_gdp_full
        description: "Full StatCan table 36-10-0104-01 (GDP, expenditure-based), all columns as text."
      - name: _dlt_loads
        description: "dlt load log: one row per successful load."
```

The leading underscore in `_sources.yml` is a naming convention: YAML property files sort to the top of the folder, above the models.

```bash
dbt parse            # reads the whole project; reports YAML/Jinja errors without touching the database
dbt ls --resource-type source
```

---

## 31.4 Your First Models and `dbt run` (50 min)

A **model** is a `.sql` file containing **one `SELECT` statement**. The file name becomes the model (and table/view) name.

### Model 1 — Hello, dbt

Create `models/staging/hello_dbt.sql`:

```sql
select 2.25 as overnight_rate, 3.0 as cpi_yoy, 2.25 - 3.0 as real_rate
```

```bash
dbt run --select hello_dbt
```

Look at the log: dbt created a **view** called `hello_dbt` in the schema `dev`. Check it:

```bash
cd .. && duckdb macro.duckdb -readonly -c "select * from dev.hello_dbt" && cd macro_dbt
```

You wrote a `SELECT`; dbt wrote `CREATE VIEW dev.hello_dbt AS SELECT …`. Delete `hello_dbt.sql` now, since it has served its purpose.

> **Style note:** the dbt community writes SQL keywords in **lowercase**, and we follow that convention from now on. Case doesn't change the meaning. What matters is consistency.

### Model 2 — Staging BoC observations from a source

Create `models/staging/stg_boc__observations.sql`:

```sql
-- Grain: one row per BoC series × observation date
with source as (

    select * from {{ source('raw_dlt', 'boc_observations') }}

)

select
    cast(date as date)  as obs_date,
    series_id,
    value,
    source              as source_system,
    _dlt_load_id
from source
```

```bash
dbt run --select stg_boc__observations
```

`{{ source('raw_dlt', 'boc_observations') }}` compiles to the real table name (something like `"macro"."raw_dlt"."boc_observations"`). If a source is ever renamed or moved, you change the YAML, not every model.

### Model 3 — The full observations model (a port from Day 30)

Create `models/staging/stg_macro__observations.sql`, the dbt version of Day 30's `sql/12_stg_macro__observations.sql`. For today, series metadata still comes from the Module 2 seed table (we move it into dbt tomorrow):

```sql
-- Grain: one row per series × observation date, all providers
with unioned as (

    select date, series_id, value, source, _dlt_load_id
    from {{ source('raw_dlt', 'boc_observations') }}

    union all

    select date, series_id, value, source, _dlt_load_id
    from {{ source('raw_dlt', 'fred_observations') }}

    union all

    select date, series_id, value, source, _dlt_load_id
    from {{ source('raw_dlt', 'statcan_observations') }}

),

loads as (

    select load_id, inserted_at
    from {{ source('raw_dlt', '_dlt_loads') }}

)

select
    cast(u.date as date)  as obs_date,
    u.series_id,
    s.series_name,
    u.source,
    u.value,
    s.frequency,
    s.monthly_agg,
    l.inserted_at         as loaded_at
from unioned as u
join seeds.seed_series as s using (series_id)          -- temporary: Module 2 seed (Day 32 fixes this)
left join loads as l on l.load_id = u._dlt_load_id
```

```bash
dbt run --select staging
```

`--select staging` builds every model in the `models/staging/` folder.

---

## 31.5 `ref()` and the DAG (45 min)

Models reference other models with `{{ ref('model_name') }}`. From these references dbt builds a **DAG** (*directed acyclic graph*): a map of which models depend on which. That's how dbt knows the build order, without any file numbering.

### An intermediate model using `ref()`

Create `models/intermediate/int_rates__monthly_long.sql`:

```sql
-- Grain: one row per month × series (rates, FX, oil, CLI, unemployment)
select
    cast(date_trunc('month', obs_date) as date)  as month,
    series_name,
    case
        when monthly_agg = 'last' then arg_max(value, obs_date)
        else avg(value)
    end                                           as value
from {{ ref('stg_macro__observations') }}
group by all
```

```bash
dbt run --select int_rates__monthly_long
```

### Selecting parts of the DAG

| Selector | Builds |
|---|---|
| `--select my_model` | just that model |
| `--select +my_model` | the model **and everything upstream** (its parents) |
| `--select my_model+` | the model **and everything downstream** (its children) |
| `--select +my_model+` | both directions |
| `--select staging` | every model in `models/staging/` |
| `--select path:models/intermediate` | by path |
| `--exclude my_model` | everything except |

Preview a selection without running it:

```bash
dbt ls --select +int_rates__monthly_long
dbt ls --select stg_macro__observations+
```

> **Economist's analogy:** the DAG is an input–output table for your data. Change a raw input and `my_model+` tells you everything downstream that must be recomputed.

### Try it 31.5

1. What does `dbt ls --select +int_rates__monthly_long` list, and why does it include sources?
2. Deliberately misspell the `ref()` (e.g. `ref('stg_macro_observations')`) and run `dbt parse`. Read the error message, then fix it.

<details>
<summary>Answers</summary>

1. It lists `int_rates__monthly_long`, `stg_macro__observations`, and the four sources it reads from (the three observation tables plus `_dlt_loads`). `+` walks all the way up the graph, and sources are the graph's roots.
2. dbt refuses to parse: *"Model … depends on a node named 'stg_macro_observations' which was not found."* That's a great safety net. In Module 2, a typo in a view name would only surface when the SQL ran.

</details>

---

## 31.6 Compiled SQL, `dbt show`, and a Regression Check (50 min)

### What dbt actually runs

```bash
dbt compile --select int_rates__monthly_long
cat target/compiled/macro_dbt/models/intermediate/int_rates__monthly_long.sql
cat target/run/macro_dbt/models/intermediate/int_rates__monthly_long.sql
```

| Folder | Contains |
|---|---|
| `target/compiled/` | your `SELECT` with Jinja rendered (`ref()` replaced by real names) |
| `target/run/` | the full statement dbt executed (`create view … as (…)`) |
| `logs/dbt.log` | a detailed log of every run |

When something behaves oddly, **read the compiled SQL first**. It's plain DuckDB SQL you can paste into the CLI.

### Previewing results without opening DuckDB

```bash
dbt show --select int_rates__monthly_long --limit 5
dbt show --inline "select series_name, count(*) as n from {{ ref('int_rates__monthly_long') }} group by 1"
```

### Mini-project: port `stg_statcan__cpi` and prove it matches

1. Create `models/staging/stg_statcan__cpi.sql`, the dbt version of Day 30's `sql/10_stg_statcan__cpi.sql`: same logic and column order, reading `{{ source('raw_dlt', 'statcan_cpi_full') }}` and (temporarily) joining `seeds.seed_geo`.
2. Build it.
3. Prove it returns **exactly** the same rows as the Module 2 view `staging.stg_statcan__cpi`, using `except` in both directions (the Day 30 regression technique).

<details>
<summary>Solution</summary>

```sql
-- models/staging/stg_statcan__cpi.sql
-- Source: raw_dlt.statcan_cpi_full (StatCan 18-10-0004-01, CPI, monthly, NSA)
-- Grain:  one row per month × geography × product group

with source as (

    select * from {{ source('raw_dlt', 'statcan_cpi_full') }}

),

renamed as (

    select
        cast(ref_date || '-01' as date)       as month,
        geo,
        products_and_product_groups           as component,
        vector                                as vector_id,
        uom                                   as index_base,
        try_cast(value as double)             as cpi,
        nullif(trim(status), '')              as status_flag,
        coalesce(terminated = 't', false)     as is_terminated
    from source

)

select
    r.month,
    r.geo,
    g.geo_code,
    coalesce(g.geo_level, 'city')             as geo_level,
    r.component,
    r.vector_id,
    r.index_base,
    r.cpi,
    r.status_flag,
    r.is_terminated
from renamed as r
left join seeds.seed_geo as g using (geo)       -- temporary: Module 2 seed
where r.cpi is not null
```

```bash
dbt run --select stg_statcan__cpi

dbt show --inline "
select 'only_dbt' as side, * from (
    select * from {{ ref('stg_statcan__cpi') }}
    except
    select * from staging.stg_statcan__cpi)
union all
select 'only_module2', * from (
    select * from staging.stg_statcan__cpi
    except
    select * from {{ ref('stg_statcan__cpi') }})
" --limit 20
```

An empty result means the port is exact. Any rows point to a column or logic difference to fix before moving on.

</details>

### Day 31 checklist
- [ ] dbt and the DuckDB adapter are installed; `dbt debug` passes
- [ ] I understand `dbt_project.yml` (project settings) vs `profiles.yml` (connections and targets)
- [ ] I declare raw tables as sources and read them with `source()`
- [ ] I write models as single `SELECT`s and connect them with `ref()`
- [ ] I can select parts of the DAG with `+`, folders and paths
- [ ] I read compiled SQL, preview with `dbt show`, and verify ports with `except`

```bash
cd ..
git add .
git commit -m "Day 31: dbt project, sources, first models, DAG"
git push
```

---

# DAY 32 — Materializations, Configuration, Seeds and Documentation

| Time | Block |
|---|---|
| 0:00 – 0:50 | 32.1 Materializations: view, table, ephemeral (and a look ahead at incremental) |
| 0:50 – 1:35 | 32.2 Where configuration lives, and which setting wins |
| 1:35 – 1:50 | Break |
| 1:50 – 2:30 | 32.3 Custom schemas: `dev_staging`, `dev_intermediate`, … |
| 2:30 – 3:20 | 32.4 Seeds: reference data as CSV |
| 3:20 – 3:35 | Break |
| 3:35 – 4:15 | 32.5 Choosing materializations with evidence |
| 4:15 – 5:00 | 32.6 Documentation and the lineage graph · mini-project |

All commands today run from inside `macro_dbt/`.

---

## 32.1 Materializations (50 min)

A **materialization** decides *how* a model's `SELECT` is persisted. You met the concept on Day 13 (tables vs views). dbt makes it a one-word setting.

| Materialization | dbt creates | Storage | Freshness | Query speed | Typical layer |
|---|---|---|---|---|---|
| `view` | `create view` | none | always current | recomputed each query | staging |
| `table` | `create table as` (rebuilt each run) | full copy | as of last run | fast | marts, heavy intermediates |
| `ephemeral` | nothing: inlined as a CTE in downstream models | none | n/a | depends on parent | small helper steps |
| `incremental` | a table updated with new rows only | full copy | as of last run | fast | very large, append-heavy data (Days 34–37) |

### See the difference yourself

Change one model to a table **inside the file**, using a `config()` block at the top:

```sql
-- models/intermediate/int_rates__monthly_long.sql
{{ config(materialized='table') }}

select
    cast(date_trunc('month', obs_date) as date)  as month,
    ...
```

```bash
dbt run --select int_rates__monthly_long
cat target/run/macro_dbt/models/intermediate/int_rates__monthly_long.sql
```

The executed SQL is now a `create table … as`. Check the object type in DuckDB:

```bash
dbt show --inline "select table_schema, table_name, table_type from information_schema.tables where table_name like 'int_rates%'"
```

### Ephemeral: a model that is only a CTE

```sql
-- models/intermediate/int_cpi__national_all_items.sql
{{ config(materialized='ephemeral') }}

-- Grain: one row per month; national All-items CPI only
select month, cpi
from {{ ref('stg_statcan__cpi') }}
where geo_code = 'CA' and component = 'All-items'
```

Nothing is created in the database. Any model that `ref()`s it gets its SQL pasted in as a CTE. Try it:

```bash
dbt show --inline "select count(*) from {{ ref('int_cpi__national_all_items') }}"
```

Use ephemeral models for small, reused building blocks that aren't worth a database object. Don't overuse them: they can't be queried directly when debugging.

### A look ahead: incremental

An incremental model inserts or merges only **new** rows on each run, much like dlt's `merge` on Day 27, but inside the warehouse. It's powerful for huge tables and needs care (what counts as "new"? what about revisions?). We'll use it on Days 34–37 once tests are in place. For macro data of our size, `view` and `table` cover almost everything.

---

## 32.2 Where Configuration Lives (45 min)

Configurations can be set in three places. **The most specific wins:**

```
1. config() block inside the model file     ← highest priority
2. properties file (models/…/_staging.yml)
3. dbt_project.yml (folder-level defaults)  ← lowest priority
```

### Folder-level defaults in `dbt_project.yml`

Replace the `models:` section:

```yaml
models:
  macro_dbt:
    staging:
      +materialized: view
    intermediate:
      +materialized: view
    marts:
      +materialized: table
```

Each key under `macro_dbt:` is a **folder** in `models/`. Every model in `models/marts/` is now a table by default, with no per-file configuration needed.

### Model-level override in a properties file

Create `models/intermediate/_intermediate.yml`:

```yaml
version: 2

models:
  - name: int_rates__monthly_long
    description: "Monthly aggregation of all ingested series, using each series' monthly_agg rule."
    config:
      materialized: table
```

Now remove the `{{ config(materialized='table') }}` line from the SQL file and rebuild: it's still a table, because the YAML setting applies.

> **Convention:** set **defaults** by folder in `dbt_project.yml`, and override **exceptions** in YAML or `config()`. Use `config()` in the SQL file only when the setting is essential to understanding the model (e.g. an incremental strategy).

### Checking what dbt resolved

```bash
dbt ls --select intermediate --output json --output-keys "name config"
```

This prints each model's final configuration after all three levels are combined.

---

## 32.3 Custom Schemas (40 min)

Right now everything lands in one schema, `dev`. We want dbt's layers separated just like Module 2's (`staging`, `intermediate`, `marts`, `seeds`), **and** we want dev builds kept away from the Module 2 objects the dashboards currently use.

Add `+schema` per folder in `dbt_project.yml`:

```yaml
models:
  macro_dbt:
    staging:
      +materialized: view
      +schema: staging
    intermediate:
      +materialized: view
      +schema: intermediate
    marts:
      +materialized: table
      +schema: marts

seeds:
  macro_dbt:
    +schema: seeds
```

```bash
dbt run
dbt show --inline "select distinct table_schema from information_schema.tables order by 1"
```

You'll see `dev_staging` and `dev_intermediate`. dbt's **default** rule is `<target schema>_<custom schema>`, so dev builds can never overwrite `staging.*`.

### Making `prod` use the clean names

For production we want `staging`, not `main_staging`. dbt decides schema names with a built-in macro, `generate_schema_name`, and you can override it. Create `macros/generate_schema_name.sql`:

```sql
{% macro generate_schema_name(custom_schema_name, node) -%}
    {%- if target.name == 'prod' and custom_schema_name is not none -%}
        {{ custom_schema_name | trim }}
    {%- elif custom_schema_name is none -%}
        {{ target.schema }}
    {%- else -%}
        {{ target.schema }}_{{ custom_schema_name | trim }}
    {%- endif -%}
{%- endmacro %}
```

| Target | Folder config `+schema: staging` → schema |
|---|---|
| `dev` | `dev_staging` |
| `prod` | `staging` |

This is your first **macro**, a reusable piece of Jinja. Macros get a full treatment on Days 34–37; for now, read it as an `if/elif/else` (Day 2) that returns a schema name.

> ⚠️ **Do not run `dbt run --target prod` yet.** In prod, dbt would replace the Module 2 views in `staging.*` and `intermediate.*`. We'll do that deliberately, with a regression test, at the cut-over on Days 38–40. Until then, **dev only**.

---

## 32.4 Seeds: Reference Data as CSV (50 min)

In Module 2, seeds were `INSERT INTO … VALUES` statements in `sql/03_seeds.sql`. In dbt, a seed is simply a **CSV file** in `seeds/`, loaded with `dbt seed` and referenced with `ref()`.

### Create the CSVs

**`seeds/seed_geo.csv`**

```csv
geo,geo_code,geo_level,region
Canada,CA,national,
Newfoundland and Labrador,NL,province,Atlantic
Prince Edward Island,PE,province,Atlantic
Nova Scotia,NS,province,Atlantic
New Brunswick,NB,province,Atlantic
Quebec,QC,province,Central
Ontario,ON,province,Central
Manitoba,MB,province,Prairies
Saskatchewan,SK,province,Prairies
Alberta,AB,province,West
British Columbia,BC,province,West
```

**`seeds/seed_series.csv`**

```csv
series_id,series_name,source,frequency,monthly_agg,max_staleness_days
V39079,overnight_rate,boc,daily,last,10
FXCADUSD,cad_usd,boc,daily,mean,10
BD.CDN.2YR.DQ.YLD,yield_2yr,boc,daily,mean,10
BD.CDN.10YR.DQ.YLD,yield_10yr,boc,daily,mean,10
FEDFUNDS,fed_funds,fred,monthly,last,75
DCOILWTICO,wti,fred,daily,mean,15
CANLOLITOAASTSAM,oecd_cli,fred,monthly,mean,120
v41690973,cpi_all_items,statcan,monthly,last,75
v2062815,unemployment_rate,statcan,monthly,last,60
```

**`seeds/seed_recession_bands.csv`**

```csv
label,start_date,end_date
GFC,2008-10-01,2009-06-30
Oil shock,2015-01-01,2015-09-30
COVID,2020-02-01,2020-06-30
Tariff recession,2025-10-01,2026-03-31
```

**`seeds/seed_cpi_weights.csv`** (illustrative weights from the course notebook; see Day 18)

```csv
component,weight_pct
Shelter,29.0
Transportation,16.0
Food,15.9
"Household operations, furnishings and equipment",14.0
"Recreation, education and reading",10.4
Health and personal care,5.4
Clothing and footwear,5.0
```

Note the **double quotes** around names containing commas. That's standard CSV quoting.

**`seeds/seed_boc_decisions.csv`**: the Day 11 decision log, which is hand-maintained reference data and so a seed:

```csv
decision_date,rate,change_bp,note
2022-03-02,0.50,25,First 2022 hike
2022-04-13,1.00,50,Accelerating
2022-06-01,1.50,50,
2022-07-13,2.50,100,Jumbo hike
2022-09-07,3.25,75,
2022-10-26,3.75,50,
2022-12-07,4.25,50,
2023-01-25,4.25,0,Conditional pause
2023-03-08,4.25,0,
2023-04-12,4.25,0,
2023-06-07,4.75,50,Resumed hiking
2023-07-12,5.00,25,Peak rate
2023-09-06,5.00,0,
2024-06-05,4.75,-25,First cut
2024-07-24,4.50,-25,
2024-09-04,4.25,-25,
2024-10-23,3.75,-50,Accelerating cuts
2024-12-11,3.25,-50,
2025-01-29,3.00,-25,
2025-03-12,2.75,-25,
2025-04-16,2.25,-50,Tariff shock
2025-06-04,2.25,0,
2025-07-30,2.25,0,
2025-09-10,2.25,0,
2025-10-29,2.25,0,Current hold
```

### Tell dbt the column types

dbt infers seed types, but, as on Day 24, **don't let inference decide** for important columns. Create `seeds/_seeds.yml`:

```yaml
version: 2

seeds:
  - name: seed_geo
    description: "Canada and provinces: codes, level and region."
    config:
      column_types: {geo: varchar, geo_code: varchar, geo_level: varchar, region: varchar}

  - name: seed_series
    description: "Every ingested series: name, provider, frequency, monthly aggregation rule, staleness tolerance."
    config:
      column_types: {series_id: varchar, max_staleness_days: integer}

  - name: seed_recession_bands
    description: "Recession bands as used in the course notebook."
    config:
      column_types: {start_date: date, end_date: date}

  - name: seed_cpi_weights
    description: "Illustrative CPI weights from the notebook; official weights: StatCan 18-10-0007-01."
    config:
      column_types: {weight_pct: double}

  - name: seed_boc_decisions
    description: "BoC policy decisions (course notebook), with change in basis points."
    config:
      column_types: {decision_date: date, rate: double, change_bp: integer, note: varchar}
```

```bash
dbt seed
dbt show --select seed_boc_decisions --limit 3
```

### Switch the staging models to the dbt seeds

In `stg_macro__observations.sql` and `stg_statcan__cpi.sql`, replace the temporary Module 2 references:

```sql
join {{ ref('seed_series') }} as s using (series_id)
...
left join {{ ref('seed_geo') }} as g using (geo)
```

```bash
dbt build --select +stg_macro__observations +stg_statcan__cpi
```

`dbt build` runs seeds, models (and tests, once we have them) in DAG order: one command for everything. The seeds are now **part of the graph**, so changing a CSV and running `dbt build --select seed_series+` rebuilds exactly what depends on it.

> **When is a CSV seed appropriate?** Small (hundreds of rows, not millions), hand-maintained reference data that changes rarely and should be reviewed in Git: codes, mappings, thresholds, recession dates, decision logs. Never use seeds to load real datasets. That's dlt's job.

---

## 32.5 Choosing Materializations with Evidence (40 min)

Port two intermediate models from Day 19. We'll measure the cost of a view vs a table rather than guessing.

**`models/intermediate/int_cpi__growth.sql`** (as on Day 19; tomorrow we'll shorten it with Jinja):

```sql
-- Grain: month × geography × component. Gap-safe growth rates in %.
with base as (

    select month, geo, geo_code, geo_level, component, cpi
    from {{ ref('stg_statcan__cpi') }}
    where not is_terminated

),

lagged as (

    select
        *,
        lag(cpi, 1)    over w as cpi_l1,   lag(month, 1)  over w as month_l1,
        lag(cpi, 3)    over w as cpi_l3,   lag(month, 3)  over w as month_l3,
        lag(cpi, 6)    over w as cpi_l6,   lag(month, 6)  over w as month_l6,
        lag(cpi, 12)   over w as cpi_l12,  lag(month, 12) over w as month_l12
    from base
    window w as (partition by geo, component order by month)

)

select
    month, geo, geo_code, geo_level, component, cpi,
    case when month_l1 = cast(month - interval 1 month as date)
         then 100 * (cpi / cpi_l1 - 1) end                     as mom,
    case when month_l3 = cast(month - interval 3 month as date)
         then 100 * (power(cpi / cpi_l3, 4) - 1) end           as ann_3m,
    case when month_l6 = cast(month - interval 6 month as date)
         then 100 * (power(cpi / cpi_l6, 2) - 1) end           as ann_6m,
    case when month_l12 = cast(month - interval 12 month as date)
         then 100 * (cpi / cpi_l12 - 1) end                    as yoy
from lagged
```

**`models/intermediate/int_cpi__smoothed.sql`**: port Day 19's `int_cpi__smoothed`, replacing `intermediate.int_cpi__growth` with `{{ ref('int_cpi__growth') }}`.

### The experiment

```bash
dbt run --select int_cpi__growth int_cpi__smoothed        # both as views (folder default)
time dbt show --inline "select count(*) from {{ ref('int_cpi__smoothed') }} where yoy_ma12 is not null"
```

Now make `int_cpi__growth` a table in `_intermediate.yml`:

```yaml
  - name: int_cpi__growth
    description: "Gap-safe CPI growth rates (mom, ann_3m, ann_6m, yoy) for every geography and component."
    config:
      materialized: table
```

```bash
dbt run --select int_cpi__growth int_cpi__smoothed
time dbt show --inline "select count(*) from {{ ref('int_cpi__smoothed') }} where yoy_ma12 is not null"
```

Compare the two timings, and the run times dbt prints for each model.

### A decision rule

| Choose `view` when… | Choose `table` when… |
|---|---|
| the model is cheap (renames, casts, filters) | the model is expensive (windows over ~1M rows, big joins) |
| it's queried rarely, or by one downstream model | many models or dashboards query it |
| freshness matters more than speed | it's a stable input to heavy downstream work |

For our project: **staging = views**, **heavy intermediates (CPI growth over the full table) = tables**, **light intermediates = views**, **marts = tables**. Record the reason for each exception in the model's `description`.

### Try it 32.5

Port Day 20's `int_gdp__growth` into `models/intermediate/`. It reads a small table (a few hundred quarters). Which materialisation should it use, and why? Configure it accordingly.

<details>
<summary>Suggested answer</summary>

A **view** (the folder default): the GDP table is tiny after filtering, so recomputing it costs milliseconds, and a view always reflects the latest staging data. The port replaces `staging.stg_statcan__gdp` with `{{ ref('stg_statcan__gdp') }}`. Port the staging model too, from Day 30's `sql/11_stg_statcan__gdp.sql`, reading `{{ source('raw_dlt', 'statcan_gdp_full') }}`.

</details>

---

## 32.6 Documentation and the Lineage Graph · Mini-Project (45 min)

Descriptions you write in YAML become a **documentation website**, generated from the project itself.

### Document the staging models

Create `models/staging/_staging.yml`:

```yaml
version: 2

models:
  - name: stg_statcan__cpi
    description: >
      Typed StatCan CPI (18-10-0004-01), not seasonally adjusted.
      Grain: one row per month × geography × product group.
      Rows without a numeric value are dropped; terminated series are flagged.
    columns:
      - name: month
        description: "First day of the reference month."
      - name: geo_level
        description: "'national', 'province' or 'city' (from seed_geo)."
      - name: cpi
        description: "Index level; base period in index_base (e.g. 2002=100)."

  - name: stg_macro__observations
    description: >
      All ingested series (BoC, FRED, StatCan vectors) in long format, labelled via seed_series.
      Grain: one row per series × observation date.
    columns:
      - name: monthly_agg
        description: "How to collapse to monthly: 'last' (policy rates) or 'mean' (prices, yields)."
      - name: loaded_at
        description: "When dlt loaded the row (from raw_dlt._dlt_loads)."
```

### Generate and browse

```bash
dbt docs generate
dbt docs serve --port 8080
```

Codespaces will offer to open the forwarded port in your browser. Explore:
- each model's description, columns, compiled SQL and **materialization**;
- the **lineage graph** (the blue icon, bottom right): sources → staging → intermediate, seeds included.

Press `Ctrl+C` in the terminal to stop the server.

### Mini-project

1. Port Day 20's `int_rates__monthly` (the **wide** version with derived columns `boc_fed_diff`, `spread_10_2_bp`, `usd_cad`) into `models/intermediate/int_rates__monthly.sql`, reading from `int_rates__monthly_long`.
2. Document it in `_intermediate.yml`: grain, the aggregation rule, and each derived column.
3. Run `dbt build --select +int_rates__monthly`.
4. Regression-check it against the Module 2 view `intermediate.int_rates__monthly` using `except` in both directions (as in 31.6). Round numeric columns to 8 decimals in both sides of the comparison if tiny floating-point differences appear.

<details>
<summary>Solution — the model</summary>

```sql
-- models/intermediate/int_rates__monthly.sql
-- Grain: one row per month. Derived spreads and FX inversion.
with wide as (

    select
        month,
        max(value) filter (where series_name = 'overnight_rate')    as overnight_rate,
        max(value) filter (where series_name = 'fed_funds')         as fed_funds,
        max(value) filter (where series_name = 'yield_2yr')         as yield_2yr,
        max(value) filter (where series_name = 'yield_10yr')        as yield_10yr,
        max(value) filter (where series_name = 'cad_usd')           as cad_usd,
        max(value) filter (where series_name = 'wti')               as wti,
        max(value) filter (where series_name = 'oecd_cli')          as oecd_cli,
        max(value) filter (where series_name = 'unemployment_rate') as unemployment_rate
    from {{ ref('int_rates__monthly_long') }}
    group by month

)

select
    *,
    overnight_rate - fed_funds        as boc_fed_diff,
    (yield_10yr - yield_2yr) * 100    as spread_10_2_bp,
    1 / cad_usd                       as usd_cad
from wide
```

Look at the eight nearly identical `max(value) filter (…)` lines. Tomorrow, Jinja generates them from a list.

</details>

### Day 32 checklist
- [ ] I can explain view, table and ephemeral materialisations and when to use each
- [ ] I set folder defaults in `dbt_project.yml` and exceptions in YAML or `config()`, and I know which wins
- [ ] My dev builds land in `dev_*` schemas; `prod` will use clean names, and I won't run prod until the cut-over
- [ ] My reference data (geo, series, recession bands, CPI weights, BoC decisions) lives in CSV seeds with typed columns
- [ ] I chose materialisations using measured timings
- [ ] I document models in YAML and can browse the docs site and lineage graph

```bash
cd ..
git add .
git commit -m "Day 32: materializations, custom schemas, seeds, docs"
git push
```

---

# DAY 33 — Basic Jinja Templating

| Time | Block |
|---|---|
| 0:00 – 0:40 | 33.1 Jinja in 40 minutes: expressions, statements, comments |
| 0:40 – 1:30 | 33.2 Variables, lists and `for` loops: generating columns |
| 1:30 – 1:45 | Break |
| 1:45 – 2:30 | 33.3 Conditionals and `target`: lighter dev builds |
| 2:30 – 3:10 | 33.4 Project variables: `var()` and `--vars` |
| 3:10 – 3:25 | Break |
| 3:25 – 4:05 | 33.5 Looping over structures: gap-safe growth rates in 15 lines |
| 4:05 – 5:00 | 33.6 Capstone: a Jinja-powered intermediate layer + regression check |

---

## 33.1 Jinja in 40 Minutes (40 min)

**Jinja** is a templating language. dbt renders the Jinja in each model **before** sending the SQL to DuckDB. You've already used it: `{{ ref(...) }}`, `{{ source(...) }}`, `{{ config(...) }}`, `{{ env_var(...) }}`.

### The three kinds of tags

| Tag | Purpose | Example |
|---|---|---|
| `{{ … }}` | **expression**: print a value into the SQL | `{{ ref('stg_statcan__cpi') }}` |
| `{% … %}` | **statement**: logic (set, if, for), prints nothing | `{% set lags = [1, 3, 12] %}` |
| `{# … #}` | **comment**: removed entirely from compiled SQL | `{# TODO: add ann_6m #}` |

### A first template

Create `analyses/jinja_playground.sql`. Files in `analyses/` are **compiled but never run**, which makes them perfect for experimenting.

```sql
{# A scratchpad for learning Jinja #}
{% set target_rate = 2.0 %}
{% set series = ['overnight_rate', 'fed_funds', 'yield_2yr'] %}

-- The inflation target is {{ target_rate }}%
-- We have {{ series | length }} series: {{ series | join(', ') }}
-- Upper-case first series: {{ series[0] | upper }}
select {{ target_rate }} + 1 as upper_band
```

```bash
cd macro_dbt
dbt compile --select jinja_playground
cat target/compiled/macro_dbt/analyses/jinja_playground.sql
```

Things to notice:
- Jinja variables look like Python: lists `[...]`, indexing `series[0]`, numbers and strings.
- **Filters** transform values with `|`: `length`, `join(', ')`, `upper`, `lower`, `trim`, `replace('a','b')`, `round(2)`.
- The `{# #}` comment and the `{% set %}` lines disappear from the output.

> **Jinja runs first, SQL runs second.** Jinja can't see your data (it only knows what's written in the project, in variables, or in the target). It **writes SQL text**, and DuckDB executes that text afterwards. Keep this two-step model in mind and most confusion disappears.

---

## 33.2 Variables, Lists and `for` Loops: Generating Columns (50 min)

Yesterday's `int_rates__monthly` repeated the same line eight times. With a loop:

```sql
{% set rate_series = [
    'overnight_rate', 'fed_funds', 'yield_2yr', 'yield_10yr',
    'cad_usd', 'wti', 'oecd_cli', 'unemployment_rate'
] %}

select
    month,
    {% for s in rate_series %}
    max(value) filter (where series_name = '{{ s }}') as {{ s }}{{ ',' if not loop.last }}
    {% endfor %}
from {{ ref('int_rates__monthly_long') }}
group by month
```

- `{% for s in rate_series %} … {% endfor %}` repeats the block once per item.
- `loop.last` is `true` on the final iteration, so `{{ ',' if not loop.last }}` puts a comma after every line except the last. A trailing comma would be a SQL syntax error.
- `'{{ s }}'` (Jinja inside single quotes) produces a SQL **string**; `{{ s }}` alone produces a column **name**.

Compile and read the output. It's the eight lines you typed yesterday, generated.

### Whitespace control

The compiled SQL contains blank lines where the `{% %}` tags were. A `-` inside a tag trims whitespace on that side:

```sql
    {%- for s in rate_series %}
    max(value) filter (where series_name = '{{ s }}') as {{ s }}{{ ',' if not loop.last }}
    {%- endfor %}
```

Tidy compiled SQL is easier to debug, but it's cosmetic. Don't lose time on perfect whitespace.

### Useful `loop` properties

| Property | Meaning |
|---|---|
| `loop.index` | 1, 2, 3, … |
| `loop.index0` | 0, 1, 2, … |
| `loop.first` / `loop.last` | first / last iteration |
| `loop.length` | number of items |

### Try it 33.2

In `analyses/jinja_playground.sql`, write a loop that generates, for each lag in `[1, 3, 6, 12]`, a line like `lag(cpi, 3) over w as cpi_l3,` with no comma after the last line. Compile and check.

<details>
<summary>Solution</summary>

```sql
{% set lags = [1, 3, 6, 12] %}
select
    {%- for l in lags %}
    lag(cpi, {{ l }}) over w as cpi_l{{ l }}{{ ',' if not loop.last }}
    {%- endfor %}
from cpi
window w as (order by month)
```

</details>

---

## 33.3 Conditionals and `target`: Lighter Dev Builds (45 min)

`{% if %} … {% elif %} … {% else %} … {% endif %}` works like Python's `if` (Day 2). Combined with **`target`**, the active environment, it lets one model behave differently in dev and prod.

### What's in `target`?

```sql
-- analyses/jinja_playground.sql
-- target.name   = {{ target.name }}
-- target.schema = {{ target.schema }}
-- target.type   = {{ target.type }}
```

### Faster dev builds on the big CPI table

The full CPI table has over a million rows. In **dev** you rarely need 1914–2005:

```sql
-- models/staging/stg_statcan__cpi.sql  (inside the `renamed` CTE, after `from source`)
    from source
    {% if target.name == 'dev' %}
    where ref_date >= '2000-01'          -- dev only: recent history is enough to develop against
    {% endif %}
```

```bash
dbt compile --select stg_statcan__cpi                 # dev: the WHERE clause is present
dbt compile --select stg_statcan__cpi --target prod   # prod: it disappears
diff target/compiled/macro_dbt/models/staging/stg_statcan__cpi.sql <(dbt compile --select stg_statcan__cpi --target prod --quiet; cat target/compiled/macro_dbt/models/staging/stg_statcan__cpi.sql) || true
```

(`dbt compile --target prod` only renders SQL. It doesn't create anything, so it's safe before the cut-over.)

> **Careful with filters and window functions.** Filtering in staging means `int_cpi__growth` in dev has no data before 2000, so the first 12 months of YoY are `NULL`. That's acceptable in dev, but it's why the filter must never apply in prod. Also note that yesterday's **regression check** against Module 2 will now show differences in dev (older rows missing). Compare on `month >= '2001-01-01'` when you check dev builds.

### Try it 33.3

Add a comment line at the very top of `int_rates__monthly.sql` that renders as `-- built for target: dev` (or `prod`). Then make the query include **only months from 2015** when the target is `dev`.

<details>
<summary>Solution</summary>

```sql
-- built for target: {{ target.name }}
...
from {{ ref('int_rates__monthly_long') }}
{% if target.name == 'dev' %}
where month >= date '2015-01-01'
{% endif %}
group by month
```

</details>

---

## 33.4 Project Variables: `var()` and `--vars` (40 min)

Hard-coded values like `'2000-01'` or `2006-01-01` belong in **one place**. dbt's project variables play the role of `config.toml` (Day 23).

Add to `dbt_project.yml`:

```yaml
vars:
  panel_start_date: "2006-01-01"     # first month in the macro panels
  dev_cpi_start: "2000-01"           # dev-only CPI filter (REF_DATE format)
  inflation_target: 2.0
  rate_series:
    - overnight_rate
    - fed_funds
    - yield_2yr
    - yield_10yr
    - cad_usd
    - wti
    - oecd_cli
    - unemployment_rate
```

Use them with `var()`:

```sql
-- stg_statcan__cpi.sql
{% if target.name == 'dev' %}
where ref_date >= '{{ var("dev_cpi_start") }}'
{% endif %}

-- int_rates__monthly.sql
{%- for s in var('rate_series') %}
max(value) filter (where series_name = '{{ s }}') as {{ s }}{{ ',' if not loop.last }}
{%- endfor %}
```

### Overriding from the command line

```bash
dbt compile --select stg_statcan__cpi --vars '{dev_cpi_start: "2020-01"}'
```

The `--vars` value is YAML inside single quotes. It overrides `dbt_project.yml` for that one invocation, which is handy for a quick narrow build or a backfill.

| Mechanism | Scope | Example |
|---|---|---|
| `{% set x = … %}` | one file | a list used only in this model |
| `var('x')` | whole project, overridable per run | start dates, targets, series lists |
| `env_var('X', default)` | environment (machine / CI) | database paths, secrets |
| `target.*` | the active profile target | dev vs prod behaviour |

> **A known duplication:** `rate_series` repeats information already in `seeds/seed_series.csv`. Jinja can't read seed *data* at compile time with what we've learned so far. On Days 34–37 you'll use `run_query` and packages to derive such lists **from the seed itself**, so the CSV becomes the single source of truth.

---

## 33.5 Looping over Structures: Gap-Safe Growth Rates in 15 Lines (40 min)

Loops aren't limited to strings. A list of **dictionaries** can describe a whole family of calculations. Here is Day 19's gap-safe growth logic, with each measure described once:

```sql
-- models/intermediate/int_cpi__growth.sql
-- Grain: month × geography × component. Gap-safe growth rates in %.
{% set horizons = [
    {"name": "mom",    "lag": 1,  "power": 1},
    {"name": "ann_3m", "lag": 3,  "power": 4},
    {"name": "ann_6m", "lag": 6,  "power": 2},
    {"name": "yoy",    "lag": 12, "power": 1},
] %}

with base as (

    select month, geo, geo_code, geo_level, component, cpi
    from {{ ref('stg_statcan__cpi') }}
    where not is_terminated

),

lagged as (

    select
        *,
        {%- for h in horizons %}
        lag(cpi, {{ h.lag }})   over w as cpi_l{{ h.lag }},
        lag(month, {{ h.lag }}) over w as month_l{{ h.lag }}{{ ',' if not loop.last }}
        {%- endfor %}
    from base
    window w as (partition by geo, component order by month)

)

select
    month, geo, geo_code, geo_level, component, cpi,
    {%- for h in horizons %}
    case when month_l{{ h.lag }} = cast(month - interval {{ h.lag }} month as date)
         then 100 * (power(cpi / cpi_l{{ h.lag }}, {{ h.power }}) - 1)
    end as {{ h.name }}{{ ',' if not loop.last }}
    {%- endfor %}
from lagged
```

Compile it and compare the output with yesterday's hand-written version: **identical SQL**, but the economics (which horizons, which annualisation power) now sits in one small, readable table at the top.

Adding a measure, say 24-month growth annualised (`power` 0.5), is now a **one-line change**:

```sql
    {"name": "ann_24m", "lag": 24, "power": 0.5},
```

> **Don't over-template.** Jinja is excellent for *repetition with a clear pattern*. If a reader has to mentally execute three nested loops to understand a model, plain SQL would have been better. Rule of thumb: loop over **lists of columns or measures**, not over business logic.

### Try it 33.5

Using the same pattern, write `models/intermediate/int_gdp__growth_rates.sql` for quarterly real GDP with horizons `qoq` (lag 1, power 1), `qoq_ann` (lag 1, power 4) and `yoy` (lag 4, power 1). Remember that one quarter is **3 months**, so the date check must use `interval {{ 3 * h.lag }} month`.

<details>
<summary>Solution</summary>

```sql
{% set horizons = [
    {"name": "real_qoq",     "lag": 1, "power": 1},
    {"name": "real_qoq_ann", "lag": 1, "power": 4},
    {"name": "real_yoy",     "lag": 4, "power": 1},
] %}

with gdp as (

    select quarter, max(value) filter (where prices like 'Chained%') as real_gdp
    from {{ ref('stg_statcan__gdp') }}
    where estimate = 'Gross domestic product at market prices'
      and seasonal_adjustment = 'Seasonally adjusted at annual rates'
    group by quarter

),

lagged as (

    select
        *,
        {%- for l in horizons | map(attribute='lag') | unique %}
        lag(real_gdp, {{ l }}) over w as real_l{{ l }},
        lag(quarter, {{ l }})  over w as quarter_l{{ l }}{{ ',' if not loop.last }}
        {%- endfor %}
    from gdp
    window w as (order by quarter)

)

select
    quarter, real_gdp,
    {%- for h in horizons %}
    case when quarter_l{{ h.lag }} = cast(quarter - interval {{ 3 * h.lag }} month as date)
         then 100 * (power(real_gdp / real_l{{ h.lag }}, {{ h.power }}) - 1)
    end as {{ h.name }}{{ ',' if not loop.last }}
    {%- endfor %}
from lagged
```

`horizons | map(attribute='lag') | unique` extracts the distinct lags `[1, 4]`, so the lag columns aren't generated twice for `real_qoq` and `real_qoq_ann`. Jinja filters can be chained, like pandas methods.

</details>

---

## 33.6 Capstone: A Jinja-Powered Intermediate Layer + Regression Check (55 min)

Bring the dbt project up to parity with Module 2's staging and intermediate layers, using Jinja where it genuinely helps.

**Requirements:**
1. Staging (views): `stg_statcan__cpi` (dev filter via `var`), `stg_statcan__gdp`, `stg_macro__observations`: all reading `source()` and dbt seeds.
2. Intermediate:
   - `int_rates__monthly_long` (table), `int_rates__monthly` (view, loop over `var('rate_series')`, derived columns);
   - `int_cpi__growth` (table, `horizons` loop), `int_cpi__smoothed` (view);
   - `int_gdp__growth` (view): port Day 20's full model (real, nominal, deflator, MA4). You may generate its growth columns with a loop.
3. Every model has a grain comment at the top and a `description` in YAML.
4. `dbt build` runs cleanly from scratch: `dbt build --full-refresh`.
5. A **regression analysis** in `analyses/regression_vs_module2.sql` compares each dbt intermediate model with its Module 2 counterpart for `month >= '2001-01-01'` (to ignore the dev CPI filter), reporting the number of differing rows per model.

<details>
<summary>Solution — <code>analyses/regression_vs_module2.sql</code></summary>

```sql
{# Compares dbt dev models with the Module 2 hand-built views.
   Compile, then run the compiled SQL in DuckDB (or via dbt show --inline). #}

{% set comparisons = [
    {"dbt": "int_cpi__growth",   "legacy": "intermediate.int_cpi__growth",
     "cols": "month, geo, component, round(cpi, 6), round(yoy, 6), round(mom, 6)",
     "filter": "month >= date '2001-01-01'"},
    {"dbt": "int_rates__monthly", "legacy": "intermediate.int_rates__monthly",
     "cols": "month, round(overnight_rate, 6), round(fed_funds, 6), round(spread_10_2_bp, 6)",
     "filter": "month >= date '2015-01-01'"},
] %}

{% for c in comparisons %}
select
    '{{ c.dbt }}' as model,
    (select count(*) from (
        select {{ c.cols }} from {{ ref(c.dbt) }} where {{ c.filter }}
        except
        select {{ c.cols }} from {{ c.legacy }} where {{ c.filter }}
    )) as only_in_dbt,
    (select count(*) from (
        select {{ c.cols }} from {{ c.legacy }} where {{ c.filter }}
        except
        select {{ c.cols }} from {{ ref(c.dbt) }} where {{ c.filter }}
    )) as only_in_legacy
{{ 'union all' if not loop.last }}
{% endfor %}
```

```bash
dbt compile --select regression_vs_module2
dbt show --inline "$(cat target/compiled/macro_dbt/analyses/regression_vs_module2.sql)"
```

Zeros everywhere means the dbt layer reproduces Module 2 exactly (within the filtered window). The `int_rates__monthly` filter starts in 2015 because of the Try-it 33.3 dev filter; widen it if you removed that.

Notice that Jinja generated the *test* too: one small list of comparisons, and one loop producing all the SQL.

</details>

Finally, look at the result as a graph:

```bash
dbt docs generate && dbt docs serve --port 8080
```

Your lineage graph now shows **raw_dlt sources and seeds → staging → intermediate**. Compare that picture with the numbered `sql/` folder from Module 2: the same logic, but now self-documenting and dependency-aware.

### Recap: Days 31–33

| Concept | You can now… |
|---|---|
| Project & profiles | set up a dbt project with `dev`/`prod` targets over DuckDB |
| `source()` / `ref()` | declare raw inputs and build a dependency graph without numbering files |
| Selectors | build exactly the part of the DAG you need |
| Materializations | choose view / table / ephemeral per model, with evidence |
| Configuration | set defaults by folder, override per model, and predict which wins |
| Custom schemas | keep dev builds in `dev_*` schemas, and plan clean names for prod |
| Seeds | manage reference data as typed, versioned CSVs inside the DAG |
| Docs | generate a documentation site with lineage |
| Jinja | use expressions, `set`, filters, loops over lists and dicts, `if`/`target`, `var()` |

### Looking ahead: Days 34–37

- **Modular modelling:** a disciplined staging → intermediate → marts split, and when to break a model apart.
- **DRY principles and macros:** turn today's `horizons` loop into a reusable macro (`{{ growth_rates('cpi', horizons) }}`) usable for CPI, GDP and any future series.
- **`run_query`:** derive `rate_series` from `seed_series` itself, with no duplication.
- **Tests:** `unique`, `not_null`, `relationships`, `accepted_values`, and custom tests replacing Module 2's `sql/tests/`.
- **Incremental models** and **packages** such as `dbt_utils`.

### Day 33 checklist
- [ ] I can read and write Jinja expressions, statements, comments and filters
- [ ] I generate repetitive columns with `for` loops over lists and lists of dictionaries
- [ ] I use `target` to make dev builds lighter, without changing prod logic
- [ ] Constants and lists live in `vars`, and I can override them with `--vars`
- [ ] I know when templating helps readability, and when plain SQL is better
- [ ] My dbt dev layer reproduces the Module 2 intermediate layer, proven by a Jinja-generated regression analysis

```bash
cd ..
git add .
git commit -m "Day 33: Jinja templating, vars, growth-rate loops, regression analysis"
git push
```
