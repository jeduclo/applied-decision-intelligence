# Module 1 · Python for Macroeconomics
## Days 4–7: Data Manipulation with pandas & Time-Series Indexing

**Audience:** MSc Economics students who completed Days 1–3
**Environment:** GitHub Codespaces, with the `.venv` from Day 3
**Time per day:** ~2.5 hours (including breaks and exercises)
**Goal by end of Day 7:** Students build a clean, validated monthly and quarterly Canadian macro panel from real BoC, FRED and Statistics Canada data. This is the same logic as Cells 3–5 of `Macro_Fall_2026.ipynb`, but now they understand every line.

---

### Where we are

On Days 1–3 you wrote loops and functions by hand: `yoy_changes`, `moving_average`, `clean_observations`. pandas does all of this in single, fast, well-tested lines. Throughout these four days you'll see **"Day 2 vs pandas"** comparisons so the new tools never feel like magic.

### Target folder structure (added over Days 4–7)

```
macro-data-course/
├── .gitignore
├── requirements.txt
├── get_course_data.py          ← run once on Day 4
├── data/                       ← raw downloads (not committed)
│   └── processed/              ← clean outputs from Day 7
├── day04/
├── day05/
├── day06/
└── day07/
    ├── panel.py
    ├── build_panel.py
    └── charts/
```

> **Convention for Days 4–7:** always run scripts **from the repository root**, e.g. `python day04/first_series.py`. File paths like `data/fred_fedfunds.csv` assume this.

---

# DAY 4 — pandas Fundamentals: Series and DataFrames

| Time | Block |
|---|---|
| 0:00 – 0:20 | 4.1 Setup: install pandas, optional Jupyter, download course data |
| 0:20 – 0:43 | 4.2 Series: a single time series |
| 0:43 – 0:50 | Break |
| 0:50 – 1:13 | 4.3 DataFrames: a table of indicators |
| 1:13 – 1:38 | 4.4 Selecting and filtering |
| 1:38 – 1:45 | Break |
| 1:45 – 2:05 | 4.5 New columns · 4.6 Sorting and counting |
| 2:05 – 2:20 | 4.7 Reading and writing files |
| 2:20 – 2:30 | 4.8 Mini-project: exploring the Fed funds rate |

---

## 4.1 Setup (20 min)

### Step 1 — Activate your environment and install packages

```bash
cd /workspaces/macro-data-course
source .venv/bin/activate
pip install pandas pyarrow matplotlib ipykernel
pip freeze > requirements.txt
```

- `pandas`: the data-frame library
- `pyarrow`: lets pandas read and write Parquet files (used by the course notebook)
- `matplotlib`: plotting (Day 7)
- `ipykernel`: lets VS Code run Jupyter notebooks with your `.venv`

### Step 2 — Optional: Jupyter notebooks in Codespaces

Notebooks are great for exploration; scripts are better for pipelines. You can use both:

1. Create `day04/explore.ipynb`.
2. Click **Select Kernel** (top right) → **Python Environments** → choose `.venv`.
3. Type code into a cell and press `Shift+Enter`.

In a notebook, the last line of a cell displays automatically, so you can type `df` instead of `print(df)`. The examples below use `print()` so they work in both.

### Step 3 — Download the course data

> **Question it answers:** How do I get the Bank of Canada, FRED and StatCan files used on Days 4–7 onto my machine in one go?
>
> **Other questions you can answer the same way:**
> - Which raw files will I be working with this week?

Create `get_course_data.py` in the repository root. **You don't need to understand all of it yet.** On Days 8–10 we rebuild it properly. It uses the same endpoints as the course notebook.

```python
"""get_course_data.py — downloads the raw files used on Days 4–7.

Run once from the repository root:  python get_course_data.py
"""
import io
import os
import zipfile

import pandas as pd
import requests

os.makedirs("data", exist_ok=True)
START = "2006-01-01"

# ── 1. Bank of Canada Valet: one file per series, values kept as raw text ─────
BOC_SERIES = {
    "V39079": "boc_overnight.csv",
    "FXCADUSD": "boc_cad_usd.csv",
    "BD.CDN.2YR.DQ.YLD": "boc_yield_2yr.csv",
    "BD.CDN.10YR.DQ.YLD": "boc_yield_10yr.csv",
}
for code, filename in BOC_SERIES.items():
    url = f"https://www.bankofcanada.ca/valet/observations/{code}/json?start_date={START}"
    obs = requests.get(url, timeout=30).json()["observations"]
    rows = [{"date": o["d"], "value": o.get(code, {}).get("v", "")} for o in obs]
    pd.DataFrame(rows).to_csv(f"data/{filename}", index=False)
    print(f"✓ {filename}: {len(rows)} rows")

# ── 2. FRED: saved exactly as downloaded ─────────────────────────────────────
FRED_SERIES = {"FEDFUNDS": "fred_fedfunds.csv", "DCOILWTICO": "fred_wti.csv"}
for code, filename in FRED_SERIES.items():
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={code}"
    text = requests.get(url, timeout=30).text
    with open(f"data/{filename}", "w") as f:
        f.write(text)
    print(f"✓ {filename}")


# ── 3. Statistics Canada: full table download, then keep a small subset ──────
def statcan_table(table_id):
    meta_url = ("https://www150.statcan.gc.ca/t1/wds/rest/"
                f"getFullTableDownloadCSV/{table_id}/en")
    meta = requests.get(meta_url, timeout=30).json()
    zipped = requests.get(meta["object"], timeout=180)
    with zipfile.ZipFile(io.BytesIO(zipped.content)) as z:
        name = [f for f in z.namelist()
                if f.endswith(".csv") and not f.endswith("_MetaData.csv")][0]
        df = pd.read_csv(z.open(name), low_memory=False, encoding="utf-8-sig")
    df.columns = df.columns.str.strip()
    return df


print("Downloading StatCan CPI (large file, please wait)...")
cpi = statcan_table("18100004")
keep = ["All-items", "Food", "Shelter", "Transportation",
        "Energy", "Clothing and footwear"]
cpi = cpi[(cpi["GEO"] == "Canada") &
          (cpi["Products and product groups"].isin(keep))]
cpi[["REF_DATE", "GEO", "Products and product groups", "VALUE"]].to_csv(
    "data/statcan_cpi.csv", index=False)
print(f"✓ statcan_cpi.csv: {len(cpi)} rows")

print("Downloading StatCan GDP...")
gdp = statcan_table("36100104")
gdp = gdp[(gdp["Seasonal adjustment"] == "Seasonally adjusted at annual rates") &
          (gdp["Estimates"] == "Gross domestic product at market prices") &
          (gdp["Prices"] == "Chained (2017) dollars")]
gdp[["REF_DATE", "VALUE"]].to_csv("data/statcan_gdp.csv", index=False)
print(f"✓ statcan_gdp.csv: {len(gdp)} rows")
```

Run it:

```bash
python get_course_data.py
```

Then add `data/` to your `.gitignore`, since raw downloads don't belong in Git:

```
.venv/
__pycache__/
*.pyc
data/
```

> If a download fails (APIs occasionally time out), run the script again. If it keeps failing, ask your instructor for a zipped copy of the `data/` folder.

---

## 4.2 Series: a Single Time Series (23 min)

A **Series** is a column of values with labels, called the **index**. Create `day04/first_series.py`.

### Example 1 — From a list

> **Question it answers:** How do I turn a list of policy rates into a pandas Series?
>
> **Other questions you can answer the same way:**
> - How do I start analysing a short list of values with pandas?

```python
import pandas as pd

rates = pd.Series([4.75, 4.50, 4.25, 3.75, 3.25])
print(rates)
```

Output:

```
0    4.75
1    4.50
2    4.25
3    3.75
4    3.25
dtype: float64
```

The left column is the index (0–4 by default); the right column holds the values.

### Example 2 — Built-in statistics

> **Question it answers:** What were the mean, maximum and standard deviation of the policy rate?
>
> **Other questions you can answer the same way:**
> - How volatile is inflation?
> - What does a quick summary of a series look like?

```python
print("Mean:", rates.mean())
print("Max:", rates.max())
print("Std dev:", rates.std())
print(rates.describe())
```

### Example 3 — Vectorised arithmetic (no loops!)

> **Question it answers:** What is every policy rate in basis points, and the change from one decision to the next, without writing a loop?
>
> **Other questions you can answer the same way:**
> - What is each value converted to another unit?
> - What is the real rate for every month at once?

```python
# Day 2 way:
# rates_bp = []
# for r in rates:
#     rates_bp.append(r * 100)

# pandas way: the operation applies to every element at once
rates_bp = rates * 100
print(rates_bp)

# Changes between decisions, in basis points
print(rates.diff() * 100)
```

`diff()` replaces the Day 2 loop over `range(1, len(...))`. The first value is `NaN` ("Not a Number"), pandas' marker for *missing*, because there's no previous decision.

### Example 4 — Meaningful labels

> **Question it answers:** What was the policy rate in October 2024, looked up by date rather than by position?
>
> **Other questions you can answer the same way:**
> - What was CPI in a given month?
> - What is the first value in the series?

```python
rates = pd.Series(
    [4.75, 4.50, 4.25, 3.75, 3.25],
    index=["2024-06", "2024-07", "2024-09", "2024-10", "2024-12"],
    name="overnight_rate",
)
print(rates)
print(rates["2024-10"])          # look up by label → 3.75
print(rates.iloc[0])             # look up by position → 4.75
```

### Example 5 — Filtering with a condition

> **Question it answers:** At which decisions was the rate above 4%?
>
> **Other questions you can answer the same way:**
> - Which months had inflation above 3%?
> - Which values exceed a threshold?

```python
print(rates > 4.0)               # a Series of True/False
print(rates[rates > 4.0])        # keep only the True rows
```

Compare with the Day 2 list comprehension `[x for x in rates if x > 4.0]`: same idea, shorter syntax.

### Try it 4.2

Create a Series of 2022 hike sizes in bp: `[25, 50, 50, 100, 75, 50, 50]`.
(a) Total tightening. (b) Largest single hike. (c) Cumulative path using `.cumsum()`. (d) Hikes of 50 bp or more.

<details>
<summary>Solution</summary>

```python
hikes = pd.Series([25, 50, 50, 100, 75, 50, 50], name="hike_bp")

print("Total:", hikes.sum())            # 400
print("Largest:", hikes.max())          # 100
print(hikes.cumsum())                   # replaces the Day 2 accumulator loop
print(hikes[hikes >= 50])
```

</details>

---

## 4.3 DataFrames: a Table of Indicators (23 min)

A **DataFrame** is a table: several Series sharing one index. Create `day04/first_dataframe.py`.

### Example 1 — From a dictionary of lists

> **Question it answers:** How do I build a table of provinces with their fiscal balance and region?
>
> **Other questions you can answer the same way:**
> - How do I store several related indicators per province in one table?

We use the notebook's provincial fiscal table (FY2026, % of provincial GDP).

```python
import pandas as pd

provinces = pd.DataFrame({
    "province": ["BC", "AB", "SK", "MB", "ON", "QC", "NB", "NS", "PE", "NL"],
    "balance_pct_gdp": [-0.8, 0.2, 0.5, -0.9, -1.4, -1.2, -0.5, -0.3, -0.7, 0.1],
    "region": ["West", "West", "Prairies", "Prairies", "Central", "Central",
               "Atlantic", "Atlantic", "Atlantic", "Atlantic"],
})
print(provinces)
```

Each dictionary key becomes a column. Every list must have the same length.

### Example 2 — First look at any DataFrame

> **Question it answers:** How many rows and columns does this dataset have, what types are the columns, are values missing, and what are the basic statistics?
>
> **Other questions you can answer the same way:**
> - Is this dataset what I expected before I analyse it?
> - Which columns are text that should be numbers?

Make this your routine for every new dataset:

```python
print(provinces.shape)       # (rows, columns) → (10, 3)
print(provinces.columns)     # column names
print(provinces.dtypes)      # type of each column
print(provinces.head(3))     # first 3 rows
print(provinces.tail(3))     # last 3 rows
provinces.info()             # overview incl. missing values
print(provinces.describe())  # statistics for numeric columns
```

> Text columns may show as `object` or `str` depending on your pandas version. Both mean *text*.

### Example 3 — From a list of dictionaries (one per row)

> **Question it answers:** How do I turn a list of decision records (like an API response) into a table?
>
> **Other questions you can answer the same way:**
> - How do I convert JSON-style records into rows and columns?

This shape should look familiar from the BoC API on Days 2–3:

```python
decisions = pd.DataFrame([
    {"date": "2025-01-29", "rate": 3.00, "change": "-25bp"},
    {"date": "2025-03-12", "rate": 2.75, "change": "-25bp"},
    {"date": "2025-06-04", "rate": 2.25, "change": "Hold"},
])
print(decisions)
```

> **Rule of thumb:** a dict of lists is *column-oriented*; a list of dicts is *row-oriented*. pandas accepts both.

---

## 4.4 Selecting and Filtering (25 min)

Continue in `first_dataframe.py`.

### Example 1 — Selecting columns

> **Question it answers:** What are the provinces' fiscal balances, without the other columns?
>
> **Other questions you can answer the same way:**
> - Which columns do I need for this chart or calculation?

```python
balances = provinces["balance_pct_gdp"]              # one column → Series
subset = provinces[["province", "balance_pct_gdp"]]  # list of columns → DataFrame
print(type(balances), type(subset))
```

Note the **double brackets** when selecting several columns: the inner brackets are a Python list.

### Example 2 — Selecting rows with `.loc` and `.iloc`

> **Question it answers:** What is the first, last or a specific province's row in the table?
>
> **Other questions you can answer the same way:**
> - What are Ontario's figures?
> - What are the first three rows?

```python
print(provinces.iloc[0])          # first row, by position
print(provinces.iloc[-1])         # last row
print(provinces.iloc[0:3])        # first three rows

# .loc uses labels: here the index labels are 0..9
print(provinces.loc[4, "province"])                  # "ON"
print(provinces.loc[4, ["province", "balance_pct_gdp"]])
```

A cleaner approach is to make `province` the index:

```python
prov = provinces.set_index("province")
print(prov.loc["ON"])                          # whole row for Ontario
print(prov.loc["ON", "balance_pct_gdp"])       # -1.4
print(prov.loc[["ON", "QC"], "balance_pct_gdp"])
```

| Accessor | Selects by | Example |
|---|---|---|
| `df["col"]` | column name | `df["rate"]` |
| `df.loc[row, col]` | labels | `df.loc["ON", "balance_pct_gdp"]` |
| `df.iloc[row, col]` | positions | `df.iloc[0, 1]` |

### Example 3 — Boolean filtering

> **Question it answers:** Which provinces ran a surplus? Which Atlantic provinces ran a deficit?
>
> **Other questions you can answer the same way:**
> - Which months had inflation above target and unemployment above 6%?
> - Which quarters had negative growth?

```python
surplus = provinces[provinces["balance_pct_gdp"] > 0]
print(surplus)

# Two conditions: use & (and) or | (or), with each condition in parentheses
atlantic_deficits = provinces[
    (provinces["region"] == "Atlantic") & (provinces["balance_pct_gdp"] < 0)
]
print(atlantic_deficits)
```

> **Common error:** writing `and` instead of `&`, or forgetting parentheses, gives `ValueError: The truth value of a Series is ambiguous`. With pandas, always use `&`, `|`, `~` and parentheses.

### Example 4 — `.isin()` and `.query()`

> **Question it answers:** What are the fiscal positions of the four largest provinces? Which provinces have deficits over 1% of GDP?
>
> **Other questions you can answer the same way:**
> - How do I filter for a list of series codes?
> - Which Western provinces are in deficit?

```python
big_four = provinces[provinces["province"].isin(["ON", "QC", "BC", "AB"])]
print(big_four)

# .query reads almost like English (the notebook uses this in fred_fetch)
print(provinces.query("balance_pct_gdp < -1.0"))
print(provinces.query("region == 'West' and balance_pct_gdp < 0"))
```

### Try it 4.4

(a) List Prairie and Western provinces with deficits. (b) Get the balance of Nova Scotia using `.loc`. (c) How many provinces have a deficit worse than −0.5%?

<details>
<summary>Solution</summary>

```python
west = provinces[
    provinces["region"].isin(["West", "Prairies"]) &
    (provinces["balance_pct_gdp"] < 0)
]
print(west)

prov = provinces.set_index("province")
print(prov.loc["NS", "balance_pct_gdp"])        # -0.3

print((provinces["balance_pct_gdp"] < -0.5).sum())   # 5
```

`.sum()` on a True/False Series counts the `True` values. This replaces the Day 2 counting loop.

</details>

---

## 4.5 Creating New Columns (13 min)

### Example 1 — Arithmetic on columns

> **Question it answers:** What is each province's balance in basis points?
>
> **Other questions you can answer the same way:**
> - What is the real rate (nominal minus inflation) in every row?
> - What is each value per capita?

```python
provinces["balance_bp"] = provinces["balance_pct_gdp"] * 100
```

### Example 2 — Conditional labels with `.apply` and your own function

> **Question it answers:** Is each province in surplus, small deficit or large deficit?
>
> **Other questions you can answer the same way:**
> - Is inflation below, inside or above target each month?
> - Is each quarter an expansion or a contraction?

You already know how to write classification functions (Day 3):

```python
def fiscal_status(balance):
    if balance > 0:
        return "Surplus"
    elif balance >= -0.5:
        return "Small deficit"
    return "Large deficit"

provinces["status"] = provinces["balance_pct_gdp"].apply(fiscal_status)
print(provinces[["province", "balance_pct_gdp", "status"]])
```

`.apply` calls your function once per value, just like a loop, but with less code.

### Example 3 — Mapping codes to names with `.map`

> **Question it answers:** What is the full name of each province code?
>
> **Other questions you can answer the same way:**
> - What is the readable name of each series code?
> - Which region does each province belong to?

```python
names = {"BC": "British Columbia", "AB": "Alberta", "SK": "Saskatchewan",
         "MB": "Manitoba", "ON": "Ontario", "QC": "Quebec",
         "NB": "New Brunswick", "NS": "Nova Scotia",
         "PE": "Prince Edward Island", "NL": "Newfoundland and Labrador"}

provinces["name"] = provinces["province"].map(names)
```

---

## 4.6 Sorting and Counting (8 min)

> **Question it answers:** Which provinces have the weakest and strongest balances, and how many are in each status and region?
>
> **Other questions you can answer the same way:**
> - What were the five highest inflation months?
> - How many months fall into each policy stance?

```python
# Sort worst to best
print(provinces.sort_values("balance_pct_gdp"))

# Best to worst
print(provinces.sort_values("balance_pct_gdp", ascending=False).head(3))

# How many in each category?
print(provinces["status"].value_counts())
print(provinces["region"].value_counts())
```

---

## 4.7 Reading and Writing Files (15 min)

### Example 1 — Reading a CSV

> **Question it answers:** What does the FRED Fed funds file contain, and what types did pandas detect?
>
> **Other questions you can answer the same way:**
> - What is inside a downloaded CSV?
> - Did the numbers load as numbers?

Look at the raw file first. In the terminal: `head data/fred_fedfunds.csv`

```python
import pandas as pd

ff = pd.read_csv("data/fred_fedfunds.csv")
print(ff.head())
print(ff.dtypes)
```

FRED's column names vary (`DATE` or `observation_date`), so we rename by position, exactly as the notebook's `fred_fetch` does:

```python
ff = ff.iloc[:, :2]                   # keep the first two columns
ff.columns = ["date", "fed_funds"]    # give them our own names
ff["fed_funds"] = pd.to_numeric(ff["fed_funds"], errors="coerce")
print(ff.tail())
```

`pd.to_numeric(..., errors="coerce")` converts text to numbers and turns anything unreadable into `NaN`. It's the one-line replacement for your Day 2 `try/except` loop.

### Example 2 — Writing CSV and Parquet

> **Question it answers:** How do I save a cleaned table so I (or a colleague) can reuse it later?
>
> **Other questions you can answer the same way:**
> - Which format is smaller and faster to reload?

```python
import os
os.makedirs("data/processed", exist_ok=True)

ff.to_csv("data/processed/fed_funds.csv", index=False)
ff.to_parquet("data/processed/fed_funds.parquet", index=False)
```

| Format | Pros | Cons |
|---|---|---|
| CSV | Opens anywhere (Excel, Stata, R) | Loses types (dates become text), large, slow |
| Parquet | Keeps types, compressed, fast | Needs a library to open |

The course notebook saves everything as Parquet (`save_df`), and DuckDB (Days 11–20) reads Parquet natively.

---

## 4.8 Mini-Project: Exploring the Fed Funds Rate (10 min)

> **Question it answers:** Over its history, what were the Fed funds rate's average, highest and lowest values, and how many months was it above 5%?
>
> **Other questions you can answer the same way:**
> - How many months was the rate near zero?
> - What does the rate's full history look like in numbers?

Create `day04/fed_funds.py`. Using `data/fred_fedfunds.csv`:

1. Load, keep two columns, rename to `date` and `fed_funds`, convert to numeric.
2. Print shape, first and last rows, and `describe()`.
3. Count months with the rate above 5%.
4. Show the 5 highest months.
5. Show months since `"2022-01-01"` (hint: dates are still text, but ISO dates compare correctly as text).
6. Save to `data/processed/fed_funds.parquet`.

<details>
<summary>Solution</summary>

```python
import os
import pandas as pd

ff = pd.read_csv("data/fred_fedfunds.csv").iloc[:, :2]
ff.columns = ["date", "fed_funds"]
ff["fed_funds"] = pd.to_numeric(ff["fed_funds"], errors="coerce")
ff = ff.dropna()

print(ff.shape)
print(ff.head(2))
print(ff.tail(2))
print(ff["fed_funds"].describe())

print("Months above 5%:", (ff["fed_funds"] > 5).sum())
print(ff.sort_values("fed_funds", ascending=False).head(5))
print(ff[ff["date"] >= "2022-01-01"])

os.makedirs("data/processed", exist_ok=True)
ff.to_parquet("data/processed/fed_funds.parquet", index=False)
```

</details>

Tomorrow we fix step 5 properly by turning text dates into real dates.

### Day 4 checklist
- [ ] I can create a Series and a DataFrame and inspect them (`shape`, `head`, `info`, `describe`)
- [ ] I can select columns, and rows with `.loc`, `.iloc` and boolean filters
- [ ] I can add columns with arithmetic, `.apply` and `.map`
- [ ] I can read a CSV, clean a column with `pd.to_numeric`, and save CSV/Parquet

```bash
git add .
git commit -m "Day 4: pandas Series and DataFrames"
git push
```

---

# DAY 5 — Dates and Time-Series Indexing

| Time | Block |
|---|---|
| 0:00 – 0:23 | 5.1 Why dates are special · 5.2 Date columns and `.dt` |
| 0:23 – 0:50 | 5.3 The DatetimeIndex: slicing by date |
| 0:50 – 0:58 | Break |
| 0:58 – 1:18 | 5.4 Missing values and cleaning BoC data |
| 1:18 – 1:45 | 5.5 `shift`, `diff`, `pct_change`: growth rates and inflation |
| 1:45 – 1:53 | Break |
| 1:53 – 2:08 | 5.6 Rolling and expanding windows · 5.7 Periods |
| 2:08 – 2:30 | 5.8 Mini-project: a CPI inflation fact sheet |

---

## 5.1 Why Dates Are Special (8 min)

> **Question it answers:** How many days passed between the 2023 peak and the first cut in 2024?
>
> **Other questions you can answer the same way:**
> - How long did each tightening cycle last?
> - What date is three months after a decision?

Create `day05/dates_basics.py`.

```python
import pandas as pd

# Text dates can't do date arithmetic
print("2024-06-05" > "2024-01-01")     # works only by luck of ISO ordering
# "2024-06-05" - "2024-01-01"          # TypeError

# Real dates can
first_cut = pd.to_datetime("2024-06-05")
peak = pd.to_datetime("2023-07-12")

print(type(first_cut))                  # Timestamp
print(first_cut - peak)                 # 329 days
print(first_cut.year, first_cut.month, first_cut.quarter)
print(first_cut + pd.DateOffset(months=3))
print(first_cut.strftime("%B %Y"))      # "June 2024"
```

### Generating date sequences

> **Question it answers:** What are all the month-start dates between January and June 2026?
>
> **Other questions you can answer the same way:**
> - Which quarters should a quarterly dataset contain?
> - What is a complete monthly calendar for my sample?

```python
monthly = pd.date_range("2026-01-01", "2026-06-01", freq="MS")   # month starts
quarterly = pd.date_range("2025-01-01", periods=4, freq="QS")    # quarter starts
print(monthly)
print(quarterly)
```

The notebook's `synth_dates` helper uses exactly this.

---

## 5.2 Date Columns and the `.dt` Accessor (15 min)

> **Question it answers:** In which year, quarter and month does each observation fall?
>
> **Other questions you can answer the same way:**
> - What was the average rate per year?
> - Which observations fall in Q4?

```python
ff = pd.read_csv("data/fred_fedfunds.csv").iloc[:, :2]
ff.columns = ["date", "fed_funds"]
ff["date"] = pd.to_datetime(ff["date"])
ff["fed_funds"] = pd.to_numeric(ff["fed_funds"], errors="coerce")

print(ff.dtypes)        # date is now datetime64

ff["year"] = ff["date"].dt.year
ff["quarter"] = ff["date"].dt.quarter
ff["month_name"] = ff["date"].dt.month_name()
print(ff.tail())
```

`.dt` gives access to date parts of a whole column, just as `.str` does for text.

### Parsing dates explicitly

> **Question it answers:** How do I read StatCan dates like "2026-07" correctly as July 2026?
>
> **Other questions you can answer the same way:**
> - How do I stop pandas misreading day and month?

StatCan monthly dates look like `"2026-07"` (no day). Tell pandas the format so it never guesses wrong:

```python
print(pd.to_datetime("2026-07", format="%Y-%m"))    # 2026-07-01
```

| Code | Meaning | Example |
|---|---|---|
| `%Y` | 4-digit year | 2026 |
| `%m` | month number | 07 |
| `%d` | day | 01 |
| `%B` | full month name | July |

---

## 5.3 The DatetimeIndex: Slicing by Date (28 min)

Putting dates in the **index** unlocks pandas' time-series superpowers. Create `day05/time_index.py`.

### Example 1 — Setting the index

> **Question it answers:** How do I organise the Fed funds data so that dates become the row labels?
>
> **Other questions you can answer the same way:**
> - How do I prepare any series for time-series operations?

```python
import pandas as pd

ff = pd.read_csv("data/fred_fedfunds.csv").iloc[:, :2]
ff.columns = ["date", "fed_funds"]
ff["date"] = pd.to_datetime(ff["date"])
ff["fed_funds"] = pd.to_numeric(ff["fed_funds"], errors="coerce")

ff = ff.set_index("date").sort_index()
print(ff.head())
print(ff.index)          # DatetimeIndex
```

### Example 2 — Selecting by partial date strings

> **Question it answers:** What was the Fed funds rate during 2023, between March 2022 and July 2023, and from 2019 onward?
>
> **Other questions you can answer the same way:**
> - What happened during the pandemic months?
> - What was the value in a specific month?

```python
print(ff.loc["2023"])                       # all of 2023
print(ff.loc["2022-03":"2023-07"])          # a date range (both ends included)
print(ff.loc["2020-04-01"])                 # one exact month
print(ff.loc["2019":])                      # from 2019 to the end
```

Compare with Day 4, where we filtered on text. This is shorter, safer and faster.

### Example 3 — Working with a single series

> **Question it answers:** When does the series start and end, when did it peak, and what was its average in the 2010s?
>
> **Other questions you can answer the same way:**
> - What was the highest unemployment rate and when?
> - What was average inflation in a decade?

```python
rate = ff["fed_funds"]                      # Series with a DatetimeIndex

print("First date:", rate.index.min())
print("Last date:", rate.index.max())
print("Peak:", rate.max(), "on", rate.idxmax().date())
print("Average 2010s:", rate.loc["2010":"2019"].mean().round(2))
```

`idxmax()` returns the *date* of the maximum. That's hard to do with plain lists!

### Example 4 — Sanity checks on the index

> **Question it answers:** Are the dates sorted and free of duplicates?
>
> **Other questions you can answer the same way:**
> - Is this series safe to use for growth-rate calculations?

```python
print(rate.index.is_monotonic_increasing)   # sorted?
print(rate.index.is_unique)                 # no duplicate dates?
```

### Try it 5.3

Using the Fed funds series: (a) average rate in 2008, (b) the lowest rate since 2022 and its date, (c) how many months between `2020-01` and `2021-12` the rate was below 0.25%.

<details>
<summary>Solution</summary>

```python
print(rate.loc["2008"].mean())

recent = rate.loc["2022":]
print(recent.min(), recent.idxmin().date())

covid = rate.loc["2020-01":"2021-12"]
print((covid < 0.25).sum())
```

</details>

---

## 5.4 Missing Values and Cleaning BoC Data (20 min)

Create `day05/clean_boc.py`.

### Example 1 — Spotting missing values

> **Question it answers:** How many values are missing, and should I drop them or carry the last value forward?
>
> **Other questions you can answer the same way:**
> - How many CPI months are missing?
> - What policy rate applied on a day with no announcement?

```python
import numpy as np
import pandas as pd

s = pd.Series([2.25, np.nan, 2.25, np.nan, 2.50])
print(s.isna())             # True where missing
print(s.isna().sum())       # how many → 2
print(s.dropna())           # remove them
print(s.ffill())            # carry the last value forward
```

`numpy` (`np`) was installed alongside pandas. `np.nan` is how we type a missing value.

### Example 2 — Cleaning the raw BoC file (replaces Day 3's `clean_observations`)

> **Question it answers:** How many Bank of Canada values were unreadable, and what does the cleaned daily series look like?
>
> **Other questions you can answer the same way:**
> - How do I turn a raw download into a clean numeric series in a few lines?

```python
raw = pd.read_csv("data/boc_overnight.csv")
print(raw.head())
print(raw["value"].dtype)

overnight = pd.to_numeric(raw["value"], errors="coerce")
print("Unreadable or missing values:", overnight.isna().sum())

boc = pd.DataFrame({
    "date": pd.to_datetime(raw["date"]),
    "overnight_rate": overnight,
}).dropna().set_index("date").sort_index()

print(boc.tail())
```

### Example 3 — When to use `ffill`

The overnight rate is a **step function**: it stays at its level until the next decision. Carrying it forward is economically correct. The course notebook does `boc.sort_values("date").ffill()` after merging daily series.

But carrying forward **GDP** or **CPI** would invent data. Always ask: *does the last value genuinely still apply?*

> **Rule:** `dropna` when a value is unknown; `ffill` only when the previous value is still the truth (policy rates, prime rate, tariff status).

---

## 5.5 `shift`, `diff`, `pct_change`: Growth Rates and Inflation (28 min)

Create `day05/inflation.py`. We use real StatCan CPI data.

### Step 1 — Load All-items CPI as a monthly series

> **Question it answers:** What is the All-items CPI level each month?
>
> **Other questions you can answer the same way:**
> - What is the CPI level for food, shelter or energy?

```python
import pandas as pd

cpi_raw = pd.read_csv("data/statcan_cpi.csv")
cpi_raw = cpi_raw.rename(columns={
    "REF_DATE": "date",
    "Products and product groups": "component",
    "VALUE": "value",
})
cpi_raw["date"] = pd.to_datetime(cpi_raw["date"], format="%Y-%m")

all_items = (cpi_raw[cpi_raw["component"] == "All-items"]
             .set_index("date")["value"]
             .sort_index())
print(all_items.tail())
```

The parentheses let you split a long chain of methods across lines.

### Step 2 — `shift`: looking back in time

> **Question it answers:** What was CPI last month and a year ago, next to this month's value?
>
> **Other questions you can answer the same way:**
> - How do I compare each value with an earlier period?

```python
print(pd.DataFrame({
    "cpi": all_items,
    "cpi_last_month": all_items.shift(1),
    "cpi_last_year": all_items.shift(12),
}).tail())
```

`shift(12)` moves the series down 12 rows, so each month sits beside the same month last year.

### Step 3 — Year-over-year inflation, three ways

> **Question it answers:** What is year-over-year CPI inflation each month?
>
> **Other questions you can answer the same way:**
> - What is YoY growth in employment, wages or house prices?

```python
# (a) Manual formula with shift
yoy_manual = (all_items / all_items.shift(12) - 1) * 100

# (b) pct_change: the notebook's method
yoy = all_items.pct_change(12) * 100

# (c) Check they match
print((yoy_manual - yoy).abs().max())     # ~0

print(f"Latest CPI inflation: {yoy.iloc[-1]:.1f}% "
      f"({yoy.index[-1]:%B %Y})")
```

Your Day 3 `yoy_changes(levels, lag=12)` did the same thing with a loop.

### Step 4 — Other growth measures

> **Question it answers:** What are month-over-month inflation, 3-month annualised inflation and the 12-month change in index points?
>
> **Other questions you can answer the same way:**
> - Is inflation speeding up recently?
> - How many index points have prices risen in a year?

```python
mom = all_items.pct_change(1) * 100                         # month-over-month
ann_3m = ((all_items / all_items.shift(3)) ** 4 - 1) * 100  # 3-month annualised
change_pts = all_items.diff(12)                             # change in index points
```

> **Economist's warning:** table 18-10-0004 is **not seasonally adjusted**. Year-over-year comparisons cancel seasonality; month-over-month and 3-month annualised rates don't. Interpret short-horizon measures from this table with care.

### Step 5 — Watch out for gaps

> **Question it answers:** Are any months missing from the CPI series, which would make YoY calculations wrong?
>
> **Other questions you can answer the same way:**
> - Does my series cover every expected month?

`pct_change(12)` compares with **12 rows back**, not 12 months back. If a month is missing, every later YoY is wrong. Check before trusting it:

```python
expected = pd.date_range(all_items.index.min(), all_items.index.max(), freq="MS")
missing = expected.difference(all_items.index)
print("Missing months:", len(missing))
```

This exact check becomes a formal data-quality rule in Great Expectations (Days 48–50).

---

## 5.6 Rolling and Expanding Windows (10 min)

> **Question it answers:** What are the 3-month moving average of inflation, its running peak, and the number of months above 3% in the past year?
>
> **Other questions you can answer the same way:**
> - What is the underlying trend in unemployment?
> - What was the highest inflation so far at each date?

```python
yoy_recent = yoy.loc["2019":]

smoothed = yoy_recent.rolling(3).mean()          # 3-month moving average
print(smoothed.tail())

peak_so_far = yoy_recent.expanding().max()       # running maximum
print(peak_so_far.tail())

above_3 = (yoy_recent > 3).rolling(12).sum()    # months above 3% in the last 12
print(above_3.tail())
```

- `rolling(n)` = your Day 3 `moving_average`
- `expanding().max()` = your Day 2 running-peak accumulator

The notebook uses `.rolling(4, min_periods=1).mean()` for housing starts, where `min_periods=1` allows averages before 4 observations exist.

---

## 5.7 Periods: Normalising Dates (5 min)

> **Question it answers:** How do I line up daily dates (like 14 August) with monthly dates (1 August)?
>
> **Other questions you can answer the same way:**
> - Which quarter does each date belong to?

Daily data has dates like `2026-08-14`; monthly data uses `2026-08-01`. To line them up, the notebook converts dates to **periods** and back:

```python
d = pd.Series(pd.to_datetime(["2026-08-03", "2026-08-14", "2026-09-02"]))

print(d.dt.to_period("M"))                        # 2026-08, 2026-08, 2026-09
print(d.dt.to_period("M").dt.to_timestamp())      # 2026-08-01, 2026-08-01, 2026-09-01
print(d.dt.to_period("Q"))                        # 2026Q3, ...
```

Tomorrow you'll meet `resample`, a cleaner way to achieve the same result.

---

## 5.8 Mini-Project: CPI Inflation Fact Sheet (23 min)

> **Question it answers:** What are the latest inflation rate, its 12-month range, the peak since 2021, and how many months it has been outside the 1–3% band?
>
> **Other questions you can answer the same way:**
> - How does today's inflation compare with recent history?
> - How long has inflation been inside the target band?

Create `day05/cpi_factsheet.py` that prints:

1. Latest CPI YoY and its month.
2. Peak YoY since 2020 and its month.
3. Number of months since January 2021 with inflation above the 3% top of the BoC control range.
4. Average YoY in 2015–2019 versus 2023–present.
5. The most recent month inflation was *below* 2%.
6. Whether any months are missing from the series.

<details>
<summary>Solution</summary>

```python
import pandas as pd

cpi_raw = pd.read_csv("data/statcan_cpi.csv").rename(columns={
    "REF_DATE": "date", "Products and product groups": "component", "VALUE": "value"})
cpi_raw["date"] = pd.to_datetime(cpi_raw["date"], format="%Y-%m")

cpi = (cpi_raw[cpi_raw["component"] == "All-items"]
       .set_index("date")["value"].sort_index())
yoy = (cpi.pct_change(12) * 100).dropna()

print("=== CPI Inflation Fact Sheet ===")
print(f"Latest: {yoy.iloc[-1]:.1f}% ({yoy.index[-1]:%b %Y})")

since_2020 = yoy.loc["2020":]
print(f"Peak since 2020: {since_2020.max():.1f}% ({since_2020.idxmax():%b %Y})")

print(f"Months above 3% since 2021: {(yoy.loc['2021':] > 3).sum()}")

print(f"Avg 2015–2019: {yoy.loc['2015':'2019'].mean():.2f}%")
print(f"Avg 2023–now:  {yoy.loc['2023':].mean():.2f}%")

below_2 = yoy[yoy < 2]
print(f"Last month below 2%: {below_2.index[-1]:%b %Y}")

expected = pd.date_range(cpi.index.min(), cpi.index.max(), freq="MS")
print(f"Missing months: {len(expected.difference(cpi.index))}")
```

Your peak should be close to the notebook's "8.1% peak (Jun '22)" annotation.

</details>

### Day 5 checklist
- [ ] I can convert text to dates and use `.dt` to extract date parts
- [ ] I can set a DatetimeIndex and slice with `.loc["2022":"2023"]`
- [ ] I can clean messy values with `to_numeric(errors="coerce")` and choose between `dropna` and `ffill`
- [ ] I can compute MoM, YoY and annualised rates with `shift` and `pct_change`
- [ ] I check for missing periods before trusting `pct_change`

```bash
git add .
git commit -m "Day 5: dates, time-series index, inflation"
git push
```

---

# DAY 6 — Resampling, Grouping, Reshaping and Merging

| Time | Block |
|---|---|
| 0:00 – 0:30 | 6.1 Resampling: changing frequency |
| 0:30 – 0:38 | Break |
| 0:38 – 1:03 | 6.2 `groupby`: statistics by category and period |
| 1:03 – 1:23 | 6.3 Long vs wide: `pivot` and `melt` |
| 1:23 – 1:30 | Break |
| 1:30 – 2:00 | 6.4 Merging and concatenating datasets |
| 2:00 – 2:30 | 6.5 Mini-project: rebuild the notebook's derived series |

A small helper we'll reuse all day. Create `day06/loaders.py`:

```python
"""loaders.py — read the raw course files into clean Series."""
import pandas as pd


def load_boc(path, name):
    """Raw BoC Valet CSV (date, value) → clean daily Series."""
    df = pd.read_csv(path)
    df["date"] = pd.to_datetime(df["date"])
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    return df.set_index("date")["value"].dropna().sort_index().rename(name)


def load_fred(path, name):
    """Raw FRED CSV → clean Series (first two columns only)."""
    df = pd.read_csv(path).iloc[:, :2]
    df.columns = ["date", name]
    df["date"] = pd.to_datetime(df["date"])
    df[name] = pd.to_numeric(df[name], errors="coerce")
    return df.set_index("date")[name].dropna().sort_index()


def load_cpi_long(path="data/statcan_cpi.csv"):
    """StatCan CPI subset → long DataFrame (date, component, value)."""
    df = pd.read_csv(path).rename(columns={
        "REF_DATE": "date", "Products and product groups": "component",
        "VALUE": "value"})
    df["date"] = pd.to_datetime(df["date"], format="%Y-%m")
    return df[["date", "component", "value"]].dropna().sort_values(["component", "date"])
```

These are Day 5's cleaning steps wrapped in Day 3-style functions.

---

## 6.1 Resampling: Changing Frequency (30 min)

Create `day06/resampling.py`.

### Example 1 — Daily to monthly

> **Question it answers:** What was the overnight rate at the end of each month, and what was its average during the month?
>
> **Other questions you can answer the same way:**
> - What was the month-end exchange rate?
> - What was the average daily oil price each month?

```python
from loaders import load_boc

overnight = load_boc("data/boc_overnight.csv", "overnight_rate")
print(overnight.tail())

monthly_last = overnight.resample("MS").last()    # rate at end of each month
monthly_mean = overnight.resample("MS").mean()    # average rate during the month
print(monthly_last.tail())
```

`resample("MS")` groups by calendar month and labels each group with the **month start** date, matching how StatCan and FRED date monthly data.

### Example 2 — Which aggregation is economically right?

> **Question it answers:** What was the average Canadian-dollar exchange rate each month?
>
> **Other questions you can answer the same way:**
> - Should a series be averaged or sampled at the end of the period?

| Series | Sensible monthly aggregation | Why |
|---|---|---|
| Policy rate | `.last()` | The rate in force at month end |
| Exchange rate | `.mean()` | Average price over the month (notebook uses this) |
| Oil price | `.mean()` | Average price |
| Housing starts (flows) | `.sum()` | Total units in the period |

```python
cad_usd = load_boc("data/boc_cad_usd.csv", "cad_usd")
cad_monthly = cad_usd.resample("MS").mean()
print(cad_monthly.tail())
```

The notebook achieves the same with `.dt.to_period("M").dt.to_timestamp()` followed by `groupby(...).mean()`. `resample` is the shortcut.

### Example 3 — Other frequencies

> **Question it answers:** What was the policy rate at each quarter, and its average each year?
>
> **Other questions you can answer the same way:**
> - What was annual average inflation?
> - What was the quarterly average unemployment rate?

```python
quarterly = overnight.resample("QS").last()      # quarter start labels
annual = overnight.resample("YS").mean()         # annual average
print(annual.round(2))
```

| Alias | Frequency | Label |
|---|---|---|
| `"D"` | daily | |
| `"W"` | weekly | week end (Sunday) |
| `"MS"` / `"ME"` | monthly | month start / month end |
| `"QS"` / `"QE"` | quarterly | quarter start / end |
| `"YS"` / `"YE"` | annual | year start / end |

> Pick **one** labelling convention for a project and stick with it. We use *start* labels (`MS`, `QS`) because StatCan does.

### Example 4 — Upsampling a step function

> **Question it answers:** What policy rate applied on each day, given only monthly values?
>
> **Other questions you can answer the same way:**
> - How do I convert a quarterly series to monthly for a merge?

Going from monthly to daily requires filling. For a policy rate, forward fill is correct:

```python
m = monthly_last.loc["2025"]
daily = m.resample("D").ffill()
print(daily.head(35))
```

### Try it 6.1

Load 10-year and 2-year yields (`data/boc_yield_10yr.csv`, `data/boc_yield_2yr.csv`). Compute monthly averages of each, then the monthly 10yr−2yr spread in bp. Which month since 2022 had the most inverted curve?

<details>
<summary>Solution</summary>

```python
y10 = load_boc("data/boc_yield_10yr.csv", "yield_10yr").resample("MS").mean()
y2 = load_boc("data/boc_yield_2yr.csv", "yield_2yr").resample("MS").mean()

spread_bp = (y10 - y2) * 100      # pandas aligns the two series on dates automatically
recent = spread_bp.loc["2022":].dropna()
print(f"Most inverted: {recent.min():.0f} bp in {recent.idxmin():%b %Y}")
```

Notice that `y10 - y2` matched dates automatically. This is **index alignment**, one of pandas' most important features.

</details>

---

## 6.2 `groupby`: Statistics by Category and Period (25 min)

Create `day06/grouping.py`.

### Example 1 — Latest value per CPI component

> **Question it answers:** What is the latest index level of each CPI component?
>
> **Other questions you can answer the same way:**
> - What is the latest value of each series or province?

```python
from loaders import load_cpi_long

cpi = load_cpi_long()
print(cpi["component"].value_counts())

latest = cpi.groupby("component")["value"].last()
print(latest)
```

`groupby` = *split* the data into groups → *apply* a calculation → *combine* the results.

### Example 2 — YoY inflation per component (the notebook's method)

> **Question it answers:** What is year-over-year inflation for each CPI component in the latest month?
>
> **Other questions you can answer the same way:**
> - Which components are rising fastest?
> - What is YoY growth for each province?

```python
cpi["yoy"] = cpi.groupby("component")["value"].pct_change(12) * 100
print(cpi[cpi["date"] == cpi["date"].max()][["component", "yoy"]])
```

Without `groupby`, `pct_change(12)` would compare Energy with Food at the boundary between components. Grouping keeps each component's calculation separate. This is the exact line in the notebook's Cell 4.

### Example 3 — Grouping by time

> **Question it answers:** What was average inflation each year, and in each decade?
>
> **Other questions you can answer the same way:**
> - What was average unemployment per year?
> - Which decade had the highest rates?

```python
all_items = cpi[cpi["component"] == "All-items"].set_index("date")["yoy"]

by_year = all_items.groupby(all_items.index.year).mean()
print(by_year.loc[2015:].round(2))

decade = (all_items.index.year // 10) * 10
print(all_items.groupby(decade).mean().round(2))
```

### Example 4 — Several statistics at once with `.agg`

> **Question it answers:** Since 2021, what were the mean, minimum, maximum and volatility of inflation for each component?
>
> **Other questions you can answer the same way:**
> - Which components were most volatile?
> - Which component had the highest peak?

```python
summary = (cpi.dropna(subset=["yoy"])
              .query("date >= '2021-01-01'")
              .groupby("component")["yoy"]
              .agg(["mean", "min", "max", "std"])
              .round(2)
              .sort_values("max", ascending=False))
print(summary)
```

Which component drove the post-pandemic inflation surge?

---

## 6.3 Long vs Wide: `pivot` and `melt` (20 min)

> **Question it answers:** Should my data have one row per date-and-component, or one column per component?
>
> **Other questions you can answer the same way:**
> - Which layout does a chart or a regression need?

The StatCan file is **long**: one row per date *and* component. Charts and regressions usually want **wide**: one row per date, one column per component.

```
LONG                                 WIDE
date        component  value         date        Energy  Food  Shelter ...
2026-06-01  Energy     ...           2026-06-01  ...     ...   ...
2026-06-01  Food       ...           2026-07-01  ...     ...   ...
2026-06-01  Shelter    ...
```

### Example 1 — Long to wide with `pivot`

> **Question it answers:** What were YoY inflation rates for every component, side by side by month?
>
> **Other questions you can answer the same way:**
> - How do provinces compare month by month in one table?

```python
wide_yoy = cpi.pivot(index="date", columns="component", values="yoy")
print(wide_yoy.loc["2025":].round(1).tail())
```

> If `pivot` raises *"Index contains duplicate entries"*, your data has more than one row per date-component pair. Investigate with `cpi.duplicated(["date", "component"]).sum()` before reaching for `pivot_table`.

### Example 2 — Wide to long with `melt`

> **Question it answers:** How do I turn a wide table back into one row per date and component?
>
> **Other questions you can answer the same way:**
> - How do I prepare wide spreadsheet data for grouping or plotting?

```python
long_again = wide_yoy.reset_index().melt(
    id_vars="date", var_name="component", value_name="yoy")
print(long_again.head())
```

### Example 3 — Why wide is handy: comparisons across columns

> **Question it answers:** Which components have the highest inflation right now, and how far is shelter above headline?
>
> **Other questions you can answer the same way:**
> - What is the gap between two series each month?
> - How do provinces rank in the latest month?

```python
latest = wide_yoy.dropna().iloc[-1].sort_values(ascending=False)
print(latest.round(1))

gap = wide_yoy["Shelter"] - wide_yoy["All-items"]
print(f"Shelter minus headline, latest: {gap.dropna().iloc[-1]:+.1f} pp")
```

> **Rule of thumb:** store data **long** (databases, dbt models, the Parquet files in Days 11+); analyse and plot **wide**.

---

## 6.4 Merging and Concatenating Datasets (30 min)

Create `day06/merging.py`.

### Example 1 — `pd.merge` on a date column

> **Question it answers:** What is the gap between the Bank of Canada and Fed policy rates each month?
>
> **Other questions you can answer the same way:**
> - What is the real rate (policy rate minus inflation) each month?
> - How does Canadian inflation compare with US inflation?

```python
import pandas as pd
from loaders import load_boc, load_fred

boc_m = load_boc("data/boc_overnight.csv", "overnight_rate").resample("MS").last()
fed_m = load_fred("data/fred_fedfunds.csv", "fed_funds")

rate_diff = pd.merge(boc_m.reset_index(), fed_m.reset_index(), on="date", how="inner")
rate_diff["differential"] = rate_diff["overnight_rate"] - rate_diff["fed_funds"]
print(rate_diff.tail())
```

`reset_index()` turns the date index back into a column so `merge` can match on it. This mirrors the notebook's Cell 5 BoC−Fed differential.

### Example 2 — Types of join

> **Question it answers:** Which months are kept when I combine two series with inner, left, right and outer joins?
>
> **Other questions you can answer the same way:**
> - How do I keep all months even when one series is missing?

```python
a = pd.DataFrame({"date": ["2026-01", "2026-02", "2026-03"], "boc": [2.25, 2.25, 2.25]})
b = pd.DataFrame({"date": ["2026-02", "2026-03", "2026-04"], "fed": [3.6, 3.6, 3.6]})

for how in ["inner", "left", "right", "outer"]:
    print(f"\n--- {how} ---")
    print(pd.merge(a, b, on="date", how=how))
```

| `how` | Keeps |
|---|---|
| `inner` | dates in **both** |
| `left` | all dates in the left table |
| `right` | all dates in the right table |
| `outer` | dates in **either** (missing → NaN) |

### Example 3 — Diagnosing a merge with `indicator=True`

> **Question it answers:** Which months appear in only one of the two series, and why?
>
> **Other questions you can answer the same way:**
> - Did my merge silently drop observations?

```python
check = pd.merge(boc_m.reset_index(), fed_m.reset_index(),
                 on="date", how="outer", indicator=True)
print(check["_merge"].value_counts())
print(check[check["_merge"] != "both"].tail())
```

This shows which dates exist in only one source. It's usually the most recent month, because agencies publish on different schedules.

### Example 4 — Protecting against duplicate keys

> **Question it answers:** How do I make sure a merge doesn't duplicate rows because a date appears twice?
>
> **Other questions you can answer the same way:**
> - Is my lookup table really one row per date?

```python
pd.merge(boc_m.reset_index(), fed_m.reset_index(),
         on="date", how="inner", validate="one_to_one")
```

If either side had duplicate dates, pandas would raise an error instead of silently multiplying rows.

### Example 5 — Combining many series by index with `pd.concat`

> **Question it answers:** What do the BoC rate, Fed rate, exchange rate and oil price look like side by side each month, and where are the gaps?
>
> **Other questions you can answer the same way:**
> - How do I build a monthly macro panel from several series?

When every piece is a Series with the same kind of DatetimeIndex, `concat` along columns is the simplest tool:

```python
cad_m = load_boc("data/boc_cad_usd.csv", "cad_usd").resample("MS").mean()
wti_m = load_fred("data/fred_wti.csv", "wti").resample("MS").mean()

panel = pd.concat([boc_m, fed_m, cad_m, wti_m], axis=1)
print(panel.loc["2024":].tail())
print(panel.isna().sum())
```

`axis=1` means "side by side" (columns); `axis=0` would stack rows. The notebook builds its `boc` table with `reduce(lambda a, b: pd.merge(a, b, on="date", how="outer"), ...)`, which gives the same result as an outer `concat` here.

> CAD/USD has many missing values before 2017. The notebook's chart title notes "Post-2017 FX API". Missing values often tell you something about the **source**, not the economy.

---

## 6.5 Mini-Project: Rebuild the Notebook's Derived Series (30 min)

> **Question it answers:** What were the rate differential, the real rate, CPI inflation and the exchange-rate change each month, rebuilt from raw data?
>
> **Other questions you can answer the same way:**
> - Do my numbers match the course notebook?
> - How did the real rate evolve during 2022?

Recreate **Cell 5** of `Macro_Fall_2026.ipynb` using today's tools. Create `day06/derived_series.py` that builds one monthly DataFrame with:

| Column | Definition |
|---|---|
| `overnight_rate` | BoC overnight rate, last value in month |
| `fed_funds` | Fed funds rate |
| `cad_usd` | monthly average |
| `cpi_yoy` | All-items CPI, YoY % |
| `real_rate` | `overnight_rate − cpi_yoy` |
| `boc_fed_diff` | `overnight_rate − fed_funds` |
| `usd_cad` | `1 / cad_usd` |

Then:
1. Keep data from 2006 onward.
2. Print the latest *available* value of each derived series (hint: `series.dropna().iloc[-1]`).
3. Save to `data/processed/derived_monthly.parquet`.
4. Compare your latest real rate and differential with the notebook's printed values (−0.78% and −1.38% at the time the notebook was run).

<details>
<summary>Solution</summary>

```python
import os
import pandas as pd
from loaders import load_boc, load_fred, load_cpi_long

overnight = load_boc("data/boc_overnight.csv", "overnight_rate").resample("MS").last()
fed = load_fred("data/fred_fedfunds.csv", "fed_funds")
cad = load_boc("data/boc_cad_usd.csv", "cad_usd").resample("MS").mean()

cpi = load_cpi_long()
all_items = cpi[cpi["component"] == "All-items"].set_index("date")["value"]
cpi_yoy = (all_items.pct_change(12) * 100).rename("cpi_yoy")

df = pd.concat([overnight, fed, cad, cpi_yoy], axis=1).loc["2006":]

df["real_rate"] = df["overnight_rate"] - df["cpi_yoy"]
df["boc_fed_diff"] = df["overnight_rate"] - df["fed_funds"]
df["usd_cad"] = 1 / df["cad_usd"]

for col in ["real_rate", "boc_fed_diff", "usd_cad"]:
    s = df[col].dropna()
    print(f"{col:>13}: {s.iloc[-1]:+.2f}  ({s.index[-1]:%b %Y})")

os.makedirs("data/processed", exist_ok=True)
df.to_parquet("data/processed/derived_monthly.parquet")
```

Your numbers may differ slightly from the notebook's if new data has been published since it was run. That's expected and a good discussion point about **data vintages**.

</details>

### Day 6 checklist
- [ ] I can resample daily data to monthly/quarterly and choose `last`, `mean` or `sum` on economic grounds
- [ ] I can use `groupby` for per-category and per-period statistics
- [ ] I can move between long and wide with `pivot` and `melt`
- [ ] I can merge datasets, pick the right join, and diagnose mismatches
- [ ] I rebuilt the notebook's derived series myself

```bash
git add .
git commit -m "Day 6: resample, groupby, pivot, merge"
git push
```

---

# DAY 7 — Integration: A Clean, Validated Macro Panel

| Time | Block |
|---|---|
| 0:00 – 0:30 | 7.1 Quick charts with pandas and matplotlib |
| 0:30 – 0:38 | Break |
| 0:38 – 1:08 | 7.2 Refactoring into a `panel.py` module |
| 1:08 – 1:28 | 7.3 Data-quality checks |
| 1:28 – 1:35 | Break |
| 1:35 – 1:55 | 7.4 Mixing frequencies: a quarterly panel with GDP |
| 1:55 – 2:20 | 7.5 Capstone: `build_panel.py` |
| 2:20 – 2:30 | 7.6 Recap and bridge to Days 8–10 |

---

## 7.1 Quick Charts with pandas and matplotlib (30 min)

The course notebook uses Plotly for interactive dashboards. For quick checks during data work, pandas' built-in plotting (via matplotlib) is faster. Codespaces has no screen for pop-up windows, so we **save charts as PNG files** and open them in the VS Code Explorer.

Create `day07/quick_charts.py`. Copy `day06/loaders.py` into `day07/` first.

### Example 1 — A single line chart

> **Question it answers:** How has the overnight rate moved over time?
>
> **Other questions you can answer the same way:**
> - What does the history of any single indicator look like?

```python
import os
import matplotlib
matplotlib.use("Agg")                  # draw to files, not windows
import matplotlib.pyplot as plt
from loaders import load_boc

os.makedirs("day07/charts", exist_ok=True)

overnight = load_boc("data/boc_overnight.csv", "overnight_rate")

ax = overnight.plot(title="BoC Overnight Rate (%)", figsize=(10, 4))
ax.set_ylabel("%")
plt.tight_layout()
plt.savefig("day07/charts/overnight.png", dpi=120)
plt.close()
```

### Example 2 — Several series and a reference line

> **Question it answers:** How have headline, shelter and energy inflation moved since 2018 relative to the 2% target?
>
> **Other questions you can answer the same way:**
> - Which component drove the 2022 inflation surge?
> - How far is inflation from target?

```python
import pandas as pd
from loaders import load_cpi_long

cpi = load_cpi_long()
cpi["yoy"] = cpi.groupby("component")["value"].pct_change(12) * 100
wide = cpi.pivot(index="date", columns="component", values="yoy").loc["2018":]

ax = wide[["All-items", "Shelter", "Energy"]].plot(
    figsize=(10, 5), title="CPI Inflation by Component (YoY %)")
ax.axhline(2, linestyle="--", color="green", label="2% target")
ax.axhspan(1, 3, color="green", alpha=0.08)       # control range
ax.legend()
plt.tight_layout()
plt.savefig("day07/charts/cpi_components.png", dpi=120)
plt.close()
```

### Example 3 — Recession shading (from the notebook)

> **Question it answers:** How did the indicator behave during past recessions?
>
> **Other questions you can answer the same way:**
> - Did unemployment rise during each recession?
> - When did rates fall relative to the downturns?

```python
RECESSION_BANDS = [          # as defined in the course notebook
    ("2008-10-01", "2009-06-30", "GFC"),
    ("2015-01-01", "2015-09-30", "Oil shock"),
    ("2020-02-01", "2020-06-30", "COVID"),
    ("2025-10-01", "2026-03-31", "Tariff recession"),
]

def add_recession_shading(ax):
    for start, end, label in RECESSION_BANDS:
        ax.axvspan(pd.Timestamp(start), pd.Timestamp(end), color="red", alpha=0.12)

ax = wide["All-items"].plot(figsize=(10, 4), title="Headline CPI (YoY %)")
add_recession_shading(ax)
plt.tight_layout()
plt.savefig("day07/charts/cpi_recessions.png", dpi=120)
plt.close()
```

### Example 4 — Two panels in one figure

> **Question it answers:** How did the policy rate respond to inflation over time?
>
> **Other questions you can answer the same way:**
> - How do two related indicators compare when they have different units?

```python
fig, axes = plt.subplots(2, 1, figsize=(10, 7), sharex=True)

overnight.loc["2018":].plot(ax=axes[0], title="Overnight rate (%)")
wide["All-items"].plot(ax=axes[1], title="CPI inflation (YoY %)")
for ax in axes:
    add_recession_shading(ax)

plt.tight_layout()
plt.savefig("day07/charts/rate_vs_inflation.png", dpi=120)
plt.close()
```

Open the `charts/` folder in the Explorer and click a PNG to view it.

---

## 7.2 Refactoring into a `panel.py` Module (30 min)

> **Question it answers:** How do I build the monthly macro panel with one reusable function instead of repeating steps in every script?
>
> **Other questions you can answer the same way:**
> - Where do I change the start date or add a new series once for all scripts?

Over three days, your scripts have repeated the same loading and transforming steps. Let's collect them into **one tested module**, just as Day 3's `macrotools.py` did for scalar calculations.

Create `day07/panel.py`:

```python
"""panel.py — build a clean monthly Canadian macro panel from raw files."""
import pandas as pd

from loaders import load_boc, load_fred, load_cpi_long

START = "2006-01-01"


def monthly(series, how="last"):
    """Resample a daily Series to month-start frequency."""
    resampler = series.resample("MS")
    if how == "last":
        return resampler.last()
    if how == "mean":
        return resampler.mean()
    if how == "sum":
        return resampler.sum()
    raise ValueError(f"Unknown aggregation: {how}")


def cpi_yoy_wide(path="data/statcan_cpi.csv"):
    """Wide DataFrame of YoY inflation by component."""
    cpi = load_cpi_long(path)
    cpi["yoy"] = cpi.groupby("component")["value"].pct_change(12) * 100
    wide = cpi.pivot(index="date", columns="component", values="yoy")
    wide.columns = ["cpi_yoy_" + c.lower().replace(" ", "_").replace("-", "_")
                    for c in wide.columns]
    return wide


def build_monthly_panel(start=START):
    """Assemble all monthly indicators and derived series."""
    pieces = [
        monthly(load_boc("data/boc_overnight.csv", "overnight_rate"), "last"),
        monthly(load_boc("data/boc_yield_2yr.csv", "yield_2yr"), "mean"),
        monthly(load_boc("data/boc_yield_10yr.csv", "yield_10yr"), "mean"),
        monthly(load_boc("data/boc_cad_usd.csv", "cad_usd"), "mean"),
        load_fred("data/fred_fedfunds.csv", "fed_funds"),
        monthly(load_fred("data/fred_wti.csv", "wti"), "mean"),
        cpi_yoy_wide(),
    ]
    df = pd.concat(pieces, axis=1).loc[start:]
    df.index.name = "date"

    df["real_rate"] = df["overnight_rate"] - df["cpi_yoy_all_items"]
    df["boc_fed_diff"] = df["overnight_rate"] - df["fed_funds"]
    df["spread_10_2_bp"] = (df["yield_10yr"] - df["yield_2yr"]) * 100
    df["usd_cad"] = 1 / df["cad_usd"]
    return df


def latest_values(df):
    """Latest non-missing value and its date for every column."""
    rows = []
    for col in df.columns:
        s = df[col].dropna()
        if len(s):
            rows.append({"indicator": col, "value": round(s.iloc[-1], 3),
                         "as_of": s.index[-1].strftime("%Y-%m")})
    return pd.DataFrame(rows).set_index("indicator")
```

Things to notice:

- Each function does **one job** and can be tested alone.
- `raise ValueError(...)` stops the program with a clear message instead of silently returning wrong data.
- The column-renaming line turns `"All-items"` into `cpi_yoy_all_items`. Clean, lowercase names will save you pain in SQL (Days 11+).

Try it interactively:

```python
from panel import build_monthly_panel, latest_values

panel = build_monthly_panel()
print(panel.shape)
print(latest_values(panel))
```

---

## 7.3 Data-Quality Checks (20 min)

> **Question it answers:** Does the panel have sorted, unique dates, plausible values and no unexpected gaps?
>
> **Other questions you can answer the same way:**
> - Is this dataset safe to share?
> - Which checks failed, and why?

Before anyone uses your panel, it should **prove** it's sound. Add to `panel.py`:

```python
def check_panel(df):
    """Raise an error if the panel breaks basic quality rules."""
    problems = []

    # 1. Index rules
    if not df.index.is_unique:
        problems.append("duplicate dates in index")
    if not df.index.is_monotonic_increasing:
        problems.append("index not sorted")
    expected = pd.date_range(df.index.min(), df.index.max(), freq="MS")
    missing = expected.difference(df.index)
    if len(missing):
        problems.append(f"{len(missing)} missing months, e.g. {missing[0]:%Y-%m}")

    # 2. Plausible ranges (economic sanity, not statistics)
    ranges = {
        "overnight_rate": (-1, 25),
        "fed_funds": (-1, 25),
        "cpi_yoy_all_items": (-5, 20),
        "usd_cad": (0.8, 2.0),
        "wti": (0, 250),
    }
    for col, (low, high) in ranges.items():
        s = df[col].dropna()
        bad = s[(s < low) | (s > high)]
        if len(bad):
            problems.append(f"{col}: {len(bad)} values outside [{low}, {high}]")

    # 3. Completeness of core series in recent data
    recent = df.loc["2018":"2024"]
    for col in ["overnight_rate", "fed_funds", "cpi_yoy_all_items"]:
        n_missing = recent[col].isna().sum()
        if n_missing:
            problems.append(f"{col}: {n_missing} missing values in 2018–2024")

    if problems:
        raise ValueError("Panel failed checks:\n  - " + "\n  - ".join(problems))
    print(f"✓ Panel passed all checks ({len(df)} months, {df.shape[1]} columns)")
```

> **Why ranges and not just `isna()`?** A unit error (a rate stored as 0.0225 instead of 2.25) produces no missing values but is badly wrong. Range checks catch it. On Days 41–50, Great Expectations formalises exactly these rules: "unemployment between 0 and 100", "dates continuous without gaps".

### Try it 7.3

Deliberately break the panel and confirm your checks catch each problem:

```python
broken = panel.copy()
broken.loc["2020-05-01", "overnight_rate"] = 225      # unit error
check_panel(broken)
```

Then try dropping a row (`panel.drop(pd.Timestamp("2019-03-01"))`) and duplicating one (`pd.concat([panel, panel.iloc[[5]]])`).

---

## 7.4 Mixing Frequencies: a Quarterly Panel with GDP (20 min)

> **Question it answers:** In each quarter, how did real GDP growth compare with average inflation, rates and unemployment?
>
> **Other questions you can answer the same way:**
> - What was GDP growth when inflation peaked?
> - How do monthly indicators line up with quarterly GDP?

GDP is quarterly; most of our panel is monthly. The standard approach is to **aggregate monthly to quarterly**, never to invent monthly GDP.

Add to `panel.py`:

```python
def load_gdp(path="data/statcan_gdp.csv"):
    """Quarterly real GDP (SAAR, chained 2017 $) with growth rates."""
    df = pd.read_csv(path)
    df["date"] = pd.to_datetime(df["REF_DATE"], format="%Y-%m")
    gdp = df.set_index("date")["VALUE"].sort_index().rename("real_gdp")
    out = gdp.to_frame()
    out["gdp_qoq_ann_simple"] = gdp.pct_change() * 400             # notebook method
    out["gdp_qoq_ann"] = ((gdp / gdp.shift(1)) ** 4 - 1) * 100     # compounded
    out["gdp_yoy"] = gdp.pct_change(4) * 100
    return out


def build_quarterly_panel(monthly_df):
    """Quarterly averages of monthly indicators joined with GDP."""
    q = monthly_df.resample("QS").mean()
    q = q.join(load_gdp(), how="left")
    return q
```

StatCan labels quarters by their first month (`2026-04` = Q2 2026), which matches `resample("QS")`. The two indexes line up exactly, so `.join` (a merge on the index) works cleanly.

```python
from panel import build_monthly_panel, build_quarterly_panel

qpanel = build_quarterly_panel(build_monthly_panel())
print(qpanel[["real_gdp", "gdp_qoq_ann", "gdp_qoq_ann_simple",
              "overnight_rate", "real_rate"]].tail(8).round(2))
```

Compare the simple and compounded annualised growth: the gap is largest in extreme quarters like 2020.

> **Discussion:** is averaging the policy rate over a quarter the right choice? What would `last` imply instead? There's no universal answer. Document your choice.

---

## 7.5 Capstone: `build_panel.py` (25 min)

> **Question it answers:** How can anyone reproduce the monthly and quarterly panels and charts with a single command?
>
> **Other questions you can answer the same way:**
> - Will a colleague get the same datasets and charts on their computer?

Write a single script that anyone on your team can run to reproduce your datasets and charts.

**Requirements:**
1. Build the monthly panel and run `check_panel`.
2. Build the quarterly panel.
3. Save both to `data/processed/` as Parquet (index included).
4. Save a `latest_values` table as CSV for quick inspection.
5. Produce at least two charts in `day07/charts/`: (a) overnight rate vs CPI inflation with the 1–3% band; (b) real GDP growth bars coloured by sign.
6. Print a short text briefing.

<details>
<summary>Solution</summary>

```python
"""build_panel.py — reproducible monthly & quarterly macro panels.

Run from the repository root:  python day07/build_panel.py
"""
import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from panel import (build_monthly_panel, build_quarterly_panel,
                   check_panel, latest_values)

OUT = "data/processed"
CHARTS = "day07/charts"
os.makedirs(OUT, exist_ok=True)
os.makedirs(CHARTS, exist_ok=True)

# 1–2. Build and validate
monthly = build_monthly_panel()
check_panel(monthly)
quarterly = build_quarterly_panel(monthly)

# 3–4. Save
monthly.to_parquet(f"{OUT}/macro_monthly.parquet")
quarterly.to_parquet(f"{OUT}/macro_quarterly.parquet")
latest = latest_values(monthly)
latest.to_csv(f"{OUT}/latest_values.csv")
print(f"✓ Saved panels: monthly {monthly.shape}, quarterly {quarterly.shape}")

# 5a. Overnight rate vs inflation
recent = monthly.loc["2015":]
ax = recent[["overnight_rate", "cpi_yoy_all_items"]].plot(
    figsize=(10, 4.5), title="BoC Overnight Rate vs CPI Inflation (%)")
ax.axhspan(1, 3, color="green", alpha=0.08, label="1–3% control range")
ax.legend(["Overnight rate", "CPI YoY", "1–3% range"])
plt.tight_layout()
plt.savefig(f"{CHARTS}/rate_vs_cpi.png", dpi=120)
plt.close()

# 5b. GDP growth bars
g = quarterly["gdp_qoq_ann"].dropna().loc["2015":]
colours = ["tab:blue" if v >= 0 else "tab:red" for v in g]
fig, ax = plt.subplots(figsize=(10, 4.5))
ax.bar(g.index, g.values, width=60, color=colours)
ax.axhline(0, color="grey", linewidth=0.8)
ax.set_title("Real GDP Growth (QoQ annualised, %)")
plt.tight_layout()
plt.savefig(f"{CHARTS}/gdp_growth.png", dpi=120)
plt.close()
print(f"✓ Charts saved to {CHARTS}/")

# 6. Briefing
def fmt(name, unit="%"):
    row = latest.loc[name]
    return f"{row['value']:.2f}{unit} ({row['as_of']})"

print("\n=== Canadian Macro Briefing ===")
print(f"Overnight rate:   {fmt('overnight_rate')}")
print(f"CPI inflation:    {fmt('cpi_yoy_all_items')}")
print(f"Real rate:        {fmt('real_rate')}")
print(f"BoC − Fed:        {fmt('boc_fed_diff', ' pp')}")
print(f"10y−2y spread:    {fmt('spread_10_2_bp', ' bp')}")
print(f"USD/CAD:          {fmt('usd_cad', '')}")
gdp_last = quarterly["gdp_qoq_ann"].dropna()
print(f"Real GDP growth:  {gdp_last.iloc[-1]:.1f}% ann. "
      f"({gdp_last.index[-1].year} Q{gdp_last.index[-1].quarter})")
```

</details>

Run it end-to-end:

```bash
python day07/build_panel.py
```

**Stretch goals:**
- Add a `--start` option by reading `sys.argv` so users can choose the start year.
- Add the Energy and Shelter contributions to headline CPI using the notebook's `WEIGHTS` dictionary.
- Time the script with `time python day07/build_panel.py`. Which step is slowest?

---

## 7.6 Recap and Bridge to Days 8–10 (10 min)

### What you built, mapped to the course notebook

| Notebook | Your Days 4–7 version |
|---|---|
| Cell 3 `boc_fetch`, `fred_fetch` → merged `boc` table | `load_boc`, `load_fred`, `pd.concat` |
| Cell 4 `cpi.groupby("component")["value"].pct_change(12)` | `cpi_yoy_wide()` |
| Cell 4 `gdp_sa["value"].pct_change() * 400` | `load_gdp()` (simple *and* compounded) |
| Cell 5 real rate, BoC−Fed differential, monthly CAD | `build_monthly_panel()` |
| `save_df(... .parquet)` | `to_parquet` in `build_panel.py` |
| *(none)* | `check_panel()`: quality rules the notebook doesn't yet have |

### Day 1–3 concepts → pandas

| Plain Python | pandas |
|---|---|
| `for` loop over a list | vectorised arithmetic |
| `yoy_changes(levels, 12)` | `.pct_change(12)` |
| `moving_average(x, 4)` | `.rolling(4).mean()` |
| running-peak accumulator | `.expanding().max()` |
| `clean_observations` with `try/except` | `pd.to_numeric(errors="coerce").dropna()` |
| dictionaries of indicators | DataFrame columns |

### Looking ahead

`get_course_data.py` was a black box. On **Days 8–10** you'll open it up: HTTP requests, JSON structures, status codes, error handling, and robust reusable fetchers for the BoC Valet, FRED and StatCan APIs. That gives your `panel.py` a live, automated data source.

### Day 7 checklist
- [ ] I can make and save line and bar charts with recession shading
- [ ] I refactored repeated code into a documented module
- [ ] My panel checks index integrity, plausible ranges and completeness
- [ ] I can combine monthly and quarterly data without inventing observations
- [ ] One command rebuilds all my datasets and charts

```bash
git add .
git commit -m "Day 7: validated macro panel, charts, build script"
git push
```
