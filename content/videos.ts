/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  VIDEO LINKS — one YouTube video per day page.
 *
 *  Paste a YouTube link (or just the video ID) between the quotes, save, then
 *  git commit + push: Vercel redeploys and the placeholder becomes the video.
 *
 *  Accepted formats (all work):
 *    "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
 *    "https://youtu.be/dQw4w9WgXcQ"
 *    "https://www.youtube.com/embed/dQw4w9WgXcQ"
 *    "dQw4w9WgXcQ"
 *
 *  Leave "" to show the "coming soon" placeholder.
 *  Tip: "Unlisted" YouTube videos embed fine and do not appear in search.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const VIDEOS: Record<number, string> = {
  // ── Module 1: Python for Macroeconomics ──
   1: "", // Python as an Economist's Calculator
   2: "", // Control Flow
   3: "", // Functions, Modules & Virtual Environments
   4: "", // pandas Fundamentals
   5: "", // Dates and Time-Series Indexing
   6: "", // Resampling, Grouping, Reshaping and Merging
   7: "", // Integration
   8: "", // How Web APIs Work
   9: "", // Robust Extraction
  10: "", // Statistics Canada WDS and Your Own Extraction Package

  // ── Module 2: Analytical SQL with DuckDB ──
  11: "", // First Steps with SQL in the DuckDB CLI
  12: "", // Relational Algebra
  13: "", // Loading External CSV and Parquet Files
  14: "", // Common Table Expressions
  15: "", // Window Functions I
  16: "", // Window Functions II
  17: "", // Advanced DuckDB Features and a First Analytical Mart
  18: "", // The Staging Layer
  19: "", // Intermediate Models
  20: "", // GDP, Mixed Frequencies and the Module 2 Capstone

  // ── Module 3: Data Ingestion with dlt ──
  21: "", // Your First dlt Pipelines
  22: "", // Sources vs Resources
  23: "", // Configuration, Secrets and the macro_ingest Package
  24: "", // Schema Evolution
  25: "", // Schema Contracts and Row Validation
  26: "", // Flattening Nested JSON API Responses
  27: "", // Incremental Loading
  28: "", // dlt's REST Toolkit
  29: "", // Resilience Engineering
  30: "", // macro_ingest v2 → The Warehouse

  // ── Module 4: Data Modeling with dbt ──
  31: "", // Your First dbt Project
  32: "", // Materializations, Configuration, Seeds and Documentation
  33: "", // Basic Jinja Templating
  34: "", // Modular Modeling
  35: "", // DRY Principles and dbt Macros
  36: "", // Testing and Packages
  37: "", // Incremental Models, Snapshots and Project Quality
  38: "", // Designing the Mart and Building Its Foundations
  39: "", // The Open-Economy Mart
  40: "", // Production

  // ── Module 5: Quality Assurance with Great Expectations ──
  41: "", // Data Quality Principles
  42: "", // Installing Great Expectations and Initializing a Data Context
  43: "", // Connecting GX to DuckDB
  44: "", // Expectation Suites
  45: "", // Profiling Datasets
  46: "", // Validation Definitions and Checkpoints
  47: "", // Automated Data Docs and Validation History
  48: "", // Write–Audit–Publish and the Boundary Contract
  49: "", // The Headline Contracts
  50: "", // Publish or Quarantine, and Closing the Loop

  // ── Module 6: Pipeline Orchestration with Prefect ──
  51: "", // Flows and Tasks
  52: "", // Local Orchestration
  53: "", // State Management
  54: "", // Retries and Timeouts
  55: "", // Caching
  56: "", // Scheduling and Deployments
  57: "", // Logging, Secrets, Concurrency and Run History
  58: "", // From Black Boxes to First-Class Tasks
  59: "", // Event-Driven Orchestration
  60: "", // Dashboards, Production Readiness and the End of Part II

  // ── Module 7: Forecasting with XGBoost & Chronos ──
  61: "", // Supervised Learning for Economists
  62: "", // Tree-Based Models
  63: "", // Univariate Forecasting
  64: "", // Hyperparameter Tuning Without Leakage
  65: "", // SHAP Explainability
  66: "", // SHAP in Practice
  67: "", // Zero-Shot Forecasting with Chronos
  68: "", // Multivariate CPI Forecasting with Real-Time Information Sets
  69: "", // Nowcasting and Forecasting Real GDP Growth
  70: "", // Forecasts in Production

  // ── Module 8: Causal Inference with DoubleML ──
  71: "", // Causal Inference Foundations
  72: "", // Confounders, Bad Controls and Timing
  73: "", // Directed Acyclic Graphs
  74: "", // The Partially Linear Model and Its Nuisance Parameters
  75: "", // Cross-Fitting and the doubleml Package
  76: "", // DML for Macroeconomic Time Series
  77: "", // The Partially Linear Model in Practice
  78: "", // Housing Starts Through the Platform, and First Estimates
  79: "", // Interpretation, Sensitivity and Heterogeneity
  80: "", // Integration and the Final Capstone
};
