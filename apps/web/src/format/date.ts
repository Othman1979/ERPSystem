import dayjs from 'dayjs';

export const DATE_INPUT_FORMAT = 'DD/MM/YYYY';

export function formatDate(value: string): string {
  return dayjs(value).format(DATE_INPUT_FORMAT);
}

export function formatDateTime(value: string): string {
  return `${formatDate(value)} ${dayjs(value).format('HH:mm')}`;
}
