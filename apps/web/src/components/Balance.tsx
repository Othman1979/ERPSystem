import { useTranslation } from 'react-i18next';
import { balanceView, type NormalBalance } from '../format/balance';
import type { NumericInput } from '../format/number';
import { Num } from './Num';

/**
 * An account balance outside the trial balance: "520.000 Cr" / «520.000 دائن».
 * Debit balances carry no suffix. Red only when the balance is on the wrong
 * side of the account's normal balance (pass `normalBalance` to enable that).
 *
 * @param net debit − credit, as a decimal string or Decimal.
 */
export function Balance({ net, normalBalance }: { net: NumericInput; normalBalance?: NormalBalance }) {
  const { t } = useTranslation();
  const view = balanceView(net, normalBalance);
  return (
    <span className={view.wrongSide ? 'balance balance-wrong-side' : 'balance'}>
      <Num>{view.amount}</Num>
      {view.side === 'CR' && <span className="balance-side">{t('ui.creditSuffix')}</span>}
    </span>
  );
}
