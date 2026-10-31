// The editor page inside the Android app's WebView. It speaks to
// DocEditor.tsx over postMessage: the app sends the page and theme in and
// answers image lookups; the page sends changes out. The WebView never
// touches the network: images arrive as data: URIs the app decrypted.
import {
  EditorColors,
  EditorHandle,
  EditorUser,
  mountEditor,
  Peer,
} from './core';

type In =
  | {
      type: 'init';
      markdown: string;
      y: string | null;
      title: string;
      user: EditorUser;
      readOnly: boolean;
      colors: EditorColors;
      autoFocus?: boolean;
    }
  | {type: 'changes'; updates: string[]}
  | {type: 'peers'; peers: Peer[]}
  | {type: 'setTitle'; title: string}
  | {type: 'snapshot'; id: number}
  | {type: 'editable'; editable: boolean}
  | {type: 'colors'; colors: EditorColors}
  | {type: 'insertImage'; url: string; alt?: string}
  | {type: 'image'; id: number; uri?: string; error?: string};

declare global {
  interface Window {
    ReactNativeWebView?: {postMessage(msg: string): void};
  }
}

const post = (msg: object) =>
  window.ReactNativeWebView?.postMessage(JSON.stringify(msg));

let handle: EditorHandle | null = null;
let nextId = 1;
const waiting = new Map<
  number,
  {resolve: (uri: string) => void; reject: (e: Error) => void}
>();

function onMessage(raw: unknown) {
  let m: In;
  try {
    m = typeof raw === 'string' ? JSON.parse(raw) : (raw as In);
  } catch {
    return;
  }
  switch (m.type) {
    case 'init': {
      document.body.style.background = m.colors.bg;
      handle?.destroy();
      handle = mountEditor({
        el: document.getElementById('root')!,
        markdown: m.markdown,
        y: m.y,
        title: m.title,
        user: m.user,
        readOnly: m.readOnly,
        colors: m.colors,
        resolveImage: url =>
          new Promise((resolve, reject) => {
            const id = nextId++;
            waiting.set(id, {resolve, reject});
            post({type: 'resolveImage', id, url});
          }),
        onChange: (markdown, local) => post({type: 'change', markdown, local}),
        onTitle: title => post({type: 'title', title}),
        onLocalChange: update => post({type: 'localChange', update}),
        onAware: aware => post({type: 'aware', aware}),
        onPickImage: () => post({type: 'pickImage'}),
        onOpenLink: href => post({type: 'link', href}),
      });
      if (m.autoFocus) handle.focus();
      break;
    }
    case 'editable':
      handle?.setEditable(m.editable);
      break;
    case 'colors':
      document.body.style.background = m.colors.bg;
      handle?.setColors(m.colors);
      break;
    case 'insertImage':
      handle?.insertImage(m.url, m.alt);
      break;
    case 'changes':
      handle?.applyChanges(m.updates);
      break;
    case 'peers':
      handle?.setPeers(m.peers);
      break;
    case 'setTitle':
      handle?.setTitle(m.title);
      break;
    case 'snapshot':
      post(
        handle
          ? {type: 'snapshot', id: m.id, snapshot: handle.snapshot()}
          : {type: 'snapshot', id: m.id, error: 'The editor is closed.'},
      );
      break;
    case 'image': {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.uri) w?.resolve(m.uri);
      else w?.reject(new Error(m.error ?? 'image failed'));
      break;
    }
  }
}

// Android's WebView delivers injected messages on document, iOS on window.
document.addEventListener('message', (e: Event) =>
  onMessage((e as MessageEvent).data),
);
window.addEventListener('message', e => onMessage(e.data));
post({type: 'ready'});
