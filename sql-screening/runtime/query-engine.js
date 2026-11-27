(function (root) {
  'use strict';

  function leadingSQL(sql) {
    return sql.replace(/^(?:\s+|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/, '');
  }

  function createExecutor(SQL, bytes) {
    var database = new SQL.Database(bytes);
    function execute(sql, options) {
      options = options || {};
      var rowLimit = options.graded ? 50000 : 500;
      var result = { rows: [], columns: [], truncated: false, setup: [] };
      var statements = 0;
      var size = 0;
      database.run('SAVEPOINT candidate_query');
      try {
        for (var statement of database.iterateStatements(sql)) {
          try {
            var source = statement.getSQL();
            var leading = leadingSQL(source);
            var temporary = /^CREATE\s+(?:TEMP|TEMPORARY)\s+TABLE\b/i.test(leading);
            if (!/^(?:SELECT|WITH)\b/i.test(leading) && !temporary) {
              throw new Error('Only SELECT, WITH and CREATE TEMP TABLE statements are permitted.');
            }
            var plan = database.exec('EXPLAIN ' + source)[0];
            if (!plan) throw new Error('Unable to validate SQL.');
            plan.values.forEach(function (instruction) {
              var opcode = instruction[1];
              if ((opcode === 'Transaction' && instruction[2] !== 1 && instruction[3] !== 0) ||
                  (opcode === 'OpenWrite' && instruction[4] !== 1) ||
                  /^(?:VUpdate|VCreate|VDestroy|Vacuum|JournalMode|Checkpoint)$/.test(opcode) ||
                  /(?:load_extension|sqlite_attach|sqlite_detach)/i.test(String(instruction[5]))) {
                throw new Error('Assessment tables are read-only. Use a temporary table for intermediate work.');
              }
            });
            var columns = statement.getColumnNames();
            var rows = [];
            var truncated = false;
            while (statement.step()) {
              if (rows.length >= rowLimit) {
                if (options.graded) throw new Error('Result exceeds the 50,000-row grading limit. Narrow the query and run again.');
                truncated = true;
                break;
              }
              var row = statement.get();
              size += JSON.stringify(row).length;
              if (size > 4000000) throw new Error('Result exceeds the 4 MB execution limit. Select fewer rows or columns.');
              rows.push(row);
            }
            if (columns.length) {
              result.rows = rows;
              result.columns = columns;
              result.truncated = truncated;
            }
            if (temporary) result.setup.push(source);
            statements++;
          } finally {
            statement.free();
          }
        }
        if (!statements) throw new Error('Enter a SQL statement first.');
        database.run('RELEASE candidate_query');
        return result;
      } catch (error) {
        database.run('ROLLBACK TO candidate_query; RELEASE candidate_query');
        throw error;
      }
    }
    return { execute: execute, close: function () { database.close(); } };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createExecutor: createExecutor };
  } else {
    var executor;
    root.onmessage = async function (event) {
      var message = event.data;
      try {
        if (message.type === 'init') {
          var SQL = await initSqlJs({ wasmBinary: message.wasm });
          executor = createExecutor(SQL, message.database);
          for (var source of message.setup || []) executor.execute(source);
          root.postMessage({ id: message.id, result: true });
        } else {
          var started = performance.now();
          var result = executor.execute(message.sql, message.options);
          result.durationMs = Math.round(performance.now() - started);
          root.postMessage({ id: message.id, result: result });
        }
      } catch (error) {
        root.postMessage({ id: message.id, error: error.message });
      }
    };
  }
}(typeof self !== 'undefined' ? self : globalThis));