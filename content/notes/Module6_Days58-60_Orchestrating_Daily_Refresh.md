# Module 6 · Pipeline Orchestration with Prefect
## Days 58–60: Orchestrating the Daily Refresh of the Macro Dashboard Pipeline — dlt → DuckDB → dbt → Great Expectations → Dashboards

**Audience:** MSc Economics students who completed Days 1–57
**Environment:** GitHub Codespaces · `.venv` (Prefect, dlt, dbt) · `.venv-gx` · Prefect server + `local-process` worker · `macro.duckdb`
**Time per day:** ~2.5 hours (including breaks and exercises)
**Goal by end of Day 60:** The macro dashboard pipeline from the course notebook is fully automated and production-ready:
- **dlt** extraction runs as first-class Prefect tasks, with per-source retries.
- **Statistics Canada releases** trigger Write–Audit–Publish within minutes of publication.
- **dbt** rebuilds only what the new data affects, with model-level results in the UI.
- **Great Expectations** gates publication.
- The notebook's dashboards are regenerated as HTML, with "as of" dates and data-quality banners.

The platform also passes a **production-readiness review**, including backup and restore drills.

---

### Where we are

After Day 57, `daily-refresh` runs on schedules with retries, caching, fingerprints, concurrency limits, run history and a watchdog. But each tool is still a **black box** to Prefect:

| Today | Limitation | Fixed on |
|---|---|---|
| `ingest.py` runs all sources as one subprocess | one flaky source retries everything; no per-source visibility | **Day 58** |
| `dbt build` is one subprocess | no model-level results in the UI; always rebuilds everything | **Day 58** |
| StatCan releases are caught at the next schedule | dashboards lag releases by hours | **Day 59** |
| the DuckDB lock only protects writers from each other | a GX reader can still collide with a writer | **Day 59** |
| dashboards are built by hand in the notebook | the last mile isn't automated | **Day 60** |
| no tested backups; no staging environment | an accident could lose irreplaceable history | **Day 60** |

### The final architecture

```
                         ┌─────────────────────── Prefect ───────────────────────┐
schedules (09:15/17:30)  │ daily-refresh                                         │
release watcher (10 min) │   extract_load ── ingest_source(boc|fred|statcan) ×3  │  dlt → raw_dlt
        │                │   statcan_release ── WRITE → AUDIT(GX) → PUBLISH      │  raw_incoming → raw_dlt
        └─ event ───────►│   transform ── dbt build --select <what changed>+     │  dbt → staging/marts
                         │   quality ── GX warehouse checkpoints                 │  GX → Data Docs
                         │   publish ── dashboards (HTML) + briefings + history  │  site/*.html
                         └───────────────────────────────────────────────────────┘
```

### Target structure (by end of Day 60)

```
macro-data-course/
├── macro_ingest/
│   ├── runner.py              ← NEW: run_source() — ingest.py logic as a library
│   └── wap.py                 ← NEW: Write–Audit–Publish steps as functions
├── orchestration/
│   ├── settings.py            ← + environments (dev/prod), DuckDB access slots
│   ├── tasks/
│   │   ├── locks.py           ← NEW: readers–writer access to DuckDB
│   │   ├── ingest.py          ← NEW: per-source dlt tasks
│   │   ├── dbt.py             ← NEW: dbtRunner task with model-level results
│   │   ├── wap.py             ← NEW: WAP tasks
│   │   └── …                  (commands, fingerprints, history, reporting)
│   └── flows/
│       ├── daily_refresh.py   ← v4: the complete pipeline
│       ├── statcan_release.py ← NEW: event-driven WAP + targeted refresh
│       ├── release_watcher.py ← NEW
│       └── backup.py          ← NEW
├── dashboards/
│   └── build_dashboards.py    ← NEW: the notebook's dashboards as code
├── site/                      ← generated dashboards (not committed)
├── backups/                   ← database exports (not committed)
└── PRODUCTION_READINESS.md    ← NEW
```

---

# DAY 58 — From Black Boxes to First-Class Tasks

| Time | Block |
|---|---|
| 0:00 – 0:20 | 58.1 Which steps deserve deeper integration? |
| 0:20 – 0:45 | 58.2 Refactoring ingestion into a library |
| 0:45 – 0:53 | Break |
| 0:53 – 1:18 | 58.3 Per-source dlt tasks with exception-aware retries |
| 1:18 – 1:43 | 58.4 dbt in-process: `dbtRunner` with model-level results |
| 1:43 – 1:50 | Break |
| 1:50 – 2:15 | 58.5 Targeted rebuilds: run dbt only downstream of what changed |
| 2:15 – 2:30 | 58.6 Mini-project: extract_load and transform v2 |

---

## 58.1 Which Steps Deserve Deeper Integration? (20 min)

On Day 52 we wrapped every tool as a subprocess: simple and robust. Now, with the platform stable, we can ask for each step whether **finer control is worth the coupling**.

| Step | Integration | Why |
|---|---|---|
| dlt ingestion | **in-process, one task per source** | per-source retries and visibility; dlt is a Python library in the same environment |
| WAP (StatCan tables) | **in-process tasks per stage and table**; GX audit stays a subprocess | per-table audit outcomes; GX lives in `.venv-gx` (Day 42) |
| dbt | **in-process via `dbtRunner`** | model-level results, targeted selection, log forwarding |
| GX warehouse checks | **subprocess** (unchanged) | separate environment; already reports exit codes and history |
| dashboards | **in-process** | plain Python reading Parquet files |

> **Cost of in-process integration:** steps now share one Python process, so they also share **DuckDB connections**. Two DuckDB connections with different settings to the same file can't coexist in one process. That means in-process steps must run **one after another** and **close** their connections. Our flows are sequential at the writer level anyway (Day 57), and dlt and dbt close their connections when done. Keep it that way.

---

## 58.2 Refactoring Ingestion into a Library (25 min)

`ingest.py` (Day 30) mixes **logic** (run a source, collect errors) with a **command-line interface** (flags, exit codes). Prefect needs the logic as importable functions. The classic refactor: **move logic into a module and keep the script as a thin wrapper**.

Create `macro_ingest/runner.py`:

```python
"""Ingestion logic as a library: used by ingest.py (CLI) and Prefect tasks."""
import time
from datetime import datetime, timezone

import dlt

from macro_ingest.boc import boc_source
from macro_ingest.fred import fred_source
from macro_ingest.resilience import ErrorLog
from macro_ingest.statcan import statcan_source

SOURCES = {"boc": boc_source, "fred": fred_source, "statcan": statcan_source}


def make_pipeline():
    return dlt.pipeline(pipeline_name="macro_ingest", destination="duckdb",
                        dataset_name="raw_dlt", export_schema_path="schemas/export")


def run_source(name: str, full_refresh: bool = False) -> dict:
    """Load one source into raw_dlt. Raises on failure; returns a summary on success."""
    started = datetime.now(timezone.utc)
    t0 = time.perf_counter()
    errors = ErrorLog()
    pipeline = make_pipeline()

    info = pipeline.run(SOURCES[name](error_log=errors),
                        refresh="drop_resources" if full_refresh else None)
    info.raise_on_failed_jobs()
    if errors.records:
        pipeline.run(errors.records, table_name="extraction_errors", write_disposition="append")

    summary = {"source": name, "status": "warning" if errors.records else "ok",
               "series_errors": len(errors), "duration_s": round(time.perf_counter() - t0, 1),
               "run_started_at": started, "message": None}
    pipeline.run([summary], table_name="ingest_runs", write_disposition="append")
    summary["error_examples"] = [f"{e['series_id']}: {e['message'][:80]}" for e in errors.records[:5]]
    return summary
```

Then rewrite `ingest.py`'s `main()` to loop over sources and call `run_source`, keeping its flags and exit codes (0 / 2 / 1). The CLI behaves exactly as before. Verify:

```bash
python ingest.py --only boc; echo "exit: $?"
python -m pytest -q                      # Day 10 + Day 29 tests still pass
```

> This "library + thin CLI" shape is worth applying to every script you write: it makes code testable, schedulable and reusable without duplication.

---

## 58.3 Per-Source dlt Tasks with Exception-Aware Retries (25 min)

Now each source becomes its own task, so FRED being down retries **FRED only**.

### Which exceptions are transient?

In-process, failures arrive as **exceptions**, not exit codes. dlt wraps underlying errors (e.g. a `PipelineStepFailed` around a `ConnectionError`), so we inspect the **whole exception chain**:

Create `orchestration/tasks/ingest.py`:

```python
"""Per-source dlt ingestion as Prefect tasks."""
from prefect import get_run_logger, task

from macro_ingest.runner import run_source
from orchestration.tasks.locks import duckdb_access

TRANSIENT = {"ConnectionError", "Timeout", "ReadTimeout", "ConnectTimeout",
             "ChunkedEncodingError", "CircuitOpen", "TransientStepError"}
NEVER_RETRY = {"DataValidationError"}                     # schema contract violations (Day 25)


def exception_chain(exc):
    """The exception and everything it was raised from (__cause__ / __context__)."""
    chain, e = [], exc
    while e is not None and e not in chain:
        chain.append(e)
        e = e.__cause__ or e.__context__
    return chain


def is_transient(exc) -> bool:
    names = {type(e).__name__ for e in exception_chain(exc)}
    if names & NEVER_RETRY:
        return False
    return bool(names & TRANSIENT)


def retry_if_transient_exception(task, task_run, state) -> bool:
    try:
        state.result()
    except Exception as e:
        return is_transient(e)
    return False


@task(retries=2, retry_delay_seconds=[300, 600], retry_jitter_factor=0.2,
      retry_condition_fn=retry_if_transient_exception, timeout_seconds=1800)
def ingest_source(name: str, full_refresh: bool = False) -> dict:
    logger = get_run_logger()
    with duckdb_access(write=True):
        summary = run_source(name, full_refresh)
    logger.info(f"{name}: {summary['status']} — {summary['series_errors']} series error(s), "
                f"{summary['duration_s']}s")
    for ex in summary.get("error_examples", []):
        logger.warning(f"{name} series error: {ex}")
    return summary
```

- **`exception_chain`** follows `__cause__` (set by `raise X from Y`) and `__context__` (set when an exception occurs while handling another). Wrapped network errors are still recognised.
- **Contract violations are never retried**, even if a network error appears elsewhere in the chain. A changed API shape won't fix itself in ten minutes.
- `duckdb_access(write=True)` is the lock helper you'll write on Day 59 (59.2). For today, create `orchestration/tasks/locks.py` with Day 57's simple version:

```python
from contextlib import contextmanager

from prefect.concurrency.sync import concurrency


@contextmanager
def duckdb_access(write: bool):
    with concurrency("duckdb-writer", occupy=1) if write else _noop():
        yield


@contextmanager
def _noop():
    yield
```

### The extract_load subflow

```python
from prefect import flow


@flow(name="extract-load")
def extract_load_flow(sources: list[str] = ("boc", "fred", "statcan"),
                      full_refresh: bool = False) -> dict:
    return {f"ingest_{s}": ingest_source.with_options(name=f"ingest:{s}")(
                s, full_refresh, return_state=True)
            for s in sources}
```

Sources run **sequentially**: each needs the writer slot. The gain isn't speed but **isolation**: separate retries, timeouts, states and logs per provider.

### Try it 58.3

Write three small unit tests for `is_transient` in `tests/test_orchestration.py` (run them with `python -m pytest`): a plain `requests.ConnectionError` → `True`; a `RuntimeError` raised *from* a `ConnectionError` → `True`; a `RuntimeError` raised from a class you name `DataValidationError` → `False`.

<details>
<summary>Solution</summary>

```python
import requests

from orchestration.tasks.ingest import is_transient


class DataValidationError(Exception):
    pass


def test_plain_connection_error():
    assert is_transient(requests.ConnectionError("down"))


def test_wrapped_connection_error():
    try:
        try:
            raise requests.ConnectionError("down")
        except requests.ConnectionError as e:
            raise RuntimeError("pipeline step failed") from e
    except RuntimeError as wrapped:
        assert is_transient(wrapped)


def test_contract_violation_never_retried():
    try:
        try:
            raise DataValidationError("column frozen")
        except DataValidationError as e:
            raise RuntimeError("normalize failed") from e
    except RuntimeError as wrapped:
        assert not is_transient(wrapped)
```

Matching on class **names** keeps the module independent of exact import paths in dlt, which differ between versions. The test proves the behaviour regardless.

</details>

---

## 58.4 dbt In-Process: `dbtRunner` with Model-Level Results (25 min)

dbt can be invoked from Python with **`dbtRunner`**. Unlike a subprocess, it returns **structured results**: every model, test, seed and snapshot with its status, timing and message. It also accepts **callbacks** that receive dbt's log events, which we forward to Prefect with the right level.

Create `orchestration/tasks/dbt.py`:

```python
"""dbt as a first-class Prefect task (in-process dbtRunner)."""
import os
from contextlib import chdir

from dbt.cli.main import dbtRunner
from prefect import get_run_logger, task
from prefect.artifacts import create_table_artifact

from orchestration.settings import DBT_DIR
from orchestration.tasks.locks import duckdb_access


@task(timeout_seconds=1800)
def dbt_invoke(args: list[str], writes: bool = True) -> dict:
    """Run a dbt command in-process; forward logs; return node-level results."""
    logger = get_run_logger()

    def forward(event):
        level, msg = event.info.level, event.info.msg
        if level == "error":
            logger.error(msg)
        elif level == "warn":
            logger.warning(msg)
        elif level == "info":
            logger.info(msg)

    with duckdb_access(write=writes), chdir(DBT_DIR):
        res = dbtRunner(callbacks=[forward]).invoke(args)

    nodes = []
    for r in getattr(res.result, "results", None) or []:
        nodes.append({
            "node": r.node.name,
            "type": str(r.node.resource_type),
            "status": str(r.status),
            "seconds": round(r.execution_time or 0, 2),
            "message": (r.message or "")[:150],
        })
    problems = [n for n in nodes if n["status"] not in ("success", "pass", "RunStatus.Success",
                                                        "TestStatus.Pass")]
    if nodes:
        create_table_artifact(key="dbt-node-results", table=nodes,
                              description=f"dbt {' '.join(args)}")
    for p in problems:
        logger.warning(f"dbt {p['type']} {p['node']}: {p['status']} — {p['message']}")

    if not res.success:
        raise RuntimeError(f"dbt {' '.join(args)} failed: "
                           f"{len(problems)} problem node(s); {res.exception or ''}")
    return {"success": True, "nodes": len(nodes), "problems": len(problems)}
```

Notes:
- **`chdir(DBT_DIR)`** (Python 3.11+) runs dbt **from the project folder**, exactly as on the command line, so relative paths in `profiles.yml` (`../macro.duckdb`) and in the export post-hook (`../data/marts`) still resolve correctly. It restores the previous directory afterwards.
- The **`dbt-node-results`** artifact gives one row per model and test, so "which test failed last night?" is answered in the UI.
- Status strings differ slightly between dbt versions, which is why the `problems` filter accepts several spellings. Print `nodes` once to see yours.

Use it:

```python
dbt_invoke.with_options(name="dbt:deps")(["deps", "--quiet"], writes=False)
dbt_invoke.with_options(name="dbt:build")(["build", "--target", "prod"])
dbt_invoke.with_options(name="dbt:docs")(["docs", "generate", "--target", "prod"], writes=False)
```

---

## 58.5 Targeted Rebuilds: Run dbt Only Downstream of What Changed (25 min)

Day 55's fingerprint was **all-or-nothing**: any change triggered a full `dbt build`. But if only the **LFS** table was republished, there's no need to rebuild CPI, GDP or open-economy models. dbt's **graph selectors** (Day 31) can express exactly "everything downstream of this source":

```bash
dbt build --select source:statcan.lfs_full+
```

### Per-source fingerprints

Extend `orchestration/tasks/fingerprints.py` so the fingerprint is a **dictionary per dbt source**:

```python
SOURCE_QUERIES = {
    "source:boc.observations+":
        "select bit_xor(hash(series_id, date, value)) from raw_dlt.boc_observations",
    "source:fred.observations+":
        "select bit_xor(hash(series_id, date, value)) from raw_dlt.fred_observations",
    "source:statcan.observations+":
        "select bit_xor(hash(series_id, date, value)) from raw_dlt.statcan_observations",
    "source:statcan.cpi_full+":
        "select max(release_time)::varchar from raw_dlt.statcan_releases where product_id = '18100004'",
    "source:statcan.gdp_full+":
        "select max(release_time)::varchar from raw_dlt.statcan_releases where product_id = '36100104'",
    "source:statcan.lfs_full+":
        "select max(release_time)::varchar from raw_dlt.statcan_releases where product_id = '14100287'",
}


@task(cache_policy=None)
def source_fingerprints() -> dict:
    """{dbt selector: content/release fingerprint} plus the dbt code fingerprint."""
    fps = {}
    with duckdb_access(write=False):
        with duckdb.connect(ENV["MACRO_DUCKDB_PATH"], read_only=True) as con:
            for selector, sql in SOURCE_QUERIES.items():
                fps[selector] = str(con.sql(sql).fetchone()[0])
    fps["__code__"] = code_fingerprint()        # commit + uncommitted diff of macro_dbt (Day 55)
    return fps
```

(Move the Git part of Day 55's `warehouse_fingerprint` into a small `code_fingerprint()` helper.)

### Deciding the selection

```python
def plan_dbt_selection(current: dict, last: dict | None, force: bool) -> list[str] | None:
    """None = skip dbt; [] = full build; otherwise the list of selectors to build."""
    if force or not last or current.get("__code__") != last.get("__code__"):
        return []                                         # code changed (or first run): full build
    changed = [sel for sel, fp in current.items()
               if sel != "__code__" and fp != last.get(sel)]
    return changed or None
```

| Situation | Selection |
|---|---|
| first run, forced run, or dbt code / seeds changed | full `dbt build` |
| only LFS republished | `--select source:statcan.lfs_full+` |
| BoC and FRED have new values | `--select source:boc.observations+ source:fred.observations+` |
| nothing changed | skip dbt |

> **Why do code changes force a full build?** A changed macro (Day 35) can affect any model. Rather than try to compute precisely which models a code change affects, play it safe. dbt's `state:modified` selector can do that precisely in CI setups, but it needs saved artifacts from the previous build. That's worth exploring later.

### Try it 58.5

With `dbt ls --select source:statcan.lfs_full+ --resource-type model`, list what a new LFS release rebuilds. Does it include `macro_monthly`? Should it? Check your lineage graph (Day 40) and explain.

<details>
<summary>Answer</summary>

It includes `stg_statcan__lfs`, `int_lfs__headline` and `lfs_provincial_monthly` (Day 50), plus anything downstream such as `macro_kpis` if you added a labour KPI. It does **not** include `macro_monthly` unless that mart reads LFS models, because the monthly unemployment rate there comes from the **vector** series (Day 10). That's a design observation: two paths to "unemployment" exist, and the Day 49 cross-source check (L30) keeps them consistent.

</details>

---

## 58.6 Mini-Project: extract_load and transform v2 (15 min)

Assemble the new transform subflow:

```python
from prefect import flow, get_run_logger
from prefect.states import Completed
from prefect.variables import Variable

from orchestration.tasks.dbt import dbt_invoke
from orchestration.tasks.fingerprints import plan_dbt_selection, source_fingerprints


@flow(name="transform")
def transform_flow(target: str = "prod", force: bool = False) -> dict:
    logger = get_run_logger()
    var_name = f"dbt_last_fingerprints_{target}"
    current = source_fingerprints()
    selection = plan_dbt_selection(current, Variable.get(var_name, default=None), force)

    if selection is None:
        logger.info("No dbt inputs changed — skipping dbt")
        return {"dbt_build": Completed(name="Skipped", message="inputs unchanged")}

    select_args = ["--select", *selection] if selection else []
    logger.info(f"dbt build {'(full)' if not selection else ' '.join(selection)}")
    states = {
        "dbt_deps": dbt_invoke.with_options(name="dbt:deps")(["deps", "--quiet"], writes=False,
                                                              return_state=True)}
    states["dbt_build"] = dbt_invoke.with_options(name="dbt:build")(
        ["build", "--target", target, *select_args], return_state=True)
    if states["dbt_build"].is_completed():
        Variable.set(var_name, current, overwrite=True)          # markers after success
        states["dbt_docs"] = dbt_invoke.with_options(name="dbt:docs")(
            ["docs", "generate", "--target", target], writes=False, return_state=True)
    return states
```

Note the Variable name now includes the **target**, so dev and prod fingerprints never mix (Day 60 uses this).

Swap `extract_load_flow` and `transform_flow` into `daily_refresh` (keeping Day 53's `outcome()` policy logic and Day 57's history and hooks). Run it twice and compare the UI: per-source ingestion tasks, a `dbt-node-results` artifact, and on the second run a **Skipped** or targeted dbt build.

### Day 58 checklist
- [ ] I can decide which steps to integrate in-process and which to keep as subprocesses, and I know the DuckDB-connection cost
- [ ] Ingestion logic is a library (`runner.py`); `ingest.py` is a thin CLI over it
- [ ] Each source is its own task, with retries only for transient exception chains
- [ ] dbt runs in-process with forwarded logs and a node-level results artifact
- [ ] dbt rebuilds only downstream of sources whose content or release changed; code changes force a full build

```bash
python -m pytest -q
git add . && git commit -m "Day 58: per-source dlt tasks, dbtRunner, targeted dbt selection" && git push
```

---

# DAY 59 — Event-Driven Orchestration: Reacting to StatCan Releases

| Time | Block |
|---|---|
| 0:00 – 0:18 | 59.1 Schedules vs events |
| 0:18 – 0:40 | 59.2 Fixing the lock: readers *and* writers |
| 0:40 – 0:48 | Break |
| 0:48 – 1:20 | 59.3 Write–Audit–Publish as a flow |
| 1:20 – 1:43 | 59.4 The release watcher: events, triggers, idempotency |
| 1:43 – 1:50 | Break |
| 1:50 – 2:10 | 59.5 Release briefings: telling economists what changed |
| 2:10 – 2:30 | 59.6 Mini-project: simulate a release, end to end |

---

## 59.1 Schedules vs Events (18 min)

| Schedule-driven | Event-driven |
|---|---|
| "run at 09:15 and check for news" | "run **when** news arrives" |
| simple, predictable | timely, efficient |
| lag between release and dashboard can be hours | lag of minutes |
| runs even when nothing happened | runs only when something happened |

StatCan publishes at **08:30 ET** on release days, but which days isn't fixed in our schedules (CPI, LFS and GDP each have their own calendars). A **watcher** that polls StatCan's metadata every few minutes during the release window, and starts WAP as soon as something changes, combines the best of both: cheap checks, prompt reactions.

Prefect supports this pattern in two complementary ways:
1. **Events.** Your code emits named events (e.g. `statcan.table.republished`). They appear in the UI's event feed and can trigger deployments via **automations**.
2. **Direct triggering.** A flow calls `run_deployment(...)` for another deployment (Day 56).

We'll do both: direct triggering for guaranteed behaviour, and events for observability (with an optional automation).

---

## 59.2 Fixing the Lock: Readers *and* Writers (23 min)

On Day 57 we serialised **writers** with `duckdb-writer`. But DuckDB's rule across processes is stricter:

> **A database file can be opened either by one read-write process, or by any number of read-only processes, but not both at once.**

So a GX audit (a read-only process) starting while dlt is writing will fail to open the file. We need a **readers–writer lock**: many readers *or* one writer.

Prefect's global concurrency limits make this neat with **`occupy`**: give the limit N slots; readers occupy **1** slot, writers occupy **all N**.

```bash
prefect gcl create duckdb --limit 10
```

Replace `orchestration/tasks/locks.py`:

```python
"""Readers–writer access to macro.duckdb, enforced across all Prefect runs."""
from contextlib import contextmanager

from prefect.concurrency.sync import concurrency

DUCKDB_LIMIT = "duckdb"
DUCKDB_SLOTS = 10          # must equal the limit created with `prefect gcl create duckdb --limit 10`


@contextmanager
def duckdb_access(write: bool):
    """Writers take all slots (exclusive); readers take one (shared, up to 10 at once)."""
    with concurrency(DUCKDB_LIMIT, occupy=DUCKDB_SLOTS if write else 1):
        yield
```

| Holder | Slots | Can run alongside |
|---|---|---|
| writer (dlt load, WAP publish, dbt build) | 10 of 10 | nobody |
| reader (GX audit, fingerprint, briefing, backup) | 1 of 10 | other readers |

Apply it consistently:
- **writers:** `ingest_source`, WAP write and publish, `dbt_invoke(writes=True)`;
- **readers:** GX audits and warehouse checks (wrap the subprocess call), fingerprints, briefings, backups.

Delete the old limit (`prefect gcl delete duckdb-writer`) once nothing uses it.

> **Starvation note:** with this scheme a long stream of readers could delay a waiting writer. Our readers are short and infrequent, so it isn't a problem in practice. But it's the classic trade-off of readers–writer locks, worth knowing.

---

## 59.3 Write–Audit–Publish as a Flow (33 min)

Day 50's `ingest_statcan_tables.py` performs WAP in one script. As a flow, each **stage and table** becomes visible, retryable where appropriate, and lockable correctly.

### Library first

Move the functions from `ingest_statcan_tables.py` into `macro_ingest/wap.py`: `published_release_times()`, `write_incoming(changed)`, `audit(table)`, `publish(con, table)`, `quarantine(con, table, stamp)`, `record_published(current, product_ids)`. Keep the script as a thin CLI over them (the 58.2 pattern).

### Tasks

Create `orchestration/tasks/wap.py`:

```python
"""Write–Audit–Publish steps as Prefect tasks with correct DuckDB access."""
import subprocess
from datetime import datetime, timezone

import duckdb
from prefect import get_run_logger, task

from macro_ingest import wap
from macro_ingest.statcan_tables import current_release_times
from orchestration.settings import ENV, GX_PY, REPO
from orchestration.tasks.ingest import retry_if_transient_exception
from orchestration.tasks.locks import duckdb_access


@task(retries=2, retry_delay_seconds=60)
def detect_changes(tables: dict, force: bool = False) -> tuple[dict, dict]:
    current = current_release_times(tables.keys())
    with duckdb_access(write=False):
        published = wap.published_release_times()
    changed = {pid: name for pid, name in tables.items()
               if force or current.get(pid) != published.get(pid)}
    get_run_logger().info(f"changed tables: {changed or 'none'}")
    return changed, current


@task(retries=1, retry_delay_seconds=900, retry_condition_fn=retry_if_transient_exception,
      timeout_seconds=3600)
def write_table(pid: str, table: str):
    with duckdb_access(write=True):
        wap.write_incoming({pid: table})


@task(timeout_seconds=1800)
def audit_table(table: str) -> int:
    """GX in its own environment and process; read-only access."""
    with duckdb_access(write=False):
        proc = subprocess.run([GX_PY, "quality/validate_incoming.py", table],
                              cwd=REPO, env=ENV, capture_output=True, text=True)
    logger = get_run_logger()
    for line in proc.stdout.splitlines():
        (logger.error if "✗" in line else logger.info)(f"[audit:{table}] {line}")
    return proc.returncode                          # 0 pass · 1 critical · 2 warnings


@task
def publish_or_quarantine(pid: str, table: str, verdict: int) -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    with duckdb_access(write=True):
        with duckdb.connect(ENV["MACRO_DUCKDB_PATH"]) as con:
            if verdict in (0, 2):
                wap.publish(con, table)
                return "published_with_warnings" if verdict == 2 else "published"
            wap.quarantine(con, table, stamp)
            return "quarantined"


@task
def record_markers(current: dict, published_pids: list[str]):
    if published_pids:
        with duckdb_access(write=True):
            wap.record_published(current, published_pids)
```

### The flow

Create `orchestration/flows/statcan_release.py`:

```python
"""Event-driven WAP: audit and publish StatCan tables, then refresh what depends on them."""
import dlt
from prefect import flow, get_run_logger
from prefect.events import emit_event
from prefect.states import Completed, Failed

from orchestration.flows.daily_refresh import quality_flow, publish_flow   # Day 60 adds publish_flow
from orchestration.tasks.wap import (audit_table, detect_changes, publish_or_quarantine,
                                     record_markers, write_table)


@flow(name="statcan-release")
def statcan_release(product_ids: list[str] | None = None, force: bool = False,
                    target: str = "prod"):
    logger = get_run_logger()
    tables = dlt.config["sources.statcan_tables.tables"]
    if product_ids:
        tables = {pid: t for pid, t in tables.items() if pid in product_ids}

    changed, current = detect_changes(tables, force)
    if not changed:
        return Completed(name="NothingToDo", message="no republished tables")

    outcomes = {}
    for pid, table in changed.items():                     # sequential: writes need the lock
        write_table.with_options(name=f"write:{table}")(pid, table)
        verdict = audit_table.with_options(name=f"audit:{table}")(table)
        outcomes[pid] = publish_or_quarantine.with_options(name=f"publish:{table}")(
            pid, table, verdict)
        emit_event(event=f"statcan.table.{outcomes[pid]}",
                   resource={"prefect.resource.id": f"statcan.table.{pid}",
                             "statcan.table": table},
                   payload={"release_time": current.get(pid)})

    published = [pid for pid, o in outcomes.items() if o.startswith("published")]
    record_markers(current, published)

    if published:                                          # refresh only what changed (Day 58)
        from orchestration.flows.daily_refresh import transform_flow
        transform_flow(target=target)
        quality_flow()

    quarantined = [changed[p] for p, o in outcomes.items() if o == "quarantined"]
    if quarantined and not published:
        return Failed(message=f"all changed tables quarantined: {quarantined}")
    if quarantined or any(o.endswith("warnings") for o in outcomes.values()):
        return Completed(name="CompletedWithWarnings", message=f"outcomes: {outcomes}")
    return Completed(message=f"published: {[changed[p] for p in published]}")
```

Because `transform_flow` uses per-source fingerprints (58.5), a new LFS release rebuilds **only** the LFS-dependent models.

Add the deployment to `prefect.yaml` (no schedule: it's triggered):

```yaml
  - name: wap
    description: "Write–Audit–Publish for republished StatCan tables, then targeted refresh."
    entrypoint: orchestration/flows/statcan_release.py:statcan_release
    work_pool:
      name: local-process
      job_variables:
        env:
          PYTHONPATH: /workspaces/macro-data-course
    concurrency_limit: 1
    tags: [macro, prod, statcan]
```

---

## 59.4 The Release Watcher: Events, Triggers, Idempotency (23 min)

Create `orchestration/flows/release_watcher.py`:

```python
"""Poll StatCan release metadata; start WAP as soon as a configured table is republished."""
import dlt
from prefect import flow, get_run_logger
from prefect.deployments import run_deployment
from prefect.events import emit_event

from orchestration.tasks.wap import detect_changes


@flow(name="statcan-release-watcher")
def release_watcher(simulate: list[str] | None = None):
    logger = get_run_logger()
    tables = dlt.config["sources.statcan_tables.tables"]
    changed, current = detect_changes(tables)
    pids = sorted(set(changed) | set(simulate or []))

    if not pids:
        logger.info("No StatCan table republished.")
        return

    for pid in pids:
        emit_event(event="statcan.table.republished",
                   resource={"prefect.resource.id": f"statcan.table.{pid}",
                             "statcan.table": tables[pid]},
                   payload={"release_time": current.get(pid), "simulated": pid in (simulate or [])})

    key = "wap-" + "-".join(f"{p}@{current.get(p)}" for p in pids)
    run = run_deployment("statcan-release/wap",
                         parameters={"product_ids": pids, "force": bool(simulate)},
                         idempotency_key=key, timeout=0)
    logger.info(f"Triggered statcan-release/wap ({run.name}) for {pids}")
```

- **`idempotency_key`** ensures that if the watcher sees the same release twice (e.g. it runs again before WAP has published), Prefect **reuses** the existing triggered run instead of starting a duplicate. The key includes each table's **release time**, so a genuinely new release gets a new key.
- **`emit_event`** records each detected release in the UI's **Event Feed**, with the table as the event's *resource*, so you can filter events by table.

Schedule it during the release window: every 10 minutes, 08:30–10:50 ET on weekdays.

```yaml
  - name: statcan-watcher
    entrypoint: orchestration/flows/release_watcher.py:release_watcher
    work_pool:
      name: local-process
      job_variables:
        env:
          PYTHONPATH: /workspaces/macro-data-course
    concurrency_limit: 1
    schedules:
      - cron: "*/10 8-10 * * 1-5"
        timezone: "America/Toronto"
```

(It also runs at 08:00–08:20. Those polls find nothing and cost one small metadata request each.)

### Optional: an automation instead of `run_deployment`

Prefect deployments can declare **triggers** that start a run when a matching event occurs. In `prefect.yaml`, under the `wap` deployment:

```yaml
    triggers:
      - enabled: false                 # enable to replace the watcher's run_deployment call
        match:
          prefect.resource.id: "statcan.table.*"
        expect:
          - "statcan.table.republished"
        parameters:
          force: false
```

With such a trigger, the watcher only needs to **emit** events. The trade-off: event-triggered runs are elegant and decoupled, while `run_deployment` is explicit and easy to test. Check the trigger syntax against your Prefect version's documentation before enabling it. We keep it disabled and rely on the watcher's direct call.

### What happens to the morning schedule?

`prod-morning` (09:15 ET, Day 56) now overlaps with the watcher. Keep it as a **safety net**: if the watcher missed a release (e.g. the worker was down at 08:30), the morning refresh catches it, because WAP is **idempotent**. Once a release is published, its marker makes later runs find nothing to do (Day 50). Overlapping runs are serialised by the `duckdb` limit and deployment concurrency limits.

---

## 59.5 Release Briefings: Telling Economists What Changed (20 min)

When a release is published, the people who care want the **economics**, not the plumbing: *"September LFS: unemployment 6.9% (+0.1pp); Alberta highest at …"*. Create a release-specific briefing in `orchestration/tasks/reporting.py`:

```python
RELEASE_BRIEFS = {
    "14100287": ("Labour Force Survey", """
        with latest as (select max(month) as m from marts.lfs_provincial_monthly)
        select geo, unemployment_rate, ur_change_12m_pp, ur_gap_vs_canada_pp
        from marts.lfs_provincial_monthly, latest
        where month = latest.m
        order by unemployment_rate desc
    """),
    "18100004": ("Consumer Price Index", """
        select month, headline_yoy, core_ex_fe_yoy, median_major_yoy, diffusion_above_3
        from marts.macro_monthly
        where headline_yoy is not null
        order by month desc limit 3
    """),
}


@task
def publish_release_briefing(product_ids: list[str]) -> str:
    sections = []
    with duckdb_access(write=False):
        with duckdb.connect(ENV["MACRO_DUCKDB_PATH"], read_only=True) as con:
            for pid in product_ids:
                if pid not in RELEASE_BRIEFS:
                    continue
                title, sql = RELEASE_BRIEFS[pid]
                df = con.sql(sql).df().round(2)
                sections.append(f"## {title}\n\n{df.to_markdown(index=False)}")
    md = "# New StatCan release published\n\n" + "\n\n".join(sections)
    create_markdown_artifact(key="statcan-release-briefing", markdown=md,
                             description="Economic summary of newly published StatCan data")
    return md
```

(`DataFrame.to_markdown` needs the small `tabulate` package: `pip install tabulate`.)

Call it at the end of `statcan_release` when anything was published, and include a one-line headline in the notification. For the LFS, compute the national rate and its monthly change from the first rows. Economists receive **the news**; engineers have the logs.

---

## 59.6 Mini-Project: Simulate a Release, End to End (20 min)

You can't wait for StatCan's calendar, so use the watcher's `simulate` parameter to force the path:

```bash
prefect deploy --all
prefect deployment run 'statcan-release-watcher/statcan-watcher' --param 'simulate=["14100287"]'
```

Verify, using the UI:

1. **Event Feed**: a `statcan.table.republished` event for resource `statcan.table.14100287`.
2. The watcher run triggered **`statcan-release/wap`**.
3. In the WAP run: `write:statcan_lfs_full` → `audit:statcan_lfs_full` → `publish:statcan_lfs_full`, then a `transform` subflow building **only** `source:statcan.lfs_full+` (check the `dbt-node-results` artifact), then `quality`.
4. A `statcan.table.published` event, and the **release briefing** artifact.
5. Trigger the watcher **again** with the same simulation while WAP is running: the idempotency key prevents a duplicate WAP run.

Then combine with Day 50's chaos: inject `rate_out_of_range` into `raw_incoming` (skip the write step via a `skip_write=True` parameter you add for drills), run WAP, and confirm the **quarantine** path: `statcan.table.quarantined` event, Failed or warning state per policy, alert sent, production table untouched.

Record the evidence in `orchestration/ACCEPTANCE.md`.

### Day 59 checklist
- [ ] I can contrast schedule-driven and event-driven orchestration and justify a hybrid
- [ ] A readers–writer lock (`occupy`) prevents any reader–writer collision on DuckDB
- [ ] WAP runs as a flow with per-table write, audit, publish/quarantine tasks and events
- [ ] A release watcher polls during the 08:30 ET window and triggers WAP idempotently
- [ ] A new release rebuilds only its downstream dbt models, re-validates, and produces an economic briefing
- [ ] Simulated releases and simulated bad releases follow the documented paths

```bash
git add . && git commit -m "Day 59: readers-writer lock, WAP flow, release watcher, briefings" && git push
```

---

# DAY 60 — Dashboards, Production Readiness and the End of Part II

| Time | Block |
|---|---|
| 0:00 – 0:30 | 60.1 The last mile: the notebook's dashboards as code |
| 0:30 – 0:50 | 60.2 `daily_refresh` v4: the complete pipeline |
| 0:50 – 0:58 | Break |
| 0:58 – 1:20 | 60.3 Dev and prod environments: testing the whole platform safely |
| 1:20 – 1:40 | 60.4 Backups and restore drills |
| 1:40 – 1:48 | Break |
| 1:48 – 2:15 | 60.5 The production-readiness review |
| 2:15 – 2:30 | 60.6 Part II recap and a look at Part III |

---

## 60.1 The Last Mile: The Notebook's Dashboards as Code (30 min)

The course notebook draws its dashboards from data it fetches itself (Cells 2–5). Since Day 40, those numbers come from **tested marts** in `data/marts/*.parquet`. The final step is to make **building the dashboards** part of the pipeline: a script that reads the marts and writes standalone HTML files, exactly as the notebook's `fig.write_html(...)` calls did.

Create `dashboards/build_dashboards.py` (runs in `.venv`; install `plotly` there if needed):

```python
"""Build the macro dashboards (HTML) from the dbt marts. Called by the pipeline."""
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots

REPO = Path(__file__).resolve().parents[1]
MARTS = REPO / "data" / "marts"
SITE = REPO / "site"

# The notebook's navy palette
C = {"primary": "#4A90D9", "positive": "#3DA882", "warning": "#D4924A",
     "negative": "#C95555", "background": "#0D1B3E", "text": "#C8D8F0", "muted": "#A0B4CC"}
LAYOUT = dict(plot_bgcolor=C["background"], paper_bgcolor=C["background"],
              font=dict(color=C["text"], family="Calibri, Segoe UI, sans-serif"))


def banner(as_of: str, quality: pd.DataFrame | None) -> str:
    """Header shown on every dashboard: data date, build time, quality status."""
    built = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    q = ""
    if quality is not None and not quality.empty:
        crit = quality[quality["checkpoint"] == "critical"]
        ok = not crit.empty and int(crit["failures"].iloc[0]) == 0
        q = ("✅ critical quality checks passing" if ok
             else "⚠️ critical quality checks FAILING — interpret with caution")
    return f"Data as of <b>{as_of}</b> · built {built} · {q}"


def rates_fx(monthly: pd.DataFrame, daily: pd.DataFrame, quality) -> Path:
    fig = make_subplots(rows=2, cols=1, vertical_spacing=0.12,
                        subplot_titles=["Policy rates and real rate (%)",
                                        "USD/CAD vs Canada–US 2-year spread"],
                        specs=[[{}], [{"secondary_y": True}]])
    m = monthly[monthly["month"] >= "2015-01-01"]
    for col, name, colour in [("overnight_rate", "BoC overnight", C["primary"]),
                              ("fed_funds", "Fed funds", C["warning"]),
                              ("real_rate", "Real policy rate", C["positive"])]:
        fig.add_trace(go.Scatter(x=m["month"], y=m[col], name=name,
                                 line=dict(color=colour, width=2)), row=1, col=1)
    d = daily[daily["date_day"] >= "2018-01-01"]
    fig.add_trace(go.Scatter(x=d["date_day"], y=d["usd_cad"], name="USD/CAD",
                             line=dict(color=C["primary"], width=1.5)), row=2, col=1)
    fig.add_trace(go.Scatter(x=d["date_day"], y=d["ca_us_2y_spread_bp"], name="CA–US 2y (bp)",
                             line=dict(color=C["negative"], width=1.5)),
                  row=2, col=1, secondary_y=True)
    as_of = str(m["month"].max())[:7]
    fig.update_layout(**LAYOUT, height=900,
                      title=dict(text=f"<b>Rates & FX</b><br><sup>{banner(as_of, quality)}</sup>"))
    out = SITE / "rates_fx.html"
    fig.write_html(out)
    return out


def labour(lfs: pd.DataFrame, quality) -> Path:
    latest = lfs["month"].max()
    snap = lfs[lfs["month"] == latest].sort_values("unemployment_rate")
    colours = [C["negative"] if g == "CA" else C["primary"] for g in snap["geo_code"]]
    fig = go.Figure(go.Bar(x=snap["unemployment_rate"], y=snap["geo_code"], orientation="h",
                           marker_color=colours, text=snap["unemployment_rate"].round(1),
                           textposition="outside"))
    fig.update_layout(**LAYOUT, height=600,
                      title=dict(text=f"<b>Unemployment rate by province (SA, 15+)</b>"
                                      f"<br><sup>{banner(str(latest)[:7], quality)}</sup>"),
                      xaxis_title="%")
    out = SITE / "labour.html"
    fig.write_html(out)
    return out


def index(pages: list[Path]) -> Path:
    links = "\n".join(f'<li><a href="{p.name}">{p.stem.replace("_", " ").title()}</a></li>'
                      for p in pages)
    html = (f"<html><body style='background:{C['background']};color:{C['text']};"
            f"font-family:Calibri,sans-serif'><h1>Canadian Macro Dashboards</h1>"
            f"<ul>{links}</ul></body></html>")
    out = SITE / "index.html"
    out.write_text(html)
    return out


def build() -> list[str]:
    SITE.mkdir(exist_ok=True)
    monthly = pd.read_parquet(MARTS / "macro_monthly.parquet")
    daily = pd.read_parquet(MARTS / "fct_open_economy_daily.parquet")
    lfs = pd.read_parquet(MARTS / "lfs_provincial_monthly.parquet")
    quality_path = MARTS / "quality_latest.parquet"
    quality = pd.read_parquet(quality_path) if quality_path.exists() else None
    pages = [rates_fx(monthly, daily, quality), labour(lfs, quality)]
    pages.append(index(pages))
    return [str(p) for p in pages]


if __name__ == "__main__":
    print("\n".join(build()))
```

```bash
python dashboards/build_dashboards.py
python -m http.server 8090 --directory site        # Codespaces forwards port 8090
```

Design points:
- Every dashboard says **when the data is from**, **when it was built**, and **whether quality checks pass**. A chart without its "as of" date and trust status is an invitation to misread it.
- The script only **reads Parquet**: no database connection, no lock needed.
- `site/` is generated output: add it to `.gitignore`.

### Exercise: port the remaining notebook modules

Port the notebook's other modules into `build_dashboards.py`, one function each, reading **only** marts. That covers Module 01 (macro overview), Module 03 (fiscal, from the fiscal seeds if you added them), Module 05 (business cycle) and Module 07 (cockpit, from `macro_kpis`). Where the notebook computed something itself, check whether a mart already provides it, and if not, add it to dbt rather than to the dashboard script. **Dashboards present; dbt computes.**

---

## 60.2 `daily_refresh` v4: The Complete Pipeline (20 min)

```python
"""Daily macro refresh — v4 (Day 60): the complete orchestrated pipeline."""
from prefect import flow, get_run_logger, task

from dashboards.build_dashboards import build as build_dashboards
from orchestration.flows.statcan_release import statcan_release
# extract_load_flow, transform_flow, quality_flow, outcome(), hooks, history: Days 53–58


@task(retries=1, retry_delay_seconds=30)
def build_dashboards_task() -> list[str]:
    pages = build_dashboards()
    get_run_logger().info(f"dashboards built: {pages}")
    return pages


@flow(name="publish")
def publish_flow(skip_briefing: bool = False) -> dict:
    states = {"dashboards": build_dashboards_task(return_state=True)}
    if not skip_briefing:
        states["briefing"] = publish_briefing(return_state=True)           # Day 53 artifact
    return states


@flow(name="daily-refresh",
      on_failure=[alert_on_failure], on_crashed=[alert_on_failure],
      on_completion=[alert_on_warnings])
def daily_refresh(target: str = "prod", force_transform: bool = False,
                  sources: list[str] = ("boc", "fred", "statcan")):
    states = {}
    states.update(extract_load_flow(sources))                 # 1. dlt, per source
    states["statcan_release"] = statcan_release(target=target, return_state=True)  # 2. WAP (idempotent)
    states.update(transform_flow(target=target, force=force_transform))  # 3. targeted dbt
    if outcome(states.get("dbt_build")) != "failed":
        states.update(quality_flow())                          # 4. GX warehouse
        if outcome(states.get("gx_warehouse")) != "failed":
            states.update(publish_flow())                      # 5. dashboards + briefing
    ...                                                        # 6. policy → final state, history, artifacts
```

Points to note:
- **WAP runs inside the daily refresh too**, as a safety net (59.4). On most days it finds nothing and finishes in seconds.
- **Dashboards are published only if critical quality checks pass.** Otherwise yesterday's dashboards stay online, and their banner (built yesterday) still reflects yesterday's status. The policy from Day 53 extends naturally: *no publication on critical failure*.
- Update `STATE_POLICY.md` with the `statcan_release` and `publish` rows.

---

## 60.3 Dev and Prod Environments: Testing the Whole Platform Safely (23 min)

You've tested pieces in isolation (dev schemas in dbt, practice pipelines in dlt, throwaway GX assets). The whole platform deserves a **dev environment**: same code, different warehouse file, so you can run end-to-end experiments without risking production.

Add to `orchestration/settings.py`:

```python
ENVIRONMENTS = {
    "prod": {"db": REPO / "macro.duckdb", "dbt_target": "prod"},
    "dev":  {"db": REPO / "dev_macro.duckdb", "dbt_target": "dev"},
}


def activate(environment: str):
    """Point every tool at the chosen environment (in-process tools and subprocesses)."""
    db = ENVIRONMENTS[environment]["db"]
    updates = {
        "MACRO_DUCKDB_PATH": str(db),                      # dbt profiles, WAP, fingerprints
        "MACRO_DUCKDB_URL": f"duckdb:///{db}",             # Great Expectations
        "DESTINATION__DUCKDB__CREDENTIALS": str(db),       # dlt (Day 23)
    }
    os.environ.update(updates)
    ENV.update(updates)
    return ENVIRONMENTS[environment]["dbt_target"]
```

Give `daily_refresh` a parameter `environment: str = "prod"`, call `target = activate(environment)` first, and pass `target` downstream. Variables (fingerprints) are already keyed by target (58.6).

### Creating the dev copy

```bash
# with no pipeline running (the copy must not happen during a write)
cp macro.duckdb dev_macro.duckdb
```

Then run the whole pipeline against dev:

```python
from orchestration.flows.daily_refresh import daily_refresh
daily_refresh(environment="dev", force_transform=True)
```

> GX assets point at `${MACRO_DUCKDB_URL}` (Day 43), so they follow the environment automatically. The dbt `dev` target builds into `dev_*` schemas inside `dev_macro.duckdb`. Dev is fully separated from prod, at the file level **and** the schema level.

Add a `dev-refresh` deployment (no schedule) to `prefect.yaml` with `parameters: {environment: dev}`, so anyone can test a change end to end from the UI.

---

## 60.4 Backups and Restore Drills (20 min)

Most of the warehouse can be **rebuilt** from the APIs plus code. Some of it **cannot**:

| Can be rebuilt | Cannot be rebuilt (must be backed up) |
|---|---|
| observations (re-extract from APIs) | dlt **vintages** of revised data (Day 27): past values the APIs no longer serve |
| staging, intermediate, marts (dbt) | dbt **snapshots** of CPI revisions (Day 37) |
| full StatCan tables (re-download) | **quarantined** releases (Day 50): evidence of what StatCan sent |
| | GX and run **history** (`data/quality`, `data/orchestration`) |
| | seeds and code: in **Git**, already backed up |

### A backup flow

Create `orchestration/flows/backup.py`:

```python
"""Weekly backup of the warehouse and of the history files."""
import shutil
from datetime import datetime, timezone

import duckdb
from prefect import flow, get_run_logger, task

from orchestration.settings import ENV, REPO
from orchestration.tasks.locks import duckdb_access

BACKUP_DIR = REPO / "backups"
KEEP = 8


@task(timeout_seconds=3600)
def export_database() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    target = BACKUP_DIR / f"macro_{stamp}"
    with duckdb_access(write=False):
        with duckdb.connect(ENV["MACRO_DUCKDB_PATH"], read_only=True) as con:
            con.execute(f"EXPORT DATABASE '{target}' (FORMAT parquet)")
    for folder in ("data/quality", "data/orchestration"):
        src = REPO / folder
        if src.exists():
            shutil.copytree(src, target / "history" / src.name)
    return str(target)


@task
def prune_old_backups():
    backups = sorted(BACKUP_DIR.glob("macro_*"))
    for old in backups[:-KEEP]:
        shutil.rmtree(old)
        get_run_logger().info(f"pruned {old.name}")


@flow(name="backup")
def backup():
    BACKUP_DIR.mkdir(exist_ok=True)
    path = export_database()
    prune_old_backups()
    get_run_logger().info(f"backup written to {path}")
```

`EXPORT DATABASE` writes every schema and table as Parquet files plus the SQL needed to recreate them. Schedule it weekly in `prefect.yaml` (e.g. Sundays 06:00 ET, before the weekly rebuild).

> A backup inside the same Codespace protects against **mistakes** (a bad `DROP`), not against **losing the machine**. In production, copy backups to separate storage (Day 56's `DEPLOYMENT.md`).

### The restore drill

A backup you haven't restored is a hope, the same principle as every drill in this course:

```bash
duckdb restored.duckdb -c "IMPORT DATABASE 'backups/macro_<stamp>'"
duckdb restored.duckdb -readonly -c "
  select table_schema, count(*) as tables from information_schema.tables group by 1 order by 1"
```

Compare row counts of key tables between `macro.duckdb` and `restored.duckdb` (the Day 30 regression technique), time the restore, and record both in `PRODUCTION_READINESS.md`. Then point a **dev** run at the restored file (`cp restored.duckdb dev_macro.duckdb`) and confirm the pipeline runs end to end on it.

---

## 60.5 The Production-Readiness Review (28 min)

Professional teams don't declare a system "production-ready" by feel. They walk through a **checklist** with evidence. Create `PRODUCTION_READINESS.md` and score each item **✅ done (with evidence) · 🟡 partial · ❌ missing**. Link evidence: files, run names, artifacts, drill logs.

```markdown
# Production readiness review — Canadian macro data platform

## 1. Correctness
- [ ] Every mart has documented grain, tests on keys, and contracts where narrow (Days 36, 40)
- [ ] Boundary audits on all full StatCan tables; 0–100% and continuity contracts (Days 48–50)
- [ ] Warehouse GX checkpoints with critical/warning split (Days 44–47)
- [ ] Regression tests performed at every migration (Days 30, 40)
- [ ] Cross-source consistency checks (CPI vector vs table; LFS vector vs table)

## 2. Reliability
- [ ] Retries only for transient failures; documented exit codes (Day 54)
- [ ] Timeouts on every step; retry budget fits the deadline (Day 54)
- [ ] Readers–writer lock prevents DuckDB collisions across all runs (Day 59)
- [ ] Idempotent steps: re-running any flow is safe (markers after success)
- [ ] Failure drills: ingestion, quarantine, dbt, GX, overlapping runs (Days 53–59)

## 3. Observability
- [ ] Every run visible in Prefect with per-step state, logs and artifacts
- [ ] Run, quality and ingestion history queryable as data (Days 47, 57)
- [ ] Pipeline-health and data-quality KPIs in the cockpit (Days 50, 57)
- [ ] Watchdog for silent stoppage (Day 57)

## 4. Timeliness
- [ ] Schedules aligned with BoC and StatCan publication times, America/Toronto (Day 56)
- [ ] Release watcher reacts within ~10 minutes of StatCan releases (Day 59)
- [ ] Freshness tests per series (Days 36, 49)

## 5. Security
- [ ] No secrets in Git (`git log -p | grep -i key` reviewed); Secret blocks / Codespaces secrets
- [ ] Read-only connections for every reader
- [ ] Data Docs and backups treated as data (not committed)

## 6. Recoverability
- [ ] Weekly backups including vintages, snapshots, quarantine and history (Day 60)
- [ ] Restore drill performed and timed (Day 60)
- [ ] Full rebuild from APIs drill performed and timed (`--full-refresh`)

## 7. Operability & documentation
- [ ] RUNBOOK.md covers every alert type
- [ ] DATA_QUALITY_PLAN.md, STATE_POLICY.md, EXIT_CODES.md, DEPLOYMENT.md current
- [ ] A colleague can operate the platform from the docs alone (tested, Day 47 method)
- [ ] Dev environment for end-to-end testing (Day 60)

## Known gaps and risks
| Gap | Risk | Mitigation / plan |
|---|---|---|
| Runs only while the Codespace is active | missed schedules | DEPLOYMENT.md: always-on host or managed service |
| Watchdog runs on the same machine | can't detect machine loss | external monitoring in production |
| … | | |
```

### The review exercise

Work in **pairs**: each student reviews their partner's platform against the checklist, asking for **evidence** for every ✅. Unsupported ticks become 🟡. Agree on the three most important gaps, and write a short remediation plan for each. This is exactly how real teams prepare a system for launch.

---

## 60.6 Part II Recap and a Look at Part III (15 min)

### What you built in Parts I and II (Days 1–60)

| Module | Days | Layer | Tools |
|---|---|---|---|
| 1 | 1–10 | foundations: Python, pandas, REST APIs | Python, pandas, requests |
| 2 | 11–20 | analytical SQL and a layered warehouse | DuckDB |
| 3 | 21–30 | declarative, incremental, resilient ingestion | dlt |
| 4 | 31–40 | modular, tested transformations and the macro mart | dbt |
| 5 | 41–50 | data contracts, validation, Write–Audit–Publish | Great Expectations |
| 6 | 51–60 | orchestration: retries, caching, schedules, events, operations | Prefect |

### The platform, in one sentence

> *Every weekday, within minutes of the Bank of Canada and Statistics Canada publishing, a self-monitoring pipeline extracts the new data, quarantines anything that breaks its contracts, rebuilds only the affected models, validates the results, and publishes dashboards that say how fresh and how trustworthy every number is.*

### How the pieces map to the curriculum's capstone table

| Capstone component | Technology | Where you built it |
|---|---|---|
| Extract & load | Python, dlt, DuckDB | Modules 1–3; per-source tasks (Day 58) |
| Transform & test | dbt, Great Expectations | Modules 4–5; targeted builds and gating (Days 58–60) |
| Model & forecast | XGBoost, Chronos, DoubleML | **Part III**, built on these marts |
| Orchestration & visualisation | Prefect, Plotly | Module 6; dashboards (Day 60) |

### Looking ahead: Part III — Advanced Analytics (Days 61–80)

Everything you've built becomes the **foundation for modelling**:

- **Module 7 — Forecasting with XGBoost & Chronos (Days 61–70):** features engineered from `macro_monthly` and `macro_quarterly`; forecasting Canadian CPI and real GDP growth; SHAP explanations; zero-shot forecasting with Chronos. The **vintages** and **snapshots** you preserved (Days 27, 37, 60) make honest, real-time forecast evaluation possible: training only on data **as it was known** at each point in time.
- **Module 8 — Causal inference with DoubleML (Days 71–80):** estimating the effect of Bank of Canada rate hikes on housing starts, controlling for the business cycle. It uses the policy-cycle mart (Day 17), the decision log seed and the open-economy controls (Day 39).
- **The final capstone:** forecasts and causal estimates become **new marts**, produced by **new Prefect tasks** in the same pipeline, and shown on the **same dashboards**, validated by the same quality layer.

### Day 60 checklist
- [ ] The notebook's dashboards are built by code from marts, with "as of" dates and quality banners
- [ ] `daily_refresh` v4 links dlt → WAP → dbt → GX → dashboards, publishing only when quality allows
- [ ] A dev environment runs the whole platform safely against a copy of the warehouse
- [ ] Weekly backups include everything that can't be rebuilt; a restore drill succeeded and was timed
- [ ] `PRODUCTION_READINESS.md` is completed with evidence, peer-reviewed, and lists remediation plans
- [ ] I can explain how Parts I–II support forecasting and causal analysis in Part III

```bash
git add . && git commit -m "Day 60: dashboards, daily_refresh v4, dev/prod, backups, readiness review — Part II complete"
git push
```
