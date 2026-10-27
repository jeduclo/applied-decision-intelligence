import {
  Code2, Database, Download, Layers, ShieldCheck, Workflow, TrendingUp, Network,
  type LucideIcon,
} from "lucide-react";

/** Course-wide information (edit freely). */
export const COURSE = {
  title: "Applied Decision Intelligence & Data Architecture",
  program: "For Economists",
  tagline: "An 80-day technical curriculum that turns economists into full-stack data architects.",
  author: "Jean Alegue, PhD",
  hoursPerDay: 2.5,
} as const;

export type Part = { id: number; title: string; days: string };

export const PARTS: Part[] = [
  { id: 1, title: "Data Engineering Foundations", days: "Days 1–30" },
  { id: 2, title: "Transformation, Validation & Orchestration", days: "Days 31–60" },
  { id: 3, title: "Advanced Analytics & Capstone", days: "Days 61–80" },
];

export type Topic = { days: string; text: string };

export type ModuleMeta = {
  number: number;
  slug: string;
  title: string;
  short: string;          // label on the tab bar
  part: number;
  firstDay: number;
  lastDay: number;
  accent: string;         // UI accent for this module
  icon: LucideIcon;
  focus: string;
  tools: string[];
  topics: Topic[];        // the curriculum plan, three blocks per module
};

export const MODULES: ModuleMeta[] = [
  {
    number: 1, slug: "python", title: "Python for Macroeconomics", short: "Python", part: 1,
    firstDay: 1, lastDay: 10, accent: "#2dd4bf", icon: Code2,
    focus: "Core programming, data wrangling, and API interaction.",
    tools: ["Python", "pandas", "requests", "pytest", "Git"],
    topics: [
      { days: "Days 1–3", text: "Syntax, control flow, functions, and virtual environments (.venv)." },
      { days: "Days 4–7", text: "Data manipulation with pandas, handling time-series indexing." },
      { days: "Days 8–10", text: "Fetching indicators from the Bank of Canada, FRED and Statistics Canada via REST APIs." },
    ],
  },
  {
    number: 2, slug: "duckdb", title: "Analytical SQL with DuckDB", short: "DuckDB SQL", part: 1,
    firstDay: 11, lastDay: 20, accent: "#38bdf8", icon: Database,
    focus: "In-process analytical database architecture and query optimization.",
    tools: ["DuckDB", "SQL", "Parquet"],
    topics: [
      { days: "Days 11–13", text: "DuckDB CLI, relational algebra, and loading external CSV/Parquet files." },
      { days: "Days 14–17", text: "Advanced SQL, window functions, and Common Table Expressions (CTEs)." },
      { days: "Days 18–20", text: "Staging CPI and GDP; year-over-year changes and moving averages directly in SQL." },
    ],
  },
  {
    number: 3, slug: "dlt", title: "Data Ingestion with dlt", short: "dlt Ingestion", part: 1,
    firstDay: 21, lastDay: 30, accent: "#a78bfa", icon: Download,
    focus: "Declarative data pipelines and automated extraction.",
    tools: ["dlt", "REST APIs", "DuckDB", "Pydantic"],
    topics: [
      { days: "Days 21–23", text: "dlt pipelines, sources vs. resources, and secrets management." },
      { days: "Days 24–27", text: "Schema evolution, flattening nested JSON, and incremental loading." },
      { days: "Days 28–30", text: "Resilient extractors for the BoC Valet API and StatCan endpoints, loading into DuckDB." },
    ],
  },
  {
    number: 4, slug: "dbt", title: "Data Modeling with dbt", short: "dbt Modeling", part: 2,
    firstDay: 31, lastDay: 40, accent: "#fbbf24", icon: Layers,
    focus: "Transforming staged data into production-ready analytical marts.",
    tools: ["dbt", "Jinja", "DuckDB"],
    topics: [
      { days: "Days 31–33", text: "Project initialization, materializations (views/tables), and basic Jinja templating." },
      { days: "Days 34–37", text: "Modular modeling (staging, intermediate, marts), DRY principles, and dbt macros." },
      { days: "Days 38–40", text: "A macro data mart joining yield curves with USD/CAD: an open-economy dashboard schema." },
    ],
  },
  {
    number: 5, slug: "great-expectations", title: "Quality Assurance with Great Expectations", short: "Data Quality", part: 2,
    firstDay: 41, lastDay: 50, accent: "#fb7185", icon: ShieldCheck,
    focus: "Contract-driven data engineering and anomaly detection.",
    tools: ["Great Expectations", "DuckDB", "Data Docs"],
    topics: [
      { days: "Days 41–43", text: "Data quality principles, initializing contexts, and connecting to DuckDB sources." },
      { days: "Days 44–47", text: "Expectation suites, profiling datasets, and automated Data Docs." },
      { days: "Days 48–50", text: "Validating incoming StatCan data: unemployment rates within 0–100%, continuous dates." },
    ],
  },
  {
    number: 6, slug: "prefect", title: "Pipeline Orchestration with Prefect", short: "Orchestration", part: 2,
    firstDay: 51, lastDay: 60, accent: "#34d399", icon: Workflow,
    focus: "Workflow scheduling, dependency management, and error handling.",
    tools: ["Prefect", "dlt", "dbt", "Great Expectations"],
    topics: [
      { days: "Days 51–53", text: "Flow and task decorators, local orchestration, and state management." },
      { days: "Days 54–57", text: "Retries, caching, scheduling, and logging." },
      { days: "Days 58–60", text: "Orchestrating the daily macro-dashboard refresh: dlt → DuckDB → dbt → GX." },
    ],
  },
  {
    number: 7, slug: "forecasting", title: "Forecasting with XGBoost & Chronos", short: "Forecasting", part: 3,
    firstDay: 61, lastDay: 70, accent: "#fb923c", icon: TrendingUp,
    focus: "Predictive modeling on macroeconomic time-series data.",
    tools: ["XGBoost", "scikit-learn", "SHAP", "Chronos"],
    topics: [
      { days: "Days 61–63", text: "Supervised learning theory, tree-based models, and univariate forecasting." },
      { days: "Days 64–67", text: "Hyperparameter tuning, SHAP explainability, and zero-shot forecasting with Chronos." },
      { days: "Days 68–70", text: "Forecasting Canadian CPI and real GDP growth with features engineered earlier." },
    ],
  },
  {
    number: 8, slug: "causal-inference", title: "Causal Inference with DoubleML", short: "Causal Inference", part: 3,
    firstDay: 71, lastDay: 80, accent: "#e879f9", icon: Network,
    focus: "Isolating causal impacts from observational economic data.",
    tools: ["DoubleML", "DAGs", "statsmodels"],
    topics: [
      { days: "Days 71–73", text: "Causal inference theory, confounding variables, and Directed Acyclic Graphs (DAGs)." },
      { days: "Days 74–77", text: "Nuisance parameters, cross-fitting, and partially linear regression models." },
      { days: "Days 78–80", text: "The causal impact of BoC overnight-rate hikes on housing starts, controlling for the business cycle." },
    ],
  },
];

export const TOTAL_DAYS = 80;

export function moduleBySlug(slug: string) {
  return MODULES.find((m) => m.slug === slug);
}

export function moduleForDay(day: number) {
  return MODULES.find((m) => day >= m.firstDay && day <= m.lastDay);
}

export function moduleHref(m: ModuleMeta) {
  return `/module/${m.slug}`;
}

export function dayHref(day: number) {
  const m = moduleForDay(day);
  return m ? `/module/${m.slug}/day/${day}` : "/";
}
