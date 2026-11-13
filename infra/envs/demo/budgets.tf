# AWS Budgets that alert on the monthly cost of the account. The three budgets were created by
# hand on 2026-10-30 and are imported under their exact names (ADR 0005, ADR 0023). The code is
# the source of truth: a console edit is reverted at the next deploy. The notification blocks are
# masked in plans because they carry the alarm address. The deploy role may modify exactly these
# names (budget_names in infra/bootstrap/terraform.tfvars).

locals {
  # Gross usage: credits and refunds excluded, so the 3 € and 5 € alerts track real usage.
  gross_excluded_record_types = ["Credit", "Refund"]

  # Net charge: credits count, so the Zero-Spend alert fires only on money actually owed
  # (NFR-COST-1). Refunds stay excluded, which only makes the alert fire earlier.
  net_excluded_record_types = ["Refund"]

  usage_notifications = [
    { notification_type = "ACTUAL", threshold = 85, threshold_type = "PERCENTAGE" },
    { notification_type = "ACTUAL", threshold = 100, threshold_type = "PERCENTAGE" },
    { notification_type = "FORECASTED", threshold = 100, threshold_type = "PERCENTAGE" },
  ]

  budgets = {
    "3-Euros Alarm" = {
      limit_amount          = "3.25"
      excluded_record_types = local.gross_excluded_record_types
      notifications         = local.usage_notifications
    }
    "5-Euros Alarm" = {
      limit_amount          = "5.4"
      excluded_record_types = local.gross_excluded_record_types
      notifications         = local.usage_notifications
    }
    "Zero-Spend Alarm" = {
      limit_amount          = "1.0"
      excluded_record_types = local.net_excluded_record_types
      notifications = [
        { notification_type = "ACTUAL", threshold = 0.01, threshold_type = "ABSOLUTE_VALUE" },
        { notification_type = "ACTUAL", threshold = 100, threshold_type = "PERCENTAGE" },
        { notification_type = "FORECASTED", threshold = 100, threshold_type = "PERCENTAGE" },
      ]
    }
  }
}

resource "aws_budgets_budget" "this" {
  for_each = local.budgets

  # The name forces replacement: a rename would delete the budget (blocked by prevent_destroy).
  name         = each.key
  budget_type  = "COST"
  limit_amount = each.value.limit_amount
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  # Optional and not computed in the provider: omitting it would plan a change to null.
  billing_view_arn = "arn:aws:billing::${local.account_id}:billingview/primary"
  metrics          = ["UnblendedCost"]

  filter_expression {
    not {
      dimensions {
        key    = "RECORD_TYPE"
        values = each.value.excluded_record_types
      }
    }
  }

  dynamic "notification" {
    for_each = each.value.notifications
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value.threshold
      threshold_type             = notification.value.threshold_type
      notification_type          = notification.value.notification_type
      subscriber_email_addresses = [local.alarm_email]
    }
  }

  # The budgets outlive the demo (PLAN M12). The deploy role holds budgets:ModifyBudget, which
  # also authorises DeleteBudget, so a plan that deletes a budget must fail. make destroy removes
  # them from state first.
  lifecycle {
    prevent_destroy = true
  }
}
