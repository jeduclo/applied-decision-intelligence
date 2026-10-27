# Module 7 · Forecasting with XGBoost & Chronos
## Days 68–70: Forecasting Canadian CPI and Real GDP Growth with the Platform's Engineered Features

**Audience:** MSc Economics students who completed Days 1–67
**Environment:** GitHub Codespaces · `.venv-ml` (models) · `.venv` (Prefect, dbt) · `.venv-gx` · marts in `data/marts/*.parquet`
**Time per day:** ~5 hours (including breaks and exercises)
**Goal by end of Day 70:**
- **Day 68.** Students forecast **CPI inflation** with **multivariate features** drawn from the marts built in Modules 2–4 (rates, spreads, FX, oil, labour market, core and breadth measures), respecting each indicator's **publication lag**.
- **Day 69.** They **nowcast and forecast real GDP growth** from monthly indicators with a "ragged edge" and handle the COVID outliers honestly.
- **Day 70.** They put the forecasting system **into production** inside the Prefect pipeline: published forecasts with metadata, dbt marts that track **live accuracy**, GX checks on forecasts, monitoring for out-of-range inputs, a model card, and a forecast dashboard.

---

### Where we are

From Days 61–67 you have a rigorous **univariate** toolkit: a leak-free rolling-origin harness, benchmarks, XGBoost (default and tuned), AR(AIC), Chronos zero-shot, combinations, Diebold–Mariano tests, quantile intervals and SHAP explanations. `forecasting/MODEL_DECISIONS.md` records which models to carry forward.

The curriculum's goal for this module: **forecast Canadian CPI and real GDP growth using the historical features engineered in earlier modules.** That means three new challenges:

| Challenge | Why it matters | Day |
|---|---|---|
| **More information** | do rates, FX, oil and labour data improve on inflation's own history? | 68 |
| **What was known when** | each indicator is published with its own delay, and GDP is revised | 68–69 |
| **Mixed frequencies** | GDP is quarterly; most indicators are monthly or daily | 69 |
| **Production** | forecasts must be reproducible, monitored and honest about their track record | 70 |

### Target structure (by end of Day 70)

```
forecasting/
├── feature_spec_cpi.yml        ← NEW: reviewed list of predictors, lags, transforms, families
├── feature_spec_gdp.yml        ← NEW
├── availability.py             ← NEW: publication-lag-aware feature builder
├── nowcast.py                  ← NEW: ragged-edge GDP dataset and evaluation
├── monitoring.py               ← NEW: out-of-range inputs, live accuracy helpers
├── run_forecasts.py            ← NEW: production CLI (exit codes 0/1/2)
├── MODEL_CARD.md               ← NEW
└── …                           (Days 61–67 modules)
macro_dbt/models/
├── marts/ml/ml_gdp_quarterly.sql           ← NEW
└── marts/forecasts/                        ← NEW: fct_forecasts, forecast_latest, forecast_accuracy
quality/specs/forecast_latest.yml           ← NEW: GX checks on published forecasts
orchestration/flows/forecast.py             ← NEW: the forecast subflow
data/forecasts/published/run_*.parquet      ← NEW: every published forecast, with metadata
```

---

# DAY 68 — Multivariate CPI Forecasting with Real-Time Information Sets

| Time | Block |
|---|---|
| 0:00 – 0:40 | 68.1 Which indicators should help forecast inflation? |
| 0:40 – 1:40 | 68.2 Publication lags: building features only from what was known |
| 1:40 – 1:55 | Break |
| 1:55 – 2:30 | 68.3 Revisions and vintages: how "real-time" is our backtest? |
| 2:30 – 3:20 | 68.4 Multivariate models in the harness |
| 3:20 – 3:35 | Break |
| 3:35 – 4:15 | 68.5 Did the extra information help? Tests and explanations |
| 4:15 – 5:00 | 68.6 Mini-project: an ablation study by feature family |

---

## 68.1 Which Indicators Should Help Forecast Inflation? (40 min)

Before throwing every column at a model, write down **why** each candidate might help. Economic reasoning narrows the search and makes results interpretable. All of these already exist in your marts (Days 19, 20, 39):

| Family | Indicator (mart column) | Economic rationale |
|---|---|---|
| **persistence** | CPI yoy lags, moving averages | inflation is persistent (Days 61–63) |
| **core & breadth** | `core_ex_fe_yoy`, `median_major_yoy`, `diffusion_above_3` | underlying inflation and how broad-based it is (Day 19) |
| **labour market** | `unemployment_rate` and its 12-month change | Phillips-curve slack: tight labour markets push wages and prices up |
| **monetary & financial** | `overnight_rate`, `real_rate`, `spread_10_2_bp` | policy stance, financial conditions, cycle expectations |
| **external** | `usd_cad` (% change), `wti` (% change), `ca_us_2y_spread_bp` | exchange-rate pass-through to import prices; energy prices; global rates |
| **cycle** | `oecd_cli` | leading indicator of activity |

> **Expect humility.** Atkeson and Ohanian (2001) found that Phillips-curve forecasts often failed to beat a naive benchmark for US inflation, and Stock and Watson (2007) documented how inflation became harder to forecast after the mid-1980s. Your multivariate model must **earn** its complexity against Day 63's univariate leaderboard.

---

## 68.2 Publication Lags: Building Features Only from What Was Known (60 min)

### The real-time information set

Our forecast origin is **"just after CPI for month *t* is published"**, usually in the third week of month *t+1*. At that moment, what else is known?

| Indicator | Published | Latest month known at origin *t* | Lag (months) |
|---|---|---|---|
| CPI and its components | ~3rd week of *t+1* | *t* | 0 |
| BoC rates, bond yields, USD/CAD | daily | *t* (and part of *t+1*) | 0 |
| WTI (FRED) | daily, next business day | *t* | 0 |
| Unemployment rate (LFS) | early in *t+1* | *t* | 0 |
| OECD composite leading indicator | about 1–2 months after the reference month | *t − 2* (conservative) | 2 |

Using the OECD CLI for month *t* at origin *t* would be a **look-ahead leak**: in reality it wasn't published yet. Each feature needs an explicit **availability lag**.

### A reviewed feature specification

Like quality specs (Day 44) and seeds (Day 32), features belong in a **reviewed configuration file**. Create `forecasting/feature_spec_cpi.yml`:

```yaml
# Predictors for CPI inflation (target: cpi_yoy, direct horizons).
# lag = months between the origin month and the latest month published at the origin.
target: cpi_yoy
origin: "just after CPI for month t is published (~3rd week of t+1)"

features:
  - {name: core_yoy,     column: core_ex_fe_yoy,     lag: 0, transforms: [level],          family: core}
  - {name: median_major, column: median_major_yoy,   lag: 0, transforms: [level],          family: core}
  - {name: diffusion,    column: diffusion_above_3,  lag: 0, transforms: [level],          family: core}
  - {name: unemp,        column: unemployment_rate,  lag: 0, transforms: [level, diff12],  family: labour}
  - {name: overnight,    column: overnight_rate,     lag: 0, transforms: [level, diff12],  family: monetary}
  - {name: real_rate,    column: real_rate,          lag: 0, transforms: [level],          family: monetary}
  - {name: slope,        column: spread_10_2_bp,     lag: 0, transforms: [level],          family: financial}
  - {name: usd_cad,      column: usd_cad_eom,        lag: 0, transforms: [pct12, pct3],    family: external}
  - {name: wti,          column: wti_eom,            lag: 0, transforms: [pct12, pct3],    family: external}
  - {name: ca_us_2y,     column: ca_us_2y_spread_bp_avg, lag: 0, transforms: [level],      family: external}
  - {name: oecd_cli,     column: oecd_cli,           lag: 2, transforms: [level, diff3],   family: cycle}
```

(Column names follow `macro_monthly` from Days 20 and 39. Check them with `pd.read_parquet("data/marts/macro_monthly.parquet").columns`.)

### The availability-aware builder

Create `forecasting/availability.py`:

```python
"""Build features from a reviewed spec, respecting publication lags (no look-ahead)."""
from pathlib import Path

import pandas as pd
import yaml

from forecasting.data import MARTS


def load_spec(path: str | Path) -> dict:
    with open(path) as f:
        return yaml.safe_load(f)


def transform(x: pd.Series, how: str) -> pd.Series:
    if how == "level":
        return x
    if how.startswith("diff"):
        return x - x.shift(int(how[4:]))
    if how.startswith("pct"):
        k = int(how[3:])
        return 100 * (x / x.shift(k) - 1)
    raise ValueError(f"unknown transform {how}")


def build_features(panel: pd.DataFrame, spec: dict) -> tuple[pd.DataFrame, dict]:
    """Row t contains only information published by origin t. Returns (X, family_of_column)."""
    X, families = {}, {}
    for f in spec["features"]:
        series = panel[f["column"]].shift(f["lag"])        # value of month t - lag, known at t
        for how in f["transforms"]:
            name = f"{f['name']}_{how}"
            X[name] = transform(series, how)
            families[name] = f["family"]
    return pd.DataFrame(X, index=panel.index), families


def load_monthly_panel() -> pd.DataFrame:
    m = pd.read_parquet(MARTS / "macro_monthly.parquet")
    m["month"] = pd.to_datetime(m["month"])
    return m.set_index("month").sort_index().asfreq("MS")
```

`shift(lag)` puts the value of month *t − lag* in row *t*. Transforms are applied **after** the shift, so a 3-month change of the CLI at origin *t* compares *t−2* with *t−5*, both genuinely published by then.

### Assemble the multivariate design matrix

```python
from forecasting.availability import build_features, load_monthly_panel, load_spec
from forecasting.data import load_cpi
from forecasting.features import univariate_cpi_features

cpi = load_cpi(start="1992-01-01")
panel = load_monthly_panel()
spec = load_spec("forecasting/feature_spec_cpi.yml")

X_uni = univariate_cpi_features(cpi)                    # Day 61: persistence and momentum
X_mac, fam = build_features(panel, spec)
X = X_uni.join(X_mac, how="left").loc["2006-01":]       # macro panel starts in 2006
y = cpi["cpi_yoy"]
print(X.shape)
print(X.isna().mean().sort_values(ascending=False).head(8).round(2))
```

Look at the missing shares. Some series start later. For example, BoC's `FXCADUSD` begins in 2017 in our ingestion (the notebook's "Post-2017 FX API" note), so `usd_cad_*` is empty before then.

### Missing values: let XGBoost handle them, or impute?

| Approach | When |
|---|---|
| **XGBoost's native missing-value handling** | XGBoost learns a default branch for missing values at each split, so it can use features that start late |
| drop the feature | linear models (Ridge) can't take `NaN` |
| impute (e.g. with the training-window median) | only **inside** the training window, in a pipeline (Day 61's leakage rule) |
| lengthen the history | backfill the source (Day 27), or use a longer alternative, e.g. FRED's `DEXCAUS` for USD/CAD |

Our harness from Day 61 requires complete feature rows. Add a parameter so XGBoost can use incomplete ones:

```python
def rolling_origin(X, y, model_factory, horizons, test_start, model_name,
                   refit_every=1, min_train=60, explainer=None, require_complete=True):
    feature_ok = X.notna().all(axis=1) if require_complete else X.notna().any(axis=1)
    ...                                   # the rest unchanged
```

> **Optional, recommended:** lengthen the panel. Set earlier `start_date`s in `.dlt/config.toml` (Day 23) for BoC and FRED series, add `DEXCAUS` to the FRED list and `seed_series`, run a backfill (Day 27), and rebuild the marts. More history means more training data, but check for **regime breaks** (Day 61's 1991 discussion).

---

## 68.3 Revisions and Vintages: How "Real-Time" Is Our Backtest? (35 min)

Respecting publication **lags** is necessary but not sufficient. Some indicators are later **revised**, and a backtest using today's **final** values uses information no forecaster had.

| Indicator | Revised? | Consequence for our backtest |
|---|---|---|
| CPI (not seasonally adjusted) | essentially never | real-time ✓ |
| market data (rates, yields, FX, oil) | no | real-time ✓ |
| LFS unemployment rate (seasonally adjusted) | yes, usually small; annual seasonal revisions (Day 49) | approximately real-time |
| OECD CLI | yes, often noticeably | **pseudo**-real-time only |
| GDP | yes, substantially, for years | a major issue (Day 69) |

A backtest that respects lags but uses final data is called **pseudo-real-time** (or *pseudo out-of-sample*). It's the standard in most applied work, as long as you **say so**.

Your platform can do better over time. Since Day 27 you've stored **vintages** (append-only snapshots in dlt) and since Day 37 **dbt snapshots** of CPI. As these histories grow, you can rebuild features from the data **as it was on each origin date**. Add this sentence to your model card (Day 70):

> *"The backtest is pseudo-real-time: publication lags are respected, but revised series (OECD CLI, LFS, GDP) use the latest vintage. A fully real-time evaluation becomes possible as the platform's vintage history accumulates."*

### Try it 68.3

Using the snapshot table from Day 37 (`snapshots.snap_cpi_national`), check whether any national CPI value has been revised since you began snapshotting. What does the answer imply for the CPI target in your backtest?

<details>
<summary>Hint and answer</summary>

```sql
select month, component, count(*) as versions
from snapshots.snap_cpi_national
group by all having count(*) > 1;
```

Typically no rows (or only rare corrections). The NSA CPI isn't routinely revised, which makes it an unusually clean target for honest forecast evaluation. GDP, tomorrow, is the opposite.

</details>

---

## 68.4 Multivariate Models in the Harness (50 min)

Evaluate on a common window. The macro panel starts in 2006, so allow a training period before the first test origin (e.g. test from **2014-01**), and re-score the univariate models on **the same origins** (`score()` already restricts to common origins).

```python
from sklearn.impute import SimpleImputer
from sklearn.linear_model import RidgeCV
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from forecasting.evaluate import rolling_origin, score
from forecasting.models import Naive, xgb_factory

H, TEST = [1, 3, 6, 12], "2014-01-01"

runs = [
    rolling_origin(X_uni.loc["2006-01":], y, Naive, H, TEST, "naive"),
    rolling_origin(X_uni.loc["2006-01":], y, xgb_factory, H, TEST, "xgb_univariate", refit_every=3),
    rolling_origin(X, y, xgb_factory, H, TEST, "xgb_multivariate", refit_every=3,
                   require_complete=False),
    rolling_origin(X.drop(columns=[c for c in X if c.startswith("usd_cad")]), y,
                   lambda: make_pipeline(SimpleImputer(strategy="median"), StandardScaler(),
                                         RidgeCV(alphas=[1, 10, 100, 1000])),
                   H, TEST, "ridge_multivariate", refit_every=3),
]
mv = pd.concat(runs, ignore_index=True)
mv.to_parquet("data/forecasts/cpi_multivariate.parquet", index=False)
print(score(mv).round(3).to_string(index=False))
```

Notes:
- **`SimpleImputer` inside the pipeline** learns medians from each training window only. Imputing before the backtest would leak.
- Ridge drops `usd_cad_*` because those columns are empty for most of the training period, and an imputed constant would be meaningless.
- Add the AR(AIC) benchmark and Chronos from Days 63 and 67 on the same window, to compare against the strongest univariate competitors, not just naive.

### Feature count vs sample size

With ~100 training months at the first origin and ~30 features, overfitting is a real risk. XGBoost's regularisation (shallow trees, subsampling, Day 62) and Ridge's penalty are your protection. **Out-of-sample evidence decides**, not intuition.

---

## 68.5 Did the Extra Information Help? Tests and Explanations (40 min)

### Statistical comparison

```python
from forecasting.evaluate import diebold_mariano

for h in H:
    print(diebold_mariano(mv, "xgb_multivariate", "xgb_univariate", h))
```

This is the key test of the day: **does multivariate beat univariate**, with the same model class, the same origins and the same horizons? A significant negative statistic at some horizons means the macro information adds value there.

### Explanations by economic family

Use Day 66's tools, with the spec's **families** (core, labour, monetary, financial, external, cycle) plus the univariate ones (persistence, momentum, seasonality):

```python
from forecasting.explain import xgb_contributions

def family_of_mv(feature: str) -> str:
    if feature in fam:
        return fam[feature]
    if feature.startswith("yoy_"):
        return "persistence"
    if feature.startswith("mom_"):
        return "momentum"
    if feature == "month_of_year":
        return "seasonality"
    return "base_value" if feature == "base_value" else "other"

res = rolling_origin(X, y, xgb_factory, [12], TEST, "xgb_multivariate", refit_every=3,
                     require_complete=False, explainer=xgb_contributions)
expl = res.attrs["explanations"].assign(family=lambda d: d["feature"].map(family_of_mv))
```

Plot the family decomposition of the 12-month forecast over 2014–2025 (Day 66.2). Questions:
- When the 2021 inflation surge began, did **external** (oil, FX) or **core/breadth** families push the forecast up before persistence did?
- Did **monetary** features pull forecasts down after the 2022–23 hikes, and how quickly?

> Interpret carefully: these are **predictive associations learned by the model** (Day 65.6). "Monetary features pulled the forecast down" doesn't prove that rate hikes lowered inflation. That causal question is Module 8.

---

## 68.6 Mini-Project: An Ablation Study by Feature Family (45 min)

An **ablation study** removes one family at a time and measures how much **out-of-sample** accuracy suffers. It's permutation importance (Day 65.5) at the level of whole information sets, with retraining.

```python
families = sorted(set(fam.values()))
abl = []
for f in families:
    cols = [c for c in X.columns if fam.get(c) == f]
    r = rolling_origin(X.drop(columns=cols), y, xgb_factory, H, TEST, f"xgb_without_{f}",
                       refit_every=3, require_complete=False)
    abl.append(r)
ablation = pd.concat(abl + [mv[mv.model.isin(["xgb_multivariate", "naive"])]])
board = score(ablation)
full = board[board.model == "xgb_multivariate"].set_index("h")["RMSE"]
board["delta_vs_full"] = board["RMSE"] - board["h"].map(full)
print(board[board.model.str.startswith("xgb_without")]
      .pivot(index="model", columns="h", values="delta_vs_full").round(3))
```

**Reading the table:** a **positive** delta means removing that family made forecasts **worse**, so it was helping. Near-zero means it added little. Negative means it was hurting (noise or overfitting).

Write a short note in `notebooks/day68.ipynb`, and update `MODEL_DECISIONS.md`:
1. Which families help at short and long horizons?
2. Is the full multivariate model significantly better than univariate (68.5)?
3. Which families would you **drop** to simplify the production model, and why?

### Day 68 checklist
- [ ] I can justify candidate predictors with economic reasoning, by family
- [ ] Features are built from a reviewed spec that encodes each indicator's publication lag
- [ ] I handle late-starting features correctly (native XGBoost missing values or in-window imputation)
- [ ] I can explain the difference between real-time and pseudo-real-time evaluation, and where our backtest stands
- [ ] Multivariate vs univariate is tested with Diebold–Mariano on common origins
- [ ] An ablation study shows which information families actually help

```bash
git add forecasting notebooks && git commit -m "Day 68: multivariate CPI forecasts with publication lags, ablation" && git push
```

---

# DAY 69 — Nowcasting and Forecasting Real GDP Growth

| Time | Block |
|---|---|
| 0:00 – 0:40 | 69.1 GDP is different: quarterly, late and revised |
| 0:40 – 1:20 | 69.2 A long quarterly history: the `ml_gdp_quarterly` mart |
| 1:20 – 1:35 | Break |
| 1:35 – 2:40 | 69.3 Nowcasting with a ragged edge |
| 2:40 – 3:25 | 69.4 Evaluating nowcasts: error by month of the quarter |
| 3:25 – 3:40 | Break |
| 3:40 – 4:15 | 69.5 COVID outliers: robust losses and honest reporting |
| 4:15 – 5:00 | 69.6 Mini-project: the GDP leaderboard |

---

## 69.1 GDP Is Different: Quarterly, Late and Revised (40 min)

| | CPI | Real GDP |
|---|---|---|
| frequency | monthly | **quarterly** |
| delay | ~3 weeks after the month | about **two months** after the quarter ends |
| revisions | essentially none | **substantial and repeated** |
| volatility | moderate | extreme in 2020 (lockdown collapse and rebound) |
| sample since 1992 | ~400 months | ~130 quarters |

Because GDP arrives late, much of the policy interest is in **nowcasting**: estimating growth for the **current** quarter (or the one just ended) before StatCan publishes it, using **monthly** indicators that arrive earlier. Central banks and private forecasters run nowcasting models continuously for this reason.

We'll build two related targets:
- **nowcast (h = 0):** annualised real GDP growth of the quarter containing the origin month;
- **forecast (h = 1):** growth of the **next** quarter.

---

## 69.2 A Long Quarterly History: the `ml_gdp_quarterly` Mart (40 min)

`macro_quarterly` starts in 2006, which is too short. Add a modelling mart with the full GDP history in `macro_dbt/models/marts/ml/ml_gdp_quarterly.sql`:

```sql
-- Grain: one row per quarter (first month of quarter). Real GDP growth inputs for Module 7.
-- StatCan 36-10-0104-01, SAAR, chained dollars. Values are the LATEST vintage (revised).
select
    quarter,
    real_gdp,
    real_qoq,
    real_qoq_ann,
    real_yoy
from {{ ref('int_gdp__growth') }}
where real_gdp is not null
```

Add tests (unique `quarter`, quarterly `sequential_values`) and add it to the `forecasting_models` exposure (Day 61). Then build it (in `.venv`, with no pipeline running) and confirm the Parquet export:

```bash
source .venv/bin/activate
cd macro_dbt && dbt build --target prod --select ml_gdp_quarterly && cd ..
source .venv-ml/bin/activate
```

Add a loader to `forecasting/data.py`:

```python
def load_gdp(start: str = "1992-01-01") -> pd.DataFrame:
    g = pd.read_parquet(MARTS / "ml_gdp_quarterly.parquet")
    g["quarter"] = pd.to_datetime(g["quarter"])
    g = g.set_index("quarter").sort_index().asfreq("QS")
    return g.loc[start:]
```

### Which vintage are we forecasting?

The mart holds the **latest** estimates. A forecast made in 2015 is therefore judged against GDP **as revised today**, not as first published. Both targets are defensible:

| Target | Pro | Con |
|---|---|---|
| **latest vintage** | the best estimate of what actually happened | forecasters were trying to predict first releases at the time |
| **first release** | what markets and media reacted to | needs a vintage history (growing in your platform since Day 27) |

We use the latest vintage and **document it**. As your `gdp_vintages` table accumulates, you can compare. A good exercise for the end of the course.

---

## 69.3 Nowcasting with a Ragged Edge (65 min)

At any moment, the latest available data **ends at different dates** for different series: daily market data up to yesterday, the LFS for last month, the OECD CLI two months back, GDP for the quarter before last. Plotted, the end of the dataset is jagged, hence the **ragged edge**.

### Design: monthly origins, quarterly targets

Each **month-end** is an origin. At origin *m*:
- the **target quarter** is the quarter containing *m* (for the nowcast);
- for each monthly indicator, average the months of the target quarter that are **already published** (quarter-to-date), using its lag from the spec;
- record **how many months** of the quarter are known (1, 2 or 3): the nowcast should improve as the quarter fills in;
- add the **last published GDP growth**: the quarter whose release (about two months after quarter end) has happened by *m*.

Create `forecasting/feature_spec_gdp.yml`:

```yaml
target: real_qoq_ann
gdp_release_lag_months: 2      # quarter q is published ~2 months after it ends
features:
  - {name: unemp,     column: unemployment_rate,       lag: 0, family: labour}
  - {name: overnight, column: overnight_rate,          lag: 0, family: monetary}
  - {name: slope,     column: spread_10_2_bp,          lag: 0, family: financial}
  - {name: wti,       column: wti_eom,                 lag: 0, family: external}
  - {name: usd_cad,   column: usd_cad_eom,             lag: 0, family: external}
  - {name: oecd_cli,  column: oecd_cli,                lag: 2, family: cycle}
  - {name: core_yoy,  column: core_ex_fe_yoy,          lag: 0, family: prices}
```

(Because the origin is the **end** of month *m*, LFS data for *m* is published early in *m+1*, so treat it as lag 1 if you want to be conservative. Decide, write the decision in the spec comment, and be consistent.)

Create `forecasting/nowcast.py`:

```python
"""Ragged-edge nowcasting dataset for quarterly real GDP growth from monthly indicators."""
import numpy as np
import pandas as pd


def last_published_quarter(origin: pd.Timestamp, release_lag: int) -> pd.Period:
    """Most recent quarter whose GDP has been released by the end of `origin`'s month."""
    ref = (origin - pd.DateOffset(months=release_lag)).to_period("M")
    q = ref.asfreq("Q")
    return q if ref.month % 3 == 0 else q - 1          # quarter must have ended by `ref`


def nowcast_dataset(panel: pd.DataFrame, gdp: pd.Series, spec: dict,
                    horizon_q: int = 0) -> pd.DataFrame:
    """One row per monthly origin: features known at the origin, target = GDP growth of
    the quarter containing the origin (+ horizon_q quarters), and the date it becomes known."""
    rows = []
    lag_gdp = spec["gdp_release_lag_months"]
    for m in panel.index:
        tq = m.to_period("Q") + horizon_q                    # target quarter
        q_start = (m.to_period("Q")).start_time
        row = {"origin": m, "target_quarter": tq.start_time,
               "month_in_quarter": (m.month - 1) % 3 + 1,
               "target_known": (tq.end_time + pd.DateOffset(months=lag_gdp)).to_period("M")
                                .start_time}
        for f in spec["features"]:
            avail_end = m - pd.DateOffset(months=f["lag"])
            qtd = panel.loc[q_start:avail_end, f["column"]].dropna()
            hist = panel.loc[:avail_end, f["column"]].dropna()
            row[f"{f['name']}_qtd"] = qtd.mean() if len(qtd) else np.nan
            row[f"{f['name']}_last"] = hist.iloc[-1] if len(hist) else np.nan
            row[f"{f['name']}_chg3"] = (hist.iloc[-1] - hist.iloc[-4]) if len(hist) > 3 else np.nan
        pq = last_published_quarter(m, lag_gdp)
        row["gdp_last_published"] = gdp.get(pq.start_time, np.nan)
        row["gdp_prev_published"] = gdp.get((pq - 1).start_time, np.nan)
        row["target"] = gdp.get(tq.start_time, np.nan)
        rows.append(row)
    return pd.DataFrame(rows).set_index("origin")
```

Key ideas in the code:
- **`target_known`** is the month when the target quarter's GDP is published. Training rows are only usable if their target was **known by the origin**, the same principle as Day 61.4 expressed with explicit dates.
- **Quarter-to-date averages** use only months up to `avail_end`, so early in the quarter they're based on one month (or none, giving `NaN`, which XGBoost handles).
- `gdp_last_published` is the most recent **released** quarter. Early in a quarter that's two quarters back, a real feature of nowcasting.

```python
from forecasting.availability import load_monthly_panel, load_spec
from forecasting.data import load_gdp
from forecasting.nowcast import nowcast_dataset

panel = load_monthly_panel()
gdp = load_gdp()["real_qoq_ann"]
gspec = load_spec("forecasting/feature_spec_gdp.yml")
D0 = nowcast_dataset(panel, gdp, gspec, horizon_q=0)        # nowcast
D1 = nowcast_dataset(panel, gdp, gspec, horizon_q=1)        # next quarter
print(D0.tail(6)[["target_quarter", "month_in_quarter", "gdp_last_published",
                  "unemp_qtd", "oecd_cli_last", "target"]])
```

Inspect the last rows: the target is `NaN` for quarters not yet published, which is exactly what you'll **forecast** in production on Day 70.

---

## 69.4 Evaluating Nowcasts: Error by Month of the Quarter (45 min)

The Day 61 harness assumes targets *h* months ahead. Here each row carries its own `target_known` date, so write a general version. Add to `forecasting/evaluate.py`:

```python
def rolling_origin_general(D: pd.DataFrame, feature_cols: list[str], model_factory,
                           test_start: str, model_name: str, refit_every: int = 3,
                           min_train: int = 40) -> pd.DataFrame:
    """Rows carry 'target' and 'target_known'. At origin t, train on rows with target_known ≤ t."""
    rows, model = [], None
    origins = D.index[D.index >= pd.Timestamp(test_start)]
    for i, t in enumerate(origins):
        if pd.isna(D.loc[t, "target"]):
            continue                                        # outcome not yet published
        train = D["target"].notna() & (D["target_known"] <= t)
        if train.sum() < min_train:
            continue
        if model is None or i % refit_every == 0:
            model = model_factory().fit(D.loc[train, feature_cols], D.loc[train, "target"])
        pred = float(model.predict(D.loc[[t], feature_cols])[0])
        rows.append({"model": model_name, "origin": t, "target_quarter": D.loc[t, "target_quarter"],
                     "month_in_quarter": int(D.loc[t, "month_in_quarter"]),
                     "forecast": pred, "actual": float(D.loc[t, "target"])})
    return pd.DataFrame(rows)
```

### Benchmarks for GDP

| Benchmark | Forecast |
|---|---|
| **last published** | growth of the latest released quarter (`gdp_last_published`) |
| **historical mean** | average growth in the training window |
| **AR(1) on published quarters** | a simple regression on the last published value (fit with `LinearRegression` on `gdp_last_published`) |

```python
from sklearn.linear_model import LinearRegression

from forecasting.models import HistoricalMean, xgb_factory


class LastPublished:
    def fit(self, X, y):
        return self

    def predict(self, X):
        return X["gdp_last_published"].to_numpy()


feats = [c for c in D0.columns if c not in ("target", "target_quarter", "target_known")]
TEST = "2012-01-01"
now = pd.concat([
    rolling_origin_general(D0, feats, LastPublished, TEST, "last_published"),
    rolling_origin_general(D0, feats, HistoricalMean, TEST, "hist_mean"),
    rolling_origin_general(D0, ["gdp_last_published"], LinearRegression, TEST, "ar1_published"),
    rolling_origin_general(D0, feats, xgb_factory, TEST, "xgb_nowcast"),
], ignore_index=True)
now.to_parquet("data/forecasts/gdp_nowcasts.parquet", index=False)
```

(`LinearRegression` can't handle `NaN`. `gdp_last_published` is always available after the first few years, but drop rows with missing values for it if needed.)

### The signature chart of nowcasting

```python
import matplotlib.pyplot as plt
import numpy as np

err = (now.assign(e=lambda d: d.forecast - d.actual)
          .groupby(["model", "month_in_quarter"])["e"]
          .apply(lambda e: np.sqrt(np.mean(e ** 2))).unstack("model"))
print(err.round(2))
err.plot(marker="o", figsize=(7, 4), title="Nowcast RMSE by month of the quarter (pp, annualised)")
plt.xticks([1, 2, 3]); plt.ylabel("RMSE"); plt.tight_layout()
plt.savefig("data/forecasts/gdp_nowcast_by_month.png", dpi=120)
```

A good nowcasting model's error **falls** as the quarter progresses: by month 3 it has seen most of the quarter's indicators. If your XGBoost line doesn't fall while the benchmarks stay flat, the monthly indicators aren't adding information. That's a valuable, honest finding too.

---

## 69.5 COVID Outliers: Robust Losses and Honest Reporting (35 min)

In 2020, Canadian real GDP growth (annualised) swung by tens of percentage points within two quarters, far outside anything in the training history. Three consequences:

1. **Evaluation:** a single 2020 quarter can dominate RMSE (errors are squared). Always report results **with and without 2020–2021**, and look at MAE too.
2. **Training:** extreme quarters pull squared-error models strongly. Options:
   - a **robust loss**: XGBoost's `objective="reg:pseudohubererror"` behaves like squared error for small errors and like absolute error for large ones;
   - **excluding** 2020Q2–2021Q1 from training (and saying so);
   - adding a **pandemic indicator** feature (only legitimate if you'd have known it in real time, which you would have).
3. **Extrapolation:** trees can't predict beyond the training range (Day 62.5), so no tree model nowcasts a −30% quarter it hasn't seen. Accept that, and don't over-interpret 2020 errors.

```python
from xgboost import XGBRegressor

def xgb_huber():
    return XGBRegressor(objective="reg:pseudohubererror", huber_slope=5.0,
                        n_estimators=300, learning_rate=0.03, max_depth=3,
                        subsample=0.8, colsample_bytree=0.8, random_state=0)

robust = rolling_origin_general(D0, feats, xgb_huber, TEST, "xgb_huber")
now2 = pd.concat([now, robust])

covid = (now2["target_quarter"] >= "2020-01-01") & (now2["target_quarter"] <= "2021-03-01")
for label, mask in [("all", pd.Series(True, index=now2.index)), ("excl. 2020Q1–2021Q1", ~covid)]:
    sub = now2[mask].assign(ae=lambda d: (d.forecast - d.actual).abs(),
                            se=lambda d: (d.forecast - d.actual) ** 2)
    print(label)
    print(sub.groupby("model").agg(MAE=("ae", "mean"),
                                   RMSE=("se", lambda s: np.sqrt(s.mean()))).round(2))
```

(`huber_slope` sets where the loss switches from squared to linear, in units of the target, here percentage points. Check your XGBoost version supports it; otherwise use the default.)

---

## 69.6 Mini-Project: The GDP Leaderboard (45 min)

Build `forecasting/gdp_leaderboard.py` that:

1. Builds `D0` (nowcast) and `D1` (next quarter) from the spec.
2. Evaluates the benchmarks, XGBoost (squared and Huber loss) and an equal-weight combination (Day 67) for both targets, from 2012.
3. Reports MAE and RMSE **overall** and **excluding 2020Q1–2021Q1**, plus RMSE **by month of the quarter**.
4. Runs Diebold–Mariano tests of the best model vs `last_published` (adapt the function to the general results by using `origin` as the alignment key).
5. Writes `data/forecasts/gdp_leaderboard.parquet` and a Markdown report stating that the target is the **latest vintage** and that evaluation is **pseudo-real-time**.

Then update `MODEL_DECISIONS.md` with the production choice for GDP: which model for the nowcast, which for next quarter, and why.

### Day 69 checklist
- [ ] I can explain why GDP is harder (frequency, delay, revisions, 2020) and what nowcasting is
- [ ] A long-history GDP mart feeds the models, and the vintage choice is documented
- [ ] My nowcasting dataset respects each series' lag and GDP's release lag (the ragged edge)
- [ ] A general harness trains only on targets published by each origin
- [ ] I can show how nowcast error evolves through the quarter, against benchmarks
- [ ] I handle COVID with robust losses and report results with and without the outliers

```bash
git add forecasting macro_dbt notebooks && git commit -m "Day 69: GDP nowcasting, ragged edge, robust losses, leaderboard" && git push
```

---

# DAY 70 — Forecasts in Production

| Time | Block |
|---|---|
| 0:00 – 0:30 | 70.1 From notebook results to a forecasting service |
| 0:30 – 1:30 | 70.2 `run_forecasts.py`: reproducible forecasts with metadata |
| 1:30 – 1:45 | Break |
| 1:45 – 2:30 | 70.3 Forecast marts in dbt: history, latest, and live accuracy |
| 2:30 – 3:10 | 70.4 Quality gates and monitoring for forecasts |
| 3:10 – 3:25 | Break |
| 3:25 – 4:10 | 70.5 Orchestration: the forecast subflow |
| 4:10 – 4:40 | 70.6 The model card and the forecast dashboard |
| 4:40 – 5:00 | 70.7 Module 7 recap and the road to causal inference |

---

## 70.1 From Notebook Results to a Forecasting Service (30 min)

Backtests answer *"how good would this have been?"*. Production answers *"what do we forecast **today**, and how is it doing?"*. The principles you applied to data apply to forecasts:

| Data platform principle | For forecasts |
|---|---|
| raw data is kept, versioned and traceable (Modules 3, 5) | every published forecast is **kept**, with the data, code and model that produced it |
| marts are tested before use (Module 4) | forecasts pass **quality checks** before reaching dashboards |
| quality is monitored over time (Day 47) | **live accuracy** is tracked as outcomes arrive: a true out-of-sample test that no backtest can match |
| documented contracts (Days 40–41) | a **model card** states intended use and limits |
| orchestration with retries and alerts (Module 6) | forecasting is a **task** in the pipeline, triggered by new data |

Retraining policy for this course:
- **Every run:** refit the chosen models on all data available (cheap for our sizes) with **fixed** hyperparameters from `MODEL_DECISIONS.md`.
- **Quarterly:** rerun the leaderboards (Days 63, 67–69) and review the model decisions. Changes are made deliberately, through a reviewed update to `MODEL_DECISIONS.md` and the specs, never automatically.

---

## 70.2 `run_forecasts.py`: Reproducible Forecasts with Metadata (60 min)

Create `forecasting/run_forecasts.py` (runs in `.venv-ml`; exit codes follow the platform convention: **0** ok · **1** failed · **2** warnings):

```python
"""Produce today's CPI and GDP forecasts, intervals and explanations, with full metadata.

Usage:  python -m forecasting.run_forecasts
Writes: data/forecasts/published/run_<ts>.parquet (forecasts)
        data/forecasts/published/expl_<ts>.parquet (SHAP family contributions)
Exit:   0 ok · 1 failure · 2 warnings (e.g. inputs outside the training range)
"""
import hashlib
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost

from forecasting.availability import build_features, load_monthly_panel, load_spec
from forecasting.data import MARTS, load_cpi, load_gdp
from forecasting.explain import xgb_contributions
from forecasting.features import univariate_cpi_features
from forecasting.models import xgb_factory
from forecasting.monitoring import out_of_range_report
from forecasting.nowcast import nowcast_dataset

OUT = Path("data/forecasts/published")
CPI_H = [1, 3, 6, 12]


def fingerprint(paths) -> str:
    """Hash of the input files' contents: identifies exactly which data produced a forecast."""
    h = hashlib.sha256()
    for p in sorted(paths):
        h.update(Path(p).read_bytes())
    return h.hexdigest()[:16]


def interval_from_backtest(errors: pd.Series, point: float) -> tuple[float, float]:
    lo, hi = np.quantile(errors.dropna(), [0.1, 0.9])
    return point + lo, point + hi


def cpi_forecasts(run_meta: dict, backtest: pd.DataFrame) -> tuple[list, list, list]:
    cpi, panel = load_cpi(), load_monthly_panel()
    spec = load_spec("forecasting/feature_spec_cpi.yml")
    X_mac, fam = build_features(panel, spec)
    X = univariate_cpi_features(cpi).join(X_mac, how="left").loc["2006-01":]
    y = cpi["cpi_yoy"]
    origin = y.index.max()
    rows, expl, warnings = [], [], []

    for h in CPI_H:
        target = y.shift(-h)
        known = X.index.shift(h, freq="MS") <= origin
        train = X.notna().any(axis=1) & target.notna() & known
        model = xgb_factory().fit(X[train], target[train])
        x0 = X.loc[[origin]]
        point = float(model.predict(x0)[0])
        bt = backtest.query("model == 'xgb_multivariate' and h == @h")
        lo, hi = interval_from_backtest(bt["forecast"] - bt["actual"], point)
        rows.append({**run_meta, "target": "cpi_yoy", "model": "xgb_multivariate", "horizon": h,
                     "origin": origin, "target_period": origin + pd.DateOffset(months=h),
                     "forecast": point, "q10": lo, "q90": hi})
        rows.append({**run_meta, "target": "cpi_yoy", "model": "naive", "horizon": h,
                     "origin": origin, "target_period": origin + pd.DateOffset(months=h),
                     "forecast": float(y.loc[origin]), "q10": np.nan, "q90": np.nan})
        c = xgb_contributions(model, x0).iloc[0]
        for feat, val in c.items():
            expl.append({**run_meta, "target": "cpi_yoy", "horizon": h, "feature": feat,
                         "family": fam.get(feat, "base_value" if feat == "base_value" else "own_history"),
                         "contribution": float(val)})
        warnings += out_of_range_report(X[train], x0, label=f"cpi h={h}")
    return rows, expl, warnings


def gdp_nowcast(run_meta: dict) -> tuple[list, list]:
    panel, gdp = load_monthly_panel(), load_gdp()["real_qoq_ann"]
    gspec = load_spec("forecasting/feature_spec_gdp.yml")
    rows, warnings = [], []
    for hq, label in [(0, "nowcast"), (1, "next_quarter")]:
        D = nowcast_dataset(panel, gdp, gspec, horizon_q=hq)
        feats = [c for c in D.columns if c not in ("target", "target_quarter", "target_known")]
        origin = D.index.max()
        train = D["target"].notna() & (D["target_known"] <= origin)
        model = xgb_factory().fit(D.loc[train, feats], D.loc[train, "target"])
        point = float(model.predict(D.loc[[origin], feats])[0])
        rows.append({**run_meta, "target": "real_gdp_qoq_ann", "model": f"xgb_{label}",
                     "horizon": hq, "origin": origin,
                     "target_period": D.loc[origin, "target_quarter"],
                     "forecast": point, "q10": np.nan, "q90": np.nan})
        warnings += out_of_range_report(D.loc[train, feats], D.loc[[origin], feats],
                                        label=f"gdp {label}")
    return rows, warnings


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    inputs = [MARTS / f for f in ("macro_monthly.parquet", "ml_cpi_monthly.parquet",
                                  "ml_gdp_quarterly.parquet")]
    run_meta = {
        "run_id": uuid.uuid4().hex[:12],
        "as_of": now,
        "data_fingerprint": fingerprint(inputs),
        "spec_fingerprint": fingerprint([Path("forecasting/feature_spec_cpi.yml"),
                                         Path("forecasting/feature_spec_gdp.yml")]),
        "xgboost_version": xgboost.__version__,
    }
    try:
        backtest = pd.read_parquet("data/forecasts/cpi_multivariate.parquet")
        cpi_rows, expl, w1 = cpi_forecasts(run_meta, backtest)
        gdp_rows, w2 = gdp_nowcast(run_meta)
    except Exception as e:
        print(f"✗ forecasting failed: {type(e).__name__}: {e}")
        return 1

    stamp = now.strftime("%Y%m%dT%H%M%S")
    pd.DataFrame(cpi_rows + gdp_rows).to_parquet(OUT / f"run_{stamp}.parquet", index=False)
    pd.DataFrame(expl).to_parquet(OUT / f"expl_{stamp}.parquet", index=False)
    print(f"✓ published run {run_meta['run_id']} ({len(cpi_rows) + len(gdp_rows)} forecasts)")

    warnings = w1 + w2
    for w in warnings:
        print(f"⚠ {w}")
    return 2 if warnings else 0


if __name__ == "__main__":
    sys.exit(main())
```

Every published row carries its **provenance**: `run_id`, `as_of`, a **fingerprint of the input data**, a fingerprint of the **feature specs**, and the library version. Six months from now you'll be able to answer *"which data and which features produced the forecast we briefed in March?"*. That's the forecasting counterpart of Day 37's snapshots and Day 47's validation history.

The **naive** forecast is published alongside the model's, so live accuracy (70.3) always has its benchmark.

---

## 70.3 Forecast Marts in dbt: History, Latest, and Live Accuracy (45 min)

Published forecasts are data, so model them in dbt (Day 47's external-source pattern).

**`macro_dbt/models/staging/forecasts/_forecasts__sources.yml`**

```yaml
version: 2
sources:
  - name: forecasts
    description: "Forecasts published by forecasting/run_forecasts.py (Module 7)."
    meta:
      external_location: "../data/forecasts/published/run_*.parquet"
    tables:
      - name: runs
```

**`stg_forecasts__runs.sql`** casts types: `cast(origin as date)`, `cast(target_period as date)`, `cast(as_of as timestamp)`.

**`marts/forecasts/forecast_latest.sql`**

```sql
-- Grain: one row per target × model × horizon, from the most recent run.
with ranked as (
    select *,
           row_number() over (partition by target, model, horizon order by as_of desc) as rn
    from {{ ref('stg_forecasts__runs') }}
)
select * exclude (rn) from ranked where rn = 1
```

**`marts/forecasts/forecast_accuracy.sql`**: the payoff of keeping every forecast:

```sql
-- Grain: one row per published forecast whose outcome is now known.
-- This is TRUE out-of-sample evaluation: forecasts were made before outcomes existed.
with f as (
    select * from {{ ref('stg_forecasts__runs') }}
),

cpi_actual as (
    select month as target_period, cpi_yoy as actual
    from {{ ref('ml_cpi_monthly') }}
),

gdp_actual as (
    select quarter as target_period, real_qoq_ann as actual
    from {{ ref('ml_gdp_quarterly') }}
),

joined as (
    select f.*, a.actual
    from f
    join cpi_actual as a using (target_period)
    where f.target = 'cpi_yoy'
    union all by name
    select f.*, a.actual
    from f
    join gdp_actual as a using (target_period)
    where f.target = 'real_gdp_qoq_ann'
)

select
    *,
    forecast - actual                                   as error,
    abs(forecast - actual)                              as abs_error,
    case when q10 is not null
         then actual between q10 and q90 end            as inside_80
from joined
where actual is not null
```

Add a small summary mart, `forecast_track_record`: MAE and RMSE per target, model and horizon over the last 24 months of **live** forecasts, with the model's RMSE relative to the naive forecast published in the same runs.

> **Why this matters more than any backtest:** live accuracy uses forecasts that were **genuinely made before** the outcomes. No leakage is possible, no tuning on the test period, and no pretraining contamination for Chronos. Over time, `forecast_track_record` becomes the most credible evidence about your models.

---

## 70.4 Quality Gates and Monitoring for Forecasts (40 min)

### Inputs outside the training range

Trees can't extrapolate (Day 62.5). When today's inputs lie **outside** the range seen in training, the forecast deserves a warning. Create `forecasting/monitoring.py`:

```python
"""Monitoring helpers: flag inputs outside the training distribution."""
import pandas as pd


def out_of_range_report(X_train: pd.DataFrame, x_now: pd.DataFrame, label: str,
                        z_limit: float = 4.0) -> list[str]:
    """Warn for features outside the training min–max, or more than z_limit std from the mean."""
    warnings = []
    for col in x_now.columns:
        v = x_now[col].iloc[0]
        s = X_train[col].dropna()
        if pd.isna(v) or s.empty:
            continue
        if v < s.min() or v > s.max():
            warnings.append(f"{label}: {col}={v:.2f} outside training range "
                            f"[{s.min():.2f}, {s.max():.2f}]")
        elif s.std() > 0 and abs(v - s.mean()) / s.std() > z_limit:
            warnings.append(f"{label}: {col}={v:.2f} is {abs(v - s.mean()) / s.std():.1f} std "
                            f"from its training mean")
    return warnings
```

`run_forecasts.py` returns exit code **2** when such warnings occur, so the forecast is published **with a flag** (Day 53's *CompletedWithWarnings*) and the dashboard can say so.

### GX checks on published forecasts

Register `marts.forecast_latest` as a GX table asset (Day 43, `setup_gx.py`) and add a spec, `quality/specs/forecast_latest.yml` (Day 44 format):

```yaml
description: "Latest published forecasts: completeness and coherence before dashboards use them."
asset: forecast_latest
batch_definition: full
owner: macro-team

critical:
  - type: ExpectColumnValuesToNotBeNull
    kwargs: {column: forecast}
    meta: {plan_id: F01, dimension: completeness}
  - type: ExpectColumnPairValuesAToBeGreaterThanB
    kwargs: {column_A: q90, column_B: forecast, or_equal: true, ignore_row_if: either_value_is_missing}
    meta: {plan_id: F02, dimension: consistency, rationale: "Upper bound ≥ point forecast."}
  - type: ExpectColumnPairValuesAToBeGreaterThanB
    kwargs: {column_A: forecast, column_B: q10, or_equal: true, ignore_row_if: either_value_is_missing}
    meta: {plan_id: F03, dimension: consistency, rationale: "Point forecast ≥ lower bound."}
  - type: ExpectTableRowCountToBeBetween
    kwargs: {min_value: 10}
    meta: {plan_id: F04, dimension: completeness,
           rationale: "4 CPI horizons × 2 models + 2 GDP targets."}

warning:
  - type: ExpectColumnValuesToBeBetween
    kwargs: {column: forecast, min_value: -5, max_value: 15, mostly: 1.0}
    meta: {plan_id: F05, dimension: plausibility,
           rationale: "CPI forecasts outside −5…15% (or GDP outside it) need review before publication."}
```

Rebuild suites (`python quality/build_suites.py`). The forecast checks join the warehouse `critical`/`warning` checkpoints, so `run_quality.sh` now protects forecasts too.

---

## 70.5 Orchestration: The Forecast Subflow (45 min)

Add the interpreter for the modelling environment to `orchestration/settings.py`:

```python
ML_PY = str(REPO / ".venv-ml" / "bin" / "python")
```

and a step policy (Day 54):

```python
    "forecast_models": dict(retries=1, delays=[300], timeout=1800,
                            transient=(1,), warning=(2,)),
```

(A Chronos model download or a temporary file-system issue is worth one retry. Exit code 2, inputs out of range, is a warning.)

Create `orchestration/flows/forecast.py`:

```python
"""Forecast subflow: produce forecasts, model them in dbt, validate, publish."""
from prefect import flow

from orchestration.settings import ML_PY
from orchestration.tasks.commands import step
from orchestration.tasks.dbt import dbt_invoke


@flow(name="forecast")
def forecast_flow(target: str = "prod", drill: dict | None = None) -> dict:
    states = {"forecast_models": step("forecast_models",
                                      [ML_PY, "-m", "forecasting.run_forecasts"], drill=drill)}
    if states["forecast_models"].is_completed():
        states["dbt_forecasts"] = dbt_invoke.with_options(name="dbt:forecasts")(
            ["build", "--target", target, "--select", "source:forecasts+"], return_state=True)
    return states
```

Where it runs:
- **`daily_refresh`** (Day 60): after `quality_flow` and **before** `publish_flow`, so dashboards include the newest forecasts. If `forecast_models` fails, the policy publishes dashboards **without** updated forecasts (yesterday's remain, with their `as_of` dates visible) and ends the run *CompletedWithWarnings*.
- **`statcan_release`** (Day 59): after a **CPI, LFS or GDP** release is published, call `forecast_flow()`, so new information reaches the forecast within minutes.

Forecasting reads only **Parquet marts**, so it needs no DuckDB lock. The dbt step that models forecasts is a writer, and `dbt_invoke` already takes the writer slot (Day 59). Update `STATE_POLICY.md` with the new rows.

---

## 70.6 The Model Card and the Forecast Dashboard (30 min)

### `forecasting/MODEL_CARD.md`

A **model card** (Mitchell et al., 2019) documents a model the way a data contract documents a dataset. Write one with these sections:

```markdown
# Model card — Canadian CPI inflation and real GDP growth forecasts

## Intended use
Statistical forecasts of CPI yoy inflation (1–12 months) and real GDP growth (nowcast, next quarter)
for internal briefings and dashboards. NOT for: causal policy evaluation; official projections.

## Models
- CPI: XGBoost (direct, one model per horizon), multivariate features (feature_spec_cpi.yml);
  benchmark: naive (published alongside). Hyperparameters: MODEL_DECISIONS.md.
- GDP: XGBoost nowcast/next-quarter on ragged-edge monthly indicators (feature_spec_gdp.yml).

## Data
Marts: ml_cpi_monthly, macro_monthly, ml_gdp_quarterly (dbt, tested; GX-validated).
Publication lags encoded per feature. GDP target = latest vintage.

## Evaluation
Pseudo-real-time rolling-origin backtests from 2014 (CPI) / 2012 (GDP); Diebold–Mariano vs benchmarks;
interval coverage; results in data/forecasts/*leaderboard*. Live track record: marts.forecast_track_record.

## Limitations and caveats
- Tree models cannot extrapolate beyond the training range (flagged at run time).
- 2020–21 outliers dominate GDP errors; results reported with and without.
- Backtests use revised data for LFS, OECD CLI and GDP (pseudo-real-time).
- SHAP explanations describe the model's associations, not causal effects.
- Chronos (comparator) may have seen public macro series in pretraining.

## Monitoring
Out-of-range input warnings (exit code 2); GX checks F01–F05; live accuracy vs naive; explanation drift.

## Ownership and review
Owner: macro-team. Quarterly re-evaluation; changes via reviewed MODEL_DECISIONS.md updates.
```

### The forecast dashboard

Extend Day 66's `forecast_explained` page in `dashboards/build_dashboards.py` to read the **dbt-exported** marts (`forecast_latest`, `forecast_track_record`, and the latest `expl_*.parquet`):
1. **CPI fan chart:** history, model forecast with the 80% band, and the naive forecast for contrast.
2. **GDP nowcast** for the current quarter, with the latest published quarter beside it.
3. **Drivers:** SHAP family contributions for the 12-month CPI forecast.
4. **Track record:** live RMSE vs naive over time, from `forecast_track_record`.
5. The header shows the forecast `as_of`, any **out-of-range warning**, and the model card's one-line caveat.

Add an exposure `forecast_dashboard` depending on `forecast_latest` and `forecast_track_record` (Day 40), and add the latest 12-month CPI forecast and GDP nowcast as KPIs in `macro_kpis` (Day 39).

---

## 70.7 Module 7 Recap and the Road to Causal Inference (20 min)

### What you built in Module 7 (Days 61–70)

| Days | Capability |
|---|---|
| 61 | ŷ vs β̂; a leak-free rolling-origin harness; benchmarks and metrics |
| 62 | trees, forests, boosting from scratch, XGBoost; no extrapolation |
| 63 | AR benchmarks; direct vs recursive; Diebold–Mariano; prediction intervals |
| 64 | leak-free tuning with time-series CV; nested evaluation |
| 65–66 | SHAP: theory, global and local explanations, decompositions over time, explanation drift |
| 67 | zero-shot Chronos; probabilistic scoring; combinations; contamination checks |
| 68 | multivariate CPI forecasts with publication lags; ablation by information family |
| 69 | GDP nowcasting with a ragged edge; robust losses; honest COVID reporting |
| 70 | production forecasts with provenance, live accuracy, quality gates, orchestration, a model card |

### How this completes the capstone's "Model & Forecast" row

| Capstone deliverable | Where |
|---|---|
| next-quarter GDP forecasts | Day 69 nowcast and next-quarter models, published daily (Day 70) |
| CPI forecasts | Days 68–70, with explanations and track record |
| integrated with the Prefect-orchestrated pipeline | Day 70's forecast subflow, triggered by schedules and StatCan releases |
| interactive visualisation layer | the forecast dashboard page and cockpit KPIs |

### Looking ahead: Module 8 — Causal Inference with DoubleML (Days 71–80)

Forecasting asks *what will happen*. Policy asks *what would happen if…*. Throughout this module we warned that SHAP values and feature importance are **not causal**. Module 8 tackles causality directly:

- **Days 71–73:** causal inference theory, confounding, and directed acyclic graphs (DAGs) for macro questions.
- **Days 74–77:** nuisance parameters, cross-fitting and the partially linear model: using flexible ML (including the XGBoost skills you've just built) to **control** for confounders, while estimating a causal parameter with valid standard errors.
- **Days 78–80:** estimating the causal impact of **Bank of Canada overnight rate hikes on housing starts**, controlling for business-cycle indicators. You'll add a housing-starts series through the platform you built (a new dlt source or StatCan table via WAP, a staging model, tests and a mart), the same path every series in this course has followed.

### Day 70 checklist
- [ ] `run_forecasts.py` publishes forecasts with run IDs, data and spec fingerprints, versions and benchmark forecasts
- [ ] dbt models keep every forecast, the latest forecasts, and live accuracy against realised outcomes
- [ ] Inputs outside the training range raise warnings; GX validates forecast coherence before publication
- [ ] The forecast subflow runs in the daily refresh and after relevant StatCan releases, with policy rows documented
- [ ] A model card states intended use, data, evaluation, limitations and monitoring
- [ ] The dashboard shows forecasts, intervals, drivers, track record and caveats

```bash
git add .
git commit -m "Day 70: production forecasts, live accuracy, quality gates, model card — Module 7 complete"
git push
```
