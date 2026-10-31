# Module 3 · Data Ingestion with dlt
## Days 24–27: Schema Evolution, Flattening Nested JSON & Incremental Loading

**Audience:** MSc Economics students who completed Days 1–23
**Environment:** GitHub Codespaces · course `.venv` · DuckDB · `macro_ingest` package from Day 23
**Time per day:** ~2.5 hours (including breaks and exercises)
**Goal by end of Day 27:** Students control how their schemas change and protect curated tables with schema contracts. They load deeply nested API responses (Valet, StatCan WDS metadata) and query them relationally. And they upgrade `macro_ingest` to fetch **only what's new**, absorb statistical **revisions**, and keep a history of **data vintages**.

---

### Where we are

`python ingest.py` loads BoC, FRED and StatCan data into `macro.duckdb` (dataset `raw_dlt`), driven by `.dlt/config.toml`. It has three weaknesses you'll fix over these four days:

| Weakness | Risk | Fixed on |
|---|---|---|
| Any change in an API's fields silently changes our tables | broken SQL models, wrong dashboards | Days 24–25 |
| We flatten JSON by hand and throw away metadata | lost information, brittle parsing | Day 26 |
| Every run re-downloads 20 years of history | slow, wasteful, rude to APIs; revisions overwritten without trace | Day 27 |

### Practice setup

> **Question it answers:** How do I experiment with pipelines safely, without touching my real warehouse?
>
> **Other questions you can answer the same way:**
> - How do I reset a test pipeline and start clean?

Each day uses a **practice pipeline** so experiments never touch your warehouse. Create `day24/common.py`:

```python
"""Shared helpers for Days 24–27 practice scripts."""
import dlt


def practice_pipeline(name="schema_lab", dataset="lab", **kwargs):
    """A throwaway pipeline writing to <name>.duckdb in the current folder."""
    return dlt.pipeline(
        pipeline_name=name,
        destination=dlt.destinations.duckdb(f"{name}.duckdb"),
        dataset_name=dataset,
        **kwargs,
    )


def reset(name="schema_lab"):
    """Delete a practice pipeline's local state and database file."""
    import os
    import shutil
    shutil.rmtree(os.path.expanduser(f"~/.dlt/pipelines/{name}"), ignore_errors=True)
    for f in (f"{name}.duckdb", f"{name}.duckdb.wal"):
        if os.path.exists(f):
            os.remove(f)
```

`dlt.destinations.duckdb("file.duckdb")` names the database file explicitly, overriding `secrets.toml` for this pipeline only. Copy `common.py` into `day25/`, `day26/` and `day27/` too (or import it with a relative path).

---

# DAY 24 — Schema Evolution: How dlt Adapts to Changing Data

| Time | Block |
|---|---|
| 0:00 – 0:20 | 24.1 What a schema is, and where dlt keeps it |
| 0:20 – 0:45 | 24.2 Type inference and column hints |
| 0:45 – 0:53 | Break |
| 0:53 – 1:20 | 24.3 Simulating an API that changes: new, missing and renamed fields |
| 1:20 – 1:40 | 24.4 Type changes and variant columns |
| 1:40 – 1:48 | Break |
| 1:48 – 2:05 | 24.5 Naming conventions: how keys become column names |
| 2:05 – 2:30 | 24.6 Exporting schemas to Git · mini-project |

---

## 24.1 What a Schema Is, and Where dlt Keeps It (20 min)

> **Question it answers:** Which tables, columns and types did dlt create for my data, and where is that description stored?
>
> **Other questions you can answer the same way:**
> - Is the value column a decimal number?
> - Which column is the primary key?

A **schema** describes your tables: their names, columns, data types, keys and nullability. You wrote schemas by hand in SQL on Day 11 (`CREATE TABLE … (rate DOUBLE, …)`). dlt **infers** a schema from the data and **stores** it:

- inside the destination, in the `_dlt_version` table (every version ever used);
- in the pipeline's working folder `~/.dlt/pipelines/<name>/schemas/`;
- in memory, as `pipeline.default_schema`.

Create `day24/schema_basics.py`:

```python
from datetime import date
from common import practice_pipeline, reset

reset()
pipeline = practice_pipeline()

rows = [
    {"date": date(2026, 7, 1), "series_id": "V39079", "value": 2.25},
    {"date": date(2026, 8, 1), "series_id": "V39079", "value": 2.25},
]
pipeline.run(rows, table_name="rates")

schema = pipeline.default_schema
print("Schema version:", schema.version)
print(schema.to_pretty_yaml())
```

Find the `rates` table in the YAML output. For each column you'll see `data_type`, `nullable` and, where relevant, flags like `primary_key`. You'll also see the `_dlt_*` system tables.

Look at the stored versions in DuckDB:

```bash
duckdb schema_lab.duckdb -c "SELECT version, engine_version, inserted_at FROM lab._dlt_version"
```

> **Key idea:** dlt's schema is a *living document*. Each time your data has a new shape, dlt proposes a new version, migrates the destination tables (adds columns, creates tables) and records the change.

---

## 24.2 Type Inference and Column Hints (25 min)

### How dlt chooses types

| Python value | dlt `data_type` | DuckDB type |
|---|---|---|
| `int` | `bigint` | `BIGINT` |
| `float` | `double` | `DOUBLE` |
| `str` | `text` | `VARCHAR` |
| `bool` | `bool` | `BOOLEAN` |
| `datetime.date` | `date` | `DATE` |
| `datetime.datetime` | `timestamp` | `TIMESTAMP WITH TIME ZONE` |
| `decimal.Decimal` | `decimal` | `DECIMAL` |
| nested `dict` / `list` | flattened or child table (Day 26), or `json` | |

### The first row decides, which can be a trap

> **Question it answers:** Why did my value column become a whole-number type, and how do I stop that happening?
>
> **Other questions you can answer the same way:**
> - Why were decimals lost or rejected in a later load?

Add to `schema_basics.py` (or a new file):

```python
reset()
pipeline = practice_pipeline()

# The first batch happens to contain whole numbers only...
pipeline.run([{"series_id": "X", "value": 2}, {"series_id": "Y", "value": 5}],
             table_name="trap")
print(pipeline.default_schema.tables["trap"]["columns"]["value"]["data_type"])  # bigint
```

`value` was typed `bigint`, because the first values *looked* like integers. When `2.25` arrives next week, dlt must deal with a type conflict (24.4). The fix is to **tell dlt what you mean**, using column hints:

```python
pipeline.run([{"series_id": "X", "value": 2}],
             table_name="no_trap",
             columns={"value": {"data_type": "double"}})
```

### Useful column hints

| Hint | Effect |
|---|---|
| `data_type` | fix the type (`double`, `date`, `text`, `bigint`, …) |
| `nullable: False` | reject rows where the column is missing or null |
| `primary_key: True` | identity of a row (needed for `merge`) |
| `unique: True` | documents uniqueness |

You can give hints in `@dlt.resource(columns={...})` (as on Days 21–23) or in `pipeline.run(..., columns=...)`.

> **Rule for economic data:** always hint `value` as `double` and dates as `date`. Never let the first batch decide the type of a measurement.

### Try it 24.2

Load `[{"obs_date": "2026-07-01", "value": 169}]` twice into two tables: once without hints and once with hints making `obs_date` a `date` and `value` a `double`. Compare with `DESCRIBE`.

<details>
<summary>Solution</summary>

```python
reset()
pipeline = practice_pipeline()
data = [{"obs_date": "2026-07-01", "value": 169}]

pipeline.run(data, table_name="unhinted")
pipeline.run(data, table_name="hinted",
             columns={"obs_date": {"data_type": "date"},
                      "value": {"data_type": "double"}})
```

```bash
duckdb schema_lab.duckdb -c "DESCRIBE lab.unhinted" -c "DESCRIBE lab.hinted"
```

Unhinted: `obs_date` may be `VARCHAR` (or a detected date/timestamp, depending on your dlt version) and `value` is `BIGINT`. Hinted: `DATE` and `DOUBLE`. With hints, your types don't depend on what dlt happens to detect.

</details>

---

## 24.3 Simulating an API That Changes (28 min)

> **Question it answers:** What happens to my table when an API adds a field, drops one, or renames one?
>
> **Other questions you can answer the same way:**
> - Why did a new column suddenly appear?
> - Why is a column now mostly empty?

APIs change: new fields appear, others disappear or get renamed. Let's simulate three "versions" of a CPI API and watch what dlt does. Create `day24/api_versions.py`:

```python
from datetime import date
from common import practice_pipeline, reset

reset()
pipeline = practice_pipeline()
HINTS = {"ref_month": {"data_type": "date"}, "value": {"data_type": "double"}}


def load(rows, label):
    pipeline.run(rows, table_name="cpi_feed", columns=HINTS)
    cols = list(pipeline.default_schema.tables["cpi_feed"]["columns"].keys())
    print(f"{label}: schema v{pipeline.default_schema.version} → {cols}")


# v1 — the original API
load([{"ref_month": date(2026, 5, 1), "geo": "Canada", "value": 167.8}], "v1")

# v2 — a new field appears (a quality flag)
load([{"ref_month": date(2026, 6, 1), "geo": "Canada", "value": 168.2,
       "status": "A"}], "v2")

# v3 — 'geo' is renamed to 'geography'
load([{"ref_month": date(2026, 7, 1), "geography": "Canada", "value": 169.0,
       "status": "A"}], "v3")
```

```bash
python day24/api_versions.py
duckdb schema_lab.duckdb -c "SELECT ref_month, geo, geography, value, status FROM lab.cpi_feed ORDER BY 1"
```

| Change | What dlt did | Consequence for you |
|---|---|---|
| **New field** (`status`) | added a nullable column; older rows get `NULL` | usually harmless, often useful |
| **Missing field** (v3 has no `geo`) | kept the column; new rows get `NULL` | SQL filtering on `geo = 'Canada'` silently misses new rows! |
| **Renamed field** (`geo` → `geography`) | treated as missing + new column | your data is now split across two columns |

> This behaviour, called **evolve**, is ideal for a *raw* layer: nothing is lost and loads never fail. But it's dangerous for anything downstream, where a renamed field can break a model without any error. Day 25 introduces **schema contracts** to control this.

### Detecting renames downstream

> **Question it answers:** How do I keep my analysis working when the API renamed "geo" to "geography"?
>
> **Other questions you can answer the same way:**
> - How do I combine an old and a new column name into one?

The staging layer is the right place to **absorb** such changes explicitly:

```sql
-- Staging copes with both versions of the API
SELECT ref_month,
       COALESCE(geography, geo) AS geo,
       value
FROM lab.cpi_feed;
```

---

## 24.4 Type Changes and Variant Columns (20 min)

> **Question it answers:** What happens when the API sends the text "NA" in a numeric column?
>
> **Other questions you can answer the same way:**
> - Why does my table now have a value__v_text column?
> - How many rows arrived with the wrong type?

What if a field changes **type**? Suppose the API starts sending the text `"NA"` instead of a number.

```python
reset()
pipeline = practice_pipeline()
hint = {"value": {"data_type": "double"}}

pipeline.run([{"series_id": "V39079", "value": 2.25}], table_name="variants", columns=hint)
pipeline.run([{"series_id": "V39079", "value": "NA"}], table_name="variants")

print(list(pipeline.default_schema.tables["variants"]["columns"].keys()))
```

```bash
duckdb schema_lab.duckdb -c "SELECT * FROM lab.variants"
```

dlt can't put `"NA"` into a `DOUBLE` column, and it won't throw data away, so it creates a **variant column** named like `value__v_text` to hold values of the new type. The original `value` column stays clean.

Variant columns are a warning light:
- **In raw:** acceptable, since you can still see what arrived.
- **Downstream:** a sign that parsing should have happened earlier. Here that means converting `"NA"` to `None` (Day 2's `try/except`), which is exactly what our resources already do.

Find variant columns across your whole warehouse with SQL:

```sql
SELECT table_schema, table_name, column_name
FROM information_schema.columns
WHERE column_name LIKE '%\_\_v\_%' ESCAPE '\';
```

Consider adding this as a `warn` test in `sql/tests/` (Day 18).

---

## 24.5 Naming Conventions: How Keys Become Column Names (18 min)

> **Question it answers:** What will StatCan and BoC field names like "SeriesTitleEn" or "BD.CDN.10YR.DQ.YLD" be called in the database?
>
> **Other questions you can answer the same way:**
> - Why can't I find the column under its original name?

dlt normalises every table and column name to **snake_case**, so names are valid and consistent in any database.

```python
reset()
pipeline = practice_pipeline()
pipeline.run([{
    "SeriesTitleEn": "Consumer Price Index, Canada",
    "refPer": "2026-07-01",
    "V39079": 2.25,
    "BD.CDN.10YR.DQ.YLD": 3.75,
    "Products and product groups": "All-items",
}], table_name="Naming Demo")
```

```bash
duckdb schema_lab.duckdb -c "DESCRIBE lab.naming_demo"
```

You'll see names such as `series_title_en`, `ref_per`, `v39079`, a snake_case version of the bond-yield code, and `products_and_product_groups`. The table itself became `naming_demo`.

Implications:
- Column names in DuckDB may differ from the keys in the API. When in doubt, check `DESCRIBE`.
- **Series IDs used as keys become column names.** That works for 4 series and becomes a disaster for 400 (a new column per series). Day 26 shows how to turn "keys as data" into rows.

---

## 24.6 Exporting Schemas to Git · Mini-Project (25 min)

> **Question it answers:** How do I save the schema as a file so that schema changes show up in code review?
>
> **Other questions you can answer the same way:**
> - What changed in the schema since last week?

If schema changes matter, they should be **reviewed** like code. dlt can write the schema to a YAML file after every run:

```python
pipeline = dlt.pipeline(
    pipeline_name="schema_lab",
    destination=dlt.destinations.duckdb("schema_lab.duckdb"),
    dataset_name="lab",
    export_schema_path="schemas/export",
)
```

After a run, `schemas/export/<schema_name>.schema.yaml` contains the current schema. Commit it. When the API changes, `git diff schemas/` shows **exactly** which columns appeared or changed type. That makes schema drift a reviewable event instead of a surprise.

> dlt also accepts an `import_schema_path`: a schema file you edit by hand (e.g. to add hints) that dlt applies on the next run. It's useful for large projects, but for this course hints in code are enough.

### Mini-project: detect a (simulated) StatCan API change

> **Question it answers:** When StatCan changes its metadata fields, exactly what changed in my schema?
>
> **Other questions you can answer the same way:**
> - Did the latest run add or alter any columns?

1. Write a resource `vector_titles()` that yields StatCan-style metadata records `{"vectorId": 41690973, "SeriesTitleEn": "...", "frequencyCode": 6}` for two vectors.
2. Load it with `export_schema_path="schemas/export"` and commit the exported YAML.
3. "Break" the API: rename `SeriesTitleEn` to `seriesTitleEn` and change `frequencyCode` to the string `"monthly"`. Load again.
4. Run `git diff schemas/` and explain every change you see.

<details>
<summary>Solution</summary>

```python
import dlt
from common import reset

reset("schema_diff")
pipeline = dlt.pipeline(pipeline_name="schema_diff",
                        destination=dlt.destinations.duckdb("schema_diff.duckdb"),
                        dataset_name="lab", export_schema_path="schemas/export")

v1 = [{"vectorId": 41690973, "SeriesTitleEn": "CPI; Canada; All-items", "frequencyCode": 6},
      {"vectorId": 2062815, "SeriesTitleEn": "Unemployment rate; Canada", "frequencyCode": 6}]
pipeline.run(v1, table_name="vector_titles")
# → git add schemas && git commit -m "baseline schema"

v2 = [{"vectorId": 41690973, "seriesTitleEn": "CPI; Canada; All-items", "frequencyCode": "monthly"}]
pipeline.run(v2, table_name="vector_titles")
```

In the diff, the camel-case rename normalises to the **same** column name (`series_title_en`), so it isn't a change at all. That's a benefit of naming conventions. The type change creates a **variant column** such as `frequency_code__v_text`. A reviewer seeing this in a pull request would ask: *why did the frequency code become text?*

</details>

### Day 24 checklist
- [ ] I know where dlt stores schemas and how versions are recorded
- [ ] I use column hints so measurement types never depend on the first batch
- [ ] I can predict what dlt does with new, missing, renamed and re-typed fields
- [ ] I recognise variant columns and can find them with SQL
- [ ] I understand name normalisation, and why IDs-as-keys is a problem
- [ ] I export schemas to Git so changes are reviewable

```bash
git add .
git commit -m "Day 24: schema inference, evolution, variant columns, exported schemas"
git push
```

---

# DAY 25 — Schema Contracts and Row Validation

| Time | Block |
|---|---|
| 0:00 – 0:20 | 25.1 Why contracts? Evolve is not always a virtue |
| 0:20 – 0:50 | 25.2 Contract modes: `evolve`, `freeze`, `discard_row`, `discard_value` |
| 0:50 – 0:58 | Break |
| 0:58 – 1:18 | 25.3 Where to set contracts: per layer, per resource |
| 1:18 – 1:38 | 25.4 Handling violations gracefully |
| 1:38 – 1:45 | Break |
| 1:45 – 2:10 | 25.5 Row validation with Pydantic models |
| 2:10 – 2:30 | 25.6 Mini-project: contracts for `macro_ingest` |

---

## 25.1 Why Contracts? (20 min)

Recall Day 24.3: the field `geo` was renamed, dlt happily evolved, and SQL filtering on `geo = 'Canada'` silently missed every new row. Nothing failed. The dashboard just started showing stale numbers.

A **data contract** states what a table is allowed to look like. When incoming data breaks it, the pipeline reacts in a way *you* chose: stop, drop the row, or drop the value.

There are three things a contract can govern:

| Entity | Question it controls |
|---|---|
| `tables` | May new **tables** be created? |
| `columns` | May new **columns** be added to existing tables? |
| `data_type` | May a column receive values of a **different type** (variant columns)? |

---

## 25.2 Contract Modes (30 min)

> **Question it answers:** What should the pipeline do when unexpected tables, columns or types arrive: accept, ignore or block them?
>
> **Other questions you can answer the same way:**
> - How strict should each table be?

Each entity can take one of four modes:

| Mode | On violation |
|---|---|
| `evolve` | accept the change (the default, Day 24) |
| `freeze` | **raise an error**, and nothing is loaded from that step |
| `discard_row` | drop the offending **row**, load the rest |
| `discard_value` | drop the offending **value** (the new column / wrong type), keep the row |

Create `day25/contracts.py`. Each experiment starts from the same baseline table:

```python
from common import practice_pipeline, reset

HINTS = {"value": {"data_type": "double"}}
BASE = [{"series_id": "V39079", "value": 2.25}]


def fresh():
    reset("contract_lab")
    p = practice_pipeline("contract_lab")
    p.run(BASE, table_name="obs", columns=HINTS)          # baseline: 2 columns
    return p


def show(p):
    import duckdb
    con = duckdb.connect("contract_lab.duckdb", read_only=True)
    print(con.sql("SELECT * EXCLUDE (_dlt_load_id, _dlt_id) FROM lab.obs").fetchall())
    print(con.sql("SELECT column_name FROM information_schema.columns "
                  "WHERE table_name = 'obs' AND column_name NOT LIKE '\\_dlt%' ESCAPE '\\'").fetchall())
    con.close()
```

### Experiment 1 — `freeze` columns

> **Question it answers:** Can I block any load that tries to add a column I didn't expect?
>
> **Other questions you can answer the same way:**
> - How do I protect a table that SQL models depend on?

```python
p = fresh()
try:
    p.run([{"series_id": "V39079", "value": 2.50, "status": "E"}],
          table_name="obs", schema_contract={"columns": "freeze"})
except Exception as e:
    print("Blocked:", type(e).__name__)
show(p)
```

The new `status` column is rejected and **nothing** from that load is written.

### Experiment 2 — `discard_value` columns

> **Question it answers:** Can I load the rows but silently drop an unexpected new field?
>
> **Other questions you can answer the same way:**
> - How do I ignore extra fields an API starts sending?

```python
p = fresh()
p.run([{"series_id": "V39079", "value": 2.50, "status": "E"}],
      table_name="obs", schema_contract={"columns": "discard_value"})
show(p)
```

The row loads and the unknown `status` value is silently dropped.

### Experiment 3 — `discard_row` columns

> **Question it answers:** Can I skip only the rows that contain an unexpected field, and keep the rest?
>
> **Other questions you can answer the same way:**
> - How do I quarantine odd records without stopping the load?

```python
p = fresh()
p.run([{"series_id": "V39079", "value": 2.50, "status": "E"},
       {"series_id": "V39079", "value": 2.75}],
      table_name="obs", schema_contract={"columns": "discard_row"})
show(p)
```

Only the row **without** the unexpected field loads.

### Experiment 4 — `freeze` data types

> **Question it answers:** Can I block a load when a numeric column suddenly receives text?
>
> **Other questions you can answer the same way:**
> - How do I stop "NA" from sneaking into a numeric table?

```python
p = fresh()
try:
    p.run([{"series_id": "V39079", "value": "NA"}],
          table_name="obs", schema_contract={"data_type": "freeze"})
except Exception as e:
    print("Blocked:", type(e).__name__)
```

No variant column is created; the load fails instead.

### Shorthand

> **Question it answers:** How do I apply one strictness rule to tables, columns and types all at once?
>
> **Other questions you can answer the same way:**
> - How do I make a whole resource read-only in shape?

A single string applies to all three entities:

```python
schema_contract="freeze"          # same as {"tables": "freeze", "columns": "freeze", "data_type": "freeze"}
```

> **New tables are exempt from column rules.** The first load of a table defines its columns, so contracts on `columns` and `data_type` protect tables **that already exist**. `tables: "freeze"` stops *new* tables from being created at all.

### Try it 25.2

Which mode would you choose, and why, for:
(a) a raw landing table of Valet responses;
(b) the `boc_observations` table feeding your SQL staging models;
(c) a table of user-submitted survey answers where an occasional malformed row is expected?

<details>
<summary>Suggested answers</summary>

(a) `evolve`: raw should capture everything, so you can investigate changes afterwards.
(b) `freeze` for columns and data types: a change must stop the pipeline and be reviewed, because downstream SQL depends on the exact shape.
(c) `discard_row` for data types: keep the good answers and drop malformed ones. Ideally, also count the discarded rows so you notice if it becomes frequent.

</details>

---

## 25.3 Where to Set Contracts (20 min)

> **Question it answers:** Should a contract be set on the resource, the source or a single run, and which one wins?
>
> **Other questions you can answer the same way:**
> - How do I relax a contract for just one run?

Contracts can be set at three levels. More specific settings override more general ones:

```python
# 1. On a resource — applies to that table
@dlt.resource(name="boc_observations",
              schema_contract={"columns": "freeze", "data_type": "freeze"})
def observations(): ...

# 2. On a source — default for all its resources
@dlt.source(name="boc", schema_contract={"tables": "evolve", "columns": "freeze"})
def boc_source(): ...

# 3. On a single run — overrides for this run only
pipeline.run(source, schema_contract="evolve")
```

### A layered strategy

> **Question it answers:** How strict should landing tables, observation tables and metadata tables each be?
>
> **Other questions you can answer the same way:**
> - Where do I want flexibility, and where do I want guarantees?

```
raw_json / landing tables     →  evolve        (capture everything)
raw_dlt observation tables    →  freeze        (shape is a promise to SQL models)
metadata tables               →  columns: evolve, data_type: freeze
                                  (new descriptive fields are welcome; type changes are not)
```

> **Controlled evolution:** when you *intend* a change (say, adding a `unit` column), run once with `schema_contract="evolve"` on the command line or a flag, review the exported schema diff (Day 24.6), commit, and return to `freeze`. Changing the schema is a deliberate act, not an accident.

---

## 25.4 Handling Violations Gracefully (20 min)

> **Question it answers:** How do I report which source broke its contract, and keep the other sources running?
>
> **Other questions you can answer the same way:**
> - Which source failed today, and why?

A frozen contract raises an exception during the **normalize** step. The pipeline wraps it in a `PipelineStepFailed` error, which tells you which step failed. Your runner should:

1. catch it,
2. log clearly *which* source and *what* changed,
3. keep other sources running (Day 9's design),
4. exit with a non-zero code so schedulers notice (Day 10).

```python
from dlt.pipeline.exceptions import PipelineStepFailed


def run_with_contract(pipeline, source, name):
    try:
        info = pipeline.run(source)
        info.raise_on_failed_jobs()
        print(f"✓ {name}")
        return True
    except PipelineStepFailed as e:
        print(f"✗ {name}: failed at step '{e.step}'")
        cause = e.__context__ or e
        print(f"   cause: {type(cause).__name__}: {str(cause)[:300]}")
        return False
```

The underlying error (often a `DataValidationError`) names the **table**, **column** and **contract mode** involved, so you know immediately what the API changed.

### What happens to data that failed?

The extracted data from a failed normalize step stays in the pipeline's working folder as a **pending package**. After fixing the contract (or deciding to evolve), the next `pipeline.run()` can process it. For simplicity in this course, prefer re-running the source after a fix. Pending packages are covered in dlt's documentation if you need them.

---

## 25.5 Row Validation with Pydantic Models (25 min)

> **Question it answers:** How do I check values (not just shape), for example that a rate is a number and a date is a real date?
>
> **Other questions you can answer the same way:**
> - How do I reject impossible values before they reach the warehouse?

Contracts check the **shape** of data. **Pydantic** models add checks on **values**, written as a typed Python class:

```bash
pip install pydantic
pip freeze > requirements.txt
```

Create `day25/pydantic_models.py`:

```python
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class Observation(BaseModel):
    """One observation of one macro series (our long-format contract)."""
    date: date
    series_id: str = Field(min_length=2)
    value: float
    source: Literal["boc", "fred", "statcan"]

    @field_validator("value")
    @classmethod
    def must_be_finite(cls, v):
        if v != v or v in (float("inf"), float("-inf")):     # NaN is never equal to itself
            raise ValueError("value must be a finite number")
        return v


# Try it without dlt first
print(Observation(date="2026-07-01", series_id="V39079", value="2.25", source="boc"))
try:
    Observation(date="2026-07-01", series_id="V39079", value=2.25, source="imf")
except Exception as e:
    print(e)
```

Pydantic **converts** where it's safe (`"2.25"` → `2.25`, `"2026-07-01"` → a `date`) and **rejects** what doesn't fit (an unknown `source`).

### Using a model as a dlt resource's columns

> **Question it answers:** How do I load only valid observations, dropping the rows whose values fail validation?
>
> **Other questions you can answer the same way:**
> - How many rows were rejected, and which ones?

```python
import dlt


@dlt.resource(name="validated_obs", columns=Observation,
              schema_contract={"columns": "discard_value", "data_type": "discard_row"})
def validated_obs():
    yield [
        {"date": "2026-07-01", "series_id": "V39079", "value": 2.25, "source": "boc"},
        {"date": "2026-07-02", "series_id": "V39079", "value": "oops", "source": "boc"},
        {"date": "2026-07-03", "series_id": "V39079", "value": 2.25, "source": "boc",
         "extra": "ignored"},
    ]
```

With a Pydantic model as `columns`, dlt:
- derives the table's column types from the model (no separate hints needed);
- validates each item against the model, applying the contract modes when items don't match. Here the row with `"oops"` is discarded and the unexpected `extra` field is dropped.

Run it into a practice pipeline and check which rows arrived.

> **Where do economic plausibility checks belong?** "CPI must be positive" or "unemployment between 0 and 100" can live in Pydantic, but it's usually better to load the raw values and **test** them downstream (Day 18's SQL tests, Great Expectations on Days 41–50). Rejecting a surprising value at ingestion hides it; testing it downstream shows it to you. Keep ingestion validation **structural** (types, required fields, allowed codes).

---

## 25.6 Mini-Project: Contracts for `macro_ingest` (20 min)

> **Question it answers:** How do I guarantee that the production observation tables never change shape without me knowing?
>
> **Other questions you can answer the same way:**
> - Does a test prove the contract really blocks unexpected columns?

1. Add `schema_contract={"columns": "freeze", "data_type": "freeze"}` to the three **observation** resources in `macro_ingest`, and `{"columns": "evolve", "data_type": "freeze"}` to the three **metadata** resources.
2. Update `ingest.py` to use `run_with_contract` (25.4).
3. Add `export_schema_path="schemas/export"` to the `macro_ingest` pipeline and commit the exported schema.
4. Write `day25/contract_test.py` that proves the contract works: run the BoC source with `add_map` injecting an extra field into every row, into a **throwaway** DuckDB file, and assert that the load fails.

<details>
<summary>Solution — <code>day25/contract_test.py</code></summary>

```python
"""Prove that the frozen contract on boc_observations blocks unexpected columns."""
import os

import dlt
from dlt.pipeline.exceptions import PipelineStepFailed

from macro_ingest.boc import boc_source
from common import reset

reset("contract_test")
pipeline = dlt.pipeline(pipeline_name="contract_test",
                        destination=dlt.destinations.duckdb("contract_test.duckdb"),
                        dataset_name="test")

# 1. Baseline load establishes the table (contracts protect existing tables)
pipeline.run(boc_source(series_ids=["V39079"], start_date="2026-01-01")
             .with_resources("boc_observations"))

# 2. Simulate an API change: every row gains a new field
def add_field(row):
    row["surprise"] = "new field"
    return row

source = boc_source(series_ids=["V39079"], start_date="2026-01-01")
source.resources["boc_observations"].add_map(add_field)

try:
    pipeline.run(source.with_resources("boc_observations"))
    raise AssertionError("Contract did NOT block the new column!")
except PipelineStepFailed:
    print("✓ Contract blocked the unexpected column, as intended")
finally:
    reset("contract_test")
```

Our resources yield **lists** of rows. dlt's `add_map` applies the function to each row within those lists.

</details>

### Day 25 checklist
- [ ] I can explain the four contract modes and the three entities they govern
- [ ] I choose contracts per layer: evolve for raw capture, freeze for tables that SQL models depend on
- [ ] My runner catches contract violations, reports them clearly and exits non-zero
- [ ] I can validate rows with a Pydantic model and use it as a resource's columns
- [ ] I keep ingestion checks structural and leave economic plausibility to downstream tests
- [ ] I have a test that proves my contract works

```bash
git add .
git commit -m "Day 25: schema contracts, Pydantic validation, contract test"
git push
```

---

# DAY 26 — Flattening Nested JSON API Responses

| Time | Block |
|---|---|
| 0:00 – 0:20 | 26.1 How dlt normalises nested data |
| 0:20 – 0:45 | 26.2 Loading a raw Valet response as-is |
| 0:45 – 0:53 | Break |
| 0:53 – 1:15 | 26.3 "Keys as data": reshaping before loading |
| 1:15 – 1:35 | 26.4 StatCan WDS: letting dlt flatten for you |
| 1:35 – 1:43 | Break |
| 1:43 – 2:03 | 26.5 Controlling depth: `max_table_nesting` and JSON columns |
| 2:03 – 2:30 | 26.6 Mini-project: StatCan cube metadata → a product hierarchy |

---

## 26.1 How dlt Normalises Nested Data (20 min)

> **Question it answers:** How does dlt turn nested JSON (objects inside objects, lists inside records) into tables?
>
> **Other questions you can answer the same way:**
> - Where did my nested fields end up?

On Day 8 you flattened JSON by hand. dlt does it automatically using two rules:

**Rule 1 — nested dictionaries become columns**, joined with a double underscore:

```
{"series": "V39079", "detail": {"label": "Overnight", "unit": "%"}}
      ↓
table: series | detail__label | detail__unit
```

**Rule 2 — lists become child tables**, linked to their parent:

```
{"series": "V39079", "obs": [{"d": "2026-07-01", "v": 2.25}, {"d": "2026-08-01", "v": 2.25}]}
      ↓
parent table:            series | _dlt_id
child table parent__obs: d | v | _dlt_parent_id | _dlt_list_idx
```

| System column | Meaning |
|---|---|
| `_dlt_id` | unique ID of each row |
| `_dlt_parent_id` | the `_dlt_id` of the parent row (in child tables) |
| `_dlt_list_idx` | position of the item in the original list (0, 1, 2…) |
| `_dlt_root_id` | ID of the top-level row (added when `root_key=True`) |

This is **relational normalisation**: the same idea as the star schema of Day 12, applied automatically to documents.

Create `day26/nesting_basics.py`:

```python
from common import practice_pipeline, reset

reset("nest_lab")
p = practice_pipeline("nest_lab", "lab")

doc = {
    "series": "V39079",
    "detail": {"label": "Target for the overnight rate", "unit": "percent"},
    "obs": [{"d": "2026-07-01", "v": 2.25}, {"d": "2026-08-01", "v": 2.25}],
}
p.run([doc], table_name="nested_demo")
```

```bash
duckdb nest_lab.duckdb
```

```sql
.mode box
SHOW TABLES FROM lab;              -- or: SELECT table_name FROM information_schema.tables
SELECT * FROM lab.nested_demo;
SELECT * FROM lab.nested_demo__obs;

-- Re-join child to parent
SELECT p.series, p.detail__label, c.d, c.v
FROM lab.nested_demo      AS p
JOIN lab.nested_demo__obs AS c ON c._dlt_parent_id = p._dlt_id
ORDER BY c._dlt_list_idx;
```

---

## 26.2 Loading a Raw Valet Response As-Is (25 min)

> **Question it answers:** What tables appear if I load the Bank of Canada's JSON exactly as it comes, with no parsing?
>
> **Other questions you can answer the same way:**
> - Why did I get one column per series code?

Let's load the complete Valet response for **two** series with no parsing at all. Create `day26/valet_raw.py`:

```python
import dlt
from dlt.sources.helpers import requests
from common import practice_pipeline, reset


@dlt.resource(name="valet_raw", write_disposition="replace")
def valet_raw(series_ids, recent=5):
    url = f"https://www.bankofcanada.ca/valet/observations/{','.join(series_ids)}/json"
    r = requests.get(url, params={"recent": recent}, timeout=30)
    r.raise_for_status()
    yield r.json()                       # the whole payload: one document


reset("nest_lab")
p = practice_pipeline("nest_lab", "lab")
p.run(valet_raw(["V39079", "FXCADUSD"]))
print(p.default_schema.to_pretty_yaml())
```

Inspect what dlt built:

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'lab' AND table_name LIKE 'valet%';

DESCRIBE lab.valet_raw;
DESCRIBE lab.valet_raw__observations;
SELECT * FROM lab.valet_raw__observations LIMIT 5;
```

What happened:
- `terms` (a dict) became columns such as `terms__url` in the root table.
- `seriesDetail` (a dict **keyed by series ID**) became columns like `series_detail__v39079__label`, `series_detail__fxcadusd__label`, … **one set of columns per series**.
- `observations` (a list) became the child table `valet_raw__observations`, with columns such as `d`, `v39079__v`, `fxcadusd__v`.

The **list** was handled beautifully. The **dict keyed by IDs** exploded into columns. With 50 series you'd get hundreds of columns, and a new series would change the schema (which a frozen contract would block!).

> **Loading raw payloads is still valuable.** Keeping untouched responses in a raw table (with `evolve`) is your Day 9 landing zone, now queryable in SQL. For modelling, though, reshape the data first.

---

## 26.3 "Keys as Data": Reshaping Before Loading (23 min)

> **Question it answers:** How do I reshape the Bank's ID-keyed JSON into clean tables of series and observations before loading?
>
> **Other questions you can answer the same way:**
> - When should I reshape data myself instead of letting dlt flatten it?

The rule of thumb:

> **If a JSON key is actually a value (a series ID, a date, a country code), turn it into a row.**

Valet uses series IDs as keys in two places. Let's fix both with small Python functions and `add_map`:

```python
def reshape_valet(payload):
    """Turn Valet's ID-keyed structures into lists of records."""
    series = [
        {"series_id": sid, "label": info.get("label"), "description": info.get("description")}
        for sid, info in payload.get("seriesDetail", {}).items()
    ]
    observations = []
    for obs in payload.get("observations", []):
        for sid in payload.get("seriesDetail", {}):
            cell = obs.get(sid)
            if isinstance(cell, dict):
                observations.append({"date": obs["d"], "series_id": sid, "v": cell.get("v")})
    return {"series": series, "observations": observations}


reset("nest_lab")
p = practice_pipeline("nest_lab", "lab")
p.run(valet_raw(["V39079", "FXCADUSD", "BD.CDN.10YR.DQ.YLD"]).add_map(reshape_valet),
      table_name="valet_tidy")
```

```sql
DESCRIBE lab.valet_tidy__series;         -- series_id | label | description
DESCRIBE lab.valet_tidy__observations;   -- date | series_id | v
SELECT series_id, COUNT(*) FROM lab.valet_tidy__observations GROUP BY 1;
```

Now adding a series adds **rows**, not columns. The schema is stable, which is exactly what a frozen contract needs.

| Approach | Where flattening happens | Good for |
|---|---|---|
| Hand-parse in the resource (Days 21–23) | Python, fully custom | simple, well-known APIs |
| Reshape with `add_map`, let dlt normalise lists | Python for keys-as-data, dlt for lists | most real APIs |
| Load raw, flatten in SQL | DuckDB | exploring unknown APIs; keeping raw history |

---

## 26.4 StatCan WDS: Letting dlt Flatten for You (20 min)

> **Question it answers:** How do StatCan vectors and their data points become a parent table and a child table I can join?
>
> **Other questions you can answer the same way:**
> - What was the latest value of each vector, joined to its metadata?

StatCan's vector response is a list of `{status, object: {vectorId, …, vectorDataPoint: [...]}}`. Its structure is already relational (lists, not ID-keyed dicts), so we can let dlt do all the work:

```python
@dlt.resource(name="wds_vectors", write_disposition="replace")
def wds_vectors(vectors, latest_n=6):
    r = requests.post(
        "https://www150.statcan.gc.ca/t1/wds/rest/getDataFromVectorsAndLatestNPeriods",
        json=[{"vectorId": v, "latestN": latest_n} for v in vectors], timeout=30)
    r.raise_for_status()
    yield r.json()                  # a list of documents; each becomes a root row


reset("nest_lab")
p = practice_pipeline("nest_lab", "lab")
p.run(wds_vectors([41690973, 2062815]))
```

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'lab' AND table_name LIKE 'wds%';

-- The data points live in a child table; join back to the vector ID
SELECT v.object__vector_id                 AS vector_id,
       dp.ref_per,
       dp.value
FROM lab.wds_vectors                              AS v
JOIN lab.wds_vectors__object__vector_data_point   AS dp
     ON dp._dlt_parent_id = v._dlt_id
ORDER BY vector_id, dp.ref_per;
```

(Check exact column names with `DESCRIBE`: normalisation turns `vectorDataPoint` into `vector_data_point` and `refPer` into `ref_per`.)

Compare with Day 22's hand-written `statcan_source`: same result, **zero parsing code**, and every field StatCan sends (`decimals`, `scalarFactorCode`, `symbolCode`, …) is preserved.

### Try it 26.4

Using only SQL on the tables above, produce our standard long format `(date, series_id, value, source)` with `series_id` like `v41690973`.

<details>
<summary>Solution</summary>

```sql
SELECT CAST(dp.ref_per AS DATE)             AS date,
       'v' || v.object__vector_id           AS series_id,
       CAST(dp.value AS DOUBLE)             AS value,
       'statcan'                            AS source
FROM lab.wds_vectors                            AS v
JOIN lab.wds_vectors__object__vector_data_point AS dp ON dp._dlt_parent_id = v._dlt_id
WHERE dp.value IS NOT NULL
ORDER BY series_id, date;
```

This is a **staging model** (Day 18) on top of a raw nested load. Whether you flatten in Python or in SQL is a design choice. SQL keeps the raw layer complete; Python keeps the raw layer small.

</details>

---

## 26.5 Controlling Depth: `max_table_nesting` and JSON Columns (20 min)

> **Question it answers:** How do I stop a deeply nested API from creating dozens of child tables?
>
> **Other questions you can answer the same way:**
> - How do I keep nested detail as a JSON column instead?

Deeply nested APIs can produce many child tables. `max_table_nesting` sets how many levels become tables. Anything deeper is stored as a **JSON column** instead.

```python
@dlt.resource(name="wds_shallow", write_disposition="replace", max_table_nesting=0)
def wds_shallow(vectors, latest_n=6):
    yield from wds_vectors(vectors, latest_n)
```

`yield from` passes along every item another generator produces. It's a neat way to reuse a resource.

With `max_table_nesting=0`, nested data isn't flattened at all: no child tables are created, and nested structures are stored as JSON in the root table.

```sql
DESCRIBE lab.wds_shallow;

-- DuckDB can query JSON directly
SELECT object ->> '$.vectorId'                           AS vector_id,
       json_array_length(object -> '$.vectorDataPoint')  AS n_points,
       object -> '$.vectorDataPoint[0]' ->> '$.refPer'   AS first_ref_per
FROM lab.wds_shallow;
```

| Operator | Returns |
|---|---|
| `json -> '$.path'` | a JSON value (for further navigation) |
| `json ->> '$.path'` | text |
| `json_array_length(json)` | number of items |

When is a JSON column the right choice?
- The nested part is **rarely queried** (e.g. footnotes, audit metadata).
- Its structure is **irregular**, so a child table would be mostly `NULL`s.
- You want to **defer decisions**: keep it now, flatten in SQL later.

---

## 26.6 Mini-Project: StatCan Cube Metadata → a Product Hierarchy (28 min)

> **Question it answers:** What dimensions and members does a StatCan table have, and how are CPI components arranged in a hierarchy?
>
> **Other questions you can answer the same way:**
> - Which components sit under "Shelter"?
> - Which geographies does a table cover?

StatCan's `getCubeMetadata` endpoint describes a table's **dimensions** and their **members**, including each member's parent. For CPI, that's the product hierarchy: *All-items → Food → Food purchased from stores → …*. That hierarchy is exactly what the Day 19 stretch goal (diffusion over leaf-level components) needed.

**Tasks:**
1. Write a resource `cube_metadata(product_ids)` that POSTs `[{"productId": pid}, ...]` to `https://www150.statcan.gc.ca/t1/wds/rest/getCubeMetadata` and yields the response.
2. Load it for CPI (`18100004`) into the practice pipeline, with `root_key=True` on a small source wrapper so every child row carries `_dlt_root_id`.
3. Explore the tables dlt created (expect a dimension table and a nested member table).
4. In SQL, list the dimensions of the CPI table and the number of members in each.
5. For the *Products and product groups* dimension, list the members whose parent is *All-items*: the top level of the CPI basket.
6. Find the **leaf** products (members that are nobody's parent).

<details>
<summary>Solution</summary>

```python
import dlt
from dlt.sources.helpers import requests
from common import practice_pipeline, reset

WDS = "https://www150.statcan.gc.ca/t1/wds/rest"


@dlt.source(name="statcan_meta", root_key=True)
def statcan_meta(product_ids):

    @dlt.resource(name="cube_metadata", write_disposition="replace")
    def cube_metadata():
        r = requests.post(f"{WDS}/getCubeMetadata",
                          json=[{"productId": pid} for pid in product_ids], timeout=60)
        r.raise_for_status()
        yield r.json()

    return cube_metadata


reset("nest_lab")
p = practice_pipeline("nest_lab", "lab")
p.run(statcan_meta([18100004]))
```

```sql
-- 3. What was created?
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'lab' AND table_name LIKE 'cube_metadata%';
DESCRIBE lab.cube_metadata__object__dimension;
DESCRIBE lab.cube_metadata__object__dimension__member;

-- 4. Dimensions and member counts
SELECT d.dimension_name_en, COUNT(*) AS n_members
FROM lab.cube_metadata__object__dimension          AS d
JOIN lab.cube_metadata__object__dimension__member  AS m ON m._dlt_parent_id = d._dlt_id
GROUP BY d.dimension_name_en;

-- 5. Top level of the product hierarchy
WITH members AS (
    SELECT m.member_id, m.parent_member_id, m.member_name_en
    FROM lab.cube_metadata__object__dimension          AS d
    JOIN lab.cube_metadata__object__dimension__member  AS m ON m._dlt_parent_id = d._dlt_id
    WHERE d.dimension_name_en = 'Products and product groups'
)
SELECT child.member_name_en
FROM members AS child
JOIN members AS parent ON child.parent_member_id = parent.member_id
WHERE parent.member_name_en = 'All-items'
ORDER BY 1;

-- 6. Leaves: members that are nobody's parent
WITH members AS (
    SELECT m.member_id, m.parent_member_id, m.member_name_en
    FROM lab.cube_metadata__object__dimension          AS d
    JOIN lab.cube_metadata__object__dimension__member  AS m ON m._dlt_parent_id = d._dlt_id
    WHERE d.dimension_name_en = 'Products and product groups'
)
SELECT COUNT(*) AS n_leaves
FROM members AS m
WHERE NOT EXISTS (SELECT 1 FROM members AS c WHERE c.parent_member_id = m.member_id);
```

The member table is a **self-referencing hierarchy** (`parent_member_id` → `member_id`). Joining a table to itself, as on Day 15, walks the tree one level at a time. If your column names differ slightly, adjust them after checking `DESCRIBE`.

</details>

### Day 26 checklist
- [ ] I can predict how dlt turns nested dicts and lists into columns and child tables
- [ ] I can re-join child tables to parents with `_dlt_parent_id`, `_dlt_list_idx` and `_dlt_root_id`
- [ ] I recognise "keys as data" and reshape it into rows before loading
- [ ] I can choose between flattening in Python, in dlt, or in SQL
- [ ] I can limit nesting and query JSON columns in DuckDB
- [ ] I extracted StatCan's CPI product hierarchy from nested metadata

```bash
git add .
git commit -m "Day 26: nested JSON, child tables, JSON columns, CPI hierarchy"
git push
```

---

# DAY 27 — Incremental Loading

| Time | Block |
|---|---|
| 0:00 – 0:18 | 27.1 Why incremental? Five loading patterns |
| 0:18 – 0:43 | 27.2 `dlt.sources.incremental`: a cursor on one series |
| 0:43 – 0:50 | Break |
| 0:50 – 1:10 | 27.3 Revisions: lookback windows + `merge` |
| 1:10 – 1:30 | 27.4 Many series, one resource: per-series state |
| 1:30 – 1:38 | Break |
| 1:38 – 1:53 | 27.5 Change detection: only download tables that were republished |
| 1:53 – 2:05 | 27.6 Backfills, resets and vintages |
| 2:05 – 2:30 | 27.7 Capstone: an incremental `macro_ingest` |

---

## 27.1 Why Incremental? Five Loading Patterns (18 min)

Right now every run downloads everything since 2006, even though at most a few days have changed. That's slow, wastes the providers' bandwidth, and makes frequent refreshes (Days 51–60) impractical.

| Pattern | How it works | Macro example |
|---|---|---|
| **Full refresh** | download all, `replace` | small metadata tables |
| **Incremental append** | download only rows after a *cursor*, `append` | an event log (BoC decisions) |
| **Incremental merge** | download recent rows, `merge` on a primary key | daily rates; revised CPI and GDP |
| **Change detection** | check a "last updated" marker first; skip unchanged sources | full StatCan tables |
| **Snapshots / vintages** | keep every downloaded version | studying data revisions |

Two concepts make these work:
- a **cursor**: the column that tells you how far you've loaded (usually the observation date);
- **state**: somewhere to remember the cursor between runs. dlt stores it with the pipeline, and commits it **only when a load succeeds**.

---

## 27.2 `dlt.sources.incremental`: a Cursor on One Series (25 min)

> **Question it answers:** How do I download only the observations that are newer than the last one I loaded?
>
> **Other questions you can answer the same way:**
> - How much faster is an incremental run than a full reload?

Create `day27/incremental_basics.py`:

```python
from datetime import date

import dlt
from dlt.sources.helpers import requests
from common import practice_pipeline

BASE = "https://www.bankofcanada.ca/valet"


@dlt.resource(name="overnight_rate", write_disposition="append", primary_key="date",
              columns={"value": {"data_type": "double"}})
def overnight_rate(obs_date=dlt.sources.incremental("date", initial_value=date(2024, 1, 1))):
    start = obs_date.start_value                  # where the previous run finished
    print(f"  requesting data from {start}")
    r = requests.get(f"{BASE}/observations/V39079/json",
                     params={"start_date": start.isoformat()}, timeout=30)
    r.raise_for_status()
    rows = []
    for obs in r.json().get("observations", []):
        try:
            rows.append({"date": date.fromisoformat(obs["d"]),
                         "value": float(obs["V39079"]["v"])})
        except (KeyError, TypeError, ValueError):
            continue
    yield rows


if __name__ == "__main__":
    p = practice_pipeline("incr_lab", "lab")
    info = p.run(overnight_rate())
    print(info)
```

Run it **twice**:

```bash
python day27/incremental_basics.py
python day27/incremental_basics.py
duckdb incr_lab.duckdb -c "SELECT _dlt_load_id, COUNT(*) FROM lab.overnight_rate GROUP BY 1"
```

- **First run:** requests from 2024-01-01 and loads everything since.
- **Second run:** requests from the **last loaded date**. dlt also filters out rows it already loaded at the boundary (using the primary key), so the second load adds almost nothing.

### How it works

1. `dlt.sources.incremental("date", initial_value=...)` declares `date` as the cursor.
2. On each run, `obs_date.start_value` is the cursor's value from the last **successful** run (or `initial_value` the first time).
3. As rows pass through, dlt tracks the maximum `date` and saves it as the new state after a successful load.
4. The request uses `start_value`, so the API only sends new data. That's the real saving.

### Where is the state?

> **Question it answers:** What is the last date the pipeline remembers loading?
>
> **Other questions you can answer the same way:**
> - Why did the pipeline skip data I expected?

```python
import json
print(json.dumps(p.state.get("sources", {}), indent=2, default=str))
```

You'll find the cursor's `last_value` under the resource name. The state is also stored in the destination (`_dlt_pipeline_state`), so a pipeline can recover it even on a new machine.

---

## 27.3 Revisions: Lookback Windows + `merge` (20 min)

> **Question it answers:** How do I pick up revisions to recent months while still loading only new data?
>
> **Other questions you can answer the same way:**
> - How far back should I re-request to catch StatCan's revisions?

Economic data gets **revised**. StatCan revises recent months of many series with each release, and GDP is revised for years. A pure "only after the cursor" strategy **never sees revisions** to data it already loaded.

The standard remedy: **re-request a window before the cursor, and `merge` on the primary key**, so revised values overwrite old ones and new values are inserted.

```
         already loaded                 new
|----------------------------------|========|
                      |--lookback--|
                      ↑ request from here, merge on (series_id, date)
```

```python
from datetime import timedelta


@dlt.resource(name="overnight_rate_rev", write_disposition="merge", primary_key="date",
              columns={"value": {"data_type": "double"}})
def overnight_rate_rev(obs_date=dlt.sources.incremental("date", initial_value=date(2024, 1, 1)),
                       lookback_days=30):
    start = obs_date.start_value - timedelta(days=lookback_days)
    ...  # same request/parse as before, using `start`
```

> **A subtlety.** dlt's incremental filter drops rows *older* than the saved cursor, which would throw away the lookback rows you deliberately re-requested. Recent dlt versions offer a `lag` option on `dlt.sources.incremental` for exactly this. The approach in 27.4, managing the cursor yourself, avoids the issue entirely and works for many series at once, so it's what our capstone uses.

How long should the lookback be?

| Series | Typical revision horizon | Sensible lookback |
|---|---|---|
| BoC policy rate, bond yields, FX | rarely revised | a few days |
| FRED monthly series | recent months | 3–6 months |
| StatCan CPI (NSA) | rarely revised | 2–3 months |
| StatCan GDP, LFS | months to years (annual revisions) | 2–3 years |

`merge` makes a generous lookback cheap and safe: rows that didn't change are simply rewritten with the same values.

---

## 27.4 Many Series, One Resource: Per-Series State (20 min)

> **Question it answers:** How do I track the last loaded date separately for each series, so daily series don't make me skip monthly ones?
>
> **Other questions you can answer the same way:**
> - Why did FEDFUNDS miss its latest month?

Our observation resources load **many series** into one long table. A single cursor per resource is then wrong:

```
V39079   (daily)    last date: 2026-09-29
FEDFUNDS (monthly)  last date: 2026-08-01
cursor = max(...) = 2026-09-29  → next run skips FEDFUNDS September data!
```

The fix is to store **one cursor per series** in the resource's own state, a dictionary that dlt saves for you:

```python
from datetime import date, timedelta

import dlt
from dlt.sources.helpers import requests

BASE = "https://www.bankofcanada.ca/valet"


@dlt.resource(name="boc_observations_incr", write_disposition="merge",
              primary_key=("series_id", "date"),
              columns={"value": {"data_type": "double"}})
def boc_observations_incr(series_ids, initial_date="2006-01-01", lookback_days=14):
    state = dlt.current.resource_state()                 # persisted dict for this resource
    cursors = state.setdefault("last_date", {})          # {series_id: "YYYY-MM-DD"}

    for sid in series_ids:
        if sid in cursors:
            start = date.fromisoformat(cursors[sid]) - timedelta(days=lookback_days)
        else:
            start = date.fromisoformat(initial_date)

        r = requests.get(f"{BASE}/observations/{sid}/json",
                         params={"start_date": start.isoformat()}, timeout=30)
        r.raise_for_status()

        rows = []
        for obs in r.json().get("observations", []):
            cell = obs.get(sid)
            try:
                rows.append({"date": date.fromisoformat(obs["d"]), "series_id": sid,
                             "value": float(cell.get("v")), "source": "boc"})
            except (AttributeError, TypeError, ValueError):
                continue

        if rows:
            cursors[sid] = max(row["date"] for row in rows).isoformat()
        print(f"  {sid}: from {start} → {len(rows)} rows")
        yield rows
```

Notes:
- `dlt.current.resource_state()` returns a dictionary that dlt saves **only if the load succeeds**. If the run crashes halfway, the cursors don't advance, so no data is skipped.
- Store **JSON-friendly** values (strings, numbers) in state. We save ISO date strings, not `date` objects.
- Because of `merge`, the lookback rows update existing rows instead of duplicating them.

### Try it 27.4

Load `["V39079", "FXCADUSD"]` into the practice pipeline, run it twice, and confirm: (a) the second run requests only recent data; (b) there are no duplicate `(series_id, date)` rows; (c) the state contains one cursor per series.

<details>
<summary>Solution</summary>

```python
from common import practice_pipeline
p = practice_pipeline("incr_lab", "lab")
for _ in range(2):
    p.run(boc_observations_incr(["V39079", "FXCADUSD"]))

import json
print(json.dumps(p.state["sources"], indent=2, default=str))
```

```sql
SELECT series_id, date, COUNT(*) FROM lab.boc_observations_incr
GROUP BY ALL HAVING COUNT(*) > 1;          -- expect zero rows
```

</details>

---

## 27.5 Change Detection: Only Download Republished Tables (15 min)

> **Question it answers:** Has StatCan republished this table since my last download, and should I fetch it again?
>
> **Other questions you can answer the same way:**
> - When was the CPI table last released?

Full StatCan tables (Days 10 and 18) are large, and most days they haven't changed. `getCubeMetadata` (Day 26) includes a **release time**. Store it in state and skip the download when it hasn't moved:

```python
from datetime import datetime, timezone

import dlt
from dlt.sources.helpers import requests

WDS = "https://www150.statcan.gc.ca/t1/wds/rest"


@dlt.resource(name="statcan_releases", write_disposition="append")
def statcan_releases(product_ids):
    """Yield a row only for tables republished since the last successful run."""
    state = dlt.current.resource_state()
    seen = state.setdefault("release_time", {})

    r = requests.post(f"{WDS}/getCubeMetadata",
                      json=[{"productId": pid} for pid in product_ids], timeout=60)
    r.raise_for_status()

    for item in r.json():
        if item.get("status") != "SUCCESS":
            continue
        obj = item["object"]
        pid = str(obj.get("productId"))
        release = obj.get("releaseTime")
        if seen.get(pid) == release:
            print(f"  {pid}: unchanged since {release} — skipping")
            continue
        seen[pid] = release
        yield {"product_id": pid, "release_time": release,
               "detected_at": datetime.now(timezone.utc)}
```

Each row in `statcan_releases` records **when** a table was republished: a log of release events. On Days 58–60, Prefect will use exactly this signal to trigger the heavy table download and the dbt rebuild only when StatCan publishes something new.

---

## 27.6 Backfills, Resets and Vintages (13 min)

### Backfilling a historical window

> **Question it answers:** How do I reload 2008–2009 without disturbing the saved position for regular runs?
>
> **Other questions you can answer the same way:**
> - How do I fill a gap in past data?

To (re)load a specific past period without disturbing the saved cursor, give the incremental an `end_value`:

```python
p.run(overnight_rate(
    obs_date=dlt.sources.incremental("date", initial_value=date(2008, 1, 1),
                                     end_value=date(2010, 1, 1))))
```

When `end_value` is set, dlt treats the run as a **backfill** and does not update the state.

### Starting over

> **Question it answers:** How do I drop a resource's tables and memory and reload everything from scratch?
>
> **Other questions you can answer the same way:**
> - What do I do after a bad load corrupted the data?

```python
p.run(source, refresh="drop_resources")    # drop the resources' tables AND state, then reload
```

Use this after changing a resource's logic in a way that invalidates what's already loaded, for example a different cleaning rule.

### Keeping vintages: how did the data look *then*?

> **Question it answers:** What did real GDP for each quarter look like in each past release (each vintage)?
>
> **Other questions you can answer the same way:**
> - How much was last quarter's GDP revised?
> - What data would a forecaster have had on a given date?

`merge` keeps only the **latest** value. For research on revisions (and for honest forecasting evaluation on Days 61–70), you may want every version. The simplest approach is a separate **append** table of snapshots:

```python
@dlt.resource(name="gdp_vintages", write_disposition="append")
def gdp_vintages(latest_n=12):
    """Append the latest N quarters of real GDP on every run (one snapshot per run)."""
    ...  # POST getDataFromVectorsAndLatestNPeriods for your GDP vector; yield long rows
```

Each run's rows carry a different `_dlt_load_id`, so SQL can find revisions:

```sql
WITH v AS (
    SELECT g.date, g.value, l.inserted_at AS vintage
    FROM raw_dlt.gdp_vintages AS g
    JOIN raw_dlt._dlt_loads   AS l ON l.load_id = g._dlt_load_id
)
SELECT date,
       arg_min(value, vintage) AS first_estimate,
       arg_max(value, vintage) AS latest_estimate,
       arg_max(value, vintage) - arg_min(value, vintage) AS total_revision
FROM v
GROUP BY date
HAVING COUNT(DISTINCT value) > 1
ORDER BY date;
```

> dlt also offers a built-in *slowly changing dimension* strategy, `write_disposition={"disposition": "merge", "strategy": "scd2"}`, which adds validity-period columns (`_dlt_valid_from`, `_dlt_valid_to`). It assumes each run delivers a **complete** snapshot, so read its documentation carefully before using it with windowed API requests.

---

## 27.7 Capstone: An Incremental `macro_ingest` (25 min)

> **Question it answers:** How do I make the production pipeline load only new and revised data, with per-series state and lookback windows?
>
> **Other questions you can answer the same way:**
> - How do I configure the lookback for each source?

Upgrade the Day 23 package.

**Requirements:**
1. **BoC** `boc_observations`: `merge`, per-series cursors (27.4), `lookback_days` configurable (default 14).
2. **FRED** `fred_observations`: `merge`, per-series cursors. The CSV endpoint always returns full history, so the saving here is in **loading** (only rows ≥ cursor − lookback are yielded), not downloading. Default lookback 180 days, for revisions.
3. **StatCan** `statcan_observations`: `merge`. Set `latest_n` in config to a revision-friendly window (e.g. 36 months) after an initial full load of 250.
4. Metadata resources stay `replace`.
5. Contracts from Day 25 stay in place.
6. New config keys in `.dlt/config.toml`:

```toml
[sources.boc]
series_ids = ["V39079", "FXCADUSD", "BD.CDN.2YR.DQ.YLD", "BD.CDN.10YR.DQ.YLD"]
start_date = "2006-01-01"
lookback_days = 14

[sources.fred]
series_ids = ["FEDFUNDS", "DCOILWTICO", "CANLOLITOAASTSAM"]
start_date = "2006-01-01"
lookback_days = 180

[sources.statcan]
vectors = [41690973, 2062815]
latest_n = 36
```

7. Because the tables change from `replace` to `merge`, do the first run with `refresh="drop_resources"` (add a `--full-refresh` flag to `ingest.py`).
8. Add an SQL test `sql/tests/raw_dlt_no_duplicate_observations.sql` (severity `error`).

<details>
<summary>Solution — <code>macro_ingest/boc.py</code> (FRED follows the same pattern)</summary>

```python
"""Bank of Canada Valet source — incremental with per-series cursors."""
from datetime import date, timedelta

import dlt
from dlt.sources.helpers import requests

BASE = "https://www.bankofcanada.ca/valet"
OBS_CONTRACT = {"columns": "freeze", "data_type": "freeze"}


def _fetch(series_id, start):
    r = requests.get(f"{BASE}/observations/{series_id}/json",
                     params={"start_date": start}, timeout=30)
    r.raise_for_status()
    return r.json()


@dlt.source(name="boc", section="boc")
def boc_source(series_ids: list = dlt.config.value,
               start_date: str = dlt.config.value,
               lookback_days: int = 14):

    @dlt.resource(name="boc_observations", write_disposition="merge",
                  primary_key=("series_id", "date"),
                  columns={"value": {"data_type": "double"}},
                  schema_contract=OBS_CONTRACT)
    def observations():
        cursors = dlt.current.resource_state().setdefault("last_date", {})
        for sid in series_ids:
            start = (date.fromisoformat(cursors[sid]) - timedelta(days=lookback_days)
                     if sid in cursors else date.fromisoformat(start_date))
            rows = []
            for obs in _fetch(sid, start.isoformat()).get("observations", []):
                cell = obs.get(sid)
                try:
                    rows.append({"date": date.fromisoformat(obs["d"]), "series_id": sid,
                                 "value": float(cell.get("v")), "source": "boc"})
                except (AttributeError, TypeError, ValueError):
                    continue
            if rows:
                cursors[sid] = max(r["date"] for r in rows).isoformat()
            yield rows

    @dlt.resource(name="boc_series_metadata", write_disposition="replace",
                  primary_key="series_id",
                  schema_contract={"columns": "evolve", "data_type": "freeze"})
    def series_metadata():
        for sid in series_ids:
            info = _fetch(sid, date.today().isoformat()).get("seriesDetail", {}).get(sid, {})
            yield {"series_id": sid, "label": info.get("label"),
                   "description": info.get("description")}

    return observations, series_metadata
```

For FRED, the same structure applies: compute `start` from the cursor (or `start_date`), download the CSV, and yield only rows with `date >= start`.

</details>

<details>
<summary>Solution — <code>ingest.py</code> changes</summary>

```python
import sys

FULL_REFRESH = "--full-refresh" in sys.argv

# inside the loop over sources:
info = pipeline.run(make_source(),
                    refresh="drop_resources" if FULL_REFRESH else None)
```

</details>

<details>
<summary>Solution — the SQL test</summary>

```sql
-- severity: error
-- sql/tests/raw_dlt_no_duplicate_observations.sql
SELECT source, series_id, date, COUNT(*) AS n
FROM (SELECT source, series_id, date FROM raw_dlt.boc_observations
      UNION ALL SELECT source, series_id, date FROM raw_dlt.fred_observations
      UNION ALL SELECT source, series_id, date FROM raw_dlt.statcan_observations)
GROUP BY ALL
HAVING COUNT(*) > 1
```

</details>

### Measure the improvement

> **Question it answers:** How much faster is the incremental pipeline than a full refresh, and do all tests still pass?
>
> **Other questions you can answer the same way:**
> - Is the incremental data identical to a full reload?

```bash
time python ingest.py --full-refresh      # first, full load
time python ingest.py                     # incremental
python run_tests.py
```

```sql
-- How many rows did each run touch?
SELECT l.load_id, l.inserted_at, COUNT(o.series_id) AS boc_rows
FROM raw_dlt._dlt_loads AS l
LEFT JOIN raw_dlt.boc_observations AS o ON o._dlt_load_id = l.load_id
GROUP BY ALL
ORDER BY l.inserted_at DESC
LIMIT 5;
```

With `merge`, each row keeps the `_dlt_load_id` of the run that **last wrote it**. Rows inside the lookback window move to the newest load, and older rows keep their original load ID.

### Recap: Days 24–27

| Capability | Tool |
|---|---|
| Know exactly what changed in an API | exported schemas in Git (`export_schema_path`) |
| Stop harmful changes, allow harmless ones | schema contracts per layer |
| Check structure of each row | Pydantic models as `columns` |
| Keep full raw responses queryable | nested loads, child tables, JSON columns |
| Turn IDs-as-keys into rows | reshape with `add_map` |
| Download only what's new | incremental cursors and per-series state |
| Absorb revisions | lookback windows + `merge` |
| Skip unchanged tables | release-time change detection |
| Study revisions | append-only vintage snapshots |

### Looking ahead: Days 28–30

You'll harden the BoC Valet and StatCan extractors for production: dlt's declarative **REST API source** and `RESTClient`, pagination and rate limits, failure scenarios and alerts. Then you'll switch the Day 18–20 staging models to read from `raw_dlt`, so the whole warehouse is fed by automated, incremental, contract-protected ingestion.

### Day 27 checklist
- [ ] I can choose between full refresh, incremental append, incremental merge, change detection and snapshots
- [ ] I can use `dlt.sources.incremental` and inspect pipeline state
- [ ] I use lookback windows with `merge` to capture statistical revisions
- [ ] I manage per-series cursors with `dlt.current.resource_state()`
- [ ] I can backfill, reset and keep vintages
- [ ] `macro_ingest` now loads incrementally, with contracts, and passes a duplicates test

```bash
git add .
git commit -m "Day 27: incremental loading, revisions, change detection, vintages"
git push
```
