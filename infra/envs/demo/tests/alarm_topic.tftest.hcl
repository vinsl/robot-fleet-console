# Executable checks of the alarm-topic module (NFR-OBS-2, ADR 0023): only the demo's CloudWatch
# alarms may publish, the topic must refuse plain HTTP, and the alarm address must reach the
# e-mail subscription. Runs use a mocked provider, so no credentials and no AWS call are needed.

mock_provider "aws" {}

variables {
  name_prefix = "mfc-demo"
  account_id  = "123456789012"
  region      = "eu-west-3"
  alarm_email = "ops@example.com"
}

run "topic_is_prefixed_and_signs_with_sha256" {
  command = plan

  module {
    source = "../../modules/alarm-topic"
  }

  assert {
    condition     = aws_sns_topic.this.name == "mfc-demo-alarms"
    error_message = "the alarm topic must be named mfc-demo-alarms"
  }

  assert {
    condition     = aws_sns_topic.this.signature_version == 2
    error_message = "the alarm topic must sign messages with SHA256"
  }
}

run "topic_policy_admits_only_demo_cloudwatch_alarms" {
  command = plan

  module {
    source = "../../modules/alarm-topic"
  }

  # Denied-access check: the only Allow statement must be CloudWatch alarms of this demo in this
  # account. Budgets publish nothing here (they e-mail directly), so budgets.amazonaws.com must
  # not appear in the policy at all.
  assert {
    condition     = length([for s in jsondecode(aws_sns_topic_policy.this.policy).Statement : s if s.Effect == "Allow"]) == 1
    error_message = "the topic policy must have exactly one Allow statement"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_sns_topic_policy.this.policy).Statement : s.Effect != "Allow" || (try(s.Principal.Service, null) == "cloudwatch.amazonaws.com" && try(s.Action, null) == ["sns:Publish"])])
    error_message = "the Allow statement must let only CloudWatch publish to the topic"
  }

  assert {
    condition     = one([for s in jsondecode(aws_sns_topic_policy.this.policy).Statement : s if s.Effect == "Allow"]).Condition.ArnLike["aws:SourceArn"] == "arn:aws:cloudwatch:eu-west-3:123456789012:alarm:mfc-demo-*"
    error_message = "only alarms named mfc-demo-* of this account may publish"
  }

  assert {
    condition     = one([for s in jsondecode(aws_sns_topic_policy.this.policy).Statement : s if s.Effect == "Allow"]).Condition.StringEquals["aws:SourceAccount"] == "123456789012"
    error_message = "the publishing alarms must belong to this account"
  }

  assert {
    condition     = !strcontains(aws_sns_topic_policy.this.policy, "budgets.amazonaws.com")
    error_message = "budgets must not publish to the alarm topic"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_sns_topic_policy.this.policy).Statement : s.Effect != "Allow" || (try(s.Principal, null) != "*" && try(s.Principal.AWS, null) != "*")])
    error_message = "no Allow statement may grant access to every principal"
  }
}

run "topic_policy_refuses_plain_http" {
  command = plan

  module {
    source = "../../modules/alarm-topic"
  }

  assert {
    condition     = one([for s in jsondecode(aws_sns_topic_policy.this.policy).Statement : s if s.Effect == "Deny"]).Condition.Bool["aws:SecureTransport"] == "false"
    error_message = "the topic must deny publishing over a connection that is not TLS"
  }

  assert {
    condition     = one([for s in jsondecode(aws_sns_topic_policy.this.policy).Statement : s if s.Effect == "Deny"]).Action == ["sns:Publish"]
    error_message = "the plain-HTTP denial must name sns:Publish, because SNS rejects a wildcard action in a topic policy"
  }
}

run "email_subscription_targets_the_alarm_address" {
  command = plan

  module {
    source = "../../modules/alarm-topic"
  }

  assert {
    condition     = aws_sns_topic_subscription.email.protocol == "email"
    error_message = "the alarm subscription must use the email protocol"
  }

  assert {
    condition     = nonsensitive(aws_sns_topic_subscription.email.endpoint) == "ops@example.com"
    error_message = "the alarm subscription must target the alarm address"
  }
}

run "invalid_alarm_email_is_rejected" {
  command = plan

  module {
    source = "../../modules/alarm-topic"
  }

  variables {
    alarm_email = "not-an-address"
  }

  expect_failures = [var.alarm_email]
}
