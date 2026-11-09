import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
import './index.css';
import { App } from './App';
import { AuthProvider } from './auth/AuthContext';
import { antdTheme } from './theme';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

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
        <AuthProvider>
          <App />
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
