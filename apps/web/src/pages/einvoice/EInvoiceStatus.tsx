import { EInvoiceStatus as EINVOICE_STATUS, type EInvoiceErrorDto, type EInvoiceStateDto } from '@erp/api-client';
import { Alert, QRCode, Tag, Tooltip } from 'antd';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { Num } from '../../components/Num';

/** JoFotara submission states (Phase 7, docs/decisions/0005 §13), in the API's order. */
export const EINVOICE_STATUSES = Object.values(EINVOICE_STATUS);
export type EInvoiceStatus = (typeof EINVOICE_STATUSES)[number];

/** One error or warning of a submission. */
export type EInvoiceError = EInvoiceErrorDto;

/** The `einvoice` block on a sales invoice or return; null = not e-invoiced. */
export type EInvoiceState = EInvoiceStateDto;

export const STATUS_COLORS: Record<EInvoiceStatus, string> = {
  PENDING: 'default',
  SENDING: 'processing',
  ACCEPTED: 'success',
  REJECTED: 'error',
  FAILED: 'volcano',
  UNKNOWN: 'warning',
};

/** Pending or being sent: screens showing it refetch until it settles. */
export const isInFlight = (status?: EInvoiceStatus | null) => status === 'PENDING' || status === 'SENDING';

/** Coloured status tag; hover explains what the state means and what to do. */
export function EInvoiceStatusTag({ status }: { status: EInvoiceStatus }) {
  const { t } = useTranslation();
  return (
    <Tooltip title={t(`einvoice.statusHints.${status}`)}>
      <Tag color={STATUS_COLORS[status]} style={{ marginInlineEnd: 0 }}>
        {t(`einvoice.statuses.${status}`)}
      </Tag>
    </Tooltip>
  );
}

/**
 * "Not accepted by JoFotara yet" marker on a posted invoice or return that was
 * sent (or is waiting to be): shown on screen and on the printout.
 */
export function EInvoiceNotice({ einvoice }: { einvoice?: EInvoiceState | null }) {
  const { t } = useTranslation();
  if (!einvoice || einvoice.status === 'ACCEPTED') return null;
  const errors = einvoice.errors ?? [];
  return (
    <Alert
      banner
      className="einvoice-banner"
      type={einvoice.status === 'REJECTED' || einvoice.status === 'FAILED' ? 'error' : 'warning'}
      message={
        <span className="einvoice-banner-title">
          {t('einvoice.notAccepted')}
          <EInvoiceStatusTag status={einvoice.status} />
        </span>
      }
      description={
        <>
          {t(`einvoice.statusHints.${einvoice.status}`)}
          {errors.length > 0 && (
            <ul className="einvoice-banner-errors">
              {errors.map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
          )}
        </>
      }
    />
  );
}

/** QR code and identifiers of an accepted e-invoice, under the document lines (prints). */
export function EInvoiceQrPanel({ einvoice }: { einvoice?: EInvoiceState | null }) {
  const { t } = useTranslation();
  if (einvoice?.status !== 'ACCEPTED' || !einvoice.qrPayload) return null;
  return (
    <div className="einvoice-qr-panel">
      <QRCode value={einvoice.qrPayload} type="svg" size={160} bordered={false} />
      <div className="einvoice-qr-facts">
        <strong>{t('einvoice.acceptedCaption')}</strong>
        <span>
          {t('einvoice.uuid')}: <span className="doc-no">{einvoice.uuid}</span>
        </span>
        <span>
          {t('einvoice.icv')}: <Num>{einvoice.icv}</Num>
        </span>
        {einvoice.completedAt && (
          <span>
            {t('einvoice.completedAt')}: <Num>{dayjs(einvoice.completedAt).format('YYYY-MM-DD HH:mm')}</Num>
          </span>
        )}
        {einvoice.environment === 'SANDBOX' && (
          <span>
            <Tag>{t('einvoice.env_SANDBOX')}</Tag>
          </span>
        )}
      </div>
    </div>
  );
}
