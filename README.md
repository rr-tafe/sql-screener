# Offline SQL Screening

A self-contained SQL technical screening tool. Each assessment is a single
standalone HTML file that runs entirely in the candidate's browser — no server,
no internet connection, and no candidate data leaves their machine.

The workspace supports focused/all-question views, searchable schema details,
declared relationships, cancellable background SQL, and local autosave with
downloadable checkpoints. Grades belong to the exact executed SQL; later edits
are marked ungraded. Finish Work opens a review dialog with HTML and JSON exports.

Binary assets are gzip-compressed inside the HTML and decoded locally. Use a
current browser with WebAssembly, Web Workers and DecompressionStream support.
Local-file storage varies by browser; the save indicator reports failures and
downloadable checkpoints provide a portable fallback.

---

## Repository layout

```
sql-screening/
├── builder/              Python build pipeline (builder.py)
├── runtime/              Shared browser runtime (JS, CSS, HTML template)
├── modules/              Source content for each assessment module
├── dist/                 Built assessment HTML files (ready to distribute)
├── docs/                 Guides for screeners, candidates, and module builders
└── template/             LLM prompt template for authoring new modules

specs/                    Internal design specs and development history
```

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Python | 3.8 or later | Check with `python3 --version` |
| Node.js | 18 or later | Check with `node --version` |
| npm | bundled with Node.js | Used once during setup |

Python's standard library is sufficient for the build pipeline; there are no
`pip install` requirements. Node.js is required because the builder uses esbuild
(already listed as a project dependency) to minify the JavaScript and CSS that
get bundled into each assessment file.

---

## One-time setup

```bash
# 1. Clone the repository
git clone <repo-url>
cd <repo-name>

# 2. Install Node.js dependencies
#    This pulls in esbuild, CodeMirror, sql.js, and the test harness.
#    Run this once, and again whenever package.json changes.
cd sql-screening/runtime
npm install
cd ../..
```

That is all. The builder is a plain Python script — no virtual environment or
additional packages needed.

---

## Building an assessment

```bash
# From the repo root:
python3 sql-screening/builder/builder.py --module sql-screening/modules/<module-id>

# Example:
python3 sql-screening/builder/builder.py --module sql-screening/modules/banking-transaction-analytics
```

The builder runs a multi-step pipeline:

1. Validates the module folder structure and JSON files
2. Checks the declared engine is `sqlite`
3. Verifies question count matches `module.json`
4. Builds an in-memory SQLite database from the schema and CSV data
5. Executes all reference solutions and computes SHA-256 answer hashes
6. Re-validates each solution against its stored hash (sanity gate)
7. Derives a schema JSON summary for the candidate UI
8. Compresses and base64-encodes the database and WebAssembly engine
9. Minifies the JS and CSS runtime files
10. Assembles everything into a single HTML file
11. Writes staged HTML and a copy of the module README
12. Runs engine, integration and feature tests against the staged output
13. Checks the size budget, then publishes to `dist/`

If validation or tests fail, staged files are discarded and existing published
files remain unchanged. Every build refreshes the editor bundle automatically.
The default size budget is 5 MiB; use `--max-size-mb` to override it.

### Output files

| File | Purpose |
|---|---|
| `sql-screening/dist/<module-id>.html` | The assessment — send this to the candidate |
| `sql-screening/dist/<module-id>-README.md` | Interviewer context — keep this for yourself |

---

## Directory structure

```
sql-screening/
│
├── builder/
│   └── builder.py              Build pipeline (Python, stdlib only — no pip deps)
│
├── runtime/
│   ├── template.html           HTML shell with injection placeholders
│   ├── app.js                  Assessment UI logic
│   ├── style.css               Dark theme stylesheet
│   ├── grading-logic.js        Normalisation + SHA-256 hashing
│   ├── cm-editor-src.js        CodeMirror editor source
│   ├── cm-editor-bundle.js     Pre-built editor bundle (committed)
│   ├── package.json            Node.js dependencies
│   ├── package-lock.json       Locked dependency tree
│   └── test/
│       ├── integration_test.js Verifies solutions hash correctly
│       └── feature_test.js     Verifies UI structure and SQL guard
│
├── modules/
│   └── <module-id>/            One folder per assessment module
│       ├── module.json         Module metadata
│       ├── schema.sql          SQLite DDL
│       ├── questions.json      Question prompts and expected columns
│       ├── solutions.sql       Reference SQL (used to compute answer hashes)
│       ├── README.md           Interviewer guide for this module
│       └── data/
│           └── <table>.csv     One CSV per table
│
├── dist/                       Built assessment files (committed)
│   └── <module-id>.html
│
├── docs/
│   ├── screener-guide.html     Instructions for the interviewer running the session
│   ├── candidate-guide.html    Instructions to send to candidates before the test
│   └── module-builder-guide.html  Reference for authoring new modules
│
└── template/
    └── MODULE_TEMPLATE.md      LLM prompt for authoring new modules
```

---

## Creating a new module

For a working starting point, run from the repository root:

```bash
python sql-screening/builder/builder.py --scaffold sql-screening/modules/my-module
python sql-screening/builder/builder.py --module sql-screening/modules/my-module --preview
python sql-screening/builder/builder.py --module sql-screening/modules/my-module --validate-only
```

Scaffolding never overwrites an existing directory. Preview validates the module
and prints up to five reference-result rows per question without creating HTML.
Keep preview output with interviewer materials, not candidate materials.

New modules are authored with the help of an LLM using the prompt in
`sql-screening/template/MODULE_TEMPLATE.md`. The template conducts a structured
interview (domain, role, question count, difficulty, data volume, SQL concepts)
and then generates all required files as a zip.

Full authoring instructions are in [sql-screening/MODULE_AUTHORING_GUIDE.md](sql-screening/MODULE_AUTHORING_GUIDE.md).

**Short version:**

1. Open `sql-screening/template/MODULE_TEMPLATE.md` and paste its contents into
   Claude or another capable LLM.
2. Answer the interview questions.
3. Download the generated zip and extract it into `sql-screening/modules/<module-id>/`.
4. Run the builder: `python3 sql-screening/builder/builder.py --module sql-screening/modules/<module-id>`.
5. If the build passes, commit the module folder and the generated `dist/` files.

---

## Distributing an assessment to a candidate

Send the candidate only the `sql-screening/dist/<module-id>.html` file. They
open it in any modern browser (Chrome, Firefox, Safari, Edge). No installation
required. No internet connection required after the file is received.

When they click **Finish Work**, candidates review their answers and choose
**Download report** or **Download JSON**. The report includes a scorecard, exact
execution evidence, recent query history, and editable reviewer notes for printing.
Edited drafts do not inherit a previous passing grade. Reports and checkpoints
contain candidate data; store and share them appropriately.

Keep the `sql-screening/dist/<module-id>-README.md` for yourself — it contains
the question guide and interviewer notes.

The `sql-screening/docs/` folder contains three standalone HTML guides:

| File | For |
|---|---|
| `screener-guide.html` | You — how to set up, run, and debrief the session |
| `candidate-guide.html` | The candidate — send this alongside the assessment file |
| `module-builder-guide.html` | Whoever is authoring or building new modules |

---

## Rebuilding the editor bundle

The `sql-screening/runtime/cm-editor-bundle.js` file is pre-built and committed.
You only need to rebuild it if you change `sql-screening/runtime/cm-editor-src.js`
(the CodeMirror editor configuration):

```bash
cd sql-screening/runtime
npm run build
```

After rebuilding, re-run the builder for each module to pick up the new bundle.

---

## Running tests independently

```bash
python -B sql-screening/builder/test/test_hash_alignment.py
python -B sql-screening/builder/test/test_builder.py
npm --prefix sql-screening/runtime run test:engine
node sql-screening/runtime/node_modules/playwright/cli.js install chromium
npm --prefix sql-screening/runtime run test:browser
```

Builder tests use disposable fixture copies. Browser tests require a current built
`ci-test` assessment and run offline. Pass `-- --module=<module-id>` to test another
built module. Screenshots go to a temporary directory. The suite exercises real
execution, exports, recovery, unavailable storage, and desktop/mobile layouts.

Runtime limits: 8 seconds per query, 50,000 rows for grading, and 4 MB of result
data. Playground results show up to 500 rows; table previews show up to 100 rows.
Grading uses the complete result or reports an explicit limit error. Reports and
checkpoints retain up to 500 result rows and 20 recent runs per editor. Result
CSVs contain the displayed dataset, with sample files labelled as such.

The test suites require a built HTML file to run against. They are normally
invoked automatically by the builder, but you can run them manually:

```bash
# From the repo root:
node sql-screening/runtime/test/integration_test.js --module=<module-id>
node sql-screening/runtime/test/feature_test.js --module=<module-id>
```

---

## Cross-platform compatibility

Compatibility is now verified automatically in CI on Linux, macOS, and
Windows via the workflow at `.github/workflows/cross-platform-build.yml`.

The workflow installs Node.js and Python, then runs:

```bash
cd sql-screening/builder
python builder.py --module modules/ci-test
```

This gives an automated guard that build + integration/feature tests remain
portable across all three major platforms.

---

## Troubleshooting

**`node` not found during build**
Install Node.js from https://nodejs.org (LTS version recommended) and ensure
it is on your PATH.

**`npm install` fails**
Make sure you are running it from inside the `sql-screening/runtime/` directory,
not the repo root or `sql-screening/`.

**Build fails: "Runtime file missing: .../cm-editor-bundle.js"**
The bundle was not committed or was deleted. Rebuild it:
`cd sql-screening/runtime && npm run build`.

**Build fails: "esbuild minify (js) failed"**
esbuild is part of the npm dependencies. Run `npm install` inside
`sql-screening/runtime/` to ensure it is installed.

**Tests fail after editing runtime files**
Re-run the builder for all modules so their dist files reflect the latest
runtime. Pre-built dist files in the repo are pinned to the runtime version
at the time they were last built.
