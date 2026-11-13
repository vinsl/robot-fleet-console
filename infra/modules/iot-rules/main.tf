# IoT topic rules that move robot traffic into AWS (SPEC section 5). Telemetry goes to the SQS queue
# for the consumer of M5; events, acks and presence go to the ingest-events function, which validates
# them before any write. Every rule has an error action, so a failed delivery is kept, not dropped.

locals {
  rule_names = {
    telemetry = "mfc_demo_telemetry"
    events    = "mfc_demo_events"
    acks      = "mfc_demo_acks"
    presence  = "mfc_demo_presence"
  }

  # The same envelope in every robot rule: the ingest function sees one shape whatever the stream.
  envelope_select = "SELECT 'robot' AS source, topic() AS iotTopic, clientid() AS iotClientId, timestamp() AS iotReceivedAt, encode(*, 'base64') AS payloadBase64"

  # Filters are the ones of packages/protocol ruleSourceFilter; the iot_rules test pins the literals.
  rules_role_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "SendToRuleQueues"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = [var.telemetry_queue_arn, var.errors_queue_arn]
      },
    ]
  }
}

resource "aws_iam_role" "rules" {
  name                 = "${var.name_prefix}-iot-rules"
  path                 = var.role_path
  permissions_boundary = var.boundary_arn
  description          = "Lets the IoT topic rules send to the telemetry and error queues."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "TrustIotService"
        Effect    = "Allow"
        Principal = { Service = "iot.amazonaws.com" }
        Action    = "sts:AssumeRole"
        Condition = {
          StringEquals = { "aws:SourceAccount" = var.account_id }
          ArnLike      = { "aws:SourceArn" = "arn:aws:iot:${var.region}:${var.account_id}:*" }
        }
      },
    ]
  })
}

resource "aws_iam_role_policy" "rules" {
  name   = "${var.name_prefix}-iot-rules"
  role   = aws_iam_role.rules.id
  policy = jsonencode(local.rules_role_policy)
}

resource "aws_iot_topic_rule" "telemetry" {
  name        = local.rule_names.telemetry
  description = "Robot telemetry to the telemetry queue."
  enabled     = true
  sql         = "${local.envelope_select} FROM 'fleet/+/+/telemetry'"
  sql_version = "2016-03-23"

  sqs {
    queue_url  = var.telemetry_queue_url
    role_arn   = aws_iam_role.rules.arn
    use_base64 = false
  }

  error_action {
    sqs {
      queue_url  = var.errors_queue_url
      role_arn   = aws_iam_role.rules.arn
      use_base64 = false
    }
  }

  depends_on = [aws_iam_role_policy.rules]
}

resource "aws_iot_topic_rule" "events" {
  name        = local.rule_names.events
  description = "Robot events to the ingest-events function."
  enabled     = true
  sql         = "${local.envelope_select} FROM 'fleet/+/+/events'"
  sql_version = "2016-03-23"

  lambda {
    function_arn = var.ingest_events_function_arn
  }

  error_action {
    sqs {
      queue_url  = var.errors_queue_url
      role_arn   = aws_iam_role.rules.arn
      use_base64 = false
    }
  }

  depends_on = [aws_iam_role_policy.rules]
}

resource "aws_iot_topic_rule" "acks" {
  name        = local.rule_names.acks
  description = "Robot command acknowledgements to the ingest-events function."
  enabled     = true
  sql         = "${local.envelope_select} FROM 'fleet/+/+/cmd/ack'"
  sql_version = "2016-03-23"

  lambda {
    function_arn = var.ingest_events_function_arn
  }

  error_action {
    sqs {
      queue_url  = var.errors_queue_url
      role_arn   = aws_iam_role.rules.arn
      use_base64 = false
    }
  }

  depends_on = [aws_iam_role_policy.rules]
}

# Presence comes from the AWS lifecycle events: only the demo clients are forwarded. The select list is
# exactly the fields of PresenceEventSchema (packages/protocol), as AWS names them. A wildcard would also
# pass ipAddress, principalIdentifier and sessionIdentifier, which would then reach the error queue and the
# ingest dead-letter queue, where a connection address must never sit.
# thingName and connect_failed are defensive: AWS lifecycle events do not carry thingName, and the cloud
# keys presence on clientId, so the selection of both is harmless and kept for the schema.
resource "aws_iot_topic_rule" "presence" {
  name        = local.rule_names.presence
  description = "Lifecycle events of the demo clients to the ingest-events function."
  enabled     = true
  sql         = "SELECT clientId, eventType, timestamp, versionNumber, clientInitiatedDisconnect, disconnectReason, connectFailureReason, thingName, 'presence' AS source FROM '$aws/events/presence/+/+' WHERE startswith(clientId, 'mfc-demo-')"
  sql_version = "2016-03-23"

  lambda {
    function_arn = var.ingest_events_function_arn
  }

  error_action {
    sqs {
      queue_url  = var.errors_queue_url
      role_arn   = aws_iam_role.rules.arn
      use_base64 = false
    }
  }

  depends_on = [aws_iam_role_policy.rules]
}

# One invoke permission per rule that calls the function. The function has no other permission:
# the robots function is never a target of a topic rule.
resource "aws_lambda_permission" "rule" {
  for_each = {
    events   = aws_iot_topic_rule.events
    acks     = aws_iot_topic_rule.acks
    presence = aws_iot_topic_rule.presence
  }

  statement_id   = "AllowIotRule-${each.value.name}"
  action         = "lambda:InvokeFunction"
  function_name  = var.ingest_events_function_name
  principal      = "iot.amazonaws.com"
  source_arn     = each.value.arn
  source_account = var.account_id
}

# A ParseError means the rule engine could not decode a robot message. The error action keeps the message
# in the error queue, so the alarm tells the operator that messages are being kept, not lost (ADR 0023).
# The names start with the stack prefix: the alarm topic admits only alarms named mfc-demo-*.
resource "aws_cloudwatch_metric_alarm" "parse_error" {
  for_each = local.rule_names

  alarm_name          = "${var.name_prefix}-iot-${each.key}-parse-error"
  alarm_description   = "The rule ${each.value} could not parse a robot message: the message went to the rule error queue."
  namespace           = "AWS/IoT"
  metric_name         = "ParseError"
  dimensions          = { RuleName = each.value }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
}
