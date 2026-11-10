import { FileExcelOutlined, FilePdfOutlined } from '@ant-design/icons';
import { App, Button } from 'antd';
import type { TFunction } from 'i18next';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, apiFetchBlob } from '@erp/api-client';

export type QueryParams = Record<string, string | null | undefined>;

/** `?a=1&b=2` from the params that are set (empty ones are left out). */
export function queryString(params: QueryParams): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** The UI language as the API's `lang` for printouts and exports. */
export function apiLang(language: string): 'ar' | 'en' {
  return language === 'en' ? 'en' : 'ar';
}

/** Translated text for a failed API call (the standard errors.<CODE> lookup). */
export function apiErrorText(t: TFunction, err: unknown): string {
  return err instanceof ApiError
    ? t(`errors.${err.code}`, { defaultValue: err.message })
    : t('errors.INTERNAL');
}

/** Saves a downloaded file through a temporary `<a download>`. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before releasing the blob.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

type ExportFormat = 'pdf' | 'xlsx';

/**
 * "PDF" and "Excel" buttons for a report: the same endpoint and filters as
 * the screen, plus `format` and the UI language, saved as the file the
 * server names. Too many rows comes back as REPORT_TOO_LARGE (413).
 */
export function ExportButtons({
  path,
  params = {},
  disabled,
}: {
  /** Report endpoint, e.g. `/reports/trial-balance`. */
  path: string;
  /** The report's current filters (unset ones are left out). */
  params?: QueryParams;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const [busy, setBusy] = useState<ExportFormat | null>(null);

  const run = async (format: ExportFormat) => {
    setBusy(format);
    try {
      const { blob, filename } = await apiFetchBlob(
        `${path}${queryString({ ...params, format, lang: apiLang(i18n.language) })}`,
      );
      saveBlob(blob, filename ?? `report.${format}`);
    } catch (err) {
      void message.error(apiErrorText(t, err));
    } finally {
      setBusy(null);
    }
  };

  const button = (format: ExportFormat, icon: ReactNode, label: string, hint: string) => (
    <Button
      icon={icon}
      loading={busy === format}
      disabled={disabled || (busy !== null && busy !== format)}
      onClick={() => void run(format)}
      title={hint}
    >
      {label}
    </Button>
  );

  return (
    <>
      {button('pdf', <FilePdfOutlined />, t('reports.exportPdf'), t('reports.exportPdfHint'))}
      {button('xlsx', <FileExcelOutlined />, t('reports.exportExcel'), t('reports.exportExcelHint'))}
    </>
  );
}
