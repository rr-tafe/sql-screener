# Offline SQL Screening

A self-contained SQL technical screening tool. Each assessment is a single
standalone HTML file that runs entirely in the candidate's browser — no server,
no internet connection, and no candidate data leaves their machine.

---

## Repository layout

```
sql-screening/
├── builder/              Python build pipeline (builder.py)
├── runtime/              Shared browser runtime (JS, CSS, HTML template)
├── modules/              Source content for each assessment module
├── dist/                 Built assessment HTML files (ready to distribute)
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
8. Serialises the SQLite database to base64
9. Minifies the JS and CSS runtime files
10. Assembles everything into a single HTML file
11. Writes the HTML and a copy of the module README to `dist/`
12. Runs the integration and feature test suites against the output
13. Prints the output file size

If any step fails the build stops, prints the reason, and no output file is
written (or the partial file is deleted if tests fail post-write).

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
└── template/
    └── MODULE_TEMPLATE.md      LLM prompt for authoring new modules
```

---

## Creating a new module

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

Keep the `sql-screening/dist/<module-id>-README.md` for yourself — it contains
the question guide and interviewer notes.

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
python builder.py --module modules/digital-bank-marketing-analytics
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
