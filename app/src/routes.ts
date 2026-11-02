// Hand-rolled routing: react-navigation drags in native-only deps
// (react-native-screens/gesture-handler/reanimated) that complicate the
// react-native-web/Vite target for a handful of screens, so App.tsx just
// switches on this union instead.
export type Route =
  | {name: 'home'}
  | {name: 'doc'; id: string; fresh?: boolean}
  // fromHome: opened by holding a page in the grid, so back goes to the grid.
  | {name: 'docSettings'; id: string; fromHome?: boolean}
  | {name: 'join'; link: string}
  | {name: 'settings'}
  | {name: 'privacy'}
  | {name: 'terms'};
