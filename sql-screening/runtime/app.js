(function () {
  'use strict';

  // ============================================================
  // SQL Guard — classify before ANY query reaches the engine
  // Rule 2 (TEMP TABLE) checked before any general CREATE check.
  // ============================================================
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
  var tablePreviewState = {};       // { [tableName]: { loaded, rows, columns, rowCount } }
  var executions = {};
  var attempts = {};
  var temporarySetup = [];
  var worker = null;
  var workerBytes;
  var workerRequest = null;
  var requestId = 0;
  var busy = false;
  var restoring = false;
  var saveTimer;
  var activeQuestion = 0;
  var allQuestions = false;
  var assessmentQuestions = [];
  var storageKey;
  var savedSession;
  var finishedAt = null;

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
    assessmentQuestions = questions;
    document.title = moduleTitle + ' - SQL Assessment';
    storageKey = 'sql-assessment:' + BUILD_ID;
    try {
      savedSession = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (savedSession) validateSession(savedSession);
    } catch (error) { savedSession = null; }

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

    var resumeButton = document.getElementById('resume-btn');
    resumeButton.hidden = !savedSession;
    if (savedSession) resumeButton.textContent = 'Resume ' + savedSession.candidateName;
    resumeButton.addEventListener('click', function () {
      candidateName = savedSession.candidateName;
      startTest(questions, answerHashes, moduleTitle, moduleVersion, wasmB64, dbB64, moduleDesc, savedSession);
    });
    document.getElementById('restore-file').addEventListener('change', async function (event) {
      try {
        var file = event.target.files[0];
        if (!file) return;
        if (file.size > 10000000) throw new Error('Checkpoint exceeds 10 MB.');
        var session = JSON.parse(await file.text());
        validateSession(session);
        candidateName = session.candidateName;
        startTest(questions, answerHashes, moduleTitle, moduleVersion, wasmB64, dbB64, moduleDesc, session);
      } catch (error) { document.getElementById('start-error').textContent = error.message; }
      event.target.value = '';
    });

    beginBtn.addEventListener('click', function () {
      if (savedSession && !window.confirm('Start over and replace the saved session for this assessment?')) return;
      candidateName = nameInput.value.trim();
      startTest(questions, answerHashes, moduleTitle, moduleVersion, wasmB64, dbB64, moduleDesc);
    });
  });

  // ============================================================
  // startTest — hide Screen 1, show Screen 2, init everything
  // ============================================================
  function startTest(questions, answerHashes, moduleTitle, moduleVersion, wasmB64, dbB64, moduleDesc, recovery) {
    document.getElementById('screen1').classList.add('hidden');
    document.getElementById('screen2').classList.remove('hidden');

    // Show candidate name in sidebar
    var nameDisplay = document.getElementById('sidebar-candidate-name');
    if (nameDisplay) nameDisplay.textContent = candidateName;

    startTime = recovery ? new Date(recovery.startedAt) : new Date();
    temporarySetup = recovery ? recovery.temporarySetup : [];
    finishedAt = null;
    startTimer();
    document.getElementById('save-status').textContent = 'Opening database...';

    // Async DB init then wire up UI
    initDatabase(wasmB64, dbB64).then(function (database) {
      db = database;
      buildUI(questions, answerHashes, moduleTitle, moduleVersion, moduleDesc);
      if (recovery) restoreSession(recovery);
      saveSession();
    }).catch(function (err) {
      console.error('Failed to initialize sql.js database:', err);
      clearInterval(timerInterval);
      document.getElementById('screen1').classList.remove('hidden');
      document.getElementById('screen2').classList.add('hidden');
      document.getElementById('start-error').textContent = 'Unable to open assessment: ' + err.message;
    });
  }

  // ============================================================
  // Timer
  // ============================================================
  function startTimer() {
    clearInterval(timerInterval);
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
    var elapsed = Math.floor(((finishedAt || Date.now()) - startTime.getTime()) / 1000);
    var h = Math.floor(elapsed / 3600);
    var m = Math.floor((elapsed % 3600) / 60);
    var s = elapsed % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  // ============================================================
  // sql.js initialization
  // ============================================================
  async function initDatabase(wasmB64, dbB64) {
    async function decode(source) {
      var bytes = base64ToUint8Array(source);
      if (typeof PAYLOAD_ENCODING !== 'undefined' && PAYLOAD_ENCODING === 'gzip') {
        if (typeof DecompressionStream === 'undefined') throw new Error('This browser needs an update to open compressed assessments.');
        return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      }
      return bytes;
    }
    workerBytes = { wasm: await decode(wasmB64), database: await decode(dbB64) };
    await restartWorker();
    return true;
  }

  async function restartWorker() {
    if (worker) worker.terminate();
    var url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
    worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = function (event) {
      if (!workerRequest || event.data.id !== workerRequest.id) return;
      var pending = workerRequest;
      workerRequest = null;
      clearTimeout(pending.timeout);
      if (event.data.error) pending.reject(new Error(event.data.error));
      else pending.resolve(event.data.result);
    };
    worker.onerror = function () {
      if (!workerRequest) return;
      var pending = workerRequest;
      workerRequest = null;
      clearTimeout(pending.timeout);
      pending.reject(new Error('Database worker stopped. Reload and resume your saved session.'));
    };
    await workerCall({ type: 'init', wasm: workerBytes.wasm, database: workerBytes.database, setup: temporarySetup }, 15000);
  }

  function workerCall(message, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (workerRequest) { reject(new Error('Another query is running.')); return; }
      message.id = ++requestId;
      workerRequest = { id: message.id, resolve: resolve, reject: reject, timeout: setTimeout(function () {
        var pending = workerRequest;
        workerRequest = null;
        worker.terminate();
        pending.reject(new Error('Execution timed out. Narrow the query and run again.'));
      }, timeoutMs || 8000) };
      worker.postMessage(message);
    });
  }

  function cancelQuery() {
    if (!workerRequest || !busy) return;
    var pending = workerRequest;
    workerRequest = null;
    clearTimeout(pending.timeout);
    worker.terminate();
    pending.reject(new Error('Query cancelled. Your SQL is unchanged.'));
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
    wireSchemaResizeHandle();
    wireBottomButtons(questions, moduleTitle, moduleVersion);
    wireFnRefPopup();
    wireQueryHistory();
    wireThemeToggle();
    wireWorkspace(questions);
    document.getElementById('cancel-query').addEventListener('click', cancelQuery);
    document.getElementById('checkpoint-btn').addEventListener('click', function () { downloadJSON(sessionData(), 'checkpoint'); });
    document.getElementById('clear-saved-btn').addEventListener('click', function () {
      if (!window.confirm('Clear saved progress and return to the start? Download a checkpoint first to keep your work.')) return;
      clearTimeout(saveTimer);
      restoring = true;
      try { localStorage.removeItem(storageKey); } catch (error) {}
      window.location.reload();
    });
    window.addEventListener('pagehide', saveSession);
    window.addEventListener('beforeunload', function (event) {
      saveSession();
      if (!finishedAt) { event.preventDefault(); event.returnValue = ''; }
    });
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
      label.textContent = 'Q' + (idx + 1) + (q.title ? ': ' + q.title : '');

      a.appendChild(dot);
      a.appendChild(label);
      nav.appendChild(a);

      a.addEventListener('click', function (e) {
        e.preventDefault();
        activeQuestion = idx;
        updateWorkspace();
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
    finishBtn.setAttribute('aria-label', 'Finish Work');
    finishBtn.title = 'Finish Work';
    finishBtn.appendChild(CMEditor.icon('Download'));
    var finishLabel = document.createElement('span');
    finishLabel.textContent = 'Finish Work';
    finishBtn.appendChild(finishLabel);

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
      numSpan.textContent = 'Question ' + (idx + 1) + (q.title ? ': ' + q.title : '');
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
      var selectionBtn = document.createElement('button');
      selectionBtn.className = 'btn-selection';
      selectionBtn.dataset.context = q.id;
      selectionBtn.textContent = 'Run selection';
      selectionBtn.disabled = true;
      selectionBtn.title = 'Run selected SQL (Ctrl/Cmd+Shift+Enter)';
      editorButtons.appendChild(selectionBtn);
      editorButtons.appendChild(iconButton('Maximize', 'Expand SQL editor', function () {
        var expanded = section.classList.toggle('editor-expanded');
        this.setAttribute('aria-label', expanded ? 'Restore editor size' : 'Expand SQL editor');
        this.title = this.getAttribute('aria-label');
        this.replaceChildren(CMEditor.icon(expanded ? 'Minimize' : 'Maximize'));
      }));

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
      var brief = document.createElement('details');
      brief.className = 'question-brief';
      brief.open = true;
      var briefLabel = document.createElement('summary');
      briefLabel.textContent = 'Question brief';
      brief.appendChild(briefLabel);
      brief.appendChild(prompt);
      brief.appendChild(colsDiv);
      section.appendChild(brief);
      section.appendChild(editorBlock);
      var history = document.createElement('details');
      history.className = 'question-history';
      history.innerHTML = '<summary>Query history</summary><div id="history-' + q.id + '"></div>';
      section.appendChild(history);

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
        onChange: function () { editorChanged(q.id); },
        onRun: function () { runGraded(q, ANSWER_HASHES_JSON); },
        onRunSelection: function () { runGraded(q, ANSWER_HASHES_JSON, true); },
        onSelection: function (selected) { document.querySelector('.btn-selection[data-context="' + q.id + '"]').disabled = !selected || busy; },
      });
    });

    // Playground editor
    var playgroundContainer = document.getElementById('playground-editor');
    editors['playground'] = CMEditor.createEditor(playgroundContainer, {
      schema: schema,
      onChange: function () { editorChanged('playground'); },
      onRun: runPlayground,
      onRunSelection: function () { runPlayground(true); },
      onSelection: function (selected) { document.getElementById('playground-selection').disabled = !selected || busy; },
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
      document.querySelector('.btn-selection[data-context="' + q.id + '"]').addEventListener('click', function () { runGraded(q, answerHashes, true); });
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
  async function execSQL(sqlStr, options) {
    if (!db) {
      throw new Error('Database not yet initialized.');
    }
    var result = await workerCall({ type: 'execute', sql: sqlStr, options: options || {} });
    temporarySetup = temporarySetup.concat(result.setup || []);
    return result;
  }

  // ============================================================
  // Playground runner
  // ============================================================
  async function runPlayground(selection) {
    if (busy) return;
    var sqlStr    = (selection === true ? editors.playground.getSelection() : editors.playground.getContent()).trim();
    var statusEl  = document.getElementById('playground-status');
    var resultsEl = document.getElementById('playground-results');

    if (!sqlStr) return;

    clearStatus(statusEl);
    setBusy(true);
    showBadge(statusEl, 'not-permitted', 'Running...');
    var record = { sql: sqlStr, at: new Date().toISOString(), status: 'executed' };
    try {
      var result = await execSQL(sqlStr);
      renderResultsTable(resultsEl, result.rows, result.columns, { truncated: result.truncated });
      showBadge(statusEl, 'pass', 'Executed in ' + result.durationMs + ' ms');
      if (queryHistory.indexOf(sqlStr) === -1) {
        queryHistory.push(sqlStr);
      }
      // Track successful (non-error) queries separately for export
      if (playgroundSuccessHistory.indexOf(sqlStr) === -1) {
        playgroundSuccessHistory.push(sqlStr);
      }
      updateQueryHistory();
    } catch (err) {
      record.status = 'error';
      record.message = err.message;
      clearResults(resultsEl);
      showBadge(statusEl, 'error', 'ERROR: ' + err.message);
      // Add to general history but NOT to success history
      if (queryHistory.indexOf(sqlStr) === -1) {
        queryHistory.push(sqlStr);
      }
      await recoverWorker(err);
    } finally {
      addAttempt('playground', record);
      updateQueryHistory();
      setBusy(false);
      saveSession();
    }
  }

  // ============================================================
  // Graded question runner
  // ============================================================
  async function runGraded(q, answerHashes, selection) {
    if (busy) return;
    var sqlStr    = (selection ? editors[q.id].getSelection() : editors[q.id].getContent()).trim();
    var statusEl  = document.getElementById('status-' + q.id);
    var resultsEl = document.getElementById('results-' + q.id);

    if (!sqlStr) return;

    clearStatus(statusEl);
    setBusy(true);
    showBadge(statusEl, 'not-permitted', 'Running...');
    var record = { sql: sqlStr, at: new Date().toISOString(), status: 'error', rows: [], columns: [] };
    try {
      var result = await execSQL(sqlStr, { graded: true });
      record.rows = result.rows.slice(0, 500);
      record.columns = result.columns;
      record.rowCount = result.rows.length;
      record.truncated = result.rows.length > 500;
      record.durationMs = result.durationMs;
      var validColumns = result.columns.length === q.expectedColumns.length;
      if (q.grading && q.grading.requireColumnNames) validColumns = validColumns && result.columns.every(function (column, index) { return column === q.expectedColumns[index]; });
      var hash = validColumns ? await GradingLogic.computeHash(result.rows, q.expectedColumns, q.grading) : null;
      record.status = hash === answerHashes[q.id] ? 'pass' : 'fail';
      record.message = validColumns ? (record.status === 'pass' ? 'Passed' : 'Executed; answer differs') : 'Executed; expected columns: ' + q.expectedColumns.join(', ');
      renderResultsTable(resultsEl, record.rows, record.columns, { truncated: record.truncated, rowCount: record.rowCount });
    } catch (err) {
      record.message = err.message;
      clearResults(resultsEl);
      editors[q.id].focusError(err.message);
      await recoverWorker(err);
    } finally {
      executions[q.id] = record;
      addAttempt(q.id, record);
      refreshQuestion(q.id);
      setBusy(false);
      saveSession();
    }
  }

  function iconButton(icon, label, action) {
    var button = document.createElement('button');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.appendChild(CMEditor.icon(icon));
    button.addEventListener('click', action);
    return button;
  }

  function setBusy(value) {
    busy = value;
    document.querySelectorAll('.btn-run, .btn-selection, #finish-work-btn').forEach(function (button) { button.disabled = value; });
    document.querySelectorAll('.btn-selection').forEach(function (button) { button.disabled = value || !editors[button.dataset.context].getSelection(); });
    document.getElementById('playground-selection').disabled = value || !editors.playground.getSelection();
    document.getElementById('cancel-query').disabled = !value;
    document.getElementById('screen2').setAttribute('aria-busy', String(value));
  }

  async function recoverWorker(error) {
    if (!/cancelled|timed out|worker stopped/i.test(error.message)) return;
    try { await restartWorker(); }
    catch (restartError) {
      db = null;
      document.getElementById('save-status').textContent = 'Database unavailable. Download a checkpoint, then reload.';
    }
  }

  function editorChanged(questionId) {
    if (restoring) return;
    if (finishedAt) { finishedAt = null; startTimer(); }
    if (questionId !== 'playground') refreshQuestion(questionId);
    clearTimeout(saveTimer);
    document.getElementById('save-status').textContent = 'Unsaved changes';
    saveTimer = setTimeout(saveSession, 500);
  }

  function refreshQuestion(questionId) {
    var record = executions[questionId];
    var sql = editors[questionId].getContent().trim();
    var status = record ? (record.sql === sql ? record.status : 'changed') : (sql ? 'draft' : null);
    questionStatuses[questionId] = status;
    var statusElement = document.getElementById('status-' + questionId);
    if (status === 'changed') showBadge(statusElement, 'not-permitted', 'Edited since last run - ungraded');
    else if (record) showBadge(statusElement, record.status, record.message || record.status);
    else if (status === 'draft') showBadge(statusElement, 'not-permitted', 'Not run');
    else clearStatus(statusElement);
    updateNavDot(questionId, status);
    var link = document.querySelector('.nav-link[data-section="' + questionId + '"]');
    if (link) {
      link.title = questionId.toUpperCase() + ': ' + (status || 'not attempted');
      link.setAttribute('aria-label', link.title);
      var badge = link.querySelector('.nav-status');
      if (!badge) { badge = document.createElement('small'); badge.className = 'nav-status'; link.appendChild(badge); }
      badge.textContent = status || 'not attempted';
    }
  }

  function addAttempt(questionId, record) {
    var history = attempts[questionId] || [];
    history.unshift({ sql: record.sql, status: record.status, at: record.at, message: record.message || '', durationMs: record.durationMs || 0 });
    attempts[questionId] = history.slice(0, 20);
    renderAttemptHistory(questionId);
  }

  function renderAttemptHistory(questionId) {
    var container = document.getElementById(questionId === 'playground' ? 'query-history-body' : 'history-' + questionId);
    if (!container) return;
    container.replaceChildren();
    (attempts[questionId] || []).forEach(function (attempt) {
      var item = document.createElement('div');
      item.className = 'attempt-row';
      var sql = document.createElement('code');
      sql.textContent = attempt.sql;
      var label = document.createElement('span');
      label.textContent = attempt.status + ' - ' + new Date(attempt.at).toLocaleTimeString();
      item.appendChild(label);
      item.appendChild(sql);
      item.appendChild(iconButton('History', 'Restore this query', function () { editors[questionId].setContent(attempt.sql); editors[questionId].view.focus(); }));
      container.appendChild(item);
    });
    if (!container.children.length) container.textContent = 'No runs yet.';
  }

  function sessionData() {
    var drafts = {};
    Object.keys(editors).forEach(function (key) { drafts[key] = editors[key].getContent(); });
    return { formatVersion: 1, buildId: BUILD_ID, moduleId: MODULE_ID, moduleVersion: MODULE_VERSION,
      candidateName: candidateName, startedAt: startTime.toISOString(), savedAt: new Date().toISOString(),
      drafts: drafts, executions: executions, attempts: attempts, temporarySetup: temporarySetup,
      activeQuestion: activeQuestion, allQuestions: allQuestions, dark: document.documentElement.dataset.theme === 'dark' };
  }

  function saveSession() {
    if (restoring || !startTime || !editors.playground) return;
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(storageKey, JSON.stringify(sessionData()));
      document.getElementById('save-status').textContent = 'Saved on this browser';
    } catch (error) {
      document.getElementById('save-status').textContent = 'Browser save unavailable - download a checkpoint';
    }
  }

  function validateSession(session) {
    if (!session || session.formatVersion !== 1 || session.buildId !== BUILD_ID || session.moduleId !== MODULE_ID || session.moduleVersion !== MODULE_VERSION) throw new Error('This checkpoint belongs to a different assessment build.');
    if (typeof session.candidateName !== 'string' || !session.candidateName.trim() || !Number.isFinite(Date.parse(session.startedAt))) throw new Error('Invalid checkpoint identity or start time.');
    var ids = assessmentQuestions.map(function (question) { return question.id; }).concat('playground');
    if (!session.drafts || !session.executions || !session.attempts || !Array.isArray(session.temporarySetup)) throw new Error('Incomplete checkpoint.');
    if (session.temporarySetup.some(function (sql) { return typeof sql !== 'string' || sql.length > 100000; })) throw new Error('Invalid temporary-table setup.');
    Object.keys(session.drafts).forEach(function (key) {
      if (!ids.includes(key) || typeof session.drafts[key] !== 'string' || session.drafts[key].length > 100000) throw new Error('Invalid checkpoint draft.');
    });
    Object.keys(session.executions).forEach(function (key) {
      var record = session.executions[key];
      if (!ids.includes(key) || !record || typeof record.sql !== 'string' || !['pass', 'fail', 'error'].includes(record.status) || !Array.isArray(record.rows) || !Array.isArray(record.columns) || record.rows.length > 500 || record.rows.some(function (row) { return !Array.isArray(row); })) throw new Error('Invalid checkpoint execution.');
    });
    Object.keys(session.attempts).forEach(function (key) {
      if (!ids.includes(key) || !Array.isArray(session.attempts[key]) || session.attempts[key].length > 20 || session.attempts[key].some(function (record) { return !record || typeof record.sql !== 'string'; })) throw new Error('Invalid checkpoint history.');
    });
  }

  function restoreSession(session) {
    restoring = true;
    Object.keys(session.drafts).forEach(function (key) { editors[key].setContent(session.drafts[key]); });
    executions = session.executions;
    attempts = session.attempts;
    activeQuestion = Math.max(0, Math.min(assessmentQuestions.length - 1, Number(session.activeQuestion) || 0));
    allQuestions = !!session.allQuestions;
    Object.keys(executions).forEach(function (key) {
      var record = executions[key];
      renderResultsTable(document.getElementById('results-' + key), record.rows, record.columns, { truncated: record.truncated, rowCount: record.rowCount });
    });
    assessmentQuestions.forEach(function (question) { refreshQuestion(question.id); renderAttemptHistory(question.id); });
    renderAttemptHistory('playground');
    if (session.dark) document.getElementById('theme-toggle-btn').click();
    updateWorkspace();
    restoring = false;
  }

  function downloadJSON(data, suffix) {
    downloadFile(JSON.stringify(data, null, 2), 'application/json', suffix + '.json');
  }

  function downloadFile(content, type, suffix) {
    var url = URL.createObjectURL(new Blob([content], { type: type }));
    var link = document.createElement('a');
    link.href = url;
    link.download = (MODULE_ID + '_' + candidateName).replace(/[^a-z0-9_-]/gi, '_') + '_' + suffix;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  function wireWorkspace(questions) {
    document.querySelectorAll('[data-icon]').forEach(function (button) { button.appendChild(CMEditor.icon(button.dataset.icon)); });
    document.querySelectorAll('.btn-run, .btn-format').forEach(function (button) {
      button.prepend(CMEditor.icon(button.classList.contains('btn-run') ? 'Play' : 'Code'));
      if (button.classList.contains('btn-run')) button.title = 'Run query (Ctrl/Cmd+Enter)';
    });
    document.getElementById('previous-question').onclick = function () { activeQuestion--; updateWorkspace(); saveSession(); };
    document.getElementById('next-question').onclick = function () { activeQuestion++; updateWorkspace(); saveSession(); };
    document.getElementById('focus-view').onclick = function () { allQuestions = false; updateWorkspace(); saveSession(); };
    document.getElementById('all-view').onclick = function () { allQuestions = true; updateWorkspace(); saveSession(); };
    document.getElementById('data-panel-toggle').onclick = function () {
      var screen = document.getElementById('screen2');
      if (window.matchMedia('(max-width: 900px)').matches) {
        var open = screen.classList.toggle('data-open');
        this.setAttribute('aria-expanded', String(open));
      } else {
        var hidden = screen.classList.toggle('data-hidden');
        this.setAttribute('aria-expanded', String(!hidden));
      }
    };
    function updateDataVisibility() {
      var screen = document.getElementById('screen2');
      var visible = window.matchMedia('(max-width: 900px)').matches ? screen.classList.contains('data-open') : !screen.classList.contains('data-hidden');
      document.getElementById('data-panel-toggle').setAttribute('aria-expanded', String(visible));
      screen.style.setProperty('--mobile-toolbar-height', document.querySelector('.workspace-toolbar').offsetHeight + 'px');
    }
    new ResizeObserver(updateDataVisibility).observe(document.querySelector('.workspace-toolbar'));
    updateDataVisibility();
    document.getElementById('playground-selection').onclick = function () { runPlayground(true); };
    document.getElementById('schema-search').oninput = function () {
      var query = this.value.toLowerCase();
      document.querySelectorAll('.schema-table-panel').forEach(function (panel) { panel.hidden = !panel.textContent.toLowerCase().includes(query); });
    };
    document.getElementById('finish-back').onclick = function () { document.getElementById('finish-dialog').close(); };
    document.getElementById('finish-download').onclick = function () { completeSession(); exportResults(questions, MODULE_TITLE, MODULE_VERSION); };
    document.getElementById('finish-json').onclick = function () {
      completeSession();
      var data = sessionData();
      data.completedAt = new Date(finishedAt).toISOString();
      data.questionStatuses = Object.assign({}, questionStatuses);
      data.questions = questions.map(function (question) { return { id: question.id, prompt: question.prompt, difficulty: question.difficulty, tags: question.tags || [] }; });
      downloadJSON(data, 'results');
    };
    questions.forEach(function (question) { refreshQuestion(question.id); });
    document.querySelectorAll('.panel-resize-handle, .schema-resize-handle').forEach(function (handle) {
      handle.removeAttribute('aria-hidden');
      handle.tabIndex = 0;
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-label', handle.id === 'schema-resize-handle' ? 'Resize schema panel' : 'Resize side panel');
      handle.setAttribute('aria-orientation', handle.id === 'schema-resize-handle' ? 'horizontal' : 'vertical');
      handle.addEventListener('keydown', function (event) {
        var vertical = handle.id === 'schema-resize-handle';
        var previousKey = vertical ? 'ArrowUp' : 'ArrowLeft';
        var nextKey = vertical ? 'ArrowDown' : 'ArrowRight';
        if (event.key !== previousKey && event.key !== nextKey) return;
        event.preventDefault();
        var delta = event.key === nextKey ? 20 : -20;
        if (vertical) {
          var section = document.getElementById('playground-schema-section');
          section.style.height = Math.max(80, Math.min(innerHeight * 0.7, section.offsetHeight + delta)) + 'px';
        } else {
          var left = handle.id === 'left-panel-resize-handle';
          var panel = document.getElementById(left ? 'sidebar' : 'right-panel');
          document.documentElement.style.setProperty(left ? '--sidebar-width' : '--right-panel-width', Math.max(120, Math.min(innerWidth * 0.5, panel.offsetWidth + (left ? delta : -delta))) + 'px');
        }
      });
    });
    updateWorkspace();
  }

  function updateWorkspace() {
    activeQuestion = Math.max(0, Math.min(assessmentQuestions.length - 1, activeQuestion));
    assessmentQuestions.forEach(function (question, index) {
      document.getElementById('section-' + question.id).hidden = !allQuestions && index !== activeQuestion;
      var link = document.querySelector('.nav-link[data-section="' + question.id + '"]');
      link.setAttribute('aria-current', index === activeQuestion ? 'step' : 'false');
    });
    document.getElementById('question-position').textContent = (activeQuestion + 1) + ' / ' + assessmentQuestions.length;
    document.getElementById('previous-question').disabled = activeQuestion === 0;
    document.getElementById('next-question').disabled = activeQuestion === assessmentQuestions.length - 1;
    document.getElementById('focus-view').setAttribute('aria-pressed', String(!allQuestions));
    document.getElementById('all-view').setAttribute('aria-pressed', String(allQuestions));
    document.getElementById('screen2').classList.toggle('focus-mode', !allQuestions);
  }

  function completeSession() {
    finishedAt = Date.now();
    clearInterval(timerInterval);
    saveSession();
  }

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
      tables.forEach(function (tableName, tableIdx) {
        var cols = schema.tables[tableName] || [];
        html += '<div class="schema-table-panel" data-table="' + escapeHtml(tableName) + '">';
        html += '<button class="schema-table-toggle" data-table-toggle="' + escapeHtml(tableName) + '" aria-expanded="false">';
        html += '<span class="schema-table-name">' + escapeHtml(tableName) + '</span>';
        html += '<span class="schema-table-toggle-icon">&#9662;</span>';
        html += '</button>';
        html += '<span class="schema-table-cols">';
        cols.forEach(function (c) {
          html += '<code>' + escapeHtml(c) + '</code>';
        });
        html += '</span>';
        html += '<div id="table-preview-' + tableIdx + '" class="schema-table-preview hidden" data-preview-table="' + escapeHtml(tableName) + '">';
        html += '<div class="schema-table-preview-loading text-muted">Expand to load preview...</div>';
        html += '</div>';
        html += '</div>';
      });
      html += '</div>';
    }

    container.innerHTML = html;
    container.querySelectorAll('.schema-table-panel').forEach(function (panel) {
      var tableName = panel.dataset.table;
      var detail = schema.details[tableName];
      var columns = panel.querySelector('.schema-table-cols');
      columns.replaceChildren();
      var description = document.createElement('p');
      description.textContent = detail.description || '';
      columns.appendChild(description);
      detail.columns.forEach(function (column) {
        var row = document.createElement('div');
        row.className = 'column-detail';
        var name = document.createElement('code');
        name.textContent = column.name;
        var type = document.createElement('span');
        type.textContent = column.type + (column.primaryKey ? ' PK' : '') + (column.nullable ? ' nullable' : '');
        row.appendChild(name);
        row.appendChild(type);
        row.appendChild(iconButton('Code', 'Insert ' + column.name + ' into current answer', function () { editors[assessmentQuestions[activeQuestion].id].insert(quoteIdent(column.name)); }));
        if (column.description) { var explanation = document.createElement('p'); explanation.textContent = column.description; row.appendChild(explanation); }
        columns.appendChild(row);
      });
      detail.foreignKeys.forEach(function (relation) {
        var link = document.createElement('p');
        link.className = 'schema-relation';
        link.textContent = relation.from + ' -> ' + relation.table + '.' + (relation.to || '(primary key)');
        columns.appendChild(link);
      });
      var actions = document.createElement('div');
      actions.className = 'schema-actions';
      actions.appendChild(iconButton('Code', 'Insert table name into current answer', function () { editors[assessmentQuestions[activeQuestion].id].insert(quoteIdent(tableName)); }));
      actions.appendChild(iconButton('Play', 'Open preview query in playground', function () {
        if (editors.playground.getContent().trim() && !window.confirm('Replace the playground draft with a table preview query?')) return;
        editors.playground.setContent('SELECT * FROM ' + quoteIdent(tableName) + ' LIMIT 100;');
        editors.playground.view.focus();
      }));
      columns.appendChild(actions);
    });

    container.querySelectorAll('[data-table-toggle]').forEach(function (toggleBtn) {
      toggleBtn.addEventListener('click', function () {
        var tableName = toggleBtn.getAttribute('data-table-toggle');
        var panel = toggleBtn.closest('.schema-table-panel');
        if (!panel || !tableName) return;
        var preview = panel.querySelector('.schema-table-preview');
        if (!preview) return;

        var isHidden = preview.classList.toggle('hidden');
        toggleBtn.setAttribute('aria-expanded', isHidden ? 'false' : 'true');
        if (isHidden) {
          panel.classList.remove('expanded');
          return;
        }

        panel.classList.add('expanded');
        if (!tablePreviewState[tableName] || !tablePreviewState[tableName].loaded) {
          preview.innerHTML = '<div class="schema-table-preview-loading text-muted">Loading preview...</div>';
          loadTablePreview(tableName, preview);
        } else {
          var cached = tablePreviewState[tableName];
          renderResultsTable(preview, cached.rows, cached.columns, {
            pageSize: 6,
            summaryText: (cached.rowCount || cached.rows.length) + ' row' + ((cached.rowCount || cached.rows.length) !== 1 ? 's' : '') + ' total'
          });
        }
      });
    });

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

  function quoteIdent(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
  }

  async function loadTablePreview(tableName, previewEl) {
    if (!previewEl) return;
    if (!db) {
      previewEl.innerHTML = '<p class="no-results">Database not yet initialized.</p>';
      return;
    }

    if (busy) { previewEl.textContent = 'A query is running. Close and reopen this table afterward.'; return; }
    setBusy(true);
    try {
      var rowCount = schema.details[tableName].rowCount;
      var tableResult = await execSQL('SELECT * FROM ' + quoteIdent(tableName) + ' LIMIT 100');

      tablePreviewState[tableName] = {
        loaded: true,
        rows: tableResult.rows,
        columns: tableResult.columns,
        rowCount: rowCount
      };

      renderResultsTable(previewEl, tableResult.rows, tableResult.columns, {
        pageSize: 6,
        summaryText: rowCount + ' rows total; preview of ' + tableResult.rows.length
      });
    } catch (err) {
      previewEl.innerHTML = '<p class="no-results">Unable to preview table: ' + escapeHtml(err.message) + '</p>';
      await recoverWorker(err);
    } finally {
      setBusy(false);
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
  // Vertical resize handle for schema section (right panel)
  // ============================================================
  function wireSchemaResizeHandle() {
    var handle = document.getElementById('schema-resize-handle');
    var section = document.getElementById('playground-schema-section');
    var rightPanel = document.getElementById('right-panel');
    if (!handle || !section || !rightPanel) return;

    var isDragging = false;

    handle.addEventListener('mousedown', function (e) {
      if (section.classList.contains('collapsed')) return;
      isDragging = true;
      handle.classList.add('dragging');
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      if (!isDragging) return;
      var sectionRect = section.getBoundingClientRect();
      var panelRect = rightPanel.getBoundingClientRect();
      var proposedHeight = e.clientY - sectionRect.top;
      var minHeight = 80;
      var maxHeight = Math.max(minHeight, Math.floor(panelRect.height * 0.7));
      var newHeight = Math.max(minHeight, Math.min(maxHeight, proposedHeight));
      section.style.height = newHeight + 'px';
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
  // SQLite function reference — popover overlay
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

  function wireFnRefPopup() {
    var openBtn   = document.getElementById('fn-ref-open-btn');
    var popover   = document.getElementById('fn-ref-popover');
    var closeBtn  = document.getElementById('fn-ref-close-btn');
    var pinBtn    = document.getElementById('fn-ref-pin-btn');
    var bodyWrap  = document.getElementById('fn-ref-body-wrap');
    var search    = document.getElementById('fn-ref-search');
    var body      = document.getElementById('fn-ref-body');
    var isPinned  = false;

    if (!openBtn || !popover || !closeBtn || !pinBtn || !bodyWrap || !search || !body) return;

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

    function setPinned(nextPinned) {
      isPinned = !!nextPinned;
      pinBtn.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
      pinBtn.textContent = isPinned ? 'Unpin' : 'Pin';
      pinBtn.classList.toggle('active', isPinned);
    }

    function openPopover() {
      popover.classList.remove('hidden');
      openBtn.setAttribute('aria-expanded', 'true');
      renderFnRef(search.value);
      search.focus();
    }

    function closePopover() {
      popover.classList.add('hidden');
      openBtn.setAttribute('aria-expanded', 'false');
    }

    openBtn.addEventListener('click', function () {
      if (popover.classList.contains('hidden')) {
        openPopover();
      } else {
        closePopover();
      }
    });

    closeBtn.addEventListener('click', function () {
      closePopover();
    });

    pinBtn.addEventListener('click', function () {
      setPinned(!isPinned);
    });

    popover.addEventListener('click', function (e) {
      e.stopPropagation();
    });

    document.addEventListener('click', function (e) {
      if (popover.classList.contains('hidden') || isPinned) return;
      if (e.target === openBtn || openBtn.contains(e.target)) return;
      if (!popover.contains(e.target)) {
        closePopover();
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !popover.classList.contains('hidden')) {
        closePopover();
      }
    });

    search.addEventListener('input', function () {
      renderFnRef(search.value);
    });

    setPinned(false);
    renderFnRef('');
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
    renderAttemptHistory('playground');
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
      saveSession();
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
    if (busy) return;
    var summary = document.getElementById('finish-summary');
    summary.replaceChildren();
    questions.forEach(function (question, index) {
      refreshQuestion(question.id);
      var row = document.createElement('div');
      row.className = 'finish-row';
      var link = document.createElement('button');
      link.textContent = 'Question ' + (index + 1) + ': ' + (questionStatuses[question.id] || 'not attempted');
      link.onclick = function () { document.getElementById('finish-dialog').close(); activeQuestion = index; allQuestions = false; updateWorkspace(); editors[question.id].view.focus(); };
      row.appendChild(link);
      if (questionStatuses[question.id] === 'changed') {
        var restore = document.createElement('button');
        restore.textContent = 'Use last executed SQL';
        restore.onclick = function () { editors[question.id].setContent(executions[question.id].sql); finishWork(questions, moduleTitle, moduleVersion); };
        row.appendChild(restore);
      }
      summary.appendChild(row);
    });
    var dialog = document.getElementById('finish-dialog');
    if (!dialog.open) dialog.showModal();
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
    html += '<h2>Interviewer Scorecard</h2><table><tr><th>Question</th><th>Difficulty / topics</th><th>Status</th><th>Recorded runs</th></tr>';
    questions.forEach(function (question, index) {
      html += '<tr><td>Q' + (index + 1) + '</td><td>' + escapeHtml([question.difficulty || '', (question.tags || []).join(', ')].join(' ')) + '</td><td>' + escapeHtml(questionStatuses[question.id] || 'not attempted') + '</td><td>' + (attempts[question.id] || []).length + '</td></tr>';
    });
    html += '</table><h3>Reviewer notes</h3><div contenteditable="true" role="textbox" aria-label="Reviewer notes" style="min-height:5rem;border:1px solid #aaa;padding:0.5rem"></div>';

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
      else if (status === 'changed')       { badgeText = 'EDITED SINCE LAST RUN - UNGRADED'; }
      else if (status === 'draft')         { badgeText = 'NOT RUN - UNGRADED'; }

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

      var record = executions[q.id];
      if (record) {
        html += '<p><strong>Last execution:</strong> ' + escapeHtml(record.at) + ' | ' + escapeHtml(record.message || record.status) + '</p>';
        if (status === 'changed') html += '<p><strong>Previously executed SQL (not the current submission):</strong></p><pre>' + escapeHtml(record.sql) + '</pre>';
        if (record.truncated) html += '<p>Result sample: ' + record.rows.length + ' of ' + record.rowCount + ' rows. Grading used the complete result.</p>';
        html += reportResultsHTML(document.getElementById('results-' + q.id));
      }
      var history = attempts[q.id] || [];
      if (history.length) {
        html += '<details><summary>Recent execution history (up to 20 runs)</summary>';
        history.forEach(function (attempt) { html += '<p>' + escapeHtml(attempt.at + ' - ' + attempt.status) + '</p><pre>' + escapeHtml(attempt.sql) + '</pre>'; });
        html += '</details>';
      }
      html += '</div>';
    });

    // Playground query history — successful queries only, at the END
    html += '<div class="playground-section">';
    html += '<h2>Playground Queries</h2>';
    html += '<div class="section">';
    if (!(attempts.playground || []).length) {
      html += '<p><em>No playground queries recorded.</em></p>';
    } else {
      attempts.playground.forEach(function (attempt, i) {
        html += '<h3>Query ' + (i + 1) + '</h3>';
        html += '<p>' + escapeHtml(attempt.status) + '</p><pre>' + escapeHtml(attempt.sql) + '</pre>';
      });
    }
    html += '</div></div>';

    html += '</body></html>';

    downloadFile(html, 'text/html', 'results.html');

    // Show a brief success toast regardless of pop-up blocker state.
    var toast = document.createElement('div');
    toast.style.cssText = [
      'position:fixed', 'bottom:1.5rem', 'left:50%', 'transform:translateX(-50%)',
      'background:#1a5276', 'color:#fff', 'text-align:center',
      'padding:0.75rem 1.25rem', 'border-radius:6px', 'font-size:0.9rem',
      'z-index:10000', 'line-height:1.4', 'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
      'transition:opacity 0.5s'
    ].join(';');
    toast.textContent = 'Report download requested. Keep the report and share it with your recruiter.';
    document.body.appendChild(toast);
    setTimeout(function () { toast.style.opacity = '0'; }, 6000);
    setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 6600);

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
  function renderResultsTable(container, rows, columnNames, options) {
    options = options || {};
    container.innerHTML = '';

    // Store data on the element for the report generator
    container._tableData = { rows: rows, columns: columnNames };

    if (!columnNames || columnNames.length === 0) {
      container.innerHTML = '<p class="no-results">Query executed successfully. No rows returned.</p>';
      return;
    }

    var PAGE_SIZE = options.pageSize || 10;
    var currentPage = 0;
    var sortCol  = -1;
    var sortDir  = 'asc';  // 'asc' | 'desc'
    var sortedRows = rows.slice();  // working copy

    // Summary
    var summary = document.createElement('div');
    summary.className = 'results-summary';
    summary.textContent = options.summaryText || (options.truncated ? 'Showing ' + rows.length + (options.rowCount ? ' of ' + options.rowCount : '+') + ' rows (sample)' : rows.length + ' row' + (rows.length !== 1 ? 's' : '') + ' returned');
    container.appendChild(summary);
    var actions = document.createElement('div');
    actions.className = 'result-actions';
    function csv() {
      return [columnNames].concat(rows).map(function (row) {
        return row.map(function (value) {
          if (value === null || value === undefined) return '';
          var text = String(value);
          if (typeof value === 'string' && /^[=+@\-\t\r]/.test(text)) text = "'" + text;
          return '"' + text.replace(/"/g, '""') + '"';
        }).join(',');
      }).join('\r\n');
    }
    actions.appendChild(iconButton('Copy', 'Copy displayed result data as CSV', async function () {
      try { await navigator.clipboard.writeText(csv()); summary.textContent = 'Result data copied'; }
      catch (error) { summary.textContent = 'Clipboard unavailable. Use Download CSV.'; }
    }));
    actions.appendChild(iconButton('Download', 'Download displayed result data as CSV', function () { downloadFile(csv(), 'text/csv', options.truncated ? 'result-sample.csv' : 'results.csv'); }));
    container.appendChild(actions);

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
      var resize = document.createElement('span');
      resize.className = 'column-resize';
      resize.setAttribute('role', 'separator');
      resize.setAttribute('aria-label', 'Resize ' + col);
      resize.setAttribute('aria-orientation', 'vertical');
      resize.tabIndex = 0;
      resize.addEventListener('click', function (event) { event.stopPropagation(); });
      resize.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault(); event.stopPropagation();
        th.style.minWidth = Math.max(80, th.offsetWidth + (event.key === 'ArrowRight' ? 20 : -20)) + 'px';
      });
      resize.addEventListener('pointerdown', function (event) {
        event.preventDefault(); event.stopPropagation();
        var start = event.clientX;
        var width = th.offsetWidth;
        resize.setPointerCapture(event.pointerId);
        resize.onpointermove = function (move) { th.style.minWidth = Math.max(80, width + move.clientX - start) + 'px'; };
        resize.onpointerup = function () { resize.onpointermove = null; };
      });
      th.appendChild(resize);

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
              var expand = document.createElement('button');
              expand.className = 'cell-expand';
              expand.textContent = str.substring(0, 200) + '...';
              expand.title = 'Expand full cell value';
              expand.addEventListener('click', function () {
                var expanded = this.getAttribute('aria-expanded') === 'true';
                this.setAttribute('aria-expanded', String(!expanded));
                this.textContent = expanded ? str.substring(0, 200) + '...' : str;
              });
              td.appendChild(expand);
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
