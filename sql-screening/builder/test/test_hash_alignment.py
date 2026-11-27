#!/usr/bin/env python3
"""
test_hash_alignment.py — Verify Python hash == JS grading-logic.js hash
for a shared set of test cases.

Usage: python builder/test/test_hash_alignment.py
"""

import sys
import os
import json
import hashlib
import subprocess

BUILDER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.dirname(BUILDER_DIR)
RUNTIME_DIR = os.path.join(REPO_ROOT, 'runtime')
GRADING_JS = os.path.join(RUNTIME_DIR, 'grading-logic.js')


sys.path.insert(0, BUILDER_DIR)
from builder import normalize_and_hash as py_normalize_and_hash


def js_hash(rows, expected_columns, options=None):
    """Call grading-logic.js via Node.js and capture the hex hash."""
    rows_json = json.dumps(rows)
    cols_json = json.dumps(expected_columns)
    script = f"""
const g = require({json.dumps(GRADING_JS)});
const rows = {rows_json};
const cols = {cols_json};
g.computeHash(rows, cols, {json.dumps(options or {})}).then(function(h) {{
  process.stdout.write(h);
}}).catch(function(e) {{
  process.stderr.write(String(e));
  process.exit(1);
}});
"""
    result = subprocess.run(
        ['node', '-e', script],
        capture_output=True, text=True, timeout=15
    )
    if result.returncode != 0:
        raise RuntimeError(f"Node.js error: {result.stderr}")
    return result.stdout.strip()


TEST_CASES = [
    {'name': 'adjacent precise numbers', 'rows': [[1234567890123456], [1234567890123457], [0.1], [1e-10]], 'cols': ['value']},
    {'name': 'typed NULL, text and numbers', 'rows': [[None], ['null'], [1], ['1'], [1.25], [-0.0]], 'cols': ['value']},
    {'name': 'case and astral sorting', 'rows': [['HELLO'], ['\U0001f600'], ['\ue000']], 'cols': ['value']},
    {'name': 'explicit precision', 'rows': [[1.234], [-1.236]], 'cols': ['value'], 'options': {'decimalPlaces': 2}},
    {'name': 'ordered and case-sensitive', 'rows': [['Z'], ['a']], 'cols': ['value'], 'options': {'orderSensitive': True, 'caseSensitive': True}},
    {
        'name': 'multi-row result',
        'rows': [['alice', '42'], ['bob', '100']],
        'cols': ['name', 'amount'],
    },
    {
        'name': 'single row',
        'rows': [['carol', '7']],
        'cols': ['name', 'count'],
    },
    {
        'name': 'empty result set',
        'rows': [],
        'cols': ['id', 'value'],
    },
    {
        'name': 'result with NULL values',
        'rows': [['dave', None], [None, '5']],
        'cols': ['name', 'score'],
    },
    {
        'name': 'result with Unicode characters',
        'rows': [['München', '€200'], ['東京', '¥1500']],
        'cols': ['city', 'spend'],
    },
    {
        'name': 'mixed column counts — three columns',
        'rows': [['x', '1', 'a'], ['y', '2', 'b'], ['z', '3', 'c']],
        'cols': ['col1', 'col2', 'col3'],
    },
    {
        'name': 'rows in unsorted order (must sort before hashing)',
        'rows': [['z', '3'], ['a', '1'], ['m', '2']],
        'cols': ['letter', 'num'],
    },
    {
        'name': 'numeric values as strings',
        'rows': [['100'], ['20'], ['3']],
        'cols': ['amount'],
    },
]


def run_tests():
    if not os.path.isfile(GRADING_JS):
        print(f"FAIL: grading-logic.js not found at {GRADING_JS}", file=sys.stderr)
        sys.exit(1)

    passed = 0
    failed = 0

    assert py_normalize_and_hash([[None]], ['value']) != py_normalize_and_hash([['null']], ['value'])
    assert py_normalize_and_hash([[1234567890123456]], ['value']) != py_normalize_and_hash([[1234567890123457]], ['value'])
    try:
        py_normalize_and_hash([[1, 2]], ['value'])
        raise AssertionError('Extra columns were accepted')
    except ValueError:
        pass

    for case in TEST_CASES:
        name = case['name']
        rows = case['rows']
        cols = case['cols']

        py_hash = py_normalize_and_hash(rows, cols, case.get('options'))
        try:
            js_h = js_hash(rows, cols, case.get('options'))
        except Exception as e:
            print(f"FAIL [{name}]: JS execution error — {e}")
            failed += 1
            continue

        if py_hash == js_h:
            print(f"PASS [{name}]: {py_hash[:12]}…")
            passed += 1
        else:
            print(f"FAIL [{name}]:")
            print(f"     Python: {py_hash}")
            print(f"     JS:     {js_h}")
            failed += 1

    print()
    print(f"Results: {passed} passed, {failed} failed out of {len(TEST_CASES)} tests")

    if failed > 0:
        sys.exit(1)
    else:
        print("All hash alignment tests passed.")
        sys.exit(0)


if __name__ == '__main__':
    run_tests()
