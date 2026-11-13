# Executable checks of the queues module (ADR 0027): every queue is encrypted with the SQS-managed
# key, the telemetry queue keeps one hour and redrives after five receives, the dead-letter queue
# accepts redrives from its source only, every queue refuses plain HTTP, and every dead-letter queue
# and the rule error queue raises an alarm on the alarm topic when a message waits in it. Runs use a mocked
# provider, so no credentials and no AWS call are needed.

mock_provider "aws" {}

# The mock returns random ARNs at plan time. The fixed ARNs let the redrive policies be compared.
override_resource {
  target          = aws_sqs_queue.telemetry
  override_during = plan
  values          = { arn = "arn:aws:sqs:eu-west-3:123456789012:mfc-demo-telemetry" }
}

override_resource {
  target          = aws_sqs_queue.telemetry_dlq
  override_during = plan
  values          = { arn = "arn:aws:sqs:eu-west-3:123456789012:mfc-demo-telemetry-dlq" }
}

override_resource {
  target          = aws_sqs_queue.rule_errors
  override_during = plan
  values          = { arn = "arn:aws:sqs:eu-west-3:123456789012:mfc-demo-iot-rule-errors" }
}

override_resource {
  target          = aws_sqs_queue.ingest_events_dlq
  override_during = plan
  values          = { arn = "arn:aws:sqs:eu-west-3:123456789012:mfc-demo-ingest-events-dlq" }
}

variables {
  name_prefix     = "mfc-demo"
  account_id      = "123456789012"
  region          = "eu-west-3"
  alarm_topic_arn = "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"
}

run "every_queue_is_encrypted_with_the_sqs_managed_key" {
  command = plan

  module {
    source = "../../modules/queues"
  }

  assert {
    condition     = alltrue([for q in [aws_sqs_queue.telemetry, aws_sqs_queue.telemetry_dlq, aws_sqs_queue.rule_errors, aws_sqs_queue.ingest_events_dlq] : q.sqs_managed_sse_enabled])
    error_message = "every queue must use SQS-managed encryption"
  }

  assert {
    condition     = aws_sqs_queue.telemetry.name == "mfc-demo-telemetry" && aws_sqs_queue.telemetry_dlq.name == "mfc-demo-telemetry-dlq" && aws_sqs_queue.rule_errors.name == "mfc-demo-iot-rule-errors" && aws_sqs_queue.ingest_events_dlq.name == "mfc-demo-ingest-events-dlq"
    error_message = "the queues must carry the names of the design"
  }
}

run "telemetry_queue_keeps_one_hour_and_redrives_after_five_receives" {
  command = plan

  module {
    source = "../../modules/queues"
  }

  assert {
    condition     = aws_sqs_queue.telemetry.message_retention_seconds == 3600 && aws_sqs_queue.telemetry.visibility_timeout_seconds == 60 && aws_sqs_queue.telemetry.receive_wait_time_seconds == 20
    error_message = "the telemetry queue must keep 3600 s, a 60 s visibility timeout and long polling"
  }

  assert {
    condition     = jsondecode(aws_sqs_queue.telemetry.redrive_policy).maxReceiveCount == 5
    error_message = "the telemetry queue must redrive after five receives"
  }

  assert {
    condition     = aws_sqs_queue.telemetry_dlq.message_retention_seconds == 345600 && aws_sqs_queue.rule_errors.message_retention_seconds == 345600 && aws_sqs_queue.ingest_events_dlq.message_retention_seconds == 345600
    error_message = "every dead-letter and error queue must keep 345600 s"
  }
}

run "dead_letter_queue_accepts_redrive_from_the_telemetry_queue_only" {
  command = plan

  module {
    source = "../../modules/queues"
  }

  assert {
    condition     = jsondecode(aws_sqs_queue_redrive_allow_policy.telemetry_dlq.redrive_allow_policy).redrivePermission == "byQueue" && length(jsondecode(aws_sqs_queue_redrive_allow_policy.telemetry_dlq.redrive_allow_policy).sourceQueueArns) == 1
    error_message = "the telemetry dead-letter queue must allow redrives by queue, from one source"
  }
}

run "every_queue_refuses_plain_http" {
  command = plan

  module {
    source = "../../modules/queues"
  }

  assert {
    condition     = length(aws_sqs_queue_policy.insecure_transport) == 4
    error_message = "every queue must carry the transport policy"
  }

  assert {
    condition     = alltrue([for p in values(aws_sqs_queue_policy.insecure_transport) : length(jsondecode(p.policy).Statement) == 1 && jsondecode(p.policy).Statement[0].Effect == "Deny" && jsondecode(p.policy).Statement[0].Principal == "*" && jsondecode(p.policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false"])
    error_message = "every queue must deny every principal that does not use TLS, and nothing else"
  }
}

run "every_dead_letter_queue_alarms_on_a_visible_message" {
  command = plan

  module {
    source = "../../modules/queues"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.queue_not_empty) == 3 && alltrue([for a in values(aws_cloudwatch_metric_alarm.queue_not_empty) : a.namespace == "AWS/SQS" && a.metric_name == "ApproximateNumberOfMessagesVisible" && a.comparison_operator == "GreaterThanThreshold" && a.threshold == 0])
    error_message = "the telemetry and ingest dead-letter queues and the rule error queue must each alarm when ApproximateNumberOfMessagesVisible is above 0"
  }

  assert {
    condition     = alltrue([for a in values(aws_cloudwatch_metric_alarm.queue_not_empty) : length(a.alarm_actions) == 1 && contains(a.alarm_actions, "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms")])
    error_message = "every queue alarm must publish to the alarm topic"
  }

  assert {
    condition     = alltrue([for a in values(aws_cloudwatch_metric_alarm.queue_not_empty) : a.evaluation_periods == 1])
    error_message = "every queue alarm must evaluate one period"
  }

  assert {
    condition     = alltrue([for a in values(aws_cloudwatch_metric_alarm.queue_not_empty) : a.treat_missing_data == "notBreaching"])
    error_message = "every queue alarm must not breach on missing data"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.queue_not_empty["telemetry_dlq"].alarm_name == "mfc-demo-telemetry-dlq-not-empty" && aws_cloudwatch_metric_alarm.queue_not_empty["telemetry_dlq"].dimensions.QueueName == "mfc-demo-telemetry-dlq" && aws_cloudwatch_metric_alarm.queue_not_empty["ingest_events_dlq"].dimensions.QueueName == "mfc-demo-ingest-events-dlq" && aws_cloudwatch_metric_alarm.queue_not_empty["rule_errors"].dimensions.QueueName == "mfc-demo-iot-rule-errors"
    error_message = "every queue alarm must name its queue, and the alarm names must match the deploy role's mfc-demo-* grant"
  }
}
