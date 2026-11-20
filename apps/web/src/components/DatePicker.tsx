import { DatePicker as AntDatePicker, type DatePickerProps } from 'antd';
import type { RangePickerProps } from 'antd/es/date-picker';

/** How every date field is typed and shown: 20112026 becomes 20/11/2026 as it is typed. */
export const DATE_INPUT_FORMAT = 'DD/MM/YYYY';
const MASK = { format: DATE_INPUT_FORMAT, type: 'mask' } as const;

function SinglePicker(props: DatePickerProps) {
  return <AntDatePicker format={MASK} {...props} />;
}

function RangePicker(props: RangePickerProps) {
  return <AntDatePicker.RangePicker format={MASK} {...props} />;
}

/** antd's DatePicker with the masked day-first input; the calendar panel stays. */
export const DatePicker = Object.assign(SinglePicker, { RangePicker });
