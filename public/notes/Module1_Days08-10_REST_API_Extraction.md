# Module 1 · Python for Macroeconomics
## Days 8–10: Fetching Macro Indicators from REST APIs (BoC, FRED, Statistics Canada)

**Audience:** MSc Economics students who completed Days 1–7
**Environment:** GitHub Codespaces with the course `.venv`
**Time per day:** ~5 hours (including breaks and exercises)
**Goal by end of Day 10:** Students replace the "black box" `get_course_data.py` with their own tested extraction package, `macro_extract`. It fetches Bank of Canada, FRED and Statistics Canada series robustly, stores the raw responses, and writes one tidy staging file ready for DuckDB (Days 11–20).

---

### Where we are

On Day 3 you fetched the overnight rate with five lines of `requests`. On Day 4 you ran a download script you didn't fully understand. The course notebook's Cells 2–4 (`boc_fetch`, `fred_fetch`, `statcan_fetch`) work, but they are fragile. A single time-out, renamed column or unexpected value can break the whole pipeline.

These three days are about doing extraction **properly**:

| Day | Theme | Source |
|---|---|---|
| 8 | How web APIs work; JSON; the BoC Valet API | Bank of Canada |
| 9 | CSV endpoints, API keys, errors, retries, validation | FRED |
| 10 | Statistics Canada WDS; building a tested package | Statistics Canada |

### Target folder structure (by end of Day 10)

```
macro-data-course/
├── run_extract.py              ← one command runs all extraction
├── macro_extract/              ← your package
│   ├── __init__.py
│   ├── net.py                  ← shared HTTP session with retries
│   ├── schema.py               ← common output format + validation
│   ├── boc.py
│   ├── fred.py
│   ├── statcan.py
│   └── catalog.py              ← which series to fetch
├── tests/
│   └── test_parsers.py
├── data/
│   ├── raw/                    ← untouched API responses
│   └── staging/                ← tidy combined output
├── day08/  day09/  day10/      ← practice scripts
```

> Run everything **from the repository root** with the `.venv` active:
> ```bash
> cd /workspaces/macro-data-course
> source .venv/bin/activate
> ```

---

# DAY 8 — How Web APIs Work: The Bank of Canada Valet API

| Time | Block |
|---|---|
| 0:00 – 0:40 | 8.1 Concepts: requests, responses, URLs, status codes |
| 0:40 – 1:30 | 8.2 The `requests` library in depth |
| 1:30 – 1:45 | Break |
| 1:45 – 2:35 | 8.3 JSON: reading nested data |
| 2:35 – 3:35 | 8.4 Exploring the Valet API: series, lists, groups |
| 3:35 – 3:50 | Break |
| 3:50 – 4:30 | 8.5 From JSON to a tidy DataFrame |
| 4:30 – 5:00 | 8.6 Mini-project: a reusable `fetch_valet` function |

---

## 8.1 Concepts (40 min)

### The request–response cycle

An API works like the reference desk at a statistical agency's library:

1. You fill in a **request slip** (the URL): *"Series V39079, from 2024 onwards, as JSON."*
2. The librarian (the **server**) checks it and returns a **response**. It includes a status stamp (*found / not found / come back later*) and the data itself.

Your Python code is the **client**. Every call follows this cycle.

### Anatomy of a URL

```
https://www.bankofcanada.ca/valet/observations/V39079/json?start_date=2024-01-01&end_date=2024-12-31
└─┬─┘   └────────┬────────┘ └────────────┬──────────────┘ └──────────────────┬─────────────────────┘
scheme         host                    path                        query string (parameters)
```

| Part | Meaning |
|---|---|
| **scheme** | `https`: an encrypted connection |
| **host** | which server to contact |
| **path** | which resource: here the observations of series `V39079` in JSON format |
| **query string** | options after `?`, written as `key=value` pairs joined by `&` |

### HTTP methods

| Method | Use | Example in this course |
|---|---|---|
| `GET` | *read* data (parameters in the URL) | BoC Valet, FRED |
| `POST` | *send* a body of data with the request | StatCan vector requests (Day 10) |

### Status codes: the stamp on the response

| Code | Meaning | What to do |
|---|---|---|
| `200` | OK | Use the data |
| `301/302` | Redirected | `requests` follows automatically |
| `400` | Bad request (you asked wrongly) | Fix your parameters |
| `401/403` | Not authorised | Check your API key |
| `404` | Not found | Check the series ID or path |
| `429` | Too many requests | Slow down, then retry |
| `500/502/503/504` | Server problem | Wait and retry |

> **Rule of thumb:** 4xx = *your* mistake (retrying won't help); 5xx and 429 = *their* problem (retrying often helps). This distinction drives the retry logic on Day 9.

### Try it in the terminal first

`curl` is a command-line client. `-s` hides the progress bar and `-i` shows the response headers:

```bash
curl -s "https://www.bankofcanada.ca/valet/observations/V39079/json?recent=3"
curl -s -i "https://www.bankofcanada.ca/valet/observations/V39079/json?recent=3" | head -15
curl -s -i "https://www.bankofcanada.ca/valet/observations/NOT_A_SERIES/json" | head -1
```

The last command shows what an error looks like.

---

## 8.2 The `requests` Library in Depth (50 min)

Create `day08/requests_basics.py`.

### Example 1 — Inspecting a response

```python
import requests

url = "https://www.bankofcanada.ca/valet/observations/V39079/json?recent=5"
r = requests.get(url, timeout=20)

print("Status:", r.status_code)                     # 200
print("OK?", r.ok)                                  # True for 2xx codes
print("Content type:", r.headers["Content-Type"])   # application/json...
print("Response time:", r.elapsed.total_seconds(), "s")
print("First 300 characters:\n", r.text[:300])
```

`r.text` is the raw text. `r.json()` converts JSON text into Python dictionaries and lists.

### Example 2 — Let `requests` build the query string

Gluing strings together is error-prone. Pass parameters as a dictionary instead:

```python
base = "https://www.bankofcanada.ca/valet/observations/V39079/json"
params = {"start_date": "2025-01-01", "end_date": "2025-06-30"}

r = requests.get(base, params=params, timeout=20)
print(r.url)          # see the URL requests built for you
data = r.json()
print(len(data["observations"]), "observations")
```

### Example 3 — Always use a timeout

Without `timeout`, a hung server can freeze your script **forever**.

```python
r = requests.get(base, params={"recent": 1}, timeout=20)   # seconds
```

> **Habit:** every `requests` call gets a `timeout`. No exceptions.

### Example 4 — Turning bad statuses into errors

```python
bad = requests.get(
    "https://www.bankofcanada.ca/valet/observations/NOT_A_SERIES/json",
    timeout=20)
print(bad.status_code)

try:
    bad.raise_for_status()
except requests.HTTPError as e:
    print("Request failed:", e)
```

`raise_for_status()` does nothing on success and raises an error on 4xx/5xx. The course notebook calls it in `boc_fetch` and `fred_fetch`.

---

## 8.3 JSON: Reading Nested Data (50 min)

**JSON** (JavaScript Object Notation) is the most common format for API data. It maps directly onto Python:

| JSON | Python | Example |
|---|---|---|
| object `{}` | `dict` | `{"d": "2026-01-05"}` |
| array `[]` | `list` | `[1, 2, 3]` |
| string | `str` | `"2.25"` |
| number | `int` / `float` | `2.25` |
| `true` / `false` | `True` / `False` | |
| `null` | `None` | |

Create `day08/json_explore.py`.

### Example 1 — Pretty-printing

```python
import json
import requests

r = requests.get(
    "https://www.bankofcanada.ca/valet/observations/V39079/json",
    params={"recent": 3}, timeout=20)
payload = r.json()

print(json.dumps(payload, indent=2))
```

### Example 2 — Exploring an unknown structure, one level at a time

With a new API, work out the shape before writing any parsing code:

```python
print(type(payload))                 # dict
print(list(payload.keys()))          # ['terms', 'seriesDetail', 'observations']

print(type(payload["observations"])) # list
first = payload["observations"][0]
print(first)                         # {'d': '...', 'V39079': {'v': '2.25'}}
print(first.keys())

print(payload["seriesDetail"])       # metadata: label, description, dimension
```

### Example 3 — Navigating nested values

```python
obs = payload["observations"][-1]
date = obs["d"]
value = obs["V39079"]["v"]           # dict inside a dict
label = payload["seriesDetail"]["V39079"]["label"]

print(f"{label}: {value}% on {date}")
print(type(value))                   # str — numbers arrive as text (Day 1!)
```

### Example 4 — Safe navigation with `.get`

Real responses sometimes lack a key. Chained `.get` calls with defaults never crash:

```python
weird = {"d": "2026-01-06"}                        # no series key at all
print(weird.get("V39079", {}).get("v", ""))        # "" instead of a KeyError
```

This is the exact pattern in the notebook's `boc_fetch`: `val = o.get(series, {})`.

### Example 5 — Saving and reloading raw JSON

```python
import os

os.makedirs("data/raw/boc", exist_ok=True)
with open("data/raw/boc/V39079_sample.json", "w") as f:
    json.dump(payload, f, indent=2)

with open("data/raw/boc/V39079_sample.json") as f:
    reloaded = json.load(f)
print(reloaded == payload)      # True
```

Saving raw responses lets you re-parse later **without calling the API again**. We'll build on this on Day 9.

### Try it 8.3

Fetch the last 5 observations of `FXCADUSD`. Print the series label, and each date with its value converted to `float` and formatted to 4 decimals.

<details>
<summary>Solution</summary>

```python
code = "FXCADUSD"
r = requests.get(f"https://www.bankofcanada.ca/valet/observations/{code}/json",
                 params={"recent": 5}, timeout=20)
r.raise_for_status()
p = r.json()

print(p["seriesDetail"][code]["label"])
for obs in p["observations"]:
    print(obs["d"], f"{float(obs[code]['v']):.4f}")
```

</details>

---

## 8.4 Exploring the Valet API (60 min)

The Valet API has several useful endpoints beyond single-series observations. Create `day08/valet_explore.py`.

| Endpoint | Returns |
|---|---|
| `/valet/observations/{series}/json` | data for one series |
| `/valet/observations/{s1},{s2}/json` | several series in one call |
| `/valet/observations/group/{group}/json` | every series in a group |
| `/valet/series/{series}/json` | metadata for a series |
| `/valet/lists/series/json` | catalogue of all series |
| `/valet/lists/groups/json` | catalogue of all groups |

Useful query parameters: `start_date`, `end_date` (`YYYY-MM-DD`) and `recent` (last *n* observations).

### Example 1 — Searching the series catalogue

How did the notebook authors know `V39079` is the overnight rate? They searched the catalogue:

```python
import requests

BASE = "https://www.bankofcanada.ca/valet"

r = requests.get(f"{BASE}/lists/series/json", timeout=60)
r.raise_for_status()
catalogue = r.json().get("series", {})
print(f"{len(catalogue):,} series available")

keyword = "overnight"
for code, info in catalogue.items():
    label = info.get("label", "")
    if keyword.lower() in label.lower():
        print(f"{code:<25} {label}")
```

Try other keywords: `"CPI"`, `"USD"`, `"10 year"`.

### Example 2 — Several series in one request

```python
codes = ["BD.CDN.2YR.DQ.YLD", "BD.CDN.5YR.DQ.YLD", "BD.CDN.10YR.DQ.YLD"]
r = requests.get(f"{BASE}/observations/{','.join(codes)}/json",
                 params={"recent": 3}, timeout=30)
r.raise_for_status()
p = r.json()

print(list(p["seriesDetail"].keys()))
print(p["observations"][-1])     # one date, all three series
```

### Example 3 — A whole group (as in the notebook's Module 08)

```python
r = requests.get(f"{BASE}/observations/group/BOND_YIELDS_BENCHMARK/json",
                 params={"recent": 2}, timeout=30)
r.raise_for_status()
g = r.json()

print(g.get("groupDetail", {}).get("label"))
for code, info in g["seriesDetail"].items():
    print(f"{code:<25} {info['label']}")
```

### Example 4 — Series metadata

```python
r = requests.get(f"{BASE}/series/V39079/json", timeout=20)
print(json.dumps(r.json(), indent=2)[:800])
```

> **Documentation habit:** when you add a series to a project, record its code, label and source URL. Six months later, `V122531` means nothing to anyone.

---

## 8.5 From JSON to a Tidy DataFrame (40 min)

Valet responses are **wide**: each observation holds one date and several series. We want a **long** (tidy) table with one row per date and series. Long format is how databases and dbt (Days 31–40) prefer data.

```
Valet JSON (wide)                         Tidy (long)
{"d": "2026-01-05",                       date        series_id            value
 "BD.CDN.2YR.DQ.YLD": {"v": "2.27"},  →   2026-01-05  BD.CDN.2YR.DQ.YLD    2.27
 "BD.CDN.10YR.DQ.YLD": {"v": "3.75"}}     2026-01-05  BD.CDN.10YR.DQ.YLD   3.75
```

Create `day08/valet_to_df.py`:

```python
import pandas as pd
import requests


def parse_valet(payload):
    """Convert a Valet observations payload into a long DataFrame.

    Columns: date (datetime), series_id (str), value (float).
    Unusable values ('', 'NA', 'Bank holiday', missing keys) are dropped.
    """
    series_ids = list(payload.get("seriesDetail", {}).keys())
    rows = []
    for obs in payload.get("observations", []):
        for sid in series_ids:
            cell = obs.get(sid)
            if isinstance(cell, dict):
                rows.append({"date": obs.get("d"), "series_id": sid,
                             "value": cell.get("v")})

    df = pd.DataFrame(rows, columns=["date", "series_id", "value"])
    df["date"] = pd.to_datetime(df["date"])
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    return df.dropna(subset=["value"]).reset_index(drop=True)


codes = ["V39079", "BD.CDN.2YR.DQ.YLD", "BD.CDN.10YR.DQ.YLD"]
r = requests.get(
    f"https://www.bankofcanada.ca/valet/observations/{','.join(codes)}/json",
    params={"start_date": "2025-01-01"}, timeout=30)
r.raise_for_status()

long_df = parse_valet(r.json())
print(long_df.head())
print(long_df.groupby("series_id")["value"].agg(["count", "last"]))

# Wide again whenever you need it (Day 6)
wide = long_df.pivot(index="date", columns="series_id", values="value")
print(wide.tail())
```

Notice the separation: **fetching** (network) and **parsing** (pure data transformation) are different steps. A parser that takes a plain dictionary can be tested without internet access. We rely on this on Day 10.

---

## 8.6 Mini-Project: A Reusable `fetch_valet` Function (30 min)

Create `day08/boc_fetch.py` with a function:

```python
def fetch_valet(series_ids, start_date=None, end_date=None, recent=None):
    ...
```

Requirements:
1. Accept one code (a string) or several (a list).
2. Only include the parameters that were actually given.
3. Use a timeout and `raise_for_status()`.
4. Return the long DataFrame from `parse_valet`.
5. Test it: overnight rate since 2022; the three yields for the last 10 days.

<details>
<summary>Solution</summary>

```python
import requests
from valet_to_df import parse_valet   # reuse the parser from 8.5

BASE = "https://www.bankofcanada.ca/valet"


def fetch_valet(series_ids, start_date=None, end_date=None, recent=None):
    """Fetch one or more BoC Valet series as a long DataFrame."""
    if isinstance(series_ids, str):
        series_ids = [series_ids]

    params = {}
    if start_date:
        params["start_date"] = start_date
    if end_date:
        params["end_date"] = end_date
    if recent:
        params["recent"] = recent

    url = f"{BASE}/observations/{','.join(series_ids)}/json"
    r = requests.get(url, params=params, timeout=30)
    r.raise_for_status()
    return parse_valet(r.json())


if __name__ == "__main__":
    print(fetch_valet("V39079", start_date="2022-01-01").tail())
    yields = ["BD.CDN.2YR.DQ.YLD", "BD.CDN.5YR.DQ.YLD", "BD.CDN.10YR.DQ.YLD"]
    print(fetch_valet(yields, recent=10))
```

If `from valet_to_df import parse_valet` also runs the example code at the bottom of `valet_to_df.py`, move that code under `if __name__ == "__main__":` (Day 3).

</details>

**Compare with the notebook's `boc_fetch`:** yours handles several series per call, returns long format, and separates parsing from fetching. What does the notebook's version do that yours doesn't? (It prints a summary line and names the value column. You'll add logging on Day 9.)

### Day 8 checklist
- [ ] I can read a URL's parts and interpret status codes
- [ ] I use `params=` and `timeout=` on every request
- [ ] I can explore unfamiliar JSON step by step and navigate it safely with `.get`
- [ ] I can search the Valet catalogue and fetch several series or a whole group
- [ ] I keep fetching and parsing in separate functions

```bash
git add .
git commit -m "Day 8: HTTP, JSON, BoC Valet extraction"
git push
```

---

# DAY 9 — Robust Extraction: FRED, API Keys, Errors and Retries

| Time | Block |
|---|---|
| 0:00 – 0:45 | 9.1 FRED's CSV endpoint |
| 0:45 – 1:30 | 9.2 The official FRED API and keeping secrets safe |
| 1:30 – 1:45 | Break |
| 1:45 – 2:45 | 9.3 What goes wrong: errors and exceptions |
| 2:45 – 3:30 | 9.4 Retries and backoff |
| 3:30 – 3:45 | Break |
| 3:45 – 4:20 | 9.5 Validating responses and logging |
| 4:20 – 5:00 | 9.6 Raw landing zone + mini-project |

---

## 9.1 FRED's CSV Endpoint (45 min)

The notebook uses FRED's **graph CSV** endpoint. It needs no key and returns plain CSV text. Create `day09/fred_csv.py`.

### Example 1 — Look before you parse

```python
import requests

url = "https://fred.stlouisfed.org/graph/fredgraph.csv"
r = requests.get(url, params={"id": "FEDFUNDS"}, timeout=30)
r.raise_for_status()

print(r.headers.get("Content-Type"))
print(r.text[:200])
```

### Example 2 — CSV text → DataFrame without saving a file

`io.StringIO` wraps text so pandas can read it as if it were a file:

```python
import io
import pandas as pd


def parse_fred_csv(text, series_id):
    """Parse FRED graph CSV text into a long DataFrame."""
    df = pd.read_csv(io.StringIO(text))
    df = df.iloc[:, :2]                       # header names vary: DATE / observation_date
    df.columns = ["date", "value"]
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df["value"] = pd.to_numeric(df["value"], errors="coerce")   # "." or "" → NaN
    df["series_id"] = series_id
    return df.dropna(subset=["date", "value"])[["date", "series_id", "value"]]


fed = parse_fred_csv(r.text, "FEDFUNDS")
print(fed.tail())
```

The output has the same three columns as `parse_valet`. **One schema for every source** is the key design idea of Day 10.

### Example 3 — Several series

```python
frames = []
for sid in ["FEDFUNDS", "DCOILWTICO", "CANLOLITOAASTSAM"]:
    r = requests.get(url, params={"id": sid}, timeout=30)
    r.raise_for_status()
    frames.append(parse_fred_csv(r.text, sid))

fred_long = pd.concat(frames, ignore_index=True)
print(fred_long.groupby("series_id")["date"].agg(["min", "max", "count"]))
```

> The graph CSV endpoint is convenient but not a formally documented API, and it can change without notice. For production work, the official API (next block) is safer.

---

## 9.2 The Official FRED API and Keeping Secrets Safe (45 min)

The official FRED API returns JSON with metadata, supports date filters and is documented. It requires a free **API key**. Register at fred.stlouisfed.org, then request a key under *My Account → API Keys*.

### Rule number one: never put a key in your code

Code is committed to GitHub, and anything committed is effectively public forever. Keys belong in **environment variables**.

### Option A — Codespaces secrets (recommended)

1. On GitHub: **Settings → Codespaces → Secrets → New secret**.
2. Name: `FRED_API_KEY`. Value: your key. Repository access: `macro-data-course`.
3. Restart your Codespace. The secret now exists as an environment variable.

```bash
echo ${FRED_API_KEY:0:4}...      # prints only the first 4 characters
```

### Option B — A local `.env` file

```bash
pip install python-dotenv
echo 'FRED_API_KEY=paste_your_key_here' > .env
echo '.env' >> .gitignore            # critical: never commit .env
pip freeze > requirements.txt
```

### Reading the key in Python

```python
import os
from dotenv import load_dotenv    # only needed for Option B

load_dotenv()                      # harmless if there is no .env file
key = os.environ.get("FRED_API_KEY")
if not key:
    raise RuntimeError("FRED_API_KEY is not set. See Day 9, section 9.2.")
```

### Using the official endpoint

Create `day09/fred_api.py`:

```python
import os
import pandas as pd
import requests
from dotenv import load_dotenv

load_dotenv()
KEY = os.environ["FRED_API_KEY"]

r = requests.get(
    "https://api.stlouisfed.org/fred/series/observations",
    params={"series_id": "FEDFUNDS", "api_key": KEY, "file_type": "json",
            "observation_start": "2020-01-01"},
    timeout=30)
r.raise_for_status()
payload = r.json()

print(list(payload.keys()))
obs = pd.DataFrame(payload["observations"])[["date", "value"]]
obs["value"] = pd.to_numeric(obs["value"], errors="coerce")   # FRED uses "." for missing
print(obs.tail())
```

> **Careful with logs:** `print(r.url)` would show your key. Never print or save URLs that contain secrets.

This is a first taste of **secrets management**, which becomes central with `dlt` on Days 21–23. If you prefer not to register, keep using the CSV endpoint. The rest of the course works either way.

---

## 9.3 What Goes Wrong: Errors and Exceptions (60 min)

Pipelines fail at 3 a.m. for boring reasons. Let's cause each failure on purpose and learn to recognise it. Create `day09/failures.py`.

### Failure 1 — Wrong series ID (HTTP error)

```python
import requests

r = requests.get("https://fred.stlouisfed.org/graph/fredgraph.csv",
                 params={"id": "NOT_A_REAL_SERIES"}, timeout=30)
print(r.status_code)
try:
    r.raise_for_status()
except requests.HTTPError as e:
    print("HTTPError:", e)
```

### Failure 2 — The server is too slow (timeout)

```python
try:
    requests.get("https://www.bankofcanada.ca/valet/lists/series/json",
                 timeout=0.001)          # deliberately impossible
except requests.Timeout as e:
    print("Timeout:", type(e).__name__)
```

### Failure 3 — The host doesn't exist (connection error)

```python
try:
    requests.get("https://www.bankofcanada-typo.ca/valet", timeout=10)
except requests.ConnectionError as e:
    print("ConnectionError:", type(e).__name__)
```

### Failure 4 — The response isn't what you expected

```python
r = requests.get("https://www.bankofcanada.ca/valet/observations/V39079/csv",
                 params={"recent": 2}, timeout=20)
try:
    r.json()                 # we asked for CSV, then tried to read JSON
except ValueError as e:
    print("Not JSON:", type(e).__name__)
```

### The `requests` exception family

```
requests.RequestException          ← catches all of the below
├── requests.ConnectionError
├── requests.Timeout
└── requests.HTTPError             ← raised by raise_for_status()
```

### Handling them deliberately

```python
def safe_get(url, **kwargs):
    """GET with clear, specific error messages."""
    try:
        r = requests.get(url, timeout=30, **kwargs)
        r.raise_for_status()
        return r
    except requests.Timeout:
        print(f"✗ Timed out: {url}")
    except requests.ConnectionError:
        print(f"✗ Could not connect: {url}")
    except requests.HTTPError as e:
        print(f"✗ HTTP {e.response.status_code}: {url}")
    return None
```

`**kwargs` passes any extra keyword arguments (such as `params=...`) straight through to `requests.get`.

> **Design question:** should one failed series stop the whole pipeline? The notebook says *no*: each fetch is wrapped in `try/except` and the loop continues. That's usually right for dashboards. For a regulatory report you might prefer to stop. Decide consciously.

---

## 9.4 Retries and Backoff (45 min)

Temporary failures (timeouts, 5xx, 429) often succeed a few seconds later. **Exponential backoff** means waiting longer after each failure (1 s, 2 s, 4 s…) so you don't hammer a struggling server.

### Version 1 — Hand-written, so you see the logic

Create `day09/retries.py`:

```python
import time
import requests

RETRYABLE = {429, 500, 502, 503, 504}


def get_with_retries(url, params=None, max_attempts=4, base_wait=1.0):
    for attempt in range(1, max_attempts + 1):
        try:
            r = requests.get(url, params=params, timeout=30)
            if r.status_code in RETRYABLE:
                raise requests.HTTPError(f"retryable status {r.status_code}")
            r.raise_for_status()          # 4xx other than 429: fail immediately
            return r
        except (requests.Timeout, requests.ConnectionError, requests.HTTPError) as e:
            is_retryable = not isinstance(e, requests.HTTPError) or "retryable" in str(e)
            if attempt == max_attempts or not is_retryable:
                raise
            wait = base_wait * 2 ** (attempt - 1)
            print(f"  attempt {attempt} failed ({e}); retrying in {wait:.0f}s")
            time.sleep(wait)


r = get_with_retries("https://www.bankofcanada.ca/valet/observations/V39079/json",
                     params={"recent": 2})
print(r.status_code)
```

### Version 2 — The professional way: a `Session` with automatic retries

`requests` can retry for you through `urllib3`, which is already installed as a dependency:

```python
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


def make_session(retries=4, backoff=1.0):
    retry = Retry(
        total=retries,
        backoff_factor=backoff,                       # 1s, 2s, 4s, ...
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET", "POST"],
    )
    session = requests.Session()
    session.mount("https://", HTTPAdapter(max_retries=retry))
    session.headers.update({"User-Agent": "macro-data-course/1.0 (educational use)"})
    return session


session = make_session()
r = session.get("https://www.bankofcanada.ca/valet/observations/V39079/json",
                params={"recent": 2}, timeout=30)
print(r.json()["observations"])
```

A `Session` also **reuses connections**, which makes many calls to the same host faster. The `User-Agent` header politely identifies who is calling.

### Being a good API citizen

- Fetch only what you need (`start_date`, `recent`).
- Add a short pause between many calls: `time.sleep(0.5)`.
- Cache results (9.6) so you don't download the same data twice a day.

Orchestrators like Prefect (Days 54–57) add retries at the **task** level on top of this.

---

## 9.5 Validating Responses and Logging (35 min)

### A successful request can still contain bad data

A `200 OK` response might be empty, be missing columns, or have duplicated dates. Validate before passing data on. Create `day09/validation.py`:

```python
import pandas as pd

REQUIRED = ["date", "series_id", "value"]


def validate(df, source, min_rows=1):
    """Raise ValueError if a long DataFrame breaks basic rules."""
    missing = [c for c in REQUIRED if c not in df.columns]
    if missing:
        raise ValueError(f"{source}: missing columns {missing}")
    if len(df) < min_rows:
        raise ValueError(f"{source}: only {len(df)} rows (expected ≥ {min_rows})")
    dupes = df.duplicated(["series_id", "date"]).sum()
    if dupes:
        raise ValueError(f"{source}: {dupes} duplicate (series_id, date) rows")
    if df["value"].isna().any():
        raise ValueError(f"{source}: missing values after parsing")
    return df
```

Compare with Day 7's `check_panel`: same idea, applied at the **extraction** stage.

### Logging instead of `print`

`print` is fine for exercises. Pipelines use **logging**, which adds timestamps and severity levels and can write to files:

```python
import logging

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s | %(levelname)-7s | %(message)s")
log = logging.getLogger("extract")

log.info("Fetching FEDFUNDS")
log.warning("DCOILWTICO: 12 missing values dropped")
log.error("NOT_A_REAL_SERIES: HTTP 404")
```

| Level | Use for |
|---|---|
| `DEBUG` | detailed diagnostics (hidden by default) |
| `INFO` | normal progress |
| `WARNING` | something odd, but the pipeline continues |
| `ERROR` | a step failed |

---

## 9.6 The Raw Landing Zone + Mini-Project (40 min)

Professional pipelines **save the untouched response before parsing it**. If your parser has a bug, you fix it and re-parse without re-downloading. You also keep a record of exactly what the agency published on a given day, which matters because macro data gets **revised**.

```
data/raw/fred/FEDFUNDS/2026-09-29T14-05-12.csv
data/raw/boc/V39079/2026-09-29T14-05-10.json
```

```python
import os
from datetime import datetime, timezone


def save_raw(content, source, series_id, extension):
    """Save a raw API response under data/raw/<source>/<series>/<timestamp>."""
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    folder = os.path.join("data", "raw", source, series_id.replace("/", "_"))
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"{stamp}.{extension}")
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return path
```

### Mini-project

Create `day09/fred_robust.py` with `fetch_fred(series_id, session, start="2006-01-01")` that:

1. Uses a retrying `session` (9.4).
2. Saves the raw CSV text with `save_raw`.
3. Parses with `parse_fred_csv` and filters to `date >= start`.
4. Validates with `validate`.
5. Logs the row count and latest value.

Then loop over `["FEDFUNDS", "DCOILWTICO", "NOT_A_REAL_SERIES", "A191RL1Q225SBEA"]`, logging failures without stopping, and print a final summary of successes and failures.

<details>
<summary>Solution</summary>

```python
import logging
import pandas as pd

from fred_csv import parse_fred_csv      # move its demo code under __main__
from retries import make_session         # (same for retries.py)
from validation import validate
# save_raw: paste the function from 9.6 here or into its own file

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s | %(levelname)-7s | %(message)s")
log = logging.getLogger("fred")

URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"


def fetch_fred(series_id, session, start="2006-01-01"):
    r = session.get(URL, params={"id": series_id}, timeout=30)
    r.raise_for_status()
    path = save_raw(r.text, "fred", series_id, "csv")
    df = parse_fred_csv(r.text, series_id)
    df = df[df["date"] >= start]
    validate(df, f"fred:{series_id}")
    last = df.iloc[-1]
    log.info(f"{series_id}: {len(df)} rows, latest {last['value']} "
             f"({last['date']:%Y-%m-%d}) · raw → {path}")
    return df


session = make_session()
ok, failed, frames = [], [], []
for sid in ["FEDFUNDS", "DCOILWTICO", "NOT_A_REAL_SERIES", "A191RL1Q225SBEA"]:
    try:
        frames.append(fetch_fred(sid, session))
        ok.append(sid)
    except Exception as e:
        log.error(f"{sid}: {e}")
        failed.append(sid)

fred_long = pd.concat(frames, ignore_index=True)
log.info(f"Done: {len(ok)} succeeded, {len(failed)} failed {failed}")
```

The retrying session doesn't retry the 404 because it isn't in `status_forcelist`. That's correct: the series will never exist, however long you wait.

</details>

### Day 9 checklist
- [ ] I can parse CSV responses with `io.StringIO`
- [ ] My API keys live in environment variables, never in code or Git
- [ ] I can tell timeouts, connection errors and HTTP errors apart and handle each
- [ ] I retry only what's worth retrying, with exponential backoff
- [ ] I validate parsed data, log progress, and keep raw responses

```bash
git add .
git status            # make sure .env is NOT listed!
git commit -m "Day 9: FRED, secrets, errors, retries, validation"
git push
```

---

# DAY 10 — Statistics Canada WDS and Your Own Extraction Package

| Time | Block |
|---|---|
| 0:00 – 0:40 | 10.1 How StatCan organises data: tables, vectors, coordinates |
| 0:40 – 1:40 | 10.2 The vector endpoints (small, targeted requests) |
| 1:40 – 1:55 | Break |
| 1:55 – 2:40 | 10.3 Full-table downloads, done efficiently |
| 2:40 – 3:50 | 10.4 Building the `macro_extract` package |
| 3:50 – 4:05 | Break |
| 4:05 – 4:40 | 10.5 Testing parsers with `pytest` |
| 4:40 – 5:00 | 10.6 Run it end-to-end, recap, and look ahead |

---

## 10.1 How Statistics Canada Organises Data (40 min)

StatCan's **Web Data Service (WDS)** exposes three levels:

| Concept | Example | Meaning |
|---|---|---|
| **Table** (product ID) | `18100004` (web: 18-10-0004-01) | Consumer Price Index, monthly, not seasonally adjusted |
| **Vector** | `v41690973` | *one* series within a table, e.g. CPI All-items, Canada |
| **Coordinate** | `2.2.0.0...` | the position of a series in the table's dimensions |

The notebook downloads **whole tables** (`getFullTableDownloadCSV`): over a million rows for CPI, just to keep a handful of series. That's simple but slow. When you know which series you need, **vectors** are far more efficient.

### Finding a vector ID

1. Open the table page on statcan.gc.ca (search "18-10-0004-01").
2. Click **Add/Remove data** and select the series you want.
3. Under **Customize layout**, tick **Display Vector identifier and Coordinate**.
4. The table now shows a `v...` ID beside each series.

> Always **verify** a vector ID by fetching its metadata (10.2, Example 1) before building on it. A wrong ID returns a valid but *different* series, and nothing crashes.

---

## 10.2 The Vector Endpoints (60 min)

These WDS endpoints use **POST** with a JSON body: a list of requests. Create `day10/statcan_vectors.py`.

### Example 1 — Verify vectors via their metadata

```python
import requests

WDS = "https://www150.statcan.gc.ca/t1/wds/rest"

vectors = [41690973, 2062815]      # CPI All-items; unemployment rate (LFS)
body = [{"vectorId": v} for v in vectors]

r = requests.post(f"{WDS}/getSeriesInfoFromVector", json=body, timeout=30)
r.raise_for_status()

for item in r.json():
    if item.get("status") != "SUCCESS":
        print("✗", item)
        continue
    obj = item["object"]
    print(f"v{obj['vectorId']}: table {obj.get('productId')} · "
          f"{obj.get('SeriesTitleEn', '(no title)')}")
```

`json=body` tells `requests` to convert the Python list to JSON and set the right headers. Check that the printed titles match what you expect. If they don't, look up the correct vector (10.1) before continuing.

### Example 2 — Fetch the latest *n* periods

```python
body = [{"vectorId": v, "latestN": 24} for v in vectors]
r = requests.post(f"{WDS}/getDataFromVectorsAndLatestNPeriods", json=body, timeout=30)
r.raise_for_status()
payload = r.json()

first = payload[0]["object"]
print(first.keys())
print(first["vectorDataPoint"][-1])     # refPer (reference period), value, ...
```

### Example 3 — Parse into our standard long format

```python
import pandas as pd


def parse_vectors(payload):
    """StatCan vector payload → long DataFrame (date, series_id, value)."""
    rows = []
    for item in payload:
        if item.get("status") != "SUCCESS":
            continue
        obj = item["object"]
        sid = f"v{obj['vectorId']}"
        for dp in obj.get("vectorDataPoint", []):
            rows.append({"date": dp.get("refPer"), "series_id": sid,
                         "value": dp.get("value")})
    df = pd.DataFrame(rows, columns=["date", "series_id", "value"])
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    return df.dropna(subset=["date", "value"]).reset_index(drop=True)


stat = parse_vectors(payload)
print(stat.pivot(index="date", columns="series_id", values="value").tail())
```

Compare with `parse_valet` and `parse_fred_csv`: three different source formats, **one** output schema.

### Try it 10.2

Fetch the last 240 months of CPI All-items (`latestN: 240`) and compute the latest YoY inflation with `pct_change(12)` (Day 5). Does it match the value from your Day 7 panel?

<details>
<summary>Solution</summary>

```python
r = requests.post(f"{WDS}/getDataFromVectorsAndLatestNPeriods",
                  json=[{"vectorId": 41690973, "latestN": 240}], timeout=30)
r.raise_for_status()
cpi = parse_vectors(r.json()).set_index("date")["value"].sort_index()
yoy = cpi.pct_change(12) * 100
print(f"{yoy.iloc[-1]:.1f}% ({yoy.index[-1]:%b %Y})")
```

</details>

> For long histories between specific dates, WDS also offers `getDataFromVectorByReferencePeriodRange`. For entire tables, use the full download (next block).

---

## 10.3 Full-Table Downloads, Done Efficiently (45 min)

Sometimes you need the whole table, e.g. all CPI components for all provinces. Let's improve the notebook's `statcan_fetch` in three ways:

1. **Stream** the ZIP to disk in chunks instead of holding it all in memory.
2. **Cache** it: skip the download if a recent copy exists.
3. **Read only the columns you need** and filter immediately.

Create `day10/statcan_tables.py`:

```python
import os
import time
import zipfile

import pandas as pd
import requests

WDS = "https://www150.statcan.gc.ca/t1/wds/rest"


def download_table(table_id, session, folder="data/raw/statcan", max_age_hours=24):
    """Download a full StatCan table ZIP, reusing a recent cached copy."""
    os.makedirs(folder, exist_ok=True)
    zip_path = os.path.join(folder, f"{table_id}.zip")

    if os.path.exists(zip_path):
        age_hours = (time.time() - os.path.getmtime(zip_path)) / 3600
        if age_hours < max_age_hours:
            print(f"  using cached {zip_path} ({age_hours:.1f}h old)")
            return zip_path

    meta = session.get(f"{WDS}/getFullTableDownloadCSV/{table_id}/en", timeout=30)
    meta.raise_for_status()
    info = meta.json()
    if info.get("status") != "SUCCESS":
        raise ValueError(f"Table {table_id}: {info.get('status')}")

    with session.get(info["object"], stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(zip_path, "wb") as f:                    # "wb" = write bytes
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                f.write(chunk)
    print(f"  downloaded {zip_path} ({os.path.getsize(zip_path) / 1e6:.1f} MB)")
    return zip_path


def read_table(zip_path, columns, filters):
    """Read selected columns from a StatCan ZIP and apply {column: [values]} filters."""
    with zipfile.ZipFile(zip_path) as z:
        name = [f for f in z.namelist()
                if f.endswith(".csv") and not f.endswith("_MetaData.csv")][0]
        df = pd.read_csv(z.open(name), encoding="utf-8-sig", low_memory=False,
                         usecols=lambda c: c.strip() in columns)
    df.columns = df.columns.str.strip()
    for col, allowed in filters.items():
        df = df[df[col].isin(allowed)]
    return df
```

Usage, reproducing the notebook's CPI extraction:

```python
session = requests.Session()
path = download_table("18100004", session)
cpi = read_table(
    path,
    columns=["REF_DATE", "GEO", "Products and product groups", "VALUE"],
    filters={"GEO": ["Canada"],
             "Products and product groups": ["All-items", "Shelter", "Energy"]},
)
print(cpi.shape)
print(cpi.tail())
```

Run it twice: the second run uses the cache and finishes in seconds.

`usecols=lambda c: ...` passes a small **anonymous function** (a *lambda*) that pandas calls for each column name. We strip spaces first, remembering the notebook's hidden-BOM problem.

---

## 10.4 Building the `macro_extract` Package (70 min)

Now we assemble everything into a **package**: a folder of modules with an `__init__.py` file. It's the Day 3 `macrotools.py` idea, grown up.

```bash
mkdir -p macro_extract tests data/staging
touch macro_extract/__init__.py
```

### `macro_extract/net.py` — one shared, polite, retrying session

```python
"""Shared HTTP session with retries (Day 9)."""
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


def make_session(retries=4, backoff=1.0):
    retry = Retry(total=retries, backoff_factor=backoff,
                  status_forcelist=[429, 500, 502, 503, 504],
                  allowed_methods=["GET", "POST"])
    session = requests.Session()
    session.mount("https://", HTTPAdapter(max_retries=retry))
    session.headers.update({"User-Agent": "macro-data-course/1.0 (educational use)"})
    return session
```

> We call this module `net.py`, not `http.py`, because Python already has a built-in module named `http`. Avoid naming your files after standard modules (`http`, `json`, `csv`, `io`...).

### `macro_extract/schema.py` — one output format for every source

```python
"""Standard long schema shared by all sources, plus validation."""
import pandas as pd

COLUMNS = ["date", "series_id", "value", "source"]


def standardize(df, source):
    out = df.copy()
    out["date"] = pd.to_datetime(out["date"], errors="coerce")
    out["value"] = pd.to_numeric(out["value"], errors="coerce")
    out["source"] = source
    out = out.dropna(subset=["date", "value"])
    return out[COLUMNS].sort_values(["series_id", "date"]).reset_index(drop=True)


def validate(df, label, min_rows=1):
    missing = [c for c in COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"{label}: missing columns {missing}")
    if len(df) < min_rows:
        raise ValueError(f"{label}: only {len(df)} rows")
    dupes = int(df.duplicated(["series_id", "date"]).sum())
    if dupes:
        raise ValueError(f"{label}: {dupes} duplicate (series_id, date) rows")
    return df
```

### `macro_extract/rawstore.py` — the landing zone

```python
"""Save untouched API responses under data/raw/ (Day 9.6)."""
import os
from datetime import datetime, timezone


def save_raw(content, source, series_id, extension, root="data/raw"):
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    folder = os.path.join(root, source, series_id.replace("/", "_"))
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"{stamp}.{extension}")
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return path
```

### `macro_extract/boc.py`

```python
"""Bank of Canada Valet API."""
import pandas as pd

from .rawstore import save_raw
from .schema import standardize

BASE = "https://www.bankofcanada.ca/valet"


def parse_valet(payload):
    series_ids = list(payload.get("seriesDetail", {}).keys())
    rows = []
    for obs in payload.get("observations", []):
        for sid in series_ids:
            cell = obs.get(sid)
            if isinstance(cell, dict):
                rows.append({"date": obs.get("d"), "series_id": sid,
                             "value": cell.get("v")})
    return standardize(pd.DataFrame(rows, columns=["date", "series_id", "value"]), "boc")


def fetch(series_id, session, start="2006-01-01"):
    r = session.get(f"{BASE}/observations/{series_id}/json",
                    params={"start_date": start}, timeout=30)
    r.raise_for_status()
    save_raw(r.text, "boc", series_id, "json")
    return parse_valet(r.json())
```

The dot in `from .schema import ...` means "from this same package". That's a **relative import**.

### `macro_extract/fred.py`

```python
"""FRED graph CSV endpoint (no key required)."""
import io

import pandas as pd

from .rawstore import save_raw
from .schema import standardize

URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"


def parse_fred_csv(text, series_id):
    df = pd.read_csv(io.StringIO(text)).iloc[:, :2]
    df.columns = ["date", "value"]
    df["series_id"] = series_id
    return standardize(df, "fred")


def fetch(series_id, session, start="2006-01-01"):
    r = session.get(URL, params={"id": series_id}, timeout=30)
    r.raise_for_status()
    save_raw(r.text, "fred", series_id, "csv")
    df = parse_fred_csv(r.text, series_id)
    return df[df["date"] >= start].reset_index(drop=True)
```

### `macro_extract/statcan.py`

```python
"""Statistics Canada WDS: vector endpoint."""
import json

import pandas as pd

from .rawstore import save_raw
from .schema import standardize

WDS = "https://www150.statcan.gc.ca/t1/wds/rest"


def parse_vectors(payload):
    rows = []
    for item in payload:
        if item.get("status") != "SUCCESS":
            continue
        obj = item["object"]
        for dp in obj.get("vectorDataPoint", []):
            rows.append({"date": dp.get("refPer"),
                         "series_id": f"v{obj['vectorId']}",
                         "value": dp.get("value")})
    return standardize(pd.DataFrame(rows, columns=["date", "series_id", "value"]),
                       "statcan")


def fetch(series_id, session, latest_n=250):
    """series_id like 'v41690973'."""
    vector = int(series_id.lstrip("v"))
    r = session.post(f"{WDS}/getDataFromVectorsAndLatestNPeriods",
                     json=[{"vectorId": vector, "latestN": latest_n}], timeout=30)
    r.raise_for_status()
    payload = r.json()
    save_raw(json.dumps(payload), "statcan", series_id, "json")
    if not payload or payload[0].get("status") != "SUCCESS":
        raise ValueError(f"StatCan {series_id}: request not successful")
    return parse_vectors(payload)
```

### `macro_extract/catalog.py` — *what* to fetch, separate from *how*

```python
"""Series catalogue: add a row here to add a series to the pipeline."""

CATALOG = [
    # source     series_id               friendly name
    ("boc",     "V39079",               "overnight_rate"),
    ("boc",     "FXCADUSD",             "cad_usd"),
    ("boc",     "BD.CDN.2YR.DQ.YLD",    "yield_2yr"),
    ("boc",     "BD.CDN.10YR.DQ.YLD",   "yield_10yr"),
    ("fred",    "FEDFUNDS",             "fed_funds"),
    ("fred",    "DCOILWTICO",           "wti"),
    ("fred",    "CANLOLITOAASTSAM",     "oecd_cli"),
    ("statcan", "v41690973",            "cpi_all_items"),   # verify (10.1)
    ("statcan", "v2062815",             "unemployment_rate"),  # verify (10.1)
]
```

> Separating **configuration** (which series) from **code** (how to fetch) is a core data-engineering idea. `dlt` sources (Days 21–30) and dbt `sources.yml` (Days 31+) are built on it.

### `run_extract.py` (repository root) — one command for everything

```python
"""Run all extractions in the catalogue and write one tidy staging file.

Usage:  python run_extract.py
"""
import logging
import os
import sys
import time

import pandas as pd

from macro_extract import boc, fred, statcan
from macro_extract.catalog import CATALOG
from macro_extract.net import make_session
from macro_extract.schema import validate

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s | %(levelname)-7s | %(message)s")
log = logging.getLogger("extract")

FETCHERS = {"boc": boc.fetch, "fred": fred.fetch, "statcan": statcan.fetch}


def main():
    session = make_session()
    frames, failures = [], []

    for source, series_id, name in CATALOG:
        try:
            df = FETCHERS[source](series_id, session)
            validate(df, f"{source}:{series_id}")
            df["name"] = name
            frames.append(df)
            log.info(f"✓ {name:<18} {len(df):>6} rows, latest "
                     f"{df['value'].iloc[-1]:.3f} ({df['date'].iloc[-1]:%Y-%m-%d})")
        except Exception as e:
            log.error(f"✗ {name:<18} {source}:{series_id} → {e}")
            failures.append(name)
        time.sleep(0.3)          # be polite

    if not frames:
        log.error("Every extraction failed — nothing written.")
        sys.exit(1)

    out = pd.concat(frames, ignore_index=True)
    out["fetched_at"] = pd.Timestamp.now(tz="UTC")
    os.makedirs("data/staging", exist_ok=True)
    out.to_parquet("data/staging/observations.parquet", index=False)

    log.info(f"Wrote {len(out):,} rows for {out['name'].nunique()} series "
             f"→ data/staging/observations.parquet")
    if failures:
        log.warning(f"{len(failures)} series failed: {failures}")
        sys.exit(2)              # partial success: a scheduler can detect this


if __name__ == "__main__":
    main()
```

`sys.exit(1)` and `sys.exit(2)` return **exit codes**: `0` means success, anything else means a problem. Schedulers such as Prefect (Days 51–60) use them to decide whether a run succeeded.

---

## 10.5 Testing Parsers with `pytest` (35 min)

Because parsing is separate from fetching, we can test parsers with small hand-made inputs, with **no internet** needed. That makes tests fast and reliable.

```bash
pip install pytest
pip freeze > requirements.txt
```

Create `tests/test_parsers.py`:

```python
import pandas as pd
import pytest

from macro_extract.boc import parse_valet
from macro_extract.fred import parse_fred_csv
from macro_extract.schema import COLUMNS, validate
from macro_extract.statcan import parse_vectors


def test_valet_skips_bad_values():
    payload = {
        "seriesDetail": {"V39079": {"label": "Overnight"}},
        "observations": [
            {"d": "2026-01-05", "V39079": {"v": "2.25"}},
            {"d": "2026-01-06", "V39079": {"v": "Bank holiday"}},
            {"d": "2026-01-07"},                              # key missing
        ],
    }
    df = parse_valet(payload)
    assert list(df.columns) == COLUMNS
    assert len(df) == 1
    assert df["value"].iloc[0] == 2.25


def test_fred_handles_either_header_and_blanks():
    for header in ["DATE", "observation_date"]:
        text = f"{header},FEDFUNDS\n2026-01-01,3.64\n2026-02-01,.\n2026-03-01,3.63\n"
        df = parse_fred_csv(text, "FEDFUNDS")
        assert len(df) == 2
        assert (df["series_id"] == "FEDFUNDS").all()


def test_statcan_ignores_failed_items():
    payload = [
        {"status": "SUCCESS", "object": {"vectorId": 41690973, "vectorDataPoint": [
            {"refPer": "2026-06-01", "value": 168.2},
            {"refPer": "2026-07-01", "value": 169.0}]}},
        {"status": "FAILED", "object": "Vector not found"},
    ]
    df = parse_vectors(payload)
    assert set(df["series_id"]) == {"v41690973"}
    assert len(df) == 2


def test_validate_rejects_duplicates():
    df = pd.DataFrame({"date": pd.to_datetime(["2026-01-01"] * 2),
                       "series_id": ["X", "X"], "value": [1.0, 1.0],
                       "source": ["test", "test"]})
    with pytest.raises(ValueError, match="duplicate"):
        validate(df, "test")
```

Run the tests from the repository root:

```bash
python -m pytest -v
```

You should see four green `PASSED` lines. Using `python -m pytest` rather than plain `pytest` makes sure Python can find your `macro_extract` package.

> **Break it on purpose:** change `parse_valet` so it no longer skips `"Bank holiday"`, rerun the tests, and read the failure message. Tests are your safety net whenever you change code. Great Expectations (Days 41–50) does the same job for the **data** itself.

### Try it 10.5

Write a test proving that `parse_valet` handles a payload with **two** series in one observation (as in 8.4, Example 2) and returns two rows per date.

<details>
<summary>Solution</summary>

```python
def test_valet_multiple_series():
    payload = {
        "seriesDetail": {"A": {}, "B": {}},
        "observations": [
            {"d": "2026-01-05", "A": {"v": "2.27"}, "B": {"v": "3.75"}},
            {"d": "2026-01-06", "A": {"v": "2.30"}, "B": {"v": "3.80"}},
        ],
    }
    df = parse_valet(payload)
    assert len(df) == 4
    assert df.groupby("date").size().eq(2).all()
```

</details>

---

## 10.6 Run It End-to-End, Recap, and Look Ahead (20 min)

```bash
python -m pytest -q
python run_extract.py
```

Then inspect the result:

```python
import pandas as pd

obs = pd.read_parquet("data/staging/observations.parquet")
print(obs.groupby(["source", "name"])["date"].agg(["min", "max", "count"]))

wide = (obs.assign(date=obs["date"].dt.to_period("M").dt.to_timestamp())
           .pivot_table(index="date", columns="name", values="value", aggfunc="last"))
print(wide.tail())
```

### Stretch goals

- **Connect to Day 7:** rewrite `panel.py` to read `data/staging/observations.parquet` instead of the `get_course_data.py` files, then delete `get_course_data.py`.
- **Add a source type:** support `("statcan_table", "18100004", ...)` in the catalogue using `download_table` and `read_table` from 10.3.
- **Incremental loading:** read the existing staging file first and only request dates after its latest date. This is the core idea of `dlt` incremental loading (Days 24–27).

### What you built, mapped to the course notebook

| Notebook (Cells 2–4) | Your `macro_extract` |
|---|---|
| `boc_fetch`: one series per call, wide output | `boc.fetch` + `parse_valet`: multi-series capable, long output |
| `fred_fetch`: graph CSV | `fred.fetch` + `parse_fred_csv`, with the official API as an option |
| `statcan_fetch`: full tables in memory | `statcan.fetch` via vectors, plus cached streaming table downloads |
| `try/except Exception` per series | specific error handling, automatic retries, exit codes |
| `print` summaries | `logging` with timestamps and levels |
| *(none)* | raw landing zone, schema validation, unit tests, catalogue config |

### Looking ahead: Days 11–20

Your pipeline now writes one tidy, long Parquet file. On **Day 11** you'll query it directly with **DuckDB**, an analytical SQL database that reads Parquet without any import step:

```sql
SELECT name, COUNT(*) AS n, MAX(date) AS latest
FROM 'data/staging/observations.parquet'
GROUP BY name;
```

The long `(date, series_id, value, source)` schema you designed today is exactly what makes that SQL simple.

### Day 10 checklist
- [ ] I understand StatCan tables, vectors and coordinates, and I verify vector IDs
- [ ] I can POST JSON requests to the WDS vector endpoints
- [ ] I can stream, cache and selectively read large table downloads
- [ ] My package separates network, parsing, schema, storage and configuration
- [ ] My parsers are covered by offline `pytest` tests
- [ ] One command (`python run_extract.py`) extracts every series and reports failures

```bash
git add .
git status            # confirm data/ and .env are not staged
git commit -m "Day 10: StatCan WDS, macro_extract package, tests"
git push
```
