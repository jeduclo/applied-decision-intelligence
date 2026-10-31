# Module 8 · Causal Inference with DoubleML
## Days 71–73: Causal Inference Theory, Confounding Variables and Directed Acyclic Graphs (DAGs)

**Audience:** MSc Economics students who completed Days 1–70
**Environment:** GitHub Codespaces · `.venv-ml` (plus `networkx`, `doubleml`, optionally `dowhy`) · marts in `data/marts/*.parquet`
**Time per day:** ~2.5 hours (including breaks and exercises)
**Goal by end of Day 73:** Students can state a macroeconomic **causal question** precisely in the potential-outcomes framework, and explain, with simulations they wrote themselves, how **confounding**, **mediators**, **colliders** and **bad controls** bias estimates. They can draw and analyse a **DAG** for the curriculum's question, *"What is the causal effect of Bank of Canada overnight-rate hikes on housing starts?"*, derive a valid **adjustment set**, check **overlap** in real data, and write a reviewed **causal design specification** that Days 74–80 implement with DoubleML.

---

### From "what will happen" to "what would happen if…"

> **Question it answers:** If the Bank of Canada raised rates, what would happen to housing starts, as opposed to what tends to happen alongside rate hikes?
>
> **Other questions you can answer the same way:**
> - Does a rate hike cause housing to slow, or do hikes just happen during booms?
> - Why can't a forecasting model answer "what if" questions?

Module 7 asked **ŷ questions**: *what will inflation be next year?* Every SHAP chart came with a warning that it described the model's **associations**, not **causal effects** (Day 65.6). Module 8 asks **β̂ questions** (Day 61.1):

> *If the Bank of Canada raises its policy rate by 25 basis points, by how much do housing starts change over the following months?*

This is the question a policymaker actually faces, and a forecasting model can't answer it. Here's why, in one picture:

```
              economic boom
             /              \
            ▼                ▼
   BoC raises rates     housing starts rise
            \                ▲
             \──── (−) ──────┘     ← the effect we want
```

Booms make the Bank **raise rates** and also make builders **start more houses**. In raw data, rate hikes and strong housing therefore occur **together**. A naive regression may even suggest that hikes **increase** housing starts. Separating the true (presumably negative) effect from this common cause is the core problem of causal inference.

### The plan for Module 8

| Days | Focus |
|---|---|
| **71–73** | causal theory, confounding and bad controls, DAGs, design specification |
| 74–77 | nuisance parameters, cross-fitting, the partially linear model (DoubleML) |
| 78–80 | the effect of BoC rate hikes on housing starts, with robustness and sensitivity analysis, integrated into the platform |

### Target structure (by end of Day 73)

```
causal/                         ← NEW
├── __init__.py
├── simulate.py                 ← synthetic worlds where the truth is known
├── dag.py                      ← DAG, backdoor paths, adjustment sets, d-separation
├── balance.py                  ← overlap and balance diagnostics on real data
├── DAG.md                      ← the reviewed causal graph, edge by edge
└── design_spec.yml             ← treatment, outcome, controls, exclusions, assumptions
notebooks/day71.ipynb … day73.ipynb
```

Install the extra libraries into the modelling environment:

```bash
cd /workspaces/macro-data-course
source .venv-ml/bin/activate
pip install networkx doubleml
pip install dowhy            # optional: cross-checks adjustment sets on Day 73
pip freeze > forecasting/requirements-ml.txt
mkdir -p causal && touch causal/__init__.py
```

---

# DAY 71 — Causal Inference Foundations

| Time | Block |
|---|---|
| 0:00 – 0:20 | 71.1 Correlation, prediction and causation in macroeconomics |
| 0:20 – 0:48 | 71.2 Potential outcomes: the language of causal effects |
| 0:48 – 0:55 | Break |
| 0:55 – 1:20 | 71.3 Identification: the assumptions that make effects estimable |
| 1:20 – 1:45 | 71.4 Simulation lab: watching confounding happen |
| 1:45 – 1:53 | Break |
| 1:53 – 2:10 | 71.5 Experiments, natural experiments and observational macro data |
| 2:10 – 2:30 | 71.6 Mini-project: breaking and fixing the simulation |

---

## 71.1 Correlation, Prediction and Causation in Macroeconomics (20 min)

Three different questions about the same data:

| Question | Type | Answered by |
|---|---|---|
| *Are high rates and strong housing seen together?* | **association** | a correlation |
| *Given today's data, what will housing starts be next year?* | **prediction** | Module 7's models |
| *If the Bank raised rates by 25bp, what would housing starts be?* | **causation** | Module 8 |

A good predictive model can be a **terrible** causal model. If rate hikes reliably occur in booms, a forecasting model **should** use "rates are rising" as a signal of a strong economy, and may predict **more** housing starts after a hike. That's a correct forecast and a wrong policy conclusion.

### Why macro causality is especially hard

| Difficulty | In our question |
|---|---|
| **Policy responds to the economy** | the Bank sets rates *because of* inflation, growth and housing (a *reaction function*) |
| **Expectations and anticipation** | markets and builders anticipate hikes (forward guidance), so effects can appear *before* the decision |
| **Few independent observations** | one country, a few hundred months, a handful of tightening cycles |
| **Everything moves together** | business-cycle variables are highly correlated |
| **Lags** | monetary policy affects housing over months to years |

Macroeconomists have developed specific strategies for these problems, for example narrative identification of policy shocks (Romer & Romer, 2004), high-frequency identification around announcements (e.g. Gürkaynak, Sack & Swanson, 2005), and local projections for dynamic effects (Jordà, 2005). This module uses a **selection-on-observables** design: control for the information the central bank reacted to, and use machine learning to do so flexibly (DoubleML). You'll also learn exactly what that design assumes, and therefore where it can fail.

---

## 71.2 Potential Outcomes: The Language of Causal Effects (28 min)

The **potential outcomes** framework (associated with Neyman and Rubin) defines causal effects precisely.

For each unit (here, a **month** *t*) and a binary treatment *D* (e.g. "the Bank hiked this month"):
- **Y(1)** = housing starts that **would** occur if the Bank hiked;
- **Y(0)** = housing starts that **would** occur if it didn't.

The **causal effect** for that month is **Y(1) − Y(0)**.

### The fundamental problem of causal inference

In any month we observe **only one** of the two: the one corresponding to what the Bank actually did. The other is a **counterfactual**, never observed. Causal inference is therefore always about **estimating something we can't see**, using assumptions to fill the gap.

| Month | Hiked? | Y(1) | Y(0) | Effect |
|---|---|---|---|---|
| 2022-07 | yes | **observed** | ? | ? |
| 2019-07 | no | ? | **observed** | ? |

### Average effects

Since individual effects are unobservable, we estimate **averages**:

| Estimand | Definition | Question |
|---|---|---|
| **ATE** | E[Y(1) − Y(0)] | average effect over all months |
| **ATT** | E[Y(1) − Y(0) \| D = 1] | average effect in months when the Bank actually hiked |
| **CATE** | E[Y(1) − Y(0) \| X = x] | effect in particular conditions (e.g. when inflation is high) |

### Continuous treatments

Policy rates change by different amounts (25bp, 50bp, 100bp). With a **continuous treatment** *D* (the change in the overnight rate, in percentage points), the natural estimand is the **effect per unit**: how much housing starts change **per 1pp** (or per 25bp) rate increase, holding the economic situation fixed. That's exactly what the **partially linear model** in DoubleML estimates (Days 74–77):

**Y = θ · D + g(X) + ε**

where **θ** is the causal effect per unit of *D*, and **g(X)** captures everything the economic situation *X* does to *Y*, in any flexible form.

### Defining the outcome over horizons

Monetary policy works with **lags**, so the outcome must specify a horizon *h*:

**Y_{t,h} = 100 × [log(housing starts_{t+h}) − log(housing starts_{t−1})]**

the percentage change in housing starts from just before the decision to *h* months after it. Estimating θ for *h* = 3, 6, 12 and 24 months traces out a **dynamic response**, the same idea as local projections (Jordà, 2005).

---

## 71.3 Identification: The Assumptions That Make Effects Estimable (25 min)

**Identification** means: *under which assumptions can the causal effect be computed from the data we have, given infinite data?* Estimation (how to compute it well from finite data) comes later.

For a selection-on-observables design, the key assumptions are:

| Assumption | Statement | In our question |
|---|---|---|
| **Unconfoundedness** (conditional ignorability) | given controls *X*, treatment is "as good as random": (Y(1), Y(0)) ⫫ D \| X | once we control for what the Bank reacted to (inflation, growth, labour market, housing, global rates), remaining variation in rate changes is unrelated to what housing would otherwise have done |
| **Overlap** (positivity) | every combination of *X* has some probability of each treatment level | we observe hikes **and** non-hikes across a range of economic conditions |
| **SUTVA** | one month's treatment doesn't change another month's potential outcomes, and the treatment is well defined | strained in macro: policy has persistent effects across months; we address this by defining dynamic outcomes and controlling for past policy |
| **No anticipation** | outcomes before the treatment aren't affected by it | strained by forward guidance; tested with placebo outcomes (Day 73.5) |

> **Unconfoundedness is untestable.** No statistic can prove that you controlled for every common cause. You can only make it **plausible** (with economic reasoning and a DAG, Day 73), **probe** it (placebo and negative-control tests), and **quantify** how strong an unobserved confounder would need to be to overturn your result (sensitivity analysis, Days 78–80). Machine learning helps you control for **observed** confounders flexibly. It does **nothing** about unobserved ones.

### Where machine learning fits

Classical regression with controls assumes **g(X)** is linear. Reaction functions and housing dynamics are not obviously linear: the Bank may respond more strongly when inflation is far from target, and housing may react differently in booms and busts. DoubleML (Chernozhukov et al., 2018) uses flexible ML models to learn *g(X)* and the reaction function *m(X)* = E[D | X], while still delivering a **valid estimate and standard error for θ**. That combination is why it suits this question.

---

## 71.4 Simulation Lab: Watching Confounding Happen (25 min)

> **Question it answers:** In a world where I know the true effect of rates on housing is −5, what does a naive regression estimate?
>
> **Other questions you can answer the same way:**
> - How wrong can a simple correlation be when the business cycle drives both variables?

The best way to understand bias is to build a world where **you know the true effect**, then see which methods recover it.

Create `causal/simulate.py`:

```python
"""Synthetic monthly economies where the true causal effect is known."""
import numpy as np
import pandas as pd


def confounded_world(T: int = 600, true_effect: float = -5.0, cycle_on_rates: float = 0.5,
                     cycle_on_housing: float = 10.0, seed: int = 42) -> pd.DataFrame:
    """A business cycle drives both rate changes (policy reaction) and housing.

    D = rate change (pp), Y = housing-starts growth (%), C = cycle (confounder).
    True causal effect of D on Y: `true_effect` per 1pp.
    """
    rng = np.random.default_rng(seed)
    c = np.zeros(T)
    for t in range(1, T):
        c[t] = 0.9 * c[t - 1] + rng.normal(0, 1)               # persistent business cycle
    d = cycle_on_rates * c + rng.normal(0, 0.5, T)             # the Bank reacts to the cycle
    y = cycle_on_housing * c + true_effect * d + rng.normal(0, 3, T)
    return pd.DataFrame({"cycle": c, "rate_change": d, "housing_growth": y})
```

Now estimate the effect two ways:

```python
import statsmodels.formula.api as smf

from causal.simulate import confounded_world

df = confounded_world()
naive = smf.ols("housing_growth ~ rate_change", data=df).fit()
adjusted = smf.ols("housing_growth ~ rate_change + cycle", data=df).fit()

print(f"true effect:      -5.00")
print(f"naive estimate:   {naive.params['rate_change']:+.2f}  (se {naive.bse['rate_change']:.2f})")
print(f"adjusted estimate:{adjusted.params['rate_change']:+.2f}  (se {adjusted.bse['rate_change']:.2f})")
```

The naive estimate is typically **positive and large**: the regression "finds" that rate hikes **raise** housing starts. Controlling for the cycle recovers approximately −5.

### Why: the omitted-variable bias formula

> **Question it answers:** How large is the bias from leaving out the business cycle, and can I predict it with the omitted-variable formula?
>
> **Other questions you can answer the same way:**
> - In which direction does omitting the cycle bias the estimated effect?

From econometrics: if the true model is Y = θD + βC + ε, and you omit C, the naive coefficient converges to

**θ_naive = θ + β · δ**, where δ = Cov(D, C) / Var(D)

the coefficient from regressing the omitted C on D. Here θ = −5, β = 10 (the cycle raises housing), and δ > 0 (the Bank hikes in booms), so the bias **β·δ is large and positive**, enough to flip the sign.

Verify the formula numerically:

```python
delta = smf.ols("cycle ~ rate_change", data=df).fit().params["rate_change"]
print(f"θ + β·δ = -5 + 10 × {delta:.2f} = {-5 + 10 * delta:+.2f}   vs naive {naive.params['rate_change']:+.2f}")
```

> **The economist's sign test:** before estimating anything, reason about the **direction** of likely bias. Common causes that raise both rate hikes and housing activity bias the naive estimate **upwards** (towards zero or positive). If a naive estimate shows that hikes *raise* housing, suspect confounding before believing it.

---

## 71.5 Experiments, Natural Experiments and Observational Macro Data (18 min)

| Design | How treatment is assigned | Unconfoundedness | Feasible for our question? |
|---|---|---|---|
| **Randomised experiment** | by a coin flip | guaranteed by design | no: central banks don't randomise policy |
| **Natural experiment** | by an "as-if random" event (e.g. an unexpected policy surprise) | plausible if the event is truly unrelated to outcomes | partly: monetary policy *surprises* (narrative or market-based) |
| **Instrumental variables** | via a variable affecting treatment only | requires a valid instrument | hard to find in macro |
| **Selection on observables** | by the decision-maker, based on observed information | assumed, given good controls | **yes**: this module's main design, with ML controls |

Selection on observables is plausible here for a specific reason: **the Bank of Canada publishes its reasoning.** Its decisions respond to a fairly well-understood set of indicators (inflation and its outlook, the output gap, the labour market, global conditions, housing and financial stability). If we control for that **information set**, much of the remaining variation in rate changes reflects timing, judgement and surprises, which is closer to "as good as random". This is the logic behind estimating policy shocks as **residuals from a reaction function**, an idea DoubleML formalises (Day 74).

The design's main weaknesses are worth stating up front:
- variables the Bank saw but we don't (internal forecasts, market intelligence) are **unobserved confounders**;
- **anticipation** through forward guidance blurs the timing of the treatment;
- few tightening cycles limit **overlap** and precision.

Days 72–73 and 78–80 address each one explicitly.

---

## 71.6 Mini-Project: Breaking and Fixing the Simulation (20 min)

Extend `causal/simulate.py` and answer each question in `notebooks/day71.ipynb`, with numbers.

1. **Weak vs strong reaction.** Set `cycle_on_rates` to 0.1, then 2.0. How does the naive bias change? Explain with δ in the OVB formula.
2. **A noisy confounder.** Suppose we only observe `cycle_obs = cycle + noise` (measurement error, like a GDP-based output-gap estimate). Control for `cycle_obs` instead of `cycle`. Is the bias fully removed? Why not?
3. **Non-linear reaction.** Make the Bank react only to strong booms: `d = 0.8 * np.maximum(c, 0) + noise`, and make housing respond non-linearly: `y = 3 * c**2 + ...`. Does a **linear** control for `cycle` still recover −5? What does this suggest about flexible ML controls?
4. **Sample size.** With `T = 150` (about 12 years of monthly data), run 200 simulations with different seeds and plot the distribution of the adjusted estimate. How precise can we hope to be with real Canadian data?

<details>
<summary>Answers in brief</summary>

1. δ grows with the strength of the reaction, so the bias grows. With a weak reaction, naive is closer to −5.
2. No: **measurement error in a confounder leaves residual confounding**. Controlling for a noisy proxy removes only part of the bias. This is an important reason to use several indicators of the cycle.
3. A linear control under-fits the non-linear confounding, so bias remains. Adding `cycle**2` (or using a flexible model of g(X)) fixes it. That's the motivation for DoubleML's ML nuisance functions.
4. The estimates spread widely. With roughly a decade of monthly data and modest variation in rate changes, confidence intervals will be wide. Expect that with real data too, and report it honestly.

</details>

### Day 71 checklist
- [ ] I can distinguish association, prediction and causation, and explain why good forecasts can mislead policy
- [ ] I can define potential outcomes, ATE/ATT/CATE and a per-unit effect for a continuous treatment
- [ ] I can state unconfoundedness, overlap, SUTVA and no anticipation, and why unconfoundedness is untestable
- [ ] I built a simulation where confounding flips the sign of a naive estimate, and verified the OVB formula
- [ ] I can explain why measurement error and non-linearity leave residual bias

```bash
git add causal notebooks forecasting/requirements-ml.txt
git commit -m "Day 71: potential outcomes, identification, confounding simulations"
git push
```

---

# DAY 72 — Confounders, Bad Controls and Timing

| Time | Block |
|---|---|
| 0:00 – 0:23 | 72.1 Candidate confounders for rate hikes and housing |
| 0:23 – 0:50 | 72.2 Good and bad controls: mediators, colliders, instruments |
| 0:50 – 0:58 | Break |
| 0:58 – 1:20 | 72.3 Simulating bad controls |
| 1:20 – 1:40 | 72.4 Timing as identification: controls must precede the decision |
| 1:40 – 1:48 | Break |
| 1:48 – 2:10 | 72.5 Overlap and balance in real Canadian data |
| 2:10 – 2:30 | 72.6 Mini-project: a balance and overlap report |

---

## 72.1 Candidate Confounders for Rate Hikes and Housing (23 min)

A **confounder** is a common cause of the treatment (rate changes) and the outcome (housing starts). Brainstorm with economic reasoning, then check what your platform already provides.

| Candidate | Affects rate decisions because… | Affects housing because… | Expected bias if omitted | In the platform? |
|---|---|---|---|---|
| inflation (headline, core) | the Bank targets 2% | correlated with construction costs and nominal activity | likely upward | ✓ `macro_monthly` |
| real activity (GDP growth, CLI) | output gap in the reaction function | demand for housing | upward | ✓ `ml_gdp_quarterly`, `oecd_cli` |
| labour market (unemployment) | slack in the reaction function | household income, demand | upward | ✓ |
| past housing activity | the Bank watches housing and financial stability | housing is persistent | upward | Day 78 (housing starts series) |
| US / global rates | Canadian rates track global conditions | global conditions affect Canadian demand | ambiguous | ✓ `fed_funds`, US yields |
| oil / terms of trade | affects Canadian inflation and income | affects incomes in energy regions | ambiguous | ✓ `wti` |
| exchange rate | affects imported inflation | affects relative prices and demand | ambiguous | ✓ `usd_cad` |
| population growth / immigration | affects demand and inflation | directly affects housing demand | likely upward | ✗ (candidate addition) |
| credit and financial conditions | affect the transmission of policy | affect mortgage availability | ambiguous | partly: yield spreads |

"Expected bias" is a **hypothesis** from economic reasoning (Day 71.4's sign test), not a result. Writing it down before estimating is good scientific practice: it guards against rationalising whatever the data show.

---

## 72.2 Good and Bad Controls (28 min)

Not every variable correlated with both *D* and *Y* should be controlled for. The role of a variable in the **causal structure** decides. Cinelli, Forney and Pearl (2022), *A Crash Course in Good and Bad Controls*, give a systematic treatment. Here are the cases that matter for us:

| Role | Structure | Control for it? | Example in our question |
|---|---|---|---|
| **Confounder** | X → D and X → Y | ✅ **yes**: blocks a backdoor path | inflation, growth, unemployment |
| **Mediator** | D → M → Y | ❌ **no**, if you want the **total** effect: controlling removes part of the effect | **mortgage rates**, 5-year bond yields, house prices (rate hikes raise mortgage rates, which reduce housing) |
| **Collider** | D → S ← Y | ❌ **no**: conditioning *creates* a spurious association | a variable caused by both, e.g. "housing mentioned in the Bank's statement" if both policy and housing drive it |
| **Post-treatment variable** | caused by D | ❌ generally no | anything measured after the decision |
| **Instrument-like** | Z → D only | ⚠️ usually no: doesn't reduce bias and can **amplify** bias from unobserved confounding | a variable that moves rates but has no other link to housing |
| **Outcome-only predictor** | X → Y only | ✅ optional: improves precision, no bias | regional weather affecting construction |

> **The mediator trap is the most common mistake in monetary-policy work.** "Control for mortgage rates" sounds sensible, but rate hikes affect housing **largely through** mortgage rates. Controlling for them asks *"what's the effect of a hike holding mortgage rates fixed?"*, which is nearly zero by construction and isn't the policy question. If you *want* to study mechanisms, that's **mediation analysis**, a different estimand.

---

## 72.3 Simulating Bad Controls (23 min)

> **Question it answers:** What goes wrong if I control for mortgage rates, which are themselves caused by the policy change?
>
> **Other questions you can answer the same way:**
> - Should I control for house prices or 5-year yields?
> - When does adding a control make the estimate worse?

Add to `causal/simulate.py`:

```python
def mediator_world(T=600, seed=1):
    """D → mortgage rate M → Y; cycle C confounds D and Y. Total effect of D: -6 × 0.8 = -4.8."""
    rng = np.random.default_rng(seed)
    c = np.zeros(T)
    for t in range(1, T):
        c[t] = 0.9 * c[t - 1] + rng.normal(0, 1)
    d = 0.5 * c + rng.normal(0, 0.5, T)
    m = 0.8 * d + rng.normal(0, 0.3, T)                       # mortgage rates follow policy
    y = 10 * c - 6 * m + rng.normal(0, 3, T)
    return pd.DataFrame({"cycle": c, "rate_change": d, "mortgage_rate_change": m,
                         "housing_growth": y})


def collider_world(T=600, seed=2):
    """True effect −5; S is caused by both D and Y (a collider)."""
    df = confounded_world(T=T, seed=seed)
    rng = np.random.default_rng(seed + 100)
    df["collider"] = df["rate_change"] + 0.2 * df["housing_growth"] + rng.normal(0, 1, len(df))
    return df


def amplification_world(T=2000, seed=3):
    """Unobserved U confounds D and Y; Z affects D only (instrument-like). True effect −5."""
    rng = np.random.default_rng(seed)
    u = rng.normal(0, 1, T)
    z = rng.normal(0, 1, T)
    d = 1.0 * z + 0.5 * u + rng.normal(0, 0.3, T)
    y = -5 * d + 3 * u + rng.normal(0, 1, T)
    return pd.DataFrame({"z": z, "rate_change": d, "housing_growth": y, "u_unobserved": u})
```

Run the experiments:

```python
import statsmodels.formula.api as smf

from causal.simulate import amplification_world, collider_world, mediator_world

med = mediator_world()
print("TOTAL effect target: -4.80")
print("control cycle only:          ",
      smf.ols("housing_growth ~ rate_change + cycle", med).fit().params["rate_change"].round(2))
print("control cycle + mortgage rate:",
      smf.ols("housing_growth ~ rate_change + cycle + mortgage_rate_change", med)
      .fit().params["rate_change"].round(2))

col = collider_world()
print("\ncollider — true effect -5")
print("control cycle:            ",
      smf.ols("housing_growth ~ rate_change + cycle", col).fit().params["rate_change"].round(2))
print("control cycle + collider: ",
      smf.ols("housing_growth ~ rate_change + cycle + collider", col).fit().params["rate_change"].round(2))

amp = amplification_world()
print("\nbias amplification — true effect -5 (U unobserved)")
print("no controls:  ", smf.ols("housing_growth ~ rate_change", amp).fit().params["rate_change"].round(2))
print("control for Z:", smf.ols("housing_growth ~ rate_change + z", amp).fit().params["rate_change"].round(2))
```

What you should see:
- **Mediator:** controlling for the mortgage rate pushes the estimate towards **zero**, erasing most of the real effect.
- **Collider:** adding the collider **creates** bias where there was none.
- **Amplification:** controlling for the instrument-like Z makes the estimate **more** biased. It removes "good" variation in D (driven by Z) and leaves a larger share of variation driven by the unobserved U.

> These simulations are your **intuition pumps**. Whenever someone proposes "let's just add more controls", or an ML method that uses "all available variables", remember these three results. More controls aren't automatically better; the **right** controls are.

---

## 72.4 Timing as Identification: Controls Must Precede the Decision (20 min)

> **Question it answers:** Which variables were known before the rate decision, and can therefore be used as controls?
>
> **Other questions you can answer the same way:**
> - Is last month's unemployment a confounder or a mediator?
> - Why must controls be measured before the treatment?

In time series, **timing** is a powerful tool for telling confounders from mediators. A variable measured **before** the rate decision can't be caused by it. Measured **after**, it may be a mediator or post-treatment variable.

**The rule:** controls must be **pre-treatment**, meaning known **before** the decision was made. You've already built exactly this logic twice:

| Earlier work | What it gave you |
|---|---|
| Day 17: `ASOF` joins with the CPI publication lag | "the CPI reading known at each decision" |
| Day 68: the feature spec with **publication lags** | features built only from data published by each origin |

For a monthly design:
- **treatment** *D_t*: change in the overnight rate during month *t* (or at the decision in month *t*);
- **controls** *X_t*: values **published by the start of month *t*** (CPI for *t−2* or *t−1*, LFS for *t−1*, CLI for *t−3*, market data for end of *t−1*);
- **outcome** *Y_{t,h}*: housing growth from *t−1* to *t+h*.

```
     t−3      t−2      t−1    │  t   │   t+1 … t+h
 CLI ──┘  CPI ──┘  LFS, markets ┘  │  D_t │  Y measured from t−1 to t+h
         controls (pre-treatment)  │decision│
```

> Using **contemporaneous** monthly values (e.g. unemployment in month *t*) as controls risks controlling for something **already affected** by the decision, or by anticipation of it. Lag your controls according to their publication delays, and **reuse the Day 68 availability builder** rather than writing new code.

---

## 72.5 Overlap and Balance in Real Canadian Data (23 min)

> **Question it answers:** Were rate-hike months and no-hike months economically comparable before the decision?
>
> **Other questions you can answer the same way:**
> - How different was inflation before hikes compared with other months?

Now look at real data. For diagnostics, define a simple **binary** treatment: *hike month* = the overnight rate rose during the month. The main analysis (Days 74–80) uses the **continuous** change.

Create `causal/balance.py`:

```python
"""Balance and overlap diagnostics for a treatment against pre-treatment controls."""
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


def standardized_mean_differences(X: pd.DataFrame, treated: pd.Series) -> pd.DataFrame:
    """SMD = (mean_treated − mean_control) / pooled std. |SMD| > 0.25 often flags imbalance."""
    t, c = X[treated == 1], X[treated == 0]
    pooled = np.sqrt((t.var() + c.var()) / 2)
    return pd.DataFrame({"mean_treated": t.mean(), "mean_control": c.mean(),
                         "smd": (t.mean() - c.mean()) / pooled}).sort_values(
        "smd", key=np.abs, ascending=False)


def propensity_scores(X: pd.DataFrame, treated: pd.Series) -> pd.Series:
    model = make_pipeline(StandardScaler(), LogisticRegression(C=1.0, max_iter=1000))
    model.fit(X, treated)
    return pd.Series(model.predict_proba(X)[:, 1], index=X.index, name="pscore")
```

Build the dataset from the marts, with **lagged** (pre-treatment) controls:

```python
import pandas as pd

from causal.balance import propensity_scores, standardized_mean_differences
from forecasting.availability import load_monthly_panel

m = load_monthly_panel()
d = m["overnight_rate"].diff()                         # change during month t
hike = (d > 0.001).astype(int).rename("hike")

controls = pd.DataFrame({
    "cpi_yoy_l1":     m["headline_yoy"].shift(1),
    "core_yoy_l1":    m["core_ex_fe_yoy"].shift(1),
    "unemp_l1":       m["unemployment_rate"].shift(1),
    "unemp_chg12_l1": m["unemployment_rate"].diff(12).shift(1),
    "cli_l3":         m["oecd_cli"].shift(3),
    "fed_funds_l1":   m["fed_funds"].shift(1),
    "slope_l1":       m["spread_10_2_bp"].shift(1),
    "wti_pct12_l1":   (100 * m["wti_eom"].pct_change(12)).shift(1),
    "overnight_l1":   m["overnight_rate"].shift(1),     # the policy stance going in
})
data = controls.join(hike).dropna()
print(f"{data['hike'].sum()} hike months out of {len(data)}")

print(standardized_mean_differences(data.drop(columns="hike"), data["hike"]).round(2))
data["pscore"] = propensity_scores(data.drop(columns="hike"), data["hike"])
```

### Reading the diagnostics

> **Question it answers:** Are hikes observed across a wide range of economic conditions, or only in very particular ones?
>
> **Other questions you can answer the same way:**
> - Is there any comparable "no hike" month for each hike month?

- **SMDs:** large values (e.g. inflation, the policy rate going in) confirm what the DAG predicts. Hike months happen in **different conditions**, which is exactly the confounding we must adjust for.
- **Propensity scores:** the estimated probability of a hike given the controls. Plot their distributions for hike and non-hike months:

```python
import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(8, 3.5))
ax.hist(data.loc[data.hike == 0, "pscore"], bins=30, alpha=0.6, label="no hike", density=True)
ax.hist(data.loc[data.hike == 1, "pscore"], bins=30, alpha=0.6, label="hike", density=True)
ax.set_xlabel("estimated probability of a hike"); ax.legend()
ax.set_title("Overlap: are hikes observed across comparable conditions?")
plt.tight_layout(); plt.savefig("data/forecasts/overlap_pscore.png", dpi=120)
```

| Pattern | Meaning |
|---|---|
| distributions overlap broadly | comparisons are supported by data |
| hike months only at high scores, non-hikes only at low scores | **poor overlap**: estimates will rely on extrapolation by the model |
| scores near 0 or 1 | some conditions *always* or *never* lead to hikes, so there's no counterfactual evidence there |

> **Be honest about the sample.** Since our panel starts in 2006, there are only a few tightening cycles (2010, 2017–18, 2022–23), so a few dozen hike months. Overlap may be thin and estimates imprecise. This is why the main design uses the **continuous** rate change (more informative variation) and why **lengthening the panel** (backfilling earlier history, Day 68) is a valuable investment before Day 78.

---

## 72.6 Mini-Project: A Balance and Overlap Report (20 min)

In `notebooks/day72.ipynb`, produce a short report:

1. Count hike, cut and hold months by tightening cycle (use `seed_boc_decisions` for 2022 onwards and the overnight-rate changes for earlier years).
2. The SMD table, with one sentence on what it implies about confounding.
3. The propensity-score overlap plot, with the share of hike months whose score lies **within the range** of non-hike scores.
4. **Trimming:** the share of observations with scores outside [0.05, 0.95], and what dropping them would mean for the estimand (the effect only for "comparable" months).
5. Your recommendation: is the binary-hike design viable, or should the continuous design be primary? Justify with the diagnostics.

### Day 72 checklist
- [ ] I listed candidate confounders with reasoning about the direction of bias, and checked the platform for each
- [ ] I can classify controls as confounders, mediators, colliders, instrument-like or outcome-only
- [ ] My simulations show the mediator trap, collider bias and bias amplification
- [ ] Controls are pre-treatment, respecting publication lags (reusing the Day 68 logic)
- [ ] I assessed balance (SMDs) and overlap (propensity scores) in real Canadian data, and reported the limitations

```bash
git add causal notebooks && git commit -m "Day 72: good and bad controls, timing, balance and overlap" && git push
```

---

# DAY 73 — Directed Acyclic Graphs

| Time | Block |
|---|---|
| 0:00 – 0:25 | 73.1 DAGs: paths, backdoors and d-separation |
| 0:25 – 0:50 | 73.2 Code: finding backdoor paths and adjustment sets |
| 0:50 – 0:58 | Break |
| 0:58 – 1:25 | 73.3 A DAG for rate hikes and housing starts |
| 1:25 – 1:45 | 73.4 Dynamics: reaction functions, lagged outcomes and horizons |
| 1:45 – 1:53 | Break |
| 1:53 – 2:10 | 73.5 Testable implications, placebos and negative controls |
| 2:10 – 2:30 | 73.6 Capstone: `DAG.md` and the causal design specification |

---

## 73.1 DAGs: Paths, Backdoors and d-Separation (25 min)

A **directed acyclic graph (DAG)** represents your **assumptions** about what causes what:
- **nodes** are variables;
- an **arrow** A → B means "A directly causes B";
- **acyclic**: no variable causes itself through a loop (feedback over time is drawn by **time-indexing** variables, 73.4).

DAGs, developed by Judea Pearl and others, turn causal assumptions into precise, checkable statements.

### Paths between treatment and outcome

| Path type | Example | Carries |
|---|---|---|
| **causal (front-door) path** | D → M → Y | the effect we want |
| **backdoor path** | D ← C → Y | spurious association (confounding) |
| path through a **collider** | D → S ← Y | nothing, *unless* you condition on S (or a descendant of S) |

### Blocking rules (d-separation)

A path is **blocked** by a set of controls *Z* if it contains:
1. a **non-collider** node (a chain A → B → C or a fork A ← B → C) that **is in Z**; or
2. a **collider** (A → B ← C) where **neither** B **nor any descendant** of B is in Z.

### The backdoor criterion

A set *Z* is a valid **adjustment set** for the effect of D on Y if:
1. no variable in *Z* is a **descendant** of D (no mediators or post-treatment variables); and
2. *Z* **blocks every backdoor path** from D to Y.

If such a *Z* exists and is **observed**, the causal effect is identified by adjusting for *Z*. That's exactly what DoubleML's partially linear model will do, flexibly.

### Try it 73.1

For the DAG `C → D, C → Y, D → M → Y, D → S ← Y`, which of these sets satisfy the backdoor criterion for the **total** effect of D on Y: {}, {C}, {C, M}, {C, S}?

<details>
<summary>Answer</summary>

Only **{C}**. {} leaves the backdoor D ← C → Y open. {C, M} includes a descendant of D (the mediator M), violating condition 1. {C, S} includes the collider S, which is also a descendant of D, so conditioning on it violates condition 1 and opens a spurious path.

</details>

---

## 73.2 Code: Finding Backdoor Paths and Adjustment Sets (25 min)

> **Question it answers:** Given my causal diagram, which paths create spurious correlation, and which set of controls blocks them?
>
> **Other questions you can answer the same way:**
> - Is my set of controls sufficient?
> - Which variables must I not control for?

Create `causal/dag.py`, a small, transparent implementation using `networkx`:

```python
"""DAG utilities: backdoor paths, the backdoor criterion, d-separation, adjustment sets."""
from itertools import combinations

import networkx as nx


def make_dag(edges, unobserved=()):
    G = nx.DiGraph(edges)
    if not nx.is_directed_acyclic_graph(G):
        raise ValueError("graph has a cycle — time-index variables to represent feedback")
    for n in G.nodes:
        G.nodes[n]["observed"] = n not in set(unobserved)
    return G


def _is_collider(G, a, b, c) -> bool:
    return G.has_edge(a, b) and G.has_edge(c, b)


def path_blocked(G, path, Z) -> bool:
    Z = set(Z)
    for i in range(1, len(path) - 1):
        a, b, c = path[i - 1], path[i], path[i + 1]
        if _is_collider(G, a, b, c):
            if not ({b} | nx.descendants(G, b)) & Z:
                return True                      # unconditioned collider blocks
        elif b in Z:
            return True                          # conditioned chain/fork node blocks
    return False


def all_paths(G, a, b):
    return list(nx.all_simple_paths(G.to_undirected(), a, b))


def backdoor_paths(G, d, y):
    """Paths from d to y whose first edge points INTO d."""
    return [p for p in all_paths(G, d, y) if G.has_edge(p[1], d)]


def satisfies_backdoor(G, d, y, Z) -> bool:
    if set(Z) & nx.descendants(G, d):
        return False
    return all(path_blocked(G, p, Z) for p in backdoor_paths(G, d, y))


def d_separated(G, x, y, Z) -> bool:
    return all(path_blocked(G, p, Z) for p in all_paths(G, x, y))


def minimal_adjustment_sets(G, d, y, max_size=6):
    """All minimal OBSERVED adjustment sets (no proper subset is also valid)."""
    candidates = [n for n in G.nodes
                  if n not in (d, y) and G.nodes[n]["observed"]
                  and n not in nx.descendants(G, d)]
    found = []
    for k in range(0, min(max_size, len(candidates)) + 1):
        for Z in combinations(candidates, k):
            if any(set(f) <= set(Z) for f in found):
                continue                          # a smaller valid set exists
            if satisfies_backdoor(G, d, y, Z):
                found.append(Z)
    return found
```

Check it on the Try-it DAG:

```python
from causal.dag import backdoor_paths, make_dag, minimal_adjustment_sets, satisfies_backdoor

G = make_dag([("C", "D"), ("C", "Y"), ("D", "M"), ("M", "Y"), ("D", "S"), ("Y", "S")])
print(backdoor_paths(G, "D", "Y"))                         # [['D', 'C', 'Y']]
for Z in [(), ("C",), ("C", "M"), ("C", "S")]:
    print(Z, satisfies_backdoor(G, "D", "Y", Z))
print(minimal_adjustment_sets(G, "D", "Y"))                # [('C',)]
```

> Enumerating all paths is fine for teaching-sized graphs (a few dozen nodes). Libraries such as **DoWhy** implement these checks at scale. Day 73.6 cross-checks our answer with it, if installed.

---

## 73.3 A DAG for Rate Hikes and Housing Starts (28 min)

> **Question it answers:** What drives Bank of Canada rate decisions and housing starts, and which variables should be controlled for when estimating the effect of rates on housing?
>
> **Other questions you can answer the same way:**
> - Which confounders are unobserved?
> - Does the diagram justify my control list?

Now draw **our** DAG. Every arrow is an **assumption** you must be able to defend, and every **missing** arrow is an even stronger assumption (no direct effect).

```python
EDGES = [
    # The Bank's reaction function: what drives rate changes (D)
    ("Inflation_lag", "D"), ("CoreInflation_lag", "D"), ("Unemployment_lag", "D"),
    ("Activity_lag", "D"), ("Housing_lag", "D"), ("USRates", "D"),
    ("PolicyRate_lag", "D"), ("Oil", "D"), ("FX_lag", "D"),

    # What drives housing starts (Y) besides policy
    ("Activity_lag", "Y"), ("Unemployment_lag", "Y"), ("Housing_lag", "Y"),
    ("Population", "Y"), ("Inflation_lag", "Y"), ("USRates", "Y"),
    ("Oil", "Y"), ("SupplyConstraints", "Y"), ("Sentiment", "Y"),

    # Transmission: the causal channels we must NOT block
    ("D", "MortgageRates"), ("MortgageRates", "Y"),
    ("D", "BondYields5y"), ("BondYields5y", "MortgageRates"),
    ("D", "HousePrices"), ("HousePrices", "Y"),
    ("D", "Y"),                                         # other direct channels

    # Links among confounders
    ("USRates", "BondYields5y"), ("Oil", "Inflation_lag"), ("Activity_lag", "Unemployment_lag"),
    ("Population", "Activity_lag"), ("Sentiment", "Activity_lag"), ("Sentiment", "D"),
    ("FX_lag", "Inflation_lag"),
]
UNOBSERVED = ["Sentiment", "SupplyConstraints", "Population"]   # not (yet) in the platform
```

```python
from causal.dag import backdoor_paths, make_dag, minimal_adjustment_sets, satisfies_backdoor

G = make_dag(EDGES, unobserved=UNOBSERVED)
print("backdoor paths:", len(backdoor_paths(G, "D", "Y")))
print("minimal observed adjustment sets:")
for Z in minimal_adjustment_sets(G, "D", "Y"):
    print("  ", Z)
```

### What the graph tells you

> **Question it answers:** Which variables are confounders, which are mediators, and which are unobserved, according to the diagram?
>
> **Other questions you can answer the same way:**
> - Why are mortgage rates excluded from the controls?

1. **Mediators are excluded automatically.** Mortgage rates, 5-year yields and house prices are descendants of D, so they can never be in a valid adjustment set for the **total** effect.
2. **Unobserved confounders may break identification.** `Sentiment` → D and → Y (via activity and directly). If it's unobserved and no observed set blocks its paths, the algorithm finds **no** valid set. That's a precise statement of the risk that **sensitivity analysis** (Days 78–80) must quantify.
3. **Arrows you choose matter.** If you believe sentiment affects housing *only* through measured activity, delete `("Sentiment", "Y")` and re-run: identification may become possible. That's a substantive economic assumption, and it must be **written and defended**, not slipped in.

Visualise the graph for discussion:

```python
import matplotlib.pyplot as plt
import networkx as nx

pos = nx.spring_layout(G, seed=7, k=1.2)
colors = ["#C95555" if n in ("D", "Y") else
          "#A0B4CC" if not G.nodes[n]["observed"] else
          "#D4924A" if n in nx.descendants(G, "D") else "#4A90D9" for n in G.nodes]
plt.figure(figsize=(12, 8))
nx.draw_networkx(G, pos, node_color=colors, node_size=1800, font_size=8, arrowsize=15)
plt.title("DAG: overnight-rate changes (D) → housing starts (Y)\n"
          "red = treatment/outcome · orange = mediators · grey = unobserved · blue = observed")
plt.axis("off"); plt.tight_layout(); plt.savefig("causal/dag.png", dpi=120)
```

---

## 73.4 Dynamics: Reaction Functions, Lagged Outcomes and Horizons (20 min)

> **Question it answers:** How do I handle the fact that housing influences rate decisions and rate decisions influence future housing?
>
> **Other questions you can answer the same way:**
> - Should past housing starts be a control?
> - Which horizon should I study?

Monetary policy and housing interact **over time**: rates affect housing, and housing (with the economy) affects future rates. A DAG must be acyclic, so feedback is represented by **time-indexing**:

```
Housing_{t−1} ──► D_t ──► Housing_{t+h}
      │                      ▲
      └──────────────────────┘     (housing is persistent)
Economy_{t−1} ──► D_t,  Economy_{t−1} ──► Housing_{t+h}
D_{t−1} ──► Economy_{t−1}?  …    (past policy shapes today's state: control for the policy stance going in)
```

Implications for the design:

| Element | Decision | Why |
|---|---|---|
| **lagged outcome** | control for housing growth over recent months | the Bank reacts to housing; housing is persistent (a classic confounder in time series) |
| **past policy** | control for the overnight rate level and recent changes before *t* | today's change depends on the stance; past policy also affects the economy |
| **horizon** | estimate θ separately for *h* = 3, 6, 12, 24 months | effects build up with lags (local-projection logic) |
| **overlapping outcomes** | outcomes for nearby months share future periods | standard errors must account for serial correlation (Days 74–77) |

### The reaction-function view

Under unconfoundedness, the part of D_t **not** explained by the information set *X_t*,

**v_t = D_t − E[D_t | X_t]**,

behaves like a **policy surprise**: a rate change the Bank made beyond what its usual reaction to the economy would predict. DoubleML's first stage estimates exactly E[D | X] with ML (the "m(X)" nuisance function), and the effect θ is identified from how Y responds to v. That's the conceptual bridge to Days 74–77.

---

## 73.5 Testable Implications, Placebos and Negative Controls (18 min)

You can't test unconfoundedness directly, but a DAG **implies** things you **can** check.

### Conditional independencies

The DAG implies that certain variables are independent given others (d-separation). For example, if your graph has no path between `Oil` and `Population` except through blocked colliders, they should be uncorrelated in the data. Use `d_separated(G, a, b, Z)` to list implied independencies, then test a few with regressions (a coefficient near zero, given Z). A strongly violated implication means **the graph is wrong somewhere**.

### Placebo (pre-treatment) outcomes

A rate change at month *t* can't cause housing growth **before** *t*. Estimate the same model with the outcome replaced by **past** housing growth (e.g. from *t−12* to *t−6*). The estimated "effect" should be **zero**. A significant placebo effect signals **remaining confounding** or **anticipation**, and is a red flag for the main estimate.

### Negative-control outcomes

Pick an outcome that the treatment **shouldn't** affect at the chosen horizon, but that shares the confounders. If your adjusted estimate shows an "effect" on it, confounding remains.

### Negative-control treatments

Shift the treatment into the **future** (D_{t+12}) and estimate its "effect" on Y_{t,h}. A future rate change can't cause today's housing, so a non-zero estimate again flags confounding by slow-moving trends.

Write these tests **into the design now**, before seeing the main estimates, so they can't be chosen after the fact to support a preferred answer. They'll run on Days 78–80.

---

## 73.6 Capstone: `DAG.md` and the Causal Design Specification (20 min)

### `causal/DAG.md`

> **Question it answers:** For each arrow in the causal diagram, what is the economic justification and how confident am I?
>
> **Other questions you can answer the same way:**
> - Which assumptions would a referee challenge first?

Document the graph like a data contract: one row per **edge** (and per notable **missing** edge), with justification.

```markdown
# Causal DAG — overnight-rate changes → housing starts

Figure: causal/dag.png (generated by notebooks/day73.ipynb)

## Edges
| From | To | Justification | Confidence |
|---|---|---|---|
| Inflation_lag | D | 2% inflation-targeting mandate; the Bank reacts to inflation | high |
| Housing_lag | D | financial-stability concerns; housing in the Bank's assessments | medium |
| D | MortgageRates | pass-through from policy to variable and fixed mortgage rates | high |
| … | | | |

## Notable missing edges (assumptions!)
| Missing | Why we assume it absent | How we probe it |
|---|---|---|
| Sentiment → Y (direct) | sentiment affects housing mainly via measured activity | sensitivity analysis; placebo tests |
| … | | |

## Unobserved variables
Sentiment, supply constraints, population growth (candidate data addition).

## Adjustment set chosen
{…}, from causal/dag.py; mediators excluded by construction.
```

### `causal/design_spec.yml`

> **Question it answers:** Exactly what is the treatment, the outcome, the controls, the sample and the assumptions of the study?
>
> **Other questions you can answer the same way:**
> - What exactly does "the effect of a 1-point hike" mean in this study?

Translate the DAG into a **reviewed specification**, the causal counterpart of Day 68's feature spec. Days 74–80 implement exactly this, nothing more and nothing less:

```yaml
question: >
  Effect of a 1 percentage-point increase in the Bank of Canada overnight rate during month t
  on housing starts growth h months later, holding the pre-decision economic situation fixed.
unit: month
sample: {start: "2006-01", note: "extend if the panel is backfilled (Day 68)"}

treatment:
  name: d_overnight
  definition: "overnight_rate(end of t) - overnight_rate(end of t-1), percentage points"
  source: macro_monthly.overnight_rate
  type: continuous

outcome:
  name: housing_growth_h
  definition: "100 * (log HS[t+h] - log HS[t-1])"
  horizons: [3, 6, 12, 24]
  source: "housing starts (added on Day 78 via the platform: source → staging → mart → tests)"

controls:            # pre-treatment, publication lags respected (Day 68 availability builder)
  - {name: cpi_yoy,      column: headline_yoy,       lag: 1, role: confounder}
  - {name: core_yoy,     column: core_ex_fe_yoy,     lag: 1, role: confounder}
  - {name: unemp,        column: unemployment_rate,  lag: 1, role: confounder}
  - {name: unemp_chg12,  column: unemployment_rate,  lag: 1, transform: diff12, role: confounder}
  - {name: cli,          column: oecd_cli,           lag: 3, role: confounder}
  - {name: fed_funds,    column: fed_funds,          lag: 1, role: confounder}
  - {name: wti_pct12,    column: wti_eom,            lag: 1, transform: pct12, role: confounder}
  - {name: usd_cad_pct12, column: usd_cad_eom,       lag: 1, transform: pct12, role: confounder}
  - {name: overnight,    column: overnight_rate,     lag: 1, role: policy_stance}
  - {name: d_overnight_l1_6, column: overnight_rate, lag: 1, transform: diff6, role: past_policy}
  - {name: housing_growth_l1_6, column: housing_starts, lag: 1, transform: logdiff6, role: lagged_outcome}

excluded:            # never controls, with reasons (bad controls)
  - {name: mortgage_rates,   reason: "mediator (D → mortgage rates → housing)"}
  - {name: yield_5yr,        reason: "mediator (D → 5-year yields → mortgage rates)"}
  - {name: house_prices,     reason: "mediator"}
  - {name: any variable dated ≥ t, reason: "post-treatment"}

unobserved_confounders: [sentiment, supply_constraints, population_growth]

estimator: "DoubleML partially linear regression (PLR), cross-fitted, ML nuisance models (Days 74–77)"
inference: "standard errors robust to serial correlation from overlapping horizons"

robustness:          # pre-registered before seeing results
  - placebo outcome: housing growth from t-12 to t-6
  - negative-control treatment: d_overnight at t+12
  - alternative treatment: 3-month cumulative change
  - sample excluding 2020-03 to 2021-06 (pandemic)
  - sensitivity analysis for unobserved confounding (DoubleML)
  - linear (OLS) controls vs ML controls
```

### Optional: cross-check with DoWhy

> **Question it answers:** Does an established causal-inference library agree with my adjustment set?
>
> **Other questions you can answer the same way:**
> - Did I find the backdoor paths correctly?

```python
import networkx as nx
import pandas as pd
from dowhy import CausalModel

from causal.dag import make_dag

G = make_dag(EDGES, unobserved=UNOBSERVED)
observed = [n for n in G.nodes if G.nodes[n]["observed"]]
dummy = pd.DataFrame(0.0, index=range(10), columns=observed)
model = CausalModel(data=dummy, treatment="D", outcome="Y",
                    graph="".join(nx.generate_gml(G)))
print(model.identify_effect())
```

DoWhy reports whether a backdoor estimand is identified, and with which variables. Compare with `minimal_adjustment_sets`. (APIs evolve; if this snippet needs adjustment for your version, the comparison remains the goal.)

### Recap: Days 71–73

| Concept | You can now… |
|---|---|
| causal questions | separate association, prediction and causation; define potential outcomes and estimands |
| identification | state unconfoundedness, overlap, SUTVA and no anticipation, and their limits in macro |
| confounding | demonstrate and quantify omitted-variable bias by simulation |
| bad controls | recognise mediators, colliders and instrument-like variables, and avoid them |
| timing | use pre-treatment controls with publication lags |
| diagnostics | assess balance and overlap in real data |
| DAGs | find backdoor paths, valid adjustment sets and testable implications, in code |
| design | write a reviewed causal design specification before estimating anything |

### Looking ahead: Days 74–77

- **Nuisance parameters:** the reaction function m(X) = E[D | X] and the outcome function ℓ(X) = E[Y | X], learned with ML (random forests, XGBoost, regularised regression).
- **Why naive "plug-in" ML is biased** for θ (regularisation and overfitting bias), and how **orthogonal scores** and **cross-fitting** fix it.
- The **partially linear regression** model in the `doubleml` package: first on simulations with known effects, then with time-series-aware sample splitting for monthly macro data.

### Day 73 checklist
- [ ] I can identify causal, backdoor and collider paths, and apply the backdoor criterion
- [ ] My `causal/dag.py` finds backdoor paths, checks adjustment sets and lists minimal observed sets
- [ ] I drew and defended a DAG for rate hikes and housing starts, edge by edge, with unobserved variables marked
- [ ] I represent feedback with time-indexed variables and understand the reaction-function view
- [ ] Placebo, negative-control and sensitivity tests are pre-registered in the design
- [ ] `causal/design_spec.yml` specifies treatment, outcome, horizons, controls with lags, exclusions and robustness checks

```bash
git add causal notebooks && git commit -m "Day 73: DAG, adjustment sets, causal design specification" && git push
```
