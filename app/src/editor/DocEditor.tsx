// The editor on Android: the same TipTap editor as the browser (core.ts),
// bundled into one HTML page (editorHtml.generated.ts, made by `npm run
// build:editor`) and run in a WebView. It has no network access of its own:
// images are decrypted here and handed over as data: URIs.
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {Linking, StyleSheet, View} from 'react-native';
import {WebView, WebViewMessageEvent, WebViewProps} from 'react-native-webview';

import {useTheme} from '../theme';
import {EDITOR_HTML} from './editorHtml.generated';
import {colorsFor, DocEditorProps, DocEditorRef, Snapshot} from './types';

export const DocEditor = forwardRef<DocEditorRef, DocEditorProps>(
  function DocEditor(props, ref) {
    const theme = useTheme();
    const web = useRef<WebView>(null);
    const [ready, setReady] = useState(false);
    const live = useRef(props);
    live.current = props;
    const snapshots = useRef(
      new Map<
        number,
        {resolve: (s: Snapshot) => void; reject: (e: Error) => void}
      >(),
    );
    const nextSnapshot = useRef(1);

    const send = (msg: object) => web.current?.postMessage(JSON.stringify(msg));

    useEffect(() => {
      if (ready) send({type: 'editable', editable: !props.readOnly});
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.readOnly]);
    useEffect(() => {
      if (ready) send({type: 'colors', colors: colorsFor(theme)});
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [theme]);

    useImperativeHandle(ref, () => ({
      insertImage: (url, alt) => send({type: 'insertImage', url, alt}),
      applyChanges: updates => send({type: 'changes', updates}),
      setPeers: peers => send({type: 'peers', peers}),
      setTitle: title => send({type: 'setTitle', title}),
      snapshot: () =>
        new Promise<Snapshot>((resolve, reject) => {
          if (!ready) return reject(new Error('The editor is still loading.'));
          const id = nextSnapshot.current++;
          snapshots.current.set(id, {resolve, reject});
          send({type: 'snapshot', id});
        }),
    }));

    const onMessage = (e: WebViewMessageEvent) => {
      let m: any;
      try {
        m = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      switch (m.type) {
        case 'ready':
          setReady(true);
          send({
            type: 'init',
            kind: live.current.kind ?? 'page',
            markdown: live.current.markdown,
            y: live.current.y,
            title: live.current.title,
            user: live.current.user,
            readOnly: live.current.readOnly,
            colors: colorsFor(theme),
            autoFocus: live.current.autoFocus,
          });
          break;
        case 'change':
          if (typeof m.markdown === 'string')
            live.current.onChange(m.markdown, m.local !== false);
          break;
        case 'title':
          if (typeof m.title === 'string') live.current.onTitle(m.title);
          break;
        case 'localChange':
          if (typeof m.update === 'string')
            live.current.onLocalChange(m.update);
          break;
        case 'aware':
          if (typeof m.aware === 'string') live.current.onAware(m.aware);
          break;
        case 'snapshot': {
          const w = snapshots.current.get(m.id);
          snapshots.current.delete(m.id);
          if (m.snapshot) w?.resolve(m.snapshot);
          else w?.reject(new Error(String(m.error ?? 'snapshot failed')));
          break;
        }
        case 'pickImage':
          live.current.onPickImage();
          break;
        case 'resolveImage':
          live.current
            .resolveImage(String(m.url))
            .then(uri => send({type: 'image', id: m.id, uri}))
            .catch(err =>
              send({
                type: 'image',
                id: m.id,
                error: String(err?.message ?? err),
              }),
            );
          break;
        case 'link':
          if (/^https?:\/\//.test(m.href))
            Linking.openURL(m.href).catch(() => {});
          else live.current.onOpenLink?.(m.href);
          break;
      }
    };

    return (
      <View style={[styles.fill, {backgroundColor: theme.bg}]}>
        <Web
          ref={web}
          source={{html: EDITOR_HTML, baseUrl: 'about:blank'}}
          originWhitelist={['about:blank', 'data:*']}
          onMessage={onMessage}
          // Nothing in the editor may load from or go to the network.
          onShouldStartLoadWithRequest={(req: {url: string}) =>
            req.url === 'about:blank' || req.url.startsWith('data:')
          }
          javaScriptEnabled
          domStorageEnabled={false}
          allowFileAccess={false}
          cacheEnabled={false}
          incognito
          style={[styles.fill, {backgroundColor: theme.bg}]}
          containerStyle={{backgroundColor: theme.bg}}
        />
      </View>
    );
  },
);

// react-native-webview's class typings don't line up with React 19's JSX
// types (every prop comes out as never); the props themselves are right.
const Web = WebView as unknown as React.ComponentType<
  WebViewProps & {ref?: React.Ref<WebView>}
>;

const styles = StyleSheet.create({
  fill: {flex: 1},
});
