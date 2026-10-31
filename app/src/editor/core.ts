// The page editor, in plain DOM: TipTap (ProseMirror) with markdown in and
// out, so pages are stored as markdown but nobody types or sees its syntax.
// The browser build mounts it straight into the page (DocEditor.web.tsx);
// the Android app runs the same code inside a WebView (native-entry.ts,
// bundled by scripts/build-editor.mjs).
import {Editor} from '@tiptap/core';
import Image from '@tiptap/extension-image';
import {TaskItem, TaskList} from '@tiptap/extension-list';
import {Placeholder} from '@tiptap/extensions';
import {Markdown} from '@tiptap/markdown';
import {Selection} from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';

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

export interface EditorOptions {
  el: HTMLElement;
  markdown: string;
  readOnly: boolean;
  colors: EditorColors;
  /** Turns an sp-img: URL into something an <img> can show (a data: URI). */
  resolveImage: (url: string) => Promise<string>;
  onChange: (markdown: string) => void;
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
.sp-editor .ProseMirror { max-width:760px; margin:0 auto; padding:20px 20px 120px; outline:none; min-height:100%;
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
`;

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

  const editor = new Editor({
    element: host,
    editable: !o.readOnly,
    content: o.markdown,
    contentType: 'markdown',
    extensions: [
      StarterKit.configure({link: {openOnClick: false, autolink: true}}),
      Markdown,
      TaskList,
      TaskItem.configure({nested: true}),
      secureImage(o.resolveImage),
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
    onUpdate: ({editor: e}) => o.onChange(e.getMarkdown()),
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
    focus: () => {
      editor.view.dispatch(
        editor.state.tr.setSelection(Selection.atEnd(editor.state.doc)),
      );
      focusView();
    },
    destroy() {
      editor.destroy();
      o.el.innerHTML = '';
    },
  };
}
