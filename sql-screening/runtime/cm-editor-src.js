import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { sql, SQLite } from '@codemirror/lang-sql';
import { closeBrackets, closeBracketsKeymap, autocompletion } from '@codemirror/autocomplete';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { format } from 'sql-formatter';
import initSqlJs from 'sql.js';

/**
 * Dark theme — editor chrome (gutters, selection, cursor, tooltips).
 */
const darkTheme = EditorView.theme(
  {
    '&': {
      color: '#e8e8e8',
      backgroundColor: '#1e1e1e',
      height: '100%',
    },
    '.cm-content': {
      caretColor: '#4a9eff',
      fontFamily: "'Fira Code', 'Cascadia Code', 'Consolas', 'Menlo', monospace",
      fontSize: '13px',
      padding: '4px 0',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#4a9eff',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: '#1e3a5f',
    },
    '.cm-gutters': {
      backgroundColor: '#1a1a1a',
      color: '#555',
      border: 'none',
      borderRight: '1px solid #2c2c2c',
    },
    '.cm-activeLineGutter': {
      backgroundColor: '#252525',
    },
    '.cm-activeLine': {
      backgroundColor: '#252525',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 8px 0 4px',
      minWidth: '32px',
    },
    '.cm-tooltip': {
      backgroundColor: '#2c2c2c',
      border: '1px solid #3a3a3a',
      color: '#e8e8e8',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: '#1e3a5f',
      color: '#e8e8e8',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
      padding: '2px 8px',
    },
  },
  { dark: true }
);

/**
 * Light theme — editor chrome.
 */
const lightTheme = EditorView.theme(
  {
    '&': {
      color: '#1a1a1a',
      backgroundColor: '#f5f3ee',
      height: '100%',
    },
    '.cm-content': {
      caretColor: '#1a5fba',
      fontFamily: "'Fira Code', 'Cascadia Code', 'Consolas', 'Menlo', monospace",
      fontSize: '13px',
      padding: '4px 0',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#1a5fba',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: '#b8d0f0',
    },
    '.cm-gutters': {
      backgroundColor: '#ece9e4',
      color: '#999',
      border: 'none',
      borderRight: '1px solid #d5d1cb',
    },
    '.cm-activeLineGutter': {
      backgroundColor: '#e0ddd8',
    },
    '.cm-activeLine': {
      backgroundColor: '#e8e5e0',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 8px 0 4px',
      minWidth: '32px',
    },
    '.cm-tooltip': {
      backgroundColor: '#f0ede8',
      border: '1px solid #c5c1bb',
      color: '#1a1a1a',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: '#b8d0f0',
      color: '#1a1a1a',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
      padding: '2px 8px',
    },
  },
  { dark: false }
);

/**
 * Dark syntax token colors via CM6 HighlightStyle.
 */
const darkHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword,             color: '#569cd6' },
  { tag: tags.operator,            color: '#d4d4d4' },
  { tag: tags.number,              color: '#b5cea8' },
  { tag: tags.string,              color: '#ce9178' },
  { tag: tags.comment,             color: '#6a9955', fontStyle: 'italic' },
  { tag: tags.typeName,            color: '#4ec9b0' },
  { tag: tags.name,                color: '#9cdcfe' },
  { tag: tags.variableName,        color: '#9cdcfe' },
  { tag: tags.propertyName,        color: '#9cdcfe' },
  { tag: tags.punctuation,         color: '#d4d4d4' },
  { tag: tags.null,                color: '#569cd6' },
  { tag: tags.bool,                color: '#569cd6' },
  { tag: tags.special(tags.name),  color: '#dcdcaa' },
]);

/**
 * Light syntax token colors — VS Code Light+ palette.
 */
const lightHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword,             color: '#0000ff' },
  { tag: tags.operator,            color: '#333333' },
  { tag: tags.number,              color: '#098658' },
  { tag: tags.string,              color: '#a31515' },
  { tag: tags.comment,             color: '#008000', fontStyle: 'italic' },
  { tag: tags.typeName,            color: '#267f99' },
  { tag: tags.name,                color: '#001080' },
  { tag: tags.variableName,        color: '#001080' },
  { tag: tags.propertyName,        color: '#001080' },
  { tag: tags.punctuation,         color: '#333333' },
  { tag: tags.null,                color: '#0000ff' },
  { tag: tags.bool,                color: '#0000ff' },
  { tag: tags.special(tags.name),  color: '#795e26' },
]);

/**
 * Format the given SQL string using sql-formatter.
 */
function formatSQL(sqlText) {
  try {
    return format(sqlText, { language: 'sqlite', tabWidth: 2 });
  } catch (e) {
    return sqlText;
  }
}

/**
 * createEditor — factory function for CodeMirror 6 SQL editors.
 *
 * @param {HTMLElement} container
 * @param {object}      options
 *   options.schema    {tables: {tableName: [col1, col2, ...]}}
 *   options.onFormat  optional callback called after formatting
 *   options.readOnly  boolean (default false)
 *   options.dark      boolean (default false — light mode)
 *
 * @returns {{ view, getContent, setContent, format, setTheme }}
 */
function createEditor(container, options) {
  options = options || {};

  var schema = options.schema || { tables: {} };
  var readOnly = !!options.readOnly;

  var sqlSchema = {};
  if (schema && schema.tables) {
    Object.keys(schema.tables).forEach(function (tableName) {
      sqlSchema[tableName] = schema.tables[tableName];
    });
  }

  var readOnlyCompartment = new Compartment();
  var themeCompartment    = new Compartment();
  var highlightCompartment = new Compartment();

  var twoSpacesKeymap = {
    key: 'Tab',
    run: function (view) {
      view.dispatch(view.state.replaceSelection('  '));
      return true;
    },
  };

  var formatKeymap = {
    key: 'Shift-Alt-f',
    run: function (view) {
      doFormat(view);
      return true;
    },
  };

  function doFormat(view) {
    var current = view.state.doc.toString();
    var formatted = formatSQL(current);
    if (formatted !== current) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: formatted },
      });
    }
    if (options.onFormat) {
      options.onFormat(formatted);
    }
  }

  var isDark = !!options.dark;

  var extensions = [
    history(),
    lineNumbers(),
    highlightActiveLine(),
    closeBrackets(),
    autocompletion(),
    keymap.of([
      twoSpacesKeymap,
      formatKeymap,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    sql({
      dialect: SQLite,
      schema: sqlSchema,
    }),
    themeCompartment.of(isDark ? darkTheme : lightTheme),
    highlightCompartment.of(syntaxHighlighting(isDark ? darkHighlightStyle : lightHighlightStyle)),
    EditorView.lineWrapping,
    readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
  ];

  var startDoc =
    options.initialContent !== undefined ? options.initialContent : '';

  var state = EditorState.create({
    doc: startDoc,
    extensions: extensions,
  });

  var view = new EditorView({
    state: state,
    parent: container,
  });

  container.addEventListener('click', function (e) {
    if (!view.dom.contains(e.target)) {
      view.focus();
    }
  });

  function getContent() {
    return view.state.doc.toString();
  }

  function setContent(text) {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text || '' },
    });
  }

  function doFormatPublic() {
    doFormat(view);
  }

  function setTheme(dark) {
    view.dispatch({
      effects: [
        themeCompartment.reconfigure(dark ? darkTheme : lightTheme),
        highlightCompartment.reconfigure(
          syntaxHighlighting(dark ? darkHighlightStyle : lightHighlightStyle)
        ),
      ],
    });
  }

  return {
    view: view,
    getContent: getContent,
    setContent: setContent,
    format: doFormatPublic,
    setTheme: setTheme,
  };
}

// Expose as window global so app.js can call CMEditor.createEditor / CMEditor.initSqlJs
if (typeof window !== 'undefined') {
  window.CMEditor = {
    createEditor: createEditor,
    initSqlJs: initSqlJs,
  };
}

export { createEditor, initSqlJs };
