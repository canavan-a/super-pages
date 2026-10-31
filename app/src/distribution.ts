// Which build this is (android/app/build.gradle productFlavors):
//  sideload  distributed outside Google Play (release/release.sh), with the
//            in-app updater.
//  play      a store build without it (none yet).
//  ios       the App Store build: neither, like play.
//  web       the browser build.
import {NativeModules, Platform} from 'react-native';

export type Distribution = 'sideload' | 'play' | 'ios' | 'web';

export const distribution: Distribution =
  Platform.OS === 'web'
    ? 'web'
    : Platform.OS === 'ios'
    ? 'ios'
    : NativeModules.Distribution?.flavor === 'play'
    ? 'play'
    : 'sideload';

/** The sideloaded Android build: it updates itself. */
export const isSideload = distribution === 'sideload';
