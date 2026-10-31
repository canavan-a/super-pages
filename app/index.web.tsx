import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './src/App';
import {PrivacyPolicy, TermsOfUse} from './src/privacy/PrivacyPolicy';
import {ThemeProvider} from './src/theme';

const root = document.getElementById('root');
if (!root) {
  throw new Error('missing #root element');
}

// /privacy and /terms are the privacy policy and terms of use as pages of
// their own (linked from app stores), readable without an account or
// unlocking anything.
const path = window.location.pathname.replace(/\/+$/, '');
const page =
  path === '/privacy' ? (
    <PrivacyPolicy />
  ) : path === '/terms' ? (
    <TermsOfUse />
  ) : null;
if (path === '/privacy') document.title = 'Privacy policy · Super Pages';
if (path === '/terms') document.title = 'Terms of use · Super Pages';

ReactDOM.createRoot(root).render(
  page ? <ThemeProvider>{page}</ThemeProvider> : <App />,
);
