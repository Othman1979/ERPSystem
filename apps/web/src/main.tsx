import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryCache, QueryClient, QueryClientProvider, type Query } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
// Import the ES-module builds: the CJS 'antd/locale/*' entry reaches the app
// wrapped as { default: locale }, so ConfigProvider silently fell back to English.
import arEG from 'antd/es/locale/ar_EG';
import enUS from 'antd/es/locale/en_US';
import dayjs from 'dayjs';
import 'dayjs/locale/ar';
import { useTranslation } from 'react-i18next';
import { BrowserRouter } from 'react-router';
import i18n from './i18n';
// Self-hosted UI font (ADR-002). Each weight file covers Arabic + Latin via
// unicode-range, so the browser only downloads the subsets a page uses.
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/ibm-plex-sans-arabic/700.css';
import './index.css';
import { App } from './App';
import { AuthProvider, SessionBoundary } from './auth/AuthContext';
import { notifyQueryError, QueryErrorToast } from './components/QueryState';
import { installErrorReporting } from './errorReporting';
import { applyReferenceDataPolicy } from './referenceData';
import { antdTheme } from './theme';

// Uncaught errors go to the platform's error monitor (ADR-010 §10.3).
installErrorReporting();

/** Refetch on window focus at most every 30 s per query, and always after a failure (WEB-03). */
const FOCUS_REFETCH_AFTER_MS = 30_000;
function refetchOnFocus(query: Query): boolean {
  return query.state.status === 'error' || Date.now() - query.state.dataUpdatedAt > FOCUS_REFETCH_AFTER_MS;
}

const queryClient = new QueryClient({
  // One toast for failed loads; the list itself shows the error and a retry button.
  queryCache: new QueryCache({ onError: (error) => notifyQueryError(error) }),
  // refetchOnReconnect stays on (the default), so lists recover when the network returns.
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: refetchOnFocus } },
});
// Accounts, warehouses, taxes, branches and units: fresh for 5 minutes, expired on any write to them (WEB-13).
applyReferenceDataPolicy(queryClient);

/** Keeps antd locale, text direction and dayjs in sync with the UI language. */
function LocalizedApp() {
  const { i18n: i18nInstance } = useTranslation();
  const isAr = i18nInstance.language !== 'en';

  useEffect(() => {
    dayjs.locale(isAr ? 'ar' : 'en');
    document.documentElement.lang = isAr ? 'ar' : 'en';
    document.documentElement.dir = isAr ? 'rtl' : 'ltr';
  }, [isAr]);

  return (
    <ConfigProvider
      locale={isAr ? arEG : enUS}
      direction={isAr ? 'rtl' : 'ltr'}
      theme={antdTheme}
    >
      <AntApp>
        <QueryErrorToast />
        <AuthProvider>
          <SessionBoundary>
            <App />
          </SessionBoundary>
        </AuthProvider>
      </AntApp>
    </ConfigProvider>
  );
}

dayjs.locale(i18n.language === 'ar' ? 'ar' : 'en');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <LocalizedApp />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
