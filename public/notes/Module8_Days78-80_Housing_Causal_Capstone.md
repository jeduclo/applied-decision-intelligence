# Module 8 · Causal Inference with DoubleML
## Days 78–80: The Causal Impact of Bank of Canada Rate Hikes on Housing Starts — and the Final Capstone

**Audience:** MSc Economics students who completed Days 1–77
**Environment:** GitHub Codespaces · all four environments (`.venv`, `.venv-gx`, `.venv-ml`) · the full platform: dlt → DuckDB → dbt → Great Expectations → Prefect → dashboards
**Time per day:** ~5 hours (including breaks and exercises)
**Goal by end of Day 80:** Students answer the curriculum's causal question with a defensible, reproducible analysis. **Housing starts** enter the platform through the same path as every other series (source, seed, staging, mart, tests). The pre-registered DoubleML design estimates the effect of overnight-rate increases on housing starts across horizons. Students test robustness, quantify **sensitivity to unobserved confounding**, examine **asymmetry and heterogeneity**, and write a policy memo. Finally, they integrate the causal results into the orchestrated platform and its dashboards, and complete the **final capstone**, which ties Parts I–III together.

---

### Where we are

| Ready since… | What it gives us today |
|---|---|
| Day 73 | `causal/DAG.md` and `causal/design_spec.yml`: the question, controls, exclusions and pre-registered checks |
| Day 76 | `fit_plr_ts`: DML with blocked cross-fitting, buffers, HAC SEs and repeated splits, validated by simulation |
| Day 77 | `causal/run_design.py`: the whole analysis, rehearsed on unemployment, waiting for one argument |

> **Pre-registration matters today.** The design, controls and robustness checks were fixed **before** we saw the housing data. Resist the temptation to change them after seeing results. Any change from now on must be recorded as a **deviation**, with its reason, in `causal/DEVIATIONS.md`.

### Target additions (by end of Day 80)

```
.dlt/config.toml                       ← + housing-starts vector
macro_dbt/seeds/seed_series.csv        ← + housing_starts row
quality/specs/housing_starts.yml       ← NEW GX expectations
causal/
├── heterogeneity.py                   ← NEW: asymmetry and regime effects
├── sensitivity.py                     ← NEW: DoubleML sensitivity analysis
├── MEMO.md                            ← NEW: the policy memo
└── DEVIATIONS.md                      ← NEW: any departures from the pre-registered design
macro_dbt/models/marts/causal/         ← NEW: causal_effects, causal_checks
orchestration/flows/causal.py          ← NEW: monthly causal refresh
dashboards/build_dashboards.py         ← + "Monetary policy & housing" page
CAPSTONE.md                            ← NEW: the final capstone report
```

---

# DAY 78 — Housing Starts Through the Platform, and First Estimates

| Time | Block |
|---|---|
| 0:00 – 0:45 | 78.1 Finding the right housing-starts series |
| 0:45 – 1:40 | 78.2 Through the platform: ingest, seed, model, test |
| 1:40 – 1:55 | Break |
| 1:55 – 2:30 | 78.3 Profiling and sanity checks |
| 2:30 – 3:25 | 78.4 Running the pre-registered design |
| 3:25 – 3:40 | Break |
| 3:40 – 4:20 | 78.5 Diagnostics: is the design working? |
| 4:20 – 5:00 | 78.6 Robustness checks and the specification curve |

---

## 78.1 Finding the Right Housing-Starts Series (45 min)

Canadian housing starts are compiled by the **Canada Mortgage and Housing Corporation (CMHC)** and published through Statistics Canada tables. The course notebook used table **34-10-0135-01** for a quarterly chart. For our **monthly** design we want a **monthly, seasonally adjusted (at annual rates, SAAR), national total** series.

Rather than guess a table number, **search the catalogue**, just as you searched the Valet catalogue on Day 8. StatCan's WDS lists all tables:

```python
import requests
import pandas as pd

WDS = "https://www150.statcan.gc.ca/t1/wds/rest"
cubes = pd.DataFrame(requests.get(f"{WDS}/getAllCubesListLite", timeout=60).json())
hs = cubes[cubes["cubeTitleEn"].str.contains("housing starts", case=False, na=False)]
print(hs[["productId", "cubeTitleEn", "frequencyCode", "cubeStartDate", "cubeEndDate"]]
      .to_string(index=False))
```

`frequencyCode` follows StatCan's code sets (e.g. monthly vs quarterly; check the WDS documentation for the exact codes). Pick a **monthly** table covering **all areas / Canada** with **seasonally adjusted at annual rates** data.

Then find the **vector** for *Canada, total units, housing starts, SAAR*: use the table's web page (*Add/Remove data → Display vector identifier*, Day 10) or `getCubeMetadata` (Day 26). **Verify** it before using it:

```python
vec = 12345678          # ← replace with the vector you found
info = requests.post(f"{WDS}/getSeriesInfoFromVector", json=[{"vectorId": vec}], timeout=30).json()
obj = info[0]["object"]
print(obj.get("SeriesTitleEn"), "| table", obj.get("productId"),
      "| frequency", obj.get("frequencyCode"), "| scalar", obj.get("scalarFactorCode"))
```

Record in `causal/DAG.md` (data section): table ID, vector ID, title, frequency, unit and scalar factor (e.g. *thousands of units*).

> **If you can only find quarterly data,** the design still works at quarterly frequency: treatment = change in the overnight rate over the quarter, horizons in quarters, controls aggregated as in the GDP nowcast (Day 69). Record this as a deviation. Monthly data give more observations and sharper timing, so prefer them if available.

---

## 78.2 Through the Platform: Ingest, Seed, Model, Test (55 min)

Adding a series now takes **configuration, not code**, the payoff of Modules 3–5.

### 1. Ingestion (dlt, Day 23)

In `.dlt/config.toml`, add the vector to the StatCan vector list:

```toml
[sources.statcan]
vectors = [41690973, 2062815, 12345678]      # CPI, unemployment rate, housing starts (verified)
latest_n = 36
```

New vectors load their full history automatically on the first run (Day 30's `initial_latest_n`).

### 2. The series seed (Days 30, 35, 38)

Add a row to `macro_dbt/seeds/seed_series.csv`:

```csv
v12345678,housing_starts,statcan,monthly,last,75,true,CA,housing,
```

Setting `in_rates_panel = true` makes the monthly panel **pick up the new column automatically**: `int_rates__monthly` builds its columns from the seed with `run_query` (Day 35). Check that `instrument_type` accepts `housing` (Day 38's `accepted_values` test will fail until you add it, which is a useful reminder that tests protect reference data too).

### 3. Run the pipeline

```bash
source .venv/bin/activate
python -m orchestration.flows.daily_refresh            # or: trigger prod-evening from the Prefect UI
```

dlt loads the series; dbt rebuilds `int_macro__observations` → `int_rates__monthly` → `macro_monthly` (with a new `housing_starts` column) and exports Parquet. The `relationships` test confirms the vector is in the seed, and the freshness test starts watching it.

### 4. Quality expectations (GX, Day 44)

Create `quality/specs/housing_starts.yml`, with a query asset selecting the series from `int_macro__observations` (register it in `setup_gx.py`):

```yaml
description: "CMHC housing starts (monthly, SAAR, Canada) — the outcome of the Module 8 causal design."
asset: housing_starts
batch_definition: full
owner: macro-team

critical:
  - type: ExpectColumnValuesToNotBeNull
    kwargs: {column: value}
    meta: {plan_id: H01, dimension: completeness}
  - type: ExpectColumnValuesToBeBetween
    kwargs: {column: value, min_value: 0, strict_min: true}
    meta: {plan_id: H02, dimension: validity, rationale: "Starts are a positive count."}
  - type: ExpectColumnValuesToBeUnique
    kwargs: {column: obs_date}
    meta: {plan_id: H03, dimension: uniqueness}

warning:
  - type: ExpectColumnValuesToBeBetween
    kwargs: {column: value, min_value: 50, max_value: 500, mostly: 0.999}
    meta: {plan_id: H04, dimension: plausibility,
           rationale: "SAAR in thousands; set the band from the Day 45-style profile of YOUR series."}
```

Adjust H04 to the unit you recorded in 78.1 (thousands vs units). A unit mistake here is exactly the kind of error Day 41 warned about.

### 5. Exposure and documentation

Add `housing_starts` to the column documentation of `macro_monthly` (a doc block, Day 40), and add the causal analysis as an **exposure** depending on `macro_monthly` (`causal_housing_analysis`, type `analysis`).

---

## 78.3 Profiling and Sanity Checks (35 min)

Before estimating anything, **look at the data**, as you have before every analysis in this course.

```python
import matplotlib.pyplot as plt

from forecasting.availability import load_monthly_panel

panel = load_monthly_panel()
hs = panel["housing_starts"].dropna()
print(hs.describe().round(1))
print("first:", hs.index.min().date(), " last:", hs.index.max().date(), " n:", len(hs))

fig, ax1 = plt.subplots(figsize=(11, 4))
ax1.plot(hs.index, hs, label="housing starts (SAAR)")
ax2 = ax1.twinx()
ax2.step(panel.index, panel["overnight_rate"], color="#C95555", where="post", label="overnight rate (%)")
ax1.set_title("Housing starts and the policy rate"); fig.legend(loc="upper left")
plt.tight_layout(); plt.savefig("data/causal/housing_vs_rate.png", dpi=120)
```

Checks:
- **Units:** monthly SAAR starts are an **annualised rate**: a value of 250 (thousand) means "at this month's pace, 250,000 starts per year". The notebook's quarterly chart (Module 05) showed **quarterly counts** of a different magnitude. Make sure you understand which you have.
- **Gaps:** the Day 49 continuity logic applies. Confirm there are no missing months.
- **Volatility:** monthly starts are noisy (multi-unit projects start in lumps). That's one reason the outcome is growth over **several months**, and why we expect wide intervals.
- **Eyeball the raw relationship:** in the chart, do starts fall after tightening cycles? Remember Day 71: the raw picture mixes the causal effect with the cycle that drove the hikes.

---

## 78.4 Running the Pre-Registered Design (55 min)

This is the moment the whole module prepared for:

```bash
source .venv-ml/bin/activate
python -m causal.run_design --outcome housing_starts --outcome-type log --horizons 3,6,12,18,24
```

The spec's **lagged-outcome control** (`housing_growth_l1_6`: log growth of starts over the six months before the decision) now activates automatically, since the `housing_starts` column exists.

Read the main table in the report (`data/causal/report_housing_starts_*.md`):

| Column | Meaning |
|---|---|
| `theta` | % change in housing starts from *t−1* to *t+h*, per **1pp** increase in the overnight rate during month *t* |
| `ci_lo`, `ci_hi` | 95% interval with HAC standard errors (Day 76) |
| `r2_m` | out-of-fold R² of the reaction function E[D \| X] |
| `r2_l` | out-of-fold R² of E[Y \| X] |
| `n` | months used |

### From θ to policy language

Rate decisions usually move in **25bp** steps, so translate:

**effect of a 25bp hike = θ / 4** (percent of housing starts after *h* months)

and into units at the current level:

```python
latest_level = hs.iloc[-1]
main = pd.read_parquet(sorted(Path("data/causal").glob("main_housing_starts_*.parquet"))[-1])
main["per_25bp_pct"] = main["theta"] / 4
main["per_25bp_units_saar"] = latest_level * main["per_25bp_pct"] / 100
print(main[["h", "theta", "ci_lo", "ci_hi", "per_25bp_pct", "per_25bp_units_saar"]].round(2))
```

Don't interpret yet beyond sign, magnitude and precision. Day 79 does the full interpretation, after robustness and sensitivity.

### Compare with the naive regression

Also run the **naive** estimate (housing growth on the rate change, no controls) and the **linear-controls** estimate (OLS learners), and keep them for the memo:

```python
import statsmodels.api as sm

from causal.design import estimation_frame, load_design

spec = load_design()
df = estimation_frame(panel, spec, panel["housing_starts"], h=12, log_outcome=True)
naive = sm.OLS(df["y"], sm.add_constant(df["d"])).fit(cov_type="HAC", cov_kwds={"maxlags": 12})
print(f"naive θ (h=12): {naive.params['d']:+.2f}  (HAC se {naive.bse['d']:.2f})")
```

If the naive estimate is **less negative** (or positive) and the DML estimate more negative, you're seeing the confounding of Day 71 in real data. Booms raise both rates and housing.

---

## 78.5 Diagnostics: Is the Design Working? (40 min)

| Diagnostic | Where | Healthy sign | Worry |
|---|---|---|---|
| reaction-function fit | `r2_m` | moderate (policy partly predictable) | very high: little residual variation; very low: controls miss what drives policy |
| outcome fit | `r2_l` | positive | negative: nuisance model predicts worse than the mean, so θ̂ is unreliable |
| learner agreement | learner table (Day 77.3) | ML learners agree; OLS may differ | ML learners disagree widely |
| residual treatment variation | plot of `d − m̂(X)` over time | spread across cycles, not one episode | concentrated in one period (e.g. 2022 only): the estimate is effectively from a single episode |

The last diagnostic deserves a picture. Where does the **identifying variation** come from?

```python
from causal.dml import blocked_splits, cross_fit_residuals
from sklearn.ensemble import RandomForestRegressor

X = df.drop(columns=["d", "y"])
rf = RandomForestRegressor(300, min_samples_leaf=5, max_features=0.5, random_state=0, n_jobs=2)
y_res, d_res = cross_fit_residuals(df["y"].to_numpy(), df["d"].to_numpy(), X.to_numpy(),
                                   rf, rf, blocked_splits(len(df), 5, buffer=18))
v = pd.Series(d_res, index=df.index, name="policy surprise (pp)")
ax = v.plot(figsize=(11, 3), title="Residual rate changes: the variation that identifies θ")
ax.axhline(0, color="grey"); plt.tight_layout(); plt.savefig("data/causal/policy_surprises.png", dpi=120)
print((v ** 2).groupby(v.index.year).sum().div((v ** 2).sum()).round(2).sort_values(ascending=False).head())
```

The last line shows the **share of identifying variation by year**. If one year contributes most of it, say so in the memo: *"the estimate is driven mainly by the 2022 tightening"*. It's an honest statement about external validity.

---

## 78.6 Robustness Checks and the Specification Curve (40 min)

Run the **pre-registered** checks (Day 73's spec, implemented on Day 77) on the real outcome. `run_design.py` already does this; read its robustness table and specification curve:

| Check | What a sound design shows | What to do if it fails |
|---|---|---|
| placebo outcome (starts from *t−12* to *t−6*) | θ ≈ 0 | report residual confounding or anticipation; lean on sensitivity analysis (Day 79) |
| negative-control treatment (rate change at *t+12*) | θ ≈ 0 | slow-moving confounding; consider additional trend controls, recorded as a deviation |
| 3-month cumulative treatment | same sign and profile | discuss treatment timing |
| excluding the pandemic | similar estimate | report both; explain which episode drives results |
| linear vs ML controls | documented difference | explain via non-linear confounding |
| buffer sensitivity | similar estimate | report the range |
| specification curve | most specifications agree in sign | conclusion is fragile; say so |

Copy the robustness table and specification-curve figure into `notebooks/day78.ipynb` with **no interpretation yet**, just facts. Any change you feel tempted to make goes into `causal/DEVIATIONS.md` with a reason, and the original result stays in the record.

### Day 78 checklist
- [ ] I found, verified and documented a monthly SAAR housing-starts vector (table, vector, unit, scalar)
- [ ] Housing starts entered the platform via configuration: dlt vector, seed row, automatic panel column, tests, GX spec, exposure
- [ ] I profiled the series and understand SAAR vs quarterly counts
- [ ] I ran the pre-registered design and translated θ into per-25bp and unit terms
- [ ] I checked diagnostics, including where the identifying variation comes from
- [ ] Pre-registered robustness checks and the specification curve are recorded without post-hoc changes

```bash
git add .dlt/config.toml macro_dbt quality causal notebooks
git commit -m "Day 78: housing starts through the platform; pre-registered DML estimates"
git push
```

---

# DAY 79 — Interpretation, Sensitivity and Heterogeneity

| Time | Block |
|---|---|
| 0:00 – 0:40 | 79.1 Reading the results as an economist |
| 0:40 – 1:40 | 79.2 Sensitivity to unobserved confounding |
| 1:40 – 1:55 | Break |
| 1:55 – 2:45 | 79.3 Asymmetry: are hikes different from cuts? |
| 2:45 – 3:25 | 79.4 Heterogeneity: does the effect depend on the economic regime? |
| 3:25 – 3:40 | Break |
| 3:40 – 4:15 | 79.5 Naive vs DML: telling the confounding story with data |
| 4:15 – 5:00 | 79.6 Writing the policy memo |

---

## 79.1 Reading the Results as an Economist (40 min)

Interpret along four dimensions, in this order:

1. **Sign:** do increases in the overnight rate reduce housing starts? Economic theory (higher borrowing costs for builders and buyers) predicts a negative effect.
2. **Timing:** at which horizon is the effect largest? Monetary transmission to housing is generally described as operating with lags of several quarters: mortgage rates adjust, demand and pre-sales respond, and project starts follow. Does your profile peak at 12–24 months rather than 3?
3. **Magnitude:** express it per 25bp and in units of SAAR starts at today's level (78.4). Is it economically large? Compare it with the typical month-to-month volatility of starts.
4. **Precision:** do the intervals exclude zero? At which horizons? With ~20 years and a few tightening cycles, wide intervals are an expected, **honest** outcome. An imprecise estimate is a valid result.

> **Language discipline.** Write *"under the identifying assumptions of the design, a 25bp increase is estimated to reduce housing starts by about X% after 12 months (95% CI: …)"*. Don't write *"rate hikes reduce housing starts by X%"* as if it were a law of nature. The causal claim is **conditional on assumptions** that you will now stress-test.

---

## 79.2 Sensitivity to Unobserved Confounding (60 min)

Day 73's DAG flagged **unobserved confounders**: sentiment, supply constraints, population growth. The placebo test can reveal some confounding, but not prove its absence. **Sensitivity analysis** asks the complementary question:

> *How strong would an unobserved confounder have to be to change our conclusion?*

DoubleML implements the omitted-variable-bias framework for causal ML of Chernozhukov, Cinelli, Newey, Sharma and Syrgkanis ("Long Story Short: Omitted Variable Bias in Causal Machine Learning"). It's parameterised by:

| Parameter | Meaning (roughly) |
|---|---|
| `cf_y` | share of the outcome's **residual** variation that the unobserved confounder would explain |
| `cf_d` | how much the confounder would improve explaining the **treatment** (the reaction function) |
| `rho` | correlation between the confounder's effects on outcome and treatment (`1.0` = worst case) |

It reports **bounds** on θ for given strengths, and **robustness values**: the minimal strength (with `cf_y = cf_d`) at which the bound reaches zero.

Create `causal/sensitivity.py`:

```python
"""DoubleML sensitivity analysis for the housing design (blocked splits)."""
import doubleml as dml
import numpy as np
from sklearn.base import clone

from causal.dml import blocked_splits


def fit_doubleml_plr(df, x_cols, learner, h, n_folds=5, n_rep=3):
    data = dml.DoubleMLData(df.reset_index(drop=True), y_col="y", d_cols="d", x_cols=x_cols)
    plr = dml.DoubleMLPLR(data, ml_l=clone(learner), ml_m=clone(learner),
                          score="partialling out")
    n = len(df)
    step = max(1, n // (n_folds * n_rep))
    plr.set_sample_splitting(all_smpls=[blocked_splits(n, n_folds, buffer=h + 6, offset=r * step)
                                        for r in range(n_rep)])
    plr.fit()
    return plr


def sensitivity(plr, cf_y=0.03, cf_d=0.03, rho=1.0):
    plr.sensitivity_analysis(cf_y=cf_y, cf_d=cf_d, rho=rho)
    return plr.sensitivity_summary


def benchmark(plr, control_names):
    """How strong is an OBSERVED control? Calibrates 'plausible' unobserved strengths."""
    return {c: plr.sensitivity_benchmark(benchmarking_set=[c]) for c in control_names}
```

Run it at the horizon where the main effect is largest (e.g. *h* = 12):

```python
from causal.sensitivity import benchmark, fit_doubleml_plr, sensitivity

x_cols = [c for c in df.columns if c not in ("d", "y")]
plr = fit_doubleml_plr(df, x_cols, rf, h=12)
print(sensitivity(plr, cf_y=0.03, cf_d=0.03))
fig = plr.sensitivity_plot()                      # a contour plot (plotly)
fig.write_html("data/causal/sensitivity_h12.html")

bench = benchmark(plr, ["cpi_yoy", "unemp", "housing_growth_l1_6"])
for name, b in bench.items():
    print(name); print(b)
```

### Reading it

- The **contour plot** shows how the lower bound of θ moves as confounding strength grows. The zero contour marks where the conclusion would flip.
- **Benchmarking** answers *"an unobserved confounder as strong as inflation (or past housing growth) would imply…"*. If the robustness value is **larger** than the strength of your most important observed confounders, the result would survive an omitted variable **as strong as anything we did control for**. That's a powerful, communicable statement.
- If a confounder **weaker** than observed ones could overturn the result, the conclusion is **fragile**, and the memo must say so.

> **Caveats:** the sensitivity bounds rest on the same model; DoubleML's sensitivity intervals use its default (independence-based) variance, so treat the **bounds on the point estimate** as the main output, and keep the HAC intervals (Day 76) for inference. Check the `sensitivity_*` API in your installed DoubleML version: names and outputs have evolved.

---

## 79.3 Asymmetry: Are Hikes Different from Cuts? (50 min)

The curriculum asks about rate **hikes**. Our θ averages over increases **and** decreases. Do hikes and cuts have **symmetric** effects? Housing could respond more sharply to tightening (credit constraints bind) than to easing.

The partially linear model handles **several treatments**: split the rate change into its positive and negative parts,

**D⁺ = max(D, 0),  D⁻ = min(D, 0),  Y = θ⁺·D⁺ + θ⁻·D⁻ + g(X) + ε**

and partial X out of Y, D⁺ and D⁻ separately. Then regress the Y-residuals on **both** treatment residuals jointly (multivariate Frisch–Waugh–Lovell, Day 74.2).

Create `causal/heterogeneity.py`:

```python
"""PLR with several treatments: asymmetry (hikes vs cuts) and regime interactions."""
import numpy as np
import pandas as pd
import statsmodels.api as sm
from sklearn.base import clone

from causal.dml import blocked_splits, hac_lags_for


def fit_plr_multi_ts(y, D: pd.DataFrame, X, learner, h, n_folds=5, buffer=None):
    """Y = Σ θ_k D_k + g(X) + ε, cross-fitted with blocked folds; HAC inference."""
    y, X = np.asarray(y, float), np.asarray(X, float)
    Dm = D.to_numpy(float)
    n = len(y)
    splits = blocked_splits(n, n_folds, buffer if buffer is not None else h + 6)
    y_res = np.full(n, np.nan)
    D_res = np.full_like(Dm, np.nan)
    for tr, te in splits:
        y_res[te] = y[te] - clone(learner).fit(X[tr], y[tr]).predict(X[te])
        for k in range(Dm.shape[1]):
            D_res[te, k] = Dm[te, k] - clone(learner).fit(X[tr], Dm[tr, k]).predict(X[te])
    fit = sm.OLS(y_res, D_res).fit(cov_type="HAC", cov_kwds={"maxlags": hac_lags_for(n, h)})
    return pd.DataFrame({"theta": fit.params, "se": fit.bse,
                         "ci_lo": fit.conf_int()[:, 0], "ci_hi": fit.conf_int()[:, 1]},
                        index=D.columns), fit
```

```python
from causal.heterogeneity import fit_plr_multi_ts

D = pd.DataFrame({"hike": df["d"].clip(lower=0), "cut": df["d"].clip(upper=0)}, index=df.index)
asym, fit = fit_plr_multi_ts(df["y"], D, df.drop(columns=["d", "y"]), rf, h=12)
print(asym.round(2))
# Test θ⁺ = θ⁻ (symmetry), with HAC covariance
print(fit.t_test("x1 - x2 = 0"))
```

(`x1` and `x2` are statsmodels' default names for the two columns when passing NumPy arrays.)

Interpretation:
- **θ⁺** (hike): effect per 1pp of **increase**, the curriculum's quantity of interest.
- **θ⁻** (cut): effect per 1pp of the **negative** change. Because D⁻ ≤ 0, a negative θ⁻ means cuts *raise* starts.
- The symmetry test asks whether the data can distinguish the two. With few cycles of each kind, it often **can't**. Report that honestly rather than over-reading a point difference.

> Overlap matters doubly here: each treatment's residual variation comes from its own episodes. Check how many months have D⁺ > 0 and D⁻ < 0, and where (78.5's diagnostic, for each part).

---

## 79.4 Heterogeneity: Does the Effect Depend on the Economic Regime? (40 min)

Does tightening bite harder in some conditions, e.g. when inflation is high, or when rates are already elevated? Use an **interaction treatment**: with a pre-treatment regime indicator *R* (part of X),

**Y = θ_low·D + δ·(D × R) + g(X) + ε,  θ_high = θ_low + δ**

```python
regime = (df["cpi_yoy"] > 3).astype(float)               # pre-treatment: lagged inflation above 3%
D2 = pd.DataFrame({"d": df["d"], "d_x_high_inflation": df["d"] * regime}, index=df.index)
het, fit2 = fit_plr_multi_ts(df["y"], D2, df.drop(columns=["d", "y"]), rf, h=12)
print(het.round(2))
theta_high = het.loc["d", "theta"] + het.loc["d_x_high_inflation", "theta"]
print(f"θ (low-inflation regime):  {het.loc['d', 'theta']:+.2f}")
print(f"θ (high-inflation regime): {theta_high:+.2f}")
print(fit2.t_test("x1 + x2 = 0"))                         # is the high-regime effect non-zero?
```

Choose **one or two** regime hypotheses **in advance**, from economic reasoning, and record them in `DEVIATIONS.md` (they weren't in the Day 73 spec). Testing ten regimes and reporting the one that "works" is the specification-searching problem that pre-registration exists to prevent.

### Optional extension: provincial heterogeneity

If you load the **full** CMHC/StatCan table through WAP (Day 50) with provincial starts, you can ask whether effects differ across provinces (e.g. higher-priced housing markets). That's a **panel** design, which raises new questions (common national policy, cross-province dependence). DoubleML offers clustered-data tools for such settings, a natural project after the course.

---

## 79.5 Naive vs DML: Telling the Confounding Story with Data (35 min)

One chart communicates the whole module. For each horizon, plot three estimates with intervals:
1. **naive** (no controls);
2. **linear controls** (OLS nuisances);
3. **DML** (ML nuisances, blocked cross-fitting, HAC).

```python
from sklearn.linear_model import LinearRegression

from causal.dml import fit_plr_ts, hac_lags_for

rows = []
for h in [3, 6, 12, 18, 24]:
    dfh = estimation_frame(panel, spec, panel["housing_starts"], h=h, log_outcome=True)
    Xh = dfh.drop(columns=["d", "y"])
    nv = sm.OLS(dfh["y"], sm.add_constant(dfh["d"])).fit(cov_type="HAC",
                                                          cov_kwds={"maxlags": hac_lags_for(len(dfh), h)})
    rows.append({"h": h, "method": "naive", "theta": nv.params["d"],
                 "lo": nv.conf_int().loc["d", 0], "hi": nv.conf_int().loc["d", 1]})
    for name, L in [("linear controls", LinearRegression()), ("DML (random forest)", rf)]:
        r = fit_plr_ts(dfh["y"], dfh["d"], Xh, L, L, h=h)
        rows.append({"h": h, "method": name, "theta": r["theta"], "lo": r["ci_lo"], "hi": r["ci_hi"]})
comp = pd.DataFrame(rows)

fig, ax = plt.subplots(figsize=(9, 4.5))
for i, (m, g) in enumerate(comp.groupby("method", sort=False)):
    x = g["h"] + (i - 1) * 0.6
    ax.errorbar(x, g["theta"], yerr=[g["theta"] - g["lo"], g["hi"] - g["theta"]],
                fmt="o-", capsize=3, label=m)
ax.axhline(0, color="grey")
ax.set_xlabel("months after the rate change")
ax.set_ylabel("% change in housing starts per 1pp")
ax.set_title("Effect of overnight-rate increases on housing starts: naive vs adjusted")
ax.legend(); plt.tight_layout(); plt.savefig("data/causal/naive_vs_dml.png", dpi=120)
```

If the naive line sits **above** the adjusted ones, the gap is the **confounding bias** from booms that drive both hikes and housing, the Day 71 simulation now visible in real Canadian data. If linear and DML differ, the gap reflects **non-linear** confounding that only flexible controls capture.

---

## 79.6 Writing the Policy Memo (45 min)

Write `causal/MEMO.md`, two pages at most, for a reader at the Bank of Canada or a housing ministry who isn't a methods specialist:

```markdown
# The effect of policy-rate increases on Canadian housing starts

## Bottom line (3 sentences)
Under the identifying assumptions below, a 25bp increase in the overnight rate is estimated to change
housing starts by X% (95% CI: [a, b]) after 12 months, with the effect building over …
The estimate is [robust / fragile] to …; an unobserved factor would need to be [stronger than inflation] to …
A naive comparison [understates / reverses] the effect because …

## Question and design
- Question; unit (month); treatment; outcome; horizons
- Identification: selection on observables — controls for the Bank's information set before each decision
  (inflation, labour market, activity, global rates, past policy, past housing), with publication lags
- Estimator: double/debiased ML (partially linear model), blocked cross-fitting, HAC standard errors
- Pre-registered on <date>; deviations: see DEVIATIONS.md

## Results
- Dynamic effect chart (naive vs adjusted) and table (per 25bp, % and units SAAR)
- Hikes vs cuts; regime heterogeneity (pre-specified only)

## How much should we trust this?
- Robustness checks (placebo, negative control, alternative treatment, pandemic, learners, buffers)
- Sensitivity: robustness value vs benchmarks
- Where the identifying variation comes from (which tightening cycles)

## Limitations
- Unobserved confounders (sentiment, supply constraints, population) — bounded, not eliminated
- Anticipation via forward guidance; few tightening cycles; national aggregate only
- SAAR monthly starts are noisy; results are averages over the sample period

## Data and reproducibility
Platform lineage: StatCan/CMHC → dlt → dbt (macro_monthly) → GX checks; code: causal/; run tag: …
```

**Peer review:** swap memos with a classmate. The reviewer checks that every claim in the bottom line is supported by a table or figure, that limitations are stated plainly, and that no result appears that wasn't pre-registered or listed as a deviation.

### Day 79 checklist
- [ ] I interpreted sign, timing, magnitude (per 25bp, in units) and precision, with careful causal language
- [ ] I quantified sensitivity to unobserved confounding and benchmarked it against observed controls
- [ ] I estimated hike vs cut effects and tested symmetry, with overlap caveats
- [ ] I tested one or two pre-specified regime interactions, recorded as deviations
- [ ] A naive-vs-adjusted chart shows the confounding story in real data
- [ ] `causal/MEMO.md` communicates results, uncertainty and limitations, and passed peer review

```bash
git add causal notebooks && git commit -m "Day 79: interpretation, sensitivity, asymmetry, heterogeneity, memo" && git push
```

---

# DAY 80 — Integration and the Final Capstone

| Time | Block |
|---|---|
| 0:00 – 0:45 | 80.1 Causal results as a data product |
| 0:45 – 1:25 | 80.2 Orchestrating the causal analysis |
| 1:25 – 1:40 | Break |
| 1:40 – 2:25 | 80.3 The "Monetary policy & housing" dashboard |
| 2:25 – 3:10 | 80.4 Capstone extension: designing a causal tariff-impact study |
| 3:10 – 3:25 | Break |
| 3:25 – 4:25 | 80.5 The final capstone: assembly, demonstration and review |
| 4:25 – 5:00 | 80.6 Course wrap-up |

---

## 80.1 Causal Results as a Data Product (45 min)

Like forecasts (Day 70), causal estimates are **data**: kept, versioned, tested and published through the platform.

### Provenance in `run_design.py`

Extend the output rows with metadata, so every estimate can be traced:

```python
run_meta = {
    "run_tag": tag,
    "as_of": datetime.now(timezone.utc),
    "outcome": args.outcome,
    "spec_fingerprint": fingerprint([Path("causal/design_spec.yml")]),    # Day 70 helper
    "data_fingerprint": fingerprint([MARTS / "macro_monthly.parquet"]),
    "git_commit": subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True,
                                 text=True).stdout.strip(),
    "doubleml_version": doubleml.__version__,
}
main = main.assign(**run_meta)
checks = checks.assign(**run_meta)
```

### dbt models

`macro_dbt/models/staging/causal/_causal__sources.yml`:

```yaml
version: 2
sources:
  - name: causal
    description: "Causal estimates from causal/run_design.py (Module 8)."
    meta:
      external_location: "../data/causal/main_*.parquet"
    tables:
      - name: effects
```

`macro_dbt/models/marts/causal/causal_effects_latest.sql`:

```sql
-- Grain: one row per outcome × horizon, from the most recent analysis run.
with ranked as (
    select *,
           row_number() over (partition by outcome, h order by as_of desc) as rn
    from {{ source('causal', 'effects') }}
)
select
    outcome, h, theta, se, ci_lo, ci_hi,
    theta / 4                         as per_25bp_pct,
    r2_m, r2_l, n, buffer, hac_lags,
    run_tag, as_of, spec_fingerprint, data_fingerprint, git_commit
from ranked
where rn = 1
```

Add a similar `causal_checks_latest` from the robustness outputs, with tests: `unique_combination_of_columns` on (outcome, h); `ci_lo ≤ theta ≤ ci_hi` (`dbt_utils.expression_is_true`); `n ≥ 120` (warn). Then add GX expectations for the marts (Day 70.4 style), and an **exposure** linking them to the new dashboard page.

> Keeping every run (not just the latest) means you can show how the estimate **evolves** as new data arrive: a policy-relevant check of stability, and protection against quietly overwriting an inconvenient result.

---

## 80.2 Orchestrating the Causal Analysis (40 min)

Causal analysis doesn't need to run daily. It should run **when its inputs change meaningfully**:
- on a **monthly** schedule (new housing-starts data);
- when the **design spec** changes (a reviewed commit), which requires a full rerun and comparison with the previous run.

Add the step policy (Day 54) and a flow, `orchestration/flows/causal.py`:

```python
"""Monthly causal refresh: re-estimate, model results in dbt, validate."""
from prefect import flow

from orchestration.settings import ML_PY
from orchestration.tasks.commands import step
from orchestration.tasks.dbt import dbt_invoke


@flow(name="causal-housing")
def causal_flow(target: str = "prod", drill: dict | None = None) -> dict:
    states = {"causal_estimates": step(
        "causal_estimates",
        [ML_PY, "-m", "causal.run_design", "--outcome", "housing_starts",
         "--outcome-type", "log", "--horizons", "3,6,12,18,24"], drill=drill)}
    if states["causal_estimates"].is_completed():
        states["dbt_causal"] = dbt_invoke.with_options(name="dbt:causal")(
            ["build", "--target", target, "--select", "source:causal+"], return_state=True)
    return states
```

```python
# orchestration/settings.py — STEP_POLICIES
    "causal_estimates": dict(retries=0, delays=[], timeout=7200, transient=(), warning=(2,)),
```

(Statistical estimation is deterministic given its inputs, so a failure isn't transient and isn't retried.)

Deployment in `prefect.yaml`:

```yaml
  - name: causal-housing-monthly
    description: "Re-estimate the effect of rate changes on housing starts (Module 8)."
    entrypoint: orchestration/flows/causal.py:causal_flow
    work_pool:
      name: local-process
      job_variables:
        env:
          PYTHONPATH: /workspaces/macro-data-course
    concurrency_limit: 1
    schedules:
      - cron: "0 7 20 * *"              # 20th of each month, 07:00 Toronto time
        timezone: "America/Toronto"
```

Update `STATE_POLICY.md`: a failed causal run is a **warning** for the platform (dashboards keep showing the previous run, with its `as_of` date), never a blocker for the daily refresh.

---

## 80.3 The "Monetary Policy & Housing" Dashboard (45 min)

Add a page to `dashboards/build_dashboards.py`, reading only exported marts:

```python
def policy_housing(monthly: pd.DataFrame, effects: pd.DataFrame, checks: pd.DataFrame) -> Path:
    fig = make_subplots(rows=1, cols=2, column_widths=[0.55, 0.45],
                        subplot_titles=["Housing starts and the overnight rate",
                                        "Estimated effect of a +25bp increase (% of starts)"],
                        specs=[[{"secondary_y": True}, {}]])
    m = monthly[monthly["month"] >= "2006-01-01"]
    fig.add_trace(go.Scatter(x=m["month"], y=m["housing_starts"], name="Housing starts (SAAR)",
                             line=dict(color=C["primary"])), row=1, col=1)
    fig.add_trace(go.Scatter(x=m["month"], y=m["overnight_rate"], name="Overnight rate (%)",
                             line=dict(color=C["negative"], shape="hv")), row=1, col=1,
                  secondary_y=True)

    e = effects[effects["outcome"] == "housing_starts"].sort_values("h")
    fig.add_trace(go.Scatter(x=e["h"], y=e["ci_hi"] / 4, line=dict(width=0), showlegend=False),
                  row=1, col=2)
    fig.add_trace(go.Scatter(x=e["h"], y=e["ci_lo"] / 4, fill="tonexty",
                             fillcolor="rgba(74,144,217,0.25)", line=dict(width=0),
                             name="95% CI (HAC)"), row=1, col=2)
    fig.add_trace(go.Scatter(x=e["h"], y=e["per_25bp_pct"], mode="lines+markers",
                             name="estimate", line=dict(color=C["primary"], width=3)), row=1, col=2)
    fig.add_hline(y=0, line_color=C["muted"], row=1, col=2)

    placebo = checks.query("check == 'placebo outcome'")
    placebo_ok = (not placebo.empty
                  and placebo["ci_lo"].iloc[0] <= 0 <= placebo["ci_hi"].iloc[0])
    caveat = ("Causal estimate under selection-on-observables assumptions (DoubleML, PLR). "
              f"Placebo test {'passed' if placebo_ok else 'NOT passed — interpret with caution'}. "
              f"Run {e['as_of'].max():%Y-%m-%d}. See causal/MEMO.md.")
    fig.update_layout(**LAYOUT, height=520,
                      title=dict(text=f"<b>Monetary policy & housing</b><br><sup>{caveat}</sup>"))
    fig.update_xaxes(title_text="months after the rate change", row=1, col=2)
    out = SITE / "policy_housing.html"
    fig.write_html(out)
    return out
```

Add the recession bands (Day 7's `add_recession_shading` logic, or `seed_recession_bands`) to the left panel, and a KPI to `macro_kpis`: *"Estimated effect of +25bp on housing starts after 12 months: X% [CI]"*, with its `as_of`.

> The dashboard banner states the **assumptions** and the **placebo result** next to the number. A causal estimate shown without its caveats invites over-interpretation, and that's the most common way causal analysis misleads decision-makers.

---

## 80.4 Capstone Extension: Designing a Causal Tariff-Impact Study (45 min)

The curriculum's capstone table lists **"causal tariff impact models"** under *Model & Forecast*. The course notebook tracks a 2025–26 tariff shock (its "Tariff recession" band and sector-level `TARIFF_STATUS` exposure table). Estimating its effects is a natural extension, and a harder design problem than the rate-hike question. Today you write a **design**, not results.

### Why it's harder

| Feature | Rate hikes (Days 78–79) | Tariff shock |
|---|---|---|
| treatment variation over time | many decisions over 20 years | essentially **one** event |
| comparison | months with different rate changes | **units** (sectors, provinces) with different **exposure** |
| natural design | selection on observables (PLR) | **difference-in-differences (DiD)** with exposure intensity |
| main threats | unobserved confounders of policy | other shocks at the same time; anticipation; spillovers; few post-treatment periods |

### A DiD sketch with exposure intensity

Units: provinces (or industries). Exposure *Eᵢ*: the share of output or exports in tariffed sectors **before** the shock (built from the notebook's tariff matrix and provincial or industry data you'd ingest). Outcome *Yᵢₜ*: provincial employment, exports or manufacturing sales.

**Yᵢₜ = αᵢ + λₜ + β · (Eᵢ × Postₜ) + controls + εᵢₜ**

β compares the change in outcomes after the shock for **more exposed** vs **less exposed** units. The key assumption is **parallel trends**: without tariffs, exposed and less-exposed units would have evolved alike. Check it with **pre-period event-study coefficients** (the DiD analogue of the placebo test). DoubleML offers DiD estimators that use ML to adjust for covariates (check the package documentation for the current DiD classes).

### Deliverable: `causal/tariff_design_spec.yml`

Write the design in the same format as Day 73's spec: question, units, exposure definition and data sources (what the platform would need to ingest), outcome, treatment timing (announcement vs implementation), controls, pre-registered checks (event-study pre-trends, placebo dates, leave-one-province-out), and an explicit **threats** section (concurrent shocks such as interest-rate and energy-price changes; anticipation; trade diversion; small number of units). Implementing it is a strong option for an extended capstone project.

---

## 80.5 The Final Capstone: Assembly, Demonstration and Review (60 min)

### The capstone deliverable

The curriculum's final capstone links the Prefect-orchestrated pipeline to interactive visualisation layers. Your platform now delivers each row of the capstone table:

| Component | Technology | Capstone deliverable | Where you built it |
|---|---|---|---|
| **Extract & Load** | Python, dlt, DuckDB | automated ingestion of BoC, FRED and StatCan series | Modules 1–3; WAP and release watcher (Days 48–50, 59) |
| **Transform & Test** | dbt, Great Expectations | validated macro marts (yield spreads, real rates) | Modules 4–5 (`macro_monthly`, `fct_open_economy_daily`, …) |
| **Model & Forecast** | DoubleML, XGBoost, Chronos | causal models (rate hikes → housing; tariff design) and next-quarter GDP forecasts | Modules 7–8 |
| **Orchestration & visualisation** | Prefect, Plotly | scheduled, event-driven, monitored pipeline with dashboards | Module 6; Days 60, 66, 70, 80 |

### `CAPSTONE.md`: the final report

Write it at the repository root, as the entry point for anyone discovering your project:

```markdown
# Canadian Macro Decision-Intelligence Platform — Capstone

## 1. What it does (one paragraph + the architecture diagram)
## 2. How to run it (setup, environments, one-command pipeline, Prefect deployments)
## 3. Data: sources, lineage, quality (links: dbt docs, Data Docs, DATA_QUALITY_PLAN.md)
## 4. Forecasts: CPI and GDP — method, backtest, live track record (MODEL_CARD.md)
## 5. Causal analysis: rate hikes and housing starts — results and caveats (causal/MEMO.md)
## 6. Dashboards: pages and what each answers
## 7. Operations: schedules, alerts, runbook, backups, readiness review (PRODUCTION_READINESS.md)
## 8. Limitations and next steps (including the tariff-impact design)
```

### The live demonstration (15 minutes per student or team)

1. **Trigger a refresh** from the Prefect UI and narrate the flow: ingestion per source → WAP audit → targeted dbt build → GX gates → forecasts → dashboards.
2. **Show a failure being handled:** run one drill (Day 54) or chaos scenario (Day 50) and show the state, alert and unchanged production data.
3. **Open the dashboards:** the macro cockpit, the forecast page (with explanations and track record), and the policy-and-housing page (with caveats).
4. **Answer one economic question live** using the platform, e.g. *"What happened to the CA–US 2-year spread during the last tightening cycle, and what did our models forecast at the time?"*

### Review rubric

| Dimension | Excellent looks like |
|---|---|
| **Reproducibility** | a fresh Codespace can rebuild everything from the README; versions pinned; no secrets in Git |
| **Data quality** | contracts at the boundary and the marts; quality history and KPIs; documented incidents |
| **Engineering** | layered models, DRY code, tests, idempotent steps, clear state policy, observability |
| **Forecasting rigour** | leak-free backtests, benchmarks, significance tests, calibrated intervals, live track record |
| **Causal rigour** | explicit DAG, pre-registration, diagnostics, robustness, sensitivity, honest limitations |
| **Communication** | dashboards with dates and caveats; memo and model card a non-specialist can follow |

Use the Day 60 production-readiness checklist, extended with the forecasting model card and the causal memo, for **peer review**: each reviewer asks for **evidence** behind every claim, as on Day 60.

---

## 80.6 Course Wrap-Up (35 min)

### What you built in 80 days

```
Days 1–10   Python, pandas, REST APIs           → reliable extraction from BoC, FRED, StatCan
Days 11–20  DuckDB and analytical SQL           → a layered warehouse; growth rates and moving averages in SQL
Days 21–30  dlt                                 → declarative, incremental, contract-protected, resilient ingestion
Days 31–40  dbt                                 → modular, tested, documented marts; the open-economy mart
Days 41–50  Great Expectations                  → data contracts, Data Docs, Write–Audit–Publish for StatCan releases
Days 51–60  Prefect                             → scheduled, event-driven, observable orchestration; dashboards
Days 61–70  XGBoost, SHAP, Chronos              → honest CPI and GDP forecasting, explained and monitored
Days 71–80  DoubleML                            → credible causal estimates of monetary policy on housing
```

### The habits that matter more than the tools

Tools change; the course's recurring principles don't:

1. **Write down the contract before the code**: quality plans, state policies, feature specs, design specs, pre-registration.
2. **Never trust; verify**: regression tests at every migration, chaos and failure drills, Monte Carlo coverage, placebo tests.
3. **Respect time**: publication lags, vintages, leak-free evaluation, pre-treatment controls.
4. **Keep provenance**: every number traceable to its data, code and run.
5. **Say what you don't know**: intervals, caveats, limitations, sensitivity, out-of-range warnings.

### Where to go next

| Direction | Starting point |
|---|---|
| production deployment | always-on infrastructure, managed Prefect, a hosted DuckDB-compatible warehouse (Day 56) |
| real-time econometrics | use the vintages and snapshots you've been collecting for fully real-time evaluation (Days 27, 37, 68) |
| richer macro models | Bayesian VARs, dynamic factor models for nowcasting, mixed-frequency models |
| more causal designs | the tariff DiD (80.4); policy shocks from high-frequency market data; regional panels |
| your own question | add a series (one config line, one seed row), extend the DAG, and run the playbook |

> **A last word.** You started with `print("Hello, macroeconomics!")`. You end with a platform that can tell a policymaker, every morning and with stated confidence, what the data say, what the models expect, and what the evidence suggests a policy change would do. That combination of economic judgement, statistical honesty and engineering discipline is what *applied decision intelligence* means.

### Day 80 checklist
- [ ] Causal estimates are published with provenance, modelled in dbt, tested, and exposed
- [ ] A monthly Prefect deployment re-estimates the design without blocking the daily refresh
- [ ] The "Monetary policy & housing" dashboard shows estimates, intervals, placebo status and caveats
- [ ] A tariff-impact causal design specification is written, with threats and pre-registered checks
- [ ] `CAPSTONE.md` documents the platform end to end; the live demonstration and peer review are complete
- [ ] I can explain how every layer, from APIs to causal estimates, fits together

```bash
git add .
git commit -m "Day 80: causal results in the platform, dashboard, tariff design, final capstone"
git push
```

🎓 **Congratulations: course complete.**
