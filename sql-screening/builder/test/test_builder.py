#!/usr/bin/env python3
"""
test_builder.py — Builder validation gate tests.
Tests structural validation, engine gate, count gate, and solution gate.

Usage: python builder/test/test_builder.py
"""

import sys
import os
import re
import json
import shutil
import subprocess
import tempfile

BUILDER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.dirname(BUILDER_DIR)
BUILDER_PY = os.path.join(BUILDER_DIR, 'builder.py')
MODULE_DIR = os.path.join(REPO_ROOT, 'modules', 'banking-incentive-campaigns')
DIST_DIR = os.path.join(REPO_ROOT, 'dist')
MODULE_ID = 'banking-incentive-campaigns'
DIST_HTML = os.path.join(DIST_DIR, f'{MODULE_ID}.html')


def run_builder():
    result = subprocess.run(
        [sys.executable, BUILDER_PY, f'--module={MODULE_DIR}'],
        capture_output=True, text=True, cwd=REPO_ROOT
    )
    return result


def dist_html_exists():
    return os.path.isfile(DIST_HTML)


def cleanup_dist():
    if os.path.isfile(DIST_HTML):
        os.remove(DIST_HTML)


passed = 0
failed = 0


def test(name, fn):
    global passed, failed
    try:
        fn()
        print(f"PASS [{name}]")
        passed += 1
    except AssertionError as e:
        print(f"FAIL [{name}]: {e}")
        failed += 1
    except Exception as e:
        print(f"FAIL [{name}]: unexpected exception — {e}")
        failed += 1


# ─────────────────────────────────────────────────────────────────────────────
# Test 1: Missing file gate
# ─────────────────────────────────────────────────────────────────────────────

def test_missing_file():
    questions_path = os.path.join(MODULE_DIR, 'questions.json')
    bak_path = questions_path + '.bak'
    cleanup_dist()
    try:
        shutil.move(questions_path, bak_path)
        result = run_builder()
        assert result.returncode != 0, "Expected non-zero exit when questions.json missing"
        stderr = result.stderr + result.stdout
        assert 'questions.json' in stderr.lower() or 'missing' in stderr.lower(), \
            f"Expected error mentioning questions.json, got: {stderr[:300]}"
        assert not dist_html_exists(), "No dist HTML should be written on validation failure"
    finally:
        if os.path.isfile(bak_path):
            shutil.move(bak_path, questions_path)

test("missing file gate (questions.json)", test_missing_file)


# ─────────────────────────────────────────────────────────────────────────────
# Test 2: Engine rejection gate
# ─────────────────────────────────────────────────────────────────────────────

def test_engine_rejection():
    module_json_path = os.path.join(MODULE_DIR, 'module.json')
    with open(module_json_path, 'r') as f:
        original = f.read()
    original_data = json.loads(original)
    modified = dict(original_data, engine='duckdb')
    cleanup_dist()
    try:
        with open(module_json_path, 'w') as f:
            json.dump(modified, f)
        result = run_builder()
        assert result.returncode != 0, "Expected non-zero exit for unsupported engine"
        stderr = result.stderr + result.stdout
        assert 'duckdb' in stderr.lower() or 'engine' in stderr.lower(), \
            f"Expected error mentioning engine value, got: {stderr[:300]}"
        assert not dist_html_exists(), "No dist HTML should be written on engine rejection"
    finally:
        with open(module_json_path, 'w') as f:
            f.write(original)

test("engine rejection gate (duckdb)", test_engine_rejection)


# ─────────────────────────────────────────────────────────────────────────────
# Test 3: Question count mismatch gate
# ─────────────────────────────────────────────────────────────────────────────

def test_question_count():
    module_json_path = os.path.join(MODULE_DIR, 'module.json')
    with open(module_json_path, 'r') as f:
        original = f.read()
    original_data = json.loads(original)
    modified = dict(original_data, questionCount=999)
    cleanup_dist()
    try:
        with open(module_json_path, 'w') as f:
            json.dump(modified, f)
        result = run_builder()
        assert result.returncode != 0, "Expected non-zero exit for count mismatch"
        stderr = result.stderr + result.stdout
        assert '999' in stderr or 'count' in stderr.lower() or 'mismatch' in stderr.lower(), \
            f"Expected error mentioning count mismatch, got: {stderr[:300]}"
        assert not dist_html_exists(), "No dist HTML should be written on count mismatch"
    finally:
        with open(module_json_path, 'w') as f:
            f.write(original)

test("question count mismatch gate (999)", test_question_count)


# ─────────────────────────────────────────────────────────────────────────────
# Test 4: Corrupt solution validation gate
# ─────────────────────────────────────────────────────────────────────────────

def test_corrupt_solution():
    solutions_path = os.path.join(MODULE_DIR, 'solutions.sql')
    with open(solutions_path, 'r') as f:
        original = f.read()
    # Replace q1 solution with SQL that references a nonexistent table.
    # This causes an sqlite3 exception (ERROR state) which the builder must detect.
    corrupted = re.sub(
        r'(-- q1\s*\n)([\s\S]*?)(\n-- q2)',
        r'\1SELECT * FROM table_that_does_not_exist_xyz;\3',
        original
    )
    assert corrupted != original, "Corruption replacement did not change solutions.sql"
    cleanup_dist()
    try:
        with open(solutions_path, 'w') as f:
            f.write(corrupted)
        result = run_builder()
        assert result.returncode != 0, "Expected non-zero exit for corrupt solution"
        stderr = result.stderr + result.stdout
        assert 'q1' in stderr.lower() or 'error' in stderr.lower() or 'exception' in stderr.lower(), \
            f"Expected error mentioning q1 failure, got: {stderr[:300]}"
        assert not dist_html_exists(), "No dist HTML should be written on solution failure"
    finally:
        with open(solutions_path, 'w') as f:
            f.write(original)

test("corrupt solution validation gate (q1)", test_corrupt_solution)


# ─────────────────────────────────────────────────────────────────────────────
# Test 5: Missing CSV data gate
# ─────────────────────────────────────────────────────────────────────────────

def test_missing_csv():
    data_dir = os.path.join(MODULE_DIR, 'data')
    bak_dir = data_dir + '_bak'
    cleanup_dist()
    try:
        shutil.move(data_dir, bak_dir)
        result = run_builder()
        assert result.returncode != 0, "Expected non-zero exit when data/ dir missing"
        stderr = result.stderr + result.stdout
        assert 'csv' in stderr.lower() or 'missing' in stderr.lower() or 'data' in stderr.lower(), \
            f"Expected error mentioning missing CSV, got: {stderr[:300]}"
        assert not dist_html_exists(), "No dist HTML should be written when CSVs missing"
    finally:
        if os.path.isdir(bak_dir):
            shutil.move(bak_dir, data_dir)

test("missing CSV data gate", test_missing_csv)


# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────

print()
print(f"Results: {passed} passed, {failed} failed out of {passed + failed} tests")
if failed > 0:
    sys.exit(1)
else:
    print("All builder tests passed.")
    sys.exit(0)
