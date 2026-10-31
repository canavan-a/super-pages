// The editor in the browser: core.ts mounted straight into the page.
import React, {forwardRef, useEffect, useImperativeHandle, useRef} from 'react';

import {useTheme} from '../theme';
import {EditorHandle, mountEditor} from './core';
import {colorsFor, DocEditorProps, DocEditorRef} from './types';

export const DocEditor = forwardRef<DocEditorRef, DocEditorProps>(
  function DocEditor(props, ref) {
    const theme = useTheme();
    const host = useRef<HTMLDivElement>(null);
    const handle = useRef<EditorHandle | null>(null);
    // The latest callbacks, so the editor (mounted once) always calls the
    // current ones.
    const live = useRef(props);
    live.current = props;

    useEffect(() => {
      if (!host.current) return;
      handle.current = mountEditor({
        el: host.current,
        markdown: props.markdown,
        readOnly: props.readOnly,
        colors: colorsFor(theme),
        resolveImage: url => live.current.resolveImage(url),
        onChange: md => live.current.onChange(md),
        onPickImage: () => live.current.onPickImage(),
        onOpenLink: href => live.current.onOpenLink?.(href),
      });
      if (props.autoFocus) handle.current.focus();
      return () => {
        handle.current?.destroy();
        handle.current = null;
      };
      // Mounted once per document; DocScreen remounts it (key) for another.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(
      () => handle.current?.setEditable(!props.readOnly),
      [props.readOnly],
    );
    useEffect(() => handle.current?.setColors(colorsFor(theme)), [theme]);

    useImperativeHandle(ref, () => ({
      insertImage: (url, alt) => handle.current?.insertImage(url, alt),
    }));

    return (
      <div
        ref={host}
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          height: '100%',
        }}
      />
    );
  },
);
