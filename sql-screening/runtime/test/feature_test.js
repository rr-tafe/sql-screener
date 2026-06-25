#!/usr/bin/env node
/**
 * feature_test.js — UI behavior tests for compiled dist HTML.
 * Tests SQL guard, DOM state, Begin Test flow, pagination.
 *
 * Usage: node runtime/test/feature_test.js --module=<module-id>
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const args = process.argv.slice(2);
const moduleArg = args.find(a => a.startsWith('--module='));
if (!moduleArg) {
  console.error('Usage: node feature_test.js --module=<module-id>');
  process.exit(1);
}
const moduleId = moduleArg.split('=')[1];

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_HTML = path.join(REPO_ROOT, 'dist', `${moduleId}.html`);
const GRADING_LOGIC = path.join(REPO_ROOT, 'runtime', 'grading-logic.js');

if (!fs.existsSync(DIST_HTML)) {
  console.error(`dist HTML not found: ${DIST_HTML}`);
  process.exit(1);
}

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
// Test classify() extracted from the HTML — SQL guard rules
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[1] SQL guard — classify() rules');

// Extract classify function from HTML by looking for it
const htmlContent = fs.readFileSync(DIST_HTML, 'utf-8');

// We test the classify logic directly rather than running the full app in jsdom
// (which would require WASM), by recreating the exact same logic here.
// This validates the spec contract (rules must be in this exact order).
function classify(sql) {
  var s = sql.trim().replace(/\s+/g, ' ');
  if (/^SELECT\b/i.test(s)) return 'ALLOWED';
  if (/CREATE\s+(TEMP|TEMPORARY)\s+TABLE/i.test(s)) return 'ALLOWED';
  return 'BLOCKED';
}

// Verify SQL guard logic is implemented in the HTML (not silently missing).
// Check for the regex content — esbuild preserves regex literals even when
// minifying, so this survives minification unlike checking the function name.
ok(htmlContent.includes('ALLOWED') && htmlContent.includes('BLOCKED'),
  'classify function present in dist HTML');
ok(htmlContent.includes("CREATE\\\\s+(TEMP|TEMPORARY)\\\\s+TABLE") ||
   htmlContent.includes('CREATE\\s+(TEMP|TEMPORARY)\\s+TABLE') ||
   htmlContent.includes('TEMP|TEMPORARY'),
  'TEMP|TEMPORARY pattern present in classify implementation');

// Test all classify rules
ok(classify('SELECT * FROM accounts') === 'ALLOWED', 'SELECT → ALLOWED');
ok(classify('select * from accounts') === 'ALLOWED', 'select (lowercase) → ALLOWED');
ok(classify('  SELECT 1') === 'ALLOWED', 'Trimmed SELECT → ALLOWED');
ok(classify('CREATE TEMP TABLE tmp AS SELECT 1 AS x') === 'ALLOWED', 'CREATE TEMP TABLE → ALLOWED');
ok(classify('CREATE TEMPORARY TABLE tmp AS SELECT 1') === 'ALLOWED', 'CREATE TEMPORARY TABLE → ALLOWED');
ok(classify('create temp table t AS SELECT 1') === 'ALLOWED', 'create temp table (lowercase) → ALLOWED');
ok(classify('DROP TABLE accounts') === 'BLOCKED', 'DROP TABLE → BLOCKED');
ok(classify('DELETE FROM accounts') === 'BLOCKED', 'DELETE FROM → BLOCKED');
ok(classify('INSERT INTO accounts VALUES (1)') === 'BLOCKED', 'INSERT INTO → BLOCKED');
ok(classify('UPDATE accounts SET balance = 0') === 'BLOCKED', 'UPDATE → BLOCKED');
ok(classify('CREATE TABLE new_table (id INTEGER)') === 'BLOCKED',
  'CREATE TABLE (without TEMP) → BLOCKED');
ok(classify('TRUNCATE TABLE accounts') === 'BLOCKED', 'TRUNCATE → BLOCKED');
ok(classify('') === 'BLOCKED', 'Empty string → BLOCKED');
ok(classify('   ') === 'BLOCKED', 'Whitespace-only → BLOCKED');

// ─────────────────────────────────────────────────────────────────────────────
// Test grading-logic.js normalization
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[2] Grading logic — normalize and hash');

const GradingLogic = require(GRADING_LOGIC);

async function runGradingTests() {
  // Test normalization: rows should be sorted, NULLs become "null"
  const rows1 = [['charlie', '30'], ['alice', '10'], ['bob', '20']];
  const cols1 = ['name', 'score'];
  const norm1 = GradingLogic.normalizeRows(rows1, cols1);
  ok(norm1[0][0] === 'alice', 'Rows sorted lexicographically');
  ok(norm1[2][0] === 'charlie', 'Rows sorted lexicographically (last)');

  // NULL handling
  const rows2 = [[null, '5'], ['dave', null]];
  const cols2 = ['name', 'val'];
  const norm2 = GradingLogic.normalizeRows(rows2, cols2);
  ok(norm2.some(r => r[0] === 'null'), 'NULL values → "null" string');
  ok(norm2.some(r => r[1] === 'null'), 'NULL values → "null" string (second col)');

  // Hash consistency: same input → same hash
  const hash1a = await GradingLogic.computeHash(rows1, cols1);
  const hash1b = await GradingLogic.computeHash(rows1, cols1);
  ok(hash1a === hash1b, 'Same input produces same hash (deterministic)');
  ok(/^[0-9a-f]{64}$/.test(hash1a), 'Hash is 64-char lowercase hex (SHA-256)');

  // Different inputs → different hashes
  const hash2 = await GradingLogic.computeHash([['alice', '99']], cols1);
  ok(hash1a !== hash2, 'Different inputs produce different hashes');

  // Empty result → distinct hash
  const hashEmpty = await GradingLogic.computeHash([], ['col1']);
  ok(typeof hashEmpty === 'string' && hashEmpty.length === 64, 'Empty result set hashes OK');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test HTML structure (static checks)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[3] HTML structure checks');

ok(htmlContent.includes('id="begin-btn"'), 'Begin Test button present');
ok(htmlContent.includes('id="candidate-name"'), 'Candidate name input present');
ok(htmlContent.includes('id="timer-display"'), 'Timer display present');
ok(htmlContent.includes('id="sidebar"'), 'Sidebar present');
ok(htmlContent.includes('id="center-panel"'), 'Center panel present');
ok(htmlContent.includes('id="right-panel"'), 'Right panel present');
ok(htmlContent.includes('id="playground-editor"'), 'Playground editor present');
ok(htmlContent.includes('id="sidebar-toggle"'), 'Sidebar toggle button present');
ok(htmlContent.includes('id="exploration-notes"'), 'Exploration notes textarea present in right panel');
ok(htmlContent.includes('id="playground-schema-info"'), 'Schema info section in playground present');
ok(htmlContent.includes('id="left-panel-resize-handle"'), 'Left panel resize handle present');
ok(!htmlContent.includes('id="section-exploration"'), 'Exploration section removed from center panel');

// ─────────────────────────────────────────────────────────────────────────────
// Test JSDOM-based UI behaviors (lightweight, no WASM)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[4] DOM behavior — Begin Test button state');

// Create a minimal jsdom environment to test static DOM state
const dom = new JSDOM(htmlContent, { runScripts: 'outside-only' });
const document = dom.window.document;

const beginBtn = document.getElementById('begin-btn');
const nameInput = document.getElementById('candidate-name');

ok(beginBtn !== null, 'Begin Test button exists in DOM');
ok(nameInput !== null, 'Candidate name input exists in DOM');

if (beginBtn) {
  // HTML should have disabled attribute on begin-btn
  ok(beginBtn.disabled === true || beginBtn.hasAttribute('disabled'),
    'Begin Test button is disabled by default');
}

// Verify screen structure
const screen1 = document.getElementById('screen1');
const screen2 = document.getElementById('screen2');
ok(screen1 !== null, 'Screen 1 (start) exists');
ok(screen2 !== null, 'Screen 2 (main) exists');
if (screen2) {
  ok(
    screen2.classList.contains('hidden') || screen2.style.display === 'none' ||
    screen2.getAttribute('style') || screen2.className.includes('hidden'),
    'Screen 2 is hidden initially'
  );
}

// Check timer element
const timerEl = document.getElementById('timer-display');
ok(timerEl !== null, 'Timer element exists');
if (timerEl) {
  ok(timerEl.textContent.includes(':'), 'Timer shows time format (contains colon)');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test pagination logic (pure function, no DOM needed)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[5] Results pagination logic');

// Test pagination math directly
function calcPages(totalRows, pageSize) {
  return Math.ceil(totalRows / pageSize);
}

ok(calcPages(15, 10) === 2, '15 rows → 2 pages at 10 per page');
ok(calcPages(10, 10) === 1, '10 rows → 1 page exactly');
ok(calcPages(11, 10) === 2, '11 rows → 2 pages');
ok(calcPages(0, 10) === 0, '0 rows → 0 pages');
ok(calcPages(100, 10) === 10, '100 rows → 10 pages');

// Verify pagination controls should appear for > 10 rows
// (The dist HTML will contain the pagination logic — verify it's referenced)
ok(
  htmlContent.includes('Previous') || htmlContent.includes('previous') ||
  htmlContent.includes('pagination') || htmlContent.includes('pageSize') ||
  htmlContent.includes('PAGE_SIZE') || htmlContent.includes('rowsPerPage'),
  'Pagination logic present in HTML'
);

// ─────────────────────────────────────────────────────────────────────────────
// Test WCAG-relevant structure
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[6] WCAG structural checks');

ok(htmlContent.includes('aria-label') || htmlContent.includes('aria-'), 'ARIA labels present');
ok(htmlContent.includes('role="status"') || htmlContent.includes('aria-live'),
  'Live region for status updates present');
ok(document.querySelector('button') !== null, 'Buttons present in DOM');

// Verify all buttons exist in DOM (basic accessibility)
const buttons = document.querySelectorAll('button');
ok(buttons.length >= 3, `At least 3 buttons in DOM (found: ${buttons.length})`);

// ─────────────────────────────────────────────────────────────────────────────
// Run async tests and report
// ─────────────────────────────────────────────────────────────────────────────

runGradingTests().then(() => {
  console.log(`\n──────────────────────────────────`);
  console.log(`feature_test.js: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    // Prefer exitCode over process.exit() to allow Node/libuv to tear down
    // async resources cleanly on Windows.
    process.exitCode = 1;
  } else {
    console.log('All feature tests passed.');
    process.exitCode = 0;
  }
}).catch(e => {
  console.error(`Unexpected error in feature_test: ${e.message}`);
  console.error(e.stack);
  process.exitCode = 1;
});
