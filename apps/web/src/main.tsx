import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import arEG from 'antd/locale/ar_EG';
import enUS from 'antd/locale/en_US';
import dayjs from 'dayjs';
import 'dayjs/locale/ar';
import i18n from './i18n';
import { App } from './App';
import { AuthProvider } from './auth/AuthContext';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const antdLocale = i18n.language === 'ar' ? arEG : enUS;
dayjs.locale(i18n.language === 'ar' ? 'ar' : 'en');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfigProvider
        locale={antdLocale}
        direction={i18n.language === 'ar' ? 'rtl' : 'ltr'}
        theme={{
          token: {
            colorPrimary: '#714B67',
            colorInfo: '#714B67',
            borderRadius: 4,
            fontFamily:
              "'Segoe UI', Tahoma, 'Noto Kufi Arabic', Arial, sans-serif",
          },
          components: {
            Layout: { headerBg: '#714B67', headerHeight: 48, headerPadding: '0 16px' },
            Menu: { darkItemBg: '#5C3A57', darkSubMenuItemBg: '#4E3049' },
            Card: { headerBg: 'transparent' },
          },
        }}
      >
        <AntApp>
          <AuthProvider>
            <App />
          </AuthProvider>
        </AntApp>
      </ConfigProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
