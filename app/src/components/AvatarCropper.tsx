import React, {useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Image,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, {Path} from 'react-native-svg';

import {AvatarSource, cropAvatar} from '../files';
import {useTheme} from '../theme';
import {Overlay} from './Overlay';

/** How much of the square frame the circle spans. */
const CIRCLE = 0.84;
const MAX_ZOOM = 6;

/**
 * Frames a photo as a profile picture: the photo sits under a dimmed mask with
 * a circular window, and is dragged (and pinched, or zoomed with − / +) until
 * the face is in the circle. The square around that circle is what's kept,
 * so the photo can never be moved to leave a gap in it.
 */
export function AvatarCropper({
  src,
  onCancel,
  onDone,
}: {
  src: AvatarSource;
  onCancel: () => void;
  onDone: (jpeg: Uint8Array) => void | Promise<void>;
}): React.JSX.Element {
  const theme = useTheme();
  const [box, setBox] = useState(0); // side of the square work area
  const [view, setView] = useState({z: 1, tx: 0, ty: 0}); // zoom, and the photo's offset from center
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uri = useMemo(() => `data:image/jpeg;base64,${src.base64}`, [src]);

  const D = box * CIRCLE;
  // The zoom at which the photo just covers the circle.
  const fit = box ? Math.max(D / src.width, D / src.height) : 1;

  // Keeps the circle covered: the offset can't exceed the photo's overhang.
  const clamp = (z: number, tx: number, ty: number) => {
    const zz = Math.min(MAX_ZOOM, Math.max(1, z));
    const s = fit * zz;
    const mx = Math.max(0, (src.width * s - D) / 2);
    const my = Math.max(0, (src.height * s - D) / 2);
    return {
      z: zz,
      tx: Math.min(mx, Math.max(-mx, tx)),
      ty: Math.min(my, Math.max(-my, ty)),
    };
  };

  // Gesture state lives in refs: the responder is created once.
  const viewRef = useRef(view);
  viewRef.current = view;
  const clampRef = useRef(clamp);
  clampRef.current = clamp;
  const gesture = useRef<{
    start: typeof view;
    dx: number;
    dy: number;
    touches: number;
    dist: number;
  } | null>(null);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          gesture.current = null;
        },
        onPanResponderMove: (e, g) => {
          const t = e.nativeEvent.touches;
          const dist =
            t.length >= 2
              ? Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY)
              : 0;
          // Start over whenever a finger is added or lifted, from where things are now.
          if (
            !gesture.current ||
            gesture.current.touches !== Math.min(2, t.length)
          ) {
            gesture.current = {
              start: viewRef.current,
              dx: g.dx,
              dy: g.dy,
              touches: Math.min(2, t.length),
              dist,
            };
            return;
          }
          const st = gesture.current;
          const z =
            st.touches === 2 && st.dist > 0
              ? (st.start.z * dist) / st.dist
              : st.start.z;
          setView(
            clampRef.current(
              z,
              st.start.tx + g.dx - st.dx,
              st.start.ty + g.dy - st.dy,
            ),
          );
        },
        onPanResponderRelease: () => {
          gesture.current = null;
        },
      }),
    [],
  );

  const zoomBy = (f: number) =>
    setView(v => clamp(v.z * f, v.tx * f, v.ty * f));

  const use = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = fit * view.z;
      const size = D / s;
      const x = src.width / 2 - view.tx / s - size / 2;
      const y = src.height / 2 - view.ty / s - size / 2;
      await onDone(await cropAvatar(src, x, y, size));
    } catch (e) {
      setError((e as Error).message || "Couldn't crop that photo.");
      setBusy(false);
    }
  };

  const s = fit * view.z;
  const w = src.width * s;
  const h = src.height * s;
  const r = D / 2;
  const c = box / 2;
  // The dimmed mask: the whole square, minus the circle (even-odd fill).
  const mask = `M0 0H${box}V${box}H0Z M${c - r} ${c}a${r} ${r} 0 1 0 ${
    2 * r
  } 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;

  return (
    <Overlay
      visible
      onClose={busy ? () => {} : onCancel}
      backdrop="rgba(0,0,0,0.95)"
      style={styles.layer}>
      <Text style={styles.title}>Move and zoom</Text>
      <View
        style={styles.box}
        onLayout={e => setBox(e.nativeEvent.layout.width)}
        {...responder.panHandlers}>
        {box > 0 && (
          <>
            <Image
              source={{uri}}
              style={{
                position: 'absolute',
                width: w,
                height: h,
                left: c + view.tx - w / 2,
                top: c + view.ty - h / 2,
              }}
            />
            <Svg
              width={box}
              height={box}
              style={StyleSheet.absoluteFill}
              pointerEvents="none">
              <Path d={mask} fill="rgba(0,0,0,0.6)" fillRule="evenodd" />
              <Path
                d={`M${c - r} ${c}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${
                  -2 * r
                } 0Z`}
                fill="none"
                stroke="#fff"
                strokeWidth={1.5}
              />
            </Svg>
          </>
        )}
      </View>
      <View style={styles.zoomRow}>
        <Pressable
          style={styles.zoomButton}
          onPress={() => zoomBy(1 / 1.25)}
          accessibilityLabel="Zoom out">
          <Text style={styles.zoomText}>−</Text>
        </Pressable>
        <Pressable
          style={styles.zoomButton}
          onPress={() => zoomBy(1.25)}
          accessibilityLabel="Zoom in">
          <Text style={styles.zoomText}>+</Text>
        </Pressable>
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.actions}>
        <Pressable style={styles.secondary} onPress={onCancel} disabled={busy}>
          <Text style={styles.secondaryText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.primary, {backgroundColor: theme.primary}]}
          onPress={use}
          disabled={busy || !box}>
          {busy ? (
            <ActivityIndicator color={theme.primaryText} />
          ) : (
            <Text style={[styles.primaryText, {color: theme.primaryText}]}>
              Use photo
            </Text>
          )}
        </Pressable>
      </View>
    </Overlay>
  );
}

const styles = StyleSheet.create({
  layer: {justifyContent: 'center', alignItems: 'center', padding: 16, gap: 16},
  title: {color: '#fff', fontSize: 16, fontWeight: '700'},
  box: {width: '100%', maxWidth: 420, aspectRatio: 1, overflow: 'hidden'},
  zoomRow: {flexDirection: 'row', gap: 16},
  zoomButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomText: {color: '#fff', fontSize: 22, fontWeight: '600'},
  error: {color: '#ff9b9b', textAlign: 'center'},
  actions: {flexDirection: 'row', gap: 12, width: '100%', maxWidth: 420},
  secondary: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)',
    alignItems: 'center',
  },
  secondaryText: {color: '#fff', fontWeight: '600'},
  primary: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  primaryText: {fontWeight: '700'},
});
