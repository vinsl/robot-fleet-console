# SQS queues of the robot ingest (ADR 0027, SPEC section 4.3). Every queue is encrypted with the
# SQS-managed key and refuses plain HTTP. Each source queue redrives to its own dead-letter queue,
# and each dead-letter queue accepts redrives from its source only.

locals {
  # Long retention on the dead-letter queues so that a failed message can be inspected for days.
  dead_letter_retention_seconds = 345600
  # One hour for live telemetry: a stale robot state is worth less than the queue cost (T22).
  telemetry_retention_seconds  = 3600
  telemetry_visibility_timeout = 60
  telemetry_max_receive_count  = 5
}

resource "aws_sqs_queue" "telemetry_dlq" {
  name                      = "${var.name_prefix}-telemetry-dlq"
  message_retention_seconds = local.dead_letter_retention_seconds
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "telemetry" {
  name                       = "${var.name_prefix}-telemetry"
  message_retention_seconds  = local.telemetry_retention_seconds
  visibility_timeout_seconds = local.telemetry_visibility_timeout
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.telemetry_dlq.arn
    maxReceiveCount     = local.telemetry_max_receive_count
  })
}

# Kept outside the queue resources: each queue names the other in its policy, and an inline
# attribute on both would make a dependency cycle.
resource "aws_sqs_queue_redrive_allow_policy" "telemetry_dlq" {
  queue_url = aws_sqs_queue.telemetry_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.telemetry.arn]
  })
}

resource "aws_sqs_queue" "rule_errors" {
  name                      = "${var.name_prefix}-iot-rule-errors"
  message_retention_seconds = local.dead_letter_retention_seconds
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "ingest_events_dlq" {
  name                      = "${var.name_prefix}-ingest-events-dlq"
  message_retention_seconds = local.dead_letter_retention_seconds
  sqs_managed_sse_enabled   = true
}

# A message in a dead-letter queue (or in the IoT rule error queue) is a failure nobody has seen yet:
# the alarm tells the operator by e-mail through the alarm topic of the stack (ADR 0023). The alarm
# fires on the first visible message; the queues keep it for days, so a late reading still shows it.
resource "aws_cloudwatch_metric_alarm" "queue_not_empty" {
  for_each = {
    telemetry_dlq     = aws_sqs_queue.telemetry_dlq
    ingest_events_dlq = aws_sqs_queue.ingest_events_dlq
    rule_errors       = aws_sqs_queue.rule_errors
  }

  alarm_name          = "${each.value.name}-not-empty"
  alarm_description   = "A message waits in ${each.value.name}: a robot message failed and was not processed."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = each.value.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  # An absent metric means no message was ever sent, which is the healthy state of a dead-letter queue.
  treat_missing_data = "notBreaching"
  alarm_actions      = [var.alarm_topic_arn]
}

# Refuses every request that does not use TLS. The identity policies of the callers still decide who
# may send or receive; this statement only restricts the transport.
resource "aws_sqs_queue_policy" "insecure_transport" {
  for_each = {
    telemetry         = aws_sqs_queue.telemetry
    telemetry_dlq     = aws_sqs_queue.telemetry_dlq
    rule_errors       = aws_sqs_queue.rule_errors
    ingest_events_dlq = aws_sqs_queue.ingest_events_dlq
  }

  queue_url = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["sqs:*"]
        Resource  = [each.value.arn]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })
}
