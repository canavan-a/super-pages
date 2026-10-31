// The page editor, in plain DOM: TipTap (ProseMirror) with markdown in and
// out, so pages are stored as markdown but nobody types or sees its syntax.
// The browser build mounts it straight into the page (DocEditor.web.tsx);
// the Android app runs the same code inside a WebView (native-entry.ts,
// bundled by scripts/build-editor.mjs).
//
// Pages are edited together: the editor is bound to a shared Yjs document
// (the text, and the title beside it), and hands out the changes made here
// and other tabs' cursors as bytes for the app to seal and relay (live.ts).
import {AnyExtension, Editor, Extension} from '@tiptap/core';
import {Collaboration, isChangeOrigin} from '@tiptap/extension-collaboration';
import {CollaborationCaret} from '@tiptap/extension-collaboration-caret';
import Image from '@tiptap/extension-image';
import {TaskItem, TaskList} from '@tiptap/extension-list';
import {Placeholder} from '@tiptap/extensions';
import {Markdown} from '@tiptap/markdown';
import {Selection} from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import {prosemirrorJSONToYXmlFragment} from '@tiptap/y-tiptap';
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';

export interface EditorColors {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textMuted: string;
  primary: string;
  primaryText: string;
  codeBg: string;
  inlineCodeBg: string;
}

/** Who this tab is to the others: the name on its cursor, and its color. */
export interface EditorUser {
  name: string;
  color: string;
  tab: string;
}

export interface Peer {
  tab: string;
  /** Its awareness update (cursor), b64url; null if it hasn't sent one. */
  aware: string | null;
}

export interface Snapshot {
  markdown: string;
  title: string;
  /** The whole shared state, b64url. */
  y: string;
}

export interface EditorOptions {
  el: HTMLElement;
  markdown: string;
  /** The shared state to start from (b64url), or null for a page saved as markdown only. */
  y: string | null;
  /** The saved title, for a page saved as markdown only. */
  title: string;
  user: EditorUser;
  readOnly: boolean;
  colors: EditorColors;
  /** Turns an sp-img: URL into something an <img> can show (a data: URI). */
  resolveImage: (url: string) => Promise<string>;
  /** The page changed; local is false when it was someone else's change. */
  onChange: (markdown: string, local: boolean) => void;
  /** Someone else renamed the page. */
  onTitle?: (title: string) => void;
  /** A change made here (a Yjs update, b64url), to send to the others. */
  onLocalChange?: (update: string) => void;
  /** This tab's cursor moved (an awareness update, b64url). */
  onAware?: (aware: string) => void;
  /** The toolbar's image button: pick, encrypt and upload, then insertImage. */
  onPickImage: () => void;
  /** A link was tapped (links don't navigate the editor). */
  onOpenLink?: (href: string) => void;
}

export interface EditorHandle {
  setEditable(editable: boolean): void;
  setColors(colors: EditorColors): void;
  insertImage(url: string, alt?: string): void;
  getMarkdown(): string;
  /** Others' changes (b64url Yjs updates); also how a saved state is merged in. */
  applyChanges(updates: string[]): void;
  /** Who else has the page open, with their cursors. */
  setPeers(peers: Peer[]): void;
  setTitle(title: string): void;
  snapshot(): Snapshot;
  focus(): void;
  destroy(): void;
}

/**
 * Images in a page are sp-img: links to encrypted blobs. Anything else (a
 * pasted http image) isn't loaded at all: a remote image would tell its
 * server who opened the page and when.
 */
function secureImage(resolve: (url: string) => Promise<string>) {
  return Image.extend({
    addNodeView() {
      return ({node}) => {
        const wrap = document.createElement('figure');
        wrap.className = 'sp-figure';
        const img = document.createElement('img');
        img.alt = node.attrs.alt ?? '';
        img.draggable = false;
        wrap.appendChild(img);
        const src: string = node.attrs.src ?? '';
        if (src.startsWith('sp-img:')) {
          wrap.classList.add('loading');
          resolve(src)
            .then(uri => {
              img.src = uri;
              wrap.classList.remove('loading');
            })
            .catch(() => {
              wrap.classList.remove('loading');
              wrap.classList.add('broken');
            });
        } else if (src.startsWith('data:image/')) {
          img.src = src;
        } else {
          wrap.classList.add('broken');
        }
        return {dom: wrap};
      };
    },
  }).configure({inline: false, allowBase64: false});
}

type Btn = {
  label: string;
  title: string;
  run: (e: Editor) => void;
  active?: (e: Editor) => boolean;
};

const BUTTONS: (Btn | '|')[] = [
  {
    label: 'H1',
    title: 'Big heading',
    run: e => e.chain().focus().toggleHeading({level: 1}).run(),
    active: e => e.isActive('heading', {level: 1}),
  },
  {
    label: 'H2',
    title: 'Heading',
    run: e => e.chain().focus().toggleHeading({level: 2}).run(),
    active: e => e.isActive('heading', {level: 2}),
  },
  '|',
  {
    label: '<b>B</b>',
    title: 'Bold',
    run: e => e.chain().focus().toggleBold().run(),
    active: e => e.isActive('bold'),
  },
  {
    label: '<i>I</i>',
    title: 'Italic',
    run: e => e.chain().focus().toggleItalic().run(),
    active: e => e.isActive('italic'),
  },
  {
    label: '<s>S</s>',
    title: 'Strikethrough',
    run: e => e.chain().focus().toggleStrike().run(),
    active: e => e.isActive('strike'),
  },
  '|',
  {
    label: '•',
    title: 'Bulleted list',
    run: e => e.chain().focus().toggleBulletList().run(),
    active: e => e.isActive('bulletList'),
  },
  {
    label: '1.',
    title: 'Numbered list',
    run: e => e.chain().focus().toggleOrderedList().run(),
    active: e => e.isActive('orderedList'),
  },
  {
    label: '☑',
    title: 'Checklist',
    run: e => e.chain().focus().toggleTaskList().run(),
    active: e => e.isActive('taskList'),
  },
  {
    label: '❝',
    title: 'Quote',
    run: e => e.chain().focus().toggleBlockquote().run(),
    active: e => e.isActive('blockquote'),
  },
  {
    label: '&lt;/&gt;',
    title: 'Code',
    run: e => e.chain().focus().toggleCodeBlock().run(),
    active: e => e.isActive('codeBlock'),
  },
  {
    label: '—',
    title: 'Divider',
    run: e => e.chain().focus().setHorizontalRule().run(),
  },
];

function css(c: EditorColors): string {
  return `
.sp-editor { --bg:${c.bg}; --surface:${c.surface}; --surface-alt:${c.surfaceAlt}; --border:${c.border}; --text:${c.text};
  --muted:${c.textMuted}; --primary:${c.primary}; --primary-text:${c.primaryText}; --code-bg:${c.codeBg}; --inline-code:${c.inlineCodeBg}; }`;
}

const BASE_CSS = `
.sp-editor { display:flex; flex-direction:column; height:100%; background:var(--bg); color:var(--text);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.sp-toolbar { display:flex; gap:2px; padding:6px 8px; border-bottom:1px solid var(--border); overflow-x:auto;
  background:var(--surface); flex-shrink:0; scrollbar-width:none; }
.sp-toolbar::-webkit-scrollbar { display:none; }
.sp-toolbar button { min-width:36px; height:34px; padding:0 8px; border:0; border-radius:7px; background:transparent;
  color:var(--muted); font:600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; cursor:pointer; flex-shrink:0; }
.sp-toolbar button:hover { background:var(--surface-alt); color:var(--text); }
.sp-toolbar button.on { background:var(--primary); color:var(--primary-text); }
.sp-toolbar .sep { width:1px; margin:6px 4px; background:var(--border); flex-shrink:0; }
.sp-scroll { flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch; }
.sp-editor .ProseMirror { tab-size:4; max-width:760px; margin:0 auto; padding:20px 20px 120px; outline:none; min-height:100%;
  box-sizing:border-box; word-wrap:break-word; }
.ProseMirror > * + * { margin-top:0.6em; }
.ProseMirror h1 { font-size:1.9em; line-height:1.2; margin:0.2em 0 0.4em; font-weight:800; }
.ProseMirror h2 { font-size:1.4em; line-height:1.3; margin-top:1.1em; font-weight:700; }
.ProseMirror h3 { font-size:1.15em; margin-top:1em; font-weight:700; }
.ProseMirror p { margin:0; }
.ProseMirror a { color:var(--primary); }
.ProseMirror ul, .ProseMirror ol { padding-left:1.4em; margin:0.4em 0; }
.ProseMirror blockquote { border-left:3px solid var(--border); margin:0.6em 0; padding-left:1em; color:var(--muted); }
.ProseMirror code { background:var(--inline-code); border-radius:4px; padding:0.1em 0.35em; font-size:0.9em;
  font-family: ui-monospace, Menlo, Consolas, monospace; }
.ProseMirror pre { background:var(--code-bg); border:1px solid var(--border); border-radius:8px; padding:12px 14px;
  overflow-x:auto; font-size:0.9em; }
.ProseMirror pre code { background:none; padding:0; }
.ProseMirror hr { border:0; border-top:1px solid var(--border); margin:1.4em 0; }
.ProseMirror ul[data-type="taskList"] { list-style:none; padding-left:0.2em; }
.ProseMirror ul[data-type="taskList"] li { display:flex; gap:0.5em; align-items:flex-start; }
.ProseMirror ul[data-type="taskList"] li > label { margin-top:0.25em; user-select:none; }
.ProseMirror ul[data-type="taskList"] li > label input { width:1.05em; height:1.05em; accent-color:var(--primary); }
.ProseMirror ul[data-type="taskList"] li > div { flex:1; }
.ProseMirror ul[data-type="taskList"] li[data-checked="true"] > div { color:var(--muted); text-decoration:line-through; }
.ProseMirror .sp-figure { margin:0.8em 0; text-align:center; }
.ProseMirror .sp-figure img { max-width:100%; border-radius:8px; display:inline-block; }
.ProseMirror .sp-figure.loading { min-height:120px; border-radius:8px; background:var(--surface);
  animation: sp-pulse 1.2s ease-in-out infinite; }
.ProseMirror .sp-figure.broken { min-height:60px; border:1px dashed var(--border); border-radius:8px; }
.ProseMirror .sp-figure.broken::after { content:"Image unavailable"; color:var(--muted); font-size:0.85em; line-height:60px; }
.ProseMirror .ProseMirror-selectednode img { outline:2px solid var(--primary); }
.ProseMirror p.is-empty::before, .ProseMirror h1.is-empty::before, .ProseMirror h2.is-empty::before {
  content:attr(data-placeholder); color:var(--muted); opacity:0.6; float:left; height:0; pointer-events:none; }
@keyframes sp-pulse { 50% { opacity:0.5; } }
.sp-caret { position:relative; margin-left:-1px; margin-right:-1px; border-left:2px solid; word-break:normal; }
.sp-caret::before { content:""; position:absolute; left:-7px; right:-7px; top:-2px; bottom:-2px; }
.sp-caret-label { position:absolute; left:-2px; bottom:100%; padding:1px 6px; border-radius:5px 5px 5px 0; color:#fff;
  font:600 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; white-space:nowrap;
  user-select:none; pointer-events:none; opacity:0; transform:translateY(3px); transition:opacity .12s, transform .12s; z-index:2; }
.sp-caret:hover .sp-caret-label { opacity:1; transform:none; }
`;

const REMOTE = 'remote';
const LOAD = 'load';

const toB64 = (u: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000)
    s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64 = (s: string): Uint8Array => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};

/**
 * Tab writes, as in a word processor, instead of leaving the page: in a list
 * it indents the item (Shift-Tab outdents), anywhere else it types a tab
 * (Shift-Tab takes back one just before the cursor).
 */
const TabKey = Extension.create({
  name: 'spTab',
  addKeyboardShortcuts() {
    return {
      Tab: ({editor}) => {
        if (!editor.isEditable) return false;
        if (editor.isActive('listItem') || editor.isActive('taskItem')) {
          // Can't go deeper (the first item): stay put, keep focus.
          editor.commands.sinkListItem(
            editor.isActive('taskItem') ? 'taskItem' : 'listItem',
          );
          return true;
        }
        return editor.commands.insertContent('\t');
      },
      'Shift-Tab': ({editor}) => {
        if (!editor.isEditable) return false;
        if (editor.isActive('listItem') || editor.isActive('taskItem')) {
          editor.commands.liftListItem(
            editor.isActive('taskItem') ? 'taskItem' : 'listItem',
          );
          return true;
        }
        const {empty, from} = editor.state.selection;
        if (
          empty &&
          from > 0 &&
          editor.state.doc.textBetween(from - 1, from) === '\t'
        )
          editor.commands.deleteRange({from: from - 1, to: from});
        return true;
      },
    };
  },
});

const baseExtensions = (): AnyExtension[] => [
  // Collaboration brings its own undo history.
  StarterKit.configure({
    link: {openOnClick: false, autolink: true},
    undoRedo: false,
  }),
  Markdown,
  TaskList,
  TaskItem.configure({nested: true}),
  TabKey,
];

/**
 * The shared state for a page saved as markdown only. Every tab that opens
 * such a page builds it the same way, under the same fixed client id, so the
 * copies are identical and merge into one rather than doubling the text.
 */
function seedState(markdown: string, title: string): Uint8Array {
  const tmp = new Editor({
    extensions: [
      ...baseExtensions(),
      Image.configure({inline: false, allowBase64: false}),
    ],
    content: markdown,
    contentType: 'markdown',
  });
  const json = tmp.getJSON();
  const schema = tmp.schema;
  tmp.destroy();
  const d = new Y.Doc();
  d.clientID = 1;
  prosemirrorJSONToYXmlFragment(schema, json, d.getXmlFragment('default'));
  if (title) d.getText('title').insert(0, title);
  const out = Y.encodeStateAsUpdate(d);
  d.destroy();
  return out;
}

export function mountEditor(o: EditorOptions): EditorHandle {
  o.el.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'sp-editor';
  const style = document.createElement('style');
  style.textContent = BASE_CSS + css(o.colors);
  root.appendChild(style);

  const toolbar = document.createElement('div');
  toolbar.className = 'sp-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  const scroll = document.createElement('div');
  scroll.className = 'sp-scroll';
  const host = document.createElement('div');
  scroll.appendChild(host);
  root.appendChild(toolbar);
  root.appendChild(scroll);
  o.el.appendChild(root);

  const ydoc = new Y.Doc();
  Y.applyUpdate(
    ydoc,
    o.y ? fromB64(o.y) : seedState(o.markdown, o.title),
    LOAD,
  );
  const ytitle = ydoc.getText('title');
  const awareness = new Awareness(ydoc);
  awareness.setLocalStateField('tab', o.user.tab);

  ydoc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE && origin !== LOAD) o.onLocalChange?.(toB64(u));
  });
  ytitle.observe(ev => {
    if (ev.transaction.origin === REMOTE) o.onTitle?.(ytitle.toString());
  });
  awareness.on(
    'update',
    (
      {added, updated}: {added: number[]; updated: number[]},
      origin: unknown,
    ) => {
      if (
        origin === 'local' &&
        [...added, ...updated].includes(awareness.clientID)
      )
        o.onAware?.(
          toB64(encodeAwarenessUpdate(awareness, [awareness.clientID])),
        );
    },
  );

  const editor = new Editor({
    element: host,
    editable: !o.readOnly,
    extensions: [
      ...baseExtensions(),
      secureImage(o.resolveImage),
      Collaboration.configure({document: ydoc}),
      CollaborationCaret.configure({
        provider: {awareness},
        user: {name: o.user.name.slice(0, 60), color: o.user.color},
        // The name shows when the cursor is hovered.
        render: user => {
          const caret = document.createElement('span');
          caret.className = 'sp-caret';
          caret.style.borderColor = user.color;
          const label = document.createElement('span');
          label.className = 'sp-caret-label';
          label.style.backgroundColor = user.color;
          label.textContent = user.name;
          caret.appendChild(label);
          return caret;
        },
      }),
      Placeholder.configure({
        placeholder: 'Start writing…',
        showOnlyCurrent: true,
      }),
    ],
    editorProps: {
      attributes: {spellcheck: 'true', 'aria-label': 'Page'},
      handleClickOn: (_view, _pos, _node, _nodePos, event) => {
        const a = (event.target as HTMLElement)?.closest?.('a');
        if (
          a &&
          o.onOpenLink &&
          (!editor.isEditable || event.metaKey || event.ctrlKey)
        ) {
          event.preventDefault();
          o.onOpenLink(a.getAttribute('href') ?? '');
          return true;
        }
        return false;
      },
    },
    // Only changes made here count as local: not others' (they come in
    // through y-sync), and not an empty update (setEditable sends one).
    onUpdate: ({editor: e, transaction}) =>
      o.onChange(
        e.getMarkdown(),
        transaction.docChanged && !isChangeOrigin(transaction),
      ),
  });

  const buttons: {el: HTMLButtonElement; b: Btn}[] = [];
  const add = (b: Btn) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.innerHTML = b.label;
    el.title = b.title;
    el.setAttribute('aria-label', b.title);
    // mousedown, not click: keep the editor's selection.
    el.addEventListener('mousedown', ev => {
      ev.preventDefault();
      b.run(editor);
      refresh();
    });
    toolbar.appendChild(el);
    buttons.push({el, b});
  };
  for (const b of BUTTONS) {
    if (b === '|') {
      const s = document.createElement('span');
      s.className = 'sep';
      toolbar.appendChild(s);
    } else add(b);
  }
  const sep = document.createElement('span');
  sep.className = 'sep';
  toolbar.appendChild(sep);
  add({label: '🖼', title: 'Insert image', run: () => o.onPickImage()});

  // Not the focus command: on phones it focuses the page mid-command, which
  // lets the browser's own selection change slip in first, and the command's
  // transaction then no longer applies ("Applying a mismatched transaction").
  const focusView = () =>
    requestAnimationFrame(() => {
      if (!editor.isDestroyed) editor.view.focus();
    });

  const refresh = () => {
    for (const {el, b} of buttons)
      el.classList.toggle('on', !!b.active?.(editor));
  };
  editor.on('selectionUpdate', refresh);
  editor.on('transaction', refresh);
  toolbar.style.display = o.readOnly ? 'none' : '';

  return {
    setEditable(editable) {
      editor.setEditable(editable);
      toolbar.style.display = editable ? '' : 'none';
    },
    setColors(colors) {
      style.textContent = BASE_CSS + css(colors);
    },
    insertImage(url, alt = '') {
      editor.chain().setImage({src: url, alt}).createParagraphNear().run();
      focusView();
    },
    getMarkdown: () => editor.getMarkdown(),
    applyChanges(updates) {
      for (const u of updates) {
        try {
          Y.applyUpdate(ydoc, fromB64(u), REMOTE);
        } catch {
          // not a Yjs update: skip it
        }
      }
    },
    setPeers(peers) {
      for (const p of peers) {
        if (!p.aware) continue;
        try {
          applyAwarenessUpdate(awareness, fromB64(p.aware), REMOTE);
        } catch {
          // skip it
        }
      }
      const here = new Set(peers.map(p => p.tab));
      const gone: number[] = [];
      awareness.getStates().forEach((st, id) => {
        if (id !== awareness.clientID && !here.has(st?.tab)) gone.push(id);
      });
      if (gone.length) removeAwarenessStates(awareness, gone, REMOTE);
    },
    setTitle(title) {
      if (title === ytitle.toString()) return;
      ydoc.transact(() => {
        ytitle.delete(0, ytitle.length);
        ytitle.insert(0, title);
      }, 'title');
    },
    snapshot: () => ({
      markdown: editor.getMarkdown(),
      title: ytitle.toString(),
      y: toB64(Y.encodeStateAsUpdate(ydoc)),
    }),
    focus: () => {
      editor.view.dispatch(
        editor.state.tr.setSelection(Selection.atEnd(editor.state.doc)),
      );
      focusView();
    },
    destroy() {
      editor.destroy();
      awareness.destroy();
      ydoc.destroy();
      o.el.innerHTML = '';
    },
  };
}
