#!/usr/bin/env node
/**
 * integration_test.js — Verify compiled dist HTML correctness.
 * Tests grading path, hash alignment, base64 round-trips, placeholder check.
 *
 * Usage: node runtime/test/integration_test.js --module=<module-id>
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

const args = process.argv.slice(2);
const moduleArg = args.find(a => a.startsWith('--module='));
if (!moduleArg) {
  console.error('Usage: node integration_test.js --module=<module-id>');
  process.exit(1);
}
const moduleId = moduleArg.split('=')[1];

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_HTML = path.join(REPO_ROOT, 'dist', `${moduleId}.html`);
const MODULE_DIR = path.join(REPO_ROOT, 'modules', moduleId);
const RUNTIME_DIR = path.join(REPO_ROOT, 'runtime');
const GRADING_LOGIC = path.join(RUNTIME_DIR, 'grading-logic.js');

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
}

function fail(msg) {
  console.error(`  FAIL: ${msg}`);
  failed++;
}

// ─────────────────────────────────────────────────────────────────────────────
// Load dist HTML
// ─────────────────────────────────────────────────────────────────────────────

if (!fs.existsSync(DIST_HTML)) {
  console.error(`dist HTML not found: ${DIST_HTML}`);
  process.exit(1);
}

const htmlContent = fs.readFileSync(DIST_HTML, 'utf-8');

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Zero unreplaced placeholders
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[1] Placeholder check');
// Strip JS block comments (esbuild adds /* @__PURE__ */ annotations that would
// otherwise trigger false positives on the __[A-Z_]+__ pattern).
const htmlNoComments = htmlContent.replace(/\/\*[\s\S]*?\*\//g, '');
const remaining = htmlNoComments.match(/__[A-Z_]+__/g);
ok(!remaining || remaining.length === 0,
  `Zero unreplaced __PLACEHOLDER__ patterns (found: ${remaining ? remaining.length : 0})`);

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Extract embedded JSON payloads
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[2] Embedded data extraction');

function extractVar(html, varName) {
  // Match: var VARNAME = <json>
  const re = new RegExp(`var ${varName}\\s*=\\s*([\\s\\S]+?);\\s*(?:var |\\}\\)\\(\\)|$)`, 'm');
  const m = html.match(re);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

function extractVarStr(html, varName) {
  const re = new RegExp(`var ${varName}\\s*=\\s*"([^"]*)"`, 'm');
  const m = html.match(re);
  return m ? m[1] : null;
}

const questionsFromHtml = extractVar(htmlContent, 'QUESTIONS_JSON');
const hashesFromHtml = extractVar(htmlContent, 'ANSWER_HASHES_JSON');
const schemaFromHtml = extractVar(htmlContent, 'SQL_SCHEMA_JSON');
const wasmB64 = extractVarStr(htmlContent, 'SQL_JS_WASM_B64');
const dbB64 = extractVarStr(htmlContent, 'DATASET_DB_B64');

ok(Array.isArray(questionsFromHtml) && questionsFromHtml.length > 0, 'QUESTIONS_JSON extracted');
ok(hashesFromHtml && typeof hashesFromHtml === 'object', 'ANSWER_HASHES_JSON extracted');
ok(schemaFromHtml && schemaFromHtml.tables, 'SQL_SCHEMA_JSON extracted');
ok(typeof wasmB64 === 'string' && wasmB64.length > 100, 'SQL_JS_WASM_B64 present');
ok(typeof dbB64 === 'string' && dbB64.length > 100, 'DATASET_DB_B64 present');

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Base64 round-trip verification
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[3] Base64 round-trip');

// Load source WASM and DB for comparison
const wasmPath = path.join(RUNTIME_DIR, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const wasmSourceB64 = wasmPath && fs.existsSync(wasmPath)
  ? Buffer.from(fs.readFileSync(wasmPath)).toString('base64')
  : null;

if (wasmSourceB64) {
  ok(wasmB64 === wasmSourceB64, 'WASM base64 matches source file (round-trip)');
} else {
  console.log('  SKIP: WASM source not found for comparison');
}

// Verify DB base64 decodes to valid SQLite file
try {
  const dbBytes = Buffer.from(dbB64, 'base64');
  const magic = dbBytes.slice(0, 16).toString('utf8');
  ok(magic.startsWith('SQLite format 3'), 'Dataset base64 decodes to valid SQLite file');
} catch (e) {
  fail(`Dataset base64 decode failed: ${e.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Run all reference solutions through sql.js + grading-logic.js
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[4] Reference solutions → PASS');

async function runSolutionTests() {
  const initSqlJs = require(path.join(RUNTIME_DIR, 'node_modules', 'sql.js', 'dist', 'sql-wasm.js'));
  const GradingLogic = require(GRADING_LOGIC);

  const wasmBytes = fs.readFileSync(wasmPath);
  const SQL = await initSqlJs({ wasmBinary: wasmBytes });

  // Load DB from base64
  const dbBytes = Buffer.from(dbB64, 'base64');
  const db = new SQL.Database(dbBytes);

  // Read solutions from module dir
  const solutionsPath = path.join(MODULE_DIR, 'solutions.sql');
  if (!fs.existsSync(solutionsPath)) {
    fail('solutions.sql not found — cannot run solution tests');
    return;
  }
  const solutionsSql = fs.readFileSync(solutionsPath, 'utf-8');

  // Parse solution blocks
  const blocks = {};
  const parts = solutionsSql.split(/--\s*(q\d+)\s*\n/i);
  for (let i = 1; i < parts.length - 1; i += 2) {
    blocks[parts[i].trim().toLowerCase()] = parts[i + 1].trim();
  }

  for (const q of questionsFromHtml) {
    const qId = q.id;
    const expectedCols = q.expectedColumns;
    const expectedHash = hashesFromHtml[qId];
    const sqlBlock = blocks[qId];

    if (!sqlBlock) {
      fail(`No solution block for ${qId}`);
      continue;
    }
    if (!expectedHash) {
      fail(`No hash for ${qId} in ANSWER_HASHES_JSON`);
      continue;
    }

    try {
      const results = db.exec(sqlBlock);
      const rows = results.length > 0 ? results[0].values : [];
      const hash = await GradingLogic.computeHash(rows, expectedCols);
      ok(hash === expectedHash, `${qId} reference solution → PASS (hash match)`);
    } catch (e) {
      fail(`${qId} reference solution threw: ${e.message}`);
    }
  }

  // Test deliberately wrong query → FAIL (not false PASS)
  console.log('\n[5] Wrong query → FAIL');
  try {
    const q = questionsFromHtml[0];
    const wrongSql = "SELECT 'wrong_answer_xyz' AS dummy_col";
    const results = db.exec(wrongSql);
    const rows = results.length > 0 ? results[0].values : [];
    const hash = await GradingLogic.computeHash(rows, q.expectedColumns);
    ok(hash !== hashesFromHtml[q.id], 'Deliberately wrong query → FAIL (hash mismatch, not false PASS)');
  } catch (e) {
    fail(`Wrong query test threw: ${e.message}`);
  }

  // Test malformed query → ERROR (no uncaught exception surfacing)
  console.log('\n[6] Malformed query → ERROR (not exception)');
  try {
    db.exec('THIS IS NOT SQL');
    fail('Malformed query should have thrown (sql.js should reject invalid SQL)');
  } catch (e) {
    ok(e instanceof Error, 'Malformed SQL throws catchable Error (not uncaught exception)');
  }

  db.close();

  // ─────────────────────────────────────────────────────────────────────────
  // Test 7: SQL schema JSON contains expected tables
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[7] SQL schema JSON structure');
  if (schemaFromHtml) {
    const tables = Object.keys(schemaFromHtml.tables || {});
    ok(tables.length > 0, `SQL schema has ${tables.length} tables: ${tables.join(', ')}`);
    for (const [tbl, cols] of Object.entries(schemaFromHtml.tables || {})) {
      ok(Array.isArray(cols) && cols.length > 0, `Table '${tbl}' has ${cols.length} columns`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Run async tests and report
// ─────────────────────────────────────────────────────────────────────────────

runSolutionTests().then(() => {
  console.log(`\n──────────────────────────────────`);
  console.log(`integration_test.js: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('All integration tests passed.');
    process.exit(0);
  }
}).catch(e => {
  console.error(`Unexpected error in integration_test: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
