(function () {
  'use strict';

  // ============================================================
  // SQL Guard — classify before ANY query reaches the engine
  // Rule 2 (TEMP TABLE) checked before any general CREATE check.
  // ============================================================
  function classify(sqlStr) {
    var s = sqlStr.trim().replace(/\s+/g, ' ');
    if (/^SELECT\b/i.test(s)) return 'ALLOWED';
    if (/^WITH\s+(RECURSIVE\s+)?\w/i.test(s)) return 'ALLOWED';
    if (/CREATE\s+(TEMP|TEMPORARY)\s+TABLE/i.test(s)) return 'ALLOWED';
    return 'BLOCKED';
  }

  // ============================================================
  // Base64 → Uint8Array helper (works for large strings)
  // ============================================================
  function base64ToUint8Array(b64) {
    var binary = atob(b64);
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  // ============================================================
  // Module-level state
  // ============================================================
  var db = null;                    // sql.js Database instance
  var startTime = null;             // Date when test started
  var timerInterval = null;         // setInterval handle
  var candidateName = '';
  var queryHistory = [];            // Playground query history (deduped, all allowed)
  var playgroundSuccessHistory = []; // Playground successful (non-error) queries only
  var questionStatuses = {};        // { q1: 'pass'|'fail'|'error'|'not-permitted'|null }
  var editors = {};                 // { exploration, playground, q1, q2, ... }
  var schema = null;                // SQL_SCHEMA_JSON

  // ============================================================
  // DOM ready
  // ============================================================
  document.addEventListener('DOMContentLoaded', function () {

    // Grab globals set by the inline <script> block in template.html
    var questions      = typeof QUESTIONS_JSON      !== 'undefined' ? QUESTIONS_JSON      : [];
    var answerHashes   = typeof ANSWER_HASHES_JSON  !== 'undefined' ? ANSWER_HASHES_JSON  : {};

    schema             = typeof SQL_SCHEMA_JSON      !== 'undefined' ? SQL_SCHEMA_JSON      : { tables: {} };
    var moduleTitle    = typeof MODULE_TITLE         !== 'undefined' ? MODULE_TITLE         : 'SQL Assessment';
    var moduleVersion  = typeof MODULE_VERSION       !== 'undefined' ? MODULE_VERSION       : '';
    var moduleDesc     = typeof MODULE_DESCRIPTION   !== 'undefined' ? MODULE_DESCRIPTION   : '';
    var wasmB64        = typeof SQL_JS_WASM_B64      !== 'undefined' ? SQL_JS_WASM_B64      : '';
    var dbB64          = typeof DATASET_DB_B64       !== 'undefined' ? DATASET_DB_B64       : '';

    // Initialize question statuses
    questions.forEach(function (q) {
      questionStatuses[q.id] = null;
    });

    // ----------------------------------------------------------
    // Screen 1 — Name input card
    // ----------------------------------------------------------
    document.getElementById('module-title-heading').textContent = moduleTitle;
    document.getElementById('module-description').textContent   = moduleDesc;

    var nameInput  = document.getElementById('candidate-name');
    var beginBtn   = document.getElementById('begin-btn');

    function updateBeginBtn() {
      beginBtn.disabled = nameInput.value.trim().length === 0;
    }

    nameInput.addEventListener('input', updateBeginBtn);
    nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !beginBtn.disabled) {
        beginBtn.click();
      }
    });

    updateBeginBtn();

    beginBtn.addEventListener('click', function () {
      candidateName = nameInput.value.trim();
      startTest(questions, answerHashes, moduleTitle, moduleVersion, wasmB64, dbB64, moduleDesc);
    });
  });

  // ============================================================
  // startTest — hide Screen 1, show Screen 2, init everything
  // ============================================================
  function startTest(questions, answerHashes, moduleTitle, moduleVersion, wasmB64, dbB64, moduleDesc) {
    document.getElementById('screen1').classList.add('hidden');
    document.getElementById('screen2').classList.remove('hidden');

    // Show candidate name in sidebar
    var nameDisplay = document.getElementById('sidebar-candidate-name');
    if (nameDisplay) nameDisplay.textContent = candidateName;

    startTime = new Date();
    startTimer();

    // Async DB init then wire up UI
    initDatabase(wasmB64, dbB64).then(function (database) {
      db = database;
      buildUI(questions, answerHashes, moduleTitle, moduleVersion, moduleDesc);
    }).catch(function (err) {
      console.error('Failed to initialize sql.js database:', err);
      // Still build UI — queries will error gracefully
      buildUI(questions, answerHashes, moduleTitle, moduleVersion, moduleDesc);
    });
  }

  // ============================================================
  // Timer
  // ============================================================
  function startTimer() {
    var display = document.getElementById('timer-display');
    timerInterval = setInterval(function () {
      var elapsed = Math.floor((Date.now() - startTime.getTime()) / 1000);
      var h = Math.floor(elapsed / 3600);
      var m = Math.floor((elapsed % 3600) / 60);
      var s = elapsed % 60;
      display.textContent =
        String(h).padStart(2, '0') + ':' +
        String(m).padStart(2, '0') + ':' +
        String(s).padStart(2, '0');
    }, 1000);
  }

  function getElapsedString() {
    if (!startTime) return '00:00:00';
    var elapsed = Math.floor((Date.now() - startTime.getTime()) / 1000);
    var h = Math.floor(elapsed / 3600);
    var m = Math.floor((elapsed % 3600) / 60);
    var s = elapsed % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  // ============================================================
  // sql.js initialization
  // ============================================================
  function initDatabase(wasmB64, dbB64) {
    var wasmBinary = base64ToUint8Array(wasmB64);
    return CMEditor.initSqlJs({ wasmBinary: wasmBinary }).then(function (SQL) {
      var dbBytes = base64ToUint8Array(dbB64);
      return new SQL.Database(dbBytes);
    });
  }

  // ============================================================
  // Build the main UI (Screen 2)
  // ============================================================
  function buildUI(questions, answerHashes, moduleTitle, moduleVersion, moduleDesc) {
    buildSidebarNav(questions);
    buildQuestionSections(questions);
    buildExplorationSchemaInfo(moduleDesc);
    mountEditors(questions);
    wireButtons(questions, answerHashes);
    wireSidebarCollapse();
    wireResizeHandle();
    wireLeftResizeHandle();
    wireBottomButtons(questions, moduleTitle, moduleVersion);
    wireFnRefSection();
    wireQueryHistory();
    wireThemeToggle();
  }

  // ============================================================
  // Sidebar nav — Q1..QN
  // ============================================================
  function buildSidebarNav(questions) {
    var nav = document.querySelector('.sidebar-nav');

    questions.forEach(function (q, idx) {
      var a = document.createElement('a');
      a.href = '#section-' + q.id;
      a.className = 'nav-link';
      a.setAttribute('data-section', q.id);
      a.setAttribute('data-qnum', 'Q' + (idx + 1));

      var dot = document.createElement('span');
      dot.className = 'nav-dot';
      dot.setAttribute('data-section-dot', q.id);

      var label = document.createElement('span');
      label.className = 'nav-label';
      label.textContent = 'Q' + (idx + 1);

      a.appendChild(dot);
      a.appendChild(label);
      nav.appendChild(a);

      a.addEventListener('click', function (e) {
        e.preventDefault();
        var target = document.getElementById('section-' + q.id);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });

    // Create pinned action buttons at bottom of sidebar
    var sidebarContent = document.querySelector('.sidebar-content');
    var bottomDiv = document.createElement('div');
    bottomDiv.className = 'sidebar-bottom';

    var finishBtn = document.createElement('button');
    finishBtn.id = 'finish-work-btn';
    finishBtn.className = 'btn-finish-work';
    finishBtn.textContent = 'Finish Work';

    bottomDiv.appendChild(finishBtn);
    sidebarContent.appendChild(bottomDiv);
  }

  // ============================================================
  // Question sections in center panel
  // ============================================================
  function buildQuestionSections(questions) {
    var container = document.getElementById('questions-container');

    questions.forEach(function (q, idx) {
      var section = document.createElement('section');
      section.id = 'section-' + q.id;
      section.className = 'content-section';

      var meta = document.createElement('div');
      meta.className = 'question-meta';

      var numSpan = document.createElement('span');
      numSpan.className = 'question-number';
      numSpan.textContent = 'Question ' + (idx + 1);
      meta.appendChild(numSpan);

      if (q.difficulty) {
        var diffSpan = document.createElement('span');
        diffSpan.className = 'difficulty-badge difficulty-' + q.difficulty;
        diffSpan.textContent = q.difficulty;
        meta.appendChild(diffSpan);
      }

      var prompt = document.createElement('p');
      prompt.className = 'question-prompt';
      prompt.textContent = q.prompt;

      var colsDiv = document.createElement('div');
      colsDiv.className = 'expected-columns';
      colsDiv.innerHTML = 'Expected columns: ' +
        q.expectedColumns.map(function (c) {
          return '<code>' + escapeHtml(c) + '</code>';
        }).join(' ');

      var editorBlock = document.createElement('div');
      editorBlock.className = 'editor-block';

      var editorContainer = document.createElement('div');
      editorContainer.id = 'editor-' + q.id;
      editorContainer.className = 'cm-editor-container';
      editorContainer.setAttribute('aria-label', 'SQL editor for question ' + (idx + 1));

      var editorButtons = document.createElement('div');
      editorButtons.className = 'editor-buttons';

      var runBtn = document.createElement('button');
      runBtn.className = 'btn-run';
      runBtn.setAttribute('data-context', q.id);
      runBtn.setAttribute('aria-label', 'Run query for question ' + (idx + 1));
      runBtn.textContent = 'Run';

      var fmtBtn = document.createElement('button');
      fmtBtn.className = 'btn-format';
      fmtBtn.setAttribute('data-context', q.id);
      fmtBtn.setAttribute('aria-label', 'Format SQL for question ' + (idx + 1));
      fmtBtn.textContent = 'Format';

      editorButtons.appendChild(runBtn);
      editorButtons.appendChild(fmtBtn);

      var statusArea = document.createElement('div');
      statusArea.id = 'status-' + q.id;
      statusArea.className = 'status-area';
      statusArea.setAttribute('role', 'status');
      statusArea.setAttribute('aria-live', 'polite');

      var resultsArea = document.createElement('div');
      resultsArea.id = 'results-' + q.id;
      resultsArea.className = 'results-area';

      editorBlock.appendChild(editorContainer);
      editorBlock.appendChild(editorButtons);
      editorBlock.appendChild(statusArea);
      editorBlock.appendChild(resultsArea);

      section.appendChild(meta);
      section.appendChild(prompt);
      section.appendChild(colsDiv);
      section.appendChild(editorBlock);

      container.appendChild(section);
    });
  }

  // ============================================================
  // Mount CodeMirror editors
  // ============================================================
  function mountEditors(questions) {
    // Question editors
    questions.forEach(function (q) {
      var container = document.getElementById('editor-' + q.id);
      editors[q.id] = CMEditor.createEditor(container, {
        schema: schema,
      });
    });

    // Playground editor
    var playgroundContainer = document.getElementById('playground-editor');
    editors['playground'] = CMEditor.createEditor(playgroundContainer, {
      schema: schema,
    });
  }

  // ============================================================
  // Wire Run / Format buttons
  // ============================================================
  function wireButtons(questions, answerHashes) {
    // Playground Run
    document.querySelector('.btn-run[data-context="playground"]')
      .addEventListener('click', function () {
        runPlayground();
      });

    // Playground Format
    document.querySelector('.btn-format[data-context="playground"]')
      .addEventListener('click', function () {
        editors['playground'].format();
      });

    // Question Run / Format
    questions.forEach(function (q) {
      document.querySelector('.btn-run[data-context="' + q.id + '"]')
        .addEventListener('click', function () {
          runGraded(q, answerHashes);
        });

      document.querySelector('.btn-format[data-context="' + q.id + '"]')
        .addEventListener('click', function () {
          editors[q.id].format();
        });
    });
  }

  // ============================================================
  // Execute SQL against the db
  // Returns { rows, columns } or throws.
  // ============================================================
  function execSQL(sqlStr) {
    if (!db) {
      throw new Error('Database not yet initialized.');
    }
    var results = db.exec(sqlStr);
    if (!results || results.length === 0) {
      return { columns: [], rows: [] };
    }
    var first = results[0];
    return { columns: first.columns, rows: first.values };
  }

  // ============================================================
  // Playground runner
  // ============================================================
  function runPlayground() {
    var sqlStr    = editors['playground'].getContent().trim();
    var statusEl  = document.getElementById('playground-status');
    var resultsEl = document.getElementById('playground-results');

    if (!sqlStr) return;

    var cls = classify(sqlStr);
    if (cls === 'BLOCKED') {
      clearResults(resultsEl);
      showBadge(statusEl, 'not-permitted', 'NOT PERMITTED');
      return;  // Do NOT add to history
    }

    clearStatus(statusEl);
    try {
      var result = execSQL(sqlStr);
      renderResultsTable(resultsEl, result.rows, result.columns);
      if (queryHistory.indexOf(sqlStr) === -1) {
        queryHistory.push(sqlStr);
      }
      // Track successful (non-error) queries separately for export
      if (playgroundSuccessHistory.indexOf(sqlStr) === -1) {
        playgroundSuccessHistory.push(sqlStr);
      }
      updateQueryHistory();
    } catch (err) {
      clearResults(resultsEl);
      showBadge(statusEl, 'error', 'ERROR: ' + err.message);
      // Add to general history but NOT to success history
      if (queryHistory.indexOf(sqlStr) === -1) {
        queryHistory.push(sqlStr);
      }
    }
  }

  // ============================================================
  // Graded question runner
  // ============================================================
  function runGraded(q, answerHashes) {
    var sqlStr    = editors[q.id].getContent().trim();
    var statusEl  = document.getElementById('status-' + q.id);
    var resultsEl = document.getElementById('results-' + q.id);

    if (!sqlStr) return;

    var cls = classify(sqlStr);
    if (cls === 'BLOCKED') {
      clearResults(resultsEl);
      showBadge(statusEl, 'not-permitted', 'NOT PERMITTED');
      updateNavDot(q.id, 'not-permitted');
      questionStatuses[q.id] = 'not-permitted';
      return;
    }

    clearStatus(statusEl);
    var result;
    try {
      result = execSQL(sqlStr);
    } catch (err) {
      clearResults(resultsEl);
      showBadge(statusEl, 'error', 'ERROR: ' + err.message);
      updateNavDot(q.id, 'error');
      questionStatuses[q.id] = 'error';
      return;
    }

    renderResultsTable(resultsEl, result.rows, result.columns);

    // Grade via GradingLogic
    GradingLogic.computeHash(result.rows, q.expectedColumns).then(function (hash) {
      var expected = answerHashes[q.id];
      if (hash === expected) {
        showBadge(statusEl, 'pass', 'PASS');
        updateNavDot(q.id, 'pass');
        questionStatuses[q.id] = 'pass';
      } else {
        showBadge(statusEl, 'fail', 'FAIL');
        updateNavDot(q.id, 'fail');
        questionStatuses[q.id] = 'fail';
      }
    }).catch(function (err) {
      showBadge(statusEl, 'error', 'ERROR: ' + err.message);
      updateNavDot(q.id, 'error');
      questionStatuses[q.id] = 'error';
    });
  }

  // ============================================================
  // Right panel schema section — table + column reference
  // ============================================================
  function buildExplorationSchemaInfo(moduleDesc) {
    var container = document.getElementById('playground-schema-info');
    if (!container) return;

    var tables = schema && schema.tables ? Object.keys(schema.tables) : [];

    var html = '';
    if (moduleDesc) {
      html += '<p class="schema-intro">' + escapeHtml(moduleDesc) + '</p>';
    }
    if (tables.length > 0) {
      html += '<div class="schema-tables-list">';
      tables.forEach(function (tableName) {
        var cols = schema.tables[tableName] || [];
        html += '<div class="schema-table-item">';
        html += '<span class="schema-table-name">' + escapeHtml(tableName) + '</span>';
        html += '<span class="schema-table-cols">';
        cols.forEach(function (c) {
          html += '<code>' + escapeHtml(c) + '</code>';
        });
        html += '</span></div>';
      });
      html += '</div>';
    }

    container.innerHTML = html;

    // Wire the collapse toggle
    var toggleBtn = document.getElementById('schema-toggle-btn');
    var section   = document.getElementById('playground-schema-section');
    if (toggleBtn && section) {
      toggleBtn.addEventListener('click', function () {
        var collapsed = section.classList.toggle('collapsed');
        toggleBtn.innerHTML = collapsed ? '&#9660;' : '&#9650;';
        toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      });
    }
  }

  // ============================================================
  // Resizable panel handle between center and right panels
  // ============================================================
  function wireResizeHandle() {
    var handle = document.getElementById('panel-resize-handle');
    var screenMain = document.querySelector('.screen-main');
    if (!handle || !screenMain) return;

    var isDragging = false;

    handle.addEventListener('mousedown', function (e) {
      isDragging = true;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      if (!isDragging) return;
      var rect = screenMain.getBoundingClientRect();
      var newWidth = rect.right - e.clientX - 4;
      var maxWidth = Math.floor((rect.right - rect.left) * 0.75);
      newWidth = Math.max(200, Math.min(maxWidth, newWidth));
      document.documentElement.style.setProperty('--right-panel-width', newWidth + 'px');
    });

    document.addEventListener('mouseup', function () {
      if (!isDragging) return;
      isDragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  // ============================================================
  // Sidebar collapse toggle
  // ============================================================
  function wireSidebarCollapse() {
    var sidebar    = document.getElementById('sidebar');
    var toggleBtn  = document.getElementById('sidebar-toggle');
    var root       = document.documentElement;
    var savedWidth = null;

    toggleBtn.addEventListener('click', function () {
      var isCollapsed = sidebar.classList.toggle('collapsed');
      if (isCollapsed) {
        savedWidth = root.style.getPropertyValue('--sidebar-width') ||
          getComputedStyle(root).getPropertyValue('--sidebar-width').trim();
        root.style.setProperty('--sidebar-width',
          getComputedStyle(root).getPropertyValue('--sidebar-collapsed').trim() || '48px');
      } else {
        root.style.setProperty('--sidebar-width', savedWidth || '240px');
      }
      toggleBtn.innerHTML = isCollapsed ? '&#8250;' : '&#8249;';
      toggleBtn.setAttribute('aria-label', isCollapsed ? 'Expand sidebar' : 'Collapse sidebar');
    });
  }

  // ============================================================
  // Left panel resize handle (sidebar ↔ center)
  // ============================================================
  function wireLeftResizeHandle() {
    var handle     = document.getElementById('left-panel-resize-handle');
    var sidebar    = document.getElementById('sidebar');
    var screenMain = document.querySelector('.screen-main');
    if (!handle || !screenMain) return;

    var isDragging = false;

    handle.addEventListener('mousedown', function (e) {
      isDragging = true;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      // Un-collapse sidebar if collapsed so resize makes sense
      if (sidebar.classList.contains('collapsed')) {
        sidebar.classList.remove('collapsed');
      }
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      if (!isDragging) return;
      var rect = screenMain.getBoundingClientRect();
      var newWidth = e.clientX - rect.left;
      newWidth = Math.max(160, Math.min(500, newWidth));
      document.documentElement.style.setProperty('--sidebar-width', newWidth + 'px');
    });

    document.addEventListener('mouseup', function () {
      if (!isDragging) return;
      isDragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  // ============================================================
  // SQLite function reference — inline collapsible
  // ============================================================
  var SQLITE_REFS = [
    { cat: 'Aggregate', fns: [
      { name: 'COUNT',        syntax: 'COUNT(* | expr)',              desc: 'Count rows or non-null values',             ex: 'SELECT COUNT(*) FROM orders' },
      { name: 'SUM',          syntax: 'SUM(expr)',                    desc: 'Sum of non-null values',                    ex: 'SELECT SUM(amount) FROM orders' },
      { name: 'AVG',          syntax: 'AVG(expr)',                    desc: 'Average of non-null values',                ex: 'SELECT AVG(salary) FROM employees' },
      { name: 'MIN',          syntax: 'MIN(expr)',                    desc: 'Minimum non-null value',                    ex: 'SELECT MIN(price) FROM products' },
      { name: 'MAX',          syntax: 'MAX(expr)',                    desc: 'Maximum non-null value',                    ex: 'SELECT MAX(score) FROM results' },
      { name: 'GROUP_CONCAT', syntax: 'GROUP_CONCAT(expr [, sep])',   desc: 'Concatenate values into a string',          ex: "SELECT GROUP_CONCAT(name, ', ') FROM tags" }
    ]},
    { cat: 'String', fns: [
      { name: 'UPPER',   syntax: 'UPPER(s)',                       desc: 'Convert string to uppercase',               ex: "SELECT UPPER('hello')" },
      { name: 'LOWER',   syntax: 'LOWER(s)',                       desc: 'Convert string to lowercase',               ex: "SELECT LOWER('WORLD')" },
      { name: 'LENGTH',  syntax: 'LENGTH(s)',                      desc: 'Number of characters in string',            ex: "SELECT LENGTH('abc')" },
      { name: 'SUBSTR',  syntax: 'SUBSTR(s, start [, len])',       desc: 'Extract substring; start is 1-based',       ex: "SELECT SUBSTR('abcdef', 2, 3)" },
      { name: 'TRIM',    syntax: 'TRIM(s [, chars])',              desc: 'Remove leading and trailing whitespace',    ex: "SELECT TRIM('  hello  ')" },
      { name: 'LTRIM',   syntax: 'LTRIM(s [, chars])',             desc: 'Remove leading whitespace',                 ex: "SELECT LTRIM('  hi')" },
      { name: 'RTRIM',   syntax: 'RTRIM(s [, chars])',             desc: 'Remove trailing whitespace',                ex: "SELECT RTRIM('hi  ')" },
      { name: 'REPLACE', syntax: 'REPLACE(s, find, replacement)', desc: 'Replace all occurrences of find',           ex: "SELECT REPLACE('a-b-c', '-', '/')" },
      { name: 'INSTR',   syntax: 'INSTR(s, pattern)',              desc: 'Position of first occurrence (1-based, 0 if not found)', ex: "SELECT INSTR('hello', 'ell')" },
      { name: 'PRINTF',  syntax: 'PRINTF(fmt, ...)',               desc: 'Format string (alias: FORMAT)',             ex: "SELECT PRINTF('%.2f', 3.14159)" }
    ]},
    { cat: 'Numeric', fns: [
      { name: 'ABS',    syntax: 'ABS(x)',           desc: 'Absolute value',                   ex: 'SELECT ABS(-42)' },
      { name: 'ROUND',  syntax: 'ROUND(x [, d])',   desc: 'Round to d decimal places (default 0)', ex: 'SELECT ROUND(3.567, 2)' },
      { name: 'CEIL',   syntax: 'CEIL(x)',           desc: 'Smallest integer ≥ x',             ex: 'SELECT CEIL(4.1)' },
      { name: 'FLOOR',  syntax: 'FLOOR(x)',          desc: 'Largest integer ≤ x',              ex: 'SELECT FLOOR(4.9)' },
      { name: 'SIGN',   syntax: 'SIGN(x)',           desc: 'Returns -1, 0, or 1',              ex: 'SELECT SIGN(-5)' },
      { name: 'RANDOM', syntax: 'RANDOM()',          desc: 'Random integer between -2^63 and 2^63-1', ex: 'SELECT ABS(RANDOM()) % 100' }
    ]},
    { cat: 'Date & Time', fns: [
      { name: 'DATE',      syntax: "DATE(ts [, mod...])",           desc: "Return date string (YYYY-MM-DD); ts can be 'now'", ex: "SELECT DATE('now', '-7 days')" },
      { name: 'TIME',      syntax: "TIME(ts [, mod...])",           desc: 'Return time string (HH:MM:SS)',            ex: "SELECT TIME('now')" },
      { name: 'DATETIME',  syntax: "DATETIME(ts [, mod...])",       desc: 'Return datetime string',                   ex: "SELECT DATETIME('now', 'start of month')" },
      { name: 'JULIANDAY', syntax: "JULIANDAY(ts [, mod...])",      desc: 'Return Julian day number (float)',          ex: "SELECT JULIANDAY('now') - JULIANDAY(created_at) FROM t" },
      { name: 'STRFTIME',  syntax: "STRFTIME(fmt, ts [, mod...])",  desc: 'Format datetime; %Y %m %d %H %M %S %j %w', ex: "SELECT STRFTIME('%Y-%m', created_at) FROM orders" }
    ]},
    { cat: 'Conditional / Null', fns: [
      { name: 'COALESCE', syntax: 'COALESCE(v1, v2, ...)',   desc: 'Return first non-null value',               ex: 'SELECT COALESCE(nickname, first_name) FROM users' },
      { name: 'NULLIF',   syntax: 'NULLIF(v1, v2)',          desc: 'Return NULL if v1 = v2, else v1',           ex: 'SELECT NULLIF(score, 0) FROM results' },
      { name: 'IIF',      syntax: 'IIF(cond, true, false)',  desc: 'Inline if; equivalent to CASE WHEN',        ex: 'SELECT IIF(score >= 50, "pass", "fail") FROM results' },
      { name: 'CASE',     syntax: 'CASE WHEN c THEN v ... ELSE e END', desc: 'Conditional expression',          ex: 'SELECT CASE WHEN age < 18 THEN "minor" ELSE "adult" END FROM users' }
    ]},
    { cat: 'Type / Conversion', fns: [
      { name: 'TYPEOF', syntax: 'TYPEOF(v)',       desc: 'Returns "integer", "real", "text", "blob", or "null"', ex: 'SELECT TYPEOF(3.14)' },
      { name: 'CAST',   syntax: 'CAST(v AS type)', desc: 'Convert value to INTEGER, REAL, TEXT, BLOB, or NUMERIC', ex: 'SELECT CAST("42" AS INTEGER)' },
      { name: 'HEX',    syntax: 'HEX(x)',          desc: 'Return uppercase hex representation',                   ex: 'SELECT HEX(255)' },
      { name: 'QUOTE',  syntax: 'QUOTE(v)',         desc: 'Return SQL literal representation of value',            ex: "SELECT QUOTE('it''s')" }
    ]},
    { cat: 'Window', fns: [
      { name: 'ROW_NUMBER',   syntax: 'ROW_NUMBER() OVER (win)',              desc: 'Unique sequential row number within partition',   ex: 'SELECT ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) FROM emp' },
      { name: 'RANK',         syntax: 'RANK() OVER (win)',                    desc: 'Rank with gaps for ties',                         ex: 'SELECT RANK() OVER (ORDER BY score DESC) FROM results' },
      { name: 'DENSE_RANK',   syntax: 'DENSE_RANK() OVER (win)',              desc: 'Rank without gaps for ties',                      ex: 'SELECT DENSE_RANK() OVER (ORDER BY score DESC) FROM results' },
      { name: 'NTILE',        syntax: 'NTILE(n) OVER (win)',                  desc: 'Divide rows into n equal buckets',                 ex: 'SELECT NTILE(4) OVER (ORDER BY salary) AS quartile FROM emp' },
      { name: 'LAG',          syntax: 'LAG(expr [, offset [, default]]) OVER (win)', desc: 'Value from a preceding row',             ex: 'SELECT LAG(amount, 1, 0) OVER (ORDER BY date) FROM transactions' },
      { name: 'LEAD',         syntax: 'LEAD(expr [, offset [, default]]) OVER (win)', desc: 'Value from a following row',            ex: 'SELECT LEAD(amount) OVER (ORDER BY date) FROM transactions' },
      { name: 'FIRST_VALUE',  syntax: 'FIRST_VALUE(expr) OVER (win)',         desc: 'First value in the window frame',                 ex: 'SELECT FIRST_VALUE(salary) OVER (PARTITION BY dept ORDER BY salary DESC) FROM emp' },
      { name: 'LAST_VALUE',   syntax: 'LAST_VALUE(expr) OVER (win)',          desc: 'Last value in the window frame',                  ex: 'SELECT LAST_VALUE(salary) OVER (PARTITION BY dept ORDER BY salary ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM emp' },
      { name: 'SUM/AVG/COUNT OVER', syntax: 'agg(expr) OVER (win)',           desc: 'Running or partitioned aggregate',                ex: 'SELECT SUM(amount) OVER (PARTITION BY user_id ORDER BY date) FROM transactions' }
    ]}
  ];

  function wireFnRefSection() {
    var toggleBtn = document.getElementById('fn-ref-toggle');
    var bodyWrap  = document.getElementById('fn-ref-body-wrap');
    var search    = document.getElementById('fn-ref-search');
    var body      = document.getElementById('fn-ref-body');

    if (!toggleBtn || !bodyWrap) return;

    function renderFnRef(q) {
      var query = (q || '').toLowerCase().trim();
      var html = '';
      var anyVisible = false;

      SQLITE_REFS.forEach(function (cat) {
        var items = query ? cat.fns.filter(function (f) {
          return f.name.toLowerCase().indexOf(query) !== -1 ||
                 f.desc.toLowerCase().indexOf(query) !== -1 ||
                 f.syntax.toLowerCase().indexOf(query) !== -1;
        }) : cat.fns;

        if (!items.length) return;
        anyVisible = true;

        html += '<div class="fn-ref-cat">';
        html += '<div class="fn-ref-cat-title">' + escapeHtml(cat.cat) + '</div>';
        items.forEach(function (f) {
          html += '<div class="fn-ref-item">';
          html += '<div class="fn-ref-name">' + escapeHtml(f.name) + '</div>';
          html += '<div class="fn-ref-syntax">' + escapeHtml(f.syntax) + '</div>';
          html += '<div class="fn-ref-desc">' + escapeHtml(f.desc) + '</div>';
          html += '<div class="fn-ref-ex">' + escapeHtml(f.ex) + '</div>';
          html += '</div>';
        });
        html += '</div>';
      });

      body.innerHTML = anyVisible
        ? html
        : '<div class="fn-ref-no-results">No matching functions.</div>';
    }

    var header = document.getElementById('fn-ref-section-header');
    header.addEventListener('click', function (e) {
      if (e.target === search) return; // don't collapse when clicking into search box
      var isHidden = bodyWrap.classList.toggle('hidden');
      toggleBtn.innerHTML = isHidden ? '&#9660;' : '&#9650;';
      toggleBtn.setAttribute('aria-expanded', isHidden ? 'false' : 'true');
      if (!isHidden) {
        renderFnRef(search.value);
        search.focus();
      }
    });

    search.addEventListener('click', function (e) {
      e.stopPropagation(); // prevent header click handler from re-collapsing
    });

    search.addEventListener('input', function () {
      renderFnRef(search.value);
    });
  }

  function wireQueryHistory() {
    var toggleBtn = document.getElementById('query-history-toggle');
    var header    = document.getElementById('query-history-section-header');
    var body      = document.getElementById('query-history-body');
    if (!toggleBtn || !body) return;

    body.innerHTML = '<div class="qh-empty">No queries yet.</div>';

    header.addEventListener('click', function () {
      var isHidden = body.classList.toggle('hidden');
      toggleBtn.innerHTML = isHidden ? '&#9660;' : '&#9650;';
      toggleBtn.setAttribute('aria-expanded', isHidden ? 'false' : 'true');
    });
  }

  function updateQueryHistory() {
    var body = document.getElementById('query-history-body');
    if (!body) return;

    if (!playgroundSuccessHistory.length) {
      body.innerHTML = '<div class="qh-empty">No queries yet.</div>';
      return;
    }

    var html = '';
    for (var i = playgroundSuccessHistory.length - 1; i >= 0; i--) {
      var sql = playgroundSuccessHistory[i];
      var oneLine = sql.replace(/\s+/g, ' ').trim();
      var display = oneLine.length > 200 ? oneLine.slice(0, 200) + '…' : oneLine;
      html += '<div class="qh-item">';
      html += '<button class="qh-play" data-idx="' + i + '" title="Re-run this query">&#9654;</button>';
      html += '<span class="qh-sql">' + escapeHtml(display) + '</span>';
      html += '</div>';
    }
    body.innerHTML = html;

    body.querySelectorAll('.qh-play').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.getAttribute('data-idx'), 10);
        var sql = playgroundSuccessHistory[idx];
        editors['playground'].setContent(sql);
        editors['playground'].format();
        runPlayground();
        var scroll = document.querySelector('.right-panel-scroll');
        if (scroll) scroll.scrollTop = 0;
      });
    });
  }

  // ============================================================
  // Theme toggle (light ↔ dark)
  // ============================================================
  function wireThemeToggle() {
    var btn = document.getElementById('theme-toggle-btn');
    if (!btn) return;

    var isDark = false;

    btn.addEventListener('click', function () {
      isDark = !isDark;
      if (isDark) {
        document.documentElement.setAttribute('data-theme', 'dark');
        btn.innerHTML = '&#9790;'; // moon
        btn.setAttribute('aria-label', 'Switch to light mode');
        btn.setAttribute('title', 'Switch to light mode');
      } else {
        document.documentElement.removeAttribute('data-theme');
        btn.innerHTML = '&#9788;'; // sun
        btn.setAttribute('aria-label', 'Switch to dark mode');
        btn.setAttribute('title', 'Switch to dark mode');
      }
      Object.keys(editors).forEach(function (key) {
        if (editors[key] && editors[key].setTheme) {
          editors[key].setTheme(isDark);
        }
      });
    });
  }

  // ============================================================
  // Bottom button wiring
  // ============================================================
  function wireBottomButtons(questions, moduleTitle, moduleVersion) {
    document.getElementById('finish-work-btn').addEventListener('click', function () {
      finishWork(questions, moduleTitle, moduleVersion);
    });
  }

  // ============================================================
  // Finish Work — download results
  // ============================================================
  function finishWork(questions, moduleTitle, moduleVersion) {
    var confirmed = window.confirm(
      'Download your results file?\n\n' +
      'The file will be saved to your downloads folder. ' +
      'Share it with your recruiter when you are done.'
    );
    if (!confirmed) return;

    clearInterval(timerInterval);
    exportResults(questions, moduleTitle, moduleVersion);
  }

  // ============================================================
  // Export Results — HTML report + print dialog
  // ============================================================
  function exportResults(questions, moduleTitle, moduleVersion) {
    var completionTime = new Date();
    var elapsed = getElapsedString();

    var passCount = 0;
    questions.forEach(function (q) {
      if (questionStatuses[q.id] === 'pass') passCount++;
    });

    var explorationNotes = document.getElementById('exploration-notes').value;

    var html = '<!DOCTYPE html><html><head><meta charset="UTF-8">';
    html += '<title>Results — ' + escapeHtml(moduleTitle) + '</title>';
    html += '<style>';
    html += 'body { font-family: -apple-system, sans-serif; font-size: 13px; color: #222; margin: 2rem; line-height: 1.5; }';
    html += 'h1 { font-size: 1.3rem; } h2 { font-size: 1.1rem; border-bottom: 1px solid #ccc; padding-bottom: 0.25rem; margin-top: 1.5rem; }';
    html += 'h3 { font-size: 0.95rem; margin-top: 1rem; color: #333; }';
    html += '.meta { color: #555; font-size: 0.875rem; margin-bottom: 0.5rem; }';
    html += '.score { font-size: 1.1rem; font-weight: bold; margin: 1rem 0; }';
    html += '.badge-pass { color: green; font-weight: bold; }';
    html += '.badge-fail { color: #c00; font-weight: bold; }';
    html += '.badge-error { color: #a60; font-weight: bold; }';
    html += '.badge-np { color: #666; font-weight: bold; }';
    html += 'pre { background: #f5f5f5; padding: 0.75rem; border-radius: 4px; white-space: pre-wrap; word-break: break-all; font-size: 12px; }';
    html += 'table { border-collapse: collapse; font-size: 12px; width: 100%; margin-top: 0.5rem; }';
    html += 'th { background: #eee; padding: 0.3rem 0.5rem; text-align: left; border: 1px solid #ccc; }';
    html += 'td { padding: 0.3rem 0.5rem; border: 1px solid #ddd; }';
    html += 'tr:nth-child(even) td { background: #fafafa; }';
    html += '.section { margin-bottom: 1.5rem; }';
    html += '.question-block { margin-bottom: 2rem; page-break-inside: avoid; }';
    html += '.playground-section { border-top: 2px solid #ccc; margin-top: 2rem; padding-top: 1rem; }';
    html += '@media print { .playground-section { page-break-before: always; } }';
    html += '</style></head><body>';

    // Header
    html += '<h1>' + escapeHtml(moduleTitle) + ' — Assessment Results</h1>';
    html += '<div class="meta">';
    html += '<strong>Candidate:</strong> ' + escapeHtml(candidateName) + '<br>';
    html += '<strong>Module Version:</strong> ' + escapeHtml(moduleVersion) + '<br>';
    html += '<strong>Started:</strong> ' + (startTime ? startTime.toLocaleString() : '—') + '<br>';
    html += '<strong>Exported:</strong> ' + completionTime.toLocaleString() + '<br>';
    html += '<strong>Total Elapsed:</strong> ' + elapsed;
    html += '</div>';

    // Score
    html += '<div class="score">' + passCount + ' of ' + questions.length + ' questions passed</div>';

    // Notes
    html += '<h2>Notes</h2>';
    html += '<div class="section">';
    if (explorationNotes.trim()) {
      html += '<pre>' + escapeHtml(explorationNotes) + '</pre>';
    } else {
      html += '<p><em>No notes recorded.</em></p>';
    }
    html += '</div>';

    // Per-question results
    html += '<h2>Question Results</h2>';
    questions.forEach(function (q, idx) {
      var status = questionStatuses[q.id];
      var badgeClass = 'badge-np';
      var badgeText  = 'NOT ATTEMPTED';
      if (status === 'pass')               { badgeClass = 'badge-pass';  badgeText = 'PASS'; }
      else if (status === 'fail')          { badgeClass = 'badge-fail';  badgeText = 'FAIL'; }
      else if (status === 'error')         { badgeClass = 'badge-error'; badgeText = 'ERROR'; }
      else if (status === 'not-permitted') { badgeClass = 'badge-np';    badgeText = 'NOT PERMITTED'; }

      html += '<div class="question-block">';
      html += '<h3>Q' + (idx + 1) + ': <span class="' + badgeClass + '">' + badgeText + '</span></h3>';
      html += '<p><strong>Prompt:</strong> ' + escapeHtml(q.prompt) + '</p>';
      html += '<p><strong>Expected columns:</strong> ' + q.expectedColumns.map(escapeHtml).join(', ') + '</p>';

      var submittedSQL = editors[q.id] ? editors[q.id].getContent() : '';
      html += '<p><strong>Submitted SQL:</strong></p>';
      if (submittedSQL.trim()) {
        html += '<pre>' + escapeHtml(submittedSQL) + '</pre>';
      } else {
        html += '<p><em>No SQL submitted.</em></p>';
      }

      html += reportResultsHTML(document.getElementById('results-' + q.id));
      html += '</div>';
    });

    // Playground query history — successful queries only, at the END
    html += '<div class="playground-section">';
    html += '<h2>Playground Queries</h2>';
    html += '<div class="section">';
    if (playgroundSuccessHistory.length === 0) {
      html += '<p><em>No successful playground queries recorded.</em></p>';
    } else {
      playgroundSuccessHistory.forEach(function (q, i) {
        html += '<h3>Query ' + (i + 1) + '</h3>';
        html += '<pre>' + escapeHtml(q) + '</pre>';
      });
    }
    html += '</div></div>';

    html += '</body></html>';

    // Always download via Blob — works regardless of pop-up blocker settings.
    var blob = new Blob([html], { type: 'text/html' });
    var blobUrl = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = blobUrl;
    a.download = (moduleTitle || 'results').replace(/[^a-z0-9_\-]/gi, '_') + '_results.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 10000);

    // Show a brief success toast regardless of pop-up blocker state.
    var toast = document.createElement('div');
    toast.style.cssText = [
      'position:fixed', 'bottom:1.5rem', 'left:50%', 'transform:translateX(-50%)',
      'background:#1a5276', 'color:#fff', 'text-align:center',
      'padding:0.75rem 1.25rem', 'border-radius:6px', 'font-size:0.9rem',
      'z-index:10000', 'line-height:1.4', 'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
      'transition:opacity 0.5s'
    ].join(';');
    toast.textContent = 'Results file downloaded. Share it with your recruiter when you are done.';
    document.body.appendChild(toast);
    setTimeout(function () { toast.style.opacity = '0'; }, 6000);
    setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 6600);

    // Also open a print window if pop-ups are allowed.
    var w = window.open('', '_blank');
    if (w) {
      w.document.write(html);
      w.document.close();
      setTimeout(function () { w.focus(); w.print(); }, 250);
    }
  }

  function reportResultsHTML(resultsEl) {
    if (!resultsEl) return '';
    var table = resultsEl.querySelector('.results-table');
    if (!table) return '<p><em>No results.</em></p>';

    var html = '<p><strong>Last result set:</strong></p>';
    html += '<table>';

    var headers = table.querySelectorAll('thead th');
    if (headers.length > 0) {
      html += '<tr>';
      headers.forEach(function (th) {
        html += '<th>' + escapeHtml(th.getAttribute('data-colname') || th.textContent.replace(/[▲▼]/g, '').trim()) + '</th>';
      });
      html += '</tr>';
    }

    var tbl = resultsEl._tableData;
    if (tbl) {
      tbl.rows.forEach(function (row) {
        html += '<tr>';
        row.forEach(function (cell) {
          var val = cell === null || cell === undefined ? '<em>NULL</em>' : escapeHtml(String(cell));
          html += '<td>' + val + '</td>';
        });
        html += '</tr>';
      });
    } else {
      var rows = table.querySelectorAll('tbody tr');
      rows.forEach(function (tr) {
        html += '<tr>';
        tr.querySelectorAll('td').forEach(function (td) {
          html += '<td>' + escapeHtml(td.title || td.textContent) + '</td>';
        });
        html += '</tr>';
      });
    }

    html += '</table>';
    return html;
  }

  // ============================================================
  // Results table component
  // ============================================================
  /**
   * renderResultsTable — renders rows into container with pagination + sortable columns.
   *
   * @param {HTMLElement} container
   * @param {Array}       rows         - array of arrays (sql.js .values format)
   * @param {Array}       columnNames  - array of strings
   */
  function renderResultsTable(container, rows, columnNames) {
    container.innerHTML = '';

    // Store data on the element for the report generator
    container._tableData = { rows: rows, columns: columnNames };

    if (!columnNames || columnNames.length === 0) {
      container.innerHTML = '<p class="no-results">Query executed successfully. No rows returned.</p>';
      return;
    }

    var PAGE_SIZE = 10;
    var currentPage = 0;
    var sortCol  = -1;
    var sortDir  = 'asc';  // 'asc' | 'desc'
    var sortedRows = rows.slice();  // working copy

    // Summary
    var summary = document.createElement('div');
    summary.className = 'results-summary';
    summary.textContent = rows.length + ' row' + (rows.length !== 1 ? 's' : '') + ' returned';
    container.appendChild(summary);

    var wrap = document.createElement('div');
    wrap.className = 'results-table-wrap';
    container.appendChild(wrap);

    var table = document.createElement('table');
    table.className = 'results-table';
    wrap.appendChild(table);

    // Head
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    columnNames.forEach(function (col, colIdx) {
      var th = document.createElement('th');
      th.textContent = col;
      th.setAttribute('data-colname', col);
      th.setAttribute('tabindex', '0');
      th.setAttribute('aria-label', 'Sort by ' + col);

      function doSort() {
        if (sortCol === colIdx) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortCol = colIdx;
          sortDir = 'asc';
        }
        // Update header classes
        headRow.querySelectorAll('th').forEach(function (t, i) {
          t.classList.remove('sort-asc', 'sort-desc');
          if (i === sortCol) {
            t.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
          }
        });
        // Sort rows
        sortedRows.sort(function (a, b) {
          var va = a[colIdx];
          var vb = b[colIdx];
          if (va === null || va === undefined) va = '';
          if (vb === null || vb === undefined) vb = '';
          var sa = String(va).toLowerCase();
          var sb = String(vb).toLowerCase();
          // Try numeric sort
          var na = parseFloat(va);
          var nb = parseFloat(vb);
          var cmp;
          if (!isNaN(na) && !isNaN(nb)) {
            cmp = na - nb;
          } else {
            cmp = sa < sb ? -1 : sa > sb ? 1 : 0;
          }
          return sortDir === 'asc' ? cmp : -cmp;
        });
        currentPage = 0;
        renderPage();
      }

      th.addEventListener('click', doSort);
      th.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          doSort();
        }
      });

      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    table.appendChild(tbody);

    // Pagination controls
    var paginationDiv = document.createElement('div');
    paginationDiv.className = 'pagination-controls';
    container.appendChild(paginationDiv);

    var prevBtn = document.createElement('button');
    prevBtn.textContent = '← Previous';
    var pageInfo = document.createElement('span');
    pageInfo.className = 'pagination-info';
    var nextBtn = document.createElement('button');
    nextBtn.textContent = 'Next →';

    paginationDiv.appendChild(prevBtn);
    paginationDiv.appendChild(pageInfo);
    paginationDiv.appendChild(nextBtn);

    prevBtn.addEventListener('click', function () {
      if (currentPage > 0) { currentPage--; renderPage(); }
    });
    nextBtn.addEventListener('click', function () {
      var totalPages = Math.ceil(sortedRows.length / PAGE_SIZE);
      if (currentPage < totalPages - 1) { currentPage++; renderPage(); }
    });

    function renderPage() {
      tbody.innerHTML = '';
      var totalPages = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
      var start = currentPage * PAGE_SIZE;
      var end   = Math.min(start + PAGE_SIZE, sortedRows.length);
      var pageRows = sortedRows.slice(start, end);

      pageRows.forEach(function (row) {
        var tr = document.createElement('tr');
        columnNames.forEach(function (_, colIdx) {
          var td = document.createElement('td');
          var val = row[colIdx];
          if (val === null || val === undefined) {
            td.textContent = 'NULL';
            td.classList.add('null-val');
          } else {
            var str = String(val);
            if (str.length > 200) {
              td.textContent = str.substring(0, 200) + '…';
              td.title = str;
            } else {
              td.textContent = str;
              td.title = str;
            }
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });

      // Pagination visibility
      if (sortedRows.length <= PAGE_SIZE) {
        paginationDiv.style.display = 'none';
      } else {
        paginationDiv.style.display = 'flex';
        pageInfo.textContent = 'Page ' + (currentPage + 1) + ' of ' + totalPages;
        prevBtn.disabled = currentPage === 0;
        nextBtn.disabled = currentPage >= totalPages - 1;
      }
    }

    renderPage();
  }

  // ============================================================
  // Status / badge helpers
  // ============================================================
  function showBadge(statusEl, type, text) {
    statusEl.innerHTML = '';
    var badge = document.createElement('span');
    badge.className = 'badge badge-' + type;
    badge.textContent = text;
    statusEl.appendChild(badge);
  }

  function clearStatus(statusEl) {
    statusEl.innerHTML = '';
  }

  function clearResults(resultsEl) {
    resultsEl.innerHTML = '';
    resultsEl._tableData = null;
  }

  // ============================================================
  // Nav dot update
  // ============================================================
  function updateNavDot(qId, status) {
    var dot = document.querySelector('[data-section-dot="' + qId + '"]');
    if (!dot) return;
    dot.className = 'nav-dot';
    if (status) {
      dot.classList.add('dot-' + status.replace(/-/g, '-'));
    }
    var link = document.querySelector('[data-section="' + qId + '"]');
    if (link) {
      if (status) {
        link.setAttribute('data-status', status);
      } else {
        link.removeAttribute('data-status');
      }
    }
  }

  // ============================================================
  // HTML escaping
  // ============================================================
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

})();
