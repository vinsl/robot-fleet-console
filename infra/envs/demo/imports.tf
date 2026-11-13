# Adopts the budgets created by hand. Kept on purpose after the first apply: an import block whose
# target is already in state is a no-op, and after make destroy removes the budgets from state the
# next deploy re-adopts them instead of failing on existing names.

import {
  for_each = local.budgets
  to       = aws_budgets_budget.this[each.key]
  id       = "${local.account_id}:${each.key}"
}
