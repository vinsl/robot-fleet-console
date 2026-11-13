# E-mail channel of the CloudWatch alarms (NFR-OBS-2, ADR 0023). Budgets e-mail directly and do
# not publish here; EventBridge is added in M10; same-account Lambdas publish through their IAM
# role.

locals {
  topic_name       = "${var.name_prefix}-alarms"
  topic_arn        = "arn:aws:sns:${var.region}:${var.account_id}:${local.topic_name}"
  alarm_source_arn = "arn:aws:cloudwatch:${var.region}:${var.account_id}:alarm:${var.name_prefix}-*"
}

# Trivy AWS-0095 wants encryption at rest: CloudWatch alarms cannot publish to a topic encrypted
# with the AWS-managed key, and a customer-managed key is excluded for cost (SPEC section 11).
# Messages carry alarm metadata only (THREAT_MODEL R16).
#trivy:ignore:AWS-0095
resource "aws_sns_topic" "this" {
  #checkov:skip=CKV_AWS_26:No SSE: CloudWatch alarms cannot publish with the AWS-managed key, and a customer-managed key is excluded for cost (SPEC section 11, THREAT_MODEL R16).
  name = local.topic_name
  # SHA256 signatures on delivered messages.
  signature_version = 2
}

resource "aws_sns_topic_policy" "this" {
  arn = aws_sns_topic.this.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudWatchAlarmsOfDemo"
        Effect    = "Allow"
        Principal = { Service = "cloudwatch.amazonaws.com" }
        Action    = ["sns:Publish"]
        Resource  = [local.topic_arn]
        Condition = {
          ArnLike      = { "aws:SourceArn" = local.alarm_source_arn }
          StringEquals = { "aws:SourceAccount" = var.account_id }
        }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        # A wildcard such as sns:* is rejected by SetTopicAttributes ("action out of service scope").
        Action    = ["sns:Publish"]
        Resource  = [local.topic_arn]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })
}

# The owner confirms the subscription from the e-mail within 3 days; AWS deletes a pending
# subscription after that, and the next plan creates it again.
resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.this.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}
