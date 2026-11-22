import dayjs from 'dayjs';

export const DATE_INPUT_FORMAT = 'DD/MM/YYYY';

export function formatDate(value: string): string {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.0+)?(?:Z|\+00:00))?$/.exec(value);
  if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  return dayjs(value).format(DATE_INPUT_FORMAT);
}

export function formatDateTime(value: string): string {
  return `${formatDate(value)} ${dayjs(value).format('HH:mm')}`;
}
