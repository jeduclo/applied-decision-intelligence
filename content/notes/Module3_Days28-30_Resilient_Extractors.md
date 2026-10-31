# Module 3 · Data Ingestion with dlt
## Days 28–30: Resilient API Extractors for BoC Valet & Statistics Canada → DuckDB

**Audience:** MSc Economics students who completed Days 1–27
**Environment:** GitHub Codespaces · course `.venv` · DuckDB · `macro_ingest` from Day 27
**Time per day:** ~2.5 hours (including breaks and exercises)
**Goal by end of Day 30:** Students run a **production-grade ingestion layer**. It uses dlt's REST client, survives network failures, rate limits and bad payloads, isolates failing series, records errors and run summaries, alerts when something breaks, and feeds the whole `macro.duckdb` warehouse (staging → marts) from `raw_dlt`. The old Day 10 extraction path is retired.

---

### Where we are

After Day 27, `python ingest.py` loads BoC, FRED and StatCan observations **incrementally**, with **schema contracts**, into `macro.duckdb` → `raw_dlt`. But:

| Still fragile | Example |
|---|---|
| One bad series can fail a whole source | a mistyped Valet code returns 404 and kills all BoC loading |
| "Successful" responses can contain failures | StatCan returns HTTP 200 with `"status": "FAILED"` for a vector |
| No record of what went wrong, or when | errors vanish into the terminal |
| No protection against hammering a struggling API | 50 series × 5 retries each |
| Full StatCan tables still come from Day 10 scripts | two ingestion paths, two sources of truth |
| Staging SQL still reads `raw.*` | the warehouse doesn't yet benefit from dlt |

These three days fix all of it.

| Day | Theme |
|---|---|
| 28 | dlt's REST toolkit: `RESTClient`, authentication, pagination, the declarative REST API source |
| 29 | Resilience engineering: failure modes, retries, throttling, isolation, circuit breakers, testing failures offline, alerts |
| 30 | `macro_ingest` v2 → the warehouse: switch staging to `raw_dlt`, a migration regression test, a runbook |

### Target structure (by end of Day 30)

```
macro-data-course/
├── .dlt/config.toml, .dlt/secrets.toml
├── macro_ingest/
│   ├── clients.py          ← configured REST clients
│   ├── resilience.py       ← Throttle, CircuitBreaker, ErrorLog, PayloadError
│   ├── boc.py              ← v2: RESTClient + per-series state + isolation
│   ├── fred.py
│   ├── statcan.py          ← v2: batched vectors + isolation
│   └── statcan_tables.py   ← full tables, change detection, chunked loading
├── ingest.py               ← v2: flags, run summaries, alerts, exit codes
├── tests/test_resilience.py
├── sql/…                   ← staging now reads raw_dlt
├── RUNBOOK.md
└── pipeline.sh
```

---

# DAY 28 — dlt's REST Toolkit

| Time | Block |
|---|---|
| 0:00 – 0:25 | 28.1 `RESTClient`: a configured client instead of raw `requests` |
| 0:25 – 0:45 | 28.2 Authentication helpers (FRED API key) |
| 0:45 – 0:53 | Break |
| 0:53 – 1:23 | 28.3 Pagination: fetching data that arrives in pages (World Bank) |
| 1:23 – 1:45 | 28.4 The declarative REST API source |
| 1:45 – 1:53 | Break |
| 1:53 – 2:08 | 28.5 POST endpoints: StatCan WDS through `RESTClient` |
| 2:08 – 2:30 | 28.6 Mini-project: a declarative G7 GDP-growth source |

Reuse the practice helpers from Day 24 (`common.py` with `practice_pipeline` and `reset`). Copy it into `day28/`, `day29/` and `day30/`.

---

## 28.1 `RESTClient` (25 min)

> **Question it answers:** How do I set up the Bank of Canada API once (address, headers, paging) and reuse it for every request?
>
> **Other questions you can answer the same way:**
> - How do I stop repeating the same request settings in every resource?

So far every resource built URLs and called `requests.get` itself. `RESTClient` bundles the things every call to one API shares (base URL, headers, authentication, pagination) into a single configured object. It uses dlt's retrying session underneath.

Create `day28/rest_client_basics.py`:

```python
from dlt.sources.helpers.rest_client import RESTClient
from dlt.sources.helpers.rest_client.paginators import SinglePagePaginator

valet = RESTClient(
    base_url="https://www.bankofcanada.ca/valet/",
    headers={"User-Agent": "macro-data-course/1.0 (educational use)"},
    paginator=SinglePagePaginator(),        # Valet returns everything in one response
)

# 1. A single request
resp = valet.get("observations/V39079/json", params={"recent": 3})
resp.raise_for_status()
print(resp.json()["observations"])

# 2. paginate(): yields pages of *items*, extracted with a data selector
for page in valet.paginate("observations/FXCADUSD/json",
                           params={"recent": 5},
                           data_selector="observations"):
    print(type(page), len(page))            # one page (a list) of observation dicts
    print(page[0])
```

| Concept | Meaning |
|---|---|
| `base_url` | shared prefix; calls use relative paths |
| `headers` | sent with every request (identification, auth) |
| `paginator` | how to find the next page (28.3) |
| `data_selector` | a JSONPath telling the client where the items are in the response |

### JSONPath in one table

| JSONPath | Selects |
|---|---|
| `observations` or `$.observations` | the `observations` field |
| `$.seriesDetail.V39079.label` | a nested field |
| `$[1]` | the second element of a top-level list |
| `$[0].pages` | field `pages` of the first list element |

### Why bother?

- **One place to configure** each API: change a header or timeout once, not in every resource.
- **Retries** come from dlt's session (configured on Day 29).
- **Pagination** becomes a parameter instead of a hand-written loop.
- The same client works in code-based resources **and** the declarative source (28.4).

---

## 28.2 Authentication Helpers (20 min)

> **Question it answers:** How do I attach my FRED API key to every request automatically, without it appearing in my code?
>
> **Other questions you can answer the same way:**
> - How do I use APIs that need a token or a password?

dlt ships authentication classes so secrets are attached consistently, and never appear in your resource code.

```python
import dlt
from dlt.sources.helpers.rest_client import RESTClient
from dlt.sources.helpers.rest_client.auth import APIKeyAuth

fred = RESTClient(
    base_url="https://api.stlouisfed.org/fred/",
    auth=APIKeyAuth(name="api_key",
                    api_key=dlt.secrets["sources.fred.api_key"],   # Day 23
                    location="query"),                             # ?api_key=... on every call
)

resp = fred.get("series/observations",
                params={"series_id": "FEDFUNDS", "file_type": "json", "limit": 3,
                        "sort_order": "desc"})
resp.raise_for_status()
print(resp.json()["observations"])
```

| Auth class | Sends the secret as… | Typical API |
|---|---|---|
| `APIKeyAuth(location="query")` | a URL parameter | FRED |
| `APIKeyAuth(location="header")` | a header | many commercial data APIs |
| `BearerTokenAuth(token)` | `Authorization: Bearer …` | OAuth-style APIs |
| `HttpBasicAuth(user, pwd)` | basic auth | older enterprise APIs |

> **Students without a FRED key:** read along. Every exercise today also has a keyless alternative (Valet, World Bank, StatCan).

---

## 28.3 Pagination (30 min)

Many APIs return large results in **pages**: records 1–100, then 101–200, and so on. The API tells you how to get the next page, and a **paginator** knows how to follow those instructions.

| API style | How the next page is found | dlt paginator |
|---|---|---|
| Page numbers | `?page=2`, `?page=3` … until `pages` is reached | `PageNumberPaginator` |
| Offset / limit | `?offset=100&limit=100` … until `total` is reached | `OffsetPaginator` |
| Link in the response body | a `next` URL in the JSON | `JSONLinkPaginator` |
| Link in the headers | a `Link: <...>; rel="next"` header | `HeaderLinkPaginator` |
| Cursor | an opaque token in the response | `JSONResponseCursorPaginator` |
| No pagination | everything in one response | `SinglePagePaginator` |

### A keyless, paginated, economic API: the World Bank

> **Question it answers:** What does a World Bank indicator response look like, and how many pages of results does it have?
>
> **Other questions you can answer the same way:**
> - What was Canada's GDP growth according to the World Bank?

The World Bank Indicators API returns a two-element list: **metadata** (including the total number of pages), then the **records**:

```bash
curl -s "https://api.worldbank.org/v2/country/CAN/indicator/NY.GDP.MKTP.KD.ZG?format=json&per_page=3&page=1" | python -m json.tool | head -40
```

```
[
  {"page": 1, "pages": 22, "per_page": 3, "total": 65, ...},   ← $[0]
  [ {"country": {...}, "date": "2024", "value": 1.5, ...}, ... ] ← $[1]
]
```

Create `day28/world_bank.py`:

```python
from dlt.sources.helpers.rest_client import RESTClient
from dlt.sources.helpers.rest_client.paginators import PageNumberPaginator

wb = RESTClient(
    base_url="https://api.worldbank.org/v2/",
    paginator=PageNumberPaginator(
        base_page=1,              # the first page is 1, not 0
        page_param="page",        # the query parameter holding the page number
        total_path="$[0].pages",  # where the total number of pages is found
    ),
)

G7 = "CAN;USA;GBR;DEU;FRA;ITA;JPN"
n_pages = 0
records = []
for page in wb.paginate(f"country/{G7}/indicator/NY.GDP.MKTP.KD.ZG",
                        params={"format": "json", "per_page": 50, "date": "2000:2025"},
                        data_selector="$[1]"):
    n_pages += 1
    records.extend(page)

print(f"{n_pages} pages, {len(records)} records")
print(records[0])
```

`per_page=50` is deliberately small so you **see** several pages. In production, use the largest page size the API allows, because fewer requests means faster runs and fewer chances to fail.

### Try it 28.3

Turn the loop above into a `@dlt.resource` named `wb_gdp_growth` that yields each page, with `write_disposition="replace"`. Load it into a practice pipeline, then query the average real GDP growth by country for 2015–2019 vs 2021–2024. (Remember Day 26: the nested `country` object becomes `country__id` / `country__value` columns.)

<details>
<summary>Solution</summary>

```python
import dlt
from common import practice_pipeline, reset


@dlt.resource(name="wb_gdp_growth", write_disposition="replace")
def wb_gdp_growth():
    yield from wb.paginate(f"country/{G7}/indicator/NY.GDP.MKTP.KD.ZG",
                           params={"format": "json", "per_page": 100, "date": "2000:2025"},
                           data_selector="$[1]")


reset("rest_lab")
p = practice_pipeline("rest_lab", "lab")
print(p.run(wb_gdp_growth()))
```

```sql
SELECT country__value AS country,
       ROUND(AVG(value) FILTER (WHERE CAST(date AS INT) BETWEEN 2015 AND 2019), 2) AS avg_2015_19,
       ROUND(AVG(value) FILTER (WHERE CAST(date AS INT) BETWEEN 2021 AND 2024), 2) AS avg_2021_24
FROM lab.wb_gdp_growth
GROUP BY country
ORDER BY avg_2021_24 DESC;
```

`yield from wb.paginate(...)` hands each page to dlt as it arrives: a generator feeding a generator (Day 21).

</details>

---

## 28.4 The Declarative REST API Source (23 min)

For many APIs you don't need to write resource code at all. You **describe** the API in a dictionary, and dlt's `rest_api_source` builds the resources.

### Example 1 — World Bank, declaratively

> **Question it answers:** What was Canada's real GDP growth each year, loaded from the World Bank by configuration alone?
>
> **Other questions you can answer the same way:**
> - How do I load a paginated API without writing a loop?

```python
from dlt.sources.rest_api import rest_api_source
from common import practice_pipeline

config = {
    "client": {
        "base_url": "https://api.worldbank.org/v2/",
        "paginator": {"type": "page_number", "base_page": 1,
                      "page_param": "page", "total_path": "$[0].pages"},
    },
    "resource_defaults": {"write_disposition": "replace"},
    "resources": [
        {
            "name": "wb_gdp_growth_decl",
            "endpoint": {
                "path": "country/CAN;USA;GBR;DEU;FRA;ITA;JPN/indicator/NY.GDP.MKTP.KD.ZG",
                "params": {"format": "json", "per_page": 100, "date": "2000:2025"},
                "data_selector": "$[1]",
            },
        },
    ],
}

p = practice_pipeline("rest_lab", "lab")
print(p.run(rest_api_source(config)))
```

Same result as 28.3, with zero resource code. The configuration *is* the extractor.

### Example 2 — Valet with a declarative incremental cursor

> **Question it answers:** How do I load only new overnight-rate observations using configuration instead of code?
>
> **Other questions you can answer the same way:**
> - How do I make a configured API load incremental?

The REST API source can also manage an incremental cursor (Day 27): it fills a query parameter with the last value seen.

```python
config = {
    "client": {"base_url": "https://www.bankofcanada.ca/valet/", "paginator": "single_page"},
    "resources": [
        {
            "name": "valet_overnight_raw",
            "write_disposition": "merge",
            "primary_key": "d",
            "endpoint": {
                "path": "observations/V39079/json",
                "data_selector": "observations",
                "params": {
                    "start_date": {"type": "incremental", "cursor_path": "d",
                                   "initial_value": "2025-01-01"},
                },
            },
        },
    ],
}
p.run(rest_api_source(config))
```

Run it twice. The second run requests only data after the last `d` it loaded. The table keeps Valet's raw shape (`d`, and a flattened column for `V39079.v`), which a staging view would clean (Day 26.4).

### Declarative or code?

| Declarative `rest_api_source` | Code-based resources (Days 21–27) |
|---|---|
| ✓ very little code; easy to add endpoints | ✓ any logic you need |
| ✓ pagination, auth, incremental built in | ✓ custom state (per-series cursors, Day 27.4) |
| ✗ awkward for "keys as data" reshaping (Day 26.3) | ✓ easy per-item error isolation (Day 29) |
| ✗ harder to add custom validation and error handling | ✗ more code to maintain |
| **Best for:** well-structured, paginated APIs (World Bank, most SaaS APIs) | **Best for:** quirky APIs with economic parsing rules (Valet's wide format, StatCan statuses) |

For our **core** BoC and StatCan extractors, we'll keep code-based resources but build them on `RESTClient`. For **new, well-behaved** APIs, start declarative.

> The REST API source also supports dependent resources (the declarative version of Day 22's transformers), processing steps and many paginator options. Its documentation is worth browsing once you're comfortable with the basics.

---

## 28.5 POST Endpoints: StatCan WDS Through `RESTClient` (15 min)

> **Question it answers:** What happens when one of the StatCan vectors I request doesn't exist?
>
> **Other questions you can answer the same way:**
> - How do I call an API that needs a JSON request body?

StatCan's vector endpoints use **POST** with a JSON body (Day 10). `RESTClient` handles that too:

```python
from dlt.sources.helpers.rest_client import RESTClient
from dlt.sources.helpers.rest_client.paginators import SinglePagePaginator

wds = RESTClient(base_url="https://www150.statcan.gc.ca/t1/wds/rest/",
                 paginator=SinglePagePaginator())

resp = wds.post("getDataFromVectorsAndLatestNPeriods",
                json=[{"vectorId": 41690973, "latestN": 3},
                      {"vectorId": 999999999, "latestN": 3}])     # a vector that doesn't exist
resp.raise_for_status()
for item in resp.json():
    print(item["status"], str(item["object"])[:80])
```

Notice: **HTTP 200**, yet one item says `FAILED`. `raise_for_status()` can't catch this, so your code must check each item's `status`. This is the most important StatCan-specific resilience rule, and we build it in on Day 29.

---

## 28.6 Mini-Project: A Declarative G7 GDP-Growth Source (23 min)

> **Question it answers:** How did real GDP growth, inflation and unemployment compare across the G7 countries since 2000?
>
> **Other questions you can answer the same way:**
> - Did Canada grow faster than the US after 2020?
> - Which G7 economy had the highest inflation in 2022?

Extend the World Bank configuration to three indicators, each as its own resource, loaded into one dataset:

| Resource name | Indicator code | Meaning |
|---|---|---|
| `wb_gdp_growth` | `NY.GDP.MKTP.KD.ZG` | real GDP growth, % |
| `wb_inflation` | `FP.CPI.TOTL.ZG` | CPI inflation, % |
| `wb_unemployment` | `SL.UEM.TOTL.ZS` | unemployment, % of labour force (ILO estimate) |

Requirements:
1. Build the `resources` list with a **Python loop** over a dictionary of `{name: indicator_code}`, so adding an indicator is a one-line change.
2. Put the country list and date range in `.dlt/config.toml` under `[sources.world_bank]` and read them with `dlt.config["sources.world_bank.countries"]`, etc.
3. After loading, write one SQL query producing a **long** table `(country, year, indicator, value)` across all three resources.
4. Which G7 economy had the highest average inflation in 2021–2023?

<details>
<summary>Solution</summary>

```toml
# .dlt/config.toml
[sources.world_bank]
countries = "CAN;USA;GBR;DEU;FRA;ITA;JPN"
date_range = "2000:2025"
```

```python
import dlt
from dlt.sources.rest_api import rest_api_source
from common import practice_pipeline

INDICATORS = {
    "wb_gdp_growth": "NY.GDP.MKTP.KD.ZG",
    "wb_inflation": "FP.CPI.TOTL.ZG",
    "wb_unemployment": "SL.UEM.TOTL.ZS",
}
countries = dlt.config["sources.world_bank.countries"]
date_range = dlt.config["sources.world_bank.date_range"]

config = {
    "client": {
        "base_url": "https://api.worldbank.org/v2/",
        "paginator": {"type": "page_number", "base_page": 1,
                      "page_param": "page", "total_path": "$[0].pages"},
    },
    "resource_defaults": {"write_disposition": "replace"},
    "resources": [
        {"name": name,
         "endpoint": {"path": f"country/{countries}/indicator/{code}",
                      "params": {"format": "json", "per_page": 1000, "date": date_range},
                      "data_selector": "$[1]"}}
        for name, code in INDICATORS.items()
    ],
}

p = practice_pipeline("rest_lab", "lab")
print(p.run(rest_api_source(config, name="world_bank")))
```

```sql
WITH long AS (
    SELECT country__value AS country, CAST(date AS INT) AS year,
           'gdp_growth' AS indicator, value FROM lab.wb_gdp_growth
    UNION ALL
    SELECT country__value, CAST(date AS INT), 'inflation', value FROM lab.wb_inflation
    UNION ALL
    SELECT country__value, CAST(date AS INT), 'unemployment', value FROM lab.wb_unemployment
)
SELECT country, ROUND(AVG(value), 2) AS avg_inflation_2021_23
FROM long
WHERE indicator = 'inflation' AND year BETWEEN 2021 AND 2023
GROUP BY country
ORDER BY avg_inflation_2021_23 DESC;
```

The list comprehension builds a list of resource configurations from the dictionary: configuration generated by code, the best of both approaches.

</details>

### Day 28 checklist
- [ ] I can configure a `RESTClient` with a base URL, headers, a paginator and a data selector
- [ ] I attach API keys with dlt's auth helpers instead of hand-building URLs
- [ ] I can recognise pagination styles and configure the matching paginator
- [ ] I can describe an API declaratively with `rest_api_source`, including an incremental cursor
- [ ] I can call POST endpoints and I know that HTTP 200 doesn't mean every item succeeded
- [ ] I can decide when declarative beats code, and vice versa

```bash
git add .
git commit -m "Day 28: RESTClient, auth, pagination, declarative REST sources"
git push
```

---

# DAY 29 — Resilience Engineering

| Time | Block |
|---|---|
| 0:00 – 0:18 | 29.1 A taxonomy of failures |
| 0:18 – 0:35 | 29.2 Retries and timeouts, configured centrally |
| 0:35 – 0:55 | 29.3 Throttling and batching |
| 0:55 – 1:03 | Break |
| 1:03 – 1:30 | 29.4 Isolation: error logs and circuit breakers |
| 1:30 – 1:45 | 29.5 Validating payloads |
| 1:45 – 1:53 | Break |
| 1:53 – 2:18 | 29.6 Testing failures offline with `requests-mock` |
| 2:18 – 2:30 | 29.7 Run summaries and alerts |

---

## 29.1 A Taxonomy of Failures (18 min)

Resilient code starts with naming what can go wrong, and deciding **in advance** what to do about each case.

| # | Failure | Example | Retry? | Right response |
|---|---|---|---|---|
| 1 | Network blip / timeout | Codespaces loses connectivity briefly | ✓ | retry with backoff |
| 2 | Server error (5xx) | Valet under maintenance | ✓ | retry, then give up for this run |
| 3 | Rate limited (429) | too many calls in a short time | ✓ | wait (honour `Retry-After`), slow down |
| 4 | Client error (4xx) | a mistyped series code → 404 | ✗ | record, skip that series, fix config |
| 5 | Logical failure in a 200 | StatCan item `status: FAILED` | ✗ | record, skip that item |
| 6 | Malformed payload | missing `observations` key, unparsable dates | ✗ | record, skip, investigate |
| 7 | Schema drift | new or retyped field | ✗ | contract decides (Day 25) |
| 8 | Stale data | API "works" but the last value is months old | ✗ | freshness test, alert |
| 9 | Sustained outage | every call fails | ✗ | stop early (circuit breaker), alert |
| 10 | Destination problems | `macro.duckdb` locked by an open CLI | ✗ | fail clearly; runbook entry |

Two principles follow:
1. **Retry only what time can fix** (rows 1–3).
2. **Isolate everything else**: one bad series should cost you *that series*, not the whole run.

---

## 29.2 Retries and Timeouts, Configured Centrally (18 min)

> **Question it answers:** How long should each request wait, and how many times should it retry, for every source at once?
>
> **Other questions you can answer the same way:**
> - How do I make the pipeline more patient with a slow API?

dlt's `requests` helper, and therefore `RESTClient`, retries automatically. Its behaviour is controlled by **configuration**, not code. Add to `.dlt/config.toml`:

```toml
[runtime]
log_level = "WARNING"
request_timeout = 30              # seconds before a request is abandoned
request_max_attempts = 5          # total attempts per request (1 = no retries)
request_backoff_factor = 1        # exponential backoff: ~1s, 2s, 4s, ...
request_max_retry_delay = 60      # never wait longer than this between attempts
```

These map to environment variables like `RUNTIME__REQUEST_MAX_ATTEMPTS`, so tests and schedulers can override them (Day 23).

### Watching retries happen

> **Question it answers:** How long does the pipeline keep retrying a server that always fails before giving up?
>
> **Other questions you can answer the same way:**
> - Are my retry settings reasonable for a nightly run?

```python
import time
from dlt.sources.helpers import requests

t0 = time.perf_counter()
try:
    requests.get("https://httpbin.org/status/503", timeout=10)     # always answers 503
except Exception as e:
    print(type(e).__name__)
print(f"gave up after {time.perf_counter() - t0:.1f}s")
```

Run it with different settings and compare the elapsed time:

```bash
RUNTIME__REQUEST_MAX_ATTEMPTS=1 python day29/retry_demo.py
RUNTIME__REQUEST_MAX_ATTEMPTS=4 RUNTIME__REQUEST_BACKOFF_FACTOR=1 python day29/retry_demo.py
```

(httpbin.org is a public testing service. If it's slow or down, the timings are still instructive.)

> **Retry budgets.** Retries multiply: 50 series × 5 attempts × 30 s timeout could take over two hours during an outage. That's why 29.4 adds a **circuit breaker**.

---

## 29.3 Throttling and Batching (20 min)

Retries react to overload; **throttling** prevents it. Public statistical APIs are shared infrastructure, and being polite keeps you from being blocked.

### A minimal throttle

> **Question it answers:** How do I space out my requests so I don't overload a provider's API?
>
> **Other questions you can answer the same way:**
> - How do I respect an API's rate limit?

Create `macro_ingest/resilience.py` (we'll add to it all day):

```python
"""Resilience helpers shared by all macro_ingest sources."""
import time


class Throttle:
    """Ensure at least `min_interval` seconds between successive calls to wait()."""

    def __init__(self, min_interval=0.3):
        self.min_interval = min_interval
        self._last = 0.0

    def wait(self):
        elapsed = time.monotonic() - self._last
        if elapsed < self.min_interval:
            time.sleep(self.min_interval - elapsed)
        self._last = time.monotonic()
```

`time.monotonic()` is a clock that never jumps backwards (unlike wall-clock time), which makes it the right tool for measuring intervals.

### Batching: fewer, larger requests

> **Question it answers:** How do I split 40 StatCan vectors into a few larger requests instead of 40 small ones?
>
> **Other questions you can answer the same way:**
> - How many requests does a full refresh need?

StatCan's vector endpoints accept **many vectors per POST**. One request for 40 vectors is far kinder, and more reliable, than 40 requests. But don't make batches enormous: if one huge request fails, everything in it fails.

```python
def chunked(items, size):
    """Split a list into consecutive chunks of at most `size` items."""
    for i in range(0, len(items), size):
        yield items[i:i + size]

print(list(chunked([1, 2, 3, 4, 5], 2)))     # [[1, 2], [3, 4], [5]]
```

| API | Batching possible? | Our choice |
|---|---|---|
| Valet | several series per URL (Day 8) | one series per call, for clean error isolation |
| StatCan WDS vectors | many vectors per POST | batches of ~25 |
| FRED | one series per call | throttle between calls |

> Check each provider's documentation for published request limits and service windows. StatCan's WDS user guide, for example, describes its usage limits and when data is refreshed. Encode the limits you find in configuration (`min_interval`, `batch_size`) rather than in code.

---

## 29.4 Isolation: Error Logs and Circuit Breakers (28 min)

### The error log: failures become data

> **Question it answers:** Which series failed in this run, at which step and why, while the rest still loaded?
>
> **Other questions you can answer the same way:**
> - Which series fail most often over the past month?

Instead of letting an exception end the run, catch it **per series**, record it, and move on. Add to `resilience.py`:

```python
from datetime import datetime, timezone


class PayloadError(ValueError):
    """The API answered, but the content is unusable (failure types 5–6)."""


class ErrorLog:
    """Collects per-series failures during a run; loaded afterwards as a table."""

    def __init__(self):
        self.records = []

    def add(self, source, series_id, error, stage="fetch"):
        self.records.append({
            "source": source,
            "series_id": series_id,
            "stage": stage,
            "error_type": type(error).__name__,
            "message": str(error)[:500],
            "occurred_at": datetime.now(timezone.utc),
        })

    def __len__(self):
        return len(self.records)
```

The runner (29.7) loads `ErrorLog.records` into a `raw_dlt.extraction_errors` table after each source runs, whether the run succeeded or not. Now "what failed last Tuesday?" is a SQL query.

### The circuit breaker: stop hammering a dead API

> **Question it answers:** How do I stop calling an API that is clearly down after a few failures in a row?
>
> **Other questions you can answer the same way:**
> - Was a failure a single bad series or a whole outage?

If the first several series all fail, the API is probably down. Retrying the remaining 45 series wastes time and load. A **circuit breaker** trips after N **consecutive** failures:

```python
class CircuitOpen(RuntimeError):
    """Raised when too many consecutive failures suggest a sustained outage."""


class CircuitBreaker:
    def __init__(self, max_consecutive_failures=3):
        self.max = max_consecutive_failures
        self.failures = 0

    def success(self):
        self.failures = 0

    def failure(self):
        self.failures += 1
        if self.failures >= self.max:
            raise CircuitOpen(f"{self.failures} consecutive failures — stopping this source")
```

### Putting it together in a resource

> **Question it answers:** How does one resource combine per-series cursors, throttling, the circuit breaker and the error log?
>
> **Other questions you can answer the same way:**
> - How do I make one bad series not stop the others?

```python
@dlt.resource(name="boc_observations", write_disposition="merge",
              primary_key=("series_id", "date"))
def observations():
    cursors = dlt.current.resource_state().setdefault("last_date", {})
    throttle, breaker = Throttle(min_interval), CircuitBreaker(max_failures)

    for sid in series_ids:
        start = ...                                     # per-series cursor (Day 27)
        throttle.wait()
        try:
            rows = fetch_series(client, sid, start)     # may raise HTTP/payload errors
        except CircuitOpen:
            raise
        except Exception as e:
            error_log.add("boc", sid, e)
            breaker.failure()                           # may raise CircuitOpen
            continue                                    # cursor NOT advanced
        breaker.success()
        if rows:
            cursors[sid] = max(r["date"] for r in rows).isoformat()
        yield rows
```

Why these choices?
- A failed series **doesn't advance its cursor**, so next run it will be requested from the same point and nothing is skipped.
- `CircuitOpen` is **re-raised** so the whole source fails (and its state isn't committed), and the runner reports an outage.
- One bad code (404) costs one error row, and the other series load normally.

### Try it 29.4

Without writing an API call, test the circuit breaker's logic in the Python REPL: record *failure, failure, success, failure, failure, failure* with `max_consecutive_failures=3`. On which call does it trip?

<details>
<summary>Answer</summary>

On the sixth call. The success resets the counter, so only the last three failures are consecutive.

```python
from macro_ingest.resilience import CircuitBreaker, CircuitOpen
b = CircuitBreaker(3)
for i, ok in enumerate([False, False, True, False, False, False], start=1):
    try:
        b.success() if ok else b.failure()
    except CircuitOpen as e:
        print(f"tripped on call {i}: {e}")
```

</details>

---

## 29.5 Validating Payloads (15 min)

> **Question it answers:** Even when the server answers "OK", is the content usable: right series, numeric values, sensible dates?
>
> **Other questions you can answer the same way:**
> - Did the API return an empty or malformed response?

HTTP 200 only means "the server answered". Before trusting the content, check it. Put the fetch-and-validate logic in **plain functions** (no dlt), so they're easy to test in 29.6.

Create `macro_ingest/parsers.py`:

```python
"""Fetch-and-validate functions: plain Python, easy to test."""
from datetime import date, timedelta

from .resilience import PayloadError


def fetch_valet_series(client, series_id, start):
    """Return long rows for one Valet series, or raise on any problem."""
    resp = client.get(f"observations/{series_id}/json",
                      params={"start_date": start.isoformat()})
    resp.raise_for_status()
    payload = resp.json()

    if "observations" not in payload:
        raise PayloadError(f"{series_id}: no 'observations' in response")
    if series_id not in payload.get("seriesDetail", {}):
        raise PayloadError(f"{series_id}: series missing from 'seriesDetail'")

    tomorrow = date.today() + timedelta(days=1)
    rows = []
    for obs in payload["observations"]:
        cell = obs.get(series_id)
        try:
            d = date.fromisoformat(obs["d"])
            value = float(cell.get("v"))
        except (KeyError, AttributeError, TypeError, ValueError):
            continue                                      # unusable value: skip quietly
        if d > tomorrow:
            raise PayloadError(f"{series_id}: observation dated in the future ({d})")
        rows.append({"date": d, "series_id": series_id, "value": value, "source": "boc"})
    return rows


def parse_wds_items(payload, error_log):
    """Split a WDS vector response into long rows; log FAILED items."""
    if not isinstance(payload, list):
        raise PayloadError("WDS response is not a list")
    rows = []
    for item in payload:
        obj = item.get("object")
        if item.get("status") != "SUCCESS" or not isinstance(obj, dict):
            error_log.add("statcan", str(obj)[:60], PayloadError(f"item status {item.get('status')}"),
                          stage="item")
            continue
        sid = f"v{obj.get('vectorId')}"
        for dp in obj.get("vectorDataPoint", []):
            if dp.get("value") is None:
                continue
            rows.append({"date": date.fromisoformat(dp["refPer"][:10]), "series_id": sid,
                         "value": float(dp["value"]), "source": "statcan"})
    return rows
```

What gets **skipped quietly** (individual unusable values, as since Day 2) versus what **fails the series** (structural problems that suggest the API changed or broke) is a deliberate, documented choice.

---

## 29.6 Testing Failures Offline with `requests-mock` (25 min)

> **Question it answers:** Does my pipeline handle outages, bad statuses and broken payloads correctly, without calling the real API?
>
> **Other questions you can answer the same way:**
> - Will the circuit breaker trip after three failures?

You can't wait for Valet to go down to test your outage handling. **Mocking** replaces real HTTP responses with scripted ones, so tests run offline, instantly and deterministically.

```bash
pip install pytest requests-mock
pip freeze > requirements.txt
```

Create `tests/test_resilience.py`:

```python
import os
from datetime import date

import pytest
import requests_mock as rm

os.environ["RUNTIME__REQUEST_MAX_ATTEMPTS"] = "2"       # keep tests fast
os.environ["RUNTIME__REQUEST_BACKOFF_FACTOR"] = "0"

from macro_ingest.clients import valet_client            # built in 30.2
from macro_ingest.parsers import fetch_valet_series, parse_wds_items
from macro_ingest.resilience import CircuitBreaker, CircuitOpen, ErrorLog, PayloadError

BASE = "https://www.bankofcanada.ca/valet/"
GOOD = {"seriesDetail": {"V39079": {"label": "Overnight"}},
        "observations": [{"d": "2026-07-01", "V39079": {"v": "2.25"}},
                         {"d": "2026-07-02", "V39079": {"v": "Bank holiday"}}]}


def test_valid_payload_parses_and_skips_bad_values():
    with rm.Mocker() as m:
        m.get(f"{BASE}observations/V39079/json", json=GOOD)
        rows = fetch_valet_series(valet_client(), "V39079", date(2026, 7, 1))
    assert len(rows) == 1 and rows[0]["value"] == 2.25


def test_unknown_series_raises_http_error():
    with rm.Mocker() as m:
        m.get(f"{BASE}observations/NOPE/json", status_code=404)
        with pytest.raises(Exception):
            fetch_valet_series(valet_client(), "NOPE", date(2026, 7, 1))


def test_transient_503_then_success_recovers():
    with rm.Mocker() as m:
        m.get(f"{BASE}observations/V39079/json",
              [{"status_code": 503}, {"json": GOOD}])      # first call fails, second succeeds
        rows = fetch_valet_series(valet_client(), "V39079", date(2026, 7, 1))
    assert len(rows) == 1


def test_missing_observations_is_a_payload_error():
    with rm.Mocker() as m:
        m.get(f"{BASE}observations/V39079/json", json={"seriesDetail": {}})
        with pytest.raises(PayloadError):
            fetch_valet_series(valet_client(), "V39079", date(2026, 7, 1))


def test_wds_failed_items_are_logged_not_fatal():
    log = ErrorLog()
    payload = [
        {"status": "SUCCESS", "object": {"vectorId": 41690973, "vectorDataPoint": [
            {"refPer": "2026-07-01", "value": 169.0}]}},
        {"status": "FAILED", "object": "Vector not found"},
    ]
    rows = parse_wds_items(payload, log)
    assert len(rows) == 1 and len(log) == 1


def test_circuit_breaker_trips_after_consecutive_failures():
    b = CircuitBreaker(2)
    b.failure()
    with pytest.raises(CircuitOpen):
        b.failure()
```

```bash
python -m pytest tests/test_resilience.py -v
```

Each test encodes one row of the 29.1 failure table. When you change the extractor later, these tests tell you immediately whether its resilience still holds.

> If a mocked test unexpectedly reaches the real internet or hangs, check that the URL in `m.get(...)` exactly matches what the client requests (base URL + path, including the trailing slash).

---

## 29.7 Run Summaries and Alerts (13 min)

> **Question it answers:** After each run, what loaded, what failed, and should someone be alerted?
>
> **Other questions you can answer the same way:**
> - Did last night's run need attention?

A resilient pipeline **reports**. After every run, `ingest.py` (Day 30) will:

1. load the `ErrorLog` into `raw_dlt.extraction_errors`;
2. append one row per source to `raw_dlt.ingest_runs` (status, duration, error count);
3. send an **alert** if anything failed.

A minimal alert helper, sending to any "incoming webhook" (Slack, Microsoft Teams and Discord all offer these) when one is configured, and printing otherwise. Add to `resilience.py`:

```python
import os

import requests as plain_requests      # a single, non-retried attempt is fine for alerts


def notify(message):
    """Send an alert to the webhook in NOTIFICATIONS__WEBHOOK_URL, else print it."""
    url = os.environ.get("NOTIFICATIONS__WEBHOOK_URL")
    if not url:
        print(f"[ALERT] {message}")
        return
    try:
        plain_requests.post(url, json={"text": message}, timeout=10)
    except Exception as e:                # an alert failure must never crash the pipeline
        print(f"[ALERT not delivered: {e}] {message}")
```

Store the webhook URL as a **Codespaces secret** named `NOTIFICATIONS__WEBHOOK_URL`. It's a secret: anyone with it can post to your channel.

What deserves an alert?

| Event | Alert? |
|---|---|
| One series failed (404, payload error) | ✓, low urgency: fix the config |
| A source's circuit breaker tripped | ✓, medium: provider outage |
| A contract violation (Day 25) | ✓, high: the API changed shape |
| Data is stale beyond its expected frequency | ✓, via a freshness test (Day 30) |
| Everything succeeded | ✗, but log it in `ingest_runs` |

> **Alert fatigue is real.** If the channel pings for every trivial event, people stop reading it. Alert on things that need a human, and log everything else.

### Day 29 checklist
- [ ] I can classify failures and decide which to retry
- [ ] Retry and timeout behaviour is set in `config.toml`, overridable by env vars
- [ ] I throttle and batch requests politely
- [ ] One failing series is recorded and skipped, never fatal, and its cursor doesn't advance
- [ ] A circuit breaker stops a source during sustained outages
- [ ] Payloads are validated beyond HTTP status, including StatCan's per-item status
- [ ] I test failure handling offline with mocks
- [ ] Runs produce summaries, and real problems produce alerts

```bash
git add .
git commit -m "Day 29: resilience helpers, payload validation, mocked failure tests, alerts"
git push
```

---

# DAY 30 — `macro_ingest` v2 → The Warehouse

| Time | Block |
|---|---|
| 0:00 – 0:10 | 30.1 The final architecture |
| 0:10 – 0:40 | 30.2 Resilient BoC and StatCan vector sources |
| 0:40 – 0:48 | Break |
| 0:48 – 1:10 | 30.3 Full StatCan tables: change detection + chunked loading |
| 1:10 – 1:30 | 30.4 `ingest.py` v2 |
| 1:30 – 1:38 | Break |
| 1:38 – 2:10 | 30.5 Switching the warehouse to `raw_dlt`, with a regression test |
| 2:10 – 2:30 | 30.6 Runbook, pipeline script · Module 3 recap |

---

## 30.1 The Final Architecture (10 min)

> **Question it answers:** How do all the ingestion pieces fit together, from each API to the warehouse?
>
> **Other questions you can answer the same way:**
> - Where would I add a new data provider?

```
      Bank of Canada Valet   FRED   StatCan WDS (vectors)   StatCan full tables
               │               │            │                        │
               ▼               ▼            ▼                        ▼
         ┌───────────────────────────────────────────────────────────────┐
         │ macro_ingest (dlt)                                            │
         │  RESTClient · retries · throttle · batching · circuit breaker │
         │  payload validation · per-series cursors · merge · contracts  │
         │  release-time change detection · ErrorLog                     │
         └───────────────────────────────────────────────────────────────┘
               │  python ingest.py
               ▼
  macro.duckdb ─ raw_dlt.*   boc/fred/statcan_observations, *_metadata,
               │             statcan_cpi_full, statcan_gdp_full,
               │             statcan_releases, extraction_errors, ingest_runs
               │  python load_warehouse.py   (seeds → staging → intermediate → marts)
               ▼
               seeds.* · staging.* · intermediate.* · marts.*
               │  python run_tests.py
               ▼
         data/marts/*.parquet  →  dashboards (course notebook)
```

The Day 10 path (`run_extract.py`, `macro_extract/`, `raw.observations`, `raw.statcan_*_full`) is retired today. Keep the code in Git history for reference, but nothing reads from it anymore.

---

## 30.2 Resilient BoC and StatCan Vector Sources (30 min)

### `macro_ingest/clients.py`

> **Question it answers:** Where are the configured clients for each provider defined?
>
> **Other questions you can answer the same way:**
> - How do I change the address or headers for one provider?

```python
"""Configured REST clients, one per provider."""
from dlt.sources.helpers.rest_client import RESTClient
from dlt.sources.helpers.rest_client.paginators import SinglePagePaginator

USER_AGENT = {"User-Agent": "macro-data-course/1.0 (educational use)"}


def valet_client():
    return RESTClient(base_url="https://www.bankofcanada.ca/valet/",
                      headers=USER_AGENT, paginator=SinglePagePaginator())


def wds_client():
    return RESTClient(base_url="https://www150.statcan.gc.ca/t1/wds/rest/",
                      headers=USER_AGENT, paginator=SinglePagePaginator())
```

### `macro_ingest/boc.py` (v2)

> **Question it answers:** How does the Bank of Canada source load each series incrementally, safely and independently of the others?
>
> **Other questions you can answer the same way:**
> - Why did one BoC series fail but others succeed?

```python
"""Bank of Canada Valet — resilient, incremental, isolated per series."""
from datetime import date, timedelta

import dlt

from .clients import valet_client
from .parsers import fetch_valet_series
from .resilience import CircuitBreaker, CircuitOpen, ErrorLog, Throttle

OBS_CONTRACT = {"columns": "freeze", "data_type": "freeze"}


@dlt.source(name="boc", section="boc")
def boc_source(series_ids: list = dlt.config.value,
               start_date: str = dlt.config.value,
               lookback_days: int = 14,
               min_interval: float = 0.3,
               max_consecutive_failures: int = 3,
               error_log: ErrorLog = None):
    client = valet_client()
    errors = error_log if error_log is not None else ErrorLog()

    @dlt.resource(name="boc_observations", write_disposition="merge",
                  primary_key=("series_id", "date"),
                  columns={"value": {"data_type": "double"}},
                  schema_contract=OBS_CONTRACT)
    def observations():
        cursors = dlt.current.resource_state().setdefault("last_date", {})
        throttle = Throttle(min_interval)
        breaker = CircuitBreaker(max_consecutive_failures)

        for sid in series_ids:
            start = (date.fromisoformat(cursors[sid]) - timedelta(days=lookback_days)
                     if sid in cursors else date.fromisoformat(start_date))
            throttle.wait()
            try:
                rows = fetch_valet_series(client, sid, start)
            except CircuitOpen:
                raise
            except Exception as e:
                errors.add("boc", sid, e)
                breaker.failure()
                continue
            breaker.success()
            if rows:
                cursors[sid] = max(r["date"] for r in rows).isoformat()
            yield rows

    @dlt.resource(name="boc_series_metadata", write_disposition="replace",
                  primary_key="series_id",
                  schema_contract={"columns": "evolve", "data_type": "freeze"})
    def series_metadata():
        for sid in series_ids:
            try:
                resp = client.get(f"series/{sid}/json")
                resp.raise_for_status()
                details = resp.json().get("seriesDetails", {})
                yield {"series_id": sid, "label": details.get("label"),
                       "description": details.get("description")}
            except Exception as e:
                errors.add("boc", sid, e, stage="metadata")

    return observations, series_metadata
```

Notes:
- The `error_log` argument lets the runner pass in its own `ErrorLog` and read it afterwards. Explicit arguments bypass configuration injection (Day 23).
- Metadata now uses Valet's `series/{id}/json` endpoint (Day 8.4). Check its response keys once with `print(resp.json().keys())` and adjust `seriesDetails` if your response differs.

### `macro_ingest/statcan.py` (v2): batched, isolated, incremental

> **Question it answers:** How does the StatCan source load many vectors in batches, isolating any vector that fails?
>
> **Other questions you can answer the same way:**
> - Which vectors were missing from today's response?

```python
"""Statistics Canada WDS vectors — batched POSTs, per-item isolation, merge."""
import dlt

from .clients import wds_client
from .parsers import parse_wds_items
from .resilience import CircuitBreaker, CircuitOpen, ErrorLog, Throttle


def _chunked(items, size):
    for i in range(0, len(items), size):
        yield items[i:i + size]


@dlt.source(name="statcan", section="statcan")
def statcan_source(vectors: list = dlt.config.value,
                   initial_latest_n: int = 250,
                   latest_n: int = 36,
                   batch_size: int = 25,
                   min_interval: float = 0.5,
                   max_consecutive_failures: int = 3,
                   error_log: ErrorLog = None):
    client = wds_client()
    errors = error_log if error_log is not None else ErrorLog()

    @dlt.resource(name="statcan_observations", write_disposition="merge",
                  primary_key=("series_id", "date"),
                  columns={"value": {"data_type": "double"}},
                  schema_contract={"columns": "freeze", "data_type": "freeze"})
    def observations():
        loaded = dlt.current.resource_state().setdefault("loaded_vectors", [])
        throttle = Throttle(min_interval)
        breaker = CircuitBreaker(max_consecutive_failures)

        for batch in _chunked(list(vectors), batch_size):
            body = [{"vectorId": v,
                     "latestN": latest_n if f"v{v}" in loaded else initial_latest_n}
                    for v in batch]
            throttle.wait()
            try:
                resp = client.post("getDataFromVectorsAndLatestNPeriods", json=body)
                resp.raise_for_status()
                rows = parse_wds_items(resp.json(), errors)     # FAILED items → ErrorLog
            except CircuitOpen:
                raise
            except Exception as e:
                errors.add("statcan", ",".join(f"v{v}" for v in batch), e, stage="batch")
                breaker.failure()
                continue
            breaker.success()
            for sid in {r["series_id"] for r in rows}:
                if sid not in loaded:
                    loaded.append(sid)
            yield rows

    return observations
```

The first successful load of a vector uses `initial_latest_n` (a long history), and later runs use `latest_n` (a revision window, merged). Vector IDs are recorded as loaded **only when data arrived**.

Keep the Day 27 `fred.py`, adding the same `error_log`, throttle and circuit-breaker pattern around each series (an exercise; it mirrors `boc.py`).

---

## 30.3 Full StatCan Tables: Change Detection + Chunked Loading (23 min)

The staging models (Days 18–20) need the **full** CPI and GDP tables. Loading them through dlt (instead of Day 13's `read_csv` in SQL) gives them the same run tracking as everything else. Two techniques keep this efficient:

1. **Change detection:** download only tables whose `releaseTime` changed since the last successful load (Day 27.5).
2. **Chunked loading:** read the 1M-row CSV in pieces and yield **pandas DataFrames**, which dlt loads through its fast columnar path.

### `macro_ingest/statcan_tables.py`

> **Question it answers:** How do I download a full StatCan table only when it was republished, and load it in chunks?
>
> **Other questions you can answer the same way:**
> - Was the CPI table updated today?

```python
"""Full StatCan tables: release-time change detection, streamed download, chunked load."""
import io
import os
import zipfile

import dlt
import pandas as pd
from dlt.sources.helpers import requests

from .clients import wds_client

RAW_DIR = "data/raw/statcan"


def current_release_times(product_ids):
    """{product_id (str): releaseTime} from getCubeMetadata."""
    resp = wds_client().post("getCubeMetadata",
                             json=[{"productId": int(pid)} for pid in product_ids])
    resp.raise_for_status()
    out = {}
    for item in resp.json():
        if item.get("status") == "SUCCESS":
            obj = item["object"]
            out[str(obj.get("productId"))] = obj.get("releaseTime")
    return out


def _download_zip(product_id):
    meta = wds_client().get(f"getFullTableDownloadCSV/{product_id}/en")
    meta.raise_for_status()
    info = meta.json()
    if info.get("status") != "SUCCESS":
        raise RuntimeError(f"Table {product_id}: {info.get('status')}")
    os.makedirs(RAW_DIR, exist_ok=True)
    path = os.path.join(RAW_DIR, f"{product_id}.zip")
    with requests.get(info["object"], stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(path, "wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                f.write(chunk)
    return path


@dlt.source(name="statcan_tables", section="statcan_tables")
def statcan_tables_source(tables: dict = dlt.config.value, chunk_rows: int = 200_000):
    """`tables` maps product id → destination table name."""

    def make_resource(product_id, table_name):
        @dlt.resource(name=table_name, write_disposition="replace")
        def table():
            path = _download_zip(product_id)
            with zipfile.ZipFile(path) as z:
                name = [f for f in z.namelist()
                        if f.endswith(".csv") and not f.endswith("_MetaData.csv")][0]
                with z.open(name) as fh:
                    reader = pd.read_csv(io.TextIOWrapper(fh, encoding="utf-8-sig"),
                                         dtype=str, chunksize=chunk_rows)
                    for chunk in reader:
                        chunk.columns = chunk.columns.str.strip()
                        yield chunk                       # all text: raw layer (Day 18)
        return table

    return [make_resource(pid, name) for pid, name in tables.items()]
```

Configuration:

```toml
[sources.statcan_tables]
tables = { "18100004" = "statcan_cpi_full", "36100104" = "statcan_gdp_full" }
```

Points worth noticing:
- `dtype=str` keeps every value as **text**, as a raw layer should (Day 18). Staging casts.
- `make_resource(pid, name)` is a small **factory function**: it creates one resource per table and avoids the loop-variable gotcha from Day 22.3.
- Column names will be normalised by dlt: `REF_DATE` → `ref_date`, `Products and product groups` → `products_and_product_groups`, and so on. Staging must be updated accordingly (30.5).

### The order of operations matters

> **Record a release marker only after its data has loaded successfully.**

If you recorded "CPI release of 2026-09-16 processed" and *then* the download failed, the next run would think the table is up to date and never retry. `ingest.py` therefore:

1. asks the API for current release times;
2. compares them with the last **loaded** release times stored in `raw_dlt.statcan_releases`;
3. loads only the changed tables;
4. **then** appends their release times to `raw_dlt.statcan_releases`.

---

## 30.4 `ingest.py` v2 (20 min)

> **Question it answers:** How do I run all sources (or a subset) with one command, and get a clear exit code for success, partial failure or total failure?
>
> **Other questions you can answer the same way:**
> - Did today's ingestion fully succeed?
> - How do I rerun only the StatCan source?

```python
"""ingest.py — resilient ingestion of all macro sources into DuckDB (dataset raw_dlt).

Usage:
  python ingest.py                     # incremental
  python ingest.py --full-refresh      # drop and reload all resources
  python ingest.py --only boc,statcan  # a subset of sources

Exit codes: 0 all ok · 2 partial failure · 1 nothing loaded
"""
import sys
import time
from datetime import datetime, timezone

import dlt

from macro_ingest.boc import boc_source
from macro_ingest.fred import fred_source
from macro_ingest.resilience import ErrorLog, notify
from macro_ingest.statcan import statcan_source
from macro_ingest.statcan_tables import current_release_times, statcan_tables_source

FULL_REFRESH = "--full-refresh" in sys.argv
ONLY = next((a.split("=", 1)[1] if "=" in a else sys.argv[sys.argv.index(a) + 1]
             for a in sys.argv if a.startswith("--only")), None)

SOURCES = {"boc": boc_source, "fred": fred_source, "statcan": statcan_source}


def loaded_release_times(pipeline):
    """Last successfully loaded releaseTime per product, from the warehouse itself."""
    try:
        with pipeline.sql_client() as client:
            table = client.make_qualified_table_name("statcan_releases")
            rows = client.execute_sql(
                f"SELECT product_id, MAX(release_time) FROM {table} GROUP BY 1")
        return {str(pid): rt for pid, rt in rows}
    except Exception:
        return {}                                       # first run: table doesn't exist yet


def run_source(pipeline, name, make_source, errors):
    t0 = time.perf_counter()
    status, message = "ok", None
    try:
        info = pipeline.run(make_source(error_log=errors),
                            refresh="drop_resources" if FULL_REFRESH else None)
        info.raise_on_failed_jobs()
    except Exception as e:
        status, message = "failed", f"{type(e).__name__}: {str(e)[:300]}"
    return {"source": name, "status": status, "message": message,
            "duration_s": round(time.perf_counter() - t0, 1)}


def main():
    started = datetime.now(timezone.utc)
    pipeline = dlt.pipeline(pipeline_name="macro_ingest", destination="duckdb",
                            dataset_name="raw_dlt", export_schema_path="schemas/export")
    wanted = set(ONLY.split(",")) if ONLY else set(SOURCES) | {"statcan_tables"}
    summaries, errors = [], ErrorLog()

    # 1. Observation sources, each isolated
    for name, make_source in SOURCES.items():
        if name in wanted:
            s = run_source(pipeline, name, make_source, errors)
            summaries.append(s)
            print(f"{'✓' if s['status'] == 'ok' else '✗'} {name} ({s['duration_s']}s)")

    # 2. Full tables, only when republished
    if "statcan_tables" in wanted:
        t0 = time.perf_counter()
        try:
            tables = dlt.config["sources.statcan_tables.tables"]
            current = current_release_times(tables.keys())
            loaded = loaded_release_times(pipeline)
            changed = {pid: tbl for pid, tbl in tables.items()
                       if FULL_REFRESH or current.get(pid) != loaded.get(pid)}
            if changed:
                info = pipeline.run(statcan_tables_source(tables=changed))
                info.raise_on_failed_jobs()
                pipeline.run([{"product_id": pid, "release_time": current.get(pid),
                               "loaded_at": datetime.now(timezone.utc)} for pid in changed],
                             table_name="statcan_releases", write_disposition="append")
            print(f"✓ statcan_tables: {len(changed)} table(s) refreshed")
            summaries.append({"source": "statcan_tables", "status": "ok",
                              "message": f"refreshed {sorted(changed)}",
                              "duration_s": round(time.perf_counter() - t0, 1)})
        except Exception as e:
            print(f"✗ statcan_tables: {e}")
            summaries.append({"source": "statcan_tables", "status": "failed",
                              "message": str(e)[:300],
                              "duration_s": round(time.perf_counter() - t0, 1)})

    # 3. Record errors and the run summary (always)
    if errors.records:
        pipeline.run(errors.records, table_name="extraction_errors", write_disposition="append")
    for s in summaries:
        s.update({"run_started_at": started, "series_errors": len(errors)})
    pipeline.run(summaries, table_name="ingest_runs", write_disposition="append")

    # 4. Alert and exit
    failed = [s["source"] for s in summaries if s["status"] != "ok"]
    if failed or errors.records:
        notify(f"macro_ingest: failed sources {failed or 'none'}; "
               f"{len(errors)} series-level error(s). See raw_dlt.extraction_errors.")
    if len(failed) == len(summaries):
        sys.exit(1)
    if failed or errors.records:
        sys.exit(2)


if __name__ == "__main__":
    main()
```

Run it:

```bash
python ingest.py --full-refresh
python ingest.py                     # incremental: fast, and tables are skipped if unchanged
```

```sql
SELECT run_started_at, source, status, duration_s, series_errors, message
FROM raw_dlt.ingest_runs ORDER BY run_started_at DESC, source LIMIT 10;

SELECT * FROM raw_dlt.extraction_errors ORDER BY occurred_at DESC LIMIT 10;
SELECT * FROM raw_dlt.statcan_releases ORDER BY loaded_at DESC;
```

### Try it 30.4 — prove the isolation works

Temporarily add a bogus code (`"NOT_A_SERIES"`) to `[sources.boc] series_ids`. Run `python ingest.py --only boc` and verify that: (a) the other BoC series still load; (b) an error row appears in `extraction_errors`; (c) the exit code is `2` (`echo $?`); (d) an alert is printed or sent. Then remove the bogus code.

---

## 30.5 Switching the Warehouse to `raw_dlt`, with a Regression Test (33 min)

### Step 1 — Snapshot the marts **before** the switch

> **Question it answers:** How do I save the current final tables so I can prove the new pipeline produces the same results?
>
> **Other questions you can answer the same way:**
> - What did the marts look like before the migration?

```bash
mkdir -p data/migration
duckdb macro.duckdb -readonly -c "
COPY marts.macro_monthly   TO 'data/migration/before_macro_monthly.parquet'   (FORMAT parquet);
COPY marts.macro_quarterly TO 'data/migration/before_macro_quarterly.parquet' (FORMAT parquet);
COPY marts.policy_cycles   TO 'data/migration/before_policy_cycles.parquet'   (FORMAT parquet);"
```

### Step 2 — A series seed replaces `raw.dim_series`

> **Question it answers:** How do I record, for every series, its source, frequency, monthly aggregation rule and how stale it may get?
>
> **Other questions you can answer the same way:**
> - Which series should be averaged and which taken at month-end?
> - How old can the oil price be before it's a problem?

Add to `sql/03_seeds.sql`. This turns the Day 20 stretch goal into reality: the aggregation rule lives in data, not in a `CASE`.

```sql
-- Grain: one row per ingested series
CREATE OR REPLACE TABLE seeds.seed_series (
    series_id           VARCHAR PRIMARY KEY,
    series_name         VARCHAR NOT NULL UNIQUE,
    source              VARCHAR NOT NULL,
    frequency           VARCHAR NOT NULL,
    monthly_agg         VARCHAR NOT NULL CHECK (monthly_agg IN ('last', 'mean')),
    max_staleness_days  INTEGER NOT NULL
);
INSERT INTO seeds.seed_series VALUES
    ('V39079',             'overnight_rate',    'boc',     'daily',   'last', 10),
    ('FXCADUSD',           'cad_usd',           'boc',     'daily',   'mean', 10),
    ('BD.CDN.2YR.DQ.YLD',  'yield_2yr',         'boc',     'daily',   'mean', 10),
    ('BD.CDN.10YR.DQ.YLD', 'yield_10yr',        'boc',     'daily',   'mean', 10),
    ('FEDFUNDS',           'fed_funds',         'fred',    'monthly', 'last', 75),
    ('DCOILWTICO',         'wti',               'fred',    'daily',   'mean', 15),
    ('CANLOLITOAASTSAM',   'oecd_cli',          'fred',    'monthly', 'mean', 120),
    ('v41690973',          'cpi_all_items',     'statcan', 'monthly', 'last', 75),
    ('v2062815',           'unemployment_rate', 'statcan', 'monthly', 'last', 60);
```

`max_staleness_days` reflects each series' publication rhythm (e.g. monthly CPI appears several weeks after the month ends). Adjust the numbers to what you observe.

### Step 3 — Point staging at `raw_dlt`

> **Question it answers:** How do I switch the cleaned observations table to read from the new dlt tables?
>
> **Other questions you can answer the same way:**
> - Which source does each staged observation come from?

**`sql/12_stg_macro__observations.sql`**

```sql
-- staging.stg_macro__observations
-- Source: raw_dlt.{boc,fred,statcan}_observations (dlt, incremental, merged)
-- Grain:  one row per series × observation date
CREATE OR REPLACE VIEW staging.stg_macro__observations AS
WITH unioned AS (
    SELECT date, series_id, value, source, _dlt_load_id FROM raw_dlt.boc_observations
    UNION ALL
    SELECT date, series_id, value, source, _dlt_load_id FROM raw_dlt.fred_observations
    UNION ALL
    SELECT date, series_id, value, source, _dlt_load_id FROM raw_dlt.statcan_observations
)
SELECT u.date          AS obs_date,
       u.series_id,
       s.series_name,
       u.source,
       u.value,
       s.frequency,
       s.monthly_agg,
       l.inserted_at   AS loaded_at
FROM unioned AS u
JOIN seeds.seed_series AS s USING (series_id)
LEFT JOIN raw_dlt._dlt_loads AS l ON l.load_id = u._dlt_load_id;
```

**`sql/23_int_rates__monthly.sql`**: replace the hard-coded `CASE WHEN series_name IN (...)` with the seed's rule:

```sql
CASE WHEN monthly_agg = 'last' THEN arg_max(value, obs_date) ELSE AVG(value) END AS value
```

(and add `monthly_agg` to that CTE's `GROUP BY ALL`, which happens automatically).

**`sql/10_stg_statcan__cpi.sql`**: the source is now `raw_dlt.statcan_cpi_full`, with normalised names:

```sql
WITH source AS (
    SELECT * FROM raw_dlt.statcan_cpi_full
),
renamed AS (
    SELECT
        CAST(ref_date || '-01' AS DATE)          AS month,
        geo,
        products_and_product_groups              AS component,
        vector                                   AS vector_id,
        uom                                      AS index_base,
        TRY_CAST(value AS DOUBLE)                AS cpi,
        NULLIF(TRIM(status), '')                 AS status_flag,
        COALESCE(terminated = 't', false)        AS is_terminated
    FROM source
)
-- final SELECT unchanged from Day 18
```

**`sql/11_stg_statcan__gdp.sql`**: same idea: `ref_date`, `estimates`, `prices`, `seasonal_adjustment`, `uom`, `scalar_factor`, `vector`, `value`, `status`, `geo` from `raw_dlt.statcan_gdp_full`.

> Always confirm the real column names with `DESCRIBE raw_dlt.statcan_cpi_full;` before editing. The staging layer's job is to hide such names from everything downstream, and that's why only these few files change.

### Step 4 — Find everything else that still reads the old tables

> **Question it answers:** Which files still read from the old raw tables?
>
> **Other questions you can answer the same way:**
> - Is anything left that depends on the old loader?

```bash
grep -rn "raw\.observations\|raw\.statcan\|raw\.dim_series" sql/ load_warehouse.py
```

Typical hits and fixes:
- `sql/32_policy_cycles.sql`: yields from `staging.stg_macro__observations WHERE series_name = 'yield_2yr'` (column `obs_date`); CPI from `staging.stg_statcan__cpi WHERE geo_code = 'CA' AND component = 'All-items'`.
- `sql/02_raw_tables.sql`: delete the loads of `raw.observations`, `raw.statcan_cpi`, `raw.statcan_cpi_full`, `raw.statcan_gdp_full`. Keep `raw.boc_decisions` (it's hand-maintained, more like a seed).
- `load_warehouse.py`: delete the `raw.dim_series` creation.
- Old tests referencing `raw.observations`: point them at `staging.stg_macro__observations` or `raw_dlt.*`.

### Step 5 — New tests

> **Question it answers:** Is every loaded series described in the seed, and is any series older than its allowed staleness?
>
> **Other questions you can answer the same way:**
> - Has any series stopped updating?
> - Is a new series missing its description?

```sql
-- sql/tests/series_without_seed.sql
-- severity: error
-- Every ingested series must be described in seeds.seed_series
SELECT DISTINCT series_id FROM (
    SELECT series_id FROM raw_dlt.boc_observations
    UNION SELECT series_id FROM raw_dlt.fred_observations
    UNION SELECT series_id FROM raw_dlt.statcan_observations)
ANTI JOIN seeds.seed_series USING (series_id)
```

```sql
-- sql/tests/series_freshness.sql
-- severity: warn
SELECT s.series_name, MAX(o.obs_date) AS latest, s.max_staleness_days
FROM seeds.seed_series AS s
LEFT JOIN staging.stg_macro__observations AS o USING (series_id)
GROUP BY ALL
HAVING MAX(o.obs_date) IS NULL
    OR MAX(o.obs_date) < current_date - s.max_staleness_days
```

```sql
-- sql/tests/last_ingest_run_ok.sql
-- severity: warn
SELECT source, status, message
FROM raw_dlt.ingest_runs
WHERE run_started_at = (SELECT MAX(run_started_at) FROM raw_dlt.ingest_runs)
  AND status <> 'ok'
```

### Step 6 — Rebuild and compare with the snapshot

> **Question it answers:** After switching to dlt, are the final tables identical to the snapshot taken before?
>
> **Other questions you can answer the same way:**
> - Which values, if any, changed because of the migration?

```bash
python load_warehouse.py && python run_tests.py
```

```sql
-- Months whose key values changed after the migration
WITH before AS (
    SELECT month, ROUND(overnight_rate, 6) AS overnight_rate,
           ROUND(headline_yoy, 6) AS headline_yoy, ROUND(real_rate, 6) AS real_rate
    FROM 'data/migration/before_macro_monthly.parquet'
),
after AS (
    SELECT month, ROUND(overnight_rate, 6), ROUND(headline_yoy, 6), ROUND(real_rate, 6)
    FROM marts.macro_monthly
)
SELECT 'only_before' AS side, * FROM (SELECT * FROM before EXCEPT SELECT * FROM after)
UNION ALL
SELECT 'only_after', * FROM (SELECT * FROM after EXCEPT SELECT * FROM before)
ORDER BY month, side;
```

How to read the result:
- **Differences only in the latest month(s):** new data published between snapshots. Expected.
- **Differences in old months:** revisions picked up by the lookback window, or a bug in the migration. Investigate each one.
- **Nothing at all:** a clean migration.

> This technique, **snapshot → change → compare**, is called a *regression test*. Use it whenever you refactor a pipeline: it proves you changed the plumbing, not the numbers.

---

## 30.6 Runbook, Pipeline Script · Module 3 Recap (20 min)

### `pipeline.sh` (updated)

> **Question it answers:** How do I run ingest, build and test in one go, continuing when only some sources failed?
>
> **Other questions you can answer the same way:**
> - Is the warehouse up to date today?

```bash
#!/usr/bin/env bash
# pipeline.sh — ingest → build → test. Tolerates partial ingestion failures (exit 2).
set -e
source .venv/bin/activate

python ingest.py || [ $? -eq 2 ]
python load_warehouse.py
python run_tests.py
echo "✓ Pipeline complete: data/marts/ is up to date"
```

`cmd || [ $? -eq 2 ]` means "accept exit code 2 (partial success) and continue". A complete ingestion failure (exit 1) still stops the pipeline, and the warehouse keeps its last good data.

### `RUNBOOK.md`: what to do when things break

> **Question it answers:** When something breaks, what should the person on duty check first, and what should they do?
>
> **Other questions you can answer the same way:**
> - What does a "stale series" alert mean, and how do I fix it?

A runbook is written for **someone else** (or you, at 7 a.m., half-awake). Create it at the repository root:

```markdown
# Macro pipeline runbook

## Quick health check
    duckdb macro.duckdb -readonly -c "SELECT * FROM raw_dlt.ingest_runs ORDER BY run_started_at DESC LIMIT 5"
    python run_tests.py

## Symptoms → actions
| Symptom | Likely cause | Action |
|---|---|---|
| Alert: series-level errors | typo in config, discontinued series | check raw_dlt.extraction_errors; fix .dlt/config.toml and seeds.seed_series |
| Alert: CircuitOpen for a source | provider outage | wait; rerun `python ingest.py --only <source>` later |
| PipelineStepFailed at normalize | API changed shape (contract) | inspect error + `git diff schemas/`; adapt parser; evolve deliberately |
| "database is locked" | an open DuckDB session | close CLI/notebook sessions; rerun |
| Freshness warning, no errors | provider hasn't published yet | check provider release calendar; no action |
| Marts changed for old months | revisions via lookback | expected; note in release notes |

## Full rebuild
    python ingest.py --full-refresh && python load_warehouse.py && python run_tests.py

## Adding a series
1. Add the code to `.dlt/config.toml` (sources.<provider>.series_ids / vectors)
2. Add a row to `seeds.seed_series` in `sql/03_seeds.sql`
3. `./pipeline.sh`; check the `series_without_seed` and freshness tests pass
```

Adding a series is now a two-line change with a checklist. That's the payoff of separating configuration, seeds and code.

### Module 3 recap (Days 21–30)

| Day | Capability |
|---|---|
| 21 | pipelines, resources, generators, write dispositions |
| 22 | sources vs resources, transformers, metadata as dimensions |
| 23 | configuration and secrets, dev/prod destinations, the `macro_ingest` package |
| 24 | schema inference, evolution, variant columns, schema files in Git |
| 25 | schema contracts, Pydantic validation, contract tests |
| 26 | nested JSON, child tables, JSON columns, the CPI product hierarchy |
| 27 | incremental cursors, revisions with lookback + merge, change detection, vintages |
| 28 | `RESTClient`, auth, pagination, declarative REST sources |
| 29 | failure taxonomy, retries, throttling, isolation, circuit breakers, mocked tests, alerts |
| 30 | resilient v2 extractors, full tables via dlt, warehouse migration with a regression test, runbook |

### What still hurts, and what fixes it next

| Pain point | Fixed by |
|---|---|
| Numbered SQL files and a hand-written loader decide build order | **dbt**: dependencies inferred from `ref()` |
| Staging/intermediate/marts conventions enforced only by discipline | **dbt** project structure, materialisations, macros |
| SQL tests are hand-rolled files with a custom runner | **dbt tests** (Days 31–40), then **Great Expectations** (Days 41–50) |
| `pipeline.sh` has no schedule, retries at the step level, or UI | **Prefect** (Days 51–60) |

### Day 30 checklist
- [ ] My BoC and StatCan extractors use `RESTClient`, validation, throttling, isolation and circuit breakers
- [ ] Full StatCan tables load through dlt, only when republished, in chunks, with markers recorded after success
- [ ] `ingest.py` records errors and run summaries, alerts on problems, and returns meaningful exit codes
- [ ] Staging reads `raw_dlt`, series metadata lives in `seeds.seed_series`, and the old path is retired
- [ ] A snapshot comparison shows my marts are unchanged apart from explainable differences
- [ ] My runbook explains how to diagnose failures and add a series

```bash
./pipeline.sh
git add .
git commit -m "Day 30: resilient macro_ingest v2, warehouse on raw_dlt, runbook — Module 3 complete"
git push
```
