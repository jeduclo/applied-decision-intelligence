# Module 7 · Forecasting with XGBoost & Chronos
## Days 61–63: Supervised Learning Theory, Tree-Based Models and Univariate Forecasting

**Audience:** MSc Economics students who completed Parts I–II (Days 1–60)
**Environment:** GitHub Codespaces · a new `.venv-ml` · the dbt marts exported to `data/marts/*.parquet`
**Time per day:** ~2.5 hours (including breaks and exercises)
**Goal by end of Day 63:** Students can frame macro forecasting as a supervised-learning problem without leaking the future. They build a **rolling-origin evaluation harness** (pseudo out-of-sample), understand decision trees, random forests and gradient boosting (XGBoost) from the ground up, and run an honest **univariate horse race** for Canadian CPI inflation at several horizons. Every model is judged against naive and autoregressive benchmarks, with statistical tests and calibrated prediction intervals.

---

### Part III begins: why the platform matters for modelling

Parts I–II built a pipeline that produces **clean, tested, documented, timely** data. Forecasting is where that investment pays off, because forecasting is unforgiving of data problems:

| Data problem | What it does to a forecast |
|---|---|
| a gap in the series (Day 49) | lags point to the wrong month; features silently shift |
| a unit error (Day 41) | the model learns from nonsense; error metrics explode |
| using revised data as if it were known at the time (Day 27) | evaluation looks better than real-world performance |
| features computed with future information | **leakage**: brilliant backtests, useless forecasts |

You'll meet that last problem constantly this module. Avoiding it is the single most important skill in applied forecasting.

### The plan for Module 7

| Days | Focus |
|---|---|
| **61–63** | supervised learning theory, honest evaluation, trees and boosting, univariate forecasts |
| 64–67 | hyperparameter tuning, SHAP explainability, zero-shot forecasting with Chronos |
| 68–70 | forecasting Canadian CPI and real GDP growth with the features engineered in Modules 2–4 |

### Target structure (by end of Day 63)

```
macro-data-course/
├── .venv-ml/                       ← NEW: modelling environment
├── macro_dbt/models/marts/ml/
│   └── ml_cpi_monthly.sql          ← NEW: a mart for modelling (exported to Parquet)
├── forecasting/                    ← NEW: reusable modelling code
│   ├── __init__.py
│   ├── data.py                     ← loading marts
│   ├── features.py                 ← leakage-safe feature construction
│   ├── evaluate.py                 ← rolling-origin harness, metrics, Diebold–Mariano
│   └── models.py                   ← benchmarks and model factories
├── notebooks/                      ← exploration (day61.ipynb, …)
└── data/forecasts/                 ← results (not committed)
```

---

# DAY 61 — Supervised Learning for Economists

| Time | Block |
|---|---|
| 0:00 – 0:23 | 61.1 Prediction vs inference: ŷ problems and β̂ problems |
| 0:23 – 0:40 | 61.2 Setting up the modelling environment and data |
| 0:40 – 0:48 | Break |
| 0:48 – 1:10 | 61.3 Framing a forecast: horizon, information set, target |
| 1:10 – 1:35 | 61.4 Evaluation without leakage: rolling-origin backtests |
| 1:35 – 1:43 | Break |
| 1:43 – 2:05 | 61.5 Benchmarks and metrics |
| 2:05 – 2:30 | 61.6 Mini-project: the evaluation harness + first linear models |

---

## 61.1 Prediction vs Inference (23 min)

Econometrics training focuses on **β̂**: estimating a parameter (an elasticity, a treatment effect) and its uncertainty. Machine learning focuses on **ŷ**: predicting an outcome as accurately as possible out of sample. Mullainathan and Spiess (2017, *Journal of Economic Perspectives*) frame this as the difference between "β̂ problems" and "ŷ problems".

| | Inference (β̂) | Prediction (ŷ) |
|---|---|---|
| question | *what is the effect of X on Y?* | *what will Y be?* |
| success | unbiased, efficient β̂; valid standard errors | small out-of-sample error |
| model choice | theory, identification | whatever predicts best, honestly evaluated |
| coefficients | the object of interest | often uninterpretable, and that's acceptable |
| main danger | omitted-variable bias, endogeneity | **overfitting**, **leakage** |
| this course | Module 8 (DoubleML) | **Module 7** |

Forecasting CPI inflation is a **ŷ problem**: the Bank of Canada, markets and businesses want to know where inflation is going. Explaining *why* matters too, and Days 64–67 add explainability (SHAP). But the yardstick is forecast accuracy.

### Bias, variance and overfitting

A model's expected out-of-sample squared error decomposes into:

**error = bias² + variance + irreducible noise**

- **Bias:** the model is too simple to capture the pattern (e.g. a constant forecast).
- **Variance:** the model is so flexible that it fits noise in the training sample, and its forecasts change wildly with small changes in data.
- **Noise:** the part of inflation no model can predict (shocks).

Flexible ML models reduce bias but risk variance. Every technique this week (regularisation, tree depth limits, learning rates, early stopping, cross-validation) is a way to **trade bias against variance using out-of-sample evidence**.

> **Economist's intuition:** adding regressors to an OLS model always increases in-sample R². It doesn't always improve forecasts, for the same reason. In-sample fit is not the target.

---

## 61.2 Setting Up the Modelling Environment and Data (18 min)

### A separate environment, as before (Day 42)

Modelling libraries are large and evolve quickly; keep them isolated from the pipeline:

```bash
cd /workspaces/macro-data-course
python -m venv .venv-ml
source .venv-ml/bin/activate
pip install -U pip
pip install pandas pyarrow numpy scikit-learn xgboost statsmodels matplotlib ipykernel tabulate
mkdir -p forecasting && pip freeze > forecasting/requirements-ml.txt
python -c "import xgboost, sklearn, statsmodels; print(xgboost.__version__, sklearn.__version__, statsmodels.__version__)"
```

Add `.venv-ml/` and `data/forecasts/` to `.gitignore`. In VS Code, notebooks in `notebooks/` can select `.venv-ml` as their kernel (Day 4). **Explore in notebooks, keep reusable code in `forecasting/`.**

### A mart for modelling

Models should read **marts**, never raw tables: they get tested, documented data ("dashboards present; dbt computes" applies to models too). We need a long CPI history, which `macro_monthly` (from 2006) doesn't have. Add a mart in `macro_dbt/models/marts/ml/ml_cpi_monthly.sql`:

```sql
-- Grain: one row per month, Canada. CPI inputs for forecasting (Module 7).
-- CPI (18-10-0004-01) is not seasonally adjusted and is rarely revised.
select
    month,
    max(cpi) filter (where component = 'All-items')                           as cpi,
    max(yoy) filter (where component = 'All-items')                           as cpi_yoy,
    max(mom) filter (where component = 'All-items')                           as cpi_mom,
    max(yoy) filter (where component = 'All-items excluding food and energy') as core_yoy
from {{ ref('int_cpi__growth') }}
where geo_code = 'CA'
group by month
```

with tests (`unique` on `month`, `sequential_values` monthly, Day 36) in `_ml__models.yml`. Build it in the pipeline environment while no other run is writing:

```bash
source .venv/bin/activate
cd macro_dbt && dbt build --target prod --select ml_cpi_monthly && cd ..
ls -l data/marts/ml_cpi_monthly.parquet          # exported by the Day 40 post-hook
source .venv-ml/bin/activate
```

(Also add `ml_cpi_monthly` to an exposure, e.g. `forecasting_models`, so the lineage graph shows that models depend on it, as on Day 40.)

### Loading data: `forecasting/data.py`

```python
"""Load modelling inputs from the exported dbt marts."""
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parents[1]
MARTS = REPO / "data" / "marts"


def load_cpi(start: str = "1992-01-01") -> pd.DataFrame:
    """Monthly CPI inputs from ml_cpi_monthly, on a regular month-start index."""
    df = pd.read_parquet(MARTS / "ml_cpi_monthly.parquet")
    df["month"] = pd.to_datetime(df["month"])
    df = df.set_index("month").sort_index().asfreq("MS")
    df = df.loc[start:]
    if df["cpi_yoy"].isna().any():
        missing = df.index[df["cpi_yoy"].isna()]
        raise ValueError(f"cpi_yoy has gaps, e.g. {list(missing[:3])}")
    return df
```

Why start in **1992**? The Bank of Canada and the federal government adopted inflation targets in **1991**, and inflation behaved very differently before (the 1970s–80s). Mixing regimes can teach a model patterns that no longer apply. This is an economic judgement, and you'll test its effect in an exercise.

`asfreq("MS")` puts the data on a **regular monthly index**, so a missing month would appear as `NaN` and the check fails loudly, instead of a lag silently pointing to the wrong month (Day 5's lesson).

---

## 61.3 Framing a Forecast (23 min)

Every forecast needs three precise definitions.

| Element | Definition | Our CPI example |
|---|---|---|
| **Forecast origin** *t* | the last period whose data you know when forecasting | the latest published CPI month |
| **Horizon** *h* | how far ahead | 1, 3, 6, 12 months |
| **Target** | what exactly you forecast | year-over-year CPI inflation in month *t + h* |
| **Information set** | everything knowable at *t* | CPI up to *t* (and, from Day 68, other series published by then) |

### Direct vs recursive multi-step forecasts

| Strategy | How | Pros | Cons |
|---|---|---|---|
| **Direct** | a separate model per horizon: predict *y*ₜ₊ₕ from features at *t* | no error accumulation; any features allowed | one model per horizon |
| **Recursive** | one 1-step model, iterated: feed predictions back as lags | one model | errors compound; needs forecasts of every feature |

We use **direct** forecasting by default (Day 63 compares both).

### The supervised dataset

For horizon *h*, each row pairs **features known at month *t*** with the **target at *t + h***:

```
feature date t   features (known at t)            target (y at t+h)
2019-01          y_t, y_{t-1}, …, mom_t, …        y at 2019-01 + h
2019-02          …                                y at 2019-02 + h
```

In pandas, the target is the series **shifted backwards by h**:

```python
target = y.shift(-h)          # row t holds y_{t+h}
```

This is the same `shift` you used on Day 5. Note the minus sign: we're pulling the future value back to the origin row.

> **Publication lags.** CPI for month *t* is published during month *t+1*. When we say "origin *t*", we mean the moment **just after CPI for *t* is published**. For univariate CPI forecasting that's all we need. On Day 68, when we add other series, we'll have to check that each one is **actually published** by then (Day 17's ASOF logic).

---

## 61.4 Evaluation Without Leakage: Rolling-Origin Backtests (25 min)

### Why ordinary cross-validation is wrong here

Standard ML cross-validation **shuffles** rows into folds. For time series that means training on 2024 to predict 2015: **using the future to predict the past**. Errors look small, and they're fake.

### The rolling-origin (pseudo out-of-sample) backtest

Simulate what a forecaster would have done in real time:

```
origin 2015-01: train on all rows whose target date ≤ 2015-01 → forecast y(2015-01 + h)
origin 2015-02: retrain (expanding window) → forecast y(2015-02 + h)
…
origin 2025-xx: …
```

Collect all forecasts, compare them with what actually happened, and compute errors. This is the standard way macroeconomists evaluate forecasts (*pseudo out-of-sample* because we use final data, not real-time vintages; more on Day 68).

### The subtle leakage trap: training rows near the origin

At origin *t*, a training row with feature date *s* has target date *s + h*. That target is only **known** if *s + h ≤ t*. Rows with *s* between *t − h + 1* and *t* have targets **in the future** relative to the origin, so they **must be excluded** from training, even though their *features* are known.

```
t = origin, h = 3
feature dates:  … t-4   t-3   t-2   t-1   t
target dates:   … t-1   t     t+1   t+2   t+3
usable?         …  ✓     ✓     ✗     ✗     ✗(predict this one)
```

Forgetting this is the most common forecasting bug, and it makes multi-horizon results look far too good.

### Other leakage sources to watch

| Leak | Example | Fix |
|---|---|---|
| centred rolling windows | `y.rolling(3, center=True)` uses *t+1* | only trailing windows |
| full-sample scaling | standardising with the mean of all data | fit scalers on training rows only (pipelines, 61.6) |
| target in features | `cpi_yoy` at *t+h* sneaks in via a join | build features only from data dated ≤ *t* |
| revised data | using today's GDP vintage as if known in 2015 | real-time vintages (Days 27, 37; used on Day 68) |
| tuning on the test period | choosing parameters by test error | tune on validation folds before the test period (Days 64–67) |

---

## 61.5 Benchmarks and Metrics (23 min)

### Always beat a simple benchmark first

A sophisticated model is only interesting if it beats simple ones **out of sample**.

| Benchmark | Forecast of yoy inflation at *t + h* | Rationale |
|---|---|---|
| **Naive / random walk** | yoy at *t* | "inflation stays where it is", famously hard to beat at short horizons (Atkeson & Ohanian, 2001) |
| **Historical mean** | average yoy in the training window | "inflation returns to its average" |
| **Target** | 2.0% | "inflation returns to the Bank's target" (a natural benchmark under inflation targeting) |
| **AR(p)** | autoregression on past yoy | the classic statistical benchmark (Day 63) |

### Metrics

| Metric | Formula | Notes |
|---|---|---|
| **MAE** | mean \|error\| | in percentage points; robust to occasional large errors |
| **RMSE** | √mean(error²) | penalises big misses more |
| **Relative RMSE** | RMSE(model) ÷ RMSE(naive) | < 1 means the model beats the naive benchmark; the headline number in forecasting papers |
| **MAPE** | mean \|error / actual\| | **avoid for inflation**: it explodes when inflation is near zero (e.g. 2009, 2015, 2020) |

Report errors **per horizon**. A model can win at 1 month and lose at 12.

---

## 61.6 Mini-Project: The Evaluation Harness + First Linear Models (25 min)

### `forecasting/features.py`

```python
"""Leakage-safe features: everything in row t uses data dated ≤ t only."""
import pandas as pd


def lag_features(y: pd.Series, n_lags: int, prefix: str) -> pd.DataFrame:
    """Columns prefix_lag0 … prefix_lag{n-1}: lag0 is the value at t itself (known at t)."""
    return pd.concat({f"{prefix}_lag{k}": y.shift(k) for k in range(n_lags)}, axis=1)


def univariate_cpi_features(df: pd.DataFrame, n_lags: int = 12) -> pd.DataFrame:
    y, mom = df["cpi_yoy"], df["cpi_mom"]
    X = lag_features(y, n_lags, "yoy")
    X["yoy_ma3"] = y.rolling(3).mean()              # trailing windows only
    X["yoy_ma12"] = y.rolling(12).mean()
    X["mom_lag0"] = mom
    X["mom_ma3"] = mom.rolling(3).mean()
    X["month_of_year"] = X.index.month
    return X
```

### `forecasting/evaluate.py`

```python
"""Rolling-origin (pseudo out-of-sample) evaluation and forecast metrics."""
import numpy as np
import pandas as pd


def rolling_origin(X: pd.DataFrame, y: pd.Series, model_factory, horizons,
                   test_start: str, model_name: str, refit_every: int = 1,
                   min_train: int = 60) -> pd.DataFrame:
    """Direct multi-horizon backtest with an expanding window.

    At origin t, training rows are those whose TARGET date (feature date + h) is ≤ t.
    """
    rows = []
    feature_ok = X.notna().all(axis=1)
    origins = X.index[X.index >= pd.Timestamp(test_start)]
    last_obs = y.index.max()

    for h in horizons:
        target = y.shift(-h)
        target_dates = X.index.shift(h, freq="MS")
        model = None
        for i, t in enumerate(origins):
            t_target = t + pd.DateOffset(months=h)
            if t_target > last_obs:
                break                                         # outcome not yet observed
            train = feature_ok & target.notna() & (target_dates <= t)
            if train.sum() < min_train or not feature_ok.loc[t]:
                continue
            if model is None or i % refit_every == 0:
                model = model_factory()
                model.fit(X[train], target[train])
            pred = float(model.predict(X.loc[[t]])[0])
            rows.append({"model": model_name, "h": h, "origin": t, "target_date": t_target,
                         "forecast": pred, "actual": float(y.loc[t_target])})
    return pd.DataFrame(rows)


def score(results: pd.DataFrame, benchmark: str = "naive") -> pd.DataFrame:
    """MAE, RMSE and RMSE relative to the benchmark, per model and horizon,
    computed on the origins common to all models (a fair comparison)."""
    common = results.groupby(["h", "origin"])["model"].transform("nunique") == \
             results["model"].nunique()
    r = results[common].assign(err=lambda d: d["forecast"] - d["actual"])
    out = r.groupby(["model", "h"])["err"].agg(
        MAE=lambda e: e.abs().mean(),
        RMSE=lambda e: np.sqrt((e ** 2).mean()),
        n="size").reset_index()
    bench = out[out["model"] == benchmark].set_index("h")["RMSE"]
    out["rel_RMSE"] = out["RMSE"] / out["h"].map(bench)
    return out.sort_values(["h", "rel_RMSE"])
```

`X.index.shift(h, freq="MS")` moves every month-start date forward by *h* months: the target date of each row.

### `forecasting/models.py`: benchmarks as scikit-learn-style objects

```python
"""Benchmarks with fit/predict, so they plug into the same harness as ML models."""
import numpy as np


class Naive:
    """Random walk: forecast = the latest observed value (feature yoy_lag0)."""
    def fit(self, X, y):
        return self

    def predict(self, X):
        return X["yoy_lag0"].to_numpy()


class HistoricalMean:
    def fit(self, X, y):
        self.mean_ = float(np.mean(y))
        return self

    def predict(self, X):
        return np.full(len(X), self.mean_)


class Constant:
    def __init__(self, value=2.0):
        self.value = value

    def fit(self, X, y):
        return self

    def predict(self, X):
        return np.full(len(X), self.value)
```

### Run the first horse race

In `notebooks/day61.ipynb` (kernel `.venv-ml`), or a script:

```python
from sklearn.linear_model import LinearRegression, RidgeCV
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from forecasting.data import load_cpi
from forecasting.evaluate import rolling_origin, score
from forecasting.features import univariate_cpi_features
from forecasting.models import Constant, HistoricalMean, Naive

df = load_cpi()
X, y = univariate_cpi_features(df), df["cpi_yoy"]
H = [1, 3, 6, 12]

candidates = {
    "naive": Naive,
    "hist_mean": HistoricalMean,
    "target_2pct": Constant,
    "ols_lags": LinearRegression,
    "ridge_lags": lambda: make_pipeline(StandardScaler(),
                                        RidgeCV(alphas=[0.1, 1, 10, 100, 1000])),
}

results = pd.concat([rolling_origin(X, y, f, H, "2012-01-01", name)
                     for name, f in candidates.items()], ignore_index=True)
print(score(results).round(3).to_string(index=False))
```

Things to notice:
- **`make_pipeline(StandardScaler(), RidgeCV(...))`** fits the scaler **inside** each training window. Scaling with full-sample statistics would leak (61.4). Pipelines make the leak-free version the easy version.
- `RidgeCV` chooses its penalty by internal cross-validation. That's a small leak in principle, since its folds aren't time-ordered; Days 64–67 do tuning properly.
- **Read the `rel_RMSE` column.** Does anything beat the naive forecast at h = 1? At h = 12? Does "return to target" do well at long horizons? Write down your observations. Day 63 tests whether the differences are statistically meaningful.

### Try it 61.6

Re-run with `load_cpi(start="1960-01-01")`. Which models change most, and why might pre-1991 data help or hurt forecasts of post-2012 inflation?

<details>
<summary>Discussion</summary>

The historical mean typically gets **worse**: it's pulled up by the high inflation of the 1970s–80s, which hasn't recurred under inflation targeting. Lag-based linear models may change less, since they mostly use recent values, but their coefficients now blend two regimes with different persistence. More data is only better if it comes from the **same data-generating process**. Regime changes are why macro forecasters think hard about sample start dates.

</details>

### Day 61 checklist
- [ ] I can explain ŷ vs β̂ problems and the bias–variance trade-off
- [ ] `.venv-ml` is set up; models read the tested `ml_cpi_monthly` mart via `load_cpi`
- [ ] I can define origin, horizon, target and information set, and build a direct supervised dataset
- [ ] My rolling-origin harness excludes training rows whose targets lie after the origin
- [ ] I compare every model with naive, mean and target benchmarks using MAE, RMSE and relative RMSE

```bash
git add forecasting macro_dbt notebooks .gitignore
git commit -m "Day 61: ML environment, CPI mart, rolling-origin harness, benchmarks"
git push
```

---

# DAY 62 — Tree-Based Models

| Time | Block |
|---|---|
| 0:00 – 0:25 | 62.1 Decision trees: splitting the data into regimes |
| 0:25 – 0:45 | 62.2 Overfitting and the depth trade-off |
| 0:45 – 0:53 | Break |
| 0:53 – 1:15 | 62.3 Ensembles: bagging and random forests |
| 1:15 – 1:40 | 62.4 Gradient boosting from scratch, then XGBoost |
| 1:40 – 1:48 | Break |
| 1:48 – 2:08 | 62.5 Trees can't extrapolate: what that means for macro data |
| 2:08 – 2:30 | 62.6 Mini-project: trees in the horse race |

---

## 62.1 Decision Trees: Splitting the Data into Regimes (25 min)

A **regression tree** predicts by asking a sequence of yes/no questions about the features, and predicting the **average target** of the training rows that end up in the same final group (**leaf**).

```
                   yoy_lag0 ≤ 3.1 ?
                  /                \
               yes                  no
        mom_ma3 ≤ 0.25 ?        yoy_lag0 ≤ 5.4 ?
         /        \              /          \
   leaf: 1.6   leaf: 2.4   leaf: 4.2     leaf: 6.3
```

Each split is chosen to make the leaves as **homogeneous** as possible (minimising squared error). The result is a **piecewise-constant** function: the feature space is divided into rectangles, each with one prediction.

Economists can read this as a model of **regimes**: "when inflation is low and momentum weak, expect ~1.6% next year; when inflation is high and accelerating, expect ~6%". Trees capture **non-linearities** and **interactions** automatically, without you specifying them.

```python
from sklearn.tree import DecisionTreeRegressor, export_text

from forecasting.data import load_cpi
from forecasting.features import univariate_cpi_features

df = load_cpi()
X = univariate_cpi_features(df)
h = 12
data = X.join(df["cpi_yoy"].shift(-h).rename("target")).dropna()
train = data.loc[:"2019-12"]

tree = DecisionTreeRegressor(max_depth=2, random_state=0)
tree.fit(train.drop(columns="target"), train["target"])
print(export_text(tree, feature_names=list(X.columns)))
```

Read the printed rules. Which features did the tree choose? Do the thresholds make economic sense?

(Training on rows up to 2019-12 with *h* = 12 uses targets up to 2020-12. That's fine for **illustration**; for evaluation we always use the harness.)

---

## 62.2 Overfitting and the Depth Trade-Off (20 min)

A tree can keep splitting until every leaf holds **one** training row: a perfect in-sample fit, and terrible forecasts.

```python
import numpy as np
from sklearn.metrics import mean_squared_error

test = data.loc["2021-01":]
for depth in [1, 2, 3, 5, 8, None]:
    m = DecisionTreeRegressor(max_depth=depth, random_state=0).fit(
        train.drop(columns="target"), train["target"])
    rmse_in = np.sqrt(mean_squared_error(train["target"], m.predict(train.drop(columns="target"))))
    rmse_out = np.sqrt(mean_squared_error(test["target"], m.predict(test.drop(columns="target"))))
    print(f"depth={str(depth):>4}  in-sample RMSE={rmse_in:5.2f}  out-of-sample RMSE={rmse_out:5.2f}")
```

You'll see the classic pattern: in-sample error falls towards zero as depth grows; out-of-sample error first falls, then **rises**. That's bias–variance (61.1), visible in two columns.

The controls that limit a tree's flexibility:

| Parameter | Effect |
|---|---|
| `max_depth` | maximum number of successive questions |
| `min_samples_leaf` | a leaf must contain at least this many months (e.g. 12) |
| `max_features` | consider only a random subset of features at each split (used by forests) |

> The 2021–2023 test period contains the post-pandemic inflation surge, which lies **outside** most of the training data's range. Keep this in mind for 62.5.

---

## 62.3 Ensembles: Bagging and Random Forests (23 min)

Single trees are **unstable**: a small change in the data can change the first split and hence everything below it (high variance). The fix is to **average many trees**.

| Method | How | Reduces |
|---|---|---|
| **Bagging** | train each tree on a bootstrap resample of the rows; average predictions | variance |
| **Random forest** (Breiman, 2001) | bagging + each split considers only a random subset of features | variance, further, by de-correlating trees |

```python
from sklearn.ensemble import RandomForestRegressor

rf = RandomForestRegressor(n_estimators=500, min_samples_leaf=6, max_features=0.5,
                           random_state=0, n_jobs=-1)
rf.fit(train.drop(columns="target"), train["target"])
print("RF out-of-sample RMSE:",
      np.sqrt(mean_squared_error(test["target"], rf.predict(test.drop(columns="target")))))
```

Random forests are robust with little tuning, which is why they've performed well in some inflation-forecasting studies (e.g. Medeiros, Vasconcelos, Veiga and Zilberman, 2021, *Journal of Business & Economic Statistics*, for US inflation in a data-rich setting). Whether they help for *Canadian* inflation with *our* features is an empirical question, and your harness answers it.

> **Bootstrap and time series:** resampling rows ignores time ordering, but here it's used only to build *diverse trees within the training window*. Evaluation stays strictly rolling-origin, so no future information leaks.

---

## 62.4 Gradient Boosting from Scratch, then XGBoost (25 min)

Random forests build trees **independently** and average them. **Boosting** builds trees **sequentially**: each new tree is fitted to the **errors (residuals)** of the ensemble so far, and added with a small weight (the **learning rate**). The idea is due to Friedman (2001).

### Boosting in ten lines

```python
from sklearn.tree import DecisionTreeRegressor

Xtr, ytr = train.drop(columns="target"), train["target"]
Xte, yte = test.drop(columns="target"), test["target"]

learning_rate, n_rounds = 0.1, 200
pred_tr = np.full(len(ytr), ytr.mean())          # start from the mean
pred_te = np.full(len(yte), ytr.mean())
for m in range(n_rounds):
    residual = ytr - pred_tr                     # what the ensemble still gets wrong
    stump = DecisionTreeRegressor(max_depth=2).fit(Xtr, residual)
    pred_tr += learning_rate * stump.predict(Xtr)
    pred_te += learning_rate * stump.predict(Xte)
    if m in (0, 9, 49, 199):
        print(f"round {m+1:>3}: in-sample RMSE {np.sqrt(np.mean((ytr - pred_tr)**2)):.3f}  "
              f"out-of-sample RMSE {np.sqrt(np.mean((yte - pred_te)**2)):.3f}")
```

That's the whole idea: **start simple, then repeatedly correct the remaining errors with small trees, taking small steps.** The learning rate makes each correction cautious, so many small trees generalise better than a few large ones.

### XGBoost

**XGBoost** (Chen & Guestrin, 2016) is a fast, regularised implementation of gradient boosting, and one of the most widely used ML tools for tabular data.

```python
from xgboost import XGBRegressor

xgb = XGBRegressor(
    n_estimators=500,          # maximum number of trees
    learning_rate=0.03,        # shrinkage per tree
    max_depth=3,               # small trees
    min_child_weight=5,        # minimum (weighted) rows per leaf
    subsample=0.8,             # row subsampling per tree (adds randomness, reduces variance)
    colsample_bytree=0.8,      # feature subsampling per tree
    reg_lambda=1.0,            # L2 penalty on leaf values
    random_state=0,
)
xgb.fit(Xtr, ytr)
print("XGB out-of-sample RMSE:", np.sqrt(np.mean((yte - xgb.predict(Xte)) ** 2)))
```

### Early stopping: let validation data choose the number of trees

Too many trees overfit. **Early stopping** monitors error on a **validation set** and stops when it stops improving. For time series, the validation set must be the **most recent** part of the training window, never a random sample:

```python
split = int(len(Xtr) * 0.8)                      # last 20% of the training window
xgb_es = XGBRegressor(n_estimators=2000, learning_rate=0.03, max_depth=3,
                      subsample=0.8, colsample_bytree=0.8, random_state=0,
                      early_stopping_rounds=50)
xgb_es.fit(Xtr.iloc[:split], ytr.iloc[:split],
           eval_set=[(Xtr.iloc[split:], ytr.iloc[split:])], verbose=False)
print("best number of trees:", xgb_es.best_iteration + 1)
```

### Key XGBoost parameters

| Parameter | Typical range | Lower → | Higher → |
|---|---|---|---|
| `learning_rate` | 0.01–0.1 | more trees needed, often better generalisation | faster, riskier |
| `max_depth` | 2–6 | simpler interactions | more complex interactions, more variance |
| `n_estimators` | 100–2000 (with early stopping) | underfit | overfit (without early stopping) |
| `min_child_weight` | 1–20 | more flexible leaves | smoother predictions |
| `subsample`, `colsample_bytree` | 0.5–1.0 | more randomness, less variance | less randomness |
| `reg_lambda`, `reg_alpha` | 0–10 | weaker regularisation | stronger regularisation |

Systematic tuning of these, without leakage, is Day 64.

---

## 62.5 Trees Can't Extrapolate: What That Means for Macro Data (20 min)

Because tree predictions are **averages of training targets**, a tree model can **never predict a value outside the range it has seen**. For trending or level data this is a serious limitation.

```python
import matplotlib.pyplot as plt
from sklearn.linear_model import LinearRegression

lvl = df[["cpi"]].copy()
lvl["t"] = np.arange(len(lvl))                    # a time trend as the only feature
tr, te = lvl.loc[:"2019-12"], lvl.loc["2020-01":]

lin = LinearRegression().fit(tr[["t"]], tr["cpi"])
xgb_lvl = XGBRegressor(n_estimators=300, max_depth=3, learning_rate=0.05).fit(tr[["t"]], tr["cpi"])

plt.figure(figsize=(10, 4))
plt.plot(lvl.index, lvl["cpi"], label="CPI level (actual)")
plt.plot(te.index, lin.predict(te[["t"]]), label="linear trend")
plt.plot(te.index, xgb_lvl.predict(te[["t"]]), label="XGBoost")
plt.axvline(pd.Timestamp("2020-01-01"), linestyle="--", color="grey")
plt.legend(); plt.title("Trees can't extrapolate a trend"); plt.tight_layout()
plt.savefig("data/forecasts/extrapolation.png", dpi=120)
```

The XGBoost forecast of the CPI **level** goes **flat** at the last training value, while the price level keeps rising.

### Consequences for macro forecasting

| Do | Don't |
|---|---|
| model **stationary transformations**: growth rates, yoy inflation, changes, spreads | feed **levels** of trending series (CPI index, GDP in dollars, population) |
| express features relative to history (e.g. deviation from a moving average) | rely on trees to project trends |
| remember that **unprecedented values** (2021–22 inflation) are partly outside the training range | expect trees to forecast beyond historical extremes |

That's why our target is **yoy inflation**, not the CPI index, and why the Day 68 feature set uses rates, changes and spreads from the marts. Each of these is a transformation that dbt already computes (Days 19–20, 39).

---

## 62.6 Mini-Project: Trees in the Horse Race (23 min)

Add tree models to Day 61's comparison, using the same harness, horizons and test period. Add to `forecasting/models.py`:

```python
from sklearn.ensemble import RandomForestRegressor
from sklearn.tree import DecisionTreeRegressor
from xgboost import XGBRegressor


def tree_factory():
    return DecisionTreeRegressor(max_depth=3, min_samples_leaf=12, random_state=0)


def rf_factory():
    return RandomForestRegressor(n_estimators=300, min_samples_leaf=6, max_features=0.5,
                                 random_state=0, n_jobs=-1)


def xgb_factory():
    return XGBRegressor(n_estimators=300, learning_rate=0.03, max_depth=3, min_child_weight=5,
                        subsample=0.8, colsample_bytree=0.8, reg_lambda=1.0,
                        random_state=0, n_jobs=2)
```

```python
candidates.update({"tree": tree_factory, "random_forest": rf_factory, "xgboost": xgb_factory})
results = pd.concat([rolling_origin(X, y, f, H, "2012-01-01", name, refit_every=3)
                     for name, f in candidates.items()], ignore_index=True)
results.to_parquet("data/forecasts/day62_results.parquet")
print(score(results).round(3).to_string(index=False))
```

`refit_every=3` retrains every three months instead of every month, to keep the runtime reasonable. Note it in your results: refit frequency is part of the method.

### Questions to answer in `notebooks/day62.ipynb`

1. At which horizons, if any, do tree models beat the naive benchmark? Ridge?
2. Plot forecasts against actuals for *h* = 12, 2019–2025. How did each model handle the 2021–22 surge, and does 62.5 explain what you see?
3. Plot `xgb.feature_importances_` from a model fitted on the full training window. Which features matter? (Importances are a rough guide; Days 64–67 use SHAP for a principled explanation.)

### Day 62 checklist
- [ ] I can explain how regression trees split, predict, and capture regimes and interactions
- [ ] I can demonstrate overfitting with tree depth, and name the parameters that control it
- [ ] I understand bagging, random forests and boosting (and implemented boosting from scratch)
- [ ] I can fit XGBoost with sensible parameters and time-ordered early stopping
- [ ] I know trees can't extrapolate, and I model stationary transformations
- [ ] Trees, forests and XGBoost are in the horse race under identical, leak-free evaluation

```bash
git add forecasting notebooks && git commit -m "Day 62: trees, forests, boosting, XGBoost in the backtest" && git push
```

---

# DAY 63 — Univariate Forecasting

| Time | Block |
|---|---|
| 0:00 – 0:20 | 63.1 Univariate forecasting: why bother? |
| 0:20 – 0:45 | 63.2 Statistical benchmarks: AR models with `statsmodels` |
| 0:45 – 0:53 | Break |
| 0:53 – 1:15 | 63.3 Direct vs recursive multi-step forecasts |
| 1:15 – 1:40 | 63.4 Is the difference real? The Diebold–Mariano test |
| 1:40 – 1:48 | Break |
| 1:48 – 2:10 | 63.5 Prediction intervals: quantile models and coverage |
| 2:10 – 2:30 | 63.6 Capstone: a univariate leaderboard for CPI inflation |

---

## 63.1 Univariate Forecasting: Why Bother? (20 min)

A **univariate** model forecasts a series using **only its own history**. Why start there when we have a whole warehouse of other indicators?

1. **It's the benchmark.** Any multivariate model (Day 68) must beat the best univariate one, or the extra data isn't helping.
2. **It's robust.** It needs no other series to be published on time, so it can't be broken by another source's outage or revision.
3. **It's often surprisingly good.** Inflation is persistent, and its own past carries much of the predictable signal at short horizons. Forecasting research has repeatedly found simple univariate benchmarks hard to beat (e.g. Atkeson & Ohanian, 2001; Stock & Watson, 2007, *Journal of Money, Credit and Banking*).

### Choosing the transformation

| Series | Stationary transformation | Seasonality |
|---|---|---|
| CPI index (NSA) | yoy % change (removes seasonality), or mom % change | mom has strong seasonal patterns (Day 19); yoy doesn't |
| Real GDP (SAAR) | quarterly growth, annualised | already seasonally adjusted |
| Unemployment rate (SA) | level is roughly stationary over decades; changes are safer | already seasonally adjusted |

Our target, **yoy CPI inflation**, is seasonally neutral. Features based on **mom** changes carry seasonal patterns, which is why `month_of_year` is a feature (Day 61), letting trees learn month-specific behaviour.

---

## 63.2 Statistical Benchmarks: AR Models with `statsmodels` (25 min)

An **autoregression** AR(p) forecasts the series from its own last *p* values with a linear equation. It's the workhorse univariate benchmark.

`statsmodels` fits AR models and selects the lag order by an information criterion:

```python
from statsmodels.tsa.ar_model import AutoReg, ar_select_order

y = load_cpi()["cpi_yoy"]
sel = ar_select_order(y.loc[:"2011-12"], maxlag=13, ic="aic", old_names=False)
print("AIC-selected lags:", sel.ar_lags)

res = AutoReg(y.loc[:"2011-12"], lags=sel.ar_lags, old_names=False).fit()
print(res.summary().tables[1])
print(res.forecast(steps=12).round(2))
```

AR models forecast **recursively** (each step feeds the next). To compare them fairly with our direct ML models, run them through a rolling-origin loop on the **same origins and horizons**. Add to `forecasting/evaluate.py`:

```python
from statsmodels.tsa.ar_model import AutoReg, ar_select_order


def rolling_origin_ar(y: pd.Series, horizons, test_start: str, maxlag: int = 13,
                      model_name: str = "ar_aic", reselect_every: int = 12) -> pd.DataFrame:
    """AR(p) refitted at every origin (expanding window); p re-selected by AIC periodically."""
    rows, lags = [], None
    origins = y.index[y.index >= pd.Timestamp(test_start)]
    H = max(horizons)
    for i, t in enumerate(origins):
        hist = y.loc[:t]
        if lags is None or i % reselect_every == 0:
            lags = ar_select_order(hist, maxlag=maxlag, ic="aic", old_names=False).ar_lags or [1]
        path = AutoReg(hist, lags=lags, old_names=False).fit().forecast(steps=H)
        for h in horizons:
            t_target = t + pd.DateOffset(months=h)
            if t_target > y.index.max():
                continue
            rows.append({"model": model_name, "h": h, "origin": t, "target_date": t_target,
                         "forecast": float(path.iloc[h - 1]), "actual": float(y.loc[t_target])})
    return pd.DataFrame(rows)
```

Run it and add it to your Day 62 results:

```python
ar = rolling_origin_ar(y, H, "2012-01-01")
results = pd.concat([pd.read_parquet("data/forecasts/day62_results.parquet"), ar])
print(score(results).round(3).to_string(index=False))
```

How does AR(AIC) compare with XGBoost at each horizon?

> Other classic univariate models (ARIMA, exponential smoothing) are available in `statsmodels.tsa` and fit the same rolling pattern. An optional exercise: add `ExponentialSmoothing` or an `ARIMA(1,0,1)` and see whether either changes the ranking.

---

## 63.3 Direct vs Recursive Multi-Step Forecasts (23 min)

Day 61 introduced both strategies. Let's compare them with the **same** model class (XGBoost) and **pure lag features**, which recursive forecasting needs: every feature must itself be forecastable from predictions.

```python
from forecasting.features import lag_features
from forecasting.models import Naive, xgb_factory

LAGS = 12
XL = lag_features(y, LAGS, "yoy")               # yoy_lag0 … yoy_lag11 only


def recursive_forecast(model, last_values: list[float], steps: int) -> list[float]:
    """Iterate a 1-step model: each prediction becomes yoy_lag0 for the next step."""
    window, preds = list(last_values), []          # window[0] = most recent value
    for _ in range(steps):
        x = pd.DataFrame([window[:LAGS]], columns=[f"yoy_lag{k}" for k in range(LAGS)])
        p = float(model.predict(x)[0])
        preds.append(p)
        window = [p] + window[:-1]
    return preds


rows = []
origins = y.index[y.index >= "2012-01-01"]
target1 = y.shift(-1)
for i, t in enumerate(origins):
    if i % 3:                                       # refit every 3 months for speed
        continue
    train = XL.notna().all(axis=1) & target1.notna() & (XL.index.shift(1, freq="MS") <= t)
    m = xgb_factory().fit(XL[train], target1[train])
    path = recursive_forecast(m, XL.loc[t].tolist(), max(H))
    for h in H:
        t_target = t + pd.DateOffset(months=h)
        if t_target <= y.index.max():
            rows.append({"model": "xgb_recursive", "h": h, "origin": t,
                         "target_date": t_target, "forecast": path[h - 1],
                         "actual": float(y.loc[t_target])})
recursive = pd.DataFrame(rows)
direct = rolling_origin(XL, y, xgb_factory, H, "2012-01-01", "xgb_direct", refit_every=3)
naive = rolling_origin(XL, y, Naive, H, "2012-01-01", "naive", refit_every=3)
print(score(pd.concat([recursive, direct, naive])).round(3).to_string(index=False))
```

Typical findings, which you should verify on your data:
- At *h* = 1 the two strategies are identical by construction (both use a 1-step model).
- At longer horizons, recursive XGBoost forecasts often **flatten** or drift: errors compound, and the tree's limited range (62.5) means iterated predictions converge towards typical training values.
- Direct models avoid compounding, but each horizon has slightly fewer usable training rows (61.4).

---

## 63.4 Is the Difference Real? The Diebold–Mariano Test (25 min)

Model A has RMSE 0.95 and model B 1.00 at *h* = 6. Is A really better, or is that luck over ~150 test months? The **Diebold–Mariano (DM) test** (Diebold & Mariano, 1995, *Journal of Business & Economic Statistics*) asks whether the **average difference in losses** between two forecasts is zero.

1. For each test period, compute the **loss differential** *d* = (error_A)² − (error_B)².
2. Test whether the mean of *d* is zero, using a **HAC (Newey–West) standard error**. Forecast errors at horizon *h* overlap and are serially correlated, so ordinary standard errors would be too small.

This is a regression of *d* on a constant with HAC standard errors, a tool you know from econometrics:

```python
import statsmodels.api as sm


def diebold_mariano(results: pd.DataFrame, model_a: str, model_b: str, h: int) -> dict:
    """DM test of equal squared-error accuracy; negative stat favours model_a."""
    a = results[(results.model == model_a) & (results.h == h)].set_index("origin")
    b = results[(results.model == model_b) & (results.h == h)].set_index("origin")
    common = a.index.intersection(b.index)
    ea = a.loc[common, "forecast"] - a.loc[common, "actual"]
    eb = b.loc[common, "forecast"] - b.loc[common, "actual"]
    d = (ea ** 2 - eb ** 2).to_numpy()
    fit = sm.OLS(d, np.ones(len(d))).fit(cov_type="HAC", cov_kwds={"maxlags": max(h - 1, 0)})
    return {"model_a": model_a, "model_b": model_b, "h": h, "n": len(d),
            "mean_loss_diff": float(d.mean()), "dm_stat": float(fit.tvalues[0]),
            "p_value": float(fit.pvalues[0])}
```

Add it to `forecasting/evaluate.py` and test the best model at each horizon against the naive benchmark:

```python
for h in H:
    print(diebold_mariano(results, "xgboost", "naive", h))
```

| DM statistic | Interpretation (5% level, two-sided) |
|---|---|
| strongly negative, *p* < 0.05 | model A significantly more accurate than B |
| strongly positive, *p* < 0.05 | model B significantly more accurate |
| otherwise | no significant difference: you can't claim one is better |

Caveats worth knowing:
- With few test periods, DM can over-reject. Harvey, Leybourne and Newbold (1997) proposed a small-sample correction, which you may add as a refinement.
- Running many pairwise tests invites false discoveries. Pre-specify the comparisons that matter (best model vs naive, vs AR) rather than testing everything against everything.

> **The humbling lesson:** you'll often find that the "winning" model's advantage over the naive or AR benchmark is **not statistically significant**, especially at long horizons. Reporting that honestly is a mark of a good forecaster, not a failure.

---

## 63.5 Prediction Intervals: Quantile Models and Coverage (23 min)

A point forecast of "2.4%" hides the uncertainty. Policymakers want a range: *"we expect inflation between 1.6% and 3.3% with 80% probability."*

### Method 1: empirical intervals from past errors

Use the backtest errors themselves. For each horizon, take the 10th and 90th percentiles of past forecast errors and add them to the point forecast. It's simple, model-agnostic and easy to explain.

### Method 2: quantile regression with XGBoost

Instead of minimising squared error (which targets the **mean**), minimise the **quantile (pinball) loss**, which targets a chosen **quantile**. Recent XGBoost versions support this directly:

```python
def xgb_quantile_factory(alpha: float):
    return lambda: XGBRegressor(objective="reg:quantileerror", quantile_alpha=alpha,
                                n_estimators=300, learning_rate=0.03, max_depth=3,
                                subsample=0.8, colsample_bytree=0.8, random_state=0)

H6 = [6]
q10 = rolling_origin(X, y, xgb_quantile_factory(0.10), H6, "2012-01-01", "q10", refit_every=3)
q90 = rolling_origin(X, y, xgb_quantile_factory(0.90), H6, "2012-01-01", "q90", refit_every=3)
```

(If your XGBoost version rejects `reg:quantileerror`, use scikit-learn's `GradientBoostingRegressor(loss="quantile", alpha=...)`, which plugs into the same factory pattern.)

### Checking calibration: coverage

An 80% interval should contain the actual outcome about **80%** of the time. That's testable:

```python
iv = (q10.set_index("origin")[["forecast", "actual"]].rename(columns={"forecast": "lo"})
        .join(q90.set_index("origin")[["forecast"]].rename(columns={"forecast": "hi"})))
inside = (iv["actual"] >= iv["lo"]) & (iv["actual"] <= iv["hi"])
print(f"80% interval coverage at h=6: {inside.mean():.0%}  (n={len(iv)})")
print(f"average width: {(iv['hi'] - iv['lo']).mean():.2f} pp")
print("coverage by period:")
print(inside.groupby(iv.index.year).mean().round(2))
```

Look at coverage **by year**. Intervals calibrated on calm years typically **under-cover** in 2021–22: the model's sense of uncertainty came from a period of stable inflation. That's an important, honest finding to report.

| Coverage result | Meaning |
|---|---|
| close to the nominal level (e.g. 75–85% for 80%) | well calibrated |
| far below | intervals too narrow: **overconfident** |
| far above | intervals too wide: **underconfident** (uninformative) |

---

## 63.6 Capstone: A Univariate Leaderboard for CPI Inflation (20 min)

Produce a reproducible **leaderboard** script, `forecasting/univariate.py`, that:

1. Loads CPI from the mart (`load_cpi`, start 1992).
2. Runs the rolling-origin backtest from **2012-01** for horizons **1, 3, 6, 12** for: naive, historical mean, 2% target, AR(AIC), Ridge, random forest, XGBoost (direct) and XGBoost (recursive).
3. Computes MAE, RMSE and relative RMSE on **common origins**.
4. Runs Diebold–Mariano tests of every model against the **naive** benchmark at each horizon.
5. Computes 80% empirical-interval coverage for the best model at *h* = 6 and *h* = 12.
6. Writes `data/forecasts/univariate_leaderboard.parquet` and a short Markdown report, `data/forecasts/univariate_report.md`, that records the package versions, sample, test period and refit frequency.

<details>
<summary>Solution sketch</summary>

```python
"""Univariate CPI inflation leaderboard (Day 63)."""
import platform
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import sklearn
import statsmodels
import xgboost
from sklearn.linear_model import RidgeCV
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from forecasting.data import load_cpi
from forecasting.evaluate import diebold_mariano, rolling_origin, rolling_origin_ar, score
from forecasting.features import univariate_cpi_features
from forecasting.models import Constant, HistoricalMean, Naive, rf_factory, xgb_factory

OUT = Path("data/forecasts")
H, TEST_START, REFIT = [1, 3, 6, 12], "2012-01-01", 3


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    df = load_cpi()
    X, y = univariate_cpi_features(df), df["cpi_yoy"]

    factories = {
        "naive": Naive, "hist_mean": HistoricalMean, "target_2pct": Constant,
        "ridge": lambda: make_pipeline(StandardScaler(), RidgeCV(alphas=[0.1, 1, 10, 100])),
        "random_forest": rf_factory, "xgboost": xgb_factory,
    }
    results = pd.concat(
        [rolling_origin(X, y, f, H, TEST_START, n, refit_every=REFIT) for n, f in factories.items()]
        + [rolling_origin_ar(y, H, TEST_START)], ignore_index=True)

    board = score(results)
    dm = pd.DataFrame([diebold_mariano(results, m, "naive", h)
                       for m in results.model.unique() if m != "naive" for h in H])
    board = board.merge(dm.rename(columns={"model_a": "model"})[["model", "h", "dm_stat", "p_value"]],
                        on=["model", "h"], how="left")
    board.to_parquet(OUT / "univariate_leaderboard.parquet", index=False)
    results.to_parquet(OUT / "univariate_forecasts.parquet", index=False)

    report = [
        "# Univariate CPI inflation leaderboard",
        f"Generated {datetime.now(timezone.utc):%Y-%m-%d %H:%M UTC} · Python {platform.python_version()} · "
        f"xgboost {xgboost.__version__} · scikit-learn {sklearn.__version__} · "
        f"statsmodels {statsmodels.__version__}",
        f"Sample from {df.index.min():%Y-%m} · test origins from {TEST_START[:7]} · "
        f"refit every {REFIT} months · direct forecasts (AR: recursive)",
        "", board.round(3).to_markdown(index=False),
    ]
    (OUT / "univariate_report.md").write_text("\n".join(report))
    print("\n".join(report))


if __name__ == "__main__":
    main()
```

Add interval coverage (63.5) for the best model at h = 6 and h = 12 as a final section of the report.

</details>

```bash
python -m forecasting.univariate
```

### Interpreting your leaderboard

Write five sentences in `notebooks/day63.ipynb` answering:
1. Which model is best at each horizon, by relative RMSE?
2. Which advantages over the naive benchmark are statistically significant (DM)?
3. How did all models perform during the 2021–22 surge, and why?
4. Are the 80% intervals well calibrated? In which years do they fail?
5. What would you tell a central bank economist about univariate ML forecasts of Canadian inflation?

### Recap: Days 61–63

| Concept | You built |
|---|---|
| prediction vs inference; bias–variance | the conceptual frame for the module |
| forecast framing | origin, horizon, target, information set; direct datasets |
| honest evaluation | a rolling-origin harness that excludes future targets |
| benchmarks and metrics | naive, mean, target, AR(AIC); MAE, RMSE, relative RMSE |
| trees and ensembles | trees, forests, boosting from scratch, XGBoost with early stopping |
| limitations | no extrapolation; stationary targets |
| multi-step strategies | direct vs recursive, compared |
| statistical comparison | Diebold–Mariano with HAC standard errors |
| uncertainty | quantile models and empirical intervals, checked for coverage |

### Looking ahead: Days 64–67

- **Hyperparameter tuning** without leakage: time-series cross-validation inside the training window, then a single honest test.
- **SHAP values**: explaining *why* XGBoost forecasts what it does, globally and for each forecast (e.g. "which lags drove the 2022 forecast?").
- **Zero-shot forecasting with Chronos**: a pretrained time-series foundation model that forecasts CPI without being trained on it, evaluated in the same harness against today's leaderboard.

### Day 63 checklist
- [ ] I can explain why univariate models are the essential benchmark, and choose stationary, seasonally appropriate targets
- [ ] AR(AIC) is evaluated in the same rolling-origin framework as the ML models
- [ ] I compared direct and recursive multi-step strategies and can explain the differences
- [ ] I test forecast-accuracy differences with Diebold–Mariano (HAC), and report non-significance honestly
- [ ] I produce prediction intervals and check their coverage over time
- [ ] A reproducible leaderboard script records results, tests, coverage and environment details

```bash
git add forecasting notebooks && git commit -m "Day 63: AR benchmarks, direct vs recursive, DM tests, intervals, leaderboard" && git push
```
