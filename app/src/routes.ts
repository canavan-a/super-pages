// Hand-rolled routing: react-navigation drags in native-only deps
// (react-native-screens/gesture-handler/reanimated) that complicate the
// react-native-web/Vite target for a handful of screens, so App.tsx just
// switches on this union instead.
export type Route =
  | {name: 'home'}
  | {name: 'doc'; id: string; fresh?: boolean}
  | {name: 'docSettings'; id: string}
  | {name: 'join'; link: string}
  | {name: 'settings'}
  | {name: 'privacy'}
  | {name: 'terms'};
