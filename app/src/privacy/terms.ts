// The terms of use, shown in the app (Settings, the sign-in screen) and as
// their own page on the web (/terms). Agreed to by signing in. Keep them in
// step with the privacy policy (policy.ts), and update TERMS_UPDATED when they
// change. A first draft for Super Pages: have it reviewed before launch.

import {CONTACT, type PolicySection} from './policy';

export const TERMS_UPDATED = '2026-10-31';

export const TERMS: PolicySection[] = [
  {
    title: 'Summary',
    blocks: [
      {
        p: "Super Pages is an end-to-end encrypted notes and documents app made by Lunargen. By using it you agree to these terms. If you don't agree, please don't use the app.",
      },
    ],
  },
  {
    title: 'Early access',
    blocks: [
      {
        p: 'Super Pages is in early access. New accounts need an invite code, and features may change.',
      },
    ],
  },
  {
    title: 'Acceptable use',
    blocks: [
      {
        p: 'You may not use Super Pages to store or share anything illegal, to harass anyone, or to spread malware or spam.',
      },
    ],
  },
  {
    title: 'Your account and your keys',
    blocks: [
      {
        p: "You're responsible for your passphrase and recovery phrase. We can't read your pages and can't recover them if you lose both.",
      },
    ],
  },
  {
    title: 'Other servers',
    blocks: [
      {
        p: 'Servers other than pages.superbadger.io are run by other people. These terms only cover our server.',
      },
    ],
  },
  {
    title: 'No warranty',
    blocks: [
      {
        p: "Super Pages is provided as is, without warranty of any kind. Keep copies of anything you can't afford to lose. To the extent the law allows, Lunargen isn't liable for any loss that comes from using it.",
      },
    ],
  },
  {
    title: 'Changes',
    blocks: [
      {p: 'If these terms change, the date at the top changes with it.'},
    ],
  },
  {
    title: 'Contact',
    blocks: [{p: `Questions: ${CONTACT}`}],
  },
];
