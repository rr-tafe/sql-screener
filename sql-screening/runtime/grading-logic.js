(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('node:crypto'));
  } else {
    root.GradingLogic = factory(null);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (nodeCrypto) {

  function normalizeRows(rows, expectedColumns) {
    var extracted = rows.map(function (row) {
      return expectedColumns.map(function (_, idx) {
        var vals = Array.isArray(row) ? row : Object.values(row);
        var v = vals[idx];
        var s = (v === null || v === undefined) ? 'null' : String(v);
        return isNaN(s) ? s.toLowerCase() : s;
      });
    });
    extracted.sort(function (a, b) {
      var sa = JSON.stringify(a);
      var sb = JSON.stringify(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    return extracted;
  }

  function serializeForHash(rows, expectedColumns) {
    return JSON.stringify(normalizeRows(rows, expectedColumns));
  }

  function hashNode(rows, expectedColumns) {
    var payload = serializeForHash(rows, expectedColumns);
    return nodeCrypto.createHash('sha256').update(payload, 'utf8').digest('hex');
  }

  function hashBrowser(rows, expectedColumns) {
    var payload = serializeForHash(rows, expectedColumns);
    var bytes = new TextEncoder().encode(payload);
    return crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
      return Array.from(new Uint8Array(buf))
        .map(function (b) { return b.toString(16).padStart(2, '0'); })
        .join('');
    });
  }

  function computeHash(rows, expectedColumns) {
    if (nodeCrypto) {
      return Promise.resolve(hashNode(rows, expectedColumns));
    }
    return hashBrowser(rows, expectedColumns);
  }

  return {
    normalizeRows: normalizeRows,
    serializeForHash: serializeForHash,
    computeHash: computeHash
  };
}));
