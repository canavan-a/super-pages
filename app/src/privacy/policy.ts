// The privacy policy, shown in the app (Settings, the sign-in screen) and as
// its own page on the web (/privacy). Keep it in step with what the server
// stores (server/database/migrations), and update UPDATED when it changes.
// A first draft for Super Pages: have it reviewed before launch.

export const UPDATED = '2026-10-31';
export const CONTACT = 'aidan@lunargen.com';

/** Inline **bold** is the only markup, in paragraphs, list items and table cells. */
export type PolicyBlock =
  | {p: string}
  | {list: string[]}
  | {table: {head: string[]; rows: string[][]}};

export interface PolicySection {
  title: string;
  blocks: PolicyBlock[];
}

export const POLICY: PolicySection[] = [
  {
    title: 'Summary',
    blocks: [
      {
        p: 'Super Pages stores your **email address, name and profile picture** so you can sign in and so people you share pages with can recognise you. Your **pages and the images in them are end-to-end encrypted**: they are encrypted on your device, and our server cannot read them.',
      },
      {p: 'There are no ads, no analytics and no tracking.'},
    ],
  },
  {
    title: 'What our server stores',
    blocks: [
      {
        table: {
          head: ['What', 'Readable by us?', 'Why'],
          rows: [
            [
              'Your email address',
              'Yes',
              'To send sign-in codes, and so people can share pages with you by email',
            ],
            [
              'Your name and profile picture',
              'Yes',
              'Shown to people you share pages with',
            ],
            [
              'Your account key, locked with your passphrase',
              'No',
              'So you can sign in on a new device; only your passphrase opens it',
            ],
            [
              'Your public keys',
              'Yes (they are public)',
              'So others can share pages with you',
            ],
            [
              'Page titles, text and images',
              'No, encrypted',
              'To keep your pages and sync them between devices',
            ],
            [
              'Who each page is shared with, and their role',
              'Yes',
              'To enforce owner, edit and view permissions',
            ],
            [
              'Invitations to email addresses without an account',
              'Yes',
              'To finish the share when they sign up',
            ],
            [
              'When a page was last changed, and by whom',
              'Yes',
              'To show it in the list and avoid overwriting edits',
            ],
          ],
        },
      },
      {
        p: 'Other people never see your email address through Super Pages: page members are shown by name and picture only.',
      },
    ],
  },
  {
    title: 'Your passphrase and recovery phrase',
    blocks: [
      {
        p: 'Your passphrase and your 24-word recovery phrase never leave your device. Because we never have them, **we cannot reset them**: if you lose both, the pages only you could open cannot be recovered by anyone.',
      },
    ],
  },
  {
    title: 'Outside services',
    blocks: [
      {
        p: 'Sign-in codes and sharing invitations are sent by email through our email provider (Google Gmail). The emails contain no page content.',
      },
      {p: 'The Android app checks GitHub for new versions of itself.'},
    ],
  },
  {
    title: 'Data on your device',
    blocks: [
      {
        p: 'On a phone, your account key is kept in the Android Keystore, behind your fingerprint or screen lock. In a browser, it is kept only if you choose "Remember this browser", sealed with a key the browser will not export. Signing out removes it.',
      },
    ],
  },
  {
    title: 'Deleting your data',
    blocks: [
      {
        p: 'Deleting a page removes it, and its images, from our server for everyone. Deleting your account (Settings) removes your email address, name, picture and keys, and every page only you had access to. Pages you shared stay with the people you shared them with.',
      },
    ],
  },
  {
    title: 'Children',
    blocks: [{p: 'Super Pages is not directed at children under 13.'}],
  },
  {
    title: 'Other servers',
    blocks: [
      {
        p: 'This policy covers our server at pages.superbadger.io. Anyone can run their own Super Pages server; accounts on another server are subject to that operator’s practices, though pages stay end-to-end encrypted either way.',
      },
    ],
  },
  {
    title: 'Changes',
    blocks: [
      {p: 'If this policy changes, the date at the top changes with it.'},
    ],
  },
  {
    title: 'Contact',
    blocks: [{p: `Questions: ${CONTACT}`}],
  },
];
