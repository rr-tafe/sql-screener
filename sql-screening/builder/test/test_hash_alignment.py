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


def py_normalize_and_hash(rows, expected_columns):
    """Canonical normalization + SHA-256 — mirrors builder.py and grading-logic.js."""
    extracted = []
    for row in rows:
        if isinstance(row, (list, tuple)):
            vals = list(row)
        else:
            vals = list(row.values())
        norm_row = []
        for idx in range(len(expected_columns)):
            v = vals[idx] if idx < len(vals) else None
            if v is None:
                norm_row.append('null')
            elif isinstance(v, float) and v == int(v):
                norm_row.append(str(int(v)))
            else:
                norm_row.append(str(v))
        extracted.append(norm_row)
    extracted.sort(key=lambda r: json.dumps(r, separators=(',', ':'), ensure_ascii=False))
    payload = json.dumps(extracted, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def js_hash(rows, expected_columns):
    """Call grading-logic.js via Node.js and capture the hex hash."""
    rows_json = json.dumps(rows)
    cols_json = json.dumps(expected_columns)
    script = f"""
const g = require({json.dumps(GRADING_JS)});
const rows = {rows_json};
const cols = {cols_json};
g.computeHash(rows, cols).then(function(h) {{
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

    for case in TEST_CASES:
        name = case['name']
        rows = case['rows']
        cols = case['cols']

        py_hash = py_normalize_and_hash(rows, cols)
        try:
            js_h = js_hash(rows, cols)
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
