# Module 6 · Pipeline Orchestration with Prefect
## Days 54–57: Retries, Caching, Scheduling and Logging

**Audience:** MSc Economics students who completed Days 1–53
**Environment:** GitHub Codespaces · `.venv` (Prefect, dlt, dbt) · `.venv-gx` · local Prefect server on port 4200 · `macro.duckdb`
**Time per day:** ~2.5 hours (including breaks and exercises)
**Goal by end of Day 57:** `daily-refresh` runs **by itself** on a schedule aligned with Bank of Canada and Statistics Canada publication times. Transient failures are **retried** (only those that time can fix), unchanged work is **skipped** through caching and data fingerprints, and no two runs ever fight over the DuckDB lock. Every run leaves structured **logs** and a queryable **run history**, and a **watchdog** flow alerts when the refresh silently stops happening.

---

### Where we are

After Day 53, `daily-refresh` is a Prefect flow with subflows (ingest → transform → quality), an explicit **state policy** (Completed / CompletedWithWarnings / Failed), hooks and artifacts. But:

| Still manual or fragile | Fixed on |
|---|---|
| a single network blip fails a step for the whole day | **Day 54**: retries, timeouts |
| re-running repeats expensive work even when nothing changed | **Day 55**: caching, fingerprints |
| someone has to start every run | **Day 56**: schedules, deployments, workers |
| logs are unstructured; secrets live in env vars; runs could overlap; nobody notices if runs stop | **Day 57**: logging, secrets, concurrency limits, run history, watchdog |

### Target structure (by end of Day 57)

```
macro-data-course/
├── prefect.yaml                       ← NEW: deployments, schedules, work pool
├── orchestration/
│   ├── settings.py                    ← + STEP_POLICIES (retries, timeouts, writers)
│   ├── tasks/
│   │   ├── commands.py                ← run_policy_step(): retries, timeouts, concurrency
│   │   ├── fingerprints.py            ← NEW: content fingerprints of the warehouse
│   │   ├── history.py                 ← NEW: run history to Parquet
│   │   └── reporting.py
│   └── flows/
│       ├── daily_refresh.py           ← v3
│       ├── cpi_briefing.py            ← cached fetches
│       ├── watchdog.py                ← NEW: "did the refresh actually run?"
│       └── serve_local.py             ← NEW: quick scheduling with serve()
└── data/orchestration/runs/*.parquet  ← NEW: run history (not committed)
```

Keep the Prefect server running in a second terminal (`prefect server start --host 0.0.0.0`, Day 51).

---

# DAY 54 — Retries and Timeouts

| Time | Block |
|---|---|
| 0:00 – 0:20 | 54.1 Where should retries live? |
| 0:20 – 0:45 | 54.2 Task retries: counts, delays, backoff, jitter |
| 0:45 – 0:53 | Break |
| 0:53 – 1:20 | 54.3 Retrying only what time can fix |
| 1:20 – 1:40 | 54.4 Exit codes are an API: fixing an ambiguity |
| 1:40 – 1:48 | Break |
| 1:48 – 2:05 | 54.5 Timeouts and retry budgets |
| 2:05 – 2:30 | 54.6 Mini-project: a per-step retry policy, drilled |

---

## 54.1 Where Should Retries Live? (20 min)

> **Question it answers:** If requests, steps and whole runs all retry, how many attempts could one failing request trigger?
>
> **Other questions you can answer the same way:**
> - Which level should handle a brief API outage?
> - Why is my failing run taking hours?

You already retry at one level: dlt's HTTP helper retries individual requests (Day 29). Adding Prefect retries creates **layers**, and layers **multiply**:

```
HTTP request retries (dlt, Day 29)     × 5 attempts per request
   inside a task (Prefect retries)     × 3 attempts per step
      inside a flow (flow retries)     × 2 attempts per run
                                       = up to 30 attempts at one failing request
```

| Level | Retries what | Good for | Our choice |
|---|---|---|---|
| **HTTP request** | one API call | brief blips, 429/5xx | keep (Day 29) |
| **Task (step)** | a whole pipeline step | an outage lasting minutes (provider maintenance) | **add today**, for transient failures only |
| **Flow** | the entire run | infrastructure hiccups (rare) | usually **no**: too coarse and expensive |

Principle: **each layer should cover a different timescale.** HTTP retries handle seconds; task retries handle minutes; the **schedule** (Day 56) handles hours, since tomorrow's run is the ultimate retry.

---

## 54.2 Task Retries: Counts, Delays, Backoff, Jitter (25 min)

> **Question it answers:** How do I retry a flaky step a few times, waiting longer between each attempt?
>
> **Other questions you can answer the same way:**
> - How often does a 30% failure rate still fail after three retries?

Create `orchestration/flows/retry_demo.py`:

```python
import random

from prefect import flow, get_run_logger, task
from prefect.runtime import task_run
from prefect.tasks import exponential_backoff


@task(retries=3,
      retry_delay_seconds=exponential_backoff(backoff_factor=2),   # 2s, 4s, 8s
      retry_jitter_factor=0.5)                                      # ±50% randomness
def flaky_fetch(p_fail: float = 0.6) -> str:
    logger = get_run_logger()
    attempt = task_run.run_count                   # 1 on the first try, 2 on the first retry, …
    logger.info(f"attempt {attempt}")
    if random.random() < p_fail:
        raise ConnectionError(f"simulated outage on attempt {attempt}")
    return f"succeeded on attempt {attempt}"


@flow(log_prints=True)
def retry_demo():
    print(flaky_fetch())


if __name__ == "__main__":
    random.seed(7)                                  # reproducible demo
    retry_demo()
```

```bash
python -m orchestration.flows.retry_demo
```

In the UI, the task run shows its state history: **Running → Retrying → Running → … → Completed** (or Failed if all attempts failed). Each attempt's logs are kept.

| Option | Meaning |
|---|---|
| `retries=3` | up to 3 **additional** attempts (4 in total) |
| `retry_delay_seconds=10` | wait 10 s between attempts |
| `retry_delay_seconds=[10, 60, 300]` | a different wait before each retry |
| `exponential_backoff(backoff_factor=b)` | waits of b, 2b, 4b, … seconds (Day 9's idea) |
| `retry_jitter_factor=0.5` | randomise each wait by up to ±50% |
| `prefect.runtime.task_run.run_count` | which attempt this is (1, 2, …) |

**Why jitter?** If many runs fail at the same moment (a provider outage at 08:30 ET), identical backoff would make them all retry at the same instant too, hammering the provider when it recovers. Randomness spreads them out.

### Changing retries per call

> **Question it answers:** How do I change the retry settings for one particular call only?
>
> **Other questions you can answer the same way:**
> - How do I run without retries while debugging?

A task's defaults can be overridden for one call, without redefining it:

```python
flaky_fetch.with_options(retries=0)(p_fail=0.6)                     # no retries this time
flaky_fetch.with_options(retries=5, retry_delay_seconds=1)(0.9)
```

We'll use `with_options` to give each pipeline step its own retry policy.

---

## 54.3 Retrying Only What Time Can Fix (28 min)

Day 29's rule, at the orchestration level: **retry transient failures; never retry deterministic ones.** A dbt model with a SQL error will fail identically on every attempt, and retrying only delays the alert.

| Step failure | Transient? | Retry? |
|---|---|---|
| API ingestion: nothing loaded (provider down) | usually yes | ✓ after a few minutes |
| StatCan download interrupted | yes | ✓ |
| StatCan release **quarantined** by GX (Day 50) | **no**: the data is bad | ✗ never |
| `dbt build` failed (SQL error, failing test) | no | ✗ |
| GX critical failure | no | ✗ |
| process crashed (out of memory, Codespace hiccup) | often | ✓ once |

Prefect decides whether to retry with a **`retry_condition_fn`**: a function that receives the failed state and returns `True` to retry.

### A transient-error type and a retry condition

> **Question it answers:** How do I retry only failures that waiting might fix, and not data errors?
>
> **Other questions you can answer the same way:**
> - Should a rejected StatCan release be retried? (No.)

Add to `orchestration/tasks/commands.py`:

```python
class TransientStepError(RuntimeError):
    """A step failed in a way that waiting might fix (outage, interrupted download)."""


def retry_if_transient(task, task_run, state) -> bool:
    """Retry only when the task failed with TransientStepError."""
    try:
        state.result()
    except TransientStepError:
        return True
    except Exception:
        return False
    return False
```

`state.result()` re-raises the exception that failed the task, so the `except` clauses **inspect its type**. Only `TransientStepError` triggers a retry.

### A step task that raises for transient codes

> **Question it answers:** How does a pipeline step decide from its exit code whether to retry, warn or fail?
>
> **Other questions you can answer the same way:**
> - Which exit codes count as temporary problems?

```python
from prefect.runtime import task_run as current_task_run
from prefect.states import Completed, Failed


@task(tags=["pipeline-step"], retry_condition_fn=retry_if_transient)
def run_policy_step(name: str, cmd: list[str], cwd: str | None = None,
                    warning_codes: tuple[int, ...] = (2,),
                    transient_codes: tuple[int, ...] = (),
                    drill: dict | None = None):
    """Run a step; raise TransientStepError (→ retried) or return a policy State."""
    logger = get_run_logger()
    attempt = current_task_run.run_count

    forced = (drill or {}).get(name)
    if forced is not None:                                  # drills (Day 53), now attempt-aware
        code = forced["code"] if attempt <= forced.get("attempts", 99) else 0
        logger.warning(f"DRILL: {name} attempt {attempt} forced to exit {code}")
        result = {"step": name, "exit_code": code, "duration_s": 0.0}
    else:
        result = run_step.fn(name, cmd, cwd)

    code = result["exit_code"]
    if code in transient_codes:
        raise TransientStepError(f"{name}: transient exit {code} on attempt {attempt}")
    if code == 0:
        return Completed(message=f"{name} ok", data=result)
    if code in warning_codes:
        return Completed(name=WARNING, message=f"{name} finished with warnings", data=result)
    return Failed(message=f"{name} failed with exit code {code}", data=result)
```

The drill format is now `{"ingest_api": {"code": 1, "attempts": 1}}`, meaning "exit 1 on the first attempt only", so you can watch a retry **succeed**.

---

## 54.4 Exit Codes Are an API: Fixing an Ambiguity (20 min)

Look closely at `ingest_statcan_tables.py` (Day 50):

| Exit code | Current meaning |
|---|---|
| 0 | everything published |
| 2 | published with warnings, or some tables quarantined |
| 1 | **all** changed tables quarantined |

But Python **also** exits with **1** when a script crashes with an unhandled exception, such as an interrupted download. So `1` means both "data rejected by quality checks" (never retry) and "the script crashed" (retry). The orchestrator can't tell them apart.

> **Exit codes are an interface between programs.** Like a function's return type, they deserve a documented design. Ambiguity here directly causes wrong operational decisions.

### The fix

> **Question it answers:** How do I tell "all tables were quarantined" apart from "the download failed"?
>
> **Other questions you can answer the same way:**
> - Why was a quarantined release being retried?

Give quarantine its own code. In `ingest_statcan_tables.py`, change the end of `main()`:

```python
    if quarantined and not published:
        return 3          # 3 = all changed tables quarantined (data rejected; not transient)
    if quarantined or warned:
        return 2
    return 0
```

Document the convention for every script in `orchestration/EXIT_CODES.md`:

```markdown
| Script | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| ingest.py | ok | nothing loaded / crash (transient) | partial | — |
| ingest_statcan_tables.py | ok | crash, e.g. download failure (transient) | warnings or partial quarantine | all quarantined (NOT transient) |
| dbt build | ok | models or tests failed | — | — |
| quality/run_quality.sh | ok | critical failure | warnings | — |
```

And update `orchestration/STATE_POLICY.md` (Day 53) so that WAP code 3 counts as **failed** for the policy but is **never** retried.

---

## 54.5 Timeouts and Retry Budgets (18 min)

### Timeouts

> **Question it answers:** How do I stop a step that hangs (a stalled download, a locked database) after a set time?
>
> **Other questions you can answer the same way:**
> - What is a sensible time limit for each step?

A step that **hangs** (a stalled download, a locked database) is worse than one that fails, because nothing alerts until someone notices. Give every step a **timeout**:

```python
run_policy_step.with_options(timeout_seconds=1800)(...)     # fail after 30 minutes
```

A timed-out task enters a **Failed** state named **TimedOut**. Whether it's retried depends on the retry condition. Our condition only retries `TransientStepError`, so to retry timeouts too, extend it:

```python
def retry_if_transient(task, task_run, state) -> bool:
    if state.name == "TimedOut":
        return True
    try:
        state.result()
    except TransientStepError:
        return True
    except Exception:
        return False
    return False
```

(Timeouts stop the **task** from waiting. Make sure the underlying subprocess also stops, e.g. by giving `ingest_statcan_tables.py` its own download timeouts, as Day 30's code already does.)

### Retry budgets

Before choosing numbers, compute the **worst case**: how long could a run take if everything fails slowly?

| Step | Timeout | Retries | Delays | Worst case |
|---|---|---|---|---|
| ingest_api | 30 min | 2 | 5 + 10 min | 3 × 30 + 15 = **105 min** |
| wap_statcan_tables | 60 min | 1 | 15 min | 2 × 60 + 15 = **135 min** |
| dbt_build | 30 min | 0 | — | **30 min** |
| gx_warehouse | 20 min | 0 | — | **20 min** |
| **Total** | | | | **~4.8 hours** |

If the refresh runs at 17:30 ET and the dashboard must be ready by 08:00 the next morning, a ~5-hour worst case is acceptable. If it had to be ready within an hour, you'd need shorter timeouts or fewer retries. **Retry settings are a business decision**, derived from the deadline.

---

## 54.6 Mini-Project: A Per-Step Retry Policy, Drilled (25 min)

### Centralise the policy

> **Question it answers:** For each step, how many retries, what delays, what timeout, and which exit codes are temporary or warnings?
>
> **Other questions you can answer the same way:**
> - Where do I change the retry rules for ingestion?

Add to `orchestration/settings.py`:

```python
STEP_POLICIES = {
    #  name                  retries  delays (s)      timeout (s)  transient codes  warning codes
    "ingest_api":         dict(retries=2, delays=[300, 600], timeout=1800,
                               transient=(1,), warning=(2,)),
    "wap_statcan_tables": dict(retries=1, delays=[900],      timeout=3600,
                               transient=(1,), warning=(2,)),
    "dbt_deps":           dict(retries=1, delays=[60],       timeout=600,
                               transient=(1,), warning=()),
    "dbt_build":          dict(retries=0, delays=[],         timeout=1800,
                               transient=(),   warning=()),
    "dbt_docs":           dict(retries=0, delays=[],         timeout=600,
                               transient=(),   warning=()),
    "gx_warehouse":       dict(retries=0, delays=[],         timeout=1200,
                               transient=(),   warning=(2,)),
}
```

(`dbt deps` downloads packages from the internet, so a failure there *is* usually transient.)

### A helper that applies the policy

> **Question it answers:** How do I run any step with its own retry and timeout policy, always getting a state back?
>
> **Other questions you can answer the same way:**
> - How do I add a new step with its own rules?

In `orchestration/tasks/commands.py`:

```python
from orchestration.settings import STEP_POLICIES


def step(name: str, cmd: list[str], cwd: str | None = None, drill: dict | None = None):
    """Run a pipeline step with its policy; always return a State (never raises)."""
    p = STEP_POLICIES[name]
    configured = run_policy_step.with_options(
        name=f"step:{name}",
        retries=p["retries"],
        retry_delay_seconds=p["delays"] or 0,
        retry_jitter_factor=0.2 if p["retries"] else None,
        timeout_seconds=p["timeout"],
    )
    return configured(name, cmd, cwd,
                      warning_codes=p["warning"], transient_codes=p["transient"],
                      drill=drill, return_state=True)
```

Update `daily_refresh.py` so every step goes through `step(...)` (replacing `run_step_with_state`), and pass the flow's `drill` parameter down to the subflows.

### Drills

> **Question it answers:** Does each step retry, recover or fail exactly as the policy says when I simulate problems?
>
> **Other questions you can answer the same way:**
> - Is a dbt failure correctly not retried?
> - Does ingestion recover after one temporary failure?

For quick drills, temporarily set the delays in `STEP_POLICIES` to a few seconds, then:

```python
daily_refresh(drill={"ingest_api": {"code": 1, "attempts": 1}})      # retried once → recovers → Completed
daily_refresh(drill={"ingest_api": {"code": 1, "attempts": 99}})     # exhausts retries → ingestion failed
daily_refresh(drill={"wap_statcan_tables": {"code": 3, "attempts": 1}})  # quarantine: NOT retried
daily_refresh(drill={"dbt_build": {"code": 1, "attempts": 1}})       # NOT retried; flow Failed
```

For each drill, confirm in the UI: the number of attempts, the delays between them, the final task state, and the flow's final state according to `STATE_POLICY.md`. Record the results in `orchestration/DRILL_RESULTS.md` and **restore the real delays** afterwards.

### Day 54 checklist
- [ ] I can explain retry layers (HTTP, task, flow, schedule) and avoid multiplying them
- [ ] I configure retries with backoff and jitter, and can see attempts in the UI
- [ ] A `retry_condition_fn` retries only transient failures; quality rejections and SQL errors are never retried
- [ ] Exit codes are unambiguous and documented (quarantine = 3)
- [ ] Every step has a timeout; the retry budget fits the business deadline
- [ ] Retry behaviour is centralised in `STEP_POLICIES` and proven by drills

```bash
git add . && git commit -m "Day 54: retries, retry conditions, timeouts, exit-code API" && git push
```

---

# DAY 55 — Caching

| Time | Block |
|---|---|
| 0:00 – 0:23 | 55.1 What caching is, and how Prefect decides a cache hit |
| 0:23 – 0:45 | 55.2 Caching an API fetch |
| 0:45 – 0:53 | Break |
| 0:53 – 1:15 | 55.3 Cache keys from the data's own version |
| 1:15 – 1:35 | 55.4 When not to cache |
| 1:35 – 1:43 | Break |
| 1:43 – 2:10 | 55.5 Side-effect steps: skip by content fingerprint |
| 2:10 – 2:30 | 55.6 Mini-project: a refresh that does nothing when nothing changed |

---

## 55.1 What Caching Is (23 min)

**Caching** means: *if this exact work was done before, reuse the stored result instead of doing it again.* It's the same idea as dbt only rebuilding what changed (Day 31) or dlt's incremental cursors (Day 27), applied to Prefect tasks.

Prefect computes a **cache key** for each task run from a **cache policy**. If a previous run with the same key stored a result that hasn't expired, the task is skipped and enters a **Completed** state named **Cached**.

| Cache policy | Key built from | Effect |
|---|---|---|
| `INPUTS` | the task's arguments | same inputs → cache hit |
| `TASK_SOURCE` | the task's source code | editing the function invalidates the cache |
| `RUN_ID` | the current flow run | only reuse within one run (e.g. flow retries) |
| `NONE` | nothing | never cache |
| `DEFAULT` | `INPUTS + TASK_SOURCE + RUN_ID` | Prefect's default: reuse only inside the same run |

Policies combine with `+`. For cross-run caching, the usual choice is **`INPUTS + TASK_SOURCE`**: the same arguments *and* the same code.

Cached results are **persisted** to result storage, by default files under `~/.prefect/storage/`, so they survive between runs.

---

## 55.2 Caching an API Fetch (23 min)

> **Question it answers:** How do I reuse a recent CPI download instead of calling StatCan again on every run?
>
> **Other questions you can answer the same way:**
> - How many API calls does caching save each day?

The CPI briefing (Day 51) fetches from StatCan on every run, though CPI only changes once a month. Cache it:

```python
from datetime import timedelta

from prefect import task
from prefect.cache_policies import INPUTS, TASK_SOURCE


@task(cache_policy=INPUTS + TASK_SOURCE, cache_expiration=timedelta(hours=6))
def fetch_cpi(latest_n: int) -> list[tuple[date, float]]:
    ...                                              # unchanged from Day 51
```

Run the flow twice in a row:

```bash
python -m orchestration.flows.cpi_briefing
python -m orchestration.flows.cpi_briefing
```

The second run's `fetch_cpi` is **Cached**: no request to StatCan, and instant. Run it with `latest_n=13`: that's a different input, so it's a cache **miss**. Edit the task's code (even a comment): with `TASK_SOURCE`, that's also a miss.

### Forcing a refresh

> **Question it answers:** How do I ignore the cached value and fetch fresh data on demand?
>
> **Other questions you can answer the same way:**
> - How do I force new data right after a release?

```python
fetch_cpi.with_options(refresh_cache=True)(25)       # ignore any cached value; store a new one
```

or set the environment variable `PREFECT_TASKS_REFRESH_CACHE=true` for a whole run.

### Try it 55.2

Why is `cache_expiration=timedelta(hours=6)` a better choice here than no expiration at all? What could go wrong with a 30-day expiration?

<details>
<summary>Answer</summary>

With `INPUTS` alone, the cache key doesn't know that **StatCan published new data**: `latest_n=25` looks identical before and after a release. Without expiration, the briefing would keep showing stale CPI forever. A 6-hour expiration bounds the staleness to at most six hours after a release. A 30-day expiration could hide an entire monthly release. The next section fixes this properly by putting the **data version** into the key.

</details>

---

## 55.3 Cache Keys from the Data's Own Version (23 min)

> **Question it answers:** How do I reuse the cached CPI until StatCan actually releases new data, instead of guessing an expiry time?
>
> **Other questions you can answer the same way:**
> - Has the CPI changed since my last download?

Time-based expiration is a guess. Better: make the key depend on **what the data provider says has changed**. StatCan's `getCubeMetadata` reports each table's `releaseTime` (Day 27). If the release time hasn't changed, the data hasn't either.

```python
from datetime import timedelta

import requests
from prefect import flow, task

WDS = "https://www150.statcan.gc.ca/t1/wds/rest"


@task(retries=2, retry_delay_seconds=30)
def cpi_release_time() -> str:
    r = requests.post(f"{WDS}/getCubeMetadata", json=[{"productId": 18100004}], timeout=30)
    r.raise_for_status()
    return r.json()[0]["object"]["releaseTime"]


def key_by_release(context, parameters) -> str:
    """Cache key: one entry per (CPI release, window length)."""
    return f"cpi-{parameters['release_time']}-{parameters['latest_n']}"


@task(cache_key_fn=key_by_release, cache_expiration=timedelta(days=45))
def fetch_cpi_for_release(release_time: str, latest_n: int) -> list:
    ...                                             # same fetch as before


@flow
def cpi_briefing_versioned(latest_n: int = 25):
    release = cpi_release_time()                    # cheap metadata call, every run
    points = fetch_cpi_for_release(release, latest_n)   # expensive fetch, only after a release
    ...
```

A **`cache_key_fn`** receives the run context and the task's **parameters**, and returns any string. Here the key contains the **release time**, so:
- until StatCan republishes, every run is a cache hit;
- the first run after a release is a miss and fetches the new data;
- the 45-day expiration is just a safety net.

> This is the orchestration counterpart of Day 30's change detection. The cheap question ("has it changed?") runs every time; the expensive work runs only when the answer is yes.

---

## 55.4 When Not to Cache (20 min)

Caching is powerful and dangerous. **Only cache work whose result is fully determined by the cache key.**

| Don't cache… | Because… |
|---|---|
| steps with **side effects** (loading data, `dbt build`, publishing) | a cache hit returns the old *result* but doesn't redo the *effect*. If the effect was undone (a table dropped), nothing restores it |
| steps depending on **hidden inputs** (the current time, a database's current contents) | the key doesn't see them, so you get stale results |
| results containing **secrets** | they'd be written to result storage on disk |
| very **large** results (whole DataFrames of millions of rows) | storage fills up; loading them back can be slower than recomputing |
| **non-deterministic** work you want fresh (random sampling, "latest" queries) | it defeats the purpose |

### Where cached results live

> **Question it answers:** Where are cached results stored, and how much space do they use?
>
> **Other questions you can answer the same way:**
> - Do I need to clean up old cached results?

```bash
ls ~/.prefect/storage | head
du -sh ~/.prefect/storage
```

Result files are **serialised Python objects** (by default using pickle). Treat the folder like data: don't commit it, and clear it if it grows too large (`rm -rf ~/.prefect/storage/*` resets all caches).

### Try it 55.4

For each task, decide: cache or not? If yes, with which key?
(a) `fetch_valet(series_id)` from the Day 52 concurrency demo; (b) `publish_briefing()` (Day 53 artifact); (c) a task computing a 10-year rolling correlation from a DataFrame argument; (d) `run_policy_step("dbt_build", …)`.

<details>
<summary>Answers</summary>

(a) Yes, but with a **short** expiration (BoC data updates daily) or a key including today's date: `INPUTS + TASK_SOURCE`, expiring after a few hours. (b) No: it has a side effect (it creates an artifact) and reads the warehouse's *current* state, a hidden input. (c) Possibly: it's deterministic given its input, but hashing a large DataFrame for the key costs time, so only cache if the computation is expensive. (d) **No, not with Prefect caching**: it's a side-effect step. Use the fingerprint approach in 55.5 instead.

</details>

---

## 55.5 Side-Effect Steps: Skip by Content Fingerprint (28 min)

`dbt build` is our most expensive side-effect step. Re-running it when **nothing in its inputs changed** (a manual re-run, a retry of a later step, a weekend run) wastes time. We can't use result caching (55.4), but we **can** make an explicit decision:

> **Rebuild only if the warehouse's inputs or the dbt code changed since the last successful build.**

### What goes into a fingerprint?

> **Question it answers:** Has the raw data's content actually changed since the last dbt build?
>
> **Other questions you can answer the same way:**
> - Did today's ingestion bring anything new, or just reload the same values?

| Input | How we measure it |
|---|---|
| observation data | an order-independent hash of every `(series_id, date, value)` in the observation tables |
| full StatCan tables | the latest published release time (`raw_dlt.statcan_releases`) |
| dbt code and seeds | the Git commit plus any uncommitted changes in `macro_dbt/` |

Why hash **content** rather than load IDs? Day 27's lookback windows rewrite recent rows on every run, which gives them new `_dlt_load_id`s even when their values are identical. A content hash changes **only when the numbers change**.

Create `orchestration/tasks/fingerprints.py`:

```python
"""Content fingerprints: decide whether downstream work is needed."""
import hashlib
import subprocess

import duckdb
from prefect import get_run_logger, task

from orchestration.settings import ENV, REPO

OBSERVATION_TABLES = ["raw_dlt.boc_observations", "raw_dlt.fred_observations",
                      "raw_dlt.statcan_observations"]


@task(cache_policy=None)
def warehouse_fingerprint() -> str:
    """Fingerprint of dbt's inputs: observation content, StatCan releases, dbt code."""
    parts = []
    with duckdb.connect(ENV["MACRO_DUCKDB_PATH"], read_only=True) as con:
        for t in OBSERVATION_TABLES:
            h = con.sql(f"select bit_xor(hash(series_id, date, value)) from {t}").fetchone()[0]
            parts.append(f"{t}={h}")
        rel = con.sql("select max(release_time)::varchar from raw_dlt.statcan_releases").fetchone()[0]
        parts.append(f"releases={rel}")

    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO,
                            capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(["git", "diff", "HEAD", "--", "macro_dbt"], cwd=REPO,
                           capture_output=True, text=True).stdout
    parts += [f"commit={commit}", f"dirty={hashlib.sha256(dirty.encode()).hexdigest()}"]

    fp = hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]
    get_run_logger().info(f"warehouse fingerprint {fp}")
    return fp
```

- **`hash(series_id, date, value)`** is a DuckDB function returning a number per row. **`bit_xor`** combines them in an **order-independent** way, so the same rows in any order give the same fingerprint, and changing any value changes it.
- `git diff HEAD -- macro_dbt` captures uncommitted edits, so a model edited but not yet committed still triggers a rebuild.
- `cache_policy=None` makes sure the fingerprint itself is **never** cached. It must always look at the current data.

### Remembering the last build: Prefect Variables

> **Question it answers:** How do I remember the fingerprint of the last successful build between runs?
>
> **Other questions you can answer the same way:**
> - When was the warehouse last rebuilt, and from which data?

**Variables** are small named values stored by the Prefect server, readable and editable in the UI (*Variables* page):

```python
from prefect.variables import Variable

Variable.set("dbt_last_fingerprint", fp, overwrite=True)
last = Variable.get("dbt_last_fingerprint", default=None)
```

### The decision in the transform subflow

> **Question it answers:** Should dbt rebuild today, or can it be skipped because nothing changed?
>
> **Other questions you can answer the same way:**
> - How do I force a rebuild anyway?

```python
from prefect.states import Completed
from prefect.variables import Variable

from orchestration.tasks.fingerprints import warehouse_fingerprint


@flow(name="transform")
def transform_flow(drill: dict | None = None, force: bool = False) -> dict:
    logger = get_run_logger()
    fp = warehouse_fingerprint()
    last = Variable.get("dbt_last_fingerprint", default=None)

    if fp == last and not force:
        logger.info(f"Inputs unchanged since last build ({fp}) — skipping dbt")
        return {"dbt_build": Completed(name="Skipped", message=f"inputs unchanged ({fp})")}

    states = {"dbt_deps": step("dbt_deps", [DBT, "deps", "--quiet"], str(DBT_DIR), drill)}
    if outcome(states["dbt_deps"]) == "failed":
        return states
    states["dbt_build"] = step("dbt_build", [DBT, "build", "--target", "prod"], str(DBT_DIR), drill)
    if outcome(states["dbt_build"]) != "failed":
        Variable.set("dbt_last_fingerprint", fp, overwrite=True)      # only after success
        states["dbt_docs"] = step("dbt_docs", [DBT, "docs", "generate", "--target", "prod"],
                                  str(DBT_DIR), drill)
    return states
```

Add a flow parameter `force_transform: bool = False` to `daily_refresh` and pass it through.

Note the familiar rule, **record the marker only after success** (Day 30, Day 50): the fingerprint is saved only when the build succeeded, so a failed build is retried next run even if the inputs are the same.

Also update `outcome()` so that a state named **Skipped** counts as `"ok"`. It's a Completed state, so the existing logic already treats it that way.

---

## 55.6 Mini-Project: A Refresh That Does Nothing When Nothing Changed (20 min)

> **Question it answers:** How much faster is the second refresh of the day when nothing has changed?
>
> **Other questions you can answer the same way:**
> - Does the refresh skip work correctly but still rebuild when data changes?

1. Apply release-keyed caching to the CPI briefing (55.3), and a short-expiry cache to StatCan metadata calls used in the flow.
2. Implement the fingerprint skip (55.5) in `daily_refresh`.
3. Measure:

```bash
time python -c "from orchestration.flows.daily_refresh import daily_refresh; daily_refresh()"
time python -c "from orchestration.flows.daily_refresh import daily_refresh; daily_refresh()"
```

The second run (with no new data in between) should skip dbt. Then run with `force_transform=True` and confirm dbt runs.

4. Prove the fingerprint reacts to **content**: in a DuckDB session (with nothing else running), make a copy of `raw_dlt.fred_observations`, change one value in the **original**, run `warehouse_fingerprint()` from a Python shell, restore the original from the copy, and run it again. The fingerprint must change and then return to its previous value.

> **Weekend effect:** the BoC and FRED don't publish daily financial data on weekends, so weekend runs typically find unchanged content, and the refresh completes in seconds, skipping dbt. You've just made the pipeline cheaper without scheduling exceptions.

### Day 55 checklist
- [ ] I understand cache keys, policies (`INPUTS`, `TASK_SOURCE`, `RUN_ID`, `NONE`), expiration and result storage
- [ ] I cache pure fetches, and key them on the data's own version (release time) where possible
- [ ] I never use result caching for side-effect steps
- [ ] `dbt build` is skipped when a content fingerprint of its inputs and code is unchanged
- [ ] Markers (fingerprints) are recorded only after success, and a `force` parameter overrides the skip

```bash
git add . && git commit -m "Day 55: caching, release-keyed caches, content fingerprints" && git push
```

---

# DAY 56 — Scheduling and Deployments

| Time | Block |
|---|---|
| 0:00 – 0:18 | 56.1 From scripts to deployments |
| 0:18 – 0:38 | 56.2 Quick scheduling with `serve()` |
| 0:38 – 0:45 | Break |
| 0:45 – 1:08 | 56.3 When should the refresh run? Cron, time zones and release calendars |
| 1:08 – 1:43 | 56.4 Work pools, workers and `prefect.yaml` |
| 1:43 – 1:50 | Break |
| 1:50 – 2:10 | 56.5 Running deployments on demand |
| 2:10 – 2:30 | 56.6 Keeping it alive: what "production" needs beyond a Codespace |

---

## 56.1 From Scripts to Deployments (18 min)

So far you've started flows by running Python. A **deployment** tells Prefect *how* and *when* to run a flow **without you**:

| Concept | Meaning | Our example |
|---|---|---|
| **Deployment** | a flow + its default parameters + schedules + where to run | `daily-refresh/prod` |
| **Schedule** | when to create runs automatically | weekdays 17:30 Toronto time |
| **Work pool** | a queue of scheduled runs waiting for somewhere to execute | `local-process` |
| **Worker** | a long-running process that picks runs from a pool and executes them | `prefect worker start` in your Codespace |

Two ways to get there:

| `flow.serve()` | `prefect deploy` + work pool + worker |
|---|---|
| one command; the serving process runs the flows | deployments defined in `prefect.yaml`; workers run them |
| perfect for learning and small setups | the standard for teams and real infrastructure |
| stops when the process stops | workers can run on different machines, in containers, in the cloud |

We'll do both: `serve()` first to see schedules working, then the full setup.

---

## 56.2 Quick Scheduling with `serve()` (20 min)

> **Question it answers:** How do I run the CPI briefing automatically every 15 minutes while learning?
>
> **Other questions you can answer the same way:**
> - How do I schedule a flow without setting up any infrastructure?

Create `orchestration/flows/serve_local.py`:

```python
"""Serve deployments from this process (learning setup)."""
from prefect import serve

from orchestration.flows.cpi_briefing import cpi_briefing
from orchestration.flows.daily_refresh import daily_refresh

if __name__ == "__main__":
    briefing = cpi_briefing.to_deployment(
        name="cpi-briefing-every-15-min",
        interval=900,                          # seconds: every 15 minutes (demo only)
        parameters={"latest_n": 25},
    )
    refresh = daily_refresh.to_deployment(
        name="daily-refresh-demo",
        cron="*/30 * * * *",                   # every 30 minutes (demo only)
    )
    serve(briefing, refresh)
```

```bash
python -m orchestration.flows.serve_local
```

The process keeps running. In the UI:
- **Deployments** lists both deployments;
- each deployment's page shows **upcoming scheduled runs**;
- use **Run → Quick run** or **Custom run** (with different parameters) to start one now.

Watch a scheduled `cpi-briefing` run appear, execute (mostly **Cached**, thanks to Day 55), and complete. Stop the process with `Ctrl+C`: scheduled runs stop being executed, which is exactly the limitation 56.4 solves.

---

## 56.3 When Should the Refresh Run? (23 min)

A schedule is an **economic** decision: run when new data is likely to be available, soon enough to be useful.

### When our sources publish

| Source | Typical timing (check each provider's release calendar) | Consequence |
|---|---|---|
| BoC exchange rates and bond yields (Valet) | once per business day, late afternoon Eastern time | run after ~17:00 ET |
| FRED daily series (e.g. Treasury yields, WTI) | updated the following business day | yesterday's values arrive with the evening run |
| StatCan releases (CPI, LFS, GDP) | 08:30 Eastern time on release days | a morning run shortly after 08:30 ET catches them |

That suggests **two** runs on weekdays:
1. **09:15 ET**: catches StatCan's 08:30 releases (WAP audits them; dashboards update the same morning).
2. **17:30 ET**: catches BoC's end-of-day rates.

Thanks to change detection (Day 30) and fingerprints (Day 55), a run that finds nothing new is cheap, so scheduling generously costs little.

### Cron in five fields

> **Question it answers:** How do I write "09:15 every weekday" or "07:00 every Monday" as a schedule?
>
> **Other questions you can answer the same way:**
> - When should the refresh run relative to StatCan's 08:30 releases?

```
┌──────── minute (0–59)
│ ┌────── hour (0–23)
│ │ ┌──── day of month (1–31)
│ │ │ ┌── month (1–12)
│ │ │ │ ┌ day of week (0–6, Sunday = 0; 1–5 = Monday–Friday)
│ │ │ │ │
15 9 * * 1-5      → 09:15 every weekday
30 17 * * 1-5     → 17:30 every weekday
0 7 * * 1         → 07:00 every Monday
```

### Time zones: the daylight-saving trap

Cron schedules default to **UTC**. Toronto is UTC−5 in winter and UTC−4 in summer, so a UTC cron of `15 13 * * 1-5` means 08:15 ET in winter (too early for 08:30 releases!) and 09:15 ET in summer. **Always give schedules an explicit time zone**, `America/Toronto`, and let Prefect handle daylight saving. That's what `prefect.yaml` does below.

### Holidays

Cron doesn't know Canadian statutory holidays. On holidays our runs find no new data and finish quickly, which is harmless. Skipping them explicitly (e.g. with a calendar check at the start of the flow) is possible, but rarely worth the complexity. Note it as a conscious decision in the runbook.

---

## 56.4 Work Pools, Workers and `prefect.yaml` (35 min)

### Step 1 — A work pool

> **Question it answers:** Where will scheduled runs actually execute?
>
> **Other questions you can answer the same way:**
> - Which machine picks up the scheduled work?

A **process** work pool runs flows as local subprocesses, which suits a Codespace:

```bash
prefect work-pool create local-process --type process
prefect work-pool ls
```

### Step 2 — `prefect.yaml`: deployments as code

> **Question it answers:** How do I define every scheduled job (morning, evening, weekly rebuild, briefing, watchdog) in one version-controlled file?
>
> **Other questions you can answer the same way:**
> - When does each job run, and with which parameters?

Create `prefect.yaml` at the repository root:

```yaml
# prefect.yaml — deployments for the macro data platform
name: macro-data-course
prefect-version: 3.0.0

pull:
  - prefect.deployments.steps.set_working_directory:
      directory: /workspaces/macro-data-course

deployments:
  - name: prod-morning
    description: "Weekday refresh after StatCan's 08:30 ET releases."
    entrypoint: orchestration/flows/daily_refresh.py:daily_refresh
    work_pool:
      name: local-process
      job_variables:
        env:
          PYTHONPATH: /workspaces/macro-data-course
    parameters: {}
    tags: [macro, prod]
    concurrency_limit: 1
    schedules:
      - cron: "15 9 * * 1-5"
        timezone: "America/Toronto"

  - name: prod-evening
    description: "Weekday refresh after the Bank of Canada's end-of-day rates."
    entrypoint: orchestration/flows/daily_refresh.py:daily_refresh
    work_pool:
      name: local-process
      job_variables:
        env:
          PYTHONPATH: /workspaces/macro-data-course
    parameters: {}
    tags: [macro, prod]
    concurrency_limit: 1
    schedules:
      - cron: "30 17 * * 1-5"
        timezone: "America/Toronto"

  - name: weekly-full-rebuild
    description: "Sunday rebuild ignoring fingerprints (catches anything skipped)."
    entrypoint: orchestration/flows/daily_refresh.py:daily_refresh
    work_pool:
      name: local-process
      job_variables:
        env:
          PYTHONPATH: /workspaces/macro-data-course
    parameters:
      force_transform: true
    tags: [macro, prod, weekly]
    concurrency_limit: 1
    schedules:
      - cron: "0 7 * * 0"
        timezone: "America/Toronto"

  - name: cpi-briefing
    description: "CPI briefing; cheap thanks to release-keyed caching."
    entrypoint: orchestration/flows/cpi_briefing.py:cpi_briefing
    work_pool:
      name: local-process
      job_variables:
        env:
          PYTHONPATH: /workspaces/macro-data-course
    parameters:
      latest_n: 25
    schedules:
      - cron: "45 8 * * 1-5"
        timezone: "America/Toronto"
```

Key points:
- **`entrypoint`** is `path/to/file.py:flow_function`.
- **`pull` → `set_working_directory`** runs flows from the repository root, so relative paths (`ingest.py`, `macro_dbt/`) work.
- **`PYTHONPATH`** lets the flow file import `orchestration.*`.
- **`concurrency_limit: 1`** means at most one run of this deployment at a time. If the morning run is still going when the next is due, the new one waits instead of fighting over the DuckDB lock. (Runs of *different* deployments are coordinated on Day 57.)
- **`parameters`** override the flow's defaults for that deployment (the weekly rebuild forces dbt).

### Step 3 — Deploy and start a worker

> **Question it answers:** How do I register all scheduled jobs and start the worker that runs them?
>
> **Other questions you can answer the same way:**
> - Are all the deployments registered?

```bash
prefect deploy --all                      # registers all deployments from prefect.yaml
prefect deployment ls
```

In a **third** terminal (with `.venv` active, so the worker runs flows with the right libraries):

```bash
source .venv/bin/activate
prefect worker start --pool local-process
```

The worker polls the pool and executes runs when they're due. In the UI, open **Work Pools → local-process** to see the worker's status, and **Deployments** to see each deployment's upcoming runs, displayed in your time zone.

> `prefect.yaml` is **code**: commit it. Schedules, parameters and concurrency rules are now reviewed and versioned like everything else, a pattern you've used for dbt (`dbt_project.yml`), dlt (`config.toml`) and GX (specs).

---

## 56.5 Running Deployments on Demand (20 min)

Schedules aren't the only way to trigger runs.

### From the CLI

> **Question it answers:** How do I start a scheduled job right now, optionally with different parameters?
>
> **Other questions you can answer the same way:**
> - How do I run an extra refresh after a surprise release?

```bash
prefect deployment run 'daily-refresh/prod-evening'
prefect deployment run 'daily-refresh/prod-evening' --param force_transform=true
prefect deployment run 'cpi-briefing/cpi-briefing' --param latest_n=49
```

### From the UI

**Deployments → daily-refresh/prod-evening → Run → Custom run**: the parameter form is generated from the flow's type hints (Day 51), so non-programmers can trigger a forced rebuild safely.

### From Python (e.g. from another flow)

> **Question it answers:** How can one flow trigger another job without waiting for it to finish?
>
> **Other questions you can answer the same way:**
> - How do I start a rebuild from a script?

```python
from prefect.deployments import run_deployment

run = run_deployment("daily-refresh/prod-evening",
                     parameters={"force_transform": True},
                     timeout=0)          # 0 = don't wait for it to finish
```

### Pausing and resuming schedules

> **Question it answers:** How do I pause scheduled runs during maintenance and resume them afterwards?
>
> **Other questions you can answer the same way:**
> - How do I stop runs while I restructure dbt models?

During maintenance (e.g. while restructuring dbt models), pause schedules without deleting anything:

```bash
prefect deployment schedule ls 'daily-refresh/prod-evening'
prefect deployment schedule pause 'daily-refresh/prod-evening' <schedule-id>
prefect deployment schedule resume 'daily-refresh/prod-evening' <schedule-id>
```

(or use the toggle on the deployment page in the UI).

### Try it 56.5

Trigger `prod-evening` twice in quick succession from the CLI. What happens to the second run, and why? Where do you see it in the UI?

<details>
<summary>Answer</summary>

Because of `concurrency_limit: 1`, the second run waits (it's held back rather than executed) until the first finishes. It appears in the deployment's run list in a waiting state, then runs. Without the limit, both would start, and the second would likely fail on the DuckDB write lock, or worse, interleave writes.

</details>

---

## 56.6 Keeping It Alive: What "Production" Needs Beyond a Codespace (20 min)

Be honest about the environment: **a Codespace stops after a period of inactivity**, and when it stops, so do your Prefect server and worker. No schedule fires while it's asleep. For this course that's fine: schedules run while you work, and you've learned the real mechanics. For a real team:

| Need | Options |
|---|---|
| always-on scheduler and UI | a small always-on VM or server running `prefect server`; or **Prefect Cloud** (managed server and UI) |
| always-on execution | a worker on that VM; or a managed/serverless work pool; or containers (Docker, Kubernetes pools) |
| the warehouse outside the Codespace | `macro.duckdb` on a persistent disk, or a hosted DuckDB-compatible service such as MotherDuck (a dlt/dbt destination change, Day 23) |
| secrets outside the Codespace | Prefect Secret blocks (Day 57) or the platform's secret manager |

A lighter alternative for small projects is a **scheduled CI job** (e.g. GitHub Actions with a `schedule:` trigger) that checks out the repository, restores the warehouse from persistent storage, runs `python -m orchestration.flows.daily_refresh`, and saves the warehouse back. You lose the always-on UI but keep the code and flows unchanged.

The key point: **your flows, deployments and policies don't change** between these options. Only *where* the server, workers and warehouse live changes. That's the payoff of separating orchestration logic from infrastructure.

Record your chosen production setup (even if hypothetical) in `orchestration/DEPLOYMENT.md`, with what would run where and how secrets and the warehouse are stored.

### Day 56 checklist
- [ ] I can explain deployments, schedules, work pools and workers, and when to use `serve()` vs `prefect deploy`
- [ ] Schedules follow the data: after StatCan's morning releases and the BoC's end-of-day rates, in `America/Toronto` time
- [ ] `prefect.yaml` defines prod, weekly-rebuild and briefing deployments with parameters and concurrency limits
- [ ] A worker executes scheduled runs from the `local-process` pool
- [ ] I can trigger, parameterise, pause and resume deployments from the CLI, the UI and Python
- [ ] I've documented what a real production setup needs beyond a Codespace

```bash
git add prefect.yaml orchestration && git commit -m "Day 56: deployments, schedules, work pool, worker" && git push
```

---

# DAY 57 — Logging, Secrets, Concurrency and Run History

| Time | Block |
|---|---|
| 0:00 – 0:25 | 57.1 Logging in depth |
| 0:25 – 0:45 | 57.2 Secrets and runtime configuration in Prefect |
| 0:45 – 0:53 | Break |
| 0:53 – 1:15 | 57.3 Concurrency limits: one DuckDB writer, enforced |
| 1:15 – 1:40 | 57.4 Run history as data |
| 1:40 – 1:48 | Break |
| 1:48 – 2:05 | 57.5 A watchdog: alerting when nothing happens |
| 2:05 – 2:30 | 57.6 Capstone: `daily_refresh` v3, end to end |

---

## 57.1 Logging in Depth (25 min)

### Levels from subprocess output

> **Question it answers:** How do I make errors and warnings from dbt, dlt and GX show up at the right log level?
>
> **Other questions you can answer the same way:**
> - How do I filter today's logs for errors only?

Since Day 52, every line of every tool's output is logged at INFO, so a dbt error and a progress message look the same in the UI. Map levels from the content:

```python
import re

ERROR_PAT = re.compile(r"(\bERROR\b|✗|⛔|Traceback|FAIL)", re.IGNORECASE)
WARN_PAT = re.compile(r"(\bWARN(ING)?\b|⚠)", re.IGNORECASE)


def log_line(logger, name: str, line: str):
    text = f"[{name}] {line.rstrip()}"
    if ERROR_PAT.search(line):
        logger.error(text)
    elif WARN_PAT.search(line):
        logger.warning(text)
    else:
        logger.info(text)
```

Use `log_line(logger, name, line)` in `run_step`'s streaming loop. Now the UI's level filter shows you **only the problems** from a 3,000-line run.

### What makes a good log message?

| ✗ Poor | ✓ Good |
|---|---|
| `done` | `wap_statcan_tables: published statcan_lfs_full (release 2026-09-05T08:30), 5.4M rows, 212s` |
| `error` | `ingest_api attempt 2/3: TransientStepError exit 1 — retrying in 600s` |
| `fingerprint ok` | `warehouse fingerprint 3fa1c09b… unchanged since 2026-09-29 17:41 — dbt skipped` |

Include **what, which object, how much, how long, and what happens next**. Never log **secrets** (API keys, webhook URLs) or large data dumps.

### Log levels for the whole platform

> **Question it answers:** How much detail should the logs record in development versus production?
>
> **Other questions you can answer the same way:**
> - How do I see debug messages while developing?

```bash
prefect config set PREFECT_LOGGING_LEVEL=INFO            # DEBUG while developing
```

Libraries you call **in-process** (e.g. `duckdb` or `requests` inside a task) log to their own Python loggers. To see them in Prefect, list them:

```bash
prefect config set PREFECT_LOGGING_EXTRA_LOGGERS="urllib3"
```

(Our main tools run as subprocesses, so their output already arrives through the streaming in `run_step`.)

### Logging outside a run

> **Question it answers:** How can shared code log messages whether it runs inside a flow or as a plain script?
>
> **Other questions you can answer the same way:**
> - Why does get_run_logger fail in my test script?

Code shared by flows and ordinary scripts can't always call `get_run_logger()`, which only works inside a run. Use a fallback:

```python
from prefect.exceptions import MissingContextError
from prefect.logging import get_logger, get_run_logger


def logger_for_context():
    try:
        return get_run_logger()
    except MissingContextError:
        return get_logger("macro")
```

---

## 57.2 Secrets and Runtime Configuration in Prefect (20 min)

### Secret blocks

> **Question it answers:** How do I store the alert webhook address securely in Prefect?
>
> **Other questions you can answer the same way:**
> - Where are secrets kept, and who can see them?

**Blocks** are Prefect's stored configuration objects. A **Secret** block stores a sensitive value encrypted on the server, masked in the UI, and loadable by any flow:

```python
from prefect.blocks.system import Secret

Secret(value="https://hooks.example.com/services/XXX").save("notifications-webhook", overwrite=True)
```

Run that **once**, interactively, never in committed code. Then use it:

```python
from prefect.blocks.system import Secret


def webhook_url() -> str | None:
    try:
        return Secret.load("notifications-webhook").get()
    except ValueError:
        return None                                     # not configured: print alerts instead
```

Update the alert hook (Day 53) to post to `webhook_url()`, falling back to Day 29's environment variable. Scheduled runs started by the worker then don't depend on your shell's environment variables.

| Store | For | Example |
|---|---|---|
| **Secret block** | sensitive values | webhook URL, FRED API key, cloud credentials |
| **Variable** | small, non-sensitive runtime settings editable in the UI | `dbt_last_fingerprint`, `max_staleness_hours` |
| `prefect.yaml` parameters | per-deployment defaults, reviewed in Git | `force_transform: true` for weekly rebuilds |
| `.dlt/config.toml`, dbt `vars` | settings owned by each tool | series lists, panel start date |

> Each setting should have **one home**. Don't copy the dbt start date into a Prefect Variable "for convenience". When the two drift apart, you'll spend an afternoon finding out why.

### Using a Variable for an operational threshold

> **Question it answers:** How do I make the "maximum age before alert" threshold editable without changing code?
>
> **Other questions you can answer the same way:**
> - How do I relax the alert threshold during a holiday?

```python
from prefect.variables import Variable

Variable.set("refresh_max_age_hours", 30, overwrite=True)      # once, or edit in the UI
```

The watchdog (57.5) reads it. An operator can relax the threshold during a planned outage from the UI, without a code change.

---

## 57.3 Concurrency Limits: One DuckDB Writer, Enforced (23 min)

`concurrency_limit: 1` (Day 56) stops two runs of the **same** deployment overlapping. But `prod-morning`, `prod-evening` and `weekly-full-rebuild` are **different** deployments, and a manual run of `ingest.py` could also collide with them. The real constraint is **one writer to `macro.duckdb` at a time**, so let's enforce exactly that.

### A global concurrency limit

> **Question it answers:** How do I make sure only one job writes to the DuckDB warehouse at a time?
>
> **Other questions you can answer the same way:**
> - Why is this run "waiting"? Is another job holding the database?

```bash
prefect gcl create duckdb-writer --limit 1
prefect gcl ls
```

(`gcl` is short for `global-concurrency-limit`.) In code, wrap every **writing** step:

```python
from prefect.concurrency.sync import concurrency

with concurrency("duckdb-writer", occupy=1):
    result = run_step.fn(name, cmd, cwd)          # only one holder at a time, across all runs
```

Mark which steps write in `STEP_POLICIES` (`writes_duckdb=True` for ingest_api, wap_statcan_tables and dbt_build) and apply the context manager only to those. Readers (GX, briefing) don't need the slot; DuckDB allows concurrent readers.

### Test it

1. Trigger `prod-morning` and `weekly-full-rebuild` at the same time (UI or CLI).
2. Watch the logs: one run's writing step acquires `duckdb-writer`; the other's **waits** until the slot is released, then proceeds.
3. Inspect the limit in the UI (**Concurrency**), where its active slots are visible while runs hold them.

| Mechanism | Scope | Protects against |
|---|---|---|
| deployment `concurrency_limit` | one deployment | a slow run overlapping its own next scheduled run |
| **global concurrency limit** `duckdb-writer` | **any** code, any flow, any deployment | two writers on one DuckDB file |
| sequential steps inside a flow (Day 50) | one run | the flow fighting itself |

---

## 57.4 Run History as Data (25 min)

> **Question it answers:** How do I keep a table of every step of every run, with outcome and duration?
>
> **Other questions you can answer the same way:**
> - When did ingestion last fail?

The Prefect UI shows runs, but you've learned the value of **history as a table** (GX history, Day 47): trends, KPIs, dbt models. Apply the same pattern to orchestration.

Create `orchestration/tasks/history.py`:

```python
"""Append one row per step per run to Parquet (data/orchestration/runs/)."""
from datetime import datetime, timezone

import pandas as pd
from prefect import task
from prefect.runtime import flow_run

from orchestration.settings import REPO

HISTORY_DIR = REPO / "data" / "orchestration" / "runs"


@task(cache_policy=None)
def record_run_history(summary: dict, details: dict, final_state_name: str):
    now = datetime.now(timezone.utc)
    rows = [{
        "recorded_at": now,
        "flow_run_id": str(flow_run.id),
        "flow_run_name": flow_run.name,
        "deployment": flow_run.deployment_id and str(flow_run.deployment_id),
        "scheduled_start": flow_run.scheduled_start_time,
        "step": step,
        "outcome": outcome,
        "duration_s": details.get(step, {}).get("duration_s"),
        "exit_code": details.get(step, {}).get("exit_code"),
        "run_final_state": final_state_name,
    } for step, outcome in summary.items()]
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).to_parquet(HISTORY_DIR / f"run_{now:%Y%m%dT%H%M%S}.parquet", index=False)
```

`prefect.runtime.flow_run` exposes the current run's ID, name, deployment and scheduled start time, all useful for joining with the UI later.

Call it at the end of `daily_refresh`, **before** returning the final state (compute the final state's name first), so failed runs are recorded too. (If you also need pandas in the pure-Prefect environment, it's already installed with dlt.)

### Questions the history answers

> **Question it answers:** How long does each step take week by week, and is anything getting slower?
>
> **Other questions you can answer the same way:**
> - Which step fails most often?
> - How often are runs completed with warnings?

```sql
-- How long does each step take, and is it getting slower?
select step,
       date_trunc('week', recorded_at)       as week,
       round(avg(duration_s))                as avg_s,
       round(max(duration_s))                as max_s
from 'data/orchestration/runs/*.parquet'
group by all
order by step, week desc;

-- How often did each step need attention?
select step, outcome, count(*) as runs
from 'data/orchestration/runs/*.parquet'
group by all
order by step, outcome;
```

### Into dbt (the same pattern as Day 50)

Add a dbt source `ops` with `external_location: "../data/orchestration/runs/*.parquet"`, a staging model `stg_ops__pipeline_runs`, and a mart `ops_refresh_status`: last successful refresh time, typical duration, and the steps that failed in the last 7 days. Add a KPI to `macro_kpis` (Day 39): *"Hours since last successful refresh"*. The cockpit now shows **economy**, **data quality** and **pipeline health** side by side.

---

## 57.5 A Watchdog: Alerting When Nothing Happens (18 min)

> **Question it answers:** Has the daily refresh completed successfully recently, or has it silently stopped running?
>
> **Other questions you can answer the same way:**
> - Did the worker die over the weekend?

Hooks alert when a run **fails**. But what if **no run happens at all**: the worker died, the Codespace stopped, someone paused a schedule and forgot? No failure means no alert. You need a check that looks for the **absence** of success.

Create `orchestration/flows/watchdog.py`:

```python
"""Alert if daily-refresh hasn't completed successfully recently."""
from datetime import datetime, timedelta, timezone

import duckdb
from prefect import flow, get_run_logger
from prefect.variables import Variable

from macro_ingest.resilience import notify
from orchestration.settings import REPO


@flow(name="watchdog")
def watchdog():
    logger = get_run_logger()
    max_age = timedelta(hours=float(Variable.get("refresh_max_age_hours", default=30)))
    pattern = str(REPO / "data" / "orchestration" / "runs" / "*.parquet")

    try:
        last_ok = duckdb.sql(f"""
            select max(recorded_at) from '{pattern}'
            where run_final_state in ('Completed', 'CompletedWithWarnings')
        """).fetchone()[0]
    except Exception as e:
        last_ok = None
        logger.warning(f"No run history readable yet: {e}")

    now = datetime.now(timezone.utc)
    if last_ok is None or now - last_ok.replace(tzinfo=timezone.utc) > max_age:
        msg = (f"🕳 No successful daily-refresh for more than {max_age}. "
               f"Last success: {last_ok or 'never'}. Check the worker and deployment schedules.")
        logger.error(msg)
        notify(msg)
    else:
        logger.info(f"✓ Last successful refresh {now - last_ok.replace(tzinfo=timezone.utc)} ago")


if __name__ == "__main__":
    watchdog()
```

Add it to `prefect.yaml` with an **hourly** schedule, and redeploy (`prefect deploy --all`). Test it by setting the Variable `refresh_max_age_hours` to `0.01` in the UI, waiting for the next watchdog run, confirming the alert, then restoring 30.

> A watchdog running on the **same** machine as the worker can't detect that the machine itself is down. In real production, run the watchdog elsewhere (a different host, or a managed monitoring service), or use Prefect Cloud's built-in automations for "deployment hasn't run". Note this limitation in `DEPLOYMENT.md`.

---

## 57.6 Capstone: `daily_refresh` v3, End to End (25 min)

Assemble Days 51–57 into the final flow for this module.

**Requirements:**
1. Every step goes through `step()` with its `STEP_POLICIES` entry: retries only for transient codes, backoff with jitter, timeouts, and the `duckdb-writer` concurrency limit for writers.
2. `transform_flow` skips dbt when the content fingerprint is unchanged, unless `force_transform=True`, and records the fingerprint only after success.
3. Subprocess output is logged with levels.
4. The final state follows `STATE_POLICY.md` (Day 53, updated on Day 54 for exit code 3).
5. Hooks alert through the Secret-block webhook; artifacts publish the step table and macro briefing.
6. Run history is recorded for every run, including failed ones.
7. Deployments `prod-morning`, `prod-evening`, `weekly-full-rebuild`, `cpi-briefing` and `watchdog` are defined in `prefect.yaml`; a worker is running.

### Acceptance drills

| # | Scenario | How | Expected |
|---|---|---|---|
| 1 | clean run | trigger `prod-evening` | Completed (or CompletedWithWarnings if GX warns); history row; briefing artifact |
| 2 | immediate re-run | trigger again | dbt **Skipped** by fingerprint; much faster |
| 3 | transient ingestion failure | custom run with `drill={"ingest_api": {"code": 1, "attempts": 1}}` | one retry, then Completed |
| 4 | quarantine | `drill={"wap_statcan_tables": {"code": 3, "attempts": 99}}` | **not** retried; policy outcome recorded |
| 5 | overlapping runs | trigger `prod-morning` and `weekly-full-rebuild` together | writers serialised by `duckdb-writer` |
| 6 | silent stop | pause both prod schedules; lower `refresh_max_age_hours` | watchdog alerts |

Record the evidence (run names, screenshots or log excerpts) in `orchestration/ACCEPTANCE.md`.

### Update the runbook

> **Question it answers:** What should the person on duty know about schedules, workers, forced rebuilds and stuck runs?
>
> **Other questions you can answer the same way:**
> - What do I do if no refresh ran this morning?

Add to `RUNBOOK.md`:

```markdown
## Orchestration
- UI: port 4200 (Codespaces). Deployments: prod-morning (09:15 ET), prod-evening (17:30 ET),
  weekly-full-rebuild (Sun 07:00 ET), cpi-briefing, watchdog (hourly).
- Worker: `prefect worker start --pool local-process` (in .venv). No worker → no scheduled runs.
- Force a rebuild: run prod-evening with force_transform=true.
- Maintenance: pause schedules in the UI; resume afterwards; the watchdog will alert if you forget.
- Stuck "waiting" runs: check the `duckdb-writer` concurrency limit for a held slot (UI → Concurrency).
- Exit codes and retry rules: orchestration/EXIT_CODES.md, settings.STEP_POLICIES.
```

### Recap: Days 54–57

| Capability | Built |
|---|---|
| retries at the right level | task retries with backoff and jitter; HTTP retries kept; flow retries avoided |
| retrying only what time can fix | `retry_condition_fn`, `TransientStepError`, unambiguous exit codes |
| bounded runtimes | per-step timeouts; a retry budget derived from the deadline |
| not repeating work | release-keyed caches for fetches; content fingerprints for dbt |
| running by itself | deployments in `prefect.yaml`, `America/Toronto` schedules aligned with releases, a worker |
| safety between runs | deployment concurrency limits; a global `duckdb-writer` limit |
| operability | levelled logs, Secret blocks, Variables, run history, a watchdog, pipeline-health KPIs |

### Looking ahead: Days 58–60

- The **daily refresh of the macro dashboard pipeline**, end to end: dlt extraction, DuckDB staging, dbt transformations and GX validation, as the curriculum describes, with the notebook dashboards regenerated from the marts.
- **Event-driven runs**: StatCan release detection triggering the WAP flow as soon as new data appears, instead of waiting for the next schedule.
- A final **production-readiness review** of the whole platform, Modules 1–6.

### Day 57 checklist
- [ ] Tool output is logged with correct levels; messages say what, which, how much, how long, what next
- [ ] Secrets live in Secret blocks; operational thresholds in Variables; each setting has one home
- [ ] A global `duckdb-writer` limit serialises every writer, across all deployments
- [ ] Every run appends to a queryable history, which feeds a pipeline-health KPI
- [ ] A watchdog alerts when successful runs stop happening, and its limitations are documented
- [ ] `daily_refresh` v3 passes all six acceptance drills

```bash
git add . && git commit -m "Day 57: logging, secrets, concurrency limits, run history, watchdog" && git push
```
