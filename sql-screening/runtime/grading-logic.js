(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('node:crypto'));
  } else {
    root.GradingLogic = factory(null);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (nodeCrypto) {

  function normalizeRows(rows, expectedColumns, options) {
    options = options || {};
    var extracted = rows.map(function (row) {
      var values = Array.isArray(row) ? row : Object.values(row);
      if (values.length !== expectedColumns.length) {
        throw new Error('Expected ' + expectedColumns.length + ' columns; received ' + values.length + '.');
      }
      return values.map(function (value) {
        if (value === null) return ['null'];
        if (typeof value === 'number') {
          if (!Number.isFinite(value)) throw new Error('Non-finite numeric result.');
          if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error('Integer exceeds browser precision; return it as text.');
          if (options.decimalPlaces !== undefined) {
            var scale = Math.pow(10, options.decimalPlaces);
            value = Math.sign(value) * Math.floor(Math.abs(value) * scale + 0.5) / scale;
          }
          var buffer = new ArrayBuffer(8);
          new DataView(buffer).setFloat64(0, value === 0 ? 0 : value);
          return ['number', Array.from(new Uint8Array(buffer), function (byte) { return byte.toString(16).padStart(2, '0'); }).join('')];
        }
        var text = String(value);
        return ['text', options.caseSensitive ? text : text.toLowerCase()];
      });
    });
    if (!options.orderSensitive) extracted.sort(function (a, b) {
      var sa = JSON.stringify(a);
      var sb = JSON.stringify(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    return extracted;
  }

  function serializeForHash(rows, expectedColumns, options) {
    return JSON.stringify(normalizeRows(rows, expectedColumns, options));
  }

  function hashNode(rows, expectedColumns, options) {
    var payload = serializeForHash(rows, expectedColumns, options);
    return nodeCrypto.createHash('sha256').update(payload, 'utf8').digest('hex');
  }

  function hashBrowser(rows, expectedColumns, options) {
    var payload = serializeForHash(rows, expectedColumns, options);
    var bytes = new TextEncoder().encode(payload);
    return crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
      return Array.from(new Uint8Array(buf))
        .map(function (b) { return b.toString(16).padStart(2, '0'); })
        .join('');
    });
  }

  function computeHash(rows, expectedColumns, options) {
    if (nodeCrypto) {
      return Promise.resolve(hashNode(rows, expectedColumns, options));
    }
    return hashBrowser(rows, expectedColumns, options);
  }

  return {
    normalizeRows: normalizeRows,
    serializeForHash: serializeForHash,
    computeHash: computeHash
  };
}));
