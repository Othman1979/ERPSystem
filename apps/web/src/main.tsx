import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import arEG from 'antd/locale/ar_EG';
import enUS from 'antd/locale/en_US';
import dayjs from 'dayjs';
import 'dayjs/locale/ar';
import { useTranslation } from 'react-i18next';
import i18n from './i18n';
import './index.css';
import { App } from './App';
import { AuthProvider } from './auth/AuthContext';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const theme = {
  token: {
    colorPrimary: '#714B67',
    colorInfo: '#714B67',
    borderRadius: 4,
    fontFamily: "'Segoe UI', Tahoma, 'Noto Kufi Arabic', Arial, sans-serif",
  },
  components: {
    Layout: { headerBg: '#714B67', headerHeight: 48, headerPadding: '0 16px' },
    Menu: { darkItemBg: '#5C3A57', darkSubMenuItemBg: '#4E3049' },
    Card: { headerBg: 'transparent' },
  },
};

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
      theme={theme}
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
      <LocalizedApp />
    </QueryClientProvider>
  </React.StrictMode>,
);
