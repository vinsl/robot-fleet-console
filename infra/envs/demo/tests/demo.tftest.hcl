# Executable checks of the demo root: the budgets must match the hand-made ones and alert on the
# thresholds of the cost policy. Each run plans the configuration against a mocked AWS provider
# (no credentials, no AWS call), so a change that silently moves a threshold or a recipient fails
# the suite before deployment.

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "123456789012" }
  }
  override_data {
    target = data.aws_ssm_parameter.alarm_email
    values = { value = "ops@example.com" }
  }

  # The identity policies are built by aws_iam_policy_document, which the mock cannot evaluate. The
  # root runs take a fixed document here; identity.tftest.hcl asserts the real content.
  override_data {
    target = module.identity.data.aws_iam_policy_document.console_trust
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  override_data {
    target = module.identity.data.aws_iam_policy_document.console_video_viewer
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  # The bucket policies of the web module are built from the distribution ARN, which the mock cannot
  # evaluate. The root runs take fixed documents here; web.tftest.hcl asserts the real content.
  override_data {
    target = module.web.data.aws_iam_policy_document.console_read
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  override_data {
    target = module.web.data.aws_iam_policy_document.console_tls
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  override_data {
    target = module.web.data.aws_iam_policy_document.logs
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  # The bucket policy of the site maps is built from the bucket ARN, as the web policies are (M7).
  override_data {
    target = module.site_maps.data.aws_iam_policy_document.tls
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

# The Lambda modules zip the esbuild output, which CI does not build for this job: the archive
# provider is mocked so the budgets suite does not depend on services/api/dist.
mock_provider "archive" {}

# Mock providers cannot import; this override lets the import blocks plan.
override_resource {
  target = aws_budgets_budget.this
  values = { arn = "arn:aws:budgets::123456789012:budget/mock" }
}

# The mock returns random ARNs for the trail and the topic. These are the values the outputs must
# expose, so the outputs_expose_what_smoke_reads run pins them.
override_resource {
  target          = module.audit_trail.aws_cloudtrail.this
  override_during = plan
  values          = { arn = "arn:aws:cloudtrail:eu-west-3:123456789012:trail/mfc-demo-trail" }
}

override_resource {
  target          = module.alarm_topic.aws_sns_topic.this
  override_during = plan
  values          = { arn = "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms" }
}

run "budgets_match_the_hand_made_budgets" {
  command = plan

  assert {
    condition     = toset(keys(aws_budgets_budget.this)) == toset(["3-Euros Alarm", "5-Euros Alarm", "Zero-Spend Alarm"])
    error_message = "the demo root must manage exactly the three hand-made budgets"
  }

  assert {
    condition     = aws_budgets_budget.this["3-Euros Alarm"].limit_amount == "3.25" && aws_budgets_budget.this["5-Euros Alarm"].limit_amount == "5.4" && aws_budgets_budget.this["Zero-Spend Alarm"].limit_amount == "1.0"
    error_message = "budget limits must be 3.25, 5.4 and 1.0 USD"
  }

  assert {
    condition     = alltrue([for b in aws_budgets_budget.this : b.budget_type == "COST" && b.time_unit == "MONTHLY" && b.limit_unit == "USD"])
    error_message = "every budget must be a monthly COST budget in USD"
  }

  assert {
    condition     = alltrue([for b in aws_budgets_budget.this : length(b.metrics) == 1 && b.metrics[0] == "UnblendedCost"])
    error_message = "every budget must measure UnblendedCost"
  }

  assert {
    condition     = alltrue([for b in aws_budgets_budget.this : b.billing_view_arn == "arn:aws:billing::123456789012:billingview/primary"])
    error_message = "every budget must use the primary billing view of this account"
  }

  assert {
    condition     = alltrue([for b in aws_budgets_budget.this : b.filter_expression[0].not[0].dimensions[0].key == "RECORD_TYPE"])
    error_message = "every budget must filter on RECORD_TYPE"
  }
}

run "usage_budgets_alert_at_85_and_100_percent_and_on_forecast" {
  command = plan

  assert {
    condition = alltrue([for name in ["3-Euros Alarm", "5-Euros Alarm"] :
      length(aws_budgets_budget.this[name].notification) == 3
      && anytrue([for n in aws_budgets_budget.this[name].notification : n.notification_type == "ACTUAL" && n.threshold == 85 && n.threshold_type == "PERCENTAGE"])
      && anytrue([for n in aws_budgets_budget.this[name].notification : n.notification_type == "ACTUAL" && n.threshold == 100 && n.threshold_type == "PERCENTAGE"])
      && anytrue([for n in aws_budgets_budget.this[name].notification : n.notification_type == "FORECASTED" && n.threshold == 100 && n.threshold_type == "PERCENTAGE"])
    ])
    error_message = "3-Euros and 5-Euros must alert on ACTUAL 85 %, ACTUAL 100 % and FORECASTED 100 %"
  }

  assert {
    condition     = alltrue([for name in ["3-Euros Alarm", "5-Euros Alarm"] : alltrue([for n in aws_budgets_budget.this[name].notification : n.comparison_operator == "GREATER_THAN"])])
    error_message = "usage notifications must fire when the threshold is exceeded"
  }

  assert {
    condition     = alltrue([for name in ["3-Euros Alarm", "5-Euros Alarm"] : aws_budgets_budget.this[name].filter_expression[0].not[0].dimensions[0].values == tolist(["Credit", "Refund"])])
    error_message = "3-Euros and 5-Euros must exclude credits and refunds (gross usage)"
  }
}

run "zero_spend_alerts_on_one_cent" {
  command = plan

  assert {
    condition     = length(aws_budgets_budget.this["Zero-Spend Alarm"].notification) == 3
    error_message = "Zero-Spend Alarm must have exactly three notifications"
  }

  assert {
    condition     = anytrue([for n in aws_budgets_budget.this["Zero-Spend Alarm"].notification : n.notification_type == "ACTUAL" && n.comparison_operator == "GREATER_THAN" && n.threshold == 0.01 && n.threshold_type == "ABSOLUTE_VALUE"])
    error_message = "Zero-Spend Alarm must alert as soon as one cent is spent"
  }
}

run "zero_spend_counts_credits" {
  command = plan

  assert {
    condition     = aws_budgets_budget.this["Zero-Spend Alarm"].filter_expression[0].not[0].dimensions[0].values == tolist(["Refund"])
    error_message = "Zero-Spend Alarm must count credits: only refunds are excluded"
  }

  assert {
    condition     = alltrue([for name in ["3-Euros Alarm", "5-Euros Alarm"] : aws_budgets_budget.this[name].filter_expression[0].not[0].dimensions[0].values == tolist(["Credit", "Refund"])])
    error_message = "3-Euros and 5-Euros must keep excluding credits and refunds"
  }
}

run "every_budget_notification_mails_the_alarm_address_only" {
  command = plan

  assert {
    condition = nonsensitive(alltrue([for b in aws_budgets_budget.this : alltrue([for n in b.notification :
      n.subscriber_email_addresses == toset(["ops@example.com"])
      && length(coalesce(n.subscriber_sns_topic_arns, [])) == 0
    ])]))
    error_message = "every budget notification must mail the alarm address and nothing else"
  }
}

# Bootstrap (infra/bootstrap/policies.tf) hard-codes the trail name mfc-demo-trail and the bucket
# pattern mfc-demo-trail-*, which the CI deploy role uses to keep CI out of the trail bucket (ADR 0024).
# These two asserts pin this root to those values: the two roots must change together.
run "names_carry_the_demo_prefix" {
  command = plan

  assert {
    condition     = output.trail_name == "mfc-demo-trail"
    error_message = "the trail must be named mfc-demo-trail: bootstrap policies.tf hard-codes this name, so the two must change together"
  }

  assert {
    condition     = can(regex("^${replace("mfc-demo-trail-*", "*", ".*")}$", output.trail_bucket_name))
    error_message = "the trail bucket must match the mfc-demo-trail-* pattern that bootstrap policies.tf hard-codes: the two must change together (ADR 0024)"
  }
}

run "outputs_expose_what_smoke_reads" {
  command = plan

  assert {
    condition     = output.alarm_topic_arn == "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"
    error_message = "the alarm topic output must be the ARN of mfc-demo-alarms"
  }

  assert {
    condition     = output.trail_arn == "arn:aws:cloudtrail:eu-west-3:123456789012:trail/mfc-demo-trail"
    error_message = "the trail output must be the ARN of mfc-demo-trail"
  }

  assert {
    condition     = output.trail_bucket_name != ""
    error_message = "the trail bucket output must not be empty"
  }
}

run "region_outside_the_allowed_pair_is_rejected" {
  command = plan

  variables {
    region = "us-east-1"
  }

  expect_failures = [var.region]
}

run "invalid_bucket_suffix_is_rejected" {
  command = plan

  variables {
    bucket_suffix = "Bad_Suffix"
  }

  expect_failures = [var.bucket_suffix]
}
