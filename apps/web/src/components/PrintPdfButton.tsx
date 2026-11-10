import { PrinterOutlined } from '@ant-design/icons';
import { App, Button } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetchBlob } from '@erp/api-client';
import { apiErrorText, apiLang, queryString, saveBlob } from './ExportButtons';

/**
 * "Print" for a business document: opens the server's A4 PDF (with the
 * JoFotara QR, or the not-accepted banner) in a new tab, in the UI language.
 * This is the official printout; the screen itself is not printed.
 */
export function PrintPdfButton({ path }: { /** e.g. `/sales-invoices/12/pdf` */ path: string }) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);

  const print = async () => {
    // Open the tab inside the click so popup blockers allow it; it gets the PDF when it arrives.
    const win = window.open('', '_blank');
    if (win) win.opener = null;
    setBusy(true);
    try {
      const { blob, filename } = await apiFetchBlob(`${path}${queryString({ lang: apiLang(i18n.language) })}`);
      if (win && !win.closed) {
        const url = URL.createObjectURL(blob);
        win.location.href = url;
        // The viewer has loaded it by then; release the memory.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else {
        // Popup blocked or closed: download the file instead.
        saveBlob(blob, filename ?? 'document.pdf');
      }
    } catch (err) {
      win?.close();
      void message.error(apiErrorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button icon={<PrinterOutlined />} loading={busy} onClick={() => void print()}>
      {t('common.print')}
    </Button>
  );
}
