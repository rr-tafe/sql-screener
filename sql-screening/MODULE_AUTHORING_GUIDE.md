# Module Authoring Guide — SQL Screening Framework

End-to-end walkthrough for creating and distributing a new SQL assessment module.

## Prerequisites

Before you start, ensure you have:

- **Python 3.8+** — `python3 --version`
- **Node.js 18+** — `node --version`
- **npm** — `npm --version`

## One-time Setup

Run this once after cloning the repository:

```bash
cd sql-screening/runtime
npm install
```

This installs the JavaScript runtime dependencies (CodeMirror, sql.js, esbuild, jsdom).

---

## Step 1 — Generate module content with the LLM template

1. Open `template/MODULE_TEMPLATE.md`.
2. Copy the entire document.
3. Paste it into Claude (claude.ai) or ChatGPT.
4. Answer the LLM's eight interview questions about your module:
   - Domain/industry
   - Target role and seniority
   - Business scenario
   - Question count
   - Difficulty distribution
   - Data volume tier
   - SQL concepts to test
   - Data quality edge cases

5. The LLM will produce seven files in a single response:
   - `module.json`
   - `schema.sql`
   - `data/<table>.csv` (one per table)
   - `questions.json`
   - `solutions.sql`
   - `er-diagram.md`
   - `README.md`

---

## Step 2 — Place files in the modules directory

Create a folder under `modules/` using a kebab-case identifier that matches `module.json.id`:

```
modules/
└── my-new-module/
    ├── module.json
    ├── schema.sql
    ├── data/
    │   ├── table1.csv
    │   └── table2.csv
    ├── questions.json
    ├── solutions.sql
    ├── er-diagram.md
    └── README.md
```

Copy all generated files into this folder. Make sure `data/` contains one CSV per table in `schema.sql`.

For format details, see [template/20-required-file-specs.txt](template/20-required-file-specs.txt)
and the optional metadata section below.

---

## Step 3 — Build the candidate HTML

From the `sql-screening/` directory:

```bash
python builder/builder.py --module=modules/my-new-module
```

The builder will:
1. Validate all required files are present
2. Check engine (`sqlite`) and question count match
3. Execute all reference solutions and compute answer hashes
4. Validate every solution produces PASS
5. Assemble a self-contained HTML file
6. Copy the README to dist/
7. Run the JS test harness to verify the assembled HTML

On success, two files are written to `dist/`:

```
dist/
├── my-new-module.html          ← distribute this to candidates
└── my-new-module-README.md     ← interviewer context document
```

---

## Step 4 — Distribute to candidates

Send `dist/my-new-module.html` directly to candidates. No server required.

Candidate instructions:
> "Open the attached HTML file in any modern browser. No installation needed. The entire assessment runs offline in your browser."

The interviewer should keep `dist/my-new-module-README.md` for reference during the debrief.

---

## Validation reference

Run `python -B builder/test/test_builder.py` from `sql-screening/` for isolated
validation and publication tests. Run `npm --prefix runtime run test:browser`
after building `ci-test` and installing the Playwright Chromium browser for an
offline browser walkthrough. A failed build preserves previously published files.

---

## If the build fails

| Error message | Likely cause | Fix |
|---------------|-------------|-----|
| `Required file missing` | A file is absent from the module folder | Copy the missing file from the LLM output |
| `engine … expected 'sqlite'` | `module.json.engine` is not `"sqlite"` | Change it to `"sqlite"` |
| `Question count mismatch` | `questionCount` in module.json differs from questions.json | Update `questionCount` to match actual count |
| `Solution for 'qN' raised an exception` | solutions.sql has invalid SQL for that question | Fix the SQL in solutions.sql |
| `HASH_MISMATCH` | Solution produces wrong result | Review query logic and expectedColumns order |
| `sql.js WASM not found` | npm install not run | `cd runtime && npm install` |
| `cm-editor-bundle.js not found` | Bundle not built | `cd runtime && npm run build` |
| `JS test failed` | integration_test.js or feature_test.js failed | See test output; fix the module content |

---

## Troubleshooting solutions

The most common cause of build failure is a mismatch between `solutions.sql` and `expectedColumns` in `questions.json`. The framework grades by column **position** (not name), so the columns returned by the solution must appear in the same order as `expectedColumns`.

To debug interactively, open `dist/my-new-module.html` in a browser, enter any name, and run the reference solution for the failing question. If it returns FAIL, compare the column order in the result with the `expectedColumns` list.

---

## Rebuilding after runtime changes

If you modify `runtime/cm-editor-src.js`, rebuild the bundle first:

```bash
cd runtime && npm run build
```

Then re-run the builder.

## Scaffold, validate and preview

From `sql-screening/`:

```bash
python builder/builder.py --scaffold modules/my-module
python builder/builder.py --module modules/my-module --validate-only
python builder/builder.py --module modules/my-module --preview
python builder/builder.py --module modules/my-module --output-dir dist --max-size-mb 5
```

Preview prints solution columns and up to five sample result rows without writing
assessment files. Do not distribute that output to candidates. Builds compile the
editor automatically, gzip binary assets, run tests in staging, and only then
publish. Source paths work from either the repository root or `sql-screening/`.

## Optional question metadata

```json
{
   "id": "q1",
   "title": "Campaign response rates",
   "difficulty": "medium",
   "tags": ["aggregation", "date boundaries"],
   "prompt": "Return campaign_code and response_rate...",
   "expectedColumns": ["campaign_code", "response_rate"],
   "grading": {
      "caseSensitive": false,
      "orderSensitive": false,
      "requireColumnNames": false,
      "decimalPlaces": 2
   },
   "incorrectExamples": ["SELECT campaign_code, 0 AS response_rate FROM campaigns"]
}
```

The default ignores row order and text case, but preserves NULL, numeric and text
types and requires the exact number of columns. Numeric values are compared
exactly unless `decimalPlaces` (0-10) requests rounding before comparison.
Rounding is half-away-from-zero on the binary numeric value, not an absolute-error
tolerance. Only use it when the prompt states the same precision rule. Integers
beyond JavaScript's safe range must be returned as text. Duplicate rows matter.
Reference-solution column names must match `expectedColumns` in order.

Use `orderSensitive` only when the prompt explicitly requires an order, including
a deterministic tie-breaker. `requireColumnNames` makes candidate aliases exact.
Explain any case sensitivity or precision requirements in the question.

`incorrectExamples` are optional executable, same-shape queries representing
common mistakes. The build fails if one produces the reference answer. They are
not included in the candidate HTML. This checks your dataset's ability to expose
known mistakes; it does not prove that a question is unambiguous.

## Business descriptions

Add optional descriptions to `module.json`:

```json
{
   "dataDictionary": {
      "customers": {
         "description": "One row per customer.",
         "columns": { "customer_id": "Stable customer identifier." }
      }
   }
}
```

Types, keys, row counts and declared foreign-key relationships come from SQLite
metadata. Descriptions are authored, not inferred. The data explorer can insert
identifiers and preview up to 100 rows without replacing the candidate's answer.

## Runtime limits

Queries execute in a cancellable worker with an 8-second deadline. Base tables
are read-only; SELECT, read-only WITH and CREATE TEMP TABLE are supported.
Successful temporary-table setup is replayed after cancellation and recovery.
Grading accepts at most 50,000 rows and 4 MB of result data; exceeding a limit is an
error, never a grade on a truncated result. The UI/report retains up to 500 rows.
Build and browser-test representative solutions before distributing a module.
