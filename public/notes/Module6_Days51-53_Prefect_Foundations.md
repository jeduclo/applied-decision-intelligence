# Module 6 · Pipeline Orchestration with Prefect
## Days 51–53: Flow & Task Decorators, Local Orchestration and State Management

**Audience:** MSc Economics students who completed Modules 1–5 (Days 1–50)
**Environment:** GitHub Codespaces · `.venv` (dlt, dbt, now Prefect) · `.venv-gx` (Great Expectations) · `macro.duckdb`
**Time per day:** ~5 hours (including breaks and exercises)
**Goal by end of Day 53:** Students rebuild `pipeline.sh` as a **Prefect flow**. Each step is an observable **task**, related steps are grouped in **subflows**, and independent API calls run **concurrently**. Every run is visible in the Prefect UI. The fragile exit-code juggling of the shell script becomes an explicit, tested **state policy**, and the pipeline reports through **state hooks** (alerts) and **artifacts** (a run report economists can read).

---

### Why orchestration, and why now?

At the end of Module 5 you listed what `pipeline.sh` can't do:

| `pipeline.sh` today | What an orchestrator gives you |
|---|---|
| runs only when someone types it | schedules and event triggers (Days 54–57) |
| one failure → rerun everything | per-step **retries** and **caching** (Days 54–57) |
| "did last night's run work?" → read logs | a **UI** with every run, step, duration and log line |
| `|| [ $? -eq 2 ]`, `set +e`: decisions hidden in shell tricks | **states** and explicit Python logic |
| no record of *why* a run ended as it did | state messages, hooks, **artifacts** |
| accidental overlapping runs fight over the DuckDB lock | concurrency controls (Days 54–57) |

**Prefect** is a Python orchestration framework. You add two decorators (`@flow` and `@task`) to ordinary Python functions, and Prefect tracks, logs, retries and schedules them. There's no special DSL and no rewrite: your Module 1–5 code stays as it is.

> **Orchestration ≠ transformation.** Prefect doesn't replace dlt, dbt or GX. It **coordinates** them: in what order, under which conditions, with which retries, and what to do when something goes wrong. Think of it as the conductor, not another instrument.

### The plan for Module 6

| Days | Focus |
|---|---|
| **51–53** | flows & tasks, local orchestration (subflows, concurrency, wrapping existing tools), states |
| 54–57 | retries, caching, scheduling, logging and deployments |
| 58–60 | orchestrating the daily macro-dashboard refresh: dlt → WAP → dbt → GX, triggered by releases |

### Target structure (by end of Day 53)

```
macro-data-course/
├── orchestration/                    ← NEW
│   ├── __init__.py
│   ├── settings.py                   ← paths, interpreters, environment
│   ├── tasks/
│   │   ├── __init__.py
│   │   ├── commands.py               ← run_step(): scripts/CLIs as observable tasks
│   │   └── reporting.py              ← artifacts: run report, KPI briefing
│   └── flows/
│       ├── __init__.py
│       ├── hello.py                  ← Day 51 learning flows
│       ├── cpi_briefing.py
│       ├── concurrency_demo.py       ← Day 52
│       └── daily_refresh.py          ← Days 52–53: pipeline.sh as a flow
├── pipeline.sh                       ← kept for comparison until Day 60
```

---

# DAY 51 — Flows and Tasks

| Time | Block |
|---|---|
| 0:00 – 0:40 | 51.1 Orchestration concepts |
| 0:40 – 1:25 | 51.2 Installing Prefect and starting the UI in Codespaces |
| 1:25 – 1:40 | Break |
| 1:40 – 2:20 | 51.3 Your first flow |
| 2:20 – 3:10 | 51.4 Tasks: the observable steps inside a flow |
| 3:10 – 3:25 | Break |
| 3:25 – 4:00 | 51.5 Parameters and type hints |
| 4:00 – 4:20 | 51.6 Logging |
| 4:20 – 5:00 | 51.7 Mini-project: a CPI briefing flow |

---

## 51.1 Orchestration Concepts (40 min)

| Term | Meaning | Macro example |
|---|---|---|
| **Flow** | a unit of work you run and monitor as a whole | "daily macro refresh" |
| **Task** | one observable step inside a flow | "load StatCan tables", "dbt build" |
| **Flow run / task run** | one execution, with its own ID, logs, timing and state | "last night's refresh" |
| **State** | where a run is in its lifecycle, and how it ended | Running, Completed, Failed |
| **Parameters** | inputs that change a flow's behaviour between runs | start date, list of series |
| **Subflow** | a flow called inside another flow | "ingest" within "daily refresh" |

### Workflows as Python, not as diagrams

Some orchestrators (Airflow is the best known) make you declare a **static graph** of tasks up front. Prefect builds the graph **dynamically from your Python code**: if you call task B with the output of task A, B depends on A. Loops, `if` statements and function calls work as usual.

```python
@flow
def refresh():
    data = extract()          # task A
    clean = transform(data)   # task B: depends on A through its input
    if clean.shape[0] > 0:    # ordinary Python control flow
        publish(clean)        # task C
```

For economists who already write Python, that's the big attraction: **orchestration looks like the code you already write**.

### What Prefect records for you

Every time a flow runs, Prefect records **who ran what, with which parameters, when, for how long, in what order, what was logged, and how it ended**. That's the audit trail a data team needs when a dashboard number is questioned three weeks later.

---

## 51.2 Installing Prefect and Starting the UI (45 min)

Prefect goes into the **main** environment, next to dlt and dbt, because it will call their Python code directly. GX stays isolated in `.venv-gx` and will be called as a separate process (Day 50's pattern).

```bash
cd /workspaces/macro-data-course
source .venv/bin/activate
pip install -U prefect
pip freeze > requirements.txt
prefect version
```

> **Version note.** This course uses **Prefect 3.x**. Prefect 1 and 2 had different APIs (e.g. Prefect 1's `Flow` context manager), and many online examples still use them. Check the version any example targets before copying it.

### Start a local Prefect server

The Prefect **server** stores run history and serves the UI. Open a **second terminal** (it will keep running):

```bash
source .venv/bin/activate
prefect server start --host 0.0.0.0
```

Codespaces will offer to open **port 4200**. In your **first** terminal, tell Prefect where the API is:

```bash
prefect config set PREFECT_API_URL="http://127.0.0.1:4200/api"
```

If the UI loads in your browser but shows "can't connect to the API", tell the UI to use the Codespaces forwarded address (Codespaces provides these variables automatically), then restart the server:

```bash
prefect config set PREFECT_UI_API_URL="https://${CODESPACE_NAME}-4200.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}/api"
```

> **Without a server:** if `PREFECT_API_URL` isn't set, Prefect starts a temporary server for each run. The flow works, but history disappears afterwards. Keep the server terminal running during these three days.

### Project skeleton

```bash
mkdir -p orchestration/tasks orchestration/flows
touch orchestration/__init__.py orchestration/tasks/__init__.py orchestration/flows/__init__.py
```

We'll run flows as modules from the repository root, e.g. `python -m orchestration.flows.hello`, so that imports like `from orchestration.settings import ...` work.

---

## 51.3 Your First Flow (40 min)

Create `orchestration/flows/hello.py`:

```python
from prefect import flow


@flow(log_prints=True)
def hello_macro(target: float = 2.0):
    """A first flow: compare a real-rate calculation with the inflation target."""
    overnight, cpi_yoy = 2.25, 3.0            # values from the course notebook
    real_rate = overnight - cpi_yoy
    print(f"Real policy rate: {real_rate:+.2f}% (inflation target {target}%)")
    return real_rate


if __name__ == "__main__":
    hello_macro()
```

```bash
python -m orchestration.flows.hello
```

Look at the terminal output: besides your `print`, Prefect logged that it **created a flow run** (with a random, memorable name like `"cerulean-otter"`), and that the run **finished in state Completed**.

Open the UI (port 4200) → **Runs**. Click your run: you'll see its parameters (`target: 2.0`), logs, duration and final state.

What the decorator added:

| Without `@flow` | With `@flow` |
|---|---|
| a Python function | a tracked **flow run** with an ID and a name |
| output only in the terminal | logs stored and visible in the UI |
| no record of inputs | parameters recorded |
| an exception is just a traceback | the run ends in state **Failed**, with the error recorded |

`log_prints=True` makes every `print()` inside the flow a **log line**, which is handy for learning. For production code we'll use a proper logger (51.6).

### Make it fail

Add `raise ValueError("CPI data missing")` before the `return`, run again, and look at the run in the UI: state **Failed**, with the error message and traceback attached. Remove the line again.

---

## 51.4 Tasks: The Observable Steps Inside a Flow (50 min)

A **task** is a function decorated with `@task`, called from inside a flow. Each call becomes a **task run** with its own state, logs and timing.

Create `orchestration/flows/cpi_steps.py`:

```python
import time

from prefect import flow, task


@task
def fetch_cpi_levels() -> list[float]:
    """Illustrative CPI levels (Day 1). Tomorrow we fetch real data."""
    time.sleep(1)                               # pretend this is a slow API call
    return [161.3, 161.8, 162.4, 162.6, 163.0, 163.4,
            163.9, 164.0, 163.7, 164.1, 164.3, 164.2, 166.1]


@task
def year_over_year(levels: list[float]) -> float:
    return 100 * (levels[-1] / levels[-13] - 1)


@task
def classify(yoy: float, target: float = 2.0) -> str:
    if yoy > target + 1:
        return "above the 1–3% control range"
    if yoy < target - 1:
        return "below the 1–3% control range"
    return "within the 1–3% control range"


@flow(log_prints=True)
def cpi_steps(target: float = 2.0):
    levels = fetch_cpi_levels()
    yoy = year_over_year(levels)
    verdict = classify(yoy, target)
    print(f"CPI inflation {yoy:.1f}% — {verdict}")


if __name__ == "__main__":
    cpi_steps()
```

```bash
python -m orchestration.flows.cpi_steps
```

In the UI, open the flow run and look at the **timeline** (or "graph") view: three task runs in sequence, each with its own duration. `fetch_cpi_levels` takes about a second; the others are instant.

### How dependencies arise

You never declared "`year_over_year` runs after `fetch_cpi_levels`". Prefect saw that `year_over_year` **received** the output of `fetch_cpi_levels` and recorded the dependency. That's the dynamic graph from 51.1.

### What makes a good task?

| Good task boundaries | Poor task boundaries |
|---|---|
| a step you'd want to **retry** on its own (an API call) | one line of arithmetic |
| a step whose **duration** you want to track (dbt build) | a helper called thousands of times |
| a step with a clear **input and output** | a step that relies on hidden global state |
| a step whose **failure** means something specific | a step so large that a failure tells you nothing |

> Rule of thumb: **one task per external system interaction or meaningful stage**: one API, one database write, one tool invocation. Pure calculations inside a stage can stay ordinary functions.

### Try it 51.4

Add a fourth task, `real_rate(overnight: float, yoy: float) -> float`, and make the flow print the real policy rate, using 2.25 as the overnight rate. In the UI, which tasks does `real_rate` depend on?

<details>
<summary>Solution</summary>

```python
@task
def real_rate(overnight: float, yoy: float) -> float:
    return overnight - yoy

# inside the flow, after computing yoy:
    r = real_rate(2.25, yoy)
    print(f"Real policy rate: {r:+.2f}%")
```

`real_rate` depends only on `year_over_year` (through `yoy`). The constant 2.25 creates no dependency. `classify` and `real_rate` are independent of each other, which matters for concurrency tomorrow.

</details>

---

## 51.5 Parameters and Type Hints (35 min)

A flow's **function arguments are its parameters**. Prefect records them for every run and **validates** them against the type hints, converting where it safely can.

```python
from datetime import date

from prefect import flow


@flow(log_prints=True)
def parameter_demo(series_ids: list[str], start_date: date = date(2006, 1, 1),
                   lookback_days: int = 14):
    print(f"series={series_ids} start={start_date!r} lookback={lookback_days}")


if __name__ == "__main__":
    parameter_demo(["V39079", "FXCADUSD"], start_date="2024-01-01", lookback_days="30")
```

Run it and look at the output: `start_date` arrived as the **text** `"2024-01-01"` but was converted to a `date`, and `"30"` became the integer `30`. Invalid values fail **before** any work starts:

```python
parameter_demo(["V39079"], start_date="not a date")    # the run fails immediately, with a clear error
```

Why this matters:
- **Every run documents its inputs.** "Which start date did the backfill use?" is answered in the UI.
- **Bad inputs fail fast**, before touching APIs or the warehouse.
- Later, **deployments** (Days 54–57) let you run flows with different parameters from the UI or a schedule. Type hints then generate the input form automatically.

> Parameters should be **small, serialisable values** (text, numbers, dates, lists, dictionaries). Don't pass DataFrames or database connections as flow parameters; pass *where to find* the data instead.

---

## 51.6 Logging (20 min)

`print` with `log_prints=True` is fine for learning. In real flows, use Prefect's **run logger**, which attaches each message to the right flow or task run, with a **level**:

```python
from prefect import flow, get_run_logger, task


@task
def check_freshness(age_days: int, tolerance: int) -> bool:
    logger = get_run_logger()
    if age_days > tolerance:
        logger.warning(f"Series is {age_days} days old (tolerance {tolerance})")
        return False
    logger.info(f"Series fresh ({age_days} days old)")
    return True


@flow
def logging_demo():
    logger = get_run_logger()
    logger.info("Checking freshness of two series")
    check_freshness(3, 10)
    check_freshness(45, 10)


if __name__ == "__main__":
    logging_demo()
```

In the UI, filter the run's logs by level to see only warnings. That's the same level scheme as Day 9's `logging` module: DEBUG, INFO, WARNING, ERROR, CRITICAL.

---

## 51.7 Mini-Project: A CPI Briefing Flow (40 min)

Create `orchestration/flows/cpi_briefing.py`: a flow that fetches **real** data and produces a short inflation briefing.

**Requirements:**
1. Parameter `latest_n: int = 25`: how many months to fetch.
2. Task `fetch_cpi(latest_n)`: POST to StatCan's `getDataFromVectorsAndLatestNPeriods` for vector `41690973` (CPI All-items, Day 10) and return a list of `(date, value)` pairs.
3. Task `compute_measures(points)`: return a dictionary with the latest month, YoY inflation, the YoY one year earlier, and the change in YoY (acceleration, Day 19).
4. Task `briefing(measures, target=2.0)`: return a two-sentence text, logged at INFO.
5. Use `get_run_logger()` (no `print`).
6. Run it twice, once with `latest_n=13` and once with the default, and compare the runs' parameters in the UI.

<details>
<summary>Solution</summary>

```python
"""A small real-data flow: CPI inflation briefing from the StatCan WDS API."""
from datetime import date

import requests
from prefect import flow, get_run_logger, task

WDS = "https://www150.statcan.gc.ca/t1/wds/rest/getDataFromVectorsAndLatestNPeriods"


@task
def fetch_cpi(latest_n: int) -> list[tuple[date, float]]:
    r = requests.post(WDS, json=[{"vectorId": 41690973, "latestN": latest_n}], timeout=30)
    r.raise_for_status()
    item = r.json()[0]
    if item.get("status") != "SUCCESS":
        raise RuntimeError(f"StatCan returned status {item.get('status')}")
    points = [(date.fromisoformat(dp["refPer"][:10]), float(dp["value"]))
              for dp in item["object"]["vectorDataPoint"] if dp.get("value") is not None]
    get_run_logger().info(f"Fetched {len(points)} CPI observations")
    return sorted(points)


@task
def compute_measures(points: list[tuple[date, float]]) -> dict:
    values = [v for _, v in points]
    if len(values) < 25:
        yoy_prev = None
    else:
        yoy_prev = 100 * (values[-13] / values[-25] - 1)
    yoy = 100 * (values[-1] / values[-13] - 1)
    return {"latest": points[-1][0].isoformat(), "yoy": yoy, "yoy_prev": yoy_prev,
            "accel": None if yoy_prev is None else yoy - yoy_prev}


@task
def briefing(m: dict, target: float = 2.0) -> str:
    position = ("above" if m["yoy"] > target + 1 else
                "below" if m["yoy"] < target - 1 else "within")
    text = (f"CPI inflation was {m['yoy']:.1f}% in {m['latest'][:7]}, "
            f"{position} the Bank of Canada's 1–3% control range.")
    if m["accel"] is not None:
        direction = "higher" if m["accel"] > 0 else "lower"
        text += f" That is {abs(m['accel']):.1f}pp {direction} than a year earlier."
    get_run_logger().info(text)
    return text


@flow(name="cpi-briefing")
def cpi_briefing(latest_n: int = 25, target: float = 2.0) -> str:
    points = fetch_cpi(latest_n)
    measures = compute_measures(points)
    return briefing(measures, target)


if __name__ == "__main__":
    cpi_briefing()
```

With `latest_n=13` there's no prior-year YoY, so the briefing has one sentence. The code handles missing inputs explicitly instead of crashing. `@flow(name="cpi-briefing")` sets a stable, readable name in the UI.

</details>

### Day 51 checklist
- [ ] I can explain flows, tasks, runs, states, parameters and subflows
- [ ] Prefect is installed, the local server runs, and I can browse runs in the UI from Codespaces
- [ ] I can turn functions into flows and tasks, and read the dynamic dependency graph
- [ ] I choose sensible task boundaries (one external interaction or meaningful stage per task)
- [ ] Flow parameters are typed, validated and recorded
- [ ] I log with `get_run_logger()` at appropriate levels

```bash
git add orchestration requirements.txt
git commit -m "Day 51: Prefect flows, tasks, parameters, logging"
git push
```

---

# DAY 52 — Local Orchestration

| Time | Block |
|---|---|
| 0:00 – 0:40 | 52.1 Dependencies: data vs `wait_for` |
| 0:40 – 1:40 | 52.2 Concurrency: `submit`, `map` and futures |
| 1:40 – 1:55 | Break |
| 1:55 – 2:35 | 52.3 Subflows: structuring a large workflow |
| 2:35 – 3:30 | 52.4 Wrapping existing tools as tasks |
| 3:30 – 3:45 | Break |
| 3:45 – 4:10 | 52.5 Inspecting runs from the command line |
| 4:10 – 5:00 | 52.6 Mini-project: `daily_refresh` v1 |

---

## 52.1 Dependencies: Data vs `wait_for` (40 min)

Prefect infers dependencies from **data**: if a task receives another task's output, it runs after it. But some steps depend on each other **without passing data**:

> *dbt must run after the StatCan tables are published, but it doesn't take their output as a Python argument. It reads the warehouse.*

For these **side-effect dependencies**, use `wait_for`:

```python
from prefect import flow, task


@task
def publish_statcan_tables():
    print("publishing raw tables…")          # writes to DuckDB; returns nothing useful


@task
def dbt_build():
    print("running dbt…")                    # reads DuckDB


@flow(log_prints=True)
def ordering_demo():
    published = publish_statcan_tables.submit()
    dbt_build.submit(wait_for=[published]).wait()


if __name__ == "__main__":
    ordering_demo()
```

(`.submit()` and futures are explained in the next block. For now, read `wait_for=[published]` as "don't start before `published` has finished".)

| Dependency type | Expressed by | Example |
|---|---|---|
| **data** | passing a task's output as input | `yoy = year_over_year(levels)` |
| **side effect** | `wait_for=[...]` | dbt after publish; GX after dbt |

> Most of our pipeline steps communicate **through the warehouse**, not through Python values. That's normal for data platforms, and it's why `wait_for` will appear often.

---

## 52.2 Concurrency: `submit`, `map` and Futures (60 min)

Calling a task directly (`fetch(x)`) runs it and **waits** for the result. That's sequential. Many of our steps are independent **API calls** that spend most of their time waiting on the network. Running them **concurrently** saves time.

| Call style | Behaviour | Returns |
|---|---|---|
| `my_task(x)` | run now, wait | the result |
| `my_task.submit(x)` | start in the background, continue immediately | a **future** |
| `my_task.map([x1, x2, x3])` | submit once per item | a list of futures |

A **future** is a placeholder for a result that isn't ready yet. Call `.result()` to wait for it and get the value, or `.wait()` to just wait.

Create `orchestration/flows/concurrency_demo.py`:

```python
import time

import requests
from prefect import flow, get_run_logger, task
from prefect.task_runners import ThreadPoolTaskRunner

SERIES = ["V39079", "FXCADUSD", "BD.CDN.2YR.DQ.YLD", "BD.CDN.5YR.DQ.YLD", "BD.CDN.10YR.DQ.YLD"]


@task
def fetch_valet(series_id: str, recent: int = 250) -> int:
    r = requests.get(f"https://www.bankofcanada.ca/valet/observations/{series_id}/json",
                     params={"recent": recent}, timeout=30)
    r.raise_for_status()
    n = len(r.json().get("observations", []))
    get_run_logger().info(f"{series_id}: {n} observations")
    return n


@flow
def sequential(series: list[str] = SERIES) -> int:
    return sum(fetch_valet(s) for s in series)


@flow(task_runner=ThreadPoolTaskRunner(max_workers=5))
def concurrent(series: list[str] = SERIES) -> int:
    futures = fetch_valet.map(series)            # five task runs start together
    return sum(futures.result())                 # wait for all, collect results


if __name__ == "__main__":
    for f in (sequential, concurrent):
        t0 = time.perf_counter()
        total = f()
        print(f"{f.name:<12} {total} observations in {time.perf_counter() - t0:.1f}s")
```

```bash
python -m orchestration.flows.concurrency_demo
```

Compare the timings, and in the UI compare the two flows' timelines: bars one after another vs bars overlapping.

- **`ThreadPoolTaskRunner(max_workers=5)`** decides *how* submitted tasks run: here, up to five at once in threads. Threads suit **I/O-bound** work (waiting on networks or disks).
- **`futures.result()`** on a list of futures waits for all of them and returns their results in order.

### When concurrency hurts

| Good candidates | Bad candidates |
|---|---|
| independent API calls to **different** providers | many calls to **one** provider (rate limits, Day 29) |
| independent read-only queries | anything that **writes to DuckDB** (one writer at a time!) |
| steps that wait on the network | CPU-heavy pandas work (threads don't speed it up) |

For our pipeline: BoC, FRED and StatCan **fetches** could overlap, but every **load into `macro.duckdb`** must be sequential. That's why Day 50's design keeps writing, auditing and publishing strictly in order. Days 54–57 add **concurrency limits** so that "only one DuckDB writer at a time" is enforced by Prefect rather than by discipline.

> **Always resolve your futures.** If a flow submits tasks and never calls `.result()` or `.wait()`, it may finish before they do, and their failures may go unnoticed. Make waiting explicit.

### Try it 52.2

Change `max_workers` to 2 and re-run `concurrent`. Predict the duration first. Then think about a polite `max_workers` for 30 series from **one** provider, and why.

<details>
<summary>Answer</summary>

With 2 workers, the five calls run in three waves (2 + 2 + 1), so the time is roughly three single-call durations. For 30 series from one provider, a small number (2–4) plus the throttle from Day 29 is polite. The bottleneck we must respect is the **provider's** capacity, not our CPU.

</details>

---

## 52.3 Subflows: Structuring a Large Workflow (40 min)

A **subflow** is simply a flow called from inside another flow. It appears in the UI as a **nested run**, with its own tasks, logs and state.

```python
from prefect import flow, task


@task
def step(name: str):
    print(f"running {name}")


@flow(log_prints=True)
def ingest():
    step("ingest API series")
    step("WAP StatCan tables")


@flow(log_prints=True)
def transform():
    step("dbt build")


@flow(log_prints=True)
def quality():
    step("GX warehouse checkpoints")


@flow(name="daily-refresh-skeleton", log_prints=True)
def daily_refresh_skeleton():
    ingest()
    transform()
    quality()


if __name__ == "__main__":
    daily_refresh_skeleton()
```

In the UI, the parent run contains three child flow runs, each expandable.

Use subflows when:
- a group of tasks forms a **meaningful stage** (ingest, transform, quality);
- the stage should be runnable **on its own** (e.g. re-run only `quality` after fixing a threshold);
- you want **separate state and logs** per stage.

| Structure | Use for |
|---|---|
| task | one step: one API, one tool call |
| subflow | one stage: several related tasks, independently runnable |
| parent flow | the end-to-end process |

This mirrors the architecture you've built: extract/load (Module 3), transform (Module 4), quality (Module 5).

---

## 52.4 Wrapping Existing Tools as Tasks (55 min)

Our pipeline steps already exist as scripts and CLIs, each with a meaningful **exit code** (Days 10, 30, 46, 50):

| Step | Command | Environment | Exit codes |
|---|---|---|---|
| API ingestion | `python ingest.py --only boc,fred,statcan` | `.venv` | 0 ok · 2 partial · 1 failed |
| StatCan tables (WAP) | `python ingest_statcan_tables.py` | `.venv` (+ GX subprocess) | 0 ok · 2 warnings/quarantine · 1 all quarantined |
| Transform | `dbt build --target prod` | `.venv` | 0 ok · non-zero failed |
| Warehouse quality | `quality/run_quality.sh` | `.venv-gx` | 0 ok · 2 warnings · 1 critical |

### Should we call the Python code directly, or run the scripts?

| Call Python functions in-process | Run as a subprocess |
|---|---|
| richer integration (return values, exceptions) | works for **any** tool and any environment (GX in `.venv-gx`, shell scripts) |
| shares one process, **and one DuckDB lock** | each step has its own process, so locks are released when it exits |
| needs all libraries in one environment | each step keeps its own environment |

Given Day 50's lesson (separate processes release DuckDB cleanly) and the separate GX environment, we wrap **each pipeline step as a subprocess task**. It's reliable, and it reuses the exit-code conventions you already designed.

### Central settings

Create `orchestration/settings.py`:

```python
"""Paths and interpreters used by the orchestration layer."""
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
VENV_PY = sys.executable                                   # .venv (Prefect, dlt, dbt)
VENV_BIN = Path(sys.executable).parent
GX_PY = str(REPO / ".venv-gx" / "bin" / "python")
DBT = str(VENV_BIN / "dbt")
DBT_DIR = REPO / "macro_dbt"

ENV = {
    **os.environ,
    "MACRO_DUCKDB_PATH": os.environ.get("MACRO_DUCKDB_PATH", str(REPO / "macro.duckdb")),
    "MACRO_DUCKDB_URL": os.environ.get("MACRO_DUCKDB_URL", f"duckdb:///{REPO / 'macro.duckdb'}"),
}
```

`sys.executable` is the Python interpreter currently running, the `.venv` one. So `ingest.py` runs with exactly the libraries Prefect sees.

### The generic step task

Create `orchestration/tasks/commands.py`:

```python
"""Run pipeline steps (scripts, CLIs) as observable Prefect tasks."""
import subprocess
import time

from prefect import get_run_logger, task

from orchestration.settings import ENV, REPO


@task(tags=["pipeline-step"])
def run_step(name: str, cmd: list[str], cwd: str | None = None) -> dict:
    """Run one command; stream its output into Prefect logs; return exit code and duration."""
    logger = get_run_logger()
    logger.info(f"▶ {name}: {' '.join(cmd)}")
    t0 = time.perf_counter()

    proc = subprocess.Popen(cmd, cwd=cwd or REPO, env=ENV, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for line in proc.stdout:                           # stream output line by line
        logger.info(f"[{name}] {line.rstrip()}")
    code = proc.wait()

    duration = round(time.perf_counter() - t0, 1)
    logger.info(f"■ {name}: exit code {code} after {duration}s")
    return {"step": name, "exit_code": code, "duration_s": duration}
```

- **`subprocess.Popen` + iterating `proc.stdout`** streams output **as it happens**, so a long dbt build shows progress in the UI instead of one burst at the end.
- `stderr=subprocess.STDOUT` merges error output into the same stream.
- The task **doesn't decide** what an exit code means. It reports it. Interpretation belongs to the flow's **state policy** (Day 53).

---

## 52.5 Inspecting Runs from the Command Line (25 min)

The UI is convenient, but the CLI is scriptable and works over SSH:

```bash
prefect flow-run ls --limit 5                 # recent runs with state and duration
prefect flow-run inspect <flow-run-id>        # full details of one run
prefect flow-run logs <flow-run-id>           # its log lines
```

(Copy an ID from `ls` or from the UI.) Each run records its **parameters**, **start/end times**, **state**, **state message** and **task runs**, the audit trail from 51.1.

---

## 52.6 Mini-Project: `daily_refresh` v1 (50 min)

Rebuild `pipeline.sh` as a flow with **subflows** per stage, using `run_step`. Today, keep `pipeline.sh`'s behaviour: tolerate exit code 2 from ingestion; stop on anything else. Tomorrow we replace this with an explicit state policy.

Create `orchestration/flows/daily_refresh.py`:

```python
"""Daily macro refresh — v1: pipeline.sh as a Prefect flow (Day 52)."""
from prefect import flow, get_run_logger

from orchestration.settings import DBT, DBT_DIR, GX_PY, VENV_PY
from orchestration.tasks.commands import run_step


def require(result: dict, allowed=(0,)):
    """Mimic pipeline.sh: raise unless the exit code is allowed."""
    if result["exit_code"] not in allowed:
        raise RuntimeError(f"{result['step']} failed with exit code {result['exit_code']}")
    return result


@flow(name="ingest")
def ingest_flow() -> list[dict]:
    api = require(run_step("ingest_api", [VENV_PY, "ingest.py", "--only", "boc,fred,statcan"]),
                  allowed=(0, 2))
    wap = require(run_step("wap_statcan_tables", [VENV_PY, "ingest_statcan_tables.py"]),
                  allowed=(0, 2))
    return [api, wap]


@flow(name="transform")
def transform_flow() -> list[dict]:
    deps = require(run_step("dbt_deps", [DBT, "deps", "--quiet"], cwd=str(DBT_DIR)))
    build = require(run_step("dbt_build", [DBT, "build", "--target", "prod"], cwd=str(DBT_DIR)))
    docs = require(run_step("dbt_docs", [DBT, "docs", "generate", "--target", "prod"],
                            cwd=str(DBT_DIR)))
    return [deps, build, docs]


@flow(name="quality")
def quality_flow() -> list[dict]:
    return [require(run_step("gx_warehouse", ["bash", "quality/run_quality.sh"]),
                    allowed=(0, 2))]


@flow(name="daily-refresh")
def daily_refresh() -> list[dict]:
    logger = get_run_logger()
    results = ingest_flow() + transform_flow() + quality_flow()
    for r in results:
        logger.info(f"{r['step']:<22} exit {r['exit_code']}  {r['duration_s']:>7.1f}s")
    return results


if __name__ == "__main__":
    daily_refresh()
```

`GX_PY` isn't used yet: `run_quality.sh` activates `.venv-gx` itself. We'll use it on Day 53 for finer-grained quality steps.

Run it (the full refresh takes a while: dlt, the WAP audit and dbt all run for real):

```bash
python -m orchestration.flows.daily_refresh
```

In the UI, open the `daily-refresh` run: three subflows, eight step tasks, a timeline showing **where the time goes**, and every line of every tool's output in the logs. Compare that with scrolling through `pipeline.sh` output in a terminal.

### Try it 52.6

1. From the timeline, which step dominates the runtime? Is that what you expected?
2. The API ingestion (BoC, FRED, StatCan vectors) is one step. Could it be split into three **concurrent** steps? What would stop you? (Hint: where does each provider's data get **written**?)

<details>
<summary>Discussion</summary>

1. Usually the StatCan full-table download (when a table was republished) or `dbt build` dominates. On days with no new StatCan release, WAP is fast thanks to change detection (Day 30).
2. Fetching could overlap, but `ingest.py` also **writes** each source into `macro.duckdb`, and DuckDB allows one writer. Splitting safely would mean fetching concurrently but loading sequentially, a change to the ingestion code, not just the flow. That's a good example of the orchestrator exposing an architectural constraint.

</details>

### Day 52 checklist
- [ ] I distinguish data dependencies from side-effect dependencies (`wait_for`)
- [ ] I can run tasks concurrently with `submit`/`map`, resolve futures, and know when concurrency is unsafe (DuckDB writes)
- [ ] I structure large workflows with subflows per stage
- [ ] Existing scripts and CLIs run as streamed, observable subprocess tasks with exit codes
- [ ] `daily_refresh` v1 reproduces `pipeline.sh`, with full visibility in the UI

```bash
git add orchestration && git commit -m "Day 52: concurrency, subflows, daily_refresh v1" && git push
```

---

# DAY 53 — State Management

| Time | Block |
|---|---|
| 0:00 – 0:45 | 53.1 The state model |
| 0:45 – 1:30 | 53.2 Inspecting states without crashing: `return_state=True` |
| 1:30 – 1:45 | Break |
| 1:45 – 2:30 | 53.3 Custom states: *Completed with warnings* |
| 2:30 – 3:20 | 53.4 A written state policy, implemented in code |
| 3:20 – 3:35 | Break |
| 3:35 – 4:05 | 53.5 State hooks: alerts on failure |
| 4:05 – 4:35 | 53.6 Artifacts: a run report economists can read |
| 4:35 – 5:00 | 53.7 Capstone: `daily_refresh` v2 and failure drills |

---

## 53.1 The State Model (45 min)

Every flow run and task run moves through **states**. The **state type** says where it is; the **state name** can add detail; the **message** explains why.

```
Scheduled ──► Pending ──► Running ──┬──► Completed      (success; name may be "Cached", or custom)
                                    ├──► Failed         (the code raised an error, or returned a Failed state)
                                    ├──► Crashed        (the process died: killed, out of memory, infrastructure)
                                    └──► Cancelled      (someone or something stopped it)
                          (Retrying is a Running state named "Retrying": Days 54–57)
```

| Type | Meaning | Our pipeline example |
|---|---|---|
| **Completed** | finished as intended | dbt build succeeded |
| **Failed** | finished, but the work didn't succeed | GX critical checkpoint failed |
| **Crashed** | the run couldn't finish at all | Codespace restarted mid-run |
| **Cancelled** | stopped deliberately | you cancelled a backfill from the UI |

### How a flow's final state is decided

A flow's final state follows from **what happens inside it**:

1. If the flow **raises** an exception (including an unhandled task failure) → **Failed**.
2. If the flow **returns a state object** → that state.
3. Otherwise → **Completed**.

Point 2 is the key to today: **you can choose the final state explicitly**, based on your own rules.

### Try it 53.1

In `cpi_briefing.py`, change the vector ID to a non-existent one (e.g. `999999999`) and run the flow. Which task fails, what's its state message, and what's the flow's final state? Why didn't `compute_measures` run at all? Restore the ID.

<details>
<summary>Answer</summary>

`fetch_cpi` fails with the `RuntimeError` about StatCan's status (Day 28: HTTP 200 but `FAILED` inside). Its exception propagates into the flow, so the flow is **Failed** too. `compute_measures` never runs because its input never existed. Prefect shows **no** run for it, rather than a failed one, which correctly signals "not attempted".

</details>

---

## 53.2 Inspecting States Without Crashing: `return_state=True` (45 min)

By default, calling a failed task **raises** inside the flow, which ends the flow. Often you want to **look at the outcome and decide**. Pass `return_state=True`:

```python
from prefect import flow, task


@task
def fragile(x: int) -> int:
    if x < 0:
        raise ValueError("negative input")
    return x * 2


@flow(log_prints=True)
def state_demo():
    ok = fragile(2, return_state=True)
    bad = fragile(-1, return_state=True)

    for s in (ok, bad):
        print(f"type={s.type.value:<10} name={s.name:<10} failed={s.is_failed()}")

    print("ok result:", ok.result())
    print("bad result:", bad.result(raise_on_failure=False))   # the exception object, not raised
    print("bad message:", bad.message)


if __name__ == "__main__":
    state_demo()
```

| State method / attribute | Returns |
|---|---|
| `s.is_completed()`, `s.is_failed()`, `s.is_crashed()` | booleans |
| `s.type` | `COMPLETED`, `FAILED`, … |
| `s.name` | display name (`"Completed"`, `"Failed"`, or custom) |
| `s.message` | human-readable explanation |
| `s.result()` | the task's return value (raises if failed) |
| `s.result(raise_on_failure=False)` | the value, or the exception if failed |

The flow above ends **Completed**: it handled the failure itself. Whether that's right depends on your **policy**, which we'll write explicitly in 53.4.

---

## 53.3 Custom States: *Completed with Warnings* (45 min)

Our tools have a middle outcome that plain Completed/Failed can't express: **exit code 2**, meaning "done, but look at this" (partial ingestion, quarantined release, GX warnings). Prefect lets a task or flow **return a state** with a **custom name** and **message**:

```python
from prefect.states import Completed, Failed

Completed(message="all checks passed")
Completed(name="CompletedWithWarnings", message="GX warnings: L32 revisions > 0.3pp")
Failed(message="critical GX failure: L01 rate out of range")
```

The **type** remains `COMPLETED` or `FAILED`, so everything that depends on success still works correctly. The **name** shows up in the UI, so a warning run is visibly different from a clean one.

### A step task that interprets its exit code

Add to `orchestration/tasks/commands.py`:

```python
from prefect.states import Completed, Failed

WARNING = "CompletedWithWarnings"


@task(tags=["pipeline-step"])
def run_step_with_state(name: str, cmd: list[str], cwd: str | None = None,
                        warning_codes: tuple[int, ...] = (2,)):
    """Like run_step, but returns a State that encodes our exit-code convention."""
    result = run_step.fn(name, cmd, cwd)            # reuse the logic without a nested task run
    code, dur = result["exit_code"], result["duration_s"]
    if code == 0:
        return Completed(message=f"{name} ok ({dur}s)", data=result)
    if code in warning_codes:
        return Completed(name=WARNING, message=f"{name} finished with warnings ({dur}s)",
                         data=result)
    return Failed(message=f"{name} failed with exit code {code} ({dur}s)", data=result)
```

- **`run_step.fn(...)`** calls the **original function** behind a task decorator, without creating another task run. It's useful for reusing a task's logic inside another task.
- **`data=result`** attaches the step's dictionary to the state, so `state.result()` still returns it (for a Failed state, use `raise_on_failure=False`).

---

## 53.4 A Written State Policy, Implemented in Code (50 min)

Before coding, **write the policy down**. It's a decision about data risk, and should be reviewable by non-engineers, just like the quality plan (Day 41).

### `orchestration/STATE_POLICY.md`

```markdown
# Daily refresh — state policy

| Step | Completed | CompletedWithWarnings | Failed | Downstream if not Completed |
|------|-----------|-----------------------|--------|-----------------------------|
| ingest_api | ok | some series failed (exit 2) | nothing loaded (exit 1) | CONTINUE: warehouse keeps last good data |
| wap_statcan_tables | ok | warnings or some table quarantined (exit 2) | all changed tables quarantined (exit 1) | CONTINUE: only published data is used |
| dbt_build | ok | — | models or tests failed | STOP transform; SKIP quality; flow FAILED |
| gx_warehouse | ok | warnings (exit 2) | critical failure (exit 1) | flow FAILED: marts must not be used |

## Final flow state
- FAILED if: dbt_build failed, gx_warehouse critical, or ingestion failed completely
  (dashboards keep yesterday's consistent data, but a human must act).
- COMPLETED WITH WARNINGS if any step ended with warnings.
- COMPLETED otherwise.
```

Why continue after an ingestion failure? Thanks to incremental loading (Day 27) and WAP (Day 50), the warehouse is **consistent** even when today's ingestion fails. Rebuilding dbt keeps marts coherent and lets GX report staleness. But the run must still end **Failed**, so someone investigates.

### The flow, following the policy

Replace `orchestration/flows/daily_refresh.py`:

```python
"""Daily macro refresh — v2: explicit state policy (Day 53)."""
from prefect import flow, get_run_logger
from prefect.states import Completed, Failed

from orchestration.settings import DBT, DBT_DIR, VENV_PY
from orchestration.tasks.commands import WARNING, run_step_with_state


def outcome(state) -> str:
    """Collapse a state into 'ok' | 'warning' | 'failed'."""
    if state.is_failed() or state.is_crashed():
        return "failed"
    return "warning" if state.name == WARNING else "ok"


@flow(name="ingest")
def ingest_flow() -> dict:
    return {
        "ingest_api": run_step_with_state(
            "ingest_api", [VENV_PY, "ingest.py", "--only", "boc,fred,statcan"],
            return_state=True),
        "wap_statcan_tables": run_step_with_state(
            "wap_statcan_tables", [VENV_PY, "ingest_statcan_tables.py"], return_state=True),
    }


@flow(name="transform")
def transform_flow() -> dict:
    states = {"dbt_deps": run_step_with_state("dbt_deps", [DBT, "deps", "--quiet"],
                                              cwd=str(DBT_DIR), return_state=True)}
    if outcome(states["dbt_deps"]) == "failed":
        return states
    states["dbt_build"] = run_step_with_state("dbt_build", [DBT, "build", "--target", "prod"],
                                              cwd=str(DBT_DIR), warning_codes=(),
                                              return_state=True)
    if outcome(states["dbt_build"]) != "failed":
        states["dbt_docs"] = run_step_with_state("dbt_docs",
                                                 [DBT, "docs", "generate", "--target", "prod"],
                                                 cwd=str(DBT_DIR), return_state=True)
    return states


@flow(name="quality")
def quality_flow() -> dict:
    return {"gx_warehouse": run_step_with_state(
        "gx_warehouse", ["bash", "quality/run_quality.sh"], return_state=True)}


@flow(name="daily-refresh")
def daily_refresh():
    logger = get_run_logger()
    states = {}

    states.update(ingest_flow())                        # CONTINUE regardless (policy)
    states.update(transform_flow())

    if outcome(states.get("dbt_build", states["dbt_deps"])) == "failed":
        logger.error("dbt failed — skipping warehouse quality checks (policy)")
    else:
        states.update(quality_flow())

    summary = {name: outcome(s) for name, s in states.items()}
    for name, o in summary.items():
        logger.info(f"{name:<22} {o}")

    fatal = [n for n, o in summary.items() if o == "failed"
             and n in ("dbt_deps", "dbt_build", "gx_warehouse")]
    ingestion_dead = summary.get("ingest_api") == "failed" and \
                     summary.get("wap_statcan_tables") == "failed"
    warnings = [n for n, o in summary.items() if o != "ok"]

    if fatal or ingestion_dead:
        return Failed(message=f"Policy: FAILED — {fatal or ['all ingestion']}. See STATE_POLICY.md",
                      data=summary)
    if warnings:
        return Completed(name=WARNING, message=f"Warnings in: {warnings}", data=summary)
    return Completed(message="All steps completed cleanly", data=summary)


if __name__ == "__main__":
    daily_refresh()
```

Compare with `pipeline.sh`: every `|| [ $? -eq 2 ]` and `set +e` is replaced by a **named, documented decision** in Python. The flow's final state and message tell anyone opening the UI exactly what happened and why.

> **Why do subflows return dictionaries of states** instead of raising? Because the parent flow owns the policy. Subflows **report**; the parent **decides**. That separation keeps each stage reusable, so `quality_flow()` can run alone without dragging along the parent's rules.

---

## 53.5 State Hooks: Alerts on Failure (30 min)

A **state hook** is a function Prefect calls when a run **enters** a given state. It's the natural place for notifications, and it replaces the alert calls scattered through `pipeline.sh`.

```python
from macro_ingest.resilience import notify          # Day 29's single alert channel


def alert_on_failure(flow, flow_run, state):
    notify(f"⛔ {flow.name} run '{flow_run.name}' {state.name}: {state.message}")


def alert_on_warnings(flow, flow_run, state):
    if state.name == "CompletedWithWarnings":
        notify(f"⚠ {flow.name} run '{flow_run.name}': {state.message}")


@flow(name="daily-refresh",
      on_failure=[alert_on_failure],
      on_crashed=[alert_on_failure],
      on_completion=[alert_on_warnings])
def daily_refresh():
    ...
```

| Hook | Called when the run… |
|---|---|
| `on_completion` | reaches any Completed state (including custom names) |
| `on_failure` | reaches Failed |
| `on_crashed` | crashes (process killed, infrastructure failure) |
| `on_cancellation` | is cancelled |

Tasks accept hooks too (`@task(on_failure=[...])`, with the signature `(task, task_run, state)`), but for our pipeline **one flow-level alert** that summarises everything beats one alert per step. That's the same alert-fatigue lesson as Day 29.

> Hooks must never crash the flow themselves. `notify()` (Day 29) already catches its own errors, so a broken webhook can't turn a warning into a failure.

---

## 53.6 Artifacts: A Run Report Economists Can Read (30 min)

**Artifacts** are rich outputs attached to a run and shown in the UI: tables, Markdown reports and links. They turn a run from "green or red" into **evidence**.

Create `orchestration/tasks/reporting.py`:

```python
"""Artifacts: a step table and a Markdown briefing for each refresh."""
import duckdb
from prefect import task
from prefect.artifacts import create_markdown_artifact, create_table_artifact

from orchestration.settings import ENV


@task
def publish_step_table(summary: dict, durations: dict):
    rows = [{"step": s, "outcome": o, "duration_s": durations.get(s)}
            for s, o in summary.items()]
    create_table_artifact(key="daily-refresh-steps", table=rows,
                          description="Outcome and duration of each pipeline step")


@task
def publish_briefing():
    """Latest KPIs (Day 39) and data-quality status (Day 50) as a Markdown report."""
    with duckdb.connect(ENV["MACRO_DUCKDB_PATH"], read_only=True) as con:
        kpis = con.sql("""select pillar, kpi, round(value, 2) as value, as_of, signal
                          from marts.macro_kpis order by pillar, kpi""").fetchall()
        quality = con.sql("""select checkpoint, pct_passing, failures
                             from marts.quality_latest order by checkpoint""").fetchall()

    lines = ["# Canadian macro briefing", "", "| Pillar | KPI | Value | As of | Signal |",
             "|---|---|---|---|---|"]
    lines += [f"| {p} | {k} | {v} | {a} | {s} |" for p, k, v, a, s in kpis]
    lines += ["", "## Data quality (latest GX runs)", "", "| Checkpoint | % passing | Failures |",
              "|---|---|---|"]
    lines += [f"| {c} | {pct} | {f} |" for c, pct, f in quality]
    create_markdown_artifact(key="macro-briefing", markdown="\n".join(lines),
                             description="KPIs and data quality after this refresh")
```

Call both from the end of `daily_refresh` (before returning the final state), when the transform succeeded:

```python
    def step_data(state):
        data = state.result(raise_on_failure=False)
        return data if isinstance(data, dict) else {}

    durations = {n: step_data(s).get("duration_s") for n, s in states.items()}
    publish_step_table(summary, durations)
    if summary.get("dbt_build") != "failed":
        publish_briefing()
```

In the UI, open **Artifacts** (or the run's *Artifacts* tab): the step table, and a formatted briefing with every KPI, its date and its signal, plus the quality pass rates. Artifacts with the same **key** form a **history**, so you can page back through yesterday's briefing.

> The briefing opens the warehouse **read-only** and runs **after** all writers have finished, so it never competes for the DuckDB lock.

---

## 53.7 Capstone: `daily_refresh` v2 and Failure Drills (25 min)

Assemble the pieces: state policy (53.4), hooks (53.5) and artifacts (53.6). Then **prove the policy works** without breaking real systems, by adding a drill parameter that overrides exit codes.

### A drill parameter

In `run_step_with_state`, accept an optional `force_exit: int | None = None`. If set, skip the real command and pretend it exited with that code:

```python
    if force_exit is not None:
        get_run_logger().warning(f"DRILL: {name} forced to exit {force_exit}")
        result = {"step": name, "exit_code": force_exit, "duration_s": 0.0}
    else:
        result = run_step.fn(name, cmd, cwd)
```

and add a flow parameter `drill: dict[str, int] | None = None`, passing `force_exit=(drill or {}).get(step_name)` to each step.

### Run the drills

```python
from orchestration.flows.daily_refresh import daily_refresh

daily_refresh(drill={"ingest_api": 2})                  # expect CompletedWithWarnings, warning alert
daily_refresh(drill={"wap_statcan_tables": 1})          # expect CompletedWithWarnings (one ingestion path failed)
daily_refresh(drill={"ingest_api": 1, "wap_statcan_tables": 1})   # expect Failed (all ingestion)
daily_refresh(drill={"dbt_build": 1})                   # expect Failed; quality skipped
daily_refresh(drill={"gx_warehouse": 1})                # expect Failed (critical quality)
daily_refresh(drill={"gx_warehouse": 2})                # expect CompletedWithWarnings
```

Record the results in `orchestration/DRILL_RESULTS.md`:

| Drill | Expected final state | Observed | Alert sent? | Downstream behaviour correct? |
|---|---|---|---|---|
| ingest_api = 2 | CompletedWithWarnings | | | |
| … | | | | |

A policy that hasn't been drilled is a hope, the same lesson as Day 50's fault injection, now at the orchestration level.

### Recap: Days 51–53

| Concept | You built |
|---|---|
| flows & tasks | tracked, logged, observable steps with typed parameters |
| dynamic dependencies | data dependencies and `wait_for` for side effects |
| concurrency | `submit`/`map` with a thread-pool runner, and the DuckDB single-writer constraint |
| subflows | ingest / transform / quality stages, runnable alone |
| wrapping tools | streamed subprocess tasks for dlt, WAP, dbt and GX |
| states | `return_state=True`, custom *CompletedWithWarnings*, explicit final states |
| policy | `STATE_POLICY.md`, implemented and drilled |
| observability | hooks for alerts; artifacts for step tables and an economist-readable briefing |

### Looking ahead: Days 54–57

- **Retries** with backoff per task (a flaky FRED call retries alone, not the whole refresh).
- **Caching**, so re-running a flow skips steps whose inputs haven't changed.
- **Scheduling** and **deployments**: run `daily-refresh` automatically, with parameters, from a worker.
- **Logging** in depth, and **concurrency limits** that enforce "one DuckDB writer at a time".

### Day 53 checklist
- [ ] I can describe the state lifecycle and how a flow's final state is determined
- [ ] I inspect task outcomes with `return_state=True` and handle failures deliberately
- [ ] Exit codes map to Completed, *CompletedWithWarnings* and Failed states
- [ ] A written state policy is implemented in the parent flow; subflows report, the parent decides
- [ ] Hooks send one summarising alert per run; artifacts publish a step table and a macro briefing
- [ ] Drills prove every row of the state policy behaves as documented

```bash
git add orchestration && git commit -m "Day 53: state policy, custom states, hooks, artifacts, drills" && git push
```
