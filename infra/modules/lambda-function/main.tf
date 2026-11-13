# One Lambda function with its own execution role (T16). The role carries the workload boundary,
# the business policy passed by the caller, and the logging and tracing permissions that every
# function needs. The module creates no resource policy: a caller grants invocation separately.

locals {
  log_group_name = "/aws/lambda/${var.name}"
}

data "archive_file" "this" {
  type        = "zip"
  source_dir  = var.source_dir
  output_path = "${path.root}/.build/${var.name}.zip"
}

resource "aws_iam_role" "this" {
  name                 = var.name
  path                 = var.role_path
  permissions_boundary = var.boundary_arn
  description          = "Execution role of ${var.name}."

  # Standard Lambda trust. The function is the only principal able to assume its own role.
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "TrustLambdaService"
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
        Action    = "sts:AssumeRole"
      },
    ]
  })
}

# Created only when the caller passes business permissions: a function that reads nothing and writes
# nothing (health, me) gets no inline business policy at all.
resource "aws_iam_role_policy" "business" {
  count  = var.policy_json == null ? 0 : 1
  name   = "${var.name}-business"
  role   = aws_iam_role.this.id
  policy = var.policy_json
}

# Logging and tracing are the same for every function, so they are scoped to this function only:
# its own log group, and the X-Ray write actions that carry no resource type.
resource "aws_iam_role_policy" "runtime" {
  #checkov:skip=CKV_AWS_355:xray:PutTraceSegments and xray:PutTelemetryRecords have no resource type; they are the only wildcard of this policy.
  name = "${var.name}-runtime"
  role = aws_iam_role.this.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteOwnLogStreams"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${aws_cloudwatch_log_group.this.arn}:*"]
      },
      {
        Sid      = "WriteTraces"
        Effect   = "Allow"
        Action   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
        Resource = ["*"]
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "this" {
  #checkov:skip=CKV_AWS_158:AWS-managed encryption of the log group: a customer-managed key is excluded for cost (SPEC section 11, THREAT_MODEL R2).
  #checkov:skip=CKV_AWS_338:Seven days of logs on purpose: NFR-OBS-1 and the cost policy of SPEC section 11.
  name              = local.log_group_name
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "this" {
  #checkov:skip=CKV_AWS_117:Not in a VPC on purpose: the function reaches only AWS APIs over public endpoints (ADR 0008).
  #checkov:skip=CKV_AWS_115:Account concurrency limit instead of a per-function reservation: throttling is handled by the caller (demo scale).
  #checkov:skip=CKV_AWS_173:No secret in the environment: configuration only (THREAT_MODEL R2).
  #checkov:skip=CKV_AWS_272:Code signing is deferred: bundles are built and deployed only by the deploy workflow from main (THREAT_MODEL R26).
  #checkov:skip=CKV_AWS_116:Synchronous functions pass a null dead-letter queue (ADR 0029); asynchronous ones pass a queue, pinned by the root tests.
  function_name    = var.name
  description      = var.description
  role             = aws_iam_role.this.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.this.output_path
  source_code_hash = data.archive_file.this.output_base64sha256
  timeout          = var.timeout
  memory_size      = var.memory_size

  tracing_config {
    mode = "Active"
  }

  environment {
    variables = var.environment
  }

  dynamic "dead_letter_config" {
    for_each = var.dead_letter_queue_arn == null ? [] : [var.dead_letter_queue_arn]
    content {
      target_arn = dead_letter_config.value
    }
  }

  # The function must not run before its policies and its log group exist.
  depends_on = [
    aws_iam_role_policy.business,
    aws_iam_role_policy.runtime,
    aws_cloudwatch_log_group.this,
  ]
}

resource "aws_lambda_function_event_invoke_config" "this" {
  function_name                = aws_lambda_function.this.function_name
  maximum_retry_attempts       = var.maximum_retry_attempts
  maximum_event_age_in_seconds = var.maximum_event_age_in_seconds
}

# Errors and throttles are the two signals that a function fails or saturates (ADR 0023). They live with
# the function, so that a new function cannot ship without them. Missing data means no invocation, which
# is the healthy state of an idle function. The alarms are created only when the caller gives a topic.
resource "aws_cloudwatch_metric_alarm" "errors" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.name}-errors"
  alarm_description   = "${var.name} returned errors: a request of the console failed in its function."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = var.name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
}

# A throttled function is one whose concurrency the operator must look at: the account limit is shared.
resource "aws_cloudwatch_metric_alarm" "throttles" {
  count = var.enable_alarms ? 1 : 0

  alarm_name          = "${var.name}-throttles"
  alarm_description   = "${var.name} was throttled: concurrent requests exceeded the account limit."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = var.name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
}
