# Module 1 · Python for Macroeconomics
## Days 1–3: Syntax, Control Flow, Functions & Virtual Environments

**Audience:** MSc Economics students with little or no programming experience
**Environment:** GitHub Codespaces (VS Code in the browser)
**Time per day:** ~2.5 hours (including breaks and exercises)
**Goal by end of Day 3:** Students write a small reusable Python module of macro tools, run it inside a proper virtual environment, and use it to pull the live Bank of Canada overnight rate.

---

### How to use this guide

Each day is split into timed blocks. Every block follows the same rhythm:

1. **Concept**: a short explanation in economic terms.
2. **Examples**: several small, progressive code snippets. Type them yourself; don't copy-paste.
3. **Try it**: a quick exercise. Solutions are hidden in collapsible blocks.

The economic numbers used here come from our course notebook (`Macro_Fall_2026.ipynb`) or are clearly marked *illustrative*. On Days 8–10 we will replace hard-coded numbers with live API data.

### Target folder structure (built up over three days)

```
macro-data-course/
├── .gitignore
├── requirements.txt
├── day01/
│   ├── hello.py
│   ├── rates.py
│   └── snapshot.py
├── day02/
│   ├── stance.py
│   ├── loops.py
│   └── clean_boc.py
└── day03/
    ├── macrotools.py
    ├── analysis.py
    └── fetch_boc.py
```

---

# DAY 1 — Python as an Economist's Calculator

| Time | Block |
|---|---|
| 0:00 – 0:23 | 1.1 Setting up Codespaces and running your first script |
| 0:23 – 0:53 | 1.2 Variables and arithmetic (real rates, compounding, annualising) |
| 0:53 – 1:00 | Break |
| 1:00 – 1:23 | 1.3 Data types · 1.4 Strings and f-strings |
| 1:23 – 1:53 | 1.5 Lists (time series) · 1.6 Dictionaries (indicator snapshots) |
| 1:53 – 2:00 | Break |
| 2:00 – 2:23 | 1.7 Day 1 mini-project: Macro Snapshot Printer |
| 2:23 – 2:30 | 1.8 Save your work with Git |

---

## 1.1 Setting up Codespaces (23 min)

**Step 1 — Create a repository.** On GitHub, click **New repository**, name it `macro-data-course`, tick **Add a README**, and click **Create repository**.

**Step 2 — Launch a Codespace.** On the repository page click **Code → Codespaces → Create codespace on main**. After a minute you'll see VS Code in your browser.

**Step 3 — Find the terminal.** At the bottom of the screen there is a **Terminal** panel (if not, press `` Ctrl+` ``). The terminal is where you type commands to the computer.

```bash
python --version
```

You should see something like `Python 3.12.x`. Python is already installed in Codespaces.

**Step 4 — Try Python interactively.** Type `python` and press Enter. You're now in the *Python interpreter* (the prompt changes to `>>>`). Try:

```python
>>> 2 + 2
4
>>> 2.25 - 3.0
-0.75
>>> exit()
```

The interpreter is great for quick checks, but real work lives in **scripts** (`.py` files) that we can save, rerun, and share.

**Step 5 — Your first script.**

```bash
mkdir day01
```

In the Explorer panel (left), right-click `day01` → **New File** → `hello.py`:

```python
# hello.py — my first Python script
# Lines starting with # are comments. Python ignores them.

print("Hello, macroeconomics!")
print("The Bank of Canada targets 2% inflation.")
```

Run it from the terminal:

```bash
python day01/hello.py
```

> **Key idea:** `print()` displays output. Comments (`#`) explain *why* — write them generously.

---

## 1.2 Variables and Arithmetic (30 min)

A **variable** is a labelled box holding a value. Economists already think this way: `i` is the nominal rate, `π` is inflation.

### Example 1 — The real interest rate (approximation)

> **Question it answers:** With the policy rate at 2.25% and inflation at 3.0%, what is the real interest rate?
>
> **Other questions you can answer the same way:**
> - Is today's real rate positive or negative?
> - What real return does a 4% GIC give after inflation?
> - How much did real wages grow if pay rose 3.5% and prices 3%?

Create `day01/rates.py`:

```python
# Values from the course notebook (latest observations)
overnight_rate = 2.25   # BoC policy rate, %
cpi_inflation = 3.0     # CPI all-items, year-over-year %

real_rate = overnight_rate - cpi_inflation

print("Real interest rate (approx.):")
print(real_rate)
```

Output: `-0.75`. A negative real rate means policy is stimulative in real terms.

> **Naming rules:** use lowercase with underscores (`cpi_inflation`, not `CPI Inflation`). Names can't start with a number or contain spaces. Pick names a colleague would understand.

### Example 2 — The exact Fisher equation

> **Question it answers:** What is the exact real interest rate, and how different is it from the quick approximation?
>
> **Other questions you can answer the same way:**
> - When does the approximation r ≈ i − π become misleading (e.g. at high inflation)?
> - What is the exact real yield on a bond?

The approximation `r ≈ i − π` works for small rates. The exact relation is `(1 + r) = (1 + i) / (1 + π)`. Python uses `**` for powers and parentheses as in algebra. Add to `rates.py`:

```python
# Convert percentages to decimals
i = overnight_rate / 100
pi = cpi_inflation / 100

real_rate_exact = (1 + i) / (1 + pi) - 1

print("Real interest rate (exact Fisher), %:")
print(real_rate_exact * 100)
```

Output: about `-0.728`. The two measures differ slightly — worth remembering when inflation is high.

### Example 3 — Compound growth

> **Question it answers:** If nominal GDP of about $3,180B grows 1.5% a year, how big will it be in five years?
>
> **Other questions you can answer the same way:**
> - What will a $500,000 home be worth after 10 years at 4% a year?
> - How large will federal debt be if it grows 5% a year?

Federal GDP in the notebook's fiscal table for 2026 is about $3,180B. What if nominal GDP grows 1.5% a year for 5 years?

```python
gdp_2026 = 3180        # $ billions
growth = 0.015         # 1.5% per year
years = 5

gdp_future = gdp_2026 * (1 + growth) ** years

print("Projected GDP in 5 years ($B):")
print(gdp_future)
```

Output: about `3425.8`.

### Example 4 — Annualising quarterly growth

> **Question it answers:** If GDP grew 0.8% this quarter, what is that as an annual rate (simple and compound)?
>
> **Other questions you can answer the same way:**
> - What annual rate does a 0.3% monthly CPI increase imply?
> - Why do the headline and the release numbers differ?

Statistics Canada reports quarterly GDP growth, but headlines quote *annualised* rates. The notebook uses the shortcut `qoq × 4`. The compounded version is `(1 + qoq)^4 − 1`.

```python
qoq_growth = 0.008     # 0.8% quarter-over-quarter

annualised_simple = qoq_growth * 4
annualised_compound = (1 + qoq_growth) ** 4 - 1

print("Simple annualised:", annualised_simple * 100)
print("Compound annualised:", annualised_compound * 100)
```

Output: `3.2` vs about `3.24`. Notice `print` can take several items separated by commas.

### Python's arithmetic operators

| Operator | Meaning | Example | Result |
|---|---|---|---|
| `+` `-` | add, subtract | `5.0 - 2.25` | `2.75` |
| `*` `/` | multiply, divide | `100 / 4` | `25.0` |
| `**` | power | `1.02 ** 10` | `1.2189...` |
| `//` | whole-number division | `14 // 4` | `3` |
| `%` | remainder | `14 % 4` | `2` |

### Try it 1.2

A 10-year Government of Canada bond yields 3.75% and the 2-year yields 2.27% (notebook values).
(a) Compute the 10yr−2yr spread in percentage points.
(b) Convert it to basis points (1 pp = 100 bp).
(c) If $1,000 is invested at 3.75% annually for 10 years, what is it worth?

<details>
<summary>Solution</summary>

```python
yield_10yr = 3.75
yield_2yr = 2.27

spread_pp = yield_10yr - yield_2yr
spread_bp = spread_pp * 100

investment = 1000 * (1 + yield_10yr / 100) ** 10

print("Spread (pp):", spread_pp)
print("Spread (bp):", spread_bp)
print("Value after 10 years:", investment)
```

Output: spread ≈ 1.48 pp ≈ 148 bp; investment ≈ $1,444.5. You may see `1.4800000000000002` — we explain why in the next block.

</details>

---

## 1.3 Data Types (13 min)

Every value has a **type**. The four you need today:

| Type | What it holds | Examples |
|---|---|---|
| `int` | whole numbers | `2026`, `12`, `-3` |
| `float` | decimals | `2.25`, `-0.75` |
| `str` | text | `"Canada"`, `"2026-08-01"` |
| `bool` | true/false | `True`, `False` |

### Example 1 — Checking types

> **Question it answers:** Is this value a whole number, a decimal, text or True/False?
>
> **Other questions you can answer the same way:**
> - Did the API give me a number or text?

```python
print(type(2026))       # <class 'int'>
print(type(2.25))       # <class 'float'>
print(type("V39079"))   # <class 'str'>
print(type(True))       # <class 'bool'>
```

### Example 2 — Floating-point surprises

> **Question it answers:** Why does 0.1 + 0.2 not print exactly 0.3, and how do I display it cleanly?
>
> **Other questions you can answer the same way:**
> - Why does a total in my table show 0.30000000000000004?

```python
print(0.1 + 0.2)              # 0.30000000000000004
print(round(0.1 + 0.2, 2))    # 0.3
```

Computers store decimals in binary, so tiny errors appear. This is harmless for economics, but **round when displaying** and never test decimals with exact equality.

### Example 3 — Converting types (very important for APIs)

> **Question it answers:** How do I turn the text "2.25" returned by the Bank of Canada API into a number I can calculate with?
>
> **Other questions you can answer the same way:**
> - How do I turn the year "2026" into a number?
> - Why does adding "2.25" + "1" give "2.251"?

The Bank of Canada API returns numbers as **text**. Look at this line in the notebook's `boc_fetch`: `float(v)`. That's a type conversion.

```python
rate_from_api = "2.25"            # this is a string!
print(rate_from_api + "1")        # "2.251" — text gets glued together

rate = float(rate_from_api)       # convert to a number
print(rate + 1)                   # 3.25

year = int("2026")
print(year + 1)                   # 2027

label = str(2.25)
print("Rate: " + label + "%")     # Rate: 2.25%
```

> **Common error:** `float("NA")` or `float("Bank holiday")` crashes with a `ValueError`. We handle this on Day 2.

---

## 1.4 Strings and f-strings (10 min)

**f-strings** let you insert variables into text and control formatting. Put `f` before the quotes and variables in `{}`.

### Example 1 — Basic f-string

> **Question it answers:** How do I print a sentence that includes the latest unemployment rate?
>
> **Other questions you can answer the same way:**
> - How do I write "Inflation in Ontario is 2.8%" from variables?

```python
country = "Canada"
unemployment = 6.4
print(f"The unemployment rate in {country} is {unemployment}%.")
```

### Example 2 — Formatting numbers

> **Question it answers:** How do I show a rate with two decimals, a sign, a thousands separator, basis points or a percentage?
>
> **Other questions you can answer the same way:**
> - How do I display housing starts as 66,788?
> - How do I show 0.0324 as 3.2%?

```python
real_rate = -0.7281553398
housing_starts = 66788
spread_pp = 1.4800000000000002

print(f"Real rate: {real_rate:.2f}%")          # 2 decimals → -0.73%
print(f"Real rate: {real_rate:+.2f}%")         # force sign  → -0.73%
print(f"Housing starts: {housing_starts:,}")   # thousands separator → 66,788
print(f"Spread: {spread_pp * 100:.0f} bp")     # no decimals → 148 bp
print(f"Growth: {0.0324:.1%}")                 # as percentage → 3.2%
```

### Example 3 — Useful string methods

> **Question it answers:** How do I clean messy series names and extract the year from a date string?
>
> **Other questions you can answer the same way:**
> - Why does "V39079" not match "v39079"?
> - How do I get "2026" out of "2026-08-01"?

```python
series_name = "  Unemployment Rate  "
print(series_name.strip())          # removes outer spaces
print(series_name.strip().lower())  # "unemployment rate"
print("2026-08-01"[:4])             # first 4 characters → "2026"
print("V39079" == "v39079")         # False — text comparison is case-sensitive
```

> The notebook uses `df.columns.str.strip()` for exactly this reason — StatCan headers sometimes contain stray spaces.

---

## 1.5 Lists: Your First Time Series (18 min)

A **list** is an ordered collection — a natural container for a time series.

### Example 1 — Creating and inspecting a list

> **Question it answers:** How many months of CPI do I have, and what are the first and last values?
>
> **Other questions you can answer the same way:**
> - What was the latest policy rate in my list?
> - How many observations does a series contain?

```python
# Illustrative monthly CPI index levels, Jan–Dec
cpi = [161.3, 161.8, 162.4, 162.6, 163.0, 163.4,
       163.9, 164.0, 163.7, 164.1, 164.3, 164.2]

print(cpi)
print("Number of months:", len(cpi))
print("First value:", cpi[0])     # Python counts from 0!
print("Last value:", cpi[-1])     # negative index counts from the end
```

> **Zero-based indexing:** January is `cpi[0]`, December is `cpi[11]` (or `cpi[-1]`). This trips everyone up at first.

### Example 2 — Slicing (sub-periods)

> **Question it answers:** What were CPI levels in Q1, in the second half of the year, and in the last three months?
>
> **Other questions you can answer the same way:**
> - What happened in the last 12 months only?
> - What were the values in a given sub-period?

```python
q1 = cpi[0:3]        # items 0, 1, 2 (stop index is excluded)
h2 = cpi[6:]         # from July to the end
last_3 = cpi[-3:]    # last three months

print("Q1:", q1)
print("H2:", h2)
print("Last 3 months:", last_3)
```

### Example 3 — Summary statistics with built-ins

> **Question it answers:** What were the average, lowest and highest CPI levels, and how much did prices rise from January to December?
>
> **Other questions you can answer the same way:**
> - What was the average policy rate this year?
> - What was the range of the exchange rate?

```python
average = sum(cpi) / len(cpi)
print(f"Average CPI level: {average:.2f}")
print(f"Min: {min(cpi)}, Max: {max(cpi)}")

# Change over the year (Dec vs Jan)
change = (cpi[-1] / cpi[0] - 1) * 100
print(f"Jan→Dec change: {change:.2f}%")
```

### Example 4 — Modifying lists

> **Question it answers:** How do I add next month's value when new data is released?
>
> **Other questions you can answer the same way:**
> - How do I extend a list of dates with a new month?

```python
cpi.append(164.9)            # add next January's value
print(len(cpi))              # 13

dates = ["2026-01", "2026-02", "2026-03"]
dates.append("2026-04")
print(dates)
```

### Try it 1.5

Using the notebook's BoC decision rates for 2024 (in order): `[4.75, 4.50, 4.25, 3.75, 3.25]`
(a) Print the first and last rates. (b) Compute the total change in basis points. (c) Print the number of decisions.

<details>
<summary>Solution</summary>

```python
rates_2024 = [4.75, 4.50, 4.25, 3.75, 3.25]

print("First:", rates_2024[0], "Last:", rates_2024[-1])
total_change_bp = (rates_2024[-1] - rates_2024[0]) * 100
print(f"Total change: {total_change_bp:.0f} bp")
print("Decisions:", len(rates_2024))
```

Output: `-150 bp`, 5 decisions.

</details>

---

## 1.6 Dictionaries: Indicator Snapshots (13 min)

A **dictionary** maps *keys* to *values*. Think of it as a labelled row: indicator name → latest value. The notebook's `BOC_SERIES` and `TARIFF_STATUS` are dictionaries.

### Example 1 — Building a snapshot

> **Question it answers:** How do I store today's key indicators together and look one up by name?
>
> **Other questions you can answer the same way:**
> - What is the latest unemployment rate in my snapshot?

```python
snapshot = {
    "overnight_rate": 2.25,
    "cpi_yoy": 3.0,
    "unemployment": 6.4,
    "usd_cad": 1.3864,
}

print(snapshot["unemployment"])     # look up by key → 6.4
```

### Example 2 — Adding and updating

> **Question it answers:** How do I add a derived indicator (the real rate) and replace a revised value?
>
> **Other questions you can answer the same way:**
> - How do I update a figure after StatCan revises it?
> - Which indicators does my snapshot contain?

```python
snapshot["real_rate"] = snapshot["overnight_rate"] - snapshot["cpi_yoy"]
snapshot["unemployment"] = 6.5      # a revised value replaces the old one

print(snapshot)
print(list(snapshot.keys()))
```

### Example 3 — Series codes (a pattern you'll see all course)

> **Question it answers:** Which economic series does the code V39079 stand for, and is a given code in my catalogue?
>
> **Other questions you can answer the same way:**
> - What is the readable name of each Bank of Canada series code?

```python
BOC_SERIES = {
    "V39079": "overnight_rate",
    "V122531": "yield_2yr",
    "BD.CDN.10YR.DQ.YLD": "yield_10yr",
}

code = "V39079"
print(f"Series {code} is the {BOC_SERIES[code]}")
print("V122538" in BOC_SERIES)      # False — check before looking up
```

> **Common error:** `snapshot["gdp"]` raises a `KeyError` if the key doesn't exist. Use `snapshot.get("gdp")`, which returns `None` instead of crashing.

---

## 1.7 Day 1 Mini-Project: Macro Snapshot Printer (23 min)

> **Question it answers:** What do the latest Canadian macro indicators look like on one tidy screen, including the real rate and the yield spread?
>
> **Other questions you can answer the same way:**
> - Is the real rate negative today?
> - Is the yield curve inverted?
> - How do today's indicators compare at a glance?

**Task:** Create `day01/snapshot.py` that stores the latest indicators in a dictionary, derives the real rate and 10yr−2yr spread, and prints a neatly formatted briefing.

Expected output (roughly):

```
=== Canadian Macro Snapshot ===
Overnight rate:     2.25%
CPI inflation:      3.0%
Real rate:         -0.75%
Unemployment:       6.4%
10yr-2yr spread:    148 bp
USD/CAD:            1.3864
Housing starts:     66,788
```

<details>
<summary>Solution</summary>

```python
# day01/snapshot.py — prints a formatted macro briefing

snapshot = {
    "overnight_rate": 2.25,
    "cpi_yoy": 3.0,
    "unemployment": 6.4,
    "yield_10yr": 3.75,
    "yield_2yr": 2.27,
    "cad_usd": 0.7213,
    "housing_starts": 66788,
}

# Derived indicators
snapshot["real_rate"] = snapshot["overnight_rate"] - snapshot["cpi_yoy"]
snapshot["spread_bp"] = (snapshot["yield_10yr"] - snapshot["yield_2yr"]) * 100
snapshot["usd_cad"] = 1 / snapshot["cad_usd"]

print("=== Canadian Macro Snapshot ===")
print(f"Overnight rate:  {snapshot['overnight_rate']:>6.2f}%")
print(f"CPI inflation:   {snapshot['cpi_yoy']:>6.1f}%")
print(f"Real rate:       {snapshot['real_rate']:>6.2f}%")
print(f"Unemployment:    {snapshot['unemployment']:>6.1f}%")
print(f"10yr-2yr spread: {snapshot['spread_bp']:>6.0f} bp")
print(f"USD/CAD:         {snapshot['usd_cad']:>6.4f}")
print(f"Housing starts:  {snapshot['housing_starts']:>6,}")
```

Note: `:>6.2f` means *right-align in 6 characters with 2 decimals*. Inside an f-string with double quotes, use single quotes for dictionary keys.

</details>

**Stretch:** add a line showing the exact Fisher real rate next to the approximation.

---

## 1.8 Save Your Work with Git (8 min)

Git records snapshots of your project. In the terminal:

```bash
git add .
git commit -m "Day 1: variables, lists, dictionaries, snapshot printer"
git push
```

Refresh your GitHub repository page — your files are there. Do this at the end of every day.

### Day 1 checklist
- [ ] I can run a `.py` script from the terminal
- [ ] I can compute real rates, compound growth, and annualised growth
- [ ] I know the difference between `int`, `float`, `str`, `bool` and why `float("2.25")` matters
- [ ] I can format numbers with f-strings
- [ ] I can index and slice a list, and look up values in a dictionary

---

# DAY 2 — Control Flow: Teaching Python to Make Decisions

| Time | Block |
|---|---|
| 0:00 – 0:08 | Warm-up recap |
| 0:08 – 0:38 | 2.1 Comparisons and booleans · 2.2 `if / elif / else` |
| 0:38 – 0:45 | Break |
| 0:45 – 1:23 | 2.3 `for` loops · 2.4 Accumulator patterns · 2.5 Looping over dictionaries |
| 1:23 – 1:38 | 2.6 `while` loops |
| 1:38 – 1:45 | Break |
| 1:45 – 2:05 | 2.7 `break`/`continue` · 2.8 List comprehensions · 2.9 `try/except` |
| 2:05 – 2:25 | 2.10 Day 2 mini-project: Cleaning raw BoC observations |
| 2:25 – 2:30 | Commit and checklist |

### Warm-up (8 min)

Without running it, predict the output. Then run it.

```python
rates = [5.00, 4.75, 4.50]
snapshot = {"rate": rates[-1]}
print(f"{snapshot['rate'] - rates[0]:+.2f}")
```

<details>
<summary>Answer</summary>

`-0.50` — last rate (4.50) minus first (5.00), formatted with a sign.

</details>

```bash
mkdir day02
```

---

## 2.1 Comparisons and Booleans (10 min)

Comparisons produce `True` or `False`.

| Operator | Meaning |
|---|---|
| `==` | equal to (two `=` signs!) |
| `!=` | not equal to |
| `>` `<` | greater / less than |
| `>=` `<=` | greater / less than or equal |

### Example 1 — Simple checks

> **Question it answers:** Is inflation above the 2% target?
>
> **Other questions you can answer the same way:**
> - Is unemployment higher than last month?
> - Is the exchange rate exactly at a given level?

```python
cpi_yoy = 3.0
target = 2.0

print(cpi_yoy > target)       # True
print(cpi_yoy == target)      # False
```

### Example 2 — Combining conditions with `and`, `or`, `not`

> **Question it answers:** Is inflation inside the Bank of Canada's 1–3% control range? Is the yield curve inverted?
>
> **Other questions you can answer the same way:**
> - Is inflation above target AND unemployment below 6%?
> - Is either rate outside its normal range?

The Bank of Canada aims for 2% inflation within a 1–3% control range.

```python
cpi_yoy = 3.0

in_range = cpi_yoy >= 1.0 and cpi_yoy <= 3.0
print("Inside 1–3% range:", in_range)            # True

# Python allows the neater "chained" form:
print("Inside range:", 1.0 <= cpi_yoy <= 3.0)

spread_bp = -45
unemployment_rising = True
warning = spread_bp < 0 or unemployment_rising
print("Recession warning:", warning)             # True
print("Curve NOT inverted:", not spread_bp < 0)  # False
```

---

## 2.2 `if / elif / else` (20 min)

Python uses **indentation** (4 spaces) to show which lines belong to a condition. VS Code inserts them automatically after a colon `:`.

### Example 1 — A single `if`

> **Question it answers:** Is the yield curve inverted, and should I print a warning?
>
> **Other questions you can answer the same way:**
> - Should I flag a month where inflation exceeds 3%?

Create `day02/stance.py`:

```python
spread_bp = 148

if spread_bp < 0:
    print("Yield curve is INVERTED — historically a recession signal.")

print("Check complete.")   # not indented → always runs
```

### Example 2 — `if / else`

> **Question it answers:** Is monetary policy stimulative or restrictive in real terms?
>
> **Other questions you can answer the same way:**
> - Is the economy growing or shrinking this quarter?
> - Is the budget in surplus or in deficit?

```python
real_rate = -0.75

if real_rate < 0:
    print("Real rate is negative: policy is stimulative in real terms.")
else:
    print("Real rate is positive: policy is restrictive in real terms.")
```

### Example 3 — `if / elif / else`: classifying the policy stance

> **Question it answers:** Is the overnight rate below, inside or above the neutral band of 2.25–2.75%?
>
> **Other questions you can answer the same way:**
> - Is inflation below, inside or above the control range?
> - Is unemployment low, normal or high?

The notebook shades a "neutral band" of 2.25–2.75% for the overnight rate.

```python
overnight_rate = 2.25

if overnight_rate < 2.25:
    stance = "Stimulative"
elif overnight_rate <= 2.75:
    stance = "Neutral"
else:
    stance = "Restrictive"

print(f"Overnight rate {overnight_rate:.2f}% → {stance}")
```

> Python checks conditions **top to bottom** and stops at the first `True`. The order of your `elif`s matters.

### Example 4 — Nested conditions: an inflation briefing

> **Question it answers:** Where is inflation relative to the control range, and is core inflation telling a different story?
>
> **Other questions you can answer the same way:**
> - Is inflation high and rising, or high but falling?
> - Which message should today's briefing lead with?

```python
cpi_yoy = 3.0
core_yoy = 2.8

if cpi_yoy > 3.0:
    message = "Above the control range"
elif cpi_yoy < 1.0:
    message = "Below the control range"
else:
    message = "Within the control range"
    if core_yoy > 2.5:
        message += ", but core inflation is elevated"

print(message)
```

`message += "..."` is shorthand for `message = message + "..."`.

### Try it 2.2

Write code that classifies the unemployment rate:
below 5.5 → "Tight", 5.5–7.0 → "Balanced", above 7.0 → "Slack". Test it with 6.4, 5.0, and 8.1.

<details>
<summary>Solution</summary>

```python
unemployment = 6.4   # change this value to test

if unemployment < 5.5:
    labour_market = "Tight"
elif unemployment <= 7.0:
    labour_market = "Balanced"
else:
    labour_market = "Slack"

print(f"Unemployment {unemployment}% → {labour_market}")
```

</details>

---

## 2.3 `for` Loops (20 min)

A `for` loop repeats code for each item in a collection. Economists constantly do "the same calculation for each period" — that's a loop.

Create `day02/loops.py`.

### Example 1 — Looping over values

> **Question it answers:** What were the policy rates at each 2024 decision, printed one per line?
>
> **Other questions you can answer the same way:**
> - How do I print every value in a series?

```python
rates_2024 = [4.75, 4.50, 4.25, 3.75, 3.25]

for rate in rates_2024:
    print(f"Policy rate: {rate:.2f}%")
```

### Example 2 — Looping with positions: `enumerate`

> **Question it answers:** What was the rate at the 1st, 2nd, 3rd… decision of the year?
>
> **Other questions you can answer the same way:**
> - What is the position of each observation in a series?

```python
for position, rate in enumerate(rates_2024):
    print(f"Decision {position + 1}: {rate:.2f}%")
```

### Example 3 — Pairing dates and values: `zip`

> **Question it answers:** What rate did the Bank set on each 2024 decision date?
>
> **Other questions you can answer the same way:**
> - How do I print each month next to its CPI value?

```python
dates = ["2024-06-05", "2024-07-24", "2024-09-04", "2024-10-23", "2024-12-11"]

for date, rate in zip(dates, rates_2024):
    print(f"{date}: {rate:.2f}%")
```

### Example 4 — Period-over-period changes with `range`

> **Question it answers:** What was month-over-month CPI inflation for each month?
>
> **Other questions you can answer the same way:**
> - How much did GDP grow each quarter?
> - How did unemployment change month to month?

To compare each value with the previous one we need positions. `range(1, n)` produces 1, 2, …, n−1.

```python
# Illustrative monthly CPI index levels
cpi = [161.3, 161.8, 162.4, 162.6, 163.0, 163.4,
       163.9, 164.0, 163.7, 164.1, 164.3, 164.2]

for i in range(1, len(cpi)):
    mom = (cpi[i] / cpi[i - 1] - 1) * 100
    print(f"Month {i + 1}: {mom:+.2f}% m/m")
```

> This is exactly what pandas' `pct_change()` does in the notebook. On Days 4–7 you'll replace this loop with one line — but now you know what it's doing.

### Example 5 — Building a new list inside a loop

> **Question it answers:** By how many basis points did the rate change at each decision?
>
> **Other questions you can answer the same way:**
> - How do I build a list of monthly changes to analyse later?

```python
changes_bp = []                       # start with an empty list

for i in range(1, len(rates_2024)):
    change = (rates_2024[i] - rates_2024[i - 1]) * 100
    changes_bp.append(change)

print(changes_bp)                     # [-25.0, -25.0, -50.0, -50.0]
```

---

## 2.4 Accumulator Patterns (10 min)

Many statistics follow one pattern: *start with a value, update it inside the loop*.

### Example 1 — Counting months above target

> **Question it answers:** In how many months was inflation above the 2% target?
>
> **Other questions you can answer the same way:**
> - How many quarters had negative growth?
> - How many decisions were cuts?

```python
cpi_yoy_series = [2.9, 2.6, 2.4, 2.1, 1.9, 2.0, 2.3, 2.5, 3.1, 3.0]

months_above = 0
for value in cpi_yoy_series:
    if value > 2.0:
        months_above += 1

print(f"{months_above} of {len(cpi_yoy_series)} months above target")
```

### Example 2 — Tracking the peak (running maximum)

> **Question it answers:** What was the peak policy rate in the cycle?
>
> **Other questions you can answer the same way:**
> - What was the highest unemployment rate since 2020?
> - When did inflation peak?

```python
decisions = [0.50, 1.00, 1.50, 2.50, 3.25, 3.75, 4.25, 4.75, 5.00, 4.75]

peak = decisions[0]
for rate in decisions:
    if rate > peak:
        peak = rate

print(f"Peak policy rate: {peak:.2f}%")    # same answer as max(decisions)
```

### Example 3 — Cumulative change

> **Question it answers:** How many basis points of tightening had accumulated after each 2022 hike?
>
> **Other questions you can answer the same way:**
> - How many jobs were added in total over the year?
> - How much did prices rise cumulatively?

```python
changes_bp = [25, 50, 50, 100, 75, 50, 50]   # 2022 hikes

cumulative = 0
for change in changes_bp:
    cumulative += change
    print(f"After this hike: +{cumulative} bp cumulative")
```

---

## 2.5 Looping Over Dictionaries (8 min)

> **Question it answers:** How do I print every indicator in my snapshot with its value, neatly aligned?
>
> **Other questions you can answer the same way:**
> - How do I produce a small table of all indicators?

Use `.items()` to get key and value together.

```python
snapshot = {
    "overnight_rate": 2.25,
    "cpi_yoy": 3.0,
    "unemployment": 6.4,
}

for indicator, value in snapshot.items():
    print(f"{indicator:<16} {value:>6.2f}")
```

### Example — Tariff exposure (from the notebook's `TARIFF_STATUS`)

> **Question it answers:** Which sectors face tariffs, and what is the total and average tariff rate across them?
>
> **Other questions you can answer the same way:**
> - Which sectors face tariffs above 10%?
> - Which province is most exposed to a given shock?

```python
tariff_exposure = {
    "Automotive (non-CUSMA)": 40,
    "Lumber & wood": 8,
    "Dairy (non-TRQ)": 1.5,
    "Consumer goods (List 3)": 22,
    "Energy": 0,
}

total = 0
for sector, exposure in tariff_exposure.items():
    if exposure > 0:
        print(f"TARIFFED  {sector}: ${exposure}B")
        total += exposure
    else:
        print(f"EXEMPT    {sector}")

print(f"Total exposure: ${total}B")     # $71.5B, matching the notebook KPI
```

---

## 2.6 `while` Loops (15 min)

A `while` loop repeats *as long as a condition is true*. Use it when you don't know in advance how many repetitions you need.

### Example 1 — How many years for GDP to double?

> **Question it answers:** At 2% growth a year, how many years does it take for output to double?
>
> **Other questions you can answer the same way:**
> - How long until prices double at 3% inflation?
> - How long until debt reaches a target level?

```python
growth = 0.02
level = 100.0
years = 0

while level < 200.0:
    level = level * (1 + growth)
    years += 1

print(f"At {growth:.0%} growth, output doubles in {years} years")
print(f"Rule of 70 estimate: {70 / (growth * 100):.0f} years")
```

Output: the loop gives 36 years; the rule of 70 gives 35. (After 35 years the level is 199.99 — just short!)

### Example 2 — How many 25bp cuts to reach neutral?

> **Question it answers:** Starting at 5%, how many 25-basis-point cuts does it take to reach the 2.75% neutral rate?
>
> **Other questions you can answer the same way:**
> - How many hikes would take the rate back to 4%?
> - How many months until inflation returns to target at a given pace?

```python
rate = 5.00
cuts = 0

while rate > 2.75:
    rate -= 0.25
    cuts += 1

print(f"{cuts} cuts of 25bp take the rate to {rate:.2f}%")
```

> **Danger — infinite loops:** if the condition never becomes `False`, the loop runs forever. Press `Ctrl+C` in the terminal to stop it. Always check that something inside the loop moves you toward the exit.

### Try it 2.6

Canada's inflation is 3.0% and falls by 0.2 pp each month. Use a `while` loop to find how many months until it reaches 2.0% or below.

<details>
<summary>Solution</summary>

```python
inflation = 3.0
months = 0

while inflation > 2.0:
    inflation -= 0.2
    months += 1

print(f"{months} months; inflation ends at {inflation:.1f}%")
```

You might expect 5 months but get 6 — floating-point strikes again (`3.0 - 5×0.2` is `2.0000000000000004`, still > 2.0). A safer condition is `while round(inflation, 4) > 2.0:`. This is a real-world lesson: be careful with exact thresholds on decimals.

</details>

---

## 2.7 `break` and `continue` (5 min)

- `continue` → skip the rest of this iteration and move to the next item
- `break` → exit the loop entirely

### Example — Skipping missing values (just like the notebook)

> **Question it answers:** How do I keep only the valid numbers, skipping "Bank holiday", "NA" and blanks?
>
> **Other questions you can answer the same way:**
> - How many usable observations does a raw download contain?

The notebook's `boc_fetch` skips values like `""`, `"NA"`, and `"Bank holiday"`. Here's the same logic in plain Python:

```python
raw_values = ["2.25", "2.25", "Bank holiday", "2.25", "", "NA", "2.25"]

clean = []
for v in raw_values:
    if v in ("", "NA", "Bank holiday"):
        continue                     # skip this one
    clean.append(float(v))

print(clean)                         # [2.25, 2.25, 2.25, 2.25]
```

### Example — Finding the first inversion

> **Question it answers:** In which month did the yield curve first invert?
>
> **Other questions you can answer the same way:**
> - When did inflation first exceed 3%?
> - When did unemployment first rise above 7%?

```python
spreads_bp = [85, 60, 32, 10, -5, -40, -90]
months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"]

for month, spread in zip(months, spreads_bp):
    if spread < 0:
        print(f"Curve first inverted in {month} ({spread} bp)")
        break
```

---

## 2.8 List Comprehensions — a Gentle Introduction (5 min)

> **Question it answers:** How do I convert a whole list of rates to basis points, or keep only those that pass a test, in one line?
>
> **Other questions you can answer the same way:**
> - Which months had inflation above target (as a list)?
> - How do I convert every value in a list to another unit?

A compact way to build a list from a loop. These two blocks are identical:

```python
rates = [4.75, 4.50, 4.25, 3.75, 3.25]

# Long form
rates_bp = []
for r in rates:
    rates_bp.append(r * 100)

# Comprehension
rates_bp = [r * 100 for r in rates]
print(rates_bp)
```

With a filter:

```python
cpi_yoy_series = [2.9, 2.6, 2.4, 2.1, 1.9, 2.0, 2.3, 2.5, 3.1, 3.0]
above_target = [x for x in cpi_yoy_series if x > 2.0]
print(above_target)
```

> Use comprehensions for **simple** transformations. If it doesn't fit comfortably on one line, write a normal loop — readability wins.

---

## 2.9 Handling Errors with `try / except` (10 min)

> **Question it answers:** How do I convert messy text values to numbers and report the ones that fail, without the program crashing?
>
> **Other questions you can answer the same way:**
> - Which values in a download could not be read?
> - How do I keep a script running when one value is bad?

Real data is messy. Rather than listing every bad value, we can *try* the conversion and handle failure.

```python
raw_values = ["2.25", "n/a", "2.50", "--", "2.75"]

clean = []
for v in raw_values:
    try:
        clean.append(float(v))
    except ValueError:
        print(f"  Skipped unreadable value: {v!r}")

print(clean)     # [2.25, 2.5, 2.75]
```

`{v!r}` shows the value with quotes, so you can spot empty strings or stray spaces.

> **Good habit:** catch the *specific* error (`ValueError`), not everything. The notebook's `except Exception as e` is a broader net used so one failed series doesn't stop the whole pipeline — a deliberate design choice we'll revisit with Prefect retries on Days 54–57.

---

## 2.10 Day 2 Mini-Project: Cleaning Raw BoC Observations (20 min)

> **Question it answers:** From a raw Bank of Canada response, what are the valid dates and rates, how many were skipped, and what is the latest rate?
>
> **Other questions you can answer the same way:**
> - How many bank holidays or blanks were in the download?
> - What was the average rate over the valid days?

The Bank of Canada Valet API returns a list of dictionaries shaped like this. (We'll fetch the real thing on Day 3.)

Create `day02/clean_boc.py` and start with this data:

```python
# Mimics the structure of the BoC Valet API response for series V39079
observations = [
    {"d": "2025-12-01", "V39079": {"v": "2.25"}},
    {"d": "2025-12-02", "V39079": {"v": "2.25"}},
    {"d": "2025-12-25", "V39079": {"v": "Bank holiday"}},
    {"d": "2026-01-02", "V39079": {"v": ""}},
    {"d": "2026-01-05", "V39079": {"v": "2.25"}},
    {"d": "2026-01-06", "V39079": {"v": "NA"}},
    {"d": "2026-01-07", "V39079": {"v": "2.25"}},
]
```

**Tasks:**
1. Loop through the observations. For each, pull out the date (`"d"`) and the value (`obs["V39079"]["v"]`).
2. Skip unusable values with `try/except`.
3. Store clean pairs in two lists: `dates` and `values`.
4. Print how many observations were kept vs dropped.
5. Print the latest date and value, and classify the stance using your Day 2 `if/elif/else` logic.

<details>
<summary>Solution</summary>

```python
series = "V39079"

dates = []
values = []
dropped = 0

for obs in observations:
    date = obs["d"]
    raw = obs[series]["v"]
    try:
        value = float(raw)
    except ValueError:
        dropped += 1
        continue
    dates.append(date)
    values.append(value)

print(f"Kept {len(values)} observations, dropped {dropped}")

latest_date = dates[-1]
latest_rate = values[-1]

if latest_rate < 2.25:
    stance = "Stimulative"
elif latest_rate <= 2.75:
    stance = "Neutral"
else:
    stance = "Restrictive"

print(f"Latest ({latest_date}): {latest_rate:.2f}% → {stance}")
```

Output: `Kept 4 observations, dropped 3` and `Latest (2026-01-07): 2.25% → Neutral`.

Compare this with `boc_fetch` in the course notebook — you have just written its core logic by hand.

</details>

**Stretch:** some observations might be missing the series key entirely. Use `obs.get(series, {}).get("v", "")` to handle that safely (this is exactly what the notebook does).

### Day 2 checklist
- [ ] I can write `if / elif / else` blocks with correct indentation
- [ ] I can loop over lists, pairs (`zip`), positions (`enumerate`), and dictionaries (`.items()`)
- [ ] I can compute period-over-period changes with `range`
- [ ] I know when to use `while` and how to escape an infinite loop
- [ ] I can skip bad data with `continue` and `try/except`

```bash
git add .
git commit -m "Day 2: control flow and BoC cleaning"
git push
```

---

# DAY 3 — Functions, Modules & Virtual Environments

| Time | Block |
|---|---|
| 0:00 – 0:05 | Warm-up |
| 0:05 – 0:40 | 3.1 Why functions · 3.2 Parameters and defaults · 3.3 Docstrings and type hints |
| 0:40 – 0:48 | Break |
| 0:48 – 1:15 | 3.4 Return values · 3.5 Functions on time series · 3.6 Scope |
| 1:15 – 1:38 | 3.7 Modules: your own `macrotools.py` |
| 1:38 – 1:45 | Break |
| 1:45 – 2:08 | 3.8 Virtual environments (`.venv`) and packages |
| 2:08 – 2:25 | 3.9 Capstone: live Bank of Canada data |
| 2:25 – 2:30 | 3.10 Commit and checklist |

### Warm-up (5 min)

Yesterday you wrote the stance classification three times. Copy-pasting code means that if the neutral band changes, you must fix it everywhere. **Functions solve this.**

```bash
mkdir day03
```

---

## 3.1 Why Functions? (10 min)

A **function** is a named, reusable piece of logic — like `f(x)` in economics. It takes inputs (*arguments*) and gives back an output (*return value*).

### Example 1 — Your first function

> **Question it answers:** What is the real rate for any pair of nominal rate and inflation, without rewriting the formula each time?
>
> **Other questions you can answer the same way:**
> - What is the real rate in each year of a list?

```python
def real_rate(nominal, inflation):
    return nominal - inflation

print(real_rate(2.25, 3.0))     # -0.75
print(real_rate(5.00, 3.8))     # 1.2
```

Anatomy: `def` + name + `(parameters)` + colon; indented body; `return` sends the result back.

### Example 2 — Replacing repeated code

> **Question it answers:** What is the policy stance for any rate I give it, using one shared rule?
>
> **Other questions you can answer the same way:**
> - How do I classify every rate in a list with the same logic?

```python
def classify_stance(rate):
    if rate < 2.25:
        return "Stimulative"
    elif rate <= 2.75:
        return "Neutral"
    else:
        return "Restrictive"

for r in [0.25, 2.50, 5.00]:
    print(f"{r:.2f}% → {classify_stance(r)}")
```

---

## 3.2 Parameters and Defaults (13 min)

### Example 1 — Default values

> **Question it answers:** What is the real rate using the quick approximation by default, or the exact Fisher formula when I ask for it?
>
> **Other questions you can answer the same way:**
> - How do I give a function a sensible default while keeping options open?

Parameters can have defaults, used when the caller doesn't supply a value.

```python
def real_rate(nominal, inflation, method="approx"):
    if method == "exact":
        return ((1 + nominal / 100) / (1 + inflation / 100) - 1) * 100
    return nominal - inflation

print(real_rate(2.25, 3.0))                  # -0.75 (default)
print(real_rate(2.25, 3.0, method="exact"))  # -0.728...
```

### Example 2 — Keyword arguments make calls readable

> **Question it answers:** What is the annualised rate of quarterly or monthly growth, compounded or simple?
>
> **Other questions you can answer the same way:**
> - What annual rate does 0.25% monthly growth imply?

```python
def annualise(growth, periods_per_year=4, compound=True):
    if compound:
        return ((1 + growth / 100) ** periods_per_year - 1) * 100
    return growth * periods_per_year

print(annualise(0.8))                         # quarterly, compounded
print(annualise(0.8, compound=False))         # the notebook's ×4 shortcut
print(annualise(0.25, periods_per_year=12))   # monthly growth
```

### Example 3 — Making the neutral band adjustable

> **Question it answers:** How would the stance classification change if the neutral band were 2.75–3.25% instead?
>
> **Other questions you can answer the same way:**
> - How sensitive is my classification to the threshold I choose?

```python
def classify_stance(rate, neutral_low=2.25, neutral_high=2.75):
    if rate < neutral_low:
        return "Stimulative"
    elif rate <= neutral_high:
        return "Neutral"
    return "Restrictive"

print(classify_stance(2.50))                                    # Neutral
print(classify_stance(2.50, neutral_low=2.75, neutral_high=3.25))  # Stimulative
```

Now if the Bank of Canada revises its neutral-rate estimate, you change one argument.

---

## 3.3 Docstrings and Type Hints (13 min)

> **Question it answers:** How do I document what a function needs and returns so a colleague can use it correctly?
>
> **Other questions you can answer the same way:**
> - What does pct_change expect as inputs, and what does it return?

Professional code explains itself. A **docstring** (triple-quoted text right after `def`) describes the function; **type hints** state expected input and output types.

```python
def pct_change(new: float, old: float) -> float:
    """Percentage change from old to new.

    Args:
        new: The later value (e.g. this month's CPI level).
        old: The earlier value (e.g. last year's CPI level).

    Returns:
        Percentage change, e.g. 3.0 for a 3% increase.
    """
    return (new / old - 1) * 100


print(pct_change(169.0, 164.1))
help(pct_change)        # shows your docstring
```

In VS Code, hover over `pct_change` anywhere — your docstring pops up. Type hints don't enforce anything at runtime, but they help VS Code catch mistakes and help readers understand your code.

### Try it 3.3

Write a documented, type-hinted function `spread_bp(long_yield, short_yield)` that returns the spread in basis points. Test it with 3.75 and 2.27.

<details>
<summary>Solution</summary>

```python
def spread_bp(long_yield: float, short_yield: float) -> float:
    """Term spread in basis points.

    Args:
        long_yield: Long-maturity yield in % (e.g. 10-year).
        short_yield: Short-maturity yield in % (e.g. 2-year).

    Returns:
        Spread in basis points (positive = normal curve).
    """
    return (long_yield - short_yield) * 100


print(f"{spread_bp(3.75, 2.27):.0f} bp")    # 148 bp
```

</details>

---

## 3.4 Return Values: Common Pitfalls and Multiple Outputs (10 min)

### Pitfall — `print` is not `return`

> **Question it answers:** Why is my function's result "None" when I try to use it in a calculation?
>
> **Other questions you can answer the same way:**
> - Why can't I add the output of my function to another number?

```python
def bad_real_rate(nominal, inflation):
    print(nominal - inflation)          # displays, but returns nothing

result = bad_real_rate(2.25, 3.0)       # prints -0.75
print(result)                            # None!  Can't use it in further math
```

> **Rule:** functions should `return` values. Let the *caller* decide whether to print.

### Returning several values

> **Question it answers:** What are the minimum, maximum and mean of a series, from a single function call?
>
> **Other questions you can answer the same way:**
> - What is the range and average of inflation over the last five months?

```python
def summarise(values):
    """Return min, max and mean of a list of numbers."""
    mean = sum(values) / len(values)
    return min(values), max(values), mean

low, high, avg = summarise([2.9, 2.6, 2.4, 2.1, 1.9])
print(f"Range {low}–{high}, mean {avg:.2f}")
```

Returning a dictionary is often clearer:

```python
def summarise(values):
    return {
        "n": len(values),
        "min": min(values),
        "max": max(values),
        "mean": sum(values) / len(values),
    }

stats = summarise([2.9, 2.6, 2.4, 2.1, 1.9])
print(stats["mean"])
```

---

## 3.5 Functions on Time Series (13 min)

Let's wrap Day 2's loops in functions.

### Example 1 — Year-over-year changes

> **Question it answers:** What was year-over-year inflation for each month, from a list of CPI levels?
>
> **Other questions you can answer the same way:**
> - What is year-over-year growth in employment or wages?

```python
def yoy_changes(levels, lag=12):
    """Percentage change versus `lag` periods earlier.

    With monthly data and lag=12 this is year-over-year inflation.
    The first `lag` periods have no comparison and are skipped.
    """
    changes = []
    for i in range(lag, len(levels)):
        changes.append(pct_change(levels[i], levels[i - lag]))
    return changes


# Illustrative: 15 months of CPI levels
cpi = [158.9, 159.5, 160.1, 160.4, 160.8, 161.2, 161.5, 161.6,
       161.4, 161.9, 162.0, 162.1, 163.6, 164.2, 164.9]

print(yoy_changes(cpi))            # 3 YoY values
print(yoy_changes(cpi, lag=1))     # month-over-month instead
```

Notice `yoy_changes` *calls* `pct_change` — small functions combine into bigger ones.

### Example 2 — A moving average

> **Question it answers:** What is the 3-month moving average of housing starts?
>
> **Other questions you can answer the same way:**
> - What is the underlying trend once monthly noise is removed?

```python
def moving_average(values, window=3):
    """Simple trailing moving average."""
    result = []
    for i in range(window - 1, len(values)):
        chunk = values[i - window + 1 : i + 1]
        result.append(sum(chunk) / window)
    return result

housing = [240, 255, 230, 262, 270, 248]    # illustrative, thousands
print(moving_average(housing, window=4))
```

This is what the notebook's `.rolling(4).mean()` does for housing starts.

---

## 3.6 Scope: Where Variables Live (5 min)

Variables created inside a function exist **only** inside it.

```python
def compute():
    temp = 42
    return temp * 2

print(compute())      # 84
print(temp)           # NameError: name 'temp' is not defined
```

> **Good practice:** pass everything a function needs as arguments and get results back via `return`. Avoid relying on variables defined outside the function.

---

## 3.7 Modules: Your Own `macrotools.py` (23 min)

A **module** is simply a `.py` file whose functions you can `import` into other files. This is how the course notebook's code will eventually become a real project.

### Step 1 — Create `day03/macrotools.py`

> **Question it answers:** How do I collect my economic helper functions in one file I can reuse in every script?
>
> **Other questions you can answer the same way:**
> - Where should the real-rate, stance and spread calculations live?

```python
"""macrotools — small, reusable macroeconomic helper functions."""


def pct_change(new: float, old: float) -> float:
    """Percentage change from old to new."""
    return (new / old - 1) * 100


def real_rate(nominal: float, inflation: float, method: str = "approx") -> float:
    """Real interest rate in %. method='approx' (i − π) or 'exact' (Fisher)."""
    if method == "exact":
        return ((1 + nominal / 100) / (1 + inflation / 100) - 1) * 100
    return nominal - inflation


def annualise(growth: float, periods_per_year: int = 4, compound: bool = True) -> float:
    """Annualise a per-period growth rate given in %."""
    if compound:
        return ((1 + growth / 100) ** periods_per_year - 1) * 100
    return growth * periods_per_year


def spread_bp(long_yield: float, short_yield: float) -> float:
    """Term spread in basis points."""
    return (long_yield - short_yield) * 100


def classify_stance(rate: float, neutral_low: float = 2.25,
                    neutral_high: float = 2.75) -> str:
    """Classify the policy rate relative to a neutral band."""
    if rate < neutral_low:
        return "Stimulative"
    elif rate <= neutral_high:
        return "Neutral"
    return "Restrictive"


def yoy_changes(levels: list, lag: int = 12) -> list:
    """Percentage change versus `lag` periods earlier."""
    return [pct_change(levels[i], levels[i - lag]) for i in range(lag, len(levels))]


def clean_observations(observations: list, series: str) -> tuple:
    """Turn raw BoC Valet observations into (dates, values) lists.

    Unusable values ('', 'NA', 'Bank holiday', missing keys) are skipped.
    """
    dates, values = [], []
    for obs in observations:
        raw = obs.get(series, {}).get("v", "")
        try:
            value = float(raw)
        except ValueError:
            continue
        dates.append(obs["d"])
        values.append(value)
    return dates, values


def summarise(values: list) -> dict:
    """Basic descriptive statistics."""
    return {
        "n": len(values),
        "min": min(values),
        "max": max(values),
        "mean": sum(values) / len(values),
    }


# ── Self-tests: run only when this file is executed directly ──────────────
if __name__ == "__main__":
    assert real_rate(2.25, 3.0) == -0.75
    assert classify_stance(2.50) == "Neutral"
    assert classify_stance(5.00) == "Restrictive"
    assert round(spread_bp(3.75, 2.27)) == 148
    assert round(annualise(0.8, compound=False), 1) == 3.2

    sample = [{"d": "2026-01-05", "V39079": {"v": "2.25"}},
              {"d": "2026-01-06", "V39079": {"v": "NA"}}]
    assert clean_observations(sample, "V39079") == (["2026-01-05"], [2.25])

    print("✓ All macrotools self-tests passed")
```

Run it:

```bash
python day03/macrotools.py
```

> **Two new ideas:**
> - `assert condition` crashes loudly if the condition is `False`. It's the simplest form of **testing** — a first taste of the data-quality contracts you'll build with Great Expectations on Days 41–50.
> - `if __name__ == "__main__":` means "run this block only when the file is executed directly, not when imported."

### Step 2 — Use it from another file: `day03/analysis.py`

> **Question it answers:** What are today's real rate, policy stance and yield spread, using my own reusable toolkit?
>
> **Other questions you can answer the same way:**
> - How do I reuse my functions in a new analysis without copying them?

```python
from macrotools import real_rate, classify_stance, spread_bp, summarise

overnight = 2.25
cpi_yoy = 3.0

print(f"Real rate (approx): {real_rate(overnight, cpi_yoy):+.2f}%")
print(f"Real rate (exact):  {real_rate(overnight, cpi_yoy, method='exact'):+.2f}%")
print(f"Stance: {classify_stance(overnight)}")
print(f"10y-2y spread: {spread_bp(3.75, 2.27):.0f} bp")

rates_2024 = [4.75, 4.50, 4.25, 3.75, 3.25]
print(summarise(rates_2024))
```

Run from inside the folder so Python can find `macrotools.py`:

```bash
cd day03
python analysis.py
cd ..
```

Note that the self-tests did **not** run — that's `__name__ == "__main__"` doing its job.

### Try it 3.7

Add a function `fisher_gap(nominal, inflation)` to `macrotools.py` that returns the difference between the approximate and exact real rates. Add an `assert` for it, then use it in `analysis.py`.

<details>
<summary>Solution</summary>

```python
# In macrotools.py
def fisher_gap(nominal: float, inflation: float) -> float:
    """Approximate minus exact real rate, in percentage points."""
    return real_rate(nominal, inflation) - real_rate(nominal, inflation, method="exact")

# In the self-test block
    assert abs(fisher_gap(2.25, 3.0)) < 0.1

# In analysis.py
from macrotools import fisher_gap
print(f"Fisher gap: {fisher_gap(2.25, 3.0):.3f} pp")
```

</details>

---

## 3.8 Virtual Environments and Packages (23 min)

### Why?

Python's power comes from **packages** others have written: `requests` (web APIs), `pandas` (data frames), `dlt`, `dbt`, `prefect`… Different projects need different versions. A **virtual environment** is a private, project-specific set of packages so projects don't interfere with each other — and so your colleagues can recreate your exact setup.

Think of it as a replication package for your code environment.

### Step 1 — Create the environment (at the repository root)

```bash
cd /workspaces/macro-data-course
python -m venv .venv
```

This creates a hidden `.venv` folder containing its own copy of Python.

### Step 2 — Activate it

```bash
source .venv/bin/activate
```

Your prompt now starts with `(.venv)`. Confirm Python is coming from the environment:

```bash
which python
# /workspaces/macro-data-course/.venv/bin/python
```

> You must activate the environment **every time you open a new terminal**. If your prompt doesn't show `(.venv)`, you're not in it.

### Step 3 — Tell VS Code to use it

Press `Ctrl+Shift+P` → **Python: Select Interpreter** → choose the one with `.venv`. VS Code will now use it for the Run button and new terminals.

### Step 4 — Install a package

```bash
pip install requests
pip list
```

### Step 5 — Record your dependencies

```bash
pip freeze > requirements.txt
cat requirements.txt
```

`requirements.txt` lists every package and its exact version. **This file gets committed; the `.venv` folder does not.**

### Step 6 — Keep `.venv` out of Git

Create a file called `.gitignore` at the repository root:

```
.venv/
__pycache__/
*.pyc
```

### Step 7 — Prove you can rebuild it

This is what a colleague (or your future self) will do:

```bash
deactivate
rm -rf .venv
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Quick reference

| Command | Purpose |
|---|---|
| `python -m venv .venv` | Create environment |
| `source .venv/bin/activate` | Activate it |
| `deactivate` | Leave it |
| `pip install <package>` | Install a package |
| `pip freeze > requirements.txt` | Save exact versions |
| `pip install -r requirements.txt` | Recreate from the list |

---

## 3.9 Capstone: Live Bank of Canada Data (18 min)

> **Question it answers:** What is the latest overnight rate from the Bank of Canada's live API, how did it move over the last 30 days, and what stance does it imply?
>
> **Other questions you can answer the same way:**
> - What is today's 2-year yield?
> - What was the average exchange rate over the last month?

Time to replace hard-coded numbers with a live API call — using the module you wrote.

Create `day03/fetch_boc.py`:

```python
"""Fetch the latest BoC overnight rate and summarise it with macrotools."""

import requests
from macrotools import clean_observations, summarise, classify_stance

SERIES = "V39079"   # BoC target for the overnight rate
URL = f"https://www.bankofcanada.ca/valet/observations/{SERIES}/json?recent=30"

response = requests.get(URL, timeout=20)
response.raise_for_status()          # stop with a clear error if the request failed

data = response.json()               # convert the JSON text into Python dicts/lists
observations = data["observations"]

print(f"Received {len(observations)} raw observations")

dates, values = clean_observations(observations, SERIES)
stats = summarise(values)

print(f"Clean observations: {stats['n']}")
print(f"Period: {dates[0]} → {dates[-1]}")
print(f"Latest overnight rate: {values[-1]:.2f}%")
print(f"Range over period: {stats['min']:.2f}% – {stats['max']:.2f}%")
print(f"Stance: {classify_stance(values[-1])}")
```

Run it (environment active):

```bash
cd day03
python fetch_boc.py
cd ..
```

**Explore the raw response.** Add these lines temporarily to see what the API actually sends:

```python
print(data.keys())
print(observations[0])
```

You'll see the same `{"d": ..., "V39079": {"v": ...}}` shape you cleaned by hand on Day 2.

### Try it 3.9

Change `SERIES` to `"FXCADUSD"` (the CAD/USD exchange rate). Print the latest USD/CAD (`1 / value`). Which function in `macrotools.py` would you reuse, and which line would break?

<details>
<summary>Solution</summary>

`clean_observations` and `summarise` work unchanged because they take the series code as an argument. `classify_stance` makes no sense for an exchange rate — remove that line and add:

```python
print(f"Latest USD/CAD: {1 / values[-1]:.4f}")
```

This is the payoff of functions: the cleaning logic works for *any* Valet series.

</details>

**Stretch:** if the request fails (try disconnecting by using a misspelled URL), wrap the call in `try/except requests.RequestException` and print a friendly message instead of a crash.

---

## 3.10 Commit and Wrap-up (5 min)

```bash
git add .
git commit -m "Day 3: functions, macrotools module, venv, live BoC fetch"
git push
```

Check on GitHub that `requirements.txt` and `.gitignore` are present and `.venv` is **not**.

### Day 3 checklist
- [ ] I can write functions with parameters, defaults, docstrings and type hints
- [ ] I understand why functions should `return` rather than `print`
- [ ] I can import functions from my own module
- [ ] I can use `assert` for simple self-tests
- [ ] I can create, activate, and rebuild a `.venv` from `requirements.txt`
- [ ] I fetched live data from the Bank of Canada Valet API

---

## Looking Ahead to Days 4–7

Everything you did with lists and loops, `pandas` will do in single lines:

| Days 1–3 (plain Python) | Days 4–7 (pandas) |
|---|---|
| `yoy_changes(cpi, lag=12)` | `df["cpi"].pct_change(12) * 100` |
| `moving_average(x, window=4)` | `df["x"].rolling(4).mean()` |
| `clean_observations(...)` | `pd.to_numeric(..., errors="coerce").dropna()` |
| Two lists: `dates`, `values` | One `DataFrame` with a `DatetimeIndex` |

Because you built these by hand, you'll know exactly what pandas is doing under the hood.
