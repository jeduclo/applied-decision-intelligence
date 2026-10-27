# Module 8 · Causal Inference with DoubleML
## Days 74–77: Nuisance Parameters, Cross-Fitting and Partially Linear Regression Models

**Audience:** MSc Economics students who completed Days 1–73
**Environment:** GitHub Codespaces · `.venv-ml` (scikit-learn, XGBoost, `doubleml`, `statsmodels`) · `causal/` package and `design_spec.yml` from Day 73 · marts in `data/marts/`
**Time per day:** ~2.5 hours (including breaks and exercises)
**Goal by end of Day 77:** Students understand **why** Double/Debiased Machine Learning works:
- the **partially linear model** and its **nuisance functions**;
- why naive "plug-in" ML gives biased causal estimates (**regularisation** and **overfitting bias**);
- how **Neyman-orthogonal scores** and **cross-fitting** fix them.

They implement DML **by hand**, reproduce it with the **`doubleml` package**, and adapt it to **monthly macro time series** with blocked cross-fitting and HAC standard errors, validated by Monte Carlo coverage studies. They then run the full Day 73 design as a **dress rehearsal** on a real outcome already in the platform (the unemployment rate), with learner comparisons, dynamic responses, pre-registered robustness checks and a specification curve, ready for housing starts on Days 78–80.

---

### Where we are

Day 73 produced `causal/design_spec.yml`: a reviewed specification of the question *"effect of a 1pp overnight-rate increase on housing starts h months later"*, with a continuous treatment, pre-treatment controls with publication lags, excluded mediators, unobserved confounders and pre-registered robustness checks. It names the estimator:

> *DoubleML partially linear regression (PLR), cross-fitted, ML nuisance models.*

These four days turn that sentence into understood, tested code.

| Day | Theme |
|---|---|
| 74 | the PLR model, nuisance functions, and why naive ML is biased |
| 75 | cross-fitting, DML by hand, and the `doubleml` package |
| 76 | DML for dependent (time-series) data: blocked folds, HAC inference, coverage |
| 77 | the full design on real data: a dress rehearsal with diagnostics and robustness |

### Target structure (by end of Day 77)

```
causal/
├── simulate.py            ← + nonlinear and time-series worlds
├── montecarlo.py          ← NEW: bias and coverage studies
├── dml.py                 ← NEW: DML by hand (cross-fitting, repeated splits, HAC)
├── design.py              ← NEW: builds the estimation dataset from design_spec.yml
├── run_design.py          ← NEW: estimates, robustness checks, report
└── …                      (dag.py, balance.py, DAG.md, design_spec.yml)
data/causal/               ← NEW: results (not committed)
```

```bash
cd /workspaces/macro-data-course
source .venv-ml/bin/activate
python -c "import doubleml; print('doubleml', doubleml.__version__)"
mkdir -p data/causal && echo "data/causal/" >> .gitignore
```

---

# DAY 74 — The Partially Linear Model and Its Nuisance Parameters

| Time | Block |
|---|---|
| 0:00 – 0:20 | 74.1 The partially linear regression (PLR) model |
| 0:20 – 0:43 | 74.2 Frisch–Waugh–Lovell: partialling out, the linear way |
| 0:43 – 0:50 | Break |
| 0:50 – 1:13 | 74.3 Partialling out with machine learning |
| 1:13 – 1:40 | 74.4 Two biases of naive ML: regularisation and overfitting |
| 1:40 – 1:48 | Break |
| 1:48 – 2:08 | 74.5 Neyman orthogonality: why residualising both sides works |
| 2:08 – 2:30 | 74.6 Mini-project: a Monte Carlo of three estimators |

---

## 74.1 The Partially Linear Regression (PLR) Model (20 min)

The PLR model (Robinson, 1988; Chernozhukov et al., 2018) has two equations:

**Y = θ·D + g₀(X) + ε,  E[ε | D, X] = 0**
**D = m₀(X) + V,  E[V | X] = 0**

| Symbol | Our question | Role |
|---|---|---|
| **Y** | housing-starts growth over *h* months | outcome |
| **D** | change in the overnight rate (pp) | treatment |
| **X** | pre-decision economic situation (inflation, labour market, activity, global rates, past policy, past housing) | controls (confounders) |
| **θ** | effect per 1pp rate increase | **target parameter**: the causal effect under unconfoundedness |
| **g₀(X)** | how the economic situation affects housing, in any form | **nuisance** function |
| **m₀(X)** | the Bank's **reaction function**: expected rate change given the situation | **nuisance** function |
| **V** | rate change **not** explained by the situation: a *policy surprise* (Day 73.4) | the identifying variation |

A **nuisance parameter** is something we must estimate in order to get θ, but don't care about for its own sake. Here the nuisances are whole **functions**, potentially complex and non-linear. That's where machine learning comes in.

The model is **partially** linear: linear in the treatment (one number, θ, the effect per pp) but **unrestricted** in the controls. That's a sensible compromise for our question. We want one interpretable policy elasticity per horizon, and we want to make **no** functional-form assumptions about how a dozen correlated macro variables affect housing and policy.

> **What θ means:** the average effect on housing growth of a 1pp **larger** rate change, comparing months with the **same** pre-decision economic situation. Under the Day 73 assumptions (unconfoundedness given X, overlap, no anticipation), that's a causal effect.

---

## 74.2 Frisch–Waugh–Lovell: Partialling Out, the Linear Way (23 min)

You know this theorem from econometrics. In the linear regression Y = θD + Xβ + ε, the OLS estimate of θ equals the coefficient from regressing:
- the **residuals of Y** on X, on
- the **residuals of D** on X.

"Partialling out" X from both sides isolates the variation in D that's **unrelated to X**, and asks how Y's unexplained variation co-moves with it.

```python
import numpy as np
import statsmodels.api as sm

from causal.simulate import confounded_world

df = confounded_world()                      # Day 71: true effect -5
X = sm.add_constant(df[["cycle"]])

full = sm.OLS(df["housing_growth"], sm.add_constant(df[["rate_change", "cycle"]])).fit()
y_res = df["housing_growth"] - sm.OLS(df["housing_growth"], X).fit().fittedvalues
d_res = df["rate_change"] - sm.OLS(df["rate_change"], X).fit().fittedvalues
fwl = sm.OLS(y_res, d_res).fit()

print(f"full regression θ = {full.params['rate_change']:.4f}")
print(f"FWL partialling   θ = {fwl.params.iloc[0]:.4f}")          # identical
```

The two numbers are **identical**. FWL is the template for everything this week. DML is FWL where "regress on X" means **any flexible ML model**.

---

## 74.3 Partialling Out with Machine Learning (23 min)

Taking expectations of the PLR equations given X:

**ℓ₀(X) ≡ E[Y | X] = θ·m₀(X) + g₀(X)**

Subtracting gives the **residual-on-residual** equation:

**Y − ℓ₀(X) = θ · (D − m₀(X)) + ε**

So, just like FWL:
1. estimate **ℓ̂(X)** = predict Y from X (any ML model);
2. estimate **m̂(X)** = predict D from X (any ML model): the **reaction function**;
3. regress the **Y-residuals** on the **D-residuals**:

**θ̂ = Σ (Yᵢ − ℓ̂(Xᵢ))(Dᵢ − m̂(Xᵢ)) / Σ (Dᵢ − m̂(Xᵢ))²**

This is Robinson's (1988) estimator. With linear models for ℓ and m it's exactly FWL; with random forests or XGBoost it handles **non-linear confounding**, which defeated linear controls in Day 71's exercise 3.

### A non-linear world

Add to `causal/simulate.py`:

```python
def nonlinear_world(T: int = 500, true_effect: float = -5.0, seed: int = 0) -> pd.DataFrame:
    """Confounding through non-linear functions of several controls (true effect known)."""
    rng = np.random.default_rng(seed)
    X = rng.normal(size=(T, 5))
    m = 0.8 * np.tanh(2 * X[:, 0]) + 0.4 * X[:, 1] ** 2 - 0.3 * X[:, 2] * X[:, 3]   # reaction fn
    g = 6 * np.sin(1.5 * X[:, 0]) + 3 * X[:, 1] ** 2 + 2 * np.abs(X[:, 4])          # direct effects
    d = m + rng.normal(0, 0.6, T)
    y = true_effect * d + g + rng.normal(0, 2, T)
    out = pd.DataFrame(X, columns=[f"x{i}" for i in range(5)])
    out["rate_change"], out["housing_growth"] = d, y
    return out
```

Compare linear partialling out with ML partialling out (for now **without** cross-fitting, which comes on Day 75):

```python
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import LinearRegression

from causal.simulate import nonlinear_world

df = nonlinear_world(T=2000)
Xc = df[[f"x{i}" for i in range(5)]].to_numpy()
y, d = df["housing_growth"].to_numpy(), df["rate_change"].to_numpy()


def partial_out(learner_y, learner_d):
    y_res = y - learner_y.fit(Xc, y).predict(Xc)
    d_res = d - learner_d.fit(Xc, d).predict(Xc)
    return (d_res @ y_res) / (d_res @ d_res)

print("linear controls:", round(partial_out(LinearRegression(), LinearRegression()), 2))
print("random forests (in-sample!):",
      round(partial_out(RandomForestRegressor(200, min_samples_leaf=5, random_state=0),
                        RandomForestRegressor(200, min_samples_leaf=5, random_state=0)), 2))
```

The linear version is biased because the confounding is non-linear. The in-sample random-forest version is closer, but still biased. Why? Next block.

---

## 74.4 Two Biases of Naive ML: Regularisation and Overfitting (28 min)

Chernozhukov et al. (2018) identify two distinct problems with plugging ML into causal estimation.

### Bias 1 — Regularisation bias (from a non-orthogonal score)

A tempting "naive" approach estimates g with ML and then regresses the remainder on D **without residualising D**:

**θ̂_naive = Σ Dᵢ (Yᵢ − ĝ(Xᵢ)) / Σ Dᵢ²**

ML estimators of g are **regularised**: they shrink, smooth and trade bias for variance, so ĝ has errors. Because D is correlated with X (that's confounding), those errors in ĝ **leak directly into θ̂**. The estimate converges **too slowly** and is centred in the wrong place.

### Bias 2 — Overfitting bias (from using the same data twice)

Even with residualisation on both sides, if ℓ̂ and m̂ are fitted **on the same observations** whose residuals we then use, flexible learners partly **fit the noise**. In-sample residuals are too small and correlated with the noise in ways that bias θ̂. In 74.3, the random forests predicted the very points they were trained on.

| Estimator | Residualise D? | Out-of-sample nuisance predictions? | Bias |
|---|---|---|---|
| naive plug-in | ✗ | ✗ | regularisation **and** overfitting |
| orthogonal, in-sample | ✓ | ✗ | overfitting |
| **DML** (orthogonal + cross-fitting) | ✓ | ✓ | **neither**, asymptotically |

Here's the naive plug-in estimator. Fitting g requires an initial step; a common heuristic is to fit ML for Y on X and D jointly, then remove D's part. For teaching, we use an even simpler naive variant that captures the issue: fit ĝ on Y − θ₀D iteratively starting from θ₀ = 0:

```python
def naive_plugin(learner, iters: int = 5):
    theta = 0.0
    for _ in range(iters):
        g_hat = learner.fit(Xc, y - theta * d).predict(Xc)
        theta = (d @ (y - g_hat)) / (d @ d)          # no residualisation of D
    return theta

print("naive plug-in:", round(naive_plugin(RandomForestRegressor(200, min_samples_leaf=5,
                                                                   random_state=0)), 2))
```

Compare the three numbers (naive, orthogonal in-sample, and DML from Day 75) in the Monte Carlo below.

---

## 74.5 Neyman Orthogonality: Why Residualising Both Sides Works (20 min)

The DML estimator solves an equation of the form "average **score** = 0". For the partialling-out PLR, the score is:

**ψ(W; θ, ℓ, m) = [Y − ℓ(X) − θ(D − m(X))] · (D − m(X))**

**Neyman orthogonality** means: small mistakes in the nuisance functions ℓ and m have **no first-order effect** on the estimating equation. Mathematically, the derivative of the expected score with respect to the nuisances, at the truth, is zero.

### Intuition

In the naive score, **D · (Y − g(X))**, an error δ in ĝ shifts the score by **E[D · δ(X)]**. Since D depends on X, that's not zero: errors leak through. In the orthogonal score, the error is multiplied by **(D − m(X)) = V**, the policy surprise, which by construction is **uncorrelated with any function of X**. So errors in ℓ have no first-order effect. Errors in m enter only **multiplied by errors in ℓ**, a product of two small numbers.

### Why that matters for ML

ML nuisance estimates converge slower than parametric ones (they're flexible). Orthogonality means θ̂ only needs the **product** of the two nuisance errors to be small: each converging faster than *n*^(−1/4) is enough, rather than the usual *n*^(−1/2). That's a mild requirement that random forests, boosting and lasso can meet in many settings. Combined with cross-fitting (Day 75), θ̂ is **approximately normal**, centred on the truth, with valid standard errors.

> **One sentence to remember:** *DML predicts what the economic situation implies for both the outcome and the policy, subtracts it from both, and estimates the effect from what's left, using predictions made on data the models didn't train on.*

---

## 74.6 Mini-Project: A Monte Carlo of Three Estimators (23 min)

Create `causal/montecarlo.py`:

```python
"""Monte Carlo comparisons of causal estimators (bias, spread, coverage)."""
import numpy as np
import pandas as pd
from sklearn.base import clone
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import KFold

from causal.simulate import nonlinear_world

RF = RandomForestRegressor(n_estimators=100, min_samples_leaf=5, random_state=0, n_jobs=2)


def naive(y, d, X, learner, iters=5):
    theta = 0.0
    for _ in range(iters):
        g = clone(learner).fit(X, y - theta * d).predict(X)
        theta = (d @ (y - g)) / (d @ d)
    return theta


def orthogonal_insample(y, d, X, learner):
    yr = y - clone(learner).fit(X, y).predict(X)
    dr = d - clone(learner).fit(X, d).predict(X)
    return (dr @ yr) / (dr @ dr)


def dml(y, d, X, learner, n_folds=5, seed=0):
    yr, dr = np.empty_like(y), np.empty_like(d)
    for tr, te in KFold(n_folds, shuffle=True, random_state=seed).split(X):
        yr[te] = y[te] - clone(learner).fit(X[tr], y[tr]).predict(X[te])
        dr[te] = d[te] - clone(learner).fit(X[tr], d[tr]).predict(X[te])
    return (dr @ yr) / (dr @ dr)


def run(n_sims=100, T=500, true_effect=-5.0):
    rows = []
    for s in range(n_sims):
        df = nonlinear_world(T=T, true_effect=true_effect, seed=s)
        X = df[[f"x{i}" for i in range(5)]].to_numpy()
        y, d = df["housing_growth"].to_numpy(), df["rate_change"].to_numpy()
        rows += [{"sim": s, "estimator": "naive plug-in", "theta": naive(y, d, X, RF)},
                 {"sim": s, "estimator": "orthogonal, in-sample", "theta": orthogonal_insample(y, d, X, RF)},
                 {"sim": s, "estimator": "DML (cross-fitted)", "theta": dml(y, d, X, RF, seed=s)}]
    res = pd.DataFrame(rows)
    summary = res.groupby("estimator")["theta"].agg(mean="mean", sd="std")
    summary["bias"] = summary["mean"] - true_effect
    return res, summary


if __name__ == "__main__":
    res, summary = run()
    res.to_parquet("data/causal/mc_three_estimators.parquet", index=False)
    print(summary.round(3))
```

```bash
python -m causal.montecarlo          # a few minutes: 100 simulations × 3 estimators
```

Plot the three distributions of θ̂ (histograms with a vertical line at −5) in `notebooks/day74.ipynb`. You should see the naive plug-in **shifted**, the in-sample orthogonal estimator **less** shifted, and DML **centred on −5**. This reproduces, on your own simulation, the key figure in Chernozhukov et al. (2018).

### Day 74 checklist
- [ ] I can write the PLR model, identify θ, the nuisance functions ℓ₀, m₀, g₀, and the identifying variation V
- [ ] I can show that FWL partialling-out equals the full linear regression
- [ ] I can implement Robinson's residual-on-residual estimator with any ML learner
- [ ] I can explain regularisation bias and overfitting bias, and which fix addresses which
- [ ] I can explain Neyman orthogonality intuitively, and why it lets slower ML nuisance estimates work
- [ ] My Monte Carlo shows naive and in-sample estimators biased, and cross-fitted DML centred on the truth

```bash
git add causal notebooks && git commit -m "Day 74: PLR, nuisance functions, ML biases, orthogonality, Monte Carlo" && git push
```

---

# DAY 75 — Cross-Fitting and the `doubleml` Package

| Time | Block |
|---|---|
| 0:00 – 0:23 | 75.1 Sample splitting and cross-fitting |
| 0:23 – 0:48 | 75.2 DML by hand: a reusable implementation |
| 0:48 – 0:55 | Break |
| 0:55 – 1:20 | 75.3 The `doubleml` package |
| 1:20 – 1:43 | 75.4 Choosing and diagnosing learners |
| 1:43 – 1:50 | Break |
| 1:50 – 2:08 | 75.5 Repeated cross-fitting and inference |
| 2:08 – 2:30 | 75.6 Mini-project: coverage of DML confidence intervals |

---

## 75.1 Sample Splitting and Cross-Fitting (23 min)

To avoid overfitting bias, the nuisance predictions used for observation *i* must come from models that **didn't see *i***.

**Simple sample splitting** fits nuisances on half the data and estimates θ on the other half. It works, but wastes half the sample.

**Cross-fitting** gets the benefit without the waste:

```
data split into K folds:  [ 1 ][ 2 ][ 3 ][ 4 ][ 5 ]

fold 1: fit ℓ̂, m̂ on folds 2–5 → predict on fold 1 → residuals for fold 1
fold 2: fit ℓ̂, m̂ on folds 1,3–5 → predict on fold 2 → residuals for fold 2
…
then: θ̂ from ALL out-of-fold residuals together
```

Every observation's residual is **out-of-sample**, and every observation is used. That's the "cross" in cross-fitting. It's the same idea as K-fold cross-validation, but used to construct residuals rather than to choose hyperparameters.

> **Forecasting vs causal cross-fitting.** In Module 7, training on the **future** to predict the **past** was forbidden: it was leakage, because we were simulating real-time forecasts. In DML, we aren't forecasting. We estimate a **structural relationship** that's assumed stable over the sample, so learning nuisance functions from other periods, including later ones, is legitimate. What still matters with time series is **dependence between neighbouring observations**, which we handle on Day 76.

---

## 75.2 DML by Hand: A Reusable Implementation (25 min)

Writing it yourself makes the method transparent, and gives you full control later (blocked folds, HAC errors). Create `causal/dml.py`:

```python
"""Double/debiased ML for the partially linear model, written out explicitly."""
from dataclasses import dataclass

import numpy as np
import statsmodels.api as sm
from sklearn.base import clone
from sklearn.model_selection import KFold


@dataclass
class DMLResult:
    theta: float
    se: float
    y_res: np.ndarray
    d_res: np.ndarray
    r2_l: float           # out-of-fold R² of E[Y|X]
    r2_m: float           # out-of-fold R² of E[D|X] (how predictable policy is)

    def ci(self, z=1.96):
        return self.theta - z * self.se, self.theta + z * self.se


def cross_fit_residuals(y, d, X, learner_l, learner_m, splits):
    """Out-of-fold residuals Y − ℓ̂(X) and D − m̂(X) for the given (train, test) splits."""
    y_res = np.full(len(y), np.nan)
    d_res = np.full(len(d), np.nan)
    for train, test in splits:
        y_res[test] = y[test] - clone(learner_l).fit(X[train], y[train]).predict(X[test])
        d_res[test] = d[test] - clone(learner_m).fit(X[train], d[train]).predict(X[test])
    return y_res, d_res


def plr_from_residuals(y_res, d_res, hac_lags: int | None = None):
    """θ̂ = Σ d̃ỹ / Σ d̃²; SE either heteroskedasticity-robust or HAC (Newey–West)."""
    ok = ~np.isnan(y_res) & ~np.isnan(d_res)
    model = sm.OLS(y_res[ok], d_res[ok])
    if hac_lags is None:
        fit = model.fit(cov_type="HC1")
    else:
        fit = model.fit(cov_type="HAC", cov_kwds={"maxlags": hac_lags})
    return float(fit.params[0]), float(fit.bse[0])


def r2(y, residual):
    ok = ~np.isnan(residual)
    return 1 - np.var(residual[ok]) / np.var(y[ok])


def dml_plr(y, d, X, learner_l, learner_m, splits=None, n_folds=5, seed=0,
            hac_lags=None) -> DMLResult:
    y, d, X = np.asarray(y, float), np.asarray(d, float), np.asarray(X, float)
    if splits is None:
        splits = list(KFold(n_folds, shuffle=True, random_state=seed).split(X))
    y_res, d_res = cross_fit_residuals(y, d, X, learner_l, learner_m, splits)
    theta, se = plr_from_residuals(y_res, d_res, hac_lags)
    return DMLResult(theta, se, y_res, d_res, r2(y, y_res), r2(d, d_res))
```

The final step is the **FWL regression of residuals on residuals** (74.2), so its standard error is the familiar regression standard error on the residualised data: heteroskedasticity-robust (HC1) by default, or **HAC** for time series (Day 76). Asymptotically this matches the variance of the orthogonal score.

```python
from sklearn.ensemble import RandomForestRegressor

from causal.dml import dml_plr
from causal.simulate import nonlinear_world

df = nonlinear_world(T=1000, seed=1)
X = df[[f"x{i}" for i in range(5)]]
rf = RandomForestRegressor(200, min_samples_leaf=5, random_state=0, n_jobs=2)
res = dml_plr(df["housing_growth"], df["rate_change"], X, rf, rf)
print(f"θ̂ = {res.theta:.2f} (se {res.se:.2f}), 95% CI {tuple(round(v, 2) for v in res.ci())}")
print(f"out-of-fold R²: E[Y|X] {res.r2_l:.2f}, E[D|X] {res.r2_m:.2f}")
```

---

## 75.3 The `doubleml` Package (25 min)

The **DoubleML** package (Bach, Chernozhukov, Kurz & Spindler) implements these estimators with a consistent API, many model types (PLR, interactive models, IV variants), repeated cross-fitting, bootstrap inference and sensitivity analysis.

```python
import doubleml as dml
from sklearn.base import clone
from sklearn.ensemble import RandomForestRegressor

from causal.simulate import nonlinear_world

df = nonlinear_world(T=1000, seed=1)
data = dml.DoubleMLData(df, y_col="housing_growth", d_cols="rate_change",
                        x_cols=[f"x{i}" for i in range(5)])

rf = RandomForestRegressor(n_estimators=200, min_samples_leaf=5, random_state=0, n_jobs=2)
plr = dml.DoubleMLPLR(data, ml_l=clone(rf), ml_m=clone(rf),
                      n_folds=5, n_rep=1, score="partialling out")
plr.fit(store_predictions=True)

print(plr.summary)
print(plr.confint(level=0.95))
```

| Argument | Meaning |
|---|---|
| `ml_l` | learner for ℓ₀(X) = E[Y \| X] |
| `ml_m` | learner for m₀(X) = E[D \| X] (the reaction function) |
| `n_folds` | number of cross-fitting folds |
| `n_rep` | number of repetitions with different random splits (75.5) |
| `score="partialling out"` | the orthogonal score from 74.5 |

`plr.summary` reports θ̂, its standard error, *t*, *p* and the 95% interval.

### Cross-check with your implementation

```python
from causal.dml import dml_plr

mine = dml_plr(df["housing_growth"], df["rate_change"], df[[f"x{i}" for i in range(5)]], rf, rf)
print(f"by hand:   {mine.theta:.3f} (se {mine.se:.3f})")
print(f"doubleml:  {plr.coef[0]:.3f} (se {plr.se[0]:.3f})")
```

The numbers won't be identical (different random folds), but they should be close. Use the **same splits** to make them match almost exactly:

```python
from sklearn.model_selection import KFold

splits = list(KFold(5, shuffle=True, random_state=42).split(df))
plr_same = dml.DoubleMLPLR(data, ml_l=clone(rf), ml_m=clone(rf), score="partialling out")
plr_same.set_sample_splitting(all_smpls=[splits])       # one repetition, our splits
plr_same.fit()
mine_same = dml_plr(df["housing_growth"], df["rate_change"],
                    df[[f"x{i}" for i in range(5)]], rf, rf, splits=splits)
print(plr_same.coef[0], mine_same.theta)
```

> **Two implementations that agree** is strong evidence that both are correct. The same principle drove the Day 30 and Day 40 regression tests: verify new machinery against an independent version.

---

## 75.4 Choosing and Diagnosing Learners (23 min)

DML is only as good as its nuisance estimates. Compare several learners, and **report their quality**.

```python
from sklearn.linear_model import LassoCV, LinearRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import PolynomialFeatures, StandardScaler
from xgboost import XGBRegressor

LEARNERS = {
    "ols": LinearRegression(),
    "lasso_poly2": make_pipeline(PolynomialFeatures(2, include_bias=False), StandardScaler(),
                                 LassoCV(cv=5, max_iter=5000)),
    "random_forest": RandomForestRegressor(300, min_samples_leaf=5, random_state=0, n_jobs=2),
    "xgboost": XGBRegressor(n_estimators=300, learning_rate=0.05, max_depth=3,
                            subsample=0.8, colsample_bytree=0.8, random_state=0, n_jobs=2),
}

import pandas as pd
rows = []
for name, learner in LEARNERS.items():
    r = dml_plr(df["housing_growth"], df["rate_change"], df[[f"x{i}" for i in range(5)]],
                learner, learner)
    rows.append({"learner": name, "theta": r.theta, "se": r.se,
                 "r2_E[Y|X]": r.r2_l, "r2_E[D|X]": r.r2_m})
print(pd.DataFrame(rows).round(3))
```

### Interpreting the diagnostics

| Diagnostic | Tells you | Warning sign |
|---|---|---|
| out-of-fold R² of **E[Y \| X]** | how well controls explain the outcome | very low: noisy θ̂ (wide CI) |
| out-of-fold R² of **E[D \| X]** | how predictable policy is from the information set | **very high (close to 1)**: almost no residual variation in D, so θ̂ rests on tiny surprises; the continuous-treatment version of **poor overlap** (Day 72.5) |
| θ̂ stable across good learners | conclusions not driven by one model | large disagreement between learners with similar R²: investigate |

> For our real question, the R² of **E[D | X]** has a direct economic meaning: **how much of Bank of Canada rate setting is explained by its observable reaction function.** If it's 0.9, then 90% of the variation in rate changes is "systematic policy", and θ is identified only from the remaining 10%: the timing and size of moves beyond what the economic situation dictated.

### Try it 75.4

Learners also have **hyperparameters** (Day 64). Using `GridSearchCV` **inside** the learner (e.g. `GridSearchCV(RandomForestRegressor(), {"min_samples_leaf": [2, 5, 20]}, cv=3)` as the learner object), does tuning change θ̂ or its CI on the simulation? Why is tuning inside each cross-fitting fold legitimate here?

<details>
<summary>Answer</summary>

Tuning inside the learner happens within each **training** fold, so the held-out fold remains unseen and there's no overfitting bias. It often improves nuisance R² modestly, with little change in θ̂, which is reassuring. If θ̂ changed substantially, it would signal that nuisance quality was poor before tuning.

</details>

---

## 75.5 Repeated Cross-Fitting and Inference (18 min)

Different random fold assignments give slightly different θ̂. To make results **not depend on one lucky split**, repeat cross-fitting *R* times and aggregate. DoubleML reports the **median** θ̂, with a standard error that adds the across-split variability:

**θ̂ = median(θ̂ᵣ),  SE = √ median(SEᵣ² + (θ̂ᵣ − θ̂)²)**

```python
plr5 = dml.DoubleMLPLR(data, ml_l=clone(rf), ml_m=clone(rf), n_folds=5, n_rep=5)
plr5.fit()
print(plr5.summary)
print("estimates across repetitions:", plr5.all_coef.round(3))
```

Add the same aggregation to `causal/dml.py`:

```python
def aggregate_reps(thetas, ses):
    thetas, ses = np.asarray(thetas), np.asarray(ses)
    theta = float(np.median(thetas))
    se = float(np.sqrt(np.median(ses ** 2 + (thetas - theta) ** 2)))
    return theta, se
```

| Setting | Typical choice |
|---|---|
| `n_folds` | 5 (2–10); more folds = nuisances trained on more data |
| `n_rep` | 5–20 for final results; 1 while developing |

---

## 75.6 Mini-Project: Coverage of DML Confidence Intervals (23 min)

A 95% confidence interval should contain the true θ in about **95%** of repeated samples. That's **coverage**, the same idea as forecast-interval coverage on Day 63. Measure it:

Add to `causal/montecarlo.py`:

```python
from causal.dml import dml_plr


def coverage(n_sims=100, T=500, true_effect=-5.0, learner=RF):
    rows = []
    for s in range(n_sims):
        df = nonlinear_world(T=T, true_effect=true_effect, seed=1000 + s)
        X = df[[f"x{i}" for i in range(5)]]
        r = dml_plr(df["housing_growth"], df["rate_change"], X, learner, learner, seed=s)
        lo, hi = r.ci()
        rows.append({"theta": r.theta, "se": r.se, "covered": lo <= true_effect <= hi})
    res = pd.DataFrame(rows)
    return {"mean_theta": res.theta.mean(), "sd_theta": res.theta.std(),
            "mean_se": res.se.mean(), "coverage_95": res.covered.mean()}
```

Report, for `T = 250, 500, 1000`:
1. the mean θ̂ (bias);
2. the standard deviation of θ̂ across simulations vs the **average reported SE** (they should be close if the SEs are valid);
3. the coverage of the 95% CI.

Repeat with `LinearRegression` as the learner: coverage should **collapse**, because linear nuisances leave non-linear confounding: the CI is narrow around the **wrong** value. That's the most important lesson of the day: **valid inference requires good nuisance estimates.**

### Day 75 checklist
- [ ] I can explain sample splitting vs cross-fitting, and why learning from "other periods" is fine for causal (not forecasting) work
- [ ] My `causal/dml.py` implements cross-fitted PLR with robust SEs and out-of-fold R² diagnostics
- [ ] I can run `DoubleMLPLR`, read its summary, and reproduce its estimate by hand with identical splits
- [ ] I compare learners and interpret nuisance R², including the reaction-function R² as an overlap signal
- [ ] I use repeated cross-fitting and median aggregation
- [ ] My Monte Carlo shows near-nominal coverage with good learners, and failure with misspecified ones

```bash
git add causal notebooks && git commit -m "Day 75: cross-fitting, DML by hand, doubleml, learners, coverage" && git push
```

---

# DAY 76 — DML for Macroeconomic Time Series

| Time | Block |
|---|---|
| 0:00 – 0:20 | 76.1 What breaks with dependent data |
| 0:20 – 0:48 | 76.2 Blocked cross-fitting with buffers |
| 0:48 – 0:55 | Break |
| 0:55 – 1:20 | 76.3 HAC inference for overlapping horizons |
| 1:20 – 1:45 | 76.4 Monte Carlo: iid vs time-series-aware DML |
| 1:45 – 1:53 | Break |
| 1:53 – 2:10 | 76.5 Custom splits in `doubleml` |
| 2:10 – 2:30 | 76.6 Mini-project: `fit_plr_ts`, a time-series DML wrapper |

---

## 76.1 What Breaks with Dependent Data (20 min)

The DML theory of Day 75 assumes **independent** observations. Monthly macro data violate this in three ways:

| Feature of our data | Consequence for DML |
|---|---|
| **persistent controls** (inflation, unemployment move slowly) | neighbouring months are near-duplicates. Random folds put a month's twin in the training set, so "out-of-fold" predictions are effectively **in-sample** and overfitting bias returns |
| **overlapping outcomes** (housing growth from *t−1* to *t+h* shares *h* months with *t+1*'s outcome) | residuals are **serially correlated** by construction (an MA(*h*) structure) |
| **gradual policy** (rate changes come in series) | treatment residuals are autocorrelated too |

Two fixes, both standard in time-series econometrics:
1. **blocked cross-fitting with buffers:** folds are contiguous blocks of time, and months **near** the test block are removed from training;
2. **HAC (Newey–West) standard errors** for the final residual regression, which account for serial correlation (you used them on Day 63 for Diebold–Mariano tests).

---

## 76.2 Blocked Cross-Fitting with Buffers (28 min)

```
time →   [ fold 1 ][ fold 2 ][ fold 3 ][ fold 4 ][ fold 5 ]

test fold 3:  train = folds 1–5 EXCEPT fold 3 and a buffer of b months on each side
              [ fold 1 ][ fold 2 ]xx[  TEST  ]xx[ fold 4 ][ fold 5 ]
                                ↑ buffer      ↑ buffer
```

The **buffer** removes the months whose information most closely overlaps with the test block. A natural choice is **b ≥ h** (the outcome overlap), plus a margin for the persistence of controls (e.g. 12 months).

Add to `causal/dml.py`:

```python
def blocked_splits(n: int, n_folds: int = 5, buffer: int = 12, offset: int = 0):
    """Contiguous test blocks; training excludes the block ± `buffer` observations.

    `offset` rotates block boundaries, so repeated cross-fitting can use different splits.
    """
    idx = np.arange(n)
    rolled = np.roll(idx, -offset)
    splits = []
    for block in np.array_split(rolled, n_folds):
        test = np.sort(block)
        # a rotated block may wrap around the end; handle each contiguous piece
        pieces = np.split(test, np.where(np.diff(test) != 1)[0] + 1)
        exclude = set()
        for p in pieces:
            exclude |= set(range(max(0, p[0] - buffer), min(n, p[-1] + buffer + 1)))
        train = np.array([i for i in idx if i not in exclude])
        splits.append((train, test))
    return splits
```

Check the splits visually: for each fold, print the test range and the gap to the nearest training observation. Every test month should be at least `buffer` months away from any training month.

> **Trade-off:** larger buffers protect better against dependence, but train nuisances on less data. With ~240 monthly observations, 5 folds and a 12-month buffer, each nuisance model trains on roughly 75% of the sample. Report the buffer, and check results with a smaller and a larger one (Day 77).

---

## 76.3 HAC Inference for Overlapping Horizons (25 min)

`plr_from_residuals(y_res, d_res, hac_lags=L)` (Day 75) already supports Newey–West standard errors. The question is the lag length *L*.

| Source of serial correlation | Implied minimum lag |
|---|---|
| overlapping outcomes over *h* months | *h* (residuals are MA(*h*) by construction) |
| persistence of controls and policy | more; data-driven rules help |

A practical rule: **L = max(h, ⌊4 · (n/100)^(2/9)⌋)**, using the usual Newey–West automatic bandwidth as a floor. Add it:

```python
def hac_lags_for(n: int, h: int) -> int:
    return int(max(h, np.floor(4 * (n / 100) ** (2 / 9))))
```

> **Why not trust DoubleML's default standard errors here?** DoubleML's standard errors assume independent observations. With overlapping 12-month outcomes, they can be **far too small**, making a noisy estimate look precise. The next block measures how much.

---

## 76.4 Monte Carlo: iid vs Time-Series-Aware DML (25 min)

Build a world with the features of 76.1. Add to `causal/simulate.py`:

```python
def ts_world(T: int = 300, h: int = 12, true_effect: float = -5.0, seed: int = 0) -> pd.DataFrame:
    """Monthly world: persistent confounders, gradual policy, overlapping h-month outcomes."""
    rng = np.random.default_rng(seed)
    n = T + h + 1
    c = np.zeros(n)
    s = np.zeros(n)
    v = np.zeros(n)
    for t in range(1, n):
        c[t] = 0.95 * c[t - 1] + rng.normal(0, 0.5)          # slow business cycle
        s[t] = 0.8 * s[t - 1] + rng.normal(0, 0.5)           # second persistent state
        v[t] = 0.5 * v[t - 1] + rng.normal(0, 0.15)          # gradual policy surprises
    c_lag, s_lag = np.roll(c, 1), np.roll(s, 1)
    d = 0.4 * np.tanh(2 * c_lag) + 0.1 * s_lag ** 2 + v      # reaction to last month's state
    e = rng.normal(0, 1.0, n)
    overlap = np.array([e[t + 1:t + h + 1].sum() for t in range(n - h)])
    y = (true_effect * d[:n - h] + 6 * np.sin(c_lag[:n - h]) + 2 * s_lag[:n - h] ** 2
         + overlap)
    df = pd.DataFrame({"c_lag": c_lag[:n - h], "s_lag": s_lag[:n - h],
                       "rate_change": d[:n - h], "housing_growth_h": y})
    return df.iloc[1:T + 1].reset_index(drop=True)
```

Compare three versions in `causal/montecarlo.py`:

```python
from causal.dml import blocked_splits, dml_plr, hac_lags_for
from causal.simulate import ts_world


def ts_coverage(n_sims=100, T=300, h=12, true_effect=-5.0, learner=RF):
    rows = []
    for s in range(n_sims):
        df = ts_world(T=T, h=h, true_effect=true_effect, seed=2000 + s)
        X, y, d = df[["c_lag", "s_lag"]], df["housing_growth_h"], df["rate_change"]
        variants = {
            "iid folds + robust SE": dml_plr(y, d, X, learner, learner, seed=s),
            "iid folds + HAC SE": dml_plr(y, d, X, learner, learner, seed=s,
                                          hac_lags=hac_lags_for(T, h)),
            "blocked folds + HAC SE": dml_plr(y, d, X, learner, learner,
                                              splits=blocked_splits(T, 5, buffer=h + 6),
                                              hac_lags=hac_lags_for(T, h)),
        }
        for name, r in variants.items():
            lo, hi = r.ci()
            rows.append({"variant": name, "theta": r.theta, "se": r.se,
                         "covered": lo <= true_effect <= hi})
    res = pd.DataFrame(rows)
    return res.groupby("variant").agg(mean_theta=("theta", "mean"), sd_theta=("theta", "std"),
                                      mean_se=("se", "mean"), coverage_95=("covered", "mean"))
```

Typical results, which you should verify:

| Variant | Typical coverage | Why |
|---|---|---|
| iid folds + robust SE | **well below 95%** | SEs ignore serial correlation; neighbours leak across folds |
| iid folds + HAC SE | better, often still below | SEs fixed; some leakage across folds remains |
| blocked folds + HAC SE | **close to 95%** | both problems addressed |

Also compare `mean_se` with `sd_theta` for each variant: the iid version's reported SE is typically **much smaller** than the actual sampling variability. That's an overconfident result, the causal-inference version of Day 63's under-covering forecast intervals.

> **The practical lesson for Days 78–80:** with monthly macro data and multi-month outcomes, **always** use blocked folds with buffers and HAC standard errors, and expect wider intervals than an iid analysis would suggest. Those wider intervals are the honest ones.

---

## 76.5 Custom Splits in `doubleml` (18 min)

DoubleML accepts your own splits through `set_sample_splitting`, which lets you combine its machinery (repetitions, model variants, sensitivity analysis on Day 79) with blocked folds:

```python
import doubleml as dml
from sklearn.base import clone

from causal.dml import blocked_splits
from causal.simulate import ts_world

df = ts_world(T=300, h=12, seed=7)
data = dml.DoubleMLData(df, y_col="housing_growth_h", d_cols="rate_change",
                        x_cols=["c_lag", "s_lag"])

reps = [blocked_splits(len(df), n_folds=5, buffer=18, offset=o) for o in (0, 11, 23)]
plr = dml.DoubleMLPLR(data, ml_l=clone(RF), ml_m=clone(RF), score="partialling out")
plr.set_sample_splitting(all_smpls=reps)          # 3 repetitions × 5 blocked folds
plr.fit(store_predictions=True)
print(plr.summary)
```

DoubleML's reported SE is still the **independence** version. Compute HAC inference from its stored, cross-fitted predictions:

```python
import numpy as np

from causal.dml import aggregate_reps, hac_lags_for, plr_from_residuals

y = df["housing_growth_h"].to_numpy()
d = df["rate_change"].to_numpy()
thetas, ses = [], []
for r in range(plr.n_rep):
    y_res = y - plr.predictions["ml_l"][:, r, 0]
    d_res = d - plr.predictions["ml_m"][:, r, 0]
    t, s = plr_from_residuals(y_res, d_res, hac_lags=hac_lags_for(len(y), 12))
    thetas.append(t); ses.append(s)
print("θ̂ (median over reps), HAC SE:", aggregate_reps(thetas, ses))
```

> **Version note:** some DoubleML versions require that each repetition's test folds **partition** the sample (ours do) and may validate the train/test structure. If your version rejects buffered training sets, use `causal/dml.py` (which supports any splits) as the primary estimator, and DoubleML with ordinary blocked folds (`buffer=0`) as a cross-check.

---

## 76.6 Mini-Project: `fit_plr_ts`, a Time-Series DML Wrapper (20 min)

Add a single entry point to `causal/dml.py` that applies everything from today, so Day 77–80 code stays short:

```python
def fit_plr_ts(y, d, X, learner_l, learner_m, h: int, n_folds: int = 5,
               buffer: int | None = None, n_rep: int = 5) -> dict:
    """Time-series DML for the PLR: blocked folds with buffers, HAC SEs, repeated splits."""
    y, d, X = np.asarray(y, float), np.asarray(d, float), np.asarray(X, float)
    n = len(y)
    buffer = h + 6 if buffer is None else buffer
    lags = hac_lags_for(n, h)
    step = max(1, n // (n_folds * n_rep))
    thetas, ses, r2l, r2m = [], [], [], []
    for r in range(n_rep):
        splits = blocked_splits(n, n_folds, buffer, offset=r * step)
        y_res, d_res = cross_fit_residuals(y, d, X, learner_l, learner_m, splits)
        t, s = plr_from_residuals(y_res, d_res, hac_lags=lags)
        thetas.append(t); ses.append(s); r2l.append(r2(y, y_res)); r2m.append(r2(d, d_res))
    theta, se = aggregate_reps(thetas, ses)
    return {"theta": theta, "se": se, "ci_lo": theta - 1.96 * se, "ci_hi": theta + 1.96 * se,
            "r2_l": float(np.median(r2l)), "r2_m": float(np.median(r2m)),
            "n": n, "h": h, "buffer": buffer, "hac_lags": lags, "n_rep": n_rep}
```

Validate it with `ts_world` (mean estimate ≈ −5, coverage near 95% over 100 simulations), then add a unit test in `tests/test_causal.py` that runs one small simulation and checks that the true effect lies inside the estimated interval for a fixed seed. Tests protect methods as well as data.

### Day 76 checklist
- [ ] I can explain how persistence, overlapping outcomes and gradual policy break iid DML
- [ ] Blocked cross-fitting with buffers keeps nuisance predictions genuinely out-of-sample
- [ ] Final-stage HAC standard errors use a lag length tied to the horizon
- [ ] My Monte Carlo shows iid DML over-confident and time-series-aware DML near nominal coverage
- [ ] I can pass custom splits to `doubleml` and compute HAC inference from its predictions
- [ ] `fit_plr_ts` packages the method, validated by simulation and a unit test

```bash
python -m pytest -q tests/test_causal.py
git add causal tests notebooks && git commit -m "Day 76: blocked cross-fitting, HAC inference, ts coverage, fit_plr_ts" && git push
```

---

# DAY 77 — The Partially Linear Model in Practice: A Dress Rehearsal

| Time | Block |
|---|---|
| 0:00 – 0:25 | 77.1 From `design_spec.yml` to an estimation dataset |
| 0:25 – 0:50 | 77.2 A rehearsal outcome: rate changes and the unemployment rate |
| 0:50 – 0:58 | Break |
| 0:58 – 1:18 | 77.3 Learners, diagnostics and the reaction-function fit |
| 1:18 – 1:38 | 77.4 Dynamic responses across horizons |
| 1:38 – 1:45 | Break |
| 1:45 – 2:08 | 77.5 Pre-registered robustness checks |
| 2:08 – 2:30 | 77.6 A specification curve and `run_design.py` |

---

## 77.1 From `design_spec.yml` to an Estimation Dataset (25 min)

The Day 73 spec defines treatment, outcome, controls (with lags and transforms) and exclusions. Build the dataset **from the spec**, reusing Day 68's availability logic, so the estimated model is exactly the reviewed design.

Create `causal/design.py`:

```python
"""Build the estimation dataset defined in causal/design_spec.yml."""
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

from forecasting.availability import load_monthly_panel, transform

SPEC_PATH = Path(__file__).resolve().parent / "design_spec.yml"


def load_design(path=SPEC_PATH) -> dict:
    with open(path) as f:
        return yaml.safe_load(f)


def transform_ext(x: pd.Series, how: str | None) -> pd.Series:
    """Day 68 transforms plus log differences."""
    if how is None or how == "level":
        return x
    if how.startswith("logdiff"):
        k = int(how[7:])
        return 100 * (np.log(x) - np.log(x.shift(k)))
    return transform(x, how)


def build_controls(panel: pd.DataFrame, spec: dict) -> pd.DataFrame:
    cols = {}
    for c in spec["controls"]:
        if c["column"] not in panel:
            continue                                    # e.g. housing until Day 78
        series = panel[c["column"]].shift(c["lag"])
        cols[c["name"]] = transform_ext(series, c.get("transform"))
    return pd.DataFrame(cols, index=panel.index)


def treatment(panel: pd.DataFrame, months: int = 1) -> pd.Series:
    """Change in the month-end overnight rate over `months` months ending in t (pp)."""
    return panel["overnight_rate"].diff(months).rename("d")


def outcome_change(series: pd.Series, h: int, log: bool) -> pd.Series:
    """From t−1 to t+h: log-growth (%) for levels like housing; pp change for rates."""
    if log:
        return (100 * (np.log(series.shift(-h)) - np.log(series.shift(1)))).rename("y")
    return (series.shift(-h) - series.shift(1)).rename("y")


def estimation_frame(panel, spec, outcome_series, h, log_outcome, treat_months=1,
                     start=None, exclude=None) -> pd.DataFrame:
    df = (build_controls(panel, spec)
          .join(treatment(panel, treat_months))
          .join(outcome_change(outcome_series, h, log_outcome)))
    if start:
        df = df.loc[start:]
    if exclude:
        df = df.drop(df.loc[exclude[0]:exclude[1]].index, errors="ignore")
    return df.dropna()
```

Every choice (lags, transforms, sample, exclusions) is driven by the spec or by explicit arguments, so the estimate can be traced back to the reviewed design. That's the same discipline as dbt's `ref()` and GX's specs.

---

## 77.2 A Rehearsal Outcome: Rate Changes and the Unemployment Rate (25 min)

The housing-starts series arrives on Day 78. A professional team doesn't wait: it **rehearses the whole analysis** on an outcome already in the platform, to debug code and diagnostics before the real data arrive. Our rehearsal question:

> *Effect of a 1pp overnight-rate increase on the change in the unemployment rate over the following h months.*

Standard macro reasoning predicts that tightening **raises** unemployment with a lag, so θ should be **positive** at longer horizons. It's a useful **sanity check** on the machinery.

```python
from sklearn.ensemble import RandomForestRegressor

from causal.design import estimation_frame, load_design
from causal.dml import fit_plr_ts
from forecasting.availability import load_monthly_panel

spec = load_design()
panel = load_monthly_panel()
rf = RandomForestRegressor(300, min_samples_leaf=5, max_features=0.5, random_state=0, n_jobs=2)

df = estimation_frame(panel, spec, panel["unemployment_rate"], h=12, log_outcome=False)
X = df.drop(columns=["d", "y"])
res = fit_plr_ts(df["y"], df["d"], X, rf, rf, h=12)
print(f"n={res['n']}  θ̂={res['theta']:+.2f} pp per 1pp  "
      f"95% CI [{res['ci_lo']:+.2f}, {res['ci_hi']:+.2f}]  "
      f"R²(E[D|X])={res['r2_m']:.2f}  R²(E[Y|X])={res['r2_l']:.2f}")
```

(For the rehearsal, the spec's lagged-outcome control is housing, which doesn't exist yet. Add a **lagged unemployment change** control for this outcome, e.g. `unemployment_rate` with `transform: diff6, lag: 1`. The spec already includes unemployment controls.)

### Interpreting the rehearsal

- **Sign and size:** does a tightening raise unemployment a year later? By roughly how many percentage points per 1pp of tightening?
- **Precision:** how wide is the HAC interval? With ~19 years of monthly data and few tightening cycles, wide intervals are expected (Day 72.5).
- **R² of E[D | X]:** how much of rate setting your controls explain. Is there enough residual policy variation left?

### Try it 77.2: the price puzzle

Repeat with **CPI inflation** as the outcome (`panel["headline_yoy"]`, pp change). Early empirical work on monetary policy often found prices **rising** after a tightening, the famous **"price puzzle"** (Sims, 1992), widely interpreted as a sign that the central bank reacted to information about future inflation that the econometrician didn't control for. What do you find? If θ̂ is positive at short horizons, which unobserved confounder from your DAG (Day 73) is the likely culprit, and how might you proxy it (e.g. oil prices, core inflation momentum, market-based expectations)?

---

## 77.3 Learners, Diagnostics and the Reaction-Function Fit (20 min)

Run the rehearsal with several learners and **report diagnostics** alongside estimates:

```python
from sklearn.linear_model import LassoCV, LinearRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from xgboost import XGBRegressor

LEARNERS = {
    "ols (classic regression)": LinearRegression(),
    "lasso": make_pipeline(StandardScaler(), LassoCV(cv=5, max_iter=5000)),
    "random_forest": rf,
    "xgboost": XGBRegressor(n_estimators=300, learning_rate=0.03, max_depth=3, subsample=0.8,
                            colsample_bytree=0.8, random_state=0, n_jobs=2),
}
rows = []
for name, L in LEARNERS.items():
    r = fit_plr_ts(df["y"], df["d"], X, L, L, h=12)
    rows.append({"learner": name, **{k: r[k] for k in ("theta", "se", "ci_lo", "ci_hi", "r2_l", "r2_m")}})
table = pd.DataFrame(rows)
print(table.round(3).to_string(index=False))
```

| Pattern | Reading |
|---|---|
| OLS differs from all ML learners, which agree | non-linear confounding matters; ML adds value |
| all learners agree, OLS included | linear controls suffice for this outcome; reassuring |
| ML learners disagree with similar R² | fragile estimate; report the range |
| some learner has **negative** out-of-fold R² | it predicts worse than the mean, so its θ̂ is unreliable; drop or tune it |

---

## 77.4 Dynamic Responses Across Horizons (20 min)

Estimating θ for several horizons traces the **dynamic effect** of a rate change, in the spirit of local projections (Jordà, 2005):

```python
import matplotlib.pyplot as plt

H = [3, 6, 12, 18, 24]
dyn = []
for h in H:
    dfh = estimation_frame(panel, spec, panel["unemployment_rate"], h=h, log_outcome=False)
    r = fit_plr_ts(dfh["y"], dfh["d"], dfh.drop(columns=["d", "y"]), rf, rf, h=h)
    dyn.append({"h": h, **r})
dyn = pd.DataFrame(dyn)
dyn.to_parquet("data/causal/rehearsal_unemployment_dynamic.parquet", index=False)

fig, ax = plt.subplots(figsize=(8, 4))
ax.plot(dyn["h"], dyn["theta"], marker="o", label="θ̂ (per 1pp rate increase)")
ax.fill_between(dyn["h"], dyn["ci_lo"], dyn["ci_hi"], alpha=0.25, label="95% CI (HAC)")
ax.axhline(0, color="grey", lw=1)
ax.set_xlabel("months after the rate change"); ax.set_ylabel("change in unemployment rate (pp)")
ax.set_title("Rehearsal: dynamic effect of a 1pp tightening on unemployment (DML, PLR)")
ax.legend(); plt.tight_layout(); plt.savefig("data/causal/rehearsal_dynamic.png", dpi=120)
```

Note that each horizon is a **separate** estimate with its own sample (longer horizons lose the most recent months). Intervals at different horizons are **not** independent: the outcomes overlap. Read the plot as a profile, not as a set of separate tests.

---

## 77.5 Pre-Registered Robustness Checks (23 min)

Day 73 listed robustness checks **before** any estimates. Run them now on the rehearsal outcome, exactly as written:

| Check | Implementation | Expected if the design is sound |
|---|---|---|
| **placebo outcome** | outcome = unemployment change from *t−12* to *t−6* (before the decision) | θ ≈ 0, CI covering 0 |
| **negative-control treatment** | treatment = rate change at *t+12* (future) | θ ≈ 0 |
| **alternative treatment** | 3-month cumulative rate change (`treat_months=3`) | similar sign and profile |
| **excluding the pandemic** | `exclude=("2020-03-01", "2021-06-01")` | similar estimate |
| **linear vs ML controls** | OLS learner vs random forest | difference documented and explained |
| **buffer sensitivity** | buffer *h* vs *h* + 12 | similar estimate |

```python
def placebo_outcome(series, lead_start=12, lead_end=6):
    """Change from t−lead_start to t−lead_end: entirely before the decision at t."""
    return (series.shift(lead_end) - series.shift(lead_start)).rename("y")


checks = {}
base = estimation_frame(panel, spec, panel["unemployment_rate"], h=12, log_outcome=False)
Xb = base.drop(columns=["d", "y"])

pl = Xb.join(base["d"]).join(placebo_outcome(panel["unemployment_rate"])).dropna()
checks["placebo outcome"] = fit_plr_ts(pl["y"], pl["d"], pl.drop(columns=["d", "y"]), rf, rf, h=6)

future_d = panel["overnight_rate"].diff().shift(-12).rename("d")
nc = Xb.join(future_d).join(base["y"]).dropna()
checks["negative-control treatment"] = fit_plr_ts(nc["y"], nc["d"], nc.drop(columns=["d", "y"]),
                                                  rf, rf, h=12)

alt = estimation_frame(panel, spec, panel["unemployment_rate"], h=12, log_outcome=False,
                       treat_months=3)
checks["3-month treatment"] = fit_plr_ts(alt["y"], alt["d"], alt.drop(columns=["d", "y"]),
                                         rf, rf, h=12)

ex = estimation_frame(panel, spec, panel["unemployment_rate"], h=12, log_outcome=False,
                      exclude=("2020-03-01", "2021-06-01"))
checks["excl. pandemic"] = fit_plr_ts(ex["y"], ex["d"], ex.drop(columns=["d", "y"]), rf, rf, h=12)

print(pd.DataFrame(checks).T[["theta", "ci_lo", "ci_hi", "n"]].round(3))
```

> **How to react to a failed placebo:** a clearly non-zero placebo effect means the design has a problem (remaining confounding or anticipation), and the main estimate should be reported **with that caveat**, not quietly dropped. Pre-registration is what makes this honest: you can't choose which checks to show after seeing them.

---

## 77.6 A Specification Curve and `run_design.py` (23 min)

Many defensible choices exist: learners, buffer sizes, treatment definitions, sample periods. Rather than report one favourite, show **all** reasonable combinations sorted by estimate, a **specification curve** (Simonsohn, Simmons & Nelson, 2020). If most specifications agree in sign and rough size, the conclusion is robust; if they scatter across zero, it isn't.

```python
import itertools

grid = {
    "learner": ["lasso", "random_forest", "xgboost"],
    "treat_months": [1, 3],
    "exclude_pandemic": [False, True],
    "buffer_extra": [6, 18],
}
rows = []
for learner, tm, exc, bx in itertools.product(*grid.values()):
    dfi = estimation_frame(panel, spec, panel["unemployment_rate"], h=12, log_outcome=False,
                           treat_months=tm,
                           exclude=("2020-03-01", "2021-06-01") if exc else None)
    L = LEARNERS[learner]
    r = fit_plr_ts(dfi["y"], dfi["d"], dfi.drop(columns=["d", "y"]), L, L, h=12, buffer=12 + bx)
    rows.append({"learner": learner, "treat_months": tm, "exclude_pandemic": exc,
                 "buffer": 12 + bx, **{k: r[k] for k in ("theta", "ci_lo", "ci_hi")}})
curve = pd.DataFrame(rows).sort_values("theta").reset_index(drop=True)

fig, ax = plt.subplots(figsize=(9, 3.5))
ax.errorbar(curve.index, curve["theta"],
            yerr=[curve["theta"] - curve["ci_lo"], curve["ci_hi"] - curve["theta"]], fmt="o")
ax.axhline(0, color="grey")
ax.set_xlabel("specification (sorted)"); ax.set_ylabel("θ̂ at h=12")
ax.set_title("Specification curve (rehearsal outcome: unemployment)")
plt.tight_layout(); plt.savefig("data/causal/rehearsal_spec_curve.png", dpi=120)
print(f"{(curve.theta > 0).mean():.0%} of specifications positive; "
      f"{((curve.ci_lo > 0) | (curve.ci_hi < 0)).mean():.0%} exclude zero")
```

### `causal/run_design.py`

Package everything into one script that reads the spec, takes the outcome as an argument, and writes results plus a Markdown report: main estimates by horizon, learner table, robustness checks, specification-curve summary, diagnostics and package versions. On Day 78 the **only** change will be the outcome argument:

```bash
python -m causal.run_design --outcome unemployment_rate --outcome-type change   # rehearsal (today)
python -m causal.run_design --outcome housing_starts --outcome-type log          # Days 78–80
```

<details>
<summary>Solution skeleton</summary>

```python
"""Run the causal design end to end and write results + a report."""
import argparse
import itertools
from datetime import datetime, timezone
from pathlib import Path

import doubleml
import pandas as pd
import sklearn

from causal.design import estimation_frame, load_design
from causal.dml import fit_plr_ts
from forecasting.availability import load_monthly_panel

OUT = Path("data/causal")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--outcome", required=True)
    ap.add_argument("--outcome-type", choices=["log", "change"], required=True)
    ap.add_argument("--horizons", default="3,6,12,24")
    args = ap.parse_args()

    spec, panel = load_design(), load_monthly_panel()
    series = panel[args.outcome]
    log = args.outcome_type == "log"
    H = [int(h) for h in args.horizons.split(",")]
    learners = build_learners()                      # as in 77.3

    main_rows = []
    for h in H:
        df = estimation_frame(panel, spec, series, h=h, log_outcome=log)
        r = fit_plr_ts(df["y"], df["d"], df.drop(columns=["d", "y"]),
                       learners["random_forest"], learners["random_forest"], h=h)
        main_rows.append({"h": h, **r})
    main = pd.DataFrame(main_rows)
    checks = run_robustness(panel, spec, series, log, learners)   # as in 77.5
    curve = run_spec_curve(panel, spec, series, log, learners)    # as in 77.6

    tag = f"{args.outcome}_{datetime.now(timezone.utc):%Y%m%dT%H%M%S}"
    OUT.mkdir(parents=True, exist_ok=True)
    main.to_parquet(OUT / f"main_{tag}.parquet"); checks.to_parquet(OUT / f"checks_{tag}.parquet")
    curve.to_parquet(OUT / f"curve_{tag}.parquet")
    (OUT / f"report_{tag}.md").write_text("\n\n".join([
        f"# Causal design results — outcome: {args.outcome}",
        f"doubleml {doubleml.__version__} · scikit-learn {sklearn.__version__} · "
        "estimator: PLR, blocked cross-fitting, HAC SEs, median over repeated splits",
        "## Main estimates", main.round(3).to_markdown(index=False),
        "## Robustness (pre-registered)", checks.round(3).to_markdown(),
        "## Specification curve", f"{(curve.theta > 0).mean():.0%} positive",
    ]))
    print(f"✓ results written with tag {tag}")


if __name__ == "__main__":
    main()
```

</details>

### Recap: Days 74–77

| Concept | You can now… |
|---|---|
| PLR model | state θ, nuisance functions and the identifying variation; connect it to FWL |
| ML biases | demonstrate regularisation and overfitting bias by simulation |
| orthogonality | explain why residualising both sides protects θ from nuisance errors |
| cross-fitting | implement it by hand and with `doubleml`, with repeated splits |
| diagnostics | interpret nuisance R², including how predictable policy is |
| time series | use blocked folds with buffers and HAC SEs, validated by coverage studies |
| practice | build datasets from a reviewed spec, trace dynamic responses, run pre-registered checks and a specification curve |

### Looking ahead: Days 78–80

- **Day 78:** add **housing starts** to the platform through the full path you've used all course: source (dlt or WAP), staging model, tests, mart, GX expectations. Then rerun `run_design.py` with the real outcome.
- **Day 79:** interpret the results, run **sensitivity analysis** for unobserved confounders (how strong would a missing variable need to be to overturn the result?), and explore heterogeneity (e.g. high vs low inflation regimes).
- **Day 80:** integrate the causal analysis into the orchestrated platform and dashboards, and complete the **final capstone**.

### Day 77 checklist
- [ ] My estimation dataset is built from `design_spec.yml`, with every choice traceable
- [ ] I rehearsed the full analysis on a real outcome, and can interpret sign, size, precision and reaction-function fit
- [ ] I compared learners and reported diagnostics alongside estimates
- [ ] I traced dynamic effects across horizons with HAC intervals
- [ ] I ran every pre-registered robustness check and a specification curve
- [ ] `run_design.py` produces results and a report, and will only need a new outcome on Day 78

```bash
git add causal notebooks && git commit -m "Day 77: design-driven estimation, rehearsal, robustness, spec curve, run_design" && git push
```
