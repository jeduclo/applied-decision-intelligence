# Module 3 · Data Ingestion with dlt
## Days 21–23: dlt Pipelines, Sources vs Resources & Secrets Management

**Audience:** MSc Economics students who completed Modules 1–2 (Days 1–20)
**Environment:** GitHub Codespaces · course `.venv` · DuckDB CLI · `macro.duckdb`
**Time per day:** ~2.5 hours (including breaks and exercises)
**Goal by end of Day 23:** Students rebuild their Day 10 `macro_extract` package with **dlt** (data load tool). They organise BoC, FRED and StatCan extraction into sources and resources, keep configuration and secrets out of their code, and load everything into `macro.duckdb` with one command.

---

### Why a new tool now?

On Days 8–10 you wrote extraction by hand, and it worked. Look at how much code went into things that have nothing to do with economics:

| You wrote by hand (Days 8–10) | dlt provides |
|---|---|
| retrying HTTP session (`net.py`) | `dlt.sources.helpers.requests`, with retries built in |
| a common output schema (`schema.py`) | automatic schema inference, typing and evolution |
| writing Parquet, then loading DuckDB (Day 13) | loads directly into DuckDB (and 20+ other destinations) |
| a raw landing zone (`rawstore.py`) | load packages kept on disk for every run |
| a catalogue in a Python file | configuration files and environment variables |
| API keys in env vars, read manually | a full secrets system with clear lookup rules |
| `fetched_at` column, logging | `_dlt_load_id`, `_dlt_loads` table, run traces |

dlt lets you keep **your** part (knowing which economic series to fetch and how to parse them) and hands the plumbing to a well-tested library.

> You'll recognise almost everything here from Days 8–10. That's deliberate: dlt makes most sense once you've felt the pain it removes.

### Vocabulary

| dlt term | Meaning | Macro example |
|---|---|---|
| **resource** | a function that yields data for **one table** | BoC observations |
| **source** | a group of related resources sharing config and credentials | "Bank of Canada" |
| **pipeline** | moves data from sources to a destination | `macro_ingest` |
| **destination** | where data lands | DuckDB (`macro.duckdb`) |
| **dataset** | the schema inside the destination | `raw_dlt` |

Every `pipeline.run()` goes through three stages: **extract** (call your resources) → **normalize** (infer schema, flatten, type) → **load** (write to the destination).

### Target folder structure (by end of Day 23)

```
macro-data-course/
├── .dlt/
│   ├── config.toml          ← non-secret settings (committed)
│   └── secrets.toml         ← secrets (NEVER committed)
├── macro_ingest/            ← dlt version of macro_extract
│   ├── __init__.py
│   ├── boc.py
│   ├── fred.py
│   └── statcan.py
├── ingest.py                ← runs all sources into macro.duckdb
├── day21/  day22/  day23/   ← practice scripts
```

---

# DAY 21 — Your First dlt Pipelines

| Time | Block |
|---|---|
| 0:00 – 0:15 | 21.1 Installing dlt |
| 0:15 – 0:40 | 21.2 The smallest possible pipeline |
| 0:40 – 0:48 | Break |
| 0:48 – 1:10 | 21.3 Running twice: write dispositions |
| 1:10 – 1:35 | 21.4 Python generators and `yield` |
| 1:35 – 1:43 | Break |
| 1:43 – 2:05 | 21.5 `@dlt.resource`: a real BoC resource |
| 2:05 – 2:18 | 21.6 Inspecting pipelines and loads |
| 2:18 – 2:30 | 21.7 Mini-project: a FRED resource |

---

## 21.1 Installing dlt (15 min)

```bash
cd /workspaces/macro-data-course
source .venv/bin/activate
pip install "dlt[duckdb]"
pip freeze > requirements.txt
dlt --version
```

The `[duckdb]` part installs the extra packages dlt needs for the DuckDB destination.

Add these lines to `.gitignore` now, **before** you create any secrets:

```
.dlt/secrets.toml
*.duckdb
*.duckdb.wal
```

---

## 21.2 The Smallest Possible Pipeline (25 min)

> **Question it answers:** How do I load a small list of rate decisions into a database table, with the table created for me?
>
> **Other questions you can answer the same way:**
> - How do I get records from Python into DuckDB without writing CREATE TABLE?
> - What is the least code needed to load data?

Create `day21/first_pipeline.py`:

```python
import dlt

# Data: a plain Python list of dictionaries (Day 1 + Day 4!)
decisions = [
    {"decision_date": "2025-01-29", "rate": 3.00, "change_bp": -25},
    {"decision_date": "2025-03-12", "rate": 2.75, "change_bp": -25},
    {"decision_date": "2025-04-16", "rate": 2.25, "change_bp": -50},
]

pipeline = dlt.pipeline(
    pipeline_name="dlt_practice",   # also the name of the DuckDB file
    destination="duckdb",
    dataset_name="practice",        # the schema inside DuckDB
)

load_info = pipeline.run(decisions, table_name="boc_decisions")
print(load_info)
```

Run it:

```bash
python day21/first_pipeline.py
ls *.duckdb
```

dlt created `dlt_practice.duckdb` in your current folder. Open it with the tools you already know:

```bash
duckdb dlt_practice.duckdb
```

```sql
.mode box
SELECT table_schema, table_name FROM information_schema.tables ORDER BY 1, 2;
SELECT * FROM practice.boc_decisions;
DESCRIBE practice.boc_decisions;
```

### What dlt did for you

> **Question it answers:** What tables did dlt create, and when did each load happen?
>
> **Other questions you can answer the same way:**
> - When was this table last loaded?
> - Which schema version is in use?

1. **Created a schema** (`practice`) and a **table** (`boc_decisions`).
2. **Inferred types**: `rate` → `DOUBLE`, `change_bp` → `BIGINT`, and `decision_date` → a text or date column depending on how dlt reads the string (next block).
3. **Added bookkeeping columns**: `_dlt_load_id` (which run loaded this row) and `_dlt_id` (a unique row ID).
4. **Created system tables**:

```sql
SELECT * FROM practice._dlt_loads;          -- one row per successful load
SELECT * FROM practice._dlt_version;        -- schema versions
```

`_dlt_loads` replaces the `fetched_at` column you added by hand on Day 10: every row can be traced to the exact run that produced it.

### Types: be explicit about dates

> **Question it answers:** How do I make sure decision dates are stored as real dates, not text?
>
> **Other questions you can answer the same way:**
> - Why is my date column a VARCHAR in the database?

Strings that look like dates may stay text. Convert them in Python, and dlt will create a proper `DATE` column:

```python
from datetime import date

decisions = [
    {"decision_date": date(2025, 1, 29), "rate": 3.00, "change_bp": -25},
    {"decision_date": date(2025, 3, 12), "rate": 2.75, "change_bp": -25},
    {"decision_date": date(2025, 4, 16), "rate": 2.25, "change_bp": -50},
]
```

Or give dlt a **column hint**:

```python
load_info = pipeline.run(
    decisions,
    table_name="boc_decisions",
    columns={"decision_date": {"data_type": "date"}},
)
```

> Quit the DuckDB CLI (`.quit`) before running a pipeline that writes to the same file. DuckDB still allows only one writer at a time (Day 13).

---

## 21.3 Running Twice: Write Dispositions (23 min)

> **Question it answers:** Why do I have 6 rows instead of 3 after running the pipeline twice, and which load added each row?
>
> **Other questions you can answer the same way:**
> - Should this table be appended to or replaced each run?
> - How many rows did each load add?

Run `first_pipeline.py` **again**, then count the rows:

```sql
SELECT COUNT(*) FROM practice.boc_decisions;     -- 6, not 3!
SELECT _dlt_load_id, COUNT(*) FROM practice.boc_decisions GROUP BY 1;
```

By default dlt **appends**. For a decision log that's a bug: every run duplicates history. The **write disposition** controls what happens:

| Disposition | Behaviour | Use for |
|---|---|---|
| `"append"` (default) | add new rows | event logs, snapshots you want to keep |
| `"replace"` | drop the old data, load fresh | small tables re-downloaded in full |
| `"merge"` | update rows with the same **primary key**, insert new ones | data with revisions (Days 24–27) |

```python
load_info = pipeline.run(
    decisions,
    table_name="boc_decisions",
    write_disposition="replace",
)
```

Run it twice and check that the count stays at 3.

### A first look at `merge`

> **Question it answers:** How do I update a revised decision and add a new one, without creating duplicates?
>
> **Other questions you can answer the same way:**
> - How do I apply StatCan's revisions to past months?
> - How do I keep one row per date across many runs?

Macro data gets **revised**: StatCan updates past months. `merge` handles that when you tell dlt which columns identify a row:

```python
revised = [
    {"decision_date": date(2025, 4, 16), "rate": 2.25, "change_bp": -50,
     "note": "Tariff shock"},                                   # updated row
    {"decision_date": date(2025, 6, 4), "rate": 2.25, "change_bp": 0,
     "note": "Hold"},                                           # new row
]

pipeline.run(revised, table_name="boc_decisions",
             write_disposition="merge", primary_key="decision_date")
```

```sql
SELECT decision_date, rate, change_bp, note FROM practice.boc_decisions ORDER BY 1;
```

Notice that the table gained a `note` column automatically. That's **schema evolution**, covered in depth on Days 24–27.

### Try it 21.3

Load the provinces fiscal table (Day 4) into `practice.provinces` with `replace`. Then change Ontario's balance to −1.5 and load again using `merge` with `primary_key="province"`. Verify there are still 10 rows.

<details>
<summary>Solution</summary>

```python
provinces = [
    {"province": "BC", "balance_pct_gdp": -0.8}, {"province": "AB", "balance_pct_gdp": 0.2},
    {"province": "SK", "balance_pct_gdp": 0.5},  {"province": "MB", "balance_pct_gdp": -0.9},
    {"province": "ON", "balance_pct_gdp": -1.4}, {"province": "QC", "balance_pct_gdp": -1.2},
    {"province": "NB", "balance_pct_gdp": -0.5}, {"province": "NS", "balance_pct_gdp": -0.3},
    {"province": "PE", "balance_pct_gdp": -0.7}, {"province": "NL", "balance_pct_gdp": 0.1},
]
pipeline.run(provinces, table_name="provinces", write_disposition="replace")

pipeline.run([{"province": "ON", "balance_pct_gdp": -1.5}],
             table_name="provinces", write_disposition="merge", primary_key="province")
```

```sql
SELECT COUNT(*), MAX(balance_pct_gdp) FILTER (WHERE province = 'ON') FROM practice.provinces;
```

</details>

---

## 21.4 Python Generators and `yield` (25 min)

dlt resources are usually **generators**, a Python feature you haven't met yet. It's worth learning slowly.

### Example 1 — `return` gives everything at once

> **Question it answers:** What does a function that builds the whole list before handing it back look like?
>
> **Other questions you can answer the same way:**
> - Why might a huge download not fit in memory?

```python
def all_months_list(n):
    months = []
    for i in range(n):
        months.append(i)
    return months

print(all_months_list(5))     # [0, 1, 2, 3, 4]
```

### Example 2 — `yield` gives one item at a time

> **Question it answers:** How can a function hand over values one at a time, only when asked?
>
> **Other questions you can answer the same way:**
> - How do I process a long series without holding it all in memory?

```python
def months_generator(n):
    for i in range(n):
        print(f"  (producing {i})")
        yield i

gen = months_generator(3)
print(gen)                    # <generator object ...> nothing has run yet!

for m in gen:
    print("received", m)
```

Output:

```
  (producing 0)
received 0
  (producing 1)
received 1
  (producing 2)
received 2
```

The function **pauses** at each `yield` and resumes when the next item is requested. It's *lazy*: work happens only when someone consumes it.

### Why this matters for data

> **Question it answers:** How do I download many series one batch at a time instead of all at once?
>
> **Other questions you can answer the same way:**
> - How do I start loading the first series while the others are still downloading?

Imagine downloading 50 years of daily data for 200 series. With `return`, everything must fit in memory before anything is saved. With `yield`, dlt can process and write each batch as it arrives.

```python
def fetch_series_one_by_one(series_ids):
    for sid in series_ids:
        print(f"downloading {sid}...")
        rows = [{"series_id": sid, "value": 1.0}]   # imagine an API call here
        yield rows                                  # hand over one batch, then continue

for batch in fetch_series_one_by_one(["V39079", "FXCADUSD"]):
    print("got", len(batch), "rows")
```

You can yield **single dictionaries** or **lists of dictionaries** (pages). Yielding lists is faster when an API returns many rows at once.

### Example 3 — Generators are used up

> **Question it answers:** Why does my generator give an empty result the second time I read it?
>
> **Other questions you can answer the same way:**
> - Why did my second loop over the data produce nothing?

```python
gen = months_generator(2)
print(list(gen))   # [0, 1]
print(list(gen))   # [] — a generator can only be consumed once
```

### Try it 21.4

Write a generator `compounding_path(start, growth, years)` that yields a dictionary `{"year": t, "level": ...}` for each year, reproducing Day 1's compound-growth example (GDP 3180, 1.5%, 5 years). Collect it with `list(...)`.

<details>
<summary>Solution</summary>

```python
def compounding_path(start, growth, years):
    level = start
    for t in range(years + 1):
        yield {"year": t, "level": round(level, 1)}
        level *= 1 + growth

print(list(compounding_path(3180, 0.015, 5)))
```

</details>

---

## 21.5 `@dlt.resource`: a Real BoC Resource (23 min)

> **Question it answers:** How do I turn a Bank of Canada download into a resource that loads straight into the warehouse, with a primary key and merge rules?
>
> **Other questions you can answer the same way:**
> - How do I load any BoC series into DuckDB in a few lines?
> - How do I make reloading safe?

A **resource** is a generator decorated with `@dlt.resource`. The decorator attaches table-level settings: name, write disposition, keys and column hints.

Create `day21/boc_resource.py`:

```python
from datetime import date

import dlt
from dlt.sources.helpers import requests      # requests with automatic retries

BASE = "https://www.bankofcanada.ca/valet"


@dlt.resource(
    name="boc_observations",
    write_disposition="replace",
    primary_key=("series_id", "date"),
    columns={"value": {"data_type": "double"}},
)
def boc_observations(series_ids, start_date="2006-01-01"):
    """Yield one page of rows per BoC Valet series (long format, as on Day 10)."""
    for sid in series_ids:
        r = requests.get(f"{BASE}/observations/{sid}/json",
                         params={"start_date": start_date}, timeout=30)
        r.raise_for_status()

        rows = []
        for obs in r.json().get("observations", []):
            cell = obs.get(sid)
            if not isinstance(cell, dict):
                continue
            try:
                value = float(cell.get("v"))
            except (TypeError, ValueError):       # '', 'NA', 'Bank holiday', None
                continue
            rows.append({
                "date": date.fromisoformat(obs["d"]),
                "series_id": sid,
                "value": value,
                "source": "boc",
            })
        yield rows


if __name__ == "__main__":
    pipeline = dlt.pipeline(pipeline_name="dlt_practice",
                            destination="duckdb", dataset_name="practice")
    info = pipeline.run(boc_observations(["V39079", "FXCADUSD"]))
    print(info)
```

Things to notice:
- The parsing is **your Day 8 `parse_valet` logic**. dlt doesn't replace economic knowledge.
- `from dlt.sources.helpers import requests` is a drop-in replacement for `requests` that **retries automatically** on timeouts, 429 and 5xx errors. It replaces your Day 9 `make_session()`.
- `primary_key` is documentation now and becomes essential for `merge` later.
- Calling `boc_observations([...])` doesn't download anything yet; it creates a resource. The download happens inside `pipeline.run`, which is the generator's laziness at work.

```bash
python day21/boc_resource.py
duckdb dlt_practice.duckdb -c "SELECT series_id, COUNT(*), MAX(date) FROM practice.boc_observations GROUP BY 1"
```

---

## 21.6 Inspecting Pipelines and Loads (13 min)

### The load info

> **Question it answers:** Did the load succeed, and how long did each step take?
>
> **Other questions you can answer the same way:**
> - Did any part of the load fail?
> - Which step is the slowest?

```python
print(info)                       # human-readable summary
print(info.has_failed_jobs)       # True/False
print(pipeline.last_trace)        # timings of extract / normalize / load
```

### The dlt command line

> **Question it answers:** What tables and runs does the pipeline have, and how long did the last run take?
>
> **Other questions you can answer the same way:**
> - When did the pipeline last run successfully?

```bash
dlt pipeline dlt_practice info         # tables, schemas, last run
dlt pipeline dlt_practice trace        # step-by-step timings of the last run
```

### Reading data back into pandas

> **Question it answers:** What are the summary statistics of each loaded series, read straight back into pandas?
>
> **Other questions you can answer the same way:**
> - How do I check loaded data without writing SQL?

```python
ds = pipeline.dataset()
df = ds.boc_observations.df()
print(df.groupby("series_id")["value"].describe())
```

### Where dlt keeps its working files

> **Question it answers:** Where does dlt keep its state and working files between runs?
>
> **Other questions you can answer the same way:**
> - How do I reset a pipeline that got into a bad state?

```bash
ls ~/.dlt/pipelines/dlt_practice/
```

This folder holds the pipeline's **state**, its **schema** and recent **load packages** (the extracted and normalized files before loading), much like your Day 9 raw landing zone. If a pipeline gets into a confusing state during practice, you can reset it:

```bash
dlt pipeline dlt_practice drop --help     # see options; or simply:
rm -rf ~/.dlt/pipelines/dlt_practice dlt_practice.duckdb
```

### Seeing the inferred schema

> **Question it answers:** What columns and types did dlt infer for my tables?
>
> **Other questions you can answer the same way:**
> - Did dlt read the value column as a number?

```python
print(pipeline.default_schema.to_pretty_yaml())
```

Find `boc_observations` in the output. You'll see each column's `data_type`, `nullable`, and the `primary_key` flags you set.

---

## 21.7 Mini-Project: A FRED Resource (13 min)

> **Question it answers:** How do I load any list of FRED series into the warehouse, with typed dates and values and safe reloading?
>
> **Other questions you can answer the same way:**
> - How do I add US indicators alongside the Canadian ones?

Create `day21/fred_resource.py` with a resource `fred_observations(series_ids, start_date="2006-01-01")` that:

1. Downloads the FRED graph CSV for each series (Day 9), using dlt's `requests` helper.
2. Parses it with Python's built-in `csv` module (no pandas needed), skipping missing values (`""` or `"."`) and dates before `start_date`.
3. Yields long rows `{date, series_id, value, source="fred"}`, one list per series.
4. Uses `replace` and the same primary key as the BoC resource.

Load `FEDFUNDS` and `DCOILWTICO` into the same `dlt_practice` pipeline and dataset, then query both tables together with `UNION ALL BY NAME` (Day 12).

<details>
<summary>Solution</summary>

```python
import csv
import io
from datetime import date

import dlt
from dlt.sources.helpers import requests

URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"


@dlt.resource(name="fred_observations", write_disposition="replace",
              primary_key=("series_id", "date"),
              columns={"value": {"data_type": "double"}})
def fred_observations(series_ids, start_date="2006-01-01"):
    start = date.fromisoformat(start_date)
    for sid in series_ids:
        r = requests.get(URL, params={"id": sid}, timeout=30)
        r.raise_for_status()
        reader = csv.reader(io.StringIO(r.text))
        next(reader)                                  # skip header (name varies)
        rows = []
        for line in reader:
            if len(line) < 2 or line[1] in ("", "."):
                continue
            d = date.fromisoformat(line[0])
            if d >= start:
                rows.append({"date": d, "series_id": sid,
                             "value": float(line[1]), "source": "fred"})
        yield rows


if __name__ == "__main__":
    pipeline = dlt.pipeline(pipeline_name="dlt_practice",
                            destination="duckdb", dataset_name="practice")
    print(pipeline.run(fred_observations(["FEDFUNDS", "DCOILWTICO"])))
```

```sql
SELECT source, series_id, COUNT(*) AS n, MAX(date) AS latest
FROM (SELECT * FROM practice.boc_observations
      UNION ALL BY NAME
      SELECT * FROM practice.fred_observations)
GROUP BY ALL
ORDER BY source, series_id;
```

`next(reader)` pulls the first item from an iterator, here the header row, just as a generator hands over its next value.

</details>

### Day 21 checklist
- [ ] I can create a pipeline, run it and inspect the result in DuckDB
- [ ] I know what `_dlt_load_id`, `_dlt_id` and `_dlt_loads` are for
- [ ] I can choose between `append`, `replace` and `merge`
- [ ] I understand generators, `yield` and laziness
- [ ] I can write a `@dlt.resource` with column hints and a primary key
- [ ] I can inspect loads with `load_info`, the dlt CLI and `pipeline.dataset()`

```bash
git add .
git commit -m "Day 21: first dlt pipelines and resources"
git push
```

---

# DAY 22 — Sources vs Resources

| Time | Block |
|---|---|
| 0:00 – 0:20 | 22.1 Sources and resources: the design idea |
| 0:20 – 0:45 | 22.2 `@dlt.source`: grouping BoC resources |
| 0:45 – 0:53 | Break |
| 0:53 – 1:15 | 22.3 Table design: one long table or one table per series? |
| 1:15 – 1:38 | 22.4 Selecting, limiting and transforming resources |
| 1:38 – 1:45 | Break |
| 1:45 – 2:08 | 22.5 Transformers: resources that depend on other resources |
| 2:08 – 2:30 | 22.6 Mini-project: a Statistics Canada source |

---

## 22.1 The Design Idea (20 min)

> **Question it answers:** How should I group related downloads (data and metadata from one provider) so they're configured once?
>
> **Other questions you can answer the same way:**
> - Which resources belong to the BoC, FRED and StatCan sources?

| | Resource | Source |
|---|---|---|
| Produces | **one table** | a **group** of tables |
| Analogy | a single StatCan table (CPI) | the whole StatCan Web Data Service |
| Shares | — | base URL, credentials, configuration, schema |
| Decorator | `@dlt.resource` | `@dlt.source` |

A source is like a **publisher**, and its resources are the **publications**. You configure the publisher once (API key, base URL, start date) and every publication uses it.

For our project:

```
source: boc           → resources: boc_observations, boc_series_metadata
source: fred          → resources: fred_observations
source: statcan       → resources: statcan_vector_data, statcan_series_metadata
```

Keeping **metadata** as a separate resource (labels, units, frequency) gives you the dimension table from the Day 12 star schema for free.

---

## 22.2 `@dlt.source`: Grouping BoC Resources (25 min)

> **Question it answers:** How do I load BoC observations and their series descriptions together, from one configurable source?
>
> **Other questions you can answer the same way:**
> - What is the label and description of each series I load?

Create `day22/boc_source.py`:

```python
from datetime import date

import dlt
from dlt.sources.helpers import requests

BASE = "https://www.bankofcanada.ca/valet"


def _fetch(series_id, start_date):
    """Download one series; return (payload) — shared by both resources."""
    r = requests.get(f"{BASE}/observations/{series_id}/json",
                     params={"start_date": start_date}, timeout=30)
    r.raise_for_status()
    return r.json()


@dlt.source(name="boc")
def boc_source(series_ids, start_date="2006-01-01"):
    """Bank of Canada Valet API: observations + series metadata."""

    @dlt.resource(name="boc_observations", write_disposition="replace",
                  primary_key=("series_id", "date"),
                  columns={"value": {"data_type": "double"}})
    def observations():
        for sid in series_ids:
            payload = _fetch(sid, start_date)
            rows = []
            for obs in payload.get("observations", []):
                cell = obs.get(sid)
                try:
                    value = float(cell.get("v"))
                except (AttributeError, TypeError, ValueError):
                    continue
                rows.append({"date": date.fromisoformat(obs["d"]),
                             "series_id": sid, "value": value, "source": "boc"})
            yield rows

    @dlt.resource(name="boc_series_metadata", write_disposition="replace",
                  primary_key="series_id")
    def series_metadata():
        for sid in series_ids:
            payload = _fetch(sid, date.today().isoformat())   # tiny request: today only
            info = payload.get("seriesDetail", {}).get(sid, {})
            yield {"series_id": sid,
                   "label": info.get("label"),
                   "description": info.get("description")}

    return observations, series_metadata


if __name__ == "__main__":
    pipeline = dlt.pipeline(pipeline_name="dlt_practice",
                            destination="duckdb", dataset_name="practice")
    source = boc_source(["V39079", "FXCADUSD", "BD.CDN.2YR.DQ.YLD", "BD.CDN.10YR.DQ.YLD"])
    print(pipeline.run(source))
```

Things to notice:
- The resources are defined **inside** the source function, so they can use `series_ids` and `start_date` directly. Python calls this a *closure*.
- `_fetch` starts with an underscore, a Python convention meaning "internal helper, not for outside use".
- The source **returns** its resources, and `pipeline.run(source)` loads them all.

```sql
SELECT m.label, o.series_id, COUNT(*) AS n, MAX(o.date) AS latest
FROM practice.boc_observations AS o
JOIN practice.boc_series_metadata AS m USING (series_id)
GROUP BY ALL;
```

A fact table and a dimension table from one source, joined in SQL: Day 12's star schema, now fed automatically.

---

## 22.3 Table Design: One Long Table or One Table per Series? (23 min)

> **Question it answers:** Should each series get its own table, or should all series share one long table?
>
> **Other questions you can answer the same way:**
> - Which design makes it easier to add a new series later?

You could also create one table per series (`boc_v39079`, `boc_fxcadusd`, …) by creating resources dynamically:

```python
@dlt.source(name="boc_wide")
def boc_per_series(series_ids, start_date="2006-01-01"):
    resources = []
    for sid in series_ids:
        def make(sid=sid):                     # sid=sid "freezes" the loop value
            payload = _fetch(sid, start_date)
            for obs in payload.get("observations", []):
                cell = obs.get(sid)
                try:
                    yield {"date": date.fromisoformat(obs["d"]),
                           "value": float(cell.get("v"))}
                except (AttributeError, TypeError, ValueError):
                    continue
        resources.append(dlt.resource(make(), name=f"boc_{sid}",
                                      write_disposition="replace"))
    return resources
```

> **The `sid=sid` trick:** without it, every inner function would see the *last* value of `sid` when it finally runs, because generators are lazy (Day 21). Binding it as a default argument captures the value at creation time. This is a classic Python gotcha.

Which design is better?

| One long table (`series_id`, `date`, `value`) | One table per series |
|---|---|
| ✓ adding a series needs no new table | ✗ a new table for every new series |
| ✓ SQL over many series is easy (`GROUP BY series_id`) | ✗ needs `UNION` over many tables |
| ✓ matches Days 10–20 staging models | ✓ natural for series with extra columns |
| ✗ all values must share one type | ✓ each table has its own schema |

For homogeneous time series, **long** is almost always better, and it's what the rest of the course uses. Per-resource tables make sense when records have genuinely different structures (e.g. BoC decisions vs yield observations).

---

## 22.4 Selecting, Limiting and Transforming Resources (23 min)

### Selecting some resources from a source

> **Question it answers:** How do I load only the metadata, without downloading all the observations again?
>
> **Other questions you can answer the same way:**
> - How do I rerun just one part of a source?

```python
source = boc_source(["V39079"])
print(list(source.resources.keys()))       # ['boc_observations', 'boc_series_metadata']

pipeline.run(source.with_resources("boc_series_metadata"))   # load only metadata
```

### Limiting during development

> **Question it answers:** How do I test a pipeline quickly without downloading 20 years of data?
>
> **Other questions you can answer the same way:**
> - How do I check my code works before a full run?

When experimenting, don't download 20 years of data each time:

```python
pipeline.run(boc_source(["V39079", "FXCADUSD"]).add_limit(1))
```

`add_limit(1)` stops each resource after its first yield. With our code that means one series' page, which is ideal for quick tests.

### Transforming items with `add_map` and `add_filter`

> **Question it answers:** How do I add a unit to each row and keep only data since 2020, without editing the resource?
>
> **Other questions you can answer the same way:**
> - How do I drop old observations or tag rows as they load?

These apply a function to every item **as it flows through**, without editing the resource itself:

```python
def add_units(row):
    row["unit"] = "percent" if row["series_id"] == "V39079" else "CAD per USD"
    return row

def recent_only(row):
    return row["date"] >= date(2020, 1, 1)

source = boc_source(["V39079", "FXCADUSD"])
source.resources["boc_observations"].add_map(add_units).add_filter(recent_only)
pipeline.run(source)
```

| pandas idea | dlt equivalent |
|---|---|
| `df.apply(f, axis=1)` | `.add_map(f)` |
| `df[mask]` | `.add_filter(f)` |
| `df.head(n)` | `.add_limit(n)` |

> **Where should logic live?** Light, source-specific cleaning (units, dropping unusable rows) can live in dlt. Economic transformations (growth rates, aggregation) belong in the SQL layers from Days 18–20, and later in dbt. Keep ingestion boring.

### Try it 22.4

Add a map step that converts BoC **percent** values into **basis points** for `V39079` only, storing the result in a new column `value_bp`. Load with `add_limit(1)` and check the new column in DuckDB.

<details>
<summary>Solution</summary>

```python
def add_bp(row):
    if row["series_id"] == "V39079":
        row["value_bp"] = row["value"] * 100
    return row

source = boc_source(["V39079"])
source.resources["boc_observations"].add_map(add_bp)
pipeline.run(source.add_limit(1))
```

```sql
SELECT date, value, value_bp FROM practice.boc_observations ORDER BY date DESC LIMIT 3;
```

The new column appeared without any `ALTER TABLE`: schema evolution again.

</details>

---

## 22.5 Transformers: Dependent Resources (23 min)

> **Question it answers:** How do I first list every series in a Bank of Canada group, then download each one?
>
> **Other questions you can answer the same way:**
> - How do I fetch details for every item returned by a catalogue call?

Sometimes one resource's output drives another's requests: *first list the series in a group, then fetch each series*. A **transformer** receives items from a parent resource.

Create `day22/boc_groups.py`:

```python
from datetime import date

import dlt
from dlt.sources.helpers import requests

BASE = "https://www.bankofcanada.ca/valet"


@dlt.resource(name="boc_group_series", write_disposition="replace",
              primary_key="series_id")
def boc_group_series(groups):
    """Yield one metadata record per series in each BoC group."""
    for g in groups:
        r = requests.get(f"{BASE}/observations/group/{g}/json",
                         params={"recent": 1}, timeout=30)
        r.raise_for_status()
        for sid, info in r.json().get("seriesDetail", {}).items():
            yield {"series_id": sid, "group_name": g,
                   "label": info.get("label"), "description": info.get("description")}


@dlt.transformer(name="boc_group_observations", write_disposition="replace",
                 primary_key=("series_id", "date"),
                 columns={"value": {"data_type": "double"}})
def boc_group_observations(series, start_date="2024-01-01"):
    """For each series record received, fetch its observations."""
    sid = series["series_id"]
    r = requests.get(f"{BASE}/observations/{sid}/json",
                     params={"start_date": start_date}, timeout=30)
    r.raise_for_status()
    rows = []
    for obs in r.json().get("observations", []):
        cell = obs.get(sid)
        try:
            rows.append({"date": date.fromisoformat(obs["d"]), "series_id": sid,
                         "value": float(cell.get("v"))})
        except (AttributeError, TypeError, ValueError):
            continue
    yield rows


@dlt.source(name="boc_groups")
def boc_groups_source(groups, start_date="2024-01-01"):
    catalogue = boc_group_series(groups)
    return catalogue, catalogue | boc_group_observations(start_date=start_date)


if __name__ == "__main__":
    pipeline = dlt.pipeline(pipeline_name="dlt_practice",
                            destination="duckdb", dataset_name="practice")
    print(pipeline.run(boc_groups_source(["BOND_YIELDS_BENCHMARK"])))
```

The pipe operator `|` connects a resource to a transformer: *every item the catalogue yields flows into `boc_group_observations`*. Because the source returns both the catalogue and the piped transformer, **both** tables are loaded, and the catalogue is fetched only once.

```sql
SELECT s.label, COUNT(*) AS n, ROUND(arg_max(o.value, o.date), 2) AS latest
FROM practice.boc_group_observations AS o
JOIN practice.boc_group_series AS s USING (series_id)
GROUP BY s.label
ORDER BY s.label;
```

> Transformers shine when APIs are hierarchical: tables → series → observations (StatCan), groups → series → observations (BoC), or pages of search results → detail pages.

---

## 22.6 Mini-Project: A Statistics Canada Source (23 min)

> **Question it answers:** How do I load StatCan vectors (CPI, unemployment and more) with their metadata into the warehouse?
>
> **Other questions you can answer the same way:**
> - What was the latest unemployment rate, loaded from StatCan's API?

Create `day22/statcan_source.py` with a source `statcan_source(vectors, latest_n=250)` containing two resources:

1. `statcan_series_metadata`: POSTs to `getSeriesInfoFromVector` (Day 10) and yields `{vector_id, product_id, title, frequency_code}` per vector.
2. `statcan_vector_data`: POSTs to `getDataFromVectorsAndLatestNPeriods` and yields long rows `{date, series_id, value, source}`, where `series_id` is like `v41690973`.

Load vectors `41690973` (CPI All-items) and `2062815` (unemployment rate, as verified on Day 10), then join data to metadata in SQL.

<details>
<summary>Solution</summary>

```python
from datetime import date

import dlt
from dlt.sources.helpers import requests

WDS = "https://www150.statcan.gc.ca/t1/wds/rest"


@dlt.source(name="statcan")
def statcan_source(vectors, latest_n=250):

    @dlt.resource(name="statcan_series_metadata", write_disposition="replace",
                  primary_key="vector_id")
    def series_metadata():
        r = requests.post(f"{WDS}/getSeriesInfoFromVector",
                          json=[{"vectorId": v} for v in vectors], timeout=30)
        r.raise_for_status()
        for item in r.json():
            if item.get("status") != "SUCCESS":
                continue
            obj = item["object"]
            yield {"vector_id": f"v{obj['vectorId']}",
                   "product_id": obj.get("productId"),
                   "title": obj.get("SeriesTitleEn"),
                   "frequency_code": obj.get("frequencyCode")}

    @dlt.resource(name="statcan_vector_data", write_disposition="replace",
                  primary_key=("series_id", "date"),
                  columns={"value": {"data_type": "double"}})
    def vector_data():
        body = [{"vectorId": v, "latestN": latest_n} for v in vectors]
        r = requests.post(f"{WDS}/getDataFromVectorsAndLatestNPeriods",
                          json=body, timeout=60)
        r.raise_for_status()
        for item in r.json():
            if item.get("status") != "SUCCESS":
                continue
            obj = item["object"]
            sid = f"v{obj['vectorId']}"
            rows = []
            for dp in obj.get("vectorDataPoint", []):
                if dp.get("value") is None:
                    continue
                rows.append({"date": date.fromisoformat(dp["refPer"][:10]),
                             "series_id": sid, "value": float(dp["value"]),
                             "source": "statcan"})
            yield rows

    return series_metadata, vector_data


if __name__ == "__main__":
    pipeline = dlt.pipeline(pipeline_name="dlt_practice",
                            destination="duckdb", dataset_name="practice")
    print(pipeline.run(statcan_source([41690973, 2062815])))
```

```sql
SELECT m.title, d.series_id, COUNT(*) AS n, MAX(d.date) AS latest
FROM practice.statcan_vector_data AS d
JOIN practice.statcan_series_metadata AS m ON m.vector_id = d.series_id
GROUP BY ALL;
```

`dp["refPer"][:10]` keeps just the `YYYY-MM-DD` part, in case the API includes a time.

</details>

### Day 22 checklist
- [ ] I can explain the difference between a source and a resource, with examples
- [ ] I can write a `@dlt.source` that returns several resources sharing arguments
- [ ] I can argue for long vs per-series table designs, and avoid the loop-variable gotcha
- [ ] I can select resources, limit them for development, and use `add_map`/`add_filter`
- [ ] I can chain a resource into a transformer with `|`
- [ ] I load metadata alongside data to get dimension tables automatically

```bash
git add .
git commit -m "Day 22: dlt sources, transformers, StatCan source"
git push
```

---

# DAY 23 — Configuration, Secrets and the `macro_ingest` Package

| Time | Block |
|---|---|
| 0:00 – 0:20 | 23.1 Config vs secrets: what goes where |
| 0:20 – 0:50 | 23.2 Injection: `dlt.config.value` and `dlt.secrets.value` |
| 0:50 – 0:58 | Break |
| 0:58 – 1:20 | 23.3 Secrets in practice: the FRED API key |
| 1:20 – 1:38 | 23.4 Destinations from configuration: dev vs prod |
| 1:38 – 1:45 | Break |
| 1:45 – 2:20 | 23.5 Capstone: the `macro_ingest` package |
| 2:20 – 2:30 | 23.6 Smoke tests · recap |

---

## 23.1 Config vs Secrets (20 min)

> **Question it answers:** Where should settings and secret keys live so they're not hard-coded or committed to Git?
>
> **Other questions you can answer the same way:**
> - Is my secrets file safely ignored by Git?

Your code so far has values **hard-coded** in it: series lists, start dates, file names. That causes three problems:

1. Changing *what* you fetch means editing code.
2. Different environments (your laptop, a server, a colleague's machine) need different settings.
3. Secrets (API keys, passwords) end up in Git.

dlt separates two kinds of settings:

| | **Configuration** | **Secrets** |
|---|---|---|
| Examples | series lists, start dates, log level | API keys, database passwords, tokens |
| File | `.dlt/config.toml` | `.dlt/secrets.toml` |
| In Git? | ✓ yes, it documents your pipeline | ✗ **never** |
| In code | `dlt.config.value` | `dlt.secrets.value` |

Create the folder and both files:

```bash
mkdir -p .dlt
touch .dlt/config.toml .dlt/secrets.toml
git check-ignore .dlt/secrets.toml && echo "✓ secrets.toml is ignored"
```

If the last command prints nothing, fix `.gitignore` (Day 21.1) **before continuing**.

### TOML in two minutes

> **Question it answers:** How do I write settings such as series lists and start dates in a readable config file?
>
> **Other questions you can answer the same way:**
> - How do I change which series are loaded without editing code?

TOML is a simple, readable settings format:

```toml
# comments start with #
[runtime]                    # a section
log_level = "WARNING"        # text in quotes

[sources.boc]                # a nested section: sources → boc
series_ids = ["V39079", "FXCADUSD"]   # a list
start_date = "2006-01-01"

[sources.statcan]
vectors = [41690973, 2062815]         # numbers without quotes
latest_n = 250
```

Sections map naturally to Python dictionaries: `sources → boc → series_ids`.

---

## 23.2 Injection: `dlt.config.value` and `dlt.secrets.value` (30 min)

Instead of passing arguments yourself, you can ask dlt to **inject** them from configuration.

### Example 1 — Required configuration

> **Question it answers:** Which series and start date should the BoC source use, taken from the config file?
>
> **Other questions you can answer the same way:**
> - How do I start the history in 2010 instead of 2006?

Put this in `.dlt/config.toml`:

```toml
[sources.boc]
series_ids = ["V39079", "FXCADUSD", "BD.CDN.2YR.DQ.YLD", "BD.CDN.10YR.DQ.YLD"]
start_date = "2006-01-01"
```

Create `day23/config_demo.py`:

```python
import dlt


@dlt.source(name="boc", section="boc")
def boc_config_demo(series_ids: list = dlt.config.value,
                    start_date: str = dlt.config.value):

    @dlt.resource(name="boc_settings_echo", write_disposition="replace")
    def echo():
        for sid in series_ids:
            yield {"series_id": sid, "start_date": start_date}

    return echo


if __name__ == "__main__":
    source = boc_config_demo()          # no arguments — injected from config.toml
    for row in source.resources["boc_settings_echo"]:
        print(row)
```

```bash
python day23/config_demo.py
```

`dlt.config.value` means *"this argument must be supplied, either by the caller or by configuration"*. Explicit arguments always win: `boc_config_demo(series_ids=["V39079"])` ignores the file for that argument.

`section="boc"` tells dlt to look in `[sources.boc]`. Without it, dlt uses the name of the Python module the source is defined in.

### Example 2 — When a value is missing, read the error

Comment out `start_date` in `config.toml` and run again. The error message lists **every place dlt looked**: environment variables, `secrets.toml`, `config.toml`, from the most specific section to the most general. When configuration "doesn't work", this list tells you exactly what key name dlt expected.

### Example 3 — Environment variables override files

> **Question it answers:** How do I override one setting for a single run without editing any file?
>
> **Other questions you can answer the same way:**
> - How do I run a quick test with only recent data?

Every setting can also come from an environment variable: take the TOML path, join the parts with **double underscores**, and use capitals:

| TOML | Environment variable |
|---|---|
| `[sources.boc] start_date` | `SOURCES__BOC__START_DATE` |
| `[sources.fred] api_key` | `SOURCES__FRED__API_KEY` |
| `[destination.duckdb] credentials` | `DESTINATION__DUCKDB__CREDENTIALS` |
| `[runtime] log_level` | `RUNTIME__LOG_LEVEL` |

```bash
SOURCES__BOC__START_DATE=2025-01-01 python day23/config_demo.py
```

The start date changed without touching any file.

**Lookup priority** (highest first): explicit function arguments → environment variables → `.dlt/secrets.toml` → `.dlt/config.toml` → default values in the function signature.

> This order is what makes pipelines portable. Your committed `config.toml` holds sensible defaults, and each environment overrides just what it needs with environment variables. Schedulers such as Prefect (Days 51–60) and cloud platforms set environment variables, not files.

---

## 23.3 Secrets in Practice: the FRED API Key (23 min)

On Day 9 you may have registered a FRED API key. Now let dlt handle it.

### Store it (choose one)

> **Question it answers:** Where do I put my FRED API key so dlt can find it?
>
> **Other questions you can answer the same way:**
> - How do I give a pipeline a password or token safely?

**Option A — local file** (quick, for your Codespace only). In `.dlt/secrets.toml`:

```toml
[sources.fred]
api_key = "paste-your-key-here"
```

**Option B — Codespaces secret** (recommended). On GitHub: *Settings → Codespaces → Secrets → New secret*, named `SOURCES__FRED__API_KEY`, with access to `macro-data-course`. Restart the Codespace; dlt now finds the key as an environment variable, with no file needed.

### Use it

> **Question it answers:** How do I load FRED data through the official API using a key that never appears in the code?
>
> **Other questions you can answer the same way:**
> - Is my key being picked up correctly?

Create `day23/fred_api_source.py`:

```python
from datetime import date

import dlt
from dlt.sources.helpers import requests

API = "https://api.stlouisfed.org/fred/series/observations"


@dlt.source(name="fred", section="fred")
def fred_api_source(series_ids: list = dlt.config.value,
                    api_key: str = dlt.secrets.value,
                    start_date: str = "2006-01-01"):

    @dlt.resource(name="fred_observations", write_disposition="replace",
                  primary_key=("series_id", "date"),
                  columns={"value": {"data_type": "double"}})
    def observations():
        for sid in series_ids:
            r = requests.get(API, params={
                "series_id": sid, "api_key": api_key, "file_type": "json",
                "observation_start": start_date}, timeout=30)
            r.raise_for_status()
            rows = [{"date": date.fromisoformat(o["date"]), "series_id": sid,
                     "value": float(o["value"]), "source": "fred"}
                    for o in r.json().get("observations", [])
                    if o.get("value") not in (None, "", ".")]
            yield rows

    return observations
```

Add the series list to `config.toml`:

```toml
[sources.fred]
series_ids = ["FEDFUNDS", "DCOILWTICO", "CANLOLITOAASTSAM"]
```

Run it with the practice pipeline and check that it loads.

### Secrets hygiene checklist

- [ ] `secrets.toml` is in `.gitignore`, verified with `git check-ignore`
- [ ] Secrets are never printed, logged or put in URLs you save (Day 9)
- [ ] The key is typed as a secret (`dlt.secrets.value`), so dlt masks it in its own logs and traces
- [ ] If a secret **is** ever committed, **rotate it immediately** (generate a new key and revoke the old one). Deleting the file in a later commit is not enough, because Git history keeps it.

> **Students without a FRED key:** keep using the key-free CSV resource from Day 21. The capstone below uses the CSV endpoint, so everyone can complete it.

---

## 23.4 Destinations from Configuration: Dev vs Prod (18 min)

> **Question it answers:** How do I point the same pipeline at a test database or the real warehouse just by changing configuration?
>
> **Other questions you can answer the same way:**
> - Which database is this run writing to?

So far `destination="duckdb"` wrote to `<pipeline_name>.duckdb`. The **credentials** of a DuckDB destination are simply the path to the database file, and they can come from configuration too.

In `.dlt/secrets.toml` (destination credentials are conventionally treated as secrets, even when they're just a path):

```toml
[destination.duckdb]
credentials = "macro.duckdb"
```

Now any pipeline with `destination="duckdb"` loads into your warehouse. To load somewhere else temporarily, for example a throwaway practice file, override it with an environment variable:

```bash
DESTINATION__DUCKDB__CREDENTIALS=dev_macro.duckdb python ingest.py    # "dev"
python ingest.py                                                      # "prod" = macro.duckdb
```

**The same code runs in both environments; only configuration changes.** On a real team, "prod" might be a cloud warehouse such as MotherDuck, BigQuery or Snowflake. With dlt, switching is a configuration change plus installing the destination's extra (e.g. `pip install "dlt[motherduck]"`).

### Dataset names keep layers apart

> **Question it answers:** How do I keep dlt's tables separate from the tables built by my earlier loader?
>
> **Other questions you can answer the same way:**
> - Which schema holds the dlt data, and which holds the old raw data?

We load dlt output into its own schema, `raw_dlt`, so it can't collide with `raw.*` tables built by `load_warehouse.py`:

```
macro.duckdb
├── raw.*            ← Day 13 loader (Parquet from macro_extract)
├── raw_dlt.*        ← dlt pipelines (from today)
├── seeds.*, staging.*, intermediate.*, marts.*
```

On Days 28–30 the staging models will switch over to `raw_dlt`, and the old path can be retired.

---

## 23.5 Capstone: the `macro_ingest` Package (35 min)

Rebuild Day 10's `macro_extract` as a dlt package, fully driven by configuration.

### Configuration: `.dlt/config.toml`

> **Question it answers:** Which series, start dates and settings does the full ingestion project use?
>
> **Other questions you can answer the same way:**
> - Where do I add a new series to the production pipeline?

```toml
[runtime]
log_level = "WARNING"

[sources.boc]
series_ids = ["V39079", "FXCADUSD", "BD.CDN.2YR.DQ.YLD", "BD.CDN.10YR.DQ.YLD"]
start_date = "2006-01-01"

[sources.fred]
series_ids = ["FEDFUNDS", "DCOILWTICO", "CANLOLITOAASTSAM"]
start_date = "2006-01-01"

[sources.statcan]
vectors = [41690973, 2062815]
latest_n = 250
```

### Package layout

> **Question it answers:** How do I organise the BoC, FRED and StatCan sources as one reusable package?
>
> **Other questions you can answer the same way:**
> - Where does each source's code live?

```bash
mkdir -p macro_ingest
touch macro_ingest/__init__.py
```

**Requirements:**
1. `macro_ingest/boc.py`: `boc_source(series_ids=dlt.config.value, start_date=dlt.config.value)` with resources `boc_observations` and `boc_series_metadata` (Day 22.2), `section="boc"`.
2. `macro_ingest/fred.py`: `fred_source(...)` with `fred_observations` (CSV endpoint, Day 21.7), `section="fred"`.
3. `macro_ingest/statcan.py`: `statcan_source(vectors=..., latest_n=...)` with metadata and data resources (Day 22.6), `section="statcan"`.
4. All observation tables share the columns `date, series_id, value, source` and the primary key `(series_id, date)`.
5. `ingest.py` at the repository root:
   - creates the pipeline `macro_ingest` → `duckdb` → dataset `raw_dlt`;
   - runs each source **separately**, so one failing publisher doesn't stop the others (Day 9's design decision);
   - stores each run's load info in a table `_load_info`;
   - prints a summary and exits `0` (all ok), `2` (partial) or `1` (all failed), as on Day 10.

<details>
<summary>Solution — <code>macro_ingest/boc.py</code></summary>

```python
"""Bank of Canada Valet source."""
from datetime import date

import dlt
from dlt.sources.helpers import requests

BASE = "https://www.bankofcanada.ca/valet"


def _fetch(series_id, start_date):
    r = requests.get(f"{BASE}/observations/{series_id}/json",
                     params={"start_date": start_date}, timeout=30)
    r.raise_for_status()
    return r.json()


@dlt.source(name="boc", section="boc")
def boc_source(series_ids: list = dlt.config.value,
               start_date: str = dlt.config.value):

    @dlt.resource(name="boc_observations", write_disposition="replace",
                  primary_key=("series_id", "date"),
                  columns={"value": {"data_type": "double"}})
    def observations():
        for sid in series_ids:
            rows = []
            for obs in _fetch(sid, start_date).get("observations", []):
                cell = obs.get(sid)
                try:
                    value = float(cell.get("v"))
                except (AttributeError, TypeError, ValueError):
                    continue
                rows.append({"date": date.fromisoformat(obs["d"]), "series_id": sid,
                             "value": value, "source": "boc"})
            yield rows

    @dlt.resource(name="boc_series_metadata", write_disposition="replace",
                  primary_key="series_id")
    def series_metadata():
        for sid in series_ids:
            info = _fetch(sid, date.today().isoformat()).get("seriesDetail", {}).get(sid, {})
            yield {"series_id": sid, "label": info.get("label"),
                   "description": info.get("description")}

    return observations, series_metadata
```

</details>

<details>
<summary>Solution — <code>macro_ingest/fred.py</code></summary>

```python
"""FRED source (graph CSV endpoint, no key required)."""
import csv
import io
from datetime import date

import dlt
from dlt.sources.helpers import requests

URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"


@dlt.source(name="fred", section="fred")
def fred_source(series_ids: list = dlt.config.value,
                start_date: str = dlt.config.value):

    @dlt.resource(name="fred_observations", write_disposition="replace",
                  primary_key=("series_id", "date"),
                  columns={"value": {"data_type": "double"}})
    def observations():
        start = date.fromisoformat(start_date)
        for sid in series_ids:
            r = requests.get(URL, params={"id": sid}, timeout=30)
            r.raise_for_status()
            reader = csv.reader(io.StringIO(r.text))
            next(reader)
            rows = []
            for line in reader:
                if len(line) < 2 or line[1] in ("", "."):
                    continue
                d = date.fromisoformat(line[0])
                if d >= start:
                    rows.append({"date": d, "series_id": sid,
                                 "value": float(line[1]), "source": "fred"})
            yield rows

    return observations
```

</details>

<details>
<summary>Solution — <code>macro_ingest/statcan.py</code></summary>

```python
"""Statistics Canada WDS vector source."""
from datetime import date

import dlt
from dlt.sources.helpers import requests

WDS = "https://www150.statcan.gc.ca/t1/wds/rest"


@dlt.source(name="statcan", section="statcan")
def statcan_source(vectors: list = dlt.config.value,
                   latest_n: int = dlt.config.value):

    @dlt.resource(name="statcan_series_metadata", write_disposition="replace",
                  primary_key="vector_id")
    def series_metadata():
        r = requests.post(f"{WDS}/getSeriesInfoFromVector",
                          json=[{"vectorId": v} for v in vectors], timeout=30)
        r.raise_for_status()
        for item in r.json():
            if item.get("status") == "SUCCESS":
                obj = item["object"]
                yield {"vector_id": f"v{obj['vectorId']}",
                       "product_id": obj.get("productId"),
                       "title": obj.get("SeriesTitleEn"),
                       "frequency_code": obj.get("frequencyCode")}

    @dlt.resource(name="statcan_observations", write_disposition="replace",
                  primary_key=("series_id", "date"),
                  columns={"value": {"data_type": "double"}})
    def observations():
        body = [{"vectorId": v, "latestN": latest_n} for v in vectors]
        r = requests.post(f"{WDS}/getDataFromVectorsAndLatestNPeriods",
                          json=body, timeout=60)
        r.raise_for_status()
        for item in r.json():
            if item.get("status") != "SUCCESS":
                continue
            obj = item["object"]
            sid = f"v{obj['vectorId']}"
            yield [{"date": date.fromisoformat(dp["refPer"][:10]), "series_id": sid,
                    "value": float(dp["value"]), "source": "statcan"}
                   for dp in obj.get("vectorDataPoint", [])
                   if dp.get("value") is not None]

    return series_metadata, observations
```

</details>

<details>
<summary>Solution — <code>ingest.py</code></summary>

```python
"""ingest.py — load all macro sources into DuckDB with dlt.

Destination file comes from .dlt/secrets.toml ([destination.duckdb] credentials)
or the DESTINATION__DUCKDB__CREDENTIALS environment variable.

Usage:  python ingest.py
"""
import sys

import dlt

from macro_ingest.boc import boc_source
from macro_ingest.fred import fred_source
from macro_ingest.statcan import statcan_source

SOURCES = {"boc": boc_source, "fred": fred_source, "statcan": statcan_source}


def main():
    pipeline = dlt.pipeline(pipeline_name="macro_ingest",
                            destination="duckdb",
                            dataset_name="raw_dlt")
    ok, failed = [], []

    for name, make_source in SOURCES.items():
        try:
            info = pipeline.run(make_source())       # config injected here
            info.raise_on_failed_jobs()
            pipeline.run([info], table_name="_load_info")
            ok.append(name)
            print(f"✓ {name}")
        except Exception as e:
            failed.append(name)
            print(f"✗ {name}: {e}")

    print(f"\n{len(ok)} source(s) loaded, {len(failed)} failed {failed}")
    if not ok:
        sys.exit(1)
    if failed:
        sys.exit(2)


if __name__ == "__main__":
    main()
```

`pipeline.run([info], table_name="_load_info")` loads the run's own metadata as data: a permanent, queryable history of every ingestion. `raise_on_failed_jobs()` turns silent partial failures into errors you'll notice.

</details>

### Run it and compare with the old pipeline

> **Question it answers:** Does the new dlt pipeline load the same series, dates and values as the old one?
>
> **Other questions you can answer the same way:**
> - Are the row counts and latest dates identical?

```bash
python ingest.py
duckdb macro.duckdb -readonly
```

```sql
.tables

-- Parity check: dlt vs the Day 10 pipeline, per series
WITH new AS (
    SELECT series_id, COUNT(*) AS n_dlt, MAX(date) AS latest_dlt
    FROM (SELECT * FROM raw_dlt.boc_observations
          UNION ALL BY NAME SELECT * FROM raw_dlt.fred_observations
          UNION ALL BY NAME SELECT * FROM raw_dlt.statcan_observations)
    GROUP BY series_id
),
old AS (
    SELECT series_id, COUNT(*) AS n_old, CAST(MAX(date) AS DATE) AS latest_old
    FROM raw.observations
    GROUP BY series_id
)
SELECT COALESCE(new.series_id, old.series_id) AS series_id,
       n_old, n_dlt, latest_old, latest_dlt
FROM new FULL OUTER JOIN old USING (series_id)
ORDER BY series_id;
```

Small differences are expected: data published between the two runs, or different start dates for StatCan vectors. Large differences mean a bug in one of the two paths. Investigate before moving on.

---

## 23.6 Smoke Tests · Recap (10 min)

> **Question it answers:** Does the whole ingestion machinery work end to end, using tiny loads into a throwaway database?
>
> **Other questions you can answer the same way:**
> - Did today's code change break any source?

A **smoke test** is a quick run that checks the machinery works end to end without doing all the work. Combine three things you learned: `add_limit`, a throwaway destination, and a small config override.

Create `day23/smoke_test.py`:

```python
"""Fast end-to-end check: tiny loads into a throwaway DuckDB file."""
import os

import dlt

from macro_ingest.boc import boc_source
from macro_ingest.fred import fred_source
from macro_ingest.statcan import statcan_source

os.environ["DESTINATION__DUCKDB__CREDENTIALS"] = "smoke_test.duckdb"

pipeline = dlt.pipeline(pipeline_name="macro_smoke", destination="duckdb",
                        dataset_name="smoke", dev_mode=True)

for source in (boc_source(start_date="2026-01-01"),
               fred_source(start_date="2026-01-01"),
               statcan_source(latest_n=3)):
    info = pipeline.run(source.add_limit(1))
    info.raise_on_failed_jobs()
    print(f"✓ {source.name}")

print("Smoke test passed.")
```

```bash
python day23/smoke_test.py && rm -f smoke_test.duckdb
```

- Explicit arguments (`start_date=...`) override `config.toml` for this run only.
- `dev_mode=True` gives every run a fresh, uniquely named dataset, which is ideal for experiments that shouldn't interfere with each other.

Run this before `ingest.py` whenever you change the package: it takes seconds instead of minutes.

### Recap

| Day 10 (`macro_extract`) | Day 23 (`macro_ingest` with dlt) |
|---|---|
| `net.py` retry session | `dlt.sources.helpers.requests` |
| `schema.py` standardize + validate | inferred schema, column hints, primary keys |
| `rawstore.py` landing zone | load packages + `_dlt_loads` + `_load_info` |
| `catalog.py` in Python | `.dlt/config.toml`, overridable by env vars |
| env-var API key read manually | `dlt.secrets.value`, masked, with clear lookup rules |
| Parquet → `load_warehouse.py` → DuckDB | direct load into `macro.duckdb`, dataset `raw_dlt` |
| full re-download every run | *(still!)*, fixed on Days 24–27 with incremental loading |

### Looking ahead: Days 24–27

- **Schema evolution:** what happens when an API adds, renames or changes a field, and how to control it with schema contracts.
- **Flattening nested JSON:** loading raw Valet and WDS responses as-is and letting dlt create parent/child tables.
- **Incremental loading:** fetching only new observations with `dlt.sources.incremental`, and using `merge` to absorb StatCan revisions.

### Day 23 checklist
- [ ] I know what belongs in `config.toml` vs `secrets.toml`, and my secrets file is ignored by Git
- [ ] I can inject settings with `dlt.config.value` and `dlt.secrets.value`, and read dlt's lookup errors
- [ ] I can override any setting with a correctly named environment variable
- [ ] I can point the same pipeline at different DuckDB files (dev vs prod) through configuration
- [ ] My `macro_ingest` package loads BoC, FRED and StatCan into `macro.duckdb` with one command
- [ ] I verified parity with the Day 10 pipeline and have a fast smoke test

```bash
git add .
git status                         # .dlt/secrets.toml must NOT appear
git commit -m "Day 23: dlt config & secrets, macro_ingest package"
git push
```
