import { DatePicker as AntDatePicker, type DatePickerProps } from 'antd';
import type { RangePickerProps } from 'antd/es/date-picker';
import { DATE_INPUT_FORMAT } from '../format/date';
export { DATE_INPUT_FORMAT } from '../format/date';

const MASK = { format: DATE_INPUT_FORMAT, type: 'mask' } as const;

function SinglePicker(props: DatePickerProps) {
  return <AntDatePicker format={MASK} {...props} />;
}

function RangePicker(props: RangePickerProps) {
  return <AntDatePicker.RangePicker format={MASK} {...props} />;
}

/** antd's DatePicker with the masked day-first input; the calendar panel stays. */
export const DatePicker = Object.assign(SinglePicker, { RangePicker });
