---
name: sql-screening-module-builder
description: Interview an assessment author briefly, craft a clear scenario/backstory, then author and validate a complete SQLite SQL screening module ZIP with realistic data and concise, non-prescriptive candidate questions.
---

# SQL Screening Module Builder

This skill is self-contained and does not depend on `template/*.txt` or
`template/MODULE_TEMPLATE.md` — those are a separate, standalone document. Everything this
skill needs is below.

## Mission and completion contract
Create a self-contained module package for a SQL screening assessment. The author is the person
commissioning the assessment; candidates are the people taking it. Gather only missing
requirements, then produce the complete ZIP in the current task. Do not stop after a
requirements summary, seek a final approval, or repeat a question already answered. A message
such as "proceed", "use the proposed counts", or "final requirements" ends the interview. If a
non-critical detail is missing, make a reasonable, documented choice and build the module. If a
critical detail genuinely prevents a fair or executable module, ask ONE focused question, then
continue on the next reply. Never start another interview cycle.

Treat explicit author requirements as authoritative, including a custom number of questions or
difficulty mix. This skill supersedes contradictory legacy rules that demand solution hints in
candidate prompts or repeated confirmations. Do not claim a ZIP was created or validated unless
it was.

## State machine: prevent interview loops
1. Read the current request, supplied files and existing conversation. Extract answers already given. Do not re-ask them.
2. Maintain an internal requirements ledger: domain/industry; role and seniority; business scenario/backstory and decisions; question count; difficulty distribution; tables and exact rows per table; SQL concepts; desired data-quality cases; final constraints. Mark each as supplied, inferred, defaulted, or blocking.
3. Ask at most one or two unanswered topics per turn, in the order below, ONLY if the author has asked for an interactive interview or essential choices cannot be responsibly inferred. Do not ask for a second confirmation of an answer or for permission to generate. A short response that addresses the current question advances the ledger.
4. Once enough information exists to build a coherent assessment, freeze the ledger and generate. No post-interview confirmation step. Do not restart because a later instruction refines an earlier answer; update the ledger and proceed.
5. If the author requests a guide/skill rather than an actual module, produce the guide/skill and do NOT run the module interview.

### Interview topics and defaults
- Domain and industry: ask "What domain or industry is this assessment for?" if unknown; examples include commerce, healthcare, logistics, finance and HR.
- Role and seniority: ask who will take the assessment and at what level if unknown.
- Scenario: ask for a brief business setting, available data and decisions supported. If the author supplies a theme rather than a full story, flesh it out without changing the stated theme (see Backstory and scenario design below).
- Question count: ask if missing; default to six. Five to ten is a recommendation, not a restriction; honour explicit counts such as three.
- Difficulty: offer a balanced mix appropriate to count and role if missing. For six, examples are 2/2/2, 3/2/1, or 1/3/2 easy/medium/hard. References: four = 2/1/1; five = 2/2/1; eight = 3/3/2; ten = 3/4/3. Custom distributions take precedence; totals must equal count. Easy typically involves a simple filter, join or aggregation; medium may involve multi-table joins, HAVING, subqueries or dates; hard may involve multi-step aggregation, CTEs, windows or correlated subqueries. These are complexity guides, NOT mandatory techniques to disclose to candidates.
- Data volume: default Medium (roughly 100-500 rows per substantive table); Small is 10-50 and Large 2,000-5,000. Do not choose over 5,000 rows per table by default. Choose exact counts for every table, including smaller lookup tables, and state them in the author-facing README. If the author gives exact counts, use them. If they approve proposed counts, use those counts without re-confirming. If only a tier is specified, select exact counts and proceed; do not turn a size preference into a confirmation loop.
- SQL concepts: ask only if the author wants control; otherwise choose level-appropriate coverage from joins, aggregation/GROUP BY/HAVING, subqueries/CTEs, window functions, SQLite date handling, NULL handling, strings and self-joins. Never force one technique if multiple valid approaches exist.
- Data-quality cases: ask only if necessary; otherwise select relevant cases from NULLs, duplicate business records, orphan-like references, inconsistent casing, date gaps/out-of-order timestamps and business-rule violations. Design each case intentionally and document it for the author, without giving candidates a list of planted issues.
- Final constraints: accept column/value requirements, concise candidate-facing wording, company context and synthetic-data restrictions. Do not ask a final "anything else?" question if the author has already said to proceed or supplied final requirements. Do not ask whether questions should hint at SQL techniques; default is NO.

## Backstory and scenario design
Before writing any schema or data, write a short, coherent backstory that ties the domain,
role/seniority, and business scenario together into one concrete setting. This backstory is the
spine of the whole module:
- Name the fictional company/team, what it does, and why it keeps the data in question.
- Identify the decisions or actions the data is meant to support (e.g. pricing, staffing,
  retention, fraud triage) — this motivates why each question is being asked.
- Identify which tables/entities naturally exist in that setting and what each one records.
- Use the backstory to decide realistic value ranges, categories, naming conventions and the
  kind of imperfections that would plausibly occur in that setting (e.g. a delivery business
  plausibly has late/failed deliveries; a campaign platform plausibly has duplicate exposures).
- Keep the backstory synthetic and generic: no real companies, real people, or sensitive real
  data. A light fictional framing is fine as long as it does not imply a real employer.
- Write the backstory once, then stay consistent with it across the schema, the data, the
  question prompts, and the README — table names, value domains and the question framing should
  all read as if they came from the same place.

## Candidate-facing assessment design
The assessment must expose the candidate's ability to inspect the schema and data, discover relevant issues, choose SQL and explain reasonable assumptions. Each question is a clear, brief business request, preferably one or two sentences total. State the requested outcome and necessary output, not a procedure. Do not disclose the intended formula, SQL constructs, join path, planted anomalies, normalisation steps, or which records to exclude merely because the reference solution does so.

Distinguish indispensable business definitions from investigatory decisions. If revenue, active customer, cancellation, date window, unit, denominator, sign, tie policy or rounding has a definition that cannot reasonably be inferred from candidate-visible material, state the minimum necessary business rule briefly in the prompt or neutral candidate documentation. Do not hide a convention that materially changes the graded answer. For ambiguous quality issues, either make the business rule available, make plausible alternatives produce the same result, or support assessment of stated assumptions. A single reference query is not evidence that all other approaches are wrong.

Avoid vague time references such as "recent" without an anchor when the answer depends on the interpretation. Specify date bounds and inclusion where material, using business language rather than SQL predicates. Specify output column meaning, units and precision when material, but do not mandate irrelevant rounding or a particular ORDER BY. Never grade row order. Keep expectedColumns in the same order as the reference query output. Do not reveal final answer values or plaintext expected results.

Example: avoid "Use LOWER() on inconsistent category labels, exclude NULL amounts and calculate quantity * unit_price with ROUND(..., 2)." Prefer "Which product categories generated the most sales revenue? Return each category and its revenue to two decimal places." If the definition of sales revenue is not evident from candidate-visible material, add only the essential business definition.

## How grading works (design within these rules)
Candidates submit SQL and the result is compared against the reference answer by normalising
and comparing row values, not by inspecting SQL text or column aliases:
- Column **position**, not column name, is what is compared. `expectedColumns` only fixes the
  number of columns and the labels shown to the candidate in the UI; neither the candidate's nor
  the reference solution's actual SELECT aliases need to match that label text. The order of
  columns in the reference solution's SELECT must match the order of `expectedColumns`.
- Row order never matters — rows are compared as a set, not a sequence. Never require a specific
  `ORDER BY` for correctness, and never design a question where row order is the only thing
  distinguishing two otherwise-identical rows.
- Text values are compared case-insensitively. Numbers are compared in a type-insensitive way
  (e.g. a value of `100.0` and `100` are treated as equal). `NULL` is treated as its own distinct
  value. Design answers so legitimate alternative SQL phrasings converge on the same result —
  do not let correctness hinge on one phrasing returning a whole number and another a decimal for
  the same conceptual value, or on inconsistent rounding across rows.
- `difficulty` is informational only and is not checked automatically — you are the only check
  on whether the stated easy/medium/hard mix is actually honoured by the questions you wrote.

## Candidate versus author materials
Candidates only ever see: the question prompts, their expected column labels and difficulty
tags, and the schema's table/column **names** (no comments, types, or constraints) together with
the actual data, which they can query freely. Candidates never see the raw schema file's
comments, the reference solutions, the README, or the ER diagram as documents.

Consequences:
- Question prompts must still never disclose the intended formula, SQL constructs, join path,
  planted anomalies, normalisation steps, or which records to exclude, because the prompt text
  itself is shown to the candidate verbatim.
- The README and ER diagram MAY safely contain a question-by-question concept guide, difficulty
  rationale, and a description of intentionally planted data-quality cases, because they are
  author/interviewer-only documents. Do not, however, put literal expected query results or
  answer values there — keep this documentation qualitative, not a leaked answer key.
- Comments inside the schema file are also safe from candidate exposure (only bare column names
  are shown to candidates), so document tricky constraints or design rationale there freely.
- The reference solutions file is author-only and must never be exposed to candidates.
- Avoid disclosing sensitive real data; use synthetic records only.

## Deliverable structure and specifications
Create `<module-id>.zip` containing exactly one top-level `<module-id>/` folder with at least:

```
<module-id>/
  module.json
  schema.sql
  questions.json
  solutions.sql
  er-diagram.md
  README.md
  data/<table>.csv       # one per table
```

- `module.json`: exactly the keys `id`, `title`, `description`, `version`, `questionCount`,
  `engine`. `id` is kebab-case and MUST match the folder name and the ZIP's base name exactly.
  `engine` is the literal string `sqlite`. `questionCount` must exactly equal the number of
  entries in `questions.json`.
- `schema.sql`: SQLite DDL runnable on an empty database; plain, unquoted, word-characters-only
  table names (no schema-qualified or bracket-quoted names); `INTEGER PRIMARY KEY` for primary
  keys and `REFERENCES` for valid foreign keys. Do not define an enforced foreign key for
  deliberately orphaned records unless the data is designed so the load still succeeds.
- CSVs: exactly one per table, filename matching the table name exactly, headers exactly
  matching schema column names, blank cells for SQL NULL, exact chosen data-row count excluding
  header, CSV-escaped values. Data must be internally coherent while containing chosen
  intentional anomalies, and consistent with the backstory.
- `questions.json`: one object per question with `id`, `prompt`, `expectedColumns`, `difficulty`;
  ids exactly `q1`..`qN` sequential and lowercase; difficulty easy/medium/hard; count matches
  `module.json`; brief business prompt grounded in the backstory, no required row order.
- `solutions.sql`: one executable SQLite solution per question, each block starting on its own
  line with exactly `-- q1`, `-- q2`, etc.; column order must match that question's
  `expectedColumns` order (alias text does not need to match). Do not require a specific SQL
  pattern in candidate prompts.
- `er-diagram.md`: Mermaid `erDiagram` with all tables, columns and genuine FK relationships; do
  not portray intentional orphan-like data as an enforced relationship unless accurate.
- `README.md`: the backstory/scenario, table overview, usage/import notes, author/date/version
  metadata when known, and (since this file is author/interviewer-only) a question-by-question
  concept/difficulty guide and a note of intentionally planted data-quality cases. If author
  identity is unknown, use an explicit neutral placeholder; do not invent identity. Do not
  include literal expected result values.

## SQLite and content constraints
Use SQLite-compatible SQL throughout. Dates are TEXT in ISO `YYYY-MM-DD`; use SQLite date functions where needed, not `DATE '...'`, `INTERVAL`, `GENERATE_SERIES` or `UNNEST`. Use INTEGER 0/1 instead of BOOLEAN and avoid RETURNING. Be aware that SQLite string comparisons and LIKE have different default case behaviours; test the actual operator/collation rather than relying on a blanket case-sensitivity claim. Avoid row-order-dependent answers. Do not rely on unsupported extensions or platform-specific SQL.

For portable artefacts, use printable ASCII for data values, identifiers, candidate prompts and README prose (plus standard line breaks); no emoji, smart quotes, accented letters, en/em dashes or invisible Unicode. Currency symbols: `$` only, otherwise currency codes. Check the actual encoded artefacts, not just a visual sample. If author explicitly requires non-ASCII content, document the incompatibility and follow the framework's verified requirements rather than silently corrupting data.

Data volume tiers (rows per substantive table, exact counts chosen per table and stated in README.md): Small 10-50, Medium 100-500 (default), Large 2,000-5,000. Do not exceed 5,000 rows per table by default; favor the lower end of a tier for schemas with many tables or wide text columns.

## Build and mandatory pre-delivery quality gate
Use available code execution to generate the files and ZIP. Write the final ZIP to an accessible output location and provide a download link; do not merely print a local path. If execution is unavailable, provide complete filename-delimited artefacts in order: module.json, schema.sql, each CSV, questions.json, solutions.sql, er-diagram.md, README.md, then a functional build-zip.sh. Do not pretend the fallback is a generated ZIP. Do not dump raw files into chat when a ZIP is available.

Validate programmatically before delivery:
1. Parse both JSON files and every CSV; verify required keys, q1..qN, difficulty mix, column headers, unique IDs, exact rows per table, valid quoting and allowed characters.
2. Build a fresh SQLite database from schema.sql, import all CSVs with empty fields mapped to NULL, and verify row counts and intended relationship behaviour. Check that planned anomalies exist without unintentionally breaking unrelated questions.
3. Execute each reference solution independently; verify it runs, returns the declared columns in order and has an appropriate non-empty or intentionally empty result. Compare results without relying on row order. Test critical boundaries, NULLs, duplicates, ties, units and ratios where relevant.
4. Review every candidate prompt for brevity, clarity, fairness, lack of spoilers, and consistency with the backstory. Check plausible alternative interpretations; revise the question, data or grading approach if a reasonable candidate would be penalised for an unstated convention. Numeric/date/NULL/duplicate/tie conventions belong in the prompt ONLY if indispensable to a fair answer; otherwise keep them in author-side validation.
5. Check Mermaid references, ZIP paths and required files; open the ZIP and inspect its contents. Confirm the folder name, module.json's id and the ZIP's base name all match. Do not include plaintext answer values. If any check fails, fix and rerun the checks before delivery.

Return the ZIP link only when successfully created, with at most a short status sentence. Never end at a requirements summary when generation was requested.
