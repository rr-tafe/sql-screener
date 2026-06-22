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

For format details, see:
- [contracts/module-authoring.md](contracts/module-authoring.md)
- [contracts/template-document.md](contracts/template-document.md)

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

On success, three files are written to `dist/`:

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

Full validation scenarios are documented in [quickstart.md](quickstart.md):
- **Scenario B1**: Successful build
- **Scenario B2–B5**: Validation gate scenarios (engine, solution, missing files)
- **Scenario C1**: Automated JS test harness
- **Scenario C2**: Manual browser walkthrough
- **Scenario C3**: Offline verification

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
