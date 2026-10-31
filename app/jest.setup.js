// AsyncStorage is a native module; under Jest it needs the official in-memory
// mock, or anything that imports src/settings.ts fails with "AsyncStorage is null".
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// noble's randomBytes uses globalThis.crypto.getRandomValues, which the app
// gets from react-native-get-random-values and Node provides natively.
if (!globalThis.crypto) {
  globalThis.crypto = require('crypto').webcrypto;
}

// Native modules the app imports at the top level; none are exercised here.
jest.mock('react-native-keychain', () => ({
  ACCESS_CONTROL: {}, ACCESSIBLE: {}, STORAGE_TYPE: {}, SECURITY_LEVEL: {},
  getAllGenericPasswordServices: jest.fn(async () => []),
  setGenericPassword: jest.fn(async () => true),
  getGenericPassword: jest.fn(async () => false),
  resetGenericPassword: jest.fn(async () => true),
}));
jest.mock('react-native-fs', () => ({}));
jest.mock('@react-native-documents/picker', () => ({
  pick: jest.fn(), keepLocalCopy: jest.fn(), saveDocuments: jest.fn(), isErrorWithCode: () => false, errorCodes: {}, types: {},
}));
jest.mock('react-native-image-picker', () => ({launchImageLibrary: jest.fn()}));
jest.mock('react-native-webview', () => ({WebView: () => null}));
// Safe-area insets (src/App.tsx): the library's own Jest mock.
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
