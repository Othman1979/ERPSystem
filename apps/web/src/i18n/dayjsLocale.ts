import dayjs from 'dayjs';
import ar from 'dayjs/locale/ar';

/**
 * Month names as used in Jordan and the Levant (owner decision, review
 * 2026-11-13 §Design): «كانون الثاني … كانون الأول», not dayjs's default
 * «يناير … ديسمبر». Replaces the registered 'ar' locale in place, so every
 * dayjs format and antd's date pickers pick it up; the active locale is still
 * chosen by the app (dayjs.locale('ar' | 'en')).
 */
export const LEVANTINE_MONTHS = [
  'كانون الثاني',
  'شباط',
  'آذار',
  'نيسان',
  'أيار',
  'حزيران',
  'تموز',
  'آب',
  'أيلول',
  'تشرين الأول',
  'تشرين الثاني',
  'كانون الأول',
];

dayjs.locale({ ...ar, months: LEVANTINE_MONTHS, monthsShort: LEVANTINE_MONTHS }, undefined, true);
