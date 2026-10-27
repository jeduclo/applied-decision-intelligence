# Module 4 · Data Modeling with dbt
## Days 38–40: Constructing the Macro Data Mart — Yield Curves × USD/CAD, an Open-Economy Dashboard Schema, and the Cut-Over to Production

**Audience:** MSc Economics students who completed Days 1–37
**Environment:** GitHub Codespaces · course `.venv` · `macro_dbt` · `macro.duckdb` fed by `ingest.py`
**Time per day:** ~5 hours (including breaks and exercises)
**Goal by end of Day 40:** A production dbt mart layer that answers open-economy questions: how Canadian and US yield curves, the policy-rate differential, oil and USD/CAD move together, daily and monthly. It is documented with exposures, protected by model contracts, exported for the dashboard notebook, and **live in prod**, with the Module 2 hand-built warehouse retired after a final regression test.

---

### Where we are

After Day 37, `macro_dbt` (dev target) contains:

```
staging       stg_boc/fred/statcan__observations, stg_statcan__cpi/gdp, stg_dlt__loads, …
intermediate  int_macro__observations, int_rates__monthly(_long), int_cpi__growth/smoothed/
              national_measures, int_gdp__levels/growth/cycle_flags
marts         dim_date, dim_series, fct_observations (incremental), policy_cycles
snapshots     snap_cpi_national
```

Module 2's warehouse still serves the dashboards from `staging.*`, `intermediate.*` and `marts.*`. These three days build what the curriculum calls the **macro data mart**, then switch production over.

| Day | Theme |
|---|---|
| 38 | **Design & foundations:** requirements, new series (5-year and US yields), a yield-curve fact, an aligned daily market panel |
| 39 | **The open-economy mart:** spreads, slopes, returns, volatility, rolling correlations; monthly and quarterly panels; KPI table |
| 40 | **Production:** contracts, exposures, docs, Parquet exports, cut-over with regression test, retiring Module 2 |

---

# DAY 38 — Designing the Mart and Building Its Foundations

| Time | Block |
|---|---|
| 0:00 – 0:50 | 38.1 Start from the consumer: questions the dashboard must answer |
| 0:50 – 1:35 | 38.2 Extending ingestion: 5-year and US Treasury yields |
| 1:35 – 1:50 | Break |
| 1:55 – 2:40 | 38.3 A richer series dimension: country, instrument, tenor |
| 2:40 – 3:25 | 38.4 `fct_yield_curve`: the curve as data |
| 3:25 – 3:40 | Break |
| 3:40 – 5:00 | 38.5 Aligning daily markets: a business-day panel with ASOF joins |

---

## 38.1 Start from the Consumer (50 min)

A mart is a **product**. Before writing SQL, write down who uses it and what they ask. Our consumers are the course notebook's **Module 02 (Rates & FX)** and **Module 06 (Open Economy)** dashboards, and later the forecasting (Days 61–70) and causal (Days 71–80) modules.

### The questions

| # | Question | Needs |
|---|---|---|
| Q1 | What does the Canadian yield curve look like today vs a year ago? | yields by **tenor** on chosen dates |
| Q2 | Is the curve inverted? How steep is it? | slope (10y − 2y), curvature |
| Q3 | Are Canadian rates above or below US rates, and by how much? | CA–US spreads at 2y and 10y; policy differential |
| Q4 | Does USD/CAD track the rate differential? Oil? | aligned daily FX, spreads, WTI; **changes**, not just levels |
| Q5 | Is the relationship stable, or does it switch regimes? | rolling correlations and betas |
| Q6 | How volatile is the Canadian dollar right now? | rolling realised volatility |
| Q7 | Monthly and quarterly context: inflation, real rates, growth, recessions | monthly & quarterly one-big-tables |
| Q8 | A one-screen status of the economy (notebook Module 07) | a KPI table with signals |

### From questions to schema

```
                    dim_date          dim_series (country, instrument, tenor)
                        │                   │
   ┌────────────────────┼───────────────────┼─────────────────────┐
   │                    │                   │                     │
fct_yield_curve     fct_open_economy_daily   macro_monthly     macro_quarterly
(date × country     (date: FX, oil, yields,  (month: OBT)      (quarter: OBT)
 × tenor)            spreads, returns,              │
                     vol, rolling corr)       macro_kpis (latest values + signals)
```

| Model | Grain | Style | Answers |
|---|---|---|---|
| `fct_yield_curve` | date × country × tenor | fact (long) | Q1, Q2 |
| `fct_open_economy_daily` | business day | wide fact | Q3–Q6 |
| `macro_monthly` | month | one-big-table | Q3, Q4, Q7 |
| `macro_quarterly` | quarter | one-big-table | Q7 |
| `macro_kpis` | KPI | report table | Q8 |

> **The grain decision is the most important one.** Markets are **daily**, while inflation and output are **monthly/quarterly**. We keep a **daily** fact for market dynamics (returns, volatility, correlations need daily data) and aggregate **up** for the monthly and quarterly panels. We never disaggregate down: monthly CPI must not be spread across days.

### Try it 38.1

For each question Q1–Q8, name **one** pitfall that would make the answer misleading. (Example: Q4 with *levels* instead of *changes*: two trending series look correlated even when they're unrelated.)

<details>
<summary>Some answers</summary>

Q1: comparing curves on a holiday (missing yields). Q2: using monthly averages hides intraday-month inversions. Q3: mixing Canadian and US closing times or holidays. Q4: spurious correlation of trending levels. Q5: too-short windows give noisy correlations; too-long ones hide regime changes. Q6: annualising daily volatility with the wrong day count. Q7: averaging incomplete quarters (Day 20). Q8: showing a stale value as "latest" without its date.

</details>

---

## 38.2 Extending Ingestion: 5-Year and US Treasury Yields (45 min)

The curve needs a middle tenor, and the open-economy questions need US yields.

| Series | Source | Meaning |
|---|---|---|
| `BD.CDN.5YR.DQ.YLD` | BoC Valet | 5-year Government of Canada benchmark yield |
| `DGS2`, `DGS5`, `DGS10` | FRED | US Treasury constant-maturity yields, daily |
| `DFF` | FRED | effective federal funds rate, **daily** (for a daily policy differential) |

### Step 1 — Configuration (`.dlt/config.toml`)

```toml
[sources.boc]
series_ids = ["V39079", "FXCADUSD", "BD.CDN.2YR.DQ.YLD", "BD.CDN.5YR.DQ.YLD", "BD.CDN.10YR.DQ.YLD"]
start_date = "2006-01-01"
lookback_days = 14

[sources.fred]
series_ids = ["FEDFUNDS", "DFF", "DGS2", "DGS5", "DGS10", "DCOILWTICO", "CANLOLITOAASTSAM"]
start_date = "2006-01-01"
lookback_days = 180
```

### Step 2 — Ingest

```bash
cd /workspaces/macro-data-course
source .venv/bin/activate
python ingest.py
```

Thanks to the **per-series cursors** from Day 27, the new series have no cursor yet, so they load their full history from `start_date`, while existing series load only their recent window. Adding a series needs **no code change**. That's the payoff of Modules 3's design.

If `dbt build` now fails the `relationships` test from Day 36 (*"series_id not in seed_series"*), good: the test is doing its job. The next block adds the seed rows.

---

## 38.3 A Richer Series Dimension (45 min)

The mart needs to know **what kind of thing** each series is. Extend `macro_dbt/seeds/seed_series.csv`:

```csv
series_id,series_name,source,frequency,monthly_agg,max_staleness_days,in_rates_panel,country,instrument_type,tenor_years
V39079,overnight_rate,boc,daily,last,10,true,CA,policy_rate,
FXCADUSD,cad_usd,boc,daily,mean,10,true,CA,fx,
BD.CDN.2YR.DQ.YLD,yield_2yr,boc,daily,mean,10,true,CA,govt_yield,2
BD.CDN.5YR.DQ.YLD,yield_5yr,boc,daily,mean,10,true,CA,govt_yield,5
BD.CDN.10YR.DQ.YLD,yield_10yr,boc,daily,mean,10,true,CA,govt_yield,10
FEDFUNDS,fed_funds,fred,monthly,last,75,true,US,policy_rate,
DFF,fed_funds_daily,fred,daily,last,10,false,US,policy_rate,
DGS2,us_yield_2yr,fred,daily,mean,10,true,US,govt_yield,2
DGS5,us_yield_5yr,fred,daily,mean,10,true,US,govt_yield,5
DGS10,us_yield_10yr,fred,daily,mean,10,true,US,govt_yield,10
DCOILWTICO,wti,fred,daily,mean,15,true,WORLD,commodity,
CANLOLITOAASTSAM,oecd_cli,fred,monthly,mean,120,true,CA,leading_indicator,
v41690973,cpi_all_items,statcan,monthly,last,75,false,CA,price_index,
v2062815,unemployment_rate,statcan,monthly,last,60,true,CA,labour_market,
```

Update the types and tests in `seeds/_seeds.yml`:

```yaml
  - name: seed_series
    config:
      column_types:
        series_id: varchar
        max_staleness_days: integer
        in_rates_panel: boolean
        tenor_years: integer
    columns:
      - name: series_id
        data_tests: [unique, not_null]
      - name: country
        data_tests:
          - accepted_values: {values: ['CA', 'US', 'WORLD']}
      - name: instrument_type
        data_tests:
          - accepted_values:
              values: ['policy_rate', 'fx', 'govt_yield', 'commodity',
                       'leading_indicator', 'price_index', 'labour_market']
    data_tests:
      - dbt_utils.expression_is_true:
          expression: "(instrument_type = 'govt_yield') = (tenor_years is not null)"
```

The model-level `expression_is_true` test encodes a rule: *a series has a tenor if and only if it's a government yield.* It's a small **data contract** on your own reference data.

Then carry the new columns through `dim_series`:

```sql
-- models/marts/core/dim_series.sql
-- Grain: one row per ingested series
select
    s.series_id,
    s.series_name,
    s.source           as provider,
    s.frequency,
    s.monthly_agg,
    s.max_staleness_days,
    s.country,
    s.instrument_type,
    s.tenor_years,
    coalesce(b.label, st.title) as official_label
from {{ ref('seed_series') }} as s
left join {{ ref('stg_boc__series_metadata') }}     as b  using (series_id)
left join {{ ref('stg_statcan__series_metadata') }} as st on st.vector_id = s.series_id
```

```bash
cd macro_dbt
dbt build --select seed_series+
```

Because `int_rates__monthly` builds its columns from the seed (Day 35's `run_query`), the monthly rates panel **automatically gains** `yield_5yr`, `us_yield_2yr`, `us_yield_5yr` and `us_yield_10yr`. Check with `dbt show --select int_rates__monthly --limit 3`.

---

## 38.4 `fct_yield_curve`: The Curve as Data (45 min)

A yield curve is naturally **long**: for each date and country, a set of (tenor, yield) points. Long format makes curve charts and cross-country comparisons trivial.

Create `models/marts/rates/fct_yield_curve.sql` (make the `rates` folder):

```sql
-- Grain: one row per observation date × country × tenor (government bond yields only)
with yields as (

    select
        o.obs_date,
        s.country,
        s.tenor_years,
        o.value         as yield_pct,
        o.series_id
    from {{ ref('int_macro__observations') }} as o
    join {{ ref('seed_series') }}             as s using (series_id)
    where s.instrument_type = 'govt_yield'

)

select
    {{ dbt_utils.generate_surrogate_key(['obs_date', 'country', 'tenor_years']) }} as curve_point_key,
    obs_date,
    country,
    tenor_years,
    yield_pct,
    series_id
from yields
```

Document and test it in `models/marts/rates/_rates__models.yml`:

```yaml
version: 2

models:
  - name: fct_yield_curve
    description: >
      Government bond yield curve points. Grain: date × country × tenor.
      Canada: BoC benchmark yields; US: Treasury constant-maturity yields (FRED).
    columns:
      - name: curve_point_key
        data_tests: [unique, not_null]
      - name: tenor_years
        data_tests:
          - accepted_values: {values: [2, 5, 10], quote: false}
      - name: yield_pct
        data_tests:
          - within_range: {min_value: -2, max_value: 20}
```

(`quote: false` compares numbers as numbers rather than text.)

### Using it: Q1 in one query

Save as `analyses/yield_curve_snapshots.sql`:

```sql
-- Canadian curve today, one year ago, and at the 2023 tightening peak
with latest as (
    select max(obs_date) as d from {{ ref('fct_yield_curve') }} where country = 'CA'
),
dates as (
    select 'latest'      as label, d                                 as target_date from latest
    union all
    select 'one year ago', cast(d - interval 1 year as date)                            from latest
    union all
    select 'mid-2023',     date '2023-07-12'
),
points as (
    select dt.label, c.tenor_years, c.yield_pct, c.obs_date
    from dates as dt
    asof join (select * from {{ ref('fct_yield_curve') }} where country = 'CA') as c
         on dt.target_date >= c.obs_date                -- first attempt: see below
)
select label, tenor_years, round(yield_pct, 2) as yield_pct, obs_date
from points
order by label, tenor_years
```

Run this first attempt and look closely: each date returns only **one** point, not a curve. An ASOF join matches exactly one row per left row, but each date needs **three** tenors. The fix is to ASOF-join per tenor, which means adding the tenor to the join's equality condition:

```sql
points as (
    select dt.label, t.tenor_years, c.yield_pct, c.obs_date
    from dates as dt
    cross join (select distinct tenor_years from {{ ref('fct_yield_curve') }}) as t
    asof join (select * from {{ ref('fct_yield_curve') }} where country = 'CA') as c
         on c.tenor_years = t.tenor_years and dt.target_date >= c.obs_date
)
```

`ASOF JOIN … ON <equality conditions> AND <one inequality>`: the equalities pick the right tenor, and the inequality finds the latest date on or before the target. This is exactly how you'd build a curve "as of" any date, holidays included.

```bash
dbt compile --select yield_curve_snapshots
dbt show --inline "$(cat target/compiled/macro_dbt/analyses/yield_curve_snapshots.sql)"
```

---

## 38.5 Aligning Daily Markets: a Business-Day Panel (80 min)

Daily series don't share a calendar: Canadian and US holidays differ, FRED sometimes lags by a day, and oil trades on different days. To compute cross-market returns and correlations we need **one row per business day** with every series aligned.

### Design

1. A **spine** of weekdays from `dim_date`.
2. For each daily series, an **ASOF join** attaches the latest value on or before that day.
3. A **staleness cap**: if the latest value is more than `max_ffill_days` old, treat it as missing. Forward-filling across a long outage would invent data (the Day 5 `ffill` rule).
4. Columns are generated from the seed (`frequency = 'daily'`), so new daily series appear automatically.

Add to `dbt_project.yml` vars:

```yaml
  max_ffill_days: 5            # forward-fill daily market data at most 5 calendar days
```

Create `models/intermediate/markets/int_market__daily.sql`:

```sql
-- depends_on: {{ ref('seed_series') }}
-- Grain: one row per weekday. Every daily series aligned by ASOF join,
-- forward-filled at most var('max_ffill_days') calendar days, NULL beyond that.
{{ config(materialized='table') }}

{% set daily_series = get_series_names(where="frequency = 'daily'") %}

with spine as (

    select date_day
    from {{ ref('dim_date') }}
    where not is_weekend
      and date_day between date '{{ var("panel_start_date") }}' and current_date

),

{% for s in daily_series %}
s_{{ s }} as (

    select obs_date, value
    from {{ ref('int_macro__observations') }}
    where series_name = '{{ s }}'

),
{% endfor %}

aligned as (

    select
        sp.date_day
        {%- for s in daily_series %},
        s_{{ s }}.value                     as {{ s }}_raw,
        sp.date_day - s_{{ s }}.obs_date    as {{ s }}_age_days
        {%- endfor %}
    from spine as sp
    {%- for s in daily_series %}
    asof left join s_{{ s }} on sp.date_day >= s_{{ s }}.obs_date
    {%- endfor %}

)

select
    date_day
    {%- for s in daily_series %},
    case when {{ s }}_age_days <= {{ var('max_ffill_days') }} then {{ s }}_raw end  as {{ s }},
    {{ s }}_age_days
    {%- endfor %}
from aligned
```

Notes:
- `asof left join` keeps every spine day even before a series starts (the value is `NULL`).
- Subtracting two dates gives a number of days in DuckDB, so `{{ s }}_age_days` records **how stale** each value is. Keeping it lets dashboards grey out stale points.
- This model reads `dim_date`, a mart. Calendar dimensions are the accepted exception to "intermediate doesn't read marts": they're conformed reference data used everywhere. Record exceptions like this in `CONVENTIONS.md` (Day 37).

```bash
dbt build --select int_market__daily
dbt show --inline "
select date_day, cad_usd, cad_usd_age_days, yield_2yr, us_yield_2yr, wti, wti_age_days
from {{ ref('int_market__daily') }}
order by date_day desc limit 10"
```

### Tests

```yaml
# models/intermediate/markets/_markets__models.yml
version: 2

models:
  - name: int_market__daily
    description: >
      Business-day panel of all daily series (seed frequency = 'daily'), aligned by ASOF join.
      Values older than var('max_ffill_days') are set to NULL; *_age_days shows staleness.
    columns:
      - name: date_day
        data_tests: [unique, not_null]
    data_tests:
      - dbt_utils.expression_is_true:
          expression: "cad_usd_age_days is null or cad_usd_age_days >= 0"
```

### Try it 38.5

How many weekdays since 2020 had a **stale** (≥ 1 day old) US 10-year yield but a **fresh** (0 days) Canadian 10-year yield? What calendar events explain them?

<details>
<summary>Solution</summary>

```bash
dbt show --inline "
select year(date_day) as yr, count(*) as n_days
from {{ ref('int_market__daily') }}
where date_day >= date '2020-01-01'
  and us_yield_10yr_age_days >= 1 and yield_10yr_age_days = 0
group by 1 order by 1"
```

These are **US-only holidays** (e.g. Martin Luther King Jr. Day, Presidents' Day, Independence Day, Thanksgiving), when Canadian markets were open but Treasuries weren't. You'd find the reverse for Canadian holidays. Your aligned panel handles both correctly and transparently.

</details>

### Day 38 checklist
- [ ] I designed the mart from consumer questions, with an explicit grain per model
- [ ] New series were added through configuration and seeds only, with no code changes
- [ ] `dim_series` describes country, instrument type and tenor, with tests enforcing consistency
- [ ] `fct_yield_curve` stores the curve in long format, and I can build curves "as of" any date
- [ ] `int_market__daily` aligns all daily series on business days with a staleness cap

```bash
dbt build && cd .. && git add . && git commit -m "Day 38: mart design, new yields, fct_yield_curve, aligned daily panel" && git push
```

---

# DAY 39 — The Open-Economy Mart

| Time | Block |
|---|---|
| 0:00 – 0:35 | 39.1 A short open-economy primer for the data |
| 0:35 – 1:40 | 39.2 `int_open_economy__daily`: spreads, slopes, returns |
| 1:40 – 1:55 | Break |
| 1:55 – 2:40 | 39.3 Rolling volatility, correlations and betas |
| 2:40 – 3:25 | 39.4 Monthly and quarterly one-big-tables |
| 3:25 – 3:40 | Break |
| 3:40 – 4:20 | 39.5 Levels vs changes: a spurious-correlation lesson |
| 4:20 – 5:00 | 39.6 `macro_kpis`: the one-screen status table |

---

## 39.1 A Short Open-Economy Primer for the Data (35 min)

A few relationships motivate the columns we'll build. We treat them as **descriptive** patterns to monitor, not causal claims. Causal questions come in Module 8.

| Idea | Intuition | Mart column(s) |
|---|---|---|
| **Interest-rate differentials** | When Canadian yields rise relative to US yields, holding CAD becomes relatively more attractive, which tends to support CAD (USD/CAD falls). | `ca_us_2y_spread_bp`, `ca_us_10y_spread_bp`, `policy_diff_bp` |
| **Commodity currency** | Canada is a major energy exporter, and CAD has often moved with oil prices. | `wti`, `wti_logret` |
| **Curve slope** | An inverted curve (10y below 2y) has historically preceded slowdowns (Day 16). | `ca_slope_bp`, `us_slope_bp` |
| **Curvature** | The 5-year relative to the 2- and 10-year: how "humped" the curve is. | `ca_butterfly_bp` |
| **Regime changes** | These links strengthen, weaken or flip over time (the notebook's Module 06 rolling correlation). | rolling correlations and betas |

The notebook already charts several of these (BoC–Fed differential vs USD/CAD; CAD/USD vs WTI; rolling correlation). The mart makes them **consistent, tested and reusable**.

---

## 39.2 `int_open_economy__daily`: Spreads, Slopes, Returns (65 min)

Create `models/intermediate/markets/int_open_economy__daily.sql`:

```sql
-- Grain: one row per weekday. Open-economy derived measures from int_market__daily.
-- Spreads in basis points; returns are daily log changes (non-positive prices → NULL).
{{ config(materialized='table') }}

with m as (

    select * from {{ ref('int_market__daily') }}

),

levels as (

    select
        date_day,

        -- FX: both quotes (the notebook uses both)
        cad_usd,
        1 / cad_usd                                         as usd_cad,

        -- Policy rates
        overnight_rate,
        fed_funds_daily,
        {{ bp('overnight_rate - fed_funds_daily') }}        as policy_diff_bp,

        -- Curves
        yield_2yr   as ca_2y,  yield_5yr   as ca_5y,  yield_10yr   as ca_10y,
        us_yield_2yr as us_2y, us_yield_5yr as us_5y, us_yield_10yr as us_10y,
        {{ bp('yield_10yr - yield_2yr') }}                  as ca_slope_bp,
        {{ bp('us_yield_10yr - us_yield_2yr') }}            as us_slope_bp,
        {{ bp('2 * yield_5yr - yield_2yr - yield_10yr') }}  as ca_butterfly_bp,

        -- Cross-border spreads
        {{ bp('yield_2yr - us_yield_2yr') }}                as ca_us_2y_spread_bp,
        {{ bp('yield_10yr - us_yield_10yr') }}              as ca_us_10y_spread_bp,

        -- Oil
        wti
    from m

)

select
    *,
    case when usd_cad > 0 and lag(usd_cad) over w > 0
         then ln(usd_cad / lag(usd_cad) over w) end         as usd_cad_logret,
    case when wti > 0 and lag(wti) over w > 0
         then ln(wti / lag(wti) over w) end                 as wti_logret,
    ca_us_2y_spread_bp  - lag(ca_us_2y_spread_bp)  over w   as d_ca_us_2y_spread_bp,
    ca_us_10y_spread_bp - lag(ca_us_10y_spread_bp) over w   as d_ca_us_10y_spread_bp
from levels
window w as (order by date_day)
```

Why `case when … > 0`? On **20 April 2020**, WTI futures settled **below zero**, a historic anomaly caused by storage constraints. The logarithm of a negative number is undefined, so without the guard this model would fail or produce garbage. It's a reminder that economic data contains genuine extremes, and robust code anticipates them.

Why **log returns**? They add up over time (the log change over a month is the sum of daily log changes) and are roughly the percentage change for small moves. That's the standard in finance and international macro.

---

## 39.3 Rolling Volatility, Correlations and Betas (45 min)

Now the **dynamics**. We add rolling statistics over a 60-business-day window (about three months), producing `NULL` until the window is full, as `rolling_avg` did on Day 37.

First, a small generic macro for "rolling statistic with a minimum count". Create `macros/rolling_stat.sql`:

```sql
{#
  rolling_stat(): any aggregate over the last n rows, NULL unless all n rows have both inputs.
  expr        the aggregate expression, e.g. 'corr(a, b)' or 'stddev_samp(a)'
  count_expr  expression counted for completeness, e.g. 'a + b' (NULL if either is NULL)
#}
{% macro rolling_stat(expr, count_expr, n, order_by) -%}
    case
        when count({{ count_expr }}) over (order by {{ order_by }}
             rows between {{ n - 1 }} preceding and current row) = {{ n }}
        then {{ expr }} over (order by {{ order_by }}
             rows between {{ n - 1 }} preceding and current row)
    end
{%- endmacro %}
```

Then the final daily fact, `models/marts/open_economy/fct_open_economy_daily.sql`:

```sql
-- Grain: one row per weekday. Open-economy dashboard fact (notebook Modules 02 & 06).
{% set n = var('rolling_window_days', 60) %}

with d as (

    select * from {{ ref('int_open_economy__daily') }}

)

select
    *,

    -- Realised volatility of USD/CAD, annualised (≈252 trading days), in %
    {{ rolling_stat('stddev_samp(usd_cad_logret)', 'usd_cad_logret', n, 'date_day') }}
        * sqrt(252) * 100                                                   as usd_cad_vol_ann_pct,

    -- Rolling correlations of daily changes
    {{ rolling_stat('corr(usd_cad_logret, wti_logret)',
                    'usd_cad_logret + wti_logret', n, 'date_day') }}         as corr_usdcad_wti,
    {{ rolling_stat('corr(usd_cad_logret, d_ca_us_2y_spread_bp)',
                    'usd_cad_logret + d_ca_us_2y_spread_bp', n, 'date_day') }} as corr_usdcad_2y_spread,

    -- Rolling beta: % change in USD/CAD per 10bp widening of the CA–US 2y spread
    {{ rolling_stat('regr_slope(usd_cad_logret, d_ca_us_2y_spread_bp)',
                    'usd_cad_logret + d_ca_us_2y_spread_bp', n, 'date_day') }}
        * 10 * 100                                                          as beta_usdcad_per_10bp
from d
```

Add `rolling_window_days: 60` to `vars`.

| Statistic | DuckDB function | Economic reading |
|---|---|---|
| volatility | `stddev_samp` × √252 | how turbulent CAD is, annualised |
| correlation | `corr(x, y)` | do the two move together day to day? (−1 to +1) |
| beta | `regr_slope(y, x)` | how much USD/CAD moves per unit move in the spread |

A **negative** `corr_usdcad_2y_spread` means: when Canadian 2-year yields rise relative to US ones, USD/CAD tends to fall (CAD strengthens), consistent with the differential story in 39.1. Check the sign in your data, and how it changes over time.

### Tests and docs

```yaml
# models/marts/open_economy/_open_economy__models.yml
version: 2

models:
  - name: fct_open_economy_daily
    description: >
      Daily open-economy fact for the Rates & FX and Open Economy dashboards.
      Grain: weekday. Rolling statistics use var('rolling_window_days') business days
      and are NULL until the window is complete.
    columns:
      - name: date_day
        data_tests: [unique, not_null]
      - name: corr_usdcad_wti
        data_tests:
          - within_range: {min_value: -1, max_value: 1}
      - name: corr_usdcad_2y_spread
        data_tests:
          - within_range: {min_value: -1, max_value: 1}
      - name: usd_cad_vol_ann_pct
        data_tests:
          - within_range: {min_value: 0, max_value: 50}
```

Correlations outside [−1, 1] would mean a bug. Testing mathematical bounds is cheap insurance.

```bash
dbt build --select +fct_open_economy_daily
dbt show --inline "
select date_day, round(usd_cad, 4) as usd_cad, round(ca_us_2y_spread_bp) as spread_2y,
       round(corr_usdcad_2y_spread, 2) as corr_spread, round(corr_usdcad_wti, 2) as corr_wti,
       round(usd_cad_vol_ann_pct, 1) as vol
from {{ ref('fct_open_economy_daily') }} order by date_day desc limit 10"
```

---

## 39.4 Monthly and Quarterly One-Big-Tables (45 min)

### Monthly open-economy aggregates

`models/intermediate/markets/int_open_economy__monthly.sql`:

```sql
-- Grain: one row per month. Month-end FX, monthly averages of spreads and slopes,
-- monthly log changes, and how many business days contributed.
select
    cast(date_trunc('month', date_day) as date)              as month,
    arg_max(usd_cad, date_day)                               as usd_cad_eom,
    arg_max(wti, date_day)                                   as wti_eom,
    avg(ca_us_2y_spread_bp)                                  as ca_us_2y_spread_bp_avg,
    avg(ca_us_10y_spread_bp)                                 as ca_us_10y_spread_bp_avg,
    avg(policy_diff_bp)                                      as policy_diff_bp_avg,
    avg(ca_slope_bp)                                         as ca_slope_bp_avg,
    avg(us_slope_bp)                                         as us_slope_bp_avg,
    sum(usd_cad_logret)                                      as usd_cad_logret_month,
    sum(wti_logret)                                          as wti_logret_month,
    count(usd_cad)                                           as fx_days
from {{ ref('int_open_economy__daily') }}
group by 1
```

`sum(usd_cad_logret)` is the monthly log change, the additivity of log returns in action.

### `marts/macro/macro_monthly.sql`: the monthly one-big-table

Port Day 20's `macro_monthly`, now with open-economy columns. **Requirements:**
- Grain: month from `var('panel_start_date')`.
- From `int_rates__monthly`: all panel columns (generated from the seed, so US yields are included).
- From `int_cpi__national_measures`: `headline_yoy`, `core_ex_fe_yoy`, `headline_ann_3m`, `median_major_yoy`, `diffusion_above_3`, `next_yoy_if_flat`.
- From `int_open_economy__monthly`: all columns.
- Derived: `real_rate`, `real_rate_core` (use the Day 35 `real_rate` macro), `usd_cad_12m_pct` (12-month % change in month-end USD/CAD, gap-safe), `in_dated_recession` (`overlaps_recession`).

<details>
<summary>Solution</summary>

```sql
-- models/marts/macro/macro_monthly.sql
-- Grain: one row per month, Canada. Rates, FX, oil, CPI measures, real rates, open-economy aggregates.
with rates as (
    select * from {{ ref('int_rates__monthly') }}
    where month >= date '{{ var("panel_start_date") }}'
),

cpi as (
    select month, headline_yoy, core_ex_fe_yoy, headline_ann_3m,
           median_major_yoy, diffusion_above_3, next_yoy_if_flat
    from {{ ref('int_cpi__national_measures') }}
),

oe as (
    select * from {{ ref('int_open_economy__monthly') }}
),

joined as (
    select r.*, c.* exclude (month), o.* exclude (month)
    from rates as r
    left join cpi as c using (month)
    left join oe  as o using (month)
),

with_lags as (
    select *,
           lag(usd_cad_eom, 12) over (order by month) as _usd_cad_l12,
           lag(month, 12)       over (order by month) as _month_l12
    from joined
)

select
    * exclude (_usd_cad_l12, _month_l12),
    {{ real_rate('overnight_rate', 'headline_yoy') }}      as real_rate,
    {{ real_rate('overnight_rate', 'core_ex_fe_yoy') }}    as real_rate_core,
    case when _month_l12 = cast(month - interval 12 month as date)
         then {{ pct_change('usd_cad_eom', '_usd_cad_l12') }} end    as usd_cad_12m_pct,
    {{ overlaps_recession('month', "cast(month + interval 1 month - interval 1 day as date)") }}
                                                           as in_dated_recession
from with_lags
```

`* exclude (…)` drops the helper columns. Helper names start with `_`, the convention from the `growth_rates` macro.

</details>

### `marts/macro/macro_quarterly.sql`

Port Day 20's `macro_quarterly` with the same pattern: GDP from `int_gdp__growth` (plus deflator and cycle flags), **complete-quarter** averages from `macro_monthly` (require 3 months of data), and quarterly averages of the CA–US spreads. Because `macro_quarterly` reads `macro_monthly`, it is a mart reading a mart. Either accept this and document it (the quarterly table is explicitly a roll-up of the monthly one), or move the monthly logic into an intermediate model both read from. Discuss which you prefer, then implement it.

---

## 39.5 Levels vs Changes: a Spurious-Correlation Lesson (40 min)

The notebook's Module 06 computes a 12-month rolling correlation between USD/CAD **levels** and WTI **levels**. Let's compare that with correlations of **monthly changes**.

Create `analyses/levels_vs_changes.sql`:

```sql
with m as (
    select month, usd_cad_eom, wti_eom, usd_cad_logret_month, wti_logret_month
    from {{ ref('macro_monthly') }}
    where usd_cad_eom is not null and wti_eom is not null
),
rolled as (
    select
        month,
        {{ rolling_stat('corr(usd_cad_eom, wti_eom)', 'usd_cad_eom + wti_eom', 12, 'month') }}
            as corr_levels_12m,
        {{ rolling_stat('corr(usd_cad_logret_month, wti_logret_month)',
                        'usd_cad_logret_month + wti_logret_month', 12, 'month') }}
            as corr_changes_12m
    from m
)
select
    round(avg(abs(corr_levels_12m)), 2)                       as avg_abs_corr_levels,
    round(avg(abs(corr_changes_12m)), 2)                      as avg_abs_corr_changes,
    round(avg(case when abs(corr_levels_12m)  > 0.8 then 1.0 else 0 end), 2) as share_levels_above_08,
    round(avg(case when abs(corr_changes_12m) > 0.8 then 1.0 else 0 end), 2) as share_changes_above_08
from rolled
```

```bash
dbt compile --select levels_vs_changes
dbt show --inline "$(cat target/compiled/macro_dbt/analyses/levels_vs_changes.sql)"
```

Typically, level correlations are **much larger in absolute value** and swing violently between +1 and −1. Over 12 points, any two trending series look strongly related, in one direction or the other. Correlations of changes are smaller but far more meaningful. This is the classic **spurious regression** problem (Granger and Newbold), and the reason the daily fact uses **returns**.

> **Dashboard design consequence:** keep the levels chart (it's intuitive), but base any "relationship strength" indicator on changes. Put this reasoning in the column descriptions so dashboard users see it.

---

## 39.6 `macro_kpis`: the One-Screen Status Table (40 min)

The notebook's Module 07 shows a KPI grid with a coloured "signal" per indicator. The dbt version makes each value, its **as-of date**, and the **rule** behind its colour explicit.

Create `models/marts/macro/macro_kpis.sql`:

```sql
-- Grain: one row per KPI. Latest available value, its date, and a rule-based signal.
with m as (select * from {{ ref('macro_monthly') }}),
q as (select * from {{ ref('macro_quarterly') }}),
d as (select * from {{ ref('fct_open_economy_daily') }}),

{% set monthly_kpis = [
    {"pillar": "P1 Economy",  "kpi": "CPI headline YoY (%)",        "col": "headline_yoy"},
    {"pillar": "P1 Economy",  "kpi": "Unemployment rate (%)",       "col": "unemployment_rate"},
    {"pillar": "P3 Monetary", "kpi": "Overnight rate (%)",          "col": "overnight_rate"},
    {"pillar": "P3 Monetary", "kpi": "Real policy rate (%)",        "col": "real_rate"},
    {"pillar": "P4 Cycle",    "kpi": "OECD CLI (100 = trend)",      "col": "oecd_cli"},
] %}
{% set daily_kpis = [
    {"pillar": "P3 Monetary", "kpi": "CA 10y–2y slope (bp)",        "col": "ca_slope_bp"},
    {"pillar": "P5 Open",     "kpi": "USD/CAD",                     "col": "usd_cad"},
    {"pillar": "P5 Open",     "kpi": "CA–US 2y spread (bp)",        "col": "ca_us_2y_spread_bp"},
    {"pillar": "P5 Open",     "kpi": "USD/CAD vol, 60d ann. (%)",   "col": "usd_cad_vol_ann_pct"},
] %}

latest as (
    {% for k in monthly_kpis %}
    select '{{ k.pillar }}' as pillar, '{{ k.kpi }}' as kpi, '{{ k.col }}' as kpi_code,
           arg_max({{ k.col }}, month) as value, max(month) as as_of
    from m where {{ k.col }} is not null
    union all
    {% endfor %}
    {% for k in daily_kpis %}
    select '{{ k.pillar }}', '{{ k.kpi }}', '{{ k.col }}',
           arg_max({{ k.col }}, date_day), max(date_day)
    from d where {{ k.col }} is not null
    union all
    {% endfor %}
    select 'P1 Economy', 'Real GDP growth, q/q ann. (%)', 'real_qoq_ann',
           arg_max(real_qoq_ann, quarter), max(quarter)
    from q where real_qoq_ann is not null
)

select
    pillar,
    kpi,
    kpi_code,
    value,
    as_of,
    case kpi_code
        when 'headline_yoy'       then case when value between 1 and 3 then 'neutral'
                                            when value > 3 then 'warning' else 'warning' end
        when 'real_rate'          then case when value < 0 then 'stimulative' else 'restrictive' end
        when 'ca_slope_bp'        then case when value < 0 then 'negative' else 'neutral' end
        when 'real_qoq_ann'       then case when value < 0 then 'negative'
                                            when value < 1 then 'warning' else 'positive' end
        when 'unemployment_rate'  then 'neutral'
        else 'neutral'
    end as signal
from latest
order by pillar, kpi
```

- The KPI lists are **data** (lists of dicts), so adding a KPI is one line.
- Every KPI carries its **`as_of`** date, which fixes pitfall Q8 (a stale value presented as current).
- The signal rules are simple, visible and reviewable. On Days 41–50, Great Expectations can profile what "unusual" means statistically.

Add tests: `kpi_code` unique; `as_of` not null; `signal` in an accepted list.

### Day 39 checklist
- [ ] I can explain the open-economy measures (differentials, slope, curvature, oil) and their caveats
- [ ] `int_open_economy__daily` computes spreads and log returns, robust to negative oil prices
- [ ] `fct_open_economy_daily` provides rolling volatility, correlations and betas, `NULL` until complete
- [ ] `macro_monthly` and `macro_quarterly` combine rates, CPI, GDP and open-economy measures without leaking incomplete periods
- [ ] I can demonstrate why correlations of levels mislead and changes don't
- [ ] `macro_kpis` shows each KPI with value, date and a transparent signal rule

```bash
dbt build && cd .. && git add . && git commit -m "Day 39: open-economy mart, monthly/quarterly OBTs, KPIs" && git push
```

---

# DAY 40 — Production: Contracts, Exposures, Docs and the Cut-Over

| Time | Block |
|---|---|
| 0:00 – 0:45 | 40.1 Model contracts: promises about a mart's shape |
| 0:45 – 1:20 | 40.2 Exposures: putting the dashboards on the lineage graph |
| 1:20 – 1:35 | Break |
| 1:35 – 2:10 | 40.3 Documentation that scales: doc blocks and an overview page |
| 2:10 – 2:40 | 40.4 Exporting marts for the notebook |
| 2:40 – 2:55 | Break |
| 2:55 – 4:15 | 40.5 The cut-over: dev → prod with a regression test |
| 4:15 – 5:00 | 40.6 Retiring Module 2 · the final pipeline · Module 4 recap |

---

## 40.1 Model Contracts (45 min)

Tests check data **after** a model is built. A **model contract** is a promise about a model's **shape** (column names, data types, not-null constraints) that dbt checks **when building**. If the SQL would produce a different shape, the build fails before consumers ever see it. It's Day 25's schema contract idea, applied to your own marts.

Add to `models/marts/rates/_rates__models.yml`:

```yaml
  - name: fct_yield_curve
    config:
      contract:
        enforced: true
    columns:
      - name: curve_point_key
        data_type: varchar
        constraints:
          - type: not_null
      - name: obs_date
        data_type: date
        constraints:
          - type: not_null
      - name: country
        data_type: varchar
      - name: tenor_years
        data_type: integer
      - name: yield_pct
        data_type: double
      - name: series_id
        data_type: varchar
```

```bash
cd macro_dbt
dbt build --select fct_yield_curve
```

Now break the promise: rename `yield_pct` to `yld` in the SQL and rebuild. dbt refuses, listing the mismatch. Restore it.

When enforced, the contract must list **every** column. That's easy for narrow facts like `fct_yield_curve` and `macro_kpis`, and laborious for wide one-big-tables, where tests on key columns are often a better trade-off.

| Mechanism | Checks | When |
|---|---|---|
| dlt schema contract (Day 25) | raw data entering the warehouse | ingestion |
| dbt model contract | a mart's columns and types | build time |
| dbt data tests (Day 36) | values: keys, ranges, relationships | after build |
| Great Expectations (Days 41–50) | statistical profiles of data | after build / on schedule |

> If your adapter version reports that contracts or a constraint type aren't supported, keep `data_type`s for documentation, drop the unsupported `constraints`, and rely on `not_null` tests instead.

Add a contract to `macro_kpis` yourself (columns `pillar, kpi, kpi_code, value, as_of, signal`). Watch for `as_of`: it mixes month, quarter and day dates, so check the type DuckDB infers with `dbt show`.

---

## 40.2 Exposures: Putting the Dashboards on the Lineage Graph (35 min)

Your lineage graph ends at the marts. But the **reason** the marts exist is downstream: the notebook dashboards, forecasting and causal work. **Exposures** declare those consumers so they appear on the graph.

Create `models/exposures.yml`:

```yaml
version: 2

exposures:
  - name: rates_fx_dashboard
    label: "Rates & FX dashboard (notebook Module 02)"
    type: notebook
    maturity: medium
    description: >
      Policy rate path, Canadian and US yield curves, 10y–2y spread, USD/CAD vs the
      BoC–Fed differential, real policy rate.
    depends_on:
      - ref('fct_yield_curve')
      - ref('fct_open_economy_daily')
      - ref('macro_monthly')
    owner:
      name: Macro Data Course team
      email: course-team@example.com

  - name: open_economy_dashboard
    label: "Open Economy dashboard (notebook Module 06)"
    type: notebook
    maturity: medium
    description: "USD/CAD vs WTI and rate spreads, rolling correlations and betas, FX volatility."
    depends_on:
      - ref('fct_open_economy_daily')
      - ref('macro_monthly')
    owner:
      name: Macro Data Course team

  - name: macro_cockpit
    label: "Macro cockpit KPI grid (notebook Module 07)"
    type: dashboard
    maturity: low
    depends_on:
      - ref('macro_kpis')
    owner:
      name: Macro Data Course team
```

Now you can ask impact questions **before** changing anything:

```bash
dbt ls --select +exposure:open_economy_dashboard          # everything the dashboard depends on
dbt ls --select stg_statcan__cpi+ --resource-type exposure  # which dashboards a CPI change affects
dbt build --select +exposure:macro_cockpit                 # rebuild just what the cockpit needs
```

Exposures appear as orange nodes at the right edge of the docs lineage graph.

---

## 40.3 Documentation That Scales (35 min)

### Doc blocks: write a definition once, use it everywhere

The same column (`usd_cad`, `ca_us_2y_spread_bp`, …) appears in several models. Instead of copying descriptions, define them once in `models/docs.md`:

```markdown
{% docs usd_cad %}
Canadian dollars per US dollar (the inverse of the BoC's FXCADUSD series).
**Higher = weaker CAD.** Daily values are BoC closing rates, forward-filled at most
`max_ffill_days` calendar days across holidays.
{% enddocs %}

{% docs ca_us_2y_spread_bp %}
Canada 2-year benchmark yield minus US 2-year Treasury constant-maturity yield, in basis
points. Positive = Canadian short-term yields above US ones.
{% enddocs %}

{% docs rolling_window_note %}
Rolling statistics use `rolling_window_days` business days (default 60) and are NULL
until the window is complete. Based on daily **changes**, not levels (see analysis
`levels_vs_changes`).
{% enddocs %}
```

Reference them in YAML:

```yaml
      - name: usd_cad
        description: '{{ doc("usd_cad") }}'
      - name: corr_usdcad_2y_spread
        description: 'Rolling correlation of USD/CAD log returns with changes in the CA–US 2y spread. {{ doc("rolling_window_note") }}'
```

### An overview page

The docs site's home page comes from a special doc block. Add to `models/docs.md`:

```markdown
{% docs __overview__ %}
# Canadian Macro Data Mart

Built by the MSc Economics *Applied Decision Intelligence* course.

**Pipeline:** dlt (`ingest.py`) → `raw_dlt` → dbt staging → intermediate → marts.

**Start here:**
- `macro_monthly`: monthly one-big-table (rates, FX, CPI, real rates, open economy)
- `macro_quarterly`: quarterly GDP growth, deflator, recession flags
- `fct_open_economy_daily`: daily spreads, returns, volatility, rolling correlations
- `fct_yield_curve`: Canadian and US yield curves (long format)
- `macro_kpis`: latest KPI values with signals

Conventions: see `CONVENTIONS.md` in the repository.
{% enddocs %}
```

```bash
dbt docs generate && dbt docs serve --port 8080
```

---

## 40.4 Exporting Marts for the Notebook (30 min)

The dashboard notebook reads Parquet files (Day 20). Let dbt write them **automatically after each mart is built in prod**, using a **post-hook**: SQL that dbt runs right after a model.

Create `macros/export_parquet.sql`:

```sql
{#
  Post-hook: in prod, copy the just-built mart to <export_dir>/<model>.parquet.
  In other targets it does nothing (returns a harmless statement).
#}
{% macro export_parquet() %}
    {% if target.name == 'prod' and model.config.materialized in ['table', 'incremental'] %}
        copy {{ this }} to '{{ var("export_dir") }}/{{ this.name }}.parquet' (format parquet)
    {% else %}
        select 1
    {% endif %}
{% endmacro %}
```

In `dbt_project.yml`:

```yaml
vars:
  export_dir: "../data/marts"

models:
  macro_dbt:
    marts:
      +materialized: table
      +schema: marts
      +post-hook:
        - "{{ export_parquet() }}"
```

- `{{ this }}` is the model's own table; `{{ this.name }}` its name.
- `model.config.materialized` lets the hook skip views and ephemeral models.
- DuckDB's `COPY … TO` needs the folder to exist: the pipeline script creates `data/marts/` first (40.6).

---

## 40.5 The Cut-Over: dev → prod with a Regression Test (80 min)

Until now, production dashboards read Module 2's hand-built objects. Today dbt takes over the clean schema names (`staging`, `intermediate`, `marts`, `seeds`). We follow the Day 30 recipe: **snapshot → change → compare**.

### Step 0 — Freeze

Make sure nobody else writes to `macro.duckdb` during the cut-over: close all DuckDB CLI sessions and notebooks.

### Step 1 — Snapshot the current production marts

```bash
cd /workspaces/macro-data-course
mkdir -p data/migration
duckdb macro.duckdb -readonly -c "
COPY marts.macro_monthly   TO 'data/migration/m2_macro_monthly.parquet'   (FORMAT parquet);
COPY marts.macro_quarterly TO 'data/migration/m2_macro_quarterly.parquet' (FORMAT parquet);
COPY marts.policy_cycles   TO 'data/migration/m2_policy_cycles.parquet'   (FORMAT parquet);"
```

### Step 2 — Check what prod would build, without building it

```bash
cd macro_dbt
dbt ls --target prod --resource-type model --output json --output-keys "name schema" | head -40
```

Every model should show a clean schema (`staging`, `intermediate`, `marts`), with no `dev_` prefixes. That's the `generate_schema_name` macro from Day 32 doing its job.

### Step 3 — Build prod

```bash
mkdir -p ../data/marts
dbt build --target prod
```

dbt replaces same-named Module 2 objects (for example `staging.stg_statcan__cpi`, `marts.macro_monthly`) and creates the new ones. The post-hook writes Parquet exports to `data/marts/`.

### Step 4 — Regression test against the snapshot

Create `analyses/cutover_regression.sql`:

```sql
{% set checks = [
    {"name": "macro_monthly", "key": "month",
     "cols": ["overnight_rate", "fed_funds", "headline_yoy", "core_ex_fe_yoy", "real_rate",
              "spread_10_2_bp", "usd_cad"]},
    {"name": "macro_quarterly", "key": "quarter",
     "cols": ["real_qoq_ann", "real_yoy", "overnight_rate_avg", "headline_yoy_avg"]},
    {"name": "policy_cycles", "key": "cycle_id",
     "cols": ["start_date", "end_date", "n_moves", "total_bp", "rate_before", "rate_after"]},
] %}

{% for c in checks %}
select
    '{{ c.name }}'  as mart,
    (select count(*) from (
        select {{ c.key }}{% for col in c.cols %}, round(cast({{ col }} as double), 6){% endfor %}
        from 'data/migration/m2_{{ c.name }}.parquet'
        except
        select {{ c.key }}{% for col in c.cols %}, round(cast({{ col }} as double), 6){% endfor %}
        from {{ ref(c.name) }}
    )) as rows_changed_or_missing
{{ 'union all' if not loop.last }}
{% endfor %}
```

Run it from the repository root (the Parquet paths are relative to it):

```bash
dbt compile --target prod --select cutover_regression
cd .. && duckdb macro.duckdb -readonly -c "$(cat macro_dbt/target/compiled/macro_dbt/analyses/cutover_regression.sql)" && cd macro_dbt
```

(`round(cast(… as double), 6)` makes dates and numbers comparable and ignores floating-point noise. Adjust the column lists if any Module 2 names differ from yours.)

**Interpreting the result** (the Day 30 rules):

| Pattern | Meaning | Action |
|---|---|---|
| 0 everywhere | clean cut-over | proceed |
| differences only in the most recent months | new data since the snapshot | note and proceed |
| differences in old months | revisions (lookback), or a logic difference | inspect the rows; fix or document before proceeding |
| many rows missing | a filter or join changed (e.g. a leftover dev filter) | fix, rebuild prod, re-run |

For any non-zero count, list the actual rows with the same `except` query (without `count(*)`) and explain each difference in `data/migration/NOTES.md`.

### Step 5 — Remove objects dbt doesn't manage

Module 2 left objects that no dbt model replaced (e.g. `staging.stg_macro__observations`, old `intermediate.*` names). An operational macro can compare the database with dbt's **graph** of known nodes. Create `macros/ops/drop_orphaned_relations.sql`:

```sql
{% macro drop_orphaned_relations(schemas=['staging', 'intermediate', 'marts', 'seeds'],
                                 dry_run=true) %}
    {% if target.name != 'prod' %}
        {{ exceptions.raise_compiler_error("Run with --target prod") }}
    {% endif %}

    {# Every relation dbt manages in this target #}
    {% set managed = [] %}
    {% for node in graph.nodes.values()
           | selectattr("resource_type", "in", ["model", "seed", "snapshot"]) %}
        {% do managed.append((node.schema ~ "." ~ node.alias) | lower) %}
    {% endfor %}

    {% set query %}
        select table_schema, table_name, table_type
        from information_schema.tables
        where table_schema in ({% for s in schemas %}'{{ s }}'{{ ', ' if not loop.last }}{% endfor %})
        order by 1, 2
    {% endset %}

    {% for row in run_query(query) %}
        {% set fqn = (row[0] ~ "." ~ row[1]) | lower %}
        {% if fqn not in managed %}
            {% set kind = "view" if row[2] == "VIEW" else "table" %}
            {% if dry_run %}
                {{ log("would drop " ~ kind ~ " " ~ fqn, info=True) }}
            {% else %}
                {% do run_query("drop " ~ kind ~ " if exists " ~ fqn) %}
                {{ log("dropped " ~ kind ~ " " ~ fqn, info=True) }}
            {% endif %}
        {% endif %}
    {% endfor %}
{% endmacro %}
```

```bash
dbt run-operation drop_orphaned_relations --target prod                        # review the list
dbt run-operation drop_orphaned_relations --target prod --args '{dry_run: false}'
```

`graph` is dbt's in-memory map of the whole project, available to macros. Reading it lets operational macros reason about **what the project defines**, the same information the lineage graph shows.

Finally, drop the retired Module 2 raw tables (keep `raw_dlt`, of course):

```sql
-- in the DuckDB CLI, after confirming nothing reads them
drop table if exists raw.observations;
drop table if exists raw.statcan_cpi;
drop table if exists raw.statcan_cpi_full;
drop table if exists raw.statcan_gdp_full;
drop table if exists raw.dim_series;
drop table if exists raw.boc_decisions;      -- now a dbt seed
drop schema if exists scratch cascade;       -- Day 14 experiments
```

---

## 40.6 Retiring Module 2 · the Final Pipeline · Module 4 Recap (45 min)

### Move legacy code aside

Keep it in the repository for reference, clearly marked as retired:

```bash
cd /workspaces/macro-data-course
mkdir -p legacy
git mv sql legacy/sql
git mv load_warehouse.py run_tests.py legacy/
git mv run_extract.py macro_extract legacy/ 2>/dev/null || true
echo "Retired at the Day 40 dbt cut-over. See macro_dbt/ and ingest.py." > legacy/README.md
```

### The final `pipeline.sh`

```bash
#!/usr/bin/env bash
# pipeline.sh — ingest (dlt) → transform & test (dbt, prod) → export → docs
set -e
source .venv/bin/activate

python ingest.py || [ $? -eq 2 ]            # tolerate partial ingestion failures (Day 30)

mkdir -p data/marts
cd macro_dbt
dbt deps --quiet
dbt source freshness --target prod || echo "⚠ source freshness warnings — see above"
dbt build --target prod                      # seeds, models, snapshots, tests, exports
dbt docs generate --target prod
cd ..

echo "✓ Pipeline complete: marts in macro.duckdb and data/marts/*.parquet"
```

```bash
./pipeline.sh
ls -lh data/marts/
```

### Point the notebook at the mart

In the dashboard notebook, the data-fetching cells (Cells 2–5) are replaced by:

```python
import pandas as pd

monthly   = pd.read_parquet("data/marts/macro_monthly.parquet")
quarterly = pd.read_parquet("data/marts/macro_quarterly.parquet")
daily     = pd.read_parquet("data/marts/fct_open_economy_daily.parquet")
curve     = pd.read_parquet("data/marts/fct_yield_curve.parquet")
kpis      = pd.read_parquet("data/marts/macro_kpis.parquet")
```

A quick check that the open-economy data tells a coherent story, in the notebook's style:

```python
import plotly.graph_objects as go
from plotly.subplots import make_subplots

d = daily[daily["date_day"] >= "2018-01-01"]
fig = make_subplots(specs=[[{"secondary_y": True}]])
fig.add_trace(go.Scatter(x=d["date_day"], y=d["usd_cad"], name="USD/CAD"), secondary_y=False)
fig.add_trace(go.Scatter(x=d["date_day"], y=d["ca_us_2y_spread_bp"],
                         name="CA–US 2y spread (bp)"), secondary_y=True)
fig.update_layout(title="USD/CAD vs the Canada–US 2-year spread")
fig.show()
```

Every number on every chart now comes from **tested, documented, version-controlled** models, and the notebook contains only presentation.

### Module 4 recap (Days 31–40)

| Days | You built |
|---|---|
| 31–33 | a dbt project over DuckDB: sources, `ref()`, materialisations, seeds, docs, Jinja |
| 34 | modular layers: one staging model per source table, concept-based intermediates, facts & dimensions |
| 35 | DRY macros: `growth_rates`, `pct_change`, `monthly_value`, `overlaps_recession`, `run_query` from seeds |
| 36 | tests: generic, `dbt_utils`, custom, singular, unit tests; source freshness |
| 37 | incremental `fct_observations`, CPI snapshot, generated staging, operational macros, conventions |
| 38 | mart design from consumer questions; yield-curve fact; aligned business-day market panel |
| 39 | open-economy daily fact (spreads, returns, vol, correlations, betas); monthly/quarterly OBTs; KPIs |
| 40 | contracts, exposures, doc blocks, Parquet exports, a regression-tested cut-over to prod |

### The architecture after Module 4

```
BoC · FRED · StatCan · (World Bank)
          │  dlt (ingest.py): incremental, contracts, resilient
          ▼
   raw_dlt.*  ──►  dbt: staging → intermediate → marts   (prod, tested, documented)
                              │
                              ├── macro.duckdb: marts.*
                              └── data/marts/*.parquet ──► notebook dashboards (exposures)
```

### Looking ahead: Module 5 — Great Expectations (Days 41–50)

dbt tests check rules **you wrote**. Great Expectations adds **expectation suites** built from data profiles, human-readable **Data Docs**, and validation of incoming StatCan data, such as *unemployment between 0 and 100%* and *dates continuous without gaps*, at the boundary where data enters the warehouse. Your marts, contracts and exposures from today become the assets GE protects.

### Day 40 checklist
- [ ] Narrow marts have enforced contracts; wide ones have tests on key columns
- [ ] Exposures put the notebook dashboards on the lineage graph, and I can select by exposure
- [ ] Shared column definitions live in doc blocks; the docs site has an overview page
- [ ] Marts are exported to Parquet by a post-hook in prod
- [ ] The cut-over was regression-tested against a snapshot, with differences explained in writing
- [ ] Orphaned objects and retired raw tables were removed with a guarded macro and reviewed SQL
- [ ] `./pipeline.sh` runs ingestion, dbt in prod, exports and docs end to end

```bash
git add .
git commit -m "Day 40: contracts, exposures, docs, exports, prod cut-over — Module 4 complete"
git push
```
