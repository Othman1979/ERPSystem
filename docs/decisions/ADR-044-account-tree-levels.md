# ADR-044: Arbitrary-depth account trees

## Status

Accepted

## Decision

An account with no journal lines and no document references may receive a child at any depth. The rule applies when the first child is added: the parent becomes non-postable, while its existing flags remain unchanged. Later children may be added under the now-non-postable group without repeating the first-child conversion checks.

Journal lines prevent conversion because they record posted accounting history against the account itself. Document references also prevent conversion, regardless of document status, because a document has selected the account as a posting destination; silently making that account a group or moving historical document references could change the meaning of existing and draft transactions. The guarded references are:

- `payments.cashAccountId` and `payments.expenseAccountId`
- `receipts.cashAccountId`
- `sales_invoices.cashAccountId` and `sales_returns.cashAccountId`
- `purchase_invoices.cashAccountId` and `purchase_returns.cashAccountId`
- `cash_transfers.fromAccountId` and `cash_transfers.toAccountId`
- `goods_notes.expenseAccountId`
- `issue_requests.expenseAccountId`
- `cheques.bankAccountId` (the additional account foreign key found in the schema)

Configuration links are different from document references and move to the first child, in the same transaction as child creation:

- `AccountMapping.accountId`
- `CashBox.accountId`
- `BankAccount.accountId`
- `PayElement.accountId`

The create response reports counts for each kind of moved link. If any links move, one `account.links_moved` audit entry records the parent as the before state and the new child as the after state. Later children do not move links again.

When omitted from the create request, the child inherits `isControl`, `controlType`, `normalBalance`, `costCenterRequired`, and `cashFlowActivity` from its parent. If the parent has a `controlType`, a child must retain that value; it cannot clear or replace the control type. This keeps customer and supplier control-account posting rules intact on the new leaf.

A manually supplied child code must begin with the parent's code and be longer than it. Otherwise the API returns `VALIDATION` with reason `CODE_PREFIX` and the parent code. Generated child codes retain the existing `parent-NN` sequence, including at deeper levels. Root account code behavior is unchanged.

## Consequences

- Cash, bank, supplier, and other control accounts can be organized into groups without discarding their control behavior.
- Mappings and treasury/payroll configuration remain usable because they move atomically to the first postable child.
- Posted journal history and all direct document references remain attached to their original postable account and therefore block its conversion.
- Reports and account pickers must continue to use postable leaves for posting while presenting the hierarchy for navigation and roll-up.
