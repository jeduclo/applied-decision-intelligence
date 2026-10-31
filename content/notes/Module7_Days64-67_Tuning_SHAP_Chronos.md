# Module 7 · Forecasting with XGBoost & Chronos
## Days 64–67: Hyperparameter Tuning, SHAP Explainability and Zero-Shot Forecasting with Chronos

**Audience:** MSc Economics students who completed Days 1–63
**Environment:** GitHub Codespaces · `.venv-ml` · `forecasting/` package and rolling-origin harness from Days 61–63 · `data/marts/ml_cpi_monthly.parquet`
**Time per day:** ~2.5 hours (including breaks and exercises)
**Goal by end of Day 67:** Students can tune XGBoost **without contaminating the test period**, explain every forecast with **SHAP values** (globally, for a single forecast, and as a decomposition over time), and evaluate a pretrained **time-series foundation model (Chronos)** zero-shot in the same harness. They finish with probabilistic scores and a combination forecast, and choose, with evidence, which models to carry into the Day 68–70 CPI and GDP forecasting system.

---

### Where we are

After Day 63 you have an honest **univariate leaderboard** for Canadian CPI inflation at horizons 1, 3, 6 and 12 months: naive, mean, target, AR(AIC), Ridge, random forest and XGBoost (direct and recursive), with Diebold–Mariano tests and interval coverage. Three questions remain open:

| Question | Day |
|---|---|
| Would XGBoost do better with **tuned** hyperparameters, and how do we tune without cheating? | 64 |
| **Why** does the model forecast what it does? Can we explain it to an economist? | 65–66 |
| Can a **pretrained foundation model**, never trained on our data, compete? | 67 |

### New files (by end of Day 67)

```
forecasting/
├── tuning.py               ← NEW: time-series CV, randomized search, Optuna, TunedXGB
├── explain.py              ← NEW: SHAP helpers, contributions per forecast, feature families
├── chronos_models.py       ← NEW: zero-shot Chronos in the rolling-origin framework
├── scoring.py              ← NEW: pinball loss, coverage, combinations
└── …                       (data, features, evaluate, models, univariate from Days 61–63)
data/forecasts/
├── tuning_*.parquet, explanations.parquet, chronos_*.parquet, leaderboard_day67.parquet
site/forecast_explained.html ← NEW dashboard page
```

Activate the modelling environment for all four days:

```bash
cd /workspaces/macro-data-course
source .venv-ml/bin/activate
pip install optuna shap
pip freeze > forecasting/requirements-ml.txt
```

---

# DAY 64 — Hyperparameter Tuning Without Leakage

| Time | Block |
|---|---|
| 0:00 – 0:20 | 64.1 Parameters, hyperparameters and the tuning trap |
| 0:20 – 0:45 | 64.2 Time-series cross-validation with a gap |
| 0:45 – 0:53 | Break |
| 0:53 – 1:15 | 64.3 Randomized search |
| 1:15 – 1:40 | 64.4 Bayesian optimisation with Optuna |
| 1:40 – 1:48 | Break |
| 1:48 – 2:08 | 64.5 Nested evaluation: tuning inside the rolling origin |
| 2:08 – 2:30 | 64.6 Mini-project: does tuning pay? |

---

## 64.1 Parameters, Hyperparameters and the Tuning Trap (20 min)

| | Parameters | Hyperparameters |
|---|---|---|
| what | learned from data during fitting | chosen **before** fitting |
| examples | tree splits and leaf values; regression coefficients | `max_depth`, `learning_rate`, `n_estimators`, `min_child_weight` |
| how chosen | the fitting algorithm | **you**, using validation evidence |

Tuning means trying many hyperparameter settings and keeping the best. The trap: **if "best" is judged on the test period, the test period stops being a test.** Its errors become optimistic, for the same reason that adding regressors raises in-sample R². With enough tries, something always looks good by chance.

### Three roles for data

> **Question it answers:** Which data should fit the model, which should choose its settings, and which should judge it only once?
>
> **Other questions you can answer the same way:**
> - Why can't I tune and evaluate on the same months?

```
|──────── training ────────|── validation ──|─────────── test (rolling origins) ───────────|
   fit parameters             choose hyper-      judge the final method, ONCE
                              parameters
```

For time series, the three blocks must be in **chronological order**, and in a rolling-origin backtest **each origin has its own training and validation** inside its own past (64.5).

> **Rule:** the test period may be used to evaluate a *method* (including how it tunes itself), never to choose settings. If you look at test results and then change the search space, you've tuned on the test, so say so honestly or set aside a fresh test period.

---

## 64.2 Time-Series Cross-Validation with a Gap (25 min)

> **Question it answers:** How do I validate a forecasting model only on periods that come after its training data?
>
> **Other questions you can answer the same way:**
> - How many validation folds can a monthly series support?

scikit-learn's `TimeSeriesSplit` creates **expanding-window** folds in chronological order:

```
fold 1: train [══════]        validate [──]
fold 2: train [════════]          validate [──]
fold 3: train [══════════]            validate [──]
```

### Why a gap is essential for horizon *h*

> **Question it answers:** How many months must separate training and validation so that 12-month-ahead targets don't leak?
>
> **Other questions you can answer the same way:**
> - Is my cross-validation secretly using future inflation?

Each row's target is *h* months ahead (Day 61). A training row at the end of a fold has a target date **inside** the validation period, which a real forecaster standing at the start of validation wouldn't yet know. That's the same trap as Day 61.4, inside cross-validation. The fix is a **gap of *h* rows** between training and validation:

```python
from sklearn.model_selection import TimeSeriesSplit

h = 12
cv = TimeSeriesSplit(n_splits=4, test_size=24, gap=h)

from forecasting.data import load_cpi
from forecasting.features import univariate_cpi_features

df = load_cpi()
X = univariate_cpi_features(df)
target = df["cpi_yoy"].shift(-h).rename("target")
data = X.join(target).dropna().loc[:"2011-12"]       # tuning happens BEFORE the test period
Xtr, ytr = data.drop(columns="target"), data["target"]

for k, (tr, va) in enumerate(cv.split(Xtr)):
    print(f"fold {k}: train {Xtr.index[tr[0]]:%Y-%m}→{Xtr.index[tr[-1]]:%Y-%m}  "
          f"validate {Xtr.index[va[0]]:%Y-%m}→{Xtr.index[va[-1]]:%Y-%m}")
```

Check the printout: between the last training month and the first validation month there are exactly *h* skipped rows. The last training row's **target** date then falls just before validation starts. No future information leaks.

| `TimeSeriesSplit` argument | Meaning |
|---|---|
| `n_splits` | number of folds |
| `test_size` | rows per validation fold (24 = two years) |
| `gap` | rows skipped between train and validation; set to the forecast horizon *h* |

---

## 64.3 Randomized Search (23 min)

> **Question it answers:** Which XGBoost settings give the lowest validation error, found by trying random combinations?
>
> **Other questions you can answer the same way:**
> - Which hyperparameters matter most for this inflation model?

**Grid search** tries every combination: with 6 hyperparameters and 4 values each, that's 4,096 settings × folds. **Randomized search** samples a fixed number of settings from **distributions**, and usually finds equally good settings much faster (most hyperparameters matter little; random sampling explores the important ones more efficiently).

Create `forecasting/tuning.py`:

```python
"""Hyperparameter tuning for direct-horizon models, without leakage."""
import numpy as np
from scipy.stats import loguniform, randint, uniform
from sklearn.model_selection import RandomizedSearchCV, TimeSeriesSplit
from xgboost import XGBRegressor

XGB_SPACE = {
    "n_estimators": randint(100, 800),
    "learning_rate": loguniform(0.01, 0.2),        # log scale: 0.01 and 0.1 equally likely to be explored
    "max_depth": randint(2, 6),
    "min_child_weight": randint(1, 20),
    "subsample": uniform(0.5, 0.5),                # uniform on [0.5, 1.0]
    "colsample_bytree": uniform(0.5, 0.5),
    "reg_lambda": loguniform(0.1, 20),
}


def ts_cv(h: int, n_splits: int = 4, val_size: int = 24) -> TimeSeriesSplit:
    return TimeSeriesSplit(n_splits=n_splits, test_size=val_size, gap=h)


def random_search_xgb(X, y, h: int, n_iter: int = 30, seed: int = 0) -> RandomizedSearchCV:
    search = RandomizedSearchCV(
        XGBRegressor(random_state=seed, n_jobs=2),
        XGB_SPACE, n_iter=n_iter, cv=ts_cv(h),
        scoring="neg_root_mean_squared_error", random_state=seed, n_jobs=1, refit=True)
    return search.fit(X, y)
```

```python
search = random_search_xgb(Xtr, ytr, h=12, n_iter=40)
print("best CV RMSE:", -search.best_score_)
print("best params:", search.best_params_)

import pandas as pd
cvres = pd.DataFrame(search.cv_results_).sort_values("rank_test_score")
print(cvres[["param_max_depth", "param_learning_rate", "param_n_estimators",
             "mean_test_score", "std_test_score"]].head(10))
```

Look at `std_test_score`: if the top settings' scores differ by less than their fold-to-fold standard deviation, they're **statistically indistinguishable**. Prefer the **simpler** one (shallower trees, fewer estimators).

`loguniform(0.01, 0.2)` samples on a logarithmic scale. For parameters spanning orders of magnitude (learning rates, penalties), that's the natural choice.

---

## 64.4 Bayesian Optimisation with Optuna (25 min)

> **Question it answers:** Can a smarter search find good settings in fewer trials, by learning from earlier attempts?
>
> **Other questions you can answer the same way:**
> - How many trials does Optuna need compared with random search?

Randomized search ignores what it has learned. **Bayesian optimisation** uses past trials to propose more promising settings. **Optuna** is a popular library implementing this (with its default TPE sampler).

Add to `forecasting/tuning.py`:

```python
import optuna


def optuna_xgb(X, y, h: int, n_trials: int = 50, seed: int = 0):
    cv = ts_cv(h)

    def objective(trial):
        params = {
            "n_estimators": trial.suggest_int("n_estimators", 100, 800),
            "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.2, log=True),
            "max_depth": trial.suggest_int("max_depth", 2, 5),
            "min_child_weight": trial.suggest_int("min_child_weight", 1, 20),
            "subsample": trial.suggest_float("subsample", 0.5, 1.0),
            "colsample_bytree": trial.suggest_float("colsample_bytree", 0.5, 1.0),
            "reg_lambda": trial.suggest_float("reg_lambda", 0.1, 20, log=True),
        }
        scores = []
        for tr, va in cv.split(X):
            m = XGBRegressor(**params, random_state=seed, n_jobs=2).fit(X.iloc[tr], y.iloc[tr])
            scores.append(np.sqrt(np.mean((y.iloc[va] - m.predict(X.iloc[va])) ** 2)))
        return float(np.mean(scores))

    optuna.logging.set_verbosity(optuna.logging.WARNING)
    study = optuna.create_study(direction="minimize",
                                sampler=optuna.samplers.TPESampler(seed=seed))
    study.optimize(objective, n_trials=n_trials)
    return study
```

```python
study = optuna_xgb(Xtr, ytr, h=12, n_trials=60)
print("best CV RMSE:", study.best_value)
print("best params:", study.best_params)
print("which hyperparameters mattered:",
      optuna.importance.get_param_importances(study))
```

The **parameter importances** answer a practical question: *which knobs are worth tuning?* Often `learning_rate` and `max_depth` dominate, and the rest barely matter. Narrowing the search to the important ones makes later tuning faster and more stable.

| Search method | Strength | Weakness |
|---|---|---|
| grid | exhaustive, simple | explodes combinatorially |
| randomized | cheap, surprisingly effective | doesn't learn from results |
| Bayesian (Optuna) | sample-efficient; reports parameter importance | more machinery; still noisy with small samples |

> **Macro reality check:** with ~240 monthly training rows and validation folds of 24 months, CV estimates are **noisy**. Tuning can easily chase noise. That's why the next block evaluates the *whole tuning procedure* out of sample.

---

## 64.5 Nested Evaluation: Tuning Inside the Rolling Origin (20 min)

> **Question it answers:** Would tuning the model on past data only have improved real-time forecasts?
>
> **Other questions you can answer the same way:**
> - Is the tuned model's advantage real or an illusion of tuning on the test period?

To know whether tuning **helps forecasts**, evaluate the **procedure** "tune on the past, then forecast" in the rolling-origin harness. At each refit, the model tunes itself using only data available at that origin. That's **nested** evaluation: inner loop (tuning CV) inside outer loop (rolling origins).

Add a self-tuning estimator to `forecasting/tuning.py`:

```python
class TunedXGB:
    """An XGBoost that tunes its own hyperparameters on its training data (time-series CV)."""

    def __init__(self, h: int, n_iter: int = 20, seed: int = 0):
        self.h, self.n_iter, self.seed = h, n_iter, seed

    def fit(self, X, y):
        search = random_search_xgb(X, y, self.h, self.n_iter, self.seed)
        self.best_params_ = search.best_params_
        self.model_ = search.best_estimator_
        return self

    def predict(self, X):
        return self.model_.predict(X)
```

Because the gap depends on *h*, build one factory per horizon and call the harness horizon by horizon:

```python
from forecasting.evaluate import rolling_origin
from forecasting.tuning import TunedXGB

tuned = pd.concat([
    rolling_origin(X, df["cpi_yoy"], (lambda h=h: TunedXGB(h, n_iter=20)), [h],
                   "2012-01-01", "xgb_tuned", refit_every=12)
    for h in [1, 3, 6, 12]], ignore_index=True)
tuned.to_parquet("data/forecasts/tuning_nested.parquet")
```

- `refit_every=12` re-tunes **once a year** of origins, a realistic cadence and affordable compute: about 14 tunings × 20 settings × 4 folds per horizon.
- `lambda h=h: ...` freezes the loop variable (the same gotcha as Day 22).
- Expect this to take several minutes. Run it in a terminal (`python -c "..."`) or let a notebook cell run while you read 64.6.

---

## 64.6 Mini-Project: Does Tuning Pay? (23 min)

> **Question it answers:** Does the tuned XGBoost beat the default XGBoost and the benchmarks, and is the improvement significant?
>
> **Other questions you can answer the same way:**
> - Is tuning worth the extra computing time?

1. Load the Day 63 forecasts (`data/forecasts/univariate_forecasts.parquet`) and add `xgb_tuned`.
2. Score with `score()` and run Diebold–Mariano tests: **`xgb_tuned` vs `xgboost` (default)**, and **`xgb_tuned` vs `naive`**, at each horizon.
3. Inspect how the chosen hyperparameters **changed over time**. Store `best_params_` per refit by adding a hook in `TunedXGB.fit` that appends `{origin_end: X.index.max(), **best_params_}` to a list, then plot `max_depth` and `learning_rate` across refits.
4. Write a short conclusion in `notebooks/day64.ipynb`.

```python
import pandas as pd

from forecasting.evaluate import diebold_mariano, score

prev = pd.read_parquet("data/forecasts/univariate_forecasts.parquet")
allres = pd.concat([prev, pd.read_parquet("data/forecasts/tuning_nested.parquet")])
print(score(allres).query("model in ['naive', 'ar_aic', 'xgboost', 'xgb_tuned']").round(3))
for h in [1, 3, 6, 12]:
    print(diebold_mariano(allres, "xgb_tuned", "xgboost", h))
```

<details>
<summary>What students typically find, and why it matters</summary>

Gains from tuning are often **small and not statistically significant** for a univariate macro series of this length. Default settings that are already conservative (shallow trees, low learning rate, subsampling) capture most of the benefit. The chosen hyperparameters often **jump around** between refits, a sign that the CV objective is flat and noisy.

The professional conclusion isn't "tuning is useless". It's: **use sensible conservative defaults; tune only the parameters that matter; and always evaluate the tuning procedure out of sample before claiming gains.** With richer feature sets (Day 68), tuning tends to matter more.

</details>

### Day 64 checklist
- [ ] I can distinguish parameters from hyperparameters, and explain why tuning on the test period invalidates it
- [ ] My time-series CV uses chronological folds with a gap equal to the horizon
- [ ] I can run randomized search and Optuna, and read CV variability and parameter importances
- [ ] I evaluated "tune-then-forecast" as a procedure, nested inside the rolling origin
- [ ] I reported whether tuning helped, with Diebold–Mariano evidence

```bash
git add forecasting notebooks && git commit -m "Day 64: leak-free tuning, randomized search, Optuna, nested evaluation" && git push
```

---

# DAY 65 — SHAP Explainability: Fundamentals

| Time | Block |
|---|---|
| 0:00 – 0:20 | 65.1 Why explain forecasts, and why feature importance isn't enough |
| 0:20 – 0:45 | 65.2 Shapley values: a fair way to share a prediction |
| 0:45 – 0:53 | Break |
| 0:53 – 1:20 | 65.3 TreeSHAP for XGBoost: global explanations |
| 1:20 – 1:40 | 65.4 Explaining a single forecast: waterfall plots |
| 1:40 – 1:48 | Break |
| 1:48 – 2:08 | 65.5 Out-of-sample importance: permutation importance |
| 2:08 – 2:30 | 65.6 What SHAP does *not* tell you · mini-project |

---

## 65.1 Why Explain Forecasts? (20 min)

A Bank of Canada economist presented with *"the model forecasts 3.1% inflation in 12 months"* will immediately ask **why**. Explanations serve several purposes:

| Purpose | Question |
|---|---|
| **Trust** | does the model rely on sensible signals, or on artefacts? |
| **Communication** | can the forecast be narrated ("persistence is fading, momentum is rising")? |
| **Debugging** | is a feature leaking the future, or broken by a data error? |
| **Monitoring** | have the model's drivers changed (Day 66)? |

### The limits of built-in "feature importance"

XGBoost's `feature_importances_` (Day 62) has problems:
- it measures how much a feature was **used in training** (e.g. total gain), not how much it matters for **forecasts**;
- it is **global only**: it can't explain *this* forecast;
- it's biased towards features with many possible split points, and it splits credit arbitrarily among **correlated** features (our yoy lags are highly correlated);
- it has **no sign**: does a feature push the forecast up or down?

**SHAP values** fix most of these issues, with a solid theoretical foundation.

---

## 65.2 Shapley Values: A Fair Way to Share a Prediction (25 min)

### The idea from cooperative game theory

Lloyd Shapley (Nobel Prize in Economics, 2012) asked: *several players cooperate to produce a payoff; how should it be divided fairly?* His answer: give each player their **average marginal contribution** across all orders in which the players could have joined.

SHAP (Lundberg & Lee, 2017) applies this to predictions:
- the **players** are the features;
- the **payoff** is the difference between **this prediction** and the **average prediction** (the *base value*).

### A tiny example by hand

Suppose a model forecasts inflation from two features, current inflation *A* and momentum *B*. Average prediction (base value): **2.0%**. For one month:

| Features known | Prediction |
|---|---|
| none (base value) | 2.0 |
| A only | 3.0 |
| B only | 2.4 |
| A and B | 3.6 |

The two possible joining orders:
- **A first, then B:** A adds 3.0 − 2.0 = **1.0**; B adds 3.6 − 3.0 = **0.6**.
- **B first, then A:** B adds 2.4 − 2.0 = **0.4**; A adds 3.6 − 2.4 = **1.2**.

Average over orders: **φ_A = (1.0 + 1.2)/2 = 1.1** and **φ_B = (0.6 + 0.4)/2 = 0.5**.

Check: base value + φ_A + φ_B = 2.0 + 1.1 + 0.5 = **3.6**, exactly the prediction.

### Properties that make SHAP attractive

| Property | Meaning |
|---|---|
| **Additivity (efficiency)** | base value + sum of SHAP values = the prediction, exactly |
| **Symmetry** | two features contributing identically get equal credit |
| **Dummy** | a feature the model never uses gets zero |
| **Sign** | positive values push the forecast up; negative values push it down |

Additivity is what makes SHAP perfect for economists: it's a **decomposition**, just like the CPI contributions on Day 19 (components summing to headline) or growth accounting.

> With many features there are too many orderings to enumerate. **TreeSHAP** (Lundberg et al., 2020) computes **exact** Shapley values for tree ensembles efficiently by exploiting the tree structure. That's why SHAP pairs so well with XGBoost.

---

## 65.3 TreeSHAP for XGBoost: Global Explanations (28 min)

> **Question it answers:** How much did each feature push each inflation forecast up or down?
>
> **Other questions you can answer the same way:**
> - Which inputs does the model rely on?

Create `forecasting/explain.py`:

```python
"""SHAP helpers for tree models (XGBoost)."""
import numpy as np
import pandas as pd
import xgboost as xgb


def xgb_contributions(model, X: pd.DataFrame) -> pd.DataFrame:
    """Exact TreeSHAP contributions computed by XGBoost itself.

    Returns one column per feature plus 'base_value'; each row sums to the prediction.
    """
    booster = model.get_booster()
    contrib = booster.predict(xgb.DMatrix(X), pred_contribs=True)
    out = pd.DataFrame(contrib, index=X.index, columns=list(X.columns) + ["base_value"])
    return out


def check_additivity(model, X: pd.DataFrame, contrib: pd.DataFrame, tol: float = 1e-3):
    recon = contrib.sum(axis=1).to_numpy()
    pred = model.predict(X)
    gap = np.abs(recon - pred).max()
    assert gap < tol, f"SHAP additivity violated: max gap {gap}"
    return gap
```

XGBoost can compute SHAP contributions **natively** (`pred_contribs=True`). It's robust across versions and needs no extra library. The `shap` package adds rich plotting on top.

### Fit a model to explain

> **Question it answers:** Which 12-month-ahead inflation model am I going to explain?
>
> **Other questions you can answer the same way:**
> - How do I prepare a model and data for explanation?

```python
import matplotlib.pyplot as plt
import shap

from forecasting.data import load_cpi
from forecasting.features import univariate_cpi_features
from forecasting.models import xgb_factory

df = load_cpi()
X = univariate_cpi_features(df)
h = 12
target = df["cpi_yoy"].shift(-h)
train = X.notna().all(axis=1) & target.notna()

model = xgb_factory().fit(X[train], target[train])
X_explain = X[X.notna().all(axis=1)].loc["2012-01":]
contrib = xgb_contributions(model, X_explain)
print("additivity gap:", check_additivity(model, X_explain, contrib))
```

(This model is trained on all available rows, which is fine for *explaining the model*. For forecasts we always use the rolling harness. Day 66 explains each real-time forecast.)

### Global picture: which features drive forecasts, and in which direction?

> **Question it answers:** Which features matter most for the 12-month inflation forecast, and do high values push forecasts up or down?
>
> **Other questions you can answer the same way:**
> - Does current inflation or recent momentum drive the forecast more?

```python
explanation = shap.Explanation(values=contrib.drop(columns="base_value").to_numpy(),
                               base_values=contrib["base_value"].to_numpy(),
                               data=X_explain.to_numpy(),
                               feature_names=list(X_explain.columns))

shap.plots.bar(explanation, max_display=12, show=False)
plt.tight_layout(); plt.savefig("data/forecasts/shap_bar_h12.png", dpi=120); plt.close()

shap.plots.beeswarm(explanation, max_display=12, show=False)
plt.tight_layout(); plt.savefig("data/forecasts/shap_beeswarm_h12.png", dpi=120); plt.close()
```

How to read them:
- **Bar plot:** mean |SHAP| per feature, i.e. average impact on forecasts in percentage points of inflation. Unlike gain importance, this is in the **units of the forecast**.
- **Beeswarm:** each dot is one month. Horizontal position = SHAP value (push up or down); colour = the feature's value (red high, blue low). A feature whose red dots sit on the right pushes forecasts **up when it is high**.

> We build the `shap.Explanation` from XGBoost's own contributions. If `shap.TreeExplainer(model)` works with your versions, it gives the same numbers. Using `pred_contribs` avoids occasional version mismatches between `shap` and `xgboost`.

### Try it 65.3

From the beeswarm for *h* = 12: does high current inflation (`yoy_lag0`) push the 12-month-ahead forecast up as much as you'd expect from a random walk? What does that suggest about how the model treats persistence at long horizons?

<details>
<summary>Discussion</summary>

Typically `yoy_lag0` and the moving averages dominate and push forecasts up when inflation is high, but **less than one-for-one**: high inflation today raises the 12-month forecast by less than its own distance from the mean. That's **mean reversion**, which an inflation-targeting regime makes plausible. The model has learned that deviations from ~2% tend to shrink over a year. It's an economically sensible pattern, and SHAP made it visible.

</details>

---

## 65.4 Explaining a Single Forecast: Waterfall Plots (20 min)

> **Question it answers:** Why did the model forecast this particular inflation number in June 2021, and what is driving the latest forecast?
>
> **Other questions you can answer the same way:**
> - What would I tell a policymaker about why the forecast went up?

Global plots describe the model. **Local** explanations describe **one forecast**, which is what an economist asks about in a briefing.

```python
def waterfall(origin: str, path: str):
    i = list(X_explain.index).index(pd.Timestamp(origin))
    shap.plots.waterfall(explanation[i], max_display=10, show=False)
    plt.title(f"Why the model forecast {model.predict(X_explain.iloc[[i]])[0]:.2f}% "
              f"for {pd.Timestamp(origin) + pd.DateOffset(months=h):%b %Y}")
    plt.tight_layout(); plt.savefig(path, dpi=120); plt.close()

waterfall("2021-06-01", "data/forecasts/waterfall_2021_06.png")   # as inflation began to surge
waterfall(str(X_explain.index.max().date()), "data/forecasts/waterfall_latest.png")
```

A waterfall starts at the **base value** (the average forecast), adds each feature's contribution as a bar (red up, blue down), and ends at **this forecast**. It's a growth-accounting chart for a single prediction.

Write a **two-sentence narrative** for each waterfall, the way you'd brief a policymaker:

> *"The model expects inflation to ease to 2.4% by June 2027. Current inflation (+0.6pp) still pushes the forecast above average, but slowing 3-month momentum (−0.3pp) points to further easing."*

---

## 65.5 Out-of-Sample Importance: Permutation Importance (20 min)

> **Question it answers:** Which features actually improve out-of-sample forecast accuracy, rather than just being used by the model?
>
> **Other questions you can answer the same way:**
> - Could I drop a feature without losing accuracy?

SHAP explains how the model **uses** features. **Permutation importance** asks a different, complementary question: *how much worse do forecasts become if a feature's information is destroyed?* It's measured **out of sample**, on data the model didn't train on.

The method: shuffle one feature's column in the test data (breaking its link with the target), re-predict, and measure the increase in error.

```python
from sklearn.inspection import permutation_importance

cut = "2015-12"
tr = train & (X.index <= cut)
te = X.notna().all(axis=1) & target.notna() & (X.index > cut)
m = xgb_factory().fit(X[tr], target[tr])

perm = permutation_importance(m, X[te], target[te], scoring="neg_root_mean_squared_error",
                              n_repeats=30, random_state=0)
imp = (pd.Series(perm.importances_mean, index=X.columns)
         .sort_values(ascending=False))
print(imp.head(10).round(3))           # increase in RMSE (pp) when the feature is shuffled
```

| Method | Answers | Data used |
|---|---|---|
| SHAP | how does the model use each feature, per forecast? | any (usually training or recent data) |
| Permutation importance | how much does each feature help **accuracy**? | **held-out** data |

A feature with large SHAP values but **near-zero** permutation importance is used heavily but doesn't improve out-of-sample accuracy. That's often the case for one of several **correlated** features: shuffling one lag hurts little because its neighbours carry the same information.

---

## 65.6 What SHAP Does *Not* Tell You · Mini-Project (23 min)

| SHAP is | SHAP is not |
|---|---|
| an exact decomposition of **the model's** prediction | a statement about **the economy** |
| descriptive of learned associations | **causal**: "momentum causes inflation" doesn't follow |
| sensitive to how correlated features share credit | a unique ranking when features are near-duplicates |
| relative to a **base value** (the training average) | an absolute measure of a feature's "effect" |

> If an economist asks *"what would happen to inflation if the Bank raised rates?"*, SHAP cannot answer. That's a **causal** question, the subject of Module 8 (DoubleML).

### Mini-project: an explanation memo

In `notebooks/day65.ipynb`, produce a one-page **explanation memo** for the latest *h* = 12 forecast:

1. The forecast and its 80% interval (Day 63 method).
2. The waterfall plot, and your two-sentence narrative.
3. The global bar plot, with one sentence on what drives the model in general.
4. Permutation importance, and one sentence on which features **actually** help accuracy.
5. One explicit caveat about what the explanation does **not** show.

### Day 65 checklist
- [ ] I can explain why gain-based feature importance is insufficient
- [ ] I can compute Shapley values by hand for a two-feature example, and state their properties
- [ ] I compute exact TreeSHAP contributions with XGBoost and verify additivity
- [ ] I produce and read bar, beeswarm and waterfall plots, and narrate a forecast
- [ ] I contrast SHAP with out-of-sample permutation importance
- [ ] I can state clearly what SHAP explanations do not mean

```bash
git add forecasting notebooks && git commit -m "Day 65: Shapley values, TreeSHAP, waterfalls, permutation importance" && git push
```

---

# DAY 66 — SHAP in Practice: Explanations Over Time

| Time | Block |
|---|---|
| 0:00 – 0:28 | 66.1 Explaining every real-time forecast |
| 0:28 – 0:48 | 66.2 Feature families: a forecast decomposition like CPI contributions |
| 0:48 – 0:55 | Break |
| 0:55 – 1:18 | 66.3 Non-linearities and interactions: dependence plots |
| 1:18 – 1:38 | 66.4 Explanation drift: are the model's drivers stable? |
| 1:38 – 1:45 | Break |
| 1:45 – 2:30 | 66.5 Mini-project: a "forecast explained" dashboard page |

---

## 66.1 Explaining Every Real-Time Forecast (28 min)

> **Question it answers:** For every forecast made in the backtest, what were the feature contributions at that time?
>
> **Other questions you can answer the same way:**
> - How did the drivers of the forecast change during 2021–22?

Day 65 explained one model fitted on all data. But in the backtest, each origin's forecast came from a model **refitted on data available at that time**. To narrate history honestly ("in mid-2021 the model forecast X **because** Y"), explain each forecast **with the model that made it**.

Extend the harness in `forecasting/evaluate.py` with an optional **explainer callback**:

```python
def rolling_origin(X, y, model_factory, horizons, test_start, model_name,
                   refit_every=1, min_train=60, explainer=None):
    """… as Day 61; if `explainer(model, X_row)` is given, store its output per forecast."""
    rows, explanations = [], []
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
                break
            train = feature_ok & target.notna() & (target_dates <= t)
            if train.sum() < min_train or not feature_ok.loc[t]:
                continue
            if model is None or i % refit_every == 0:
                model = model_factory()
                model.fit(X[train], target[train])
            x_row = X.loc[[t]]
            pred = float(model.predict(x_row)[0])
            rows.append({"model": model_name, "h": h, "origin": t, "target_date": t_target,
                         "forecast": pred, "actual": float(y.loc[t_target])})
            if explainer is not None:
                e = explainer(model, x_row).iloc[0]
                explanations += [{"model": model_name, "h": h, "origin": t, "feature": f,
                                  "contribution": float(v)} for f, v in e.items()]

    res = pd.DataFrame(rows)
    if explainer is not None:
        res.attrs["explanations"] = pd.DataFrame(explanations)
    return res
```

Run it:

```python
from forecasting.explain import xgb_contributions

res = rolling_origin(X, df["cpi_yoy"], xgb_factory, [1, 3, 6, 12], "2012-01-01",
                     "xgboost", refit_every=3, explainer=xgb_contributions)
expl = res.attrs["explanations"]
expl.to_parquet("data/forecasts/explanations.parquet", index=False)
res.to_parquet("data/forecasts/xgb_explained_forecasts.parquet", index=False)
```

Verify additivity **per forecast**: for each (h, origin), the contributions (including `base_value`) must sum to the stored forecast:

```python
recon = expl.groupby(["h", "origin"])["contribution"].sum()
check = res.set_index(["h", "origin"])["forecast"]
print("max additivity gap:", (recon - check).abs().max())
```

---

## 66.2 Feature Families: A Forecast Decomposition Like CPI Contributions (20 min)

> **Question it answers:** How much of each forecast comes from persistence, momentum and seasonality, like a contributions chart?
>
> **Other questions you can answer the same way:**
> - Is the forecast high because inflation is high, or because it is accelerating?

Twelve individual lags are too detailed for a briefing. Because SHAP values are **additive**, you can **sum** them over groups of related features, and the group totals still add up to the forecast.

Add to `forecasting/explain.py`:

```python
FAMILIES = {
    "persistence": lambda f: f.startswith("yoy_lag") or f.startswith("yoy_ma"),
    "momentum":    lambda f: f.startswith("mom_"),
    "seasonality": lambda f: f == "month_of_year",
}


def family_of(feature: str) -> str:
    if feature == "base_value":
        return "base_value"
    for name, rule in FAMILIES.items():
        if rule(feature):
            return name
    return "other"


def family_decomposition(expl: pd.DataFrame) -> pd.DataFrame:
    """Wide table: one row per (h, origin), one column per family; rows sum to the forecast."""
    return (expl.assign(family=expl["feature"].map(family_of))
                .groupby(["h", "origin", "family"])["contribution"].sum()
                .unstack("family").reset_index())
```

Plot the *h* = 12 decomposition over time as **stacked bars around the base value**, with the forecast and the eventual outcome as lines. It's the same visual language as the notebook's CPI component chart (Module 05) and Day 19's contributions:

```python
dec = family_decomposition(expl).query("h == 12").set_index("origin").sort_index()
fc = res.query("h == 12").set_index("origin")

fig, ax = plt.subplots(figsize=(11, 4.5))
bottom_pos = dec["base_value"].copy()
bottom_neg = dec["base_value"].copy()
for fam, colour in [("persistence", "#4A90D9"), ("momentum", "#D4924A"), ("seasonality", "#7B5EA7")]:
    v = dec.get(fam, 0)
    pos, neg = v.clip(lower=0), v.clip(upper=0)
    ax.bar(dec.index, pos, bottom=bottom_pos, width=25, color=colour, label=fam)
    ax.bar(dec.index, neg, bottom=bottom_neg, width=25, color=colour)
    bottom_pos += pos
    bottom_neg += neg
ax.plot(dec.index, dec["base_value"], color="grey", lw=1, label="base value")
ax.plot(fc.index, fc["forecast"], color="black", lw=1.5, label="forecast (12m ahead)")
ax.plot(fc.index, fc["actual"], color="#C95555", lw=1.5, ls="--", label="outcome")
ax.set_title("What drove the 12-month-ahead CPI inflation forecast?")
ax.legend(ncol=3, fontsize=8); plt.tight_layout()
plt.savefig("data/forecasts/decomposition_h12.png", dpi=120)
```

Questions for discussion:
- In 2021, when inflation began to rise, which family pushed the forecast up first?
- When the forecast badly missed the 2022 peak, what did the decomposition show? Was the model **unable** to forecast that far above its training range (Day 62.5)?

---

## 66.3 Non-Linearities and Interactions: Dependence Plots (23 min)

> **Question it answers:** How does the effect of current inflation on the forecast change with its level and with momentum?
>
> **Other questions you can answer the same way:**
> - Does the model treat high inflation differently from low inflation?

A **dependence plot** shows how a feature's SHAP value varies with the feature's value: the model's learned **response curve**, with interactions revealed by colour.

```python
shap.plots.scatter(explanation[:, "yoy_lag0"], color=explanation[:, "mom_ma3"], show=False)
plt.title("Effect of current inflation on the 12-month forecast, coloured by momentum")
plt.tight_layout(); plt.savefig("data/forecasts/dependence_yoy_lag0.png", dpi=120); plt.close()
```

(`explanation` is the Day 65 object built from a full-sample model.)

How to read it:
- A **straight upward line** means a linear effect.
- **Flattening** at high values means the effect saturates (and remember that trees can't extrapolate beyond training values).
- **Vertical spread with colour structure** means an **interaction**: the effect of current inflation depends on momentum.

### Try it 66.3

Make dependence plots for `mom_ma3` and `month_of_year`. For `month_of_year`, are there months whose SHAP values are systematically positive or negative? Given that the **target** is yoy inflation (seasonally neutral), why might month-of-year still matter?

<details>
<summary>Discussion</summary>

Month-of-year interacts with **mom** features: a high month-over-month change in a seasonally strong month (e.g. one with typical seasonal price increases) means less than the same change in a normally quiet month, because NSA mom data is seasonal (Day 19). The tree can learn "discount this month's momentum in month *m*" through the month feature. The SHAP pattern for `month_of_year` alone is usually small; its role shows up in interactions.

</details>

---

## 66.4 Explanation Drift: Are the Model's Drivers Stable? (20 min)

> **Question it answers:** Are the model's drivers stable from year to year, or do they shift sharply between refits?
>
> **Other questions you can answer the same way:**
> - Should I trust a model whose reasoning keeps changing?

If a model's explanations **change sharply** from one refit to the next, its forecasts rest on unstable foundations, even if its accuracy looks fine. Monitor **mean |SHAP| by family per year**:

```python
drift = (expl.assign(family=expl["feature"].map(family_of), year=expl["origin"].dt.year)
             .query("family != 'base_value' and h == 12")
             .assign(abs_c=lambda d: d["contribution"].abs())
             .groupby(["year", "family"])["abs_c"].mean().unstack("family"))
print(drift.round(2))
drift.plot(kind="line", marker="o", figsize=(9, 3.5),
           title="Average absolute contribution by family (h=12)")
plt.tight_layout(); plt.savefig("data/forecasts/explanation_drift.png", dpi=120)
```

Interpreting drift:
- **Gradual changes** can reflect genuine economic change, e.g. momentum mattering more in high-inflation periods.
- **Abrupt jumps** right after a refit point to instability: noisy hyperparameters (Day 64), too little data, or a data problem.
- A feature family that suddenly dominates deserves a **data-quality check** first (Module 5): a broken input often shows up as a strange explanation before it shows up as a large error.

> This is a quality signal for **models**, the counterpart of Day 47's quality history for **data**. On Days 68–70 it becomes part of the forecasting pipeline's monitoring.

---

## 66.5 Mini-Project: A "Forecast Explained" Dashboard Page (45 min)

Make explanations a **data product**, visible to economists without running Python.

### Step 1 — Publish the latest explained forecasts

Write `forecasting/publish_explanations.py` (in `.venv-ml`) that:
1. fits XGBoost at the **latest origin** for each horizon (training on all rows whose targets are known);
2. produces the forecast, an 80% interval (empirical, from the backtest errors in `xgb_explained_forecasts.parquet`), and SHAP contributions;
3. writes `data/forecasts/latest_forecasts.parquet` (one row per horizon) and `data/forecasts/latest_explanations.parquet` (one row per horizon × feature, with family).

### Step 2 — A dashboard page

> **Question it answers:** What is the inflation forecast with its range, and what drives it, on one page economists can read?
>
> **Other questions you can answer the same way:**
> - How confident is the forecast compared with the naive benchmark?

Add a function `forecast_explained(...)` to `dashboards/build_dashboards.py` (Day 60) that reads those files and draws, for the latest origin:
- a **forecast path** for horizons 1–12 with the 80% band, after the last 36 months of actual inflation, with a dashed line at the 2% target;
- a **family decomposition** bar chart per horizon (persistence, momentum, seasonality) around the base value;
- a header with the forecast origin date, the model name and its backtest relative RMSE (from the Day 63 leaderboard), and a **caveat line**: *"Model-based statistical forecast; explanations describe the model, not causal effects."*

<details>
<summary>Solution sketch for the dashboard function</summary>

```python
def forecast_explained(cpi: pd.DataFrame, latest: pd.DataFrame, expl: pd.DataFrame,
                       rel_rmse: float) -> Path:
    fig = make_subplots(rows=1, cols=2, column_widths=[0.6, 0.4],
                        subplot_titles=["CPI inflation: history and forecast (%)",
                                        "What drives the forecast (pp vs base)"])
    hist = cpi["cpi_yoy"].iloc[-36:]
    fig.add_trace(go.Scatter(x=hist.index, y=hist, name="actual", line=dict(color=C["text"])),
                  row=1, col=1)
    fig.add_trace(go.Scatter(x=latest["target_date"], y=latest["hi"], line=dict(width=0),
                             showlegend=False), row=1, col=1)
    fig.add_trace(go.Scatter(x=latest["target_date"], y=latest["lo"], fill="tonexty",
                             fillcolor="rgba(74,144,217,0.25)", line=dict(width=0),
                             name="80% interval"), row=1, col=1)
    fig.add_trace(go.Scatter(x=latest["target_date"], y=latest["forecast"], name="forecast",
                             line=dict(color=C["primary"], width=3)), row=1, col=1)
    fig.add_hline(y=2, line_dash="dash", line_color=C["positive"], row=1, col=1)

    fam = (expl[expl.family != "base_value"].groupby(["h", "family"])["contribution"].sum()
               .unstack("family"))
    for f, colour in [("persistence", C["primary"]), ("momentum", C["warning"]),
                      ("seasonality", "#7B5EA7")]:
        if f in fam:
            fig.add_trace(go.Bar(x=fam.index, y=fam[f], name=f, marker_color=colour), row=1, col=2)
    fig.update_layout(**LAYOUT, barmode="relative", height=520,
                      title=dict(text=f"<b>CPI inflation forecast, explained</b><br><sup>"
                                      f"origin {latest['origin'].iloc[0]:%b %Y} · XGBoost · "
                                      f"backtest RMSE vs naive {rel_rmse:.2f} · model-based "
                                      f"statistical forecast; explanations describe the model, "
                                      f"not causal effects</sup>"))
    out = SITE / "forecast_explained.html"
    fig.write_html(out)
    return out
```

</details>

On Day 70, `publish_explanations.py` and this page become **tasks in the Prefect pipeline**. For now, run them by hand and view the page with `python -m http.server 8090 --directory site`.

### Day 66 checklist
- [ ] Every backtest forecast is explained by the model that made it, with additivity verified
- [ ] I aggregate SHAP values into feature families and plot a forecast decomposition over time
- [ ] I read dependence plots for non-linearities and interactions
- [ ] I monitor explanation drift and know what abrupt changes may signal
- [ ] A dashboard page shows the latest forecast, its interval, its drivers and an explicit caveat

```bash
git add forecasting dashboards notebooks && git commit -m "Day 66: explanations over time, families, drift, forecast dashboard" && git push
```

---

# DAY 67 — Zero-Shot Forecasting with Chronos

| Time | Block |
|---|---|
| 0:00 – 0:20 | 67.1 Time-series foundation models |
| 0:20 – 0:43 | 67.2 Installing Chronos and a first zero-shot forecast |
| 0:43 – 0:50 | Break |
| 0:50 – 1:20 | 67.3 Chronos in the rolling-origin harness |
| 1:20 – 1:40 | 67.4 Probabilistic evaluation: pinball loss and coverage |
| 1:40 – 1:48 | Break |
| 1:48 – 2:08 | 67.5 Design choices: context length, levels vs rates, model size |
| 2:08 – 2:30 | 67.6 Forecast combinations and the Day 67 leaderboard |

---

## 67.1 Time-Series Foundation Models (20 min)

Every model so far was **trained on our data**. A **foundation model** is pretrained on a very large, diverse collection of time series, and can then forecast a **new** series **zero-shot**: given only its recent history (the **context**), with no training on it.

**Chronos** (Ansari et al., 2024, "Chronos: Learning the Language of Time Series") is a family of open-source models from Amazon. Its key idea is to treat forecasting like language modelling:
1. **scale** each series (so CPI in percent and GDP in dollars look alike);
2. **quantise** values into a vocabulary of tokens;
3. use a language-model architecture to predict the next tokens, sampling many futures, which yields **probabilistic** forecasts (quantiles).

Later variants (e.g. **Chronos-Bolt**) are much faster and produce quantiles directly, which suits a CPU-only Codespace.

| | Models trained on our data (XGBoost, AR) | Zero-shot foundation model (Chronos) |
|---|---|---|
| training | on our series, at every origin | none (pretrained once by the provider) |
| inputs | engineered features | raw history of the series (context) |
| strengths | uses our features and economic knowledge | no feature engineering; probabilistic by default; works with short histories |
| weaknesses | needs enough history; tuning | can't use our covariates (in the basic setup); a large model to download; possible **training-data overlap** |

> **Contamination caveat.** Foundation models are pretrained on public data. If similar macro series were in the pretraining corpus, a backtest over historical periods could be **optimistic**, because the model may have "seen" the future. The cleanest evaluation uses **origins after the model's release**. Keep this in mind when interpreting results (67.6).

---

## 67.2 Installing Chronos and a First Zero-Shot Forecast (23 min)

Install a **CPU-only** build of PyTorch first (much smaller than the default GPU build), then the Chronos package:

```bash
source .venv-ml/bin/activate
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install chronos-forecasting
pip freeze > forecasting/requirements-ml.txt
python -c "import chronos, torch; print('chronos ok, torch', torch.__version__)"
```

The model weights are downloaded from the Hugging Face Hub the first time you load a model (a few hundred MB for small variants). They're cached in `~/.cache/huggingface/`.

### A first forecast

> **Question it answers:** What does a pretrained foundation model forecast for inflation, without any training on our data?
>
> **Other questions you can answer the same way:**
> - What range does Chronos give for the next 12 months?

```python
import numpy as np
import torch
from chronos import BaseChronosPipeline

from forecasting.data import load_cpi

pipe = BaseChronosPipeline.from_pretrained(
    "amazon/chronos-bolt-small",          # fast, CPU-friendly; try "-tiny" or "-base" later
    device_map="cpu",
    torch_dtype=torch.float32,
)

y = load_cpi()["cpi_yoy"]
context = torch.tensor(y.to_numpy(), dtype=torch.float32)

quantiles, mean = pipe.predict_quantiles(context=context, prediction_length=12,
                                         quantile_levels=[0.1, 0.5, 0.9])
q = quantiles[0].numpy()                  # shape: (12 horizons, 3 quantiles)
future = pd.date_range(y.index.max() + pd.DateOffset(months=1), periods=12, freq="MS")
print(pd.DataFrame(q, index=future, columns=["q10", "median", "q90"]).round(2))
```

Plot the history, the median path and the 10–90% band. Does the forecast revert towards ~2%? How wide is the band at 12 months compared with your Day 63 XGBoost intervals?

> **Pin the model version** for reproducibility, as you pinned package versions (Day 3). Hugging Face models can be updated; passing a specific `revision="<commit hash>"` to `from_pretrained` freezes it. Record the model name and revision in every report.

---

## 67.3 Chronos in the Rolling-Origin Harness (30 min)

> **Question it answers:** How would the zero-shot Chronos model have performed in real time, using only data up to each forecast date?
>
> **Other questions you can answer the same way:**
> - Does Chronos beat XGBoost or the naive benchmark?

To compare fairly, Chronos must forecast from **the same origins**, using **only data up to each origin**. Because it needs no training, we can **batch** all origins in one call.

Create `forecasting/chronos_models.py`:

```python
"""Zero-shot Chronos forecasts in the rolling-origin framework."""
import pandas as pd
import torch
from chronos import BaseChronosPipeline

QUANTILES = [0.1, 0.5, 0.9]


def load_pipeline(name: str = "amazon/chronos-bolt-small", revision: str | None = None):
    kwargs = {"revision": revision} if revision else {}
    return BaseChronosPipeline.from_pretrained(name, device_map="cpu",
                                               torch_dtype=torch.float32, **kwargs)


def rolling_origin_chronos(y: pd.Series, horizons, test_start: str, pipe,
                           model_name: str = "chronos", max_context: int | None = None,
                           batch_size: int = 32) -> pd.DataFrame:
    """For each origin t, forecast from y[:t] only (optionally the last `max_context` points)."""
    origins = [t for t in y.index[y.index >= pd.Timestamp(test_start)]]
    H = max(horizons)
    rows = []
    for start in range(0, len(origins), batch_size):
        batch = origins[start:start + batch_size]
        contexts = []
        for t in batch:
            hist = y.loc[:t].to_numpy()
            if max_context:
                hist = hist[-max_context:]
            contexts.append(torch.tensor(hist, dtype=torch.float32))
        q, _ = pipe.predict_quantiles(context=contexts, prediction_length=H,
                                      quantile_levels=QUANTILES)
        for j, t in enumerate(batch):
            for h in horizons:
                t_target = t + pd.DateOffset(months=h)
                if t_target > y.index.max():
                    continue
                q10, q50, q90 = (float(v) for v in q[j, h - 1].tolist())
                rows.append({"model": model_name, "h": h, "origin": t, "target_date": t_target,
                             "forecast": q50, "q10": q10, "q90": q90,
                             "actual": float(y.loc[t_target])})
    return pd.DataFrame(rows)
```

Passing a **list** of tensors of different lengths is fine: the pipeline handles the padding. Each origin sees **only its own past**, `y.loc[:t]`, so there's no leakage by construction.

```python
from forecasting.chronos_models import load_pipeline, rolling_origin_chronos

pipe = load_pipeline("amazon/chronos-bolt-small")
chronos = rolling_origin_chronos(y, [1, 3, 6, 12], "2012-01-01", pipe, "chronos_bolt_small")
chronos.to_parquet("data/forecasts/chronos_bolt_small.parquet", index=False)

prev = pd.read_parquet("data/forecasts/univariate_forecasts.parquet")
board = score(pd.concat([prev, chronos[prev.columns]]))
print(board.query("model in ['naive', 'ar_aic', 'xgboost', 'chronos_bolt_small']").round(3))
for h in [1, 3, 6, 12]:
    print(diebold_mariano(pd.concat([prev, chronos[prev.columns]]), "chronos_bolt_small", "naive", h))
```

Record the runtime: Chronos-Bolt on CPU handles a few hundred contexts in seconds to minutes, with **no training at any origin**. That's a remarkable contrast with nested XGBoost tuning (Day 64).

---

## 67.4 Probabilistic Evaluation: Pinball Loss and Coverage (20 min)

Point metrics (RMSE) ignore uncertainty. Chronos produces **quantiles**, so evaluate them as quantiles.

### Pinball (quantile) loss

> **Question it answers:** How good are the forecast ranges, not just the central forecasts?
>
> **Other questions you can answer the same way:**
> - Which model gives the best-calibrated 10th and 90th percentiles?

For quantile level *α*, forecast *q* and outcome *y*:

**L_α(y, q) = α · (y − q) if y ≥ q, else (1 − α) · (q − y)**

It's the loss that quantile regression minimises (Day 63.5). Lower is better. Averaging across α = 0.1, 0.5 and 0.9 summarises the whole forecast distribution.

Create `forecasting/scoring.py`:

```python
"""Probabilistic forecast scores and forecast combinations."""
import numpy as np
import pandas as pd


def pinball(y, q, alpha):
    diff = y - q
    return np.where(diff >= 0, alpha * diff, (alpha - 1) * diff)


def quantile_scores(res: pd.DataFrame) -> pd.DataFrame:
    """Expects columns q10, forecast (median), q90, actual. Per model and horizon."""
    r = res.assign(
        pinball_avg=(pinball(res["actual"], res["q10"], 0.1)
                     + pinball(res["actual"], res["forecast"], 0.5)
                     + pinball(res["actual"], res["q90"], 0.9)) / 3,
        inside=(res["actual"] >= res["q10"]) & (res["actual"] <= res["q90"]),
        width=res["q90"] - res["q10"],
    )
    return (r.groupby(["model", "h"])
              .agg(pinball_avg=("pinball_avg", "mean"),
                   coverage_80=("inside", "mean"),
                   avg_width=("width", "mean"))
              .reset_index())
```

Compare Chronos with your Day 63 XGBoost quantile models (add their `q10`/`q90` columns to their results, using the same column names):

```python
print(quantile_scores(chronos).round(3))
```

| Score | Good value |
|---|---|
| average pinball loss | lower than competitors |
| 80% coverage | close to 0.80 |
| average width | as narrow as possible **given** good coverage |

Check coverage **by year** again (Day 63.5). Do Chronos's intervals widen when inflation becomes volatile? Foundation models scale their uncertainty to the **recent volatility in the context**, which can help them react faster to regime changes than models calibrated on calm training periods.

---

## 67.5 Design Choices: Context Length, Levels vs Rates, Model Size (20 min)

Zero-shot doesn't mean choice-free. Run three small experiments, each through `rolling_origin_chronos` and `score`/`quantile_scores`.

### Experiment 1 — How much history should Chronos see?

> **Question it answers:** Does Chronos forecast better with 3 years, 10 years or all of the inflation history?
>
> **Other questions you can answer the same way:**
> - Does older history help or hurt?

```python
for ctx in [36, 120, None]:            # 3 years, 10 years, all since 1992
    r = rolling_origin_chronos(y, [1, 12], "2012-01-01", pipe, f"chronos_ctx{ctx or 'all'}",
                               max_context=ctx)
    print(ctx, score(pd.concat([r[prev.columns], prev.query("model == 'naive'")]))
               .query("model != 'naive'")[["h", "rel_RMSE"]].to_dict("records"))
```

Short contexts let the model focus on the current regime; long contexts show it the full range of behaviour, including mean reversion towards target.

### Experiment 2 — Forecast the level, then compute inflation

> **Question it answers:** Is it better to forecast the CPI index and convert it to inflation, or to forecast inflation directly?
>
> **Other questions you can answer the same way:**
> - Which target gives smaller errors at 12 months?

Instead of forecasting yoy inflation directly, give Chronos the **CPI index** (with its seasonal pattern) and convert its forecast into yoy:

**yoy(t+h) = 100 × (CPI(t+h) / CPI(t+h−12) − 1)**, where CPI(t+h−12) is **already known** for *h* ≤ 12.

```python
cpi = load_cpi()["cpi"]
lvl = rolling_origin_chronos(cpi, [1, 3, 6, 12], "2012-01-01", pipe, "chronos_level")
lvl["forecast"] = 100 * (lvl["forecast"] / [cpi.loc[d - pd.DateOffset(months=12)]
                                             for d in lvl["target_date"]] - 1)
lvl["actual"] = [float(y.loc[d]) for d in lvl["target_date"]]
```

(Convert `q10` and `q90` the same way if you want interval scores.) Which works better: forecasting the rate, or forecasting the level and deriving the rate? There's no universal answer, but you can now test it in an afternoon.

### Experiment 3 — Model size

Try `amazon/chronos-bolt-tiny` and `amazon/chronos-bolt-base`. Record accuracy **and** runtime. In production, a slightly less accurate model that runs in seconds may be preferable to a larger one that takes minutes, depending on the deadline (Day 54's retry-budget thinking).

> **Beyond zero-shot.** Chronos models can be **fine-tuned** on your own data, and newer variants can take **covariates** (other series as inputs). Both are worth exploring after this module. Check the package documentation for your installed version, since these capabilities evolve quickly.

---

## 67.6 Forecast Combinations and the Day 67 Leaderboard (23 min)

### Combining forecasts

> **Question it answers:** Does an equal-weight average of several models forecast inflation better than any single model?
>
> **Other questions you can answer the same way:**
> - Which combination of models works best?
> - Is the combination more reliable over time?

A long literature, going back to Bates and Granger (1969), finds that **averaging forecasts from different models** often beats the individual models, especially when they make **different kinds of errors**. Simple equal weights are notoriously hard to beat with "optimised" weights (sometimes called the *forecast combination puzzle*).

Our models are genuinely different: AR (linear persistence), XGBoost (non-linear, feature-based), Chronos (pretrained, context-based). Add to `forecasting/scoring.py`:

```python
def combine(results: pd.DataFrame, members: list[str], name: str = "combo_equal") -> pd.DataFrame:
    """Equal-weight average of point forecasts on origins where all members are available."""
    r = results[results["model"].isin(members)]
    complete = r.groupby(["h", "origin"])["model"].transform("nunique") == len(members)
    combo = (r[complete].groupby(["h", "origin", "target_date"], as_index=False)
                        .agg(forecast=("forecast", "mean"), actual=("actual", "first")))
    return combo.assign(model=name)
```

### The Day 67 leaderboard

Write `forecasting/leaderboard_day67.py` that assembles naive, AR(AIC), XGBoost (default), XGBoost (tuned, Day 64), Chronos-Bolt (best context from 67.5) and the equal-weight combination of AR + XGBoost + Chronos. It should report, per horizon:
- RMSE, relative RMSE, and the Diebold–Mariano test vs naive;
- pinball loss and 80% coverage for models with quantiles;
- the same table restricted to **origins after the Chronos model's release date**, as a contamination check (67.1).

Save it to `data/forecasts/leaderboard_day67.parquet` with a Markdown report, including package versions **and the Chronos model name and revision**.

<details>
<summary>How to read the result, and what to carry into Days 68–70</summary>

Common patterns, which you should verify on your own data:
- At **short horizons**, naive and AR remain very hard to beat; differences are often insignificant.
- At **longer horizons**, models with **mean reversion** (AR, XGBoost trained on the inflation-targeting era, and often Chronos with a long context) tend to beat naive.
- The **combination** is frequently among the best and rarely the worst, which makes it a robust default.
- On the **post-release** window the sample is short, so conclusions are tentative. Say so.

**Decision for Days 68–70:** carry forward (1) AR(AIC) as the benchmark, (2) XGBoost, which will gain **multivariate** features from the marts, (3) Chronos as a zero-shot comparator, and (4) the equal-weight combination. Record this decision, with your evidence, in `forecasting/MODEL_DECISIONS.md`.

</details>

### Recap: Days 64–67

| Topic | You can now… |
|---|---|
| tuning | tune with time-series CV and a horizon gap; use randomized search and Optuna; evaluate tuning as a nested procedure |
| explainability | compute exact TreeSHAP contributions, verify additivity, and read global, local and dependence plots |
| explanations over time | explain each real-time forecast, decompose forecasts by feature family, monitor explanation drift |
| communication | publish an explained forecast as a dashboard page with honest caveats |
| foundation models | run Chronos zero-shot in the same rolling-origin harness, batched over origins |
| probabilistic evaluation | score quantile forecasts with pinball loss and coverage |
| robustness | combine forecasts and check for training-data contamination |

### Looking ahead: Days 68–70

The curriculum's goal for this module: **forecasting Canadian CPI and real GDP growth using the historical features engineered in earlier modules**. You'll build a multivariate feature mart from `macro_monthly` and `macro_quarterly` (rates, spreads, FX, oil, labour market, core measures), respect **publication lags and data vintages** so the backtest reflects what was really known, extend everything to quarterly GDP, and turn the forecasts, explanations and dashboard into **tasks in the Prefect pipeline**.

### Day 67 checklist
- [ ] I can explain what a time-series foundation model is, and the contamination caveat
- [ ] Chronos runs on CPU with a pinned model version, producing quantile forecasts
- [ ] Chronos is evaluated on exactly the same origins and horizons as the other models, without leakage
- [ ] I score probabilistic forecasts with pinball loss and coverage
- [ ] I tested context length, level-vs-rate targets and model size
- [ ] A combined forecast and a full leaderboard (with a post-release check) inform documented model decisions

```bash
git add forecasting notebooks && git commit -m "Day 67: Chronos zero-shot, probabilistic scores, combinations, leaderboard" && git push
```
