# Robot identity in AWS IoT Core (SPEC section 5, SEC-ID-1, SEC-ID-2, ADR 0030). One policy serves
# every robot: the client id must be the robot's own thing, and the topics are bound to the site and
# robot attributes of that thing. The attributes are written only by the robots function, so a robot
# cannot pick another robot's topics. Video credentials come from a role alias that grants master
# access to the robot's own signalling channel and nothing else.

locals {
  iot_arn = "arn:aws:iot:${var.region}:${var.account_id}"
  # Policy variables are escaped: "$${...}" renders the literal "${...}" that IoT resolves at connect.
  thing_name_var = "$${iot:Connection.Thing.ThingName}"
  site_var       = "$${iot:Connection.Thing.Attributes[siteId]}"
  robot_var      = "$${iot:Connection.Thing.Attributes[robotId]}"
  # ROLE_ALIAS_NAME of packages/protocol: the robot asks for this alias, the kit names it.
  role_alias_name = "${var.name_prefix}-robot-kvs-master"
  role_alias_arn  = "${local.iot_arn}:rolealias/${local.role_alias_name}"
  # The IoT V2 logging group has a name fixed by AWS (ADR 0020).
  iot_log_group_name = "AWSIotLogsV2"
  iot_log_group_arn  = "arn:aws:logs:${var.region}:${var.account_id}:log-group:${local.iot_log_group_name}"

  robot_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ConnectAsOwnThing"
        Effect   = "Allow"
        Action   = ["iot:Connect"]
        Resource = ["${local.iot_arn}:client/${local.thing_name_var}"]
        Condition = {
          Bool = { "iot:Connection.Thing.IsAttached" = "true" }
        }
      },
      {
        # Robots publish only through the rules, which re-check the topic against the payload and the client id.
        Sid    = "PublishOwnTopicsThroughRules"
        Effect = "Allow"
        Action = ["iot:Publish"]
        Resource = [
          "${local.iot_arn}:topic/$aws/rules/mfc_demo_telemetry/fleet/${local.site_var}/${local.robot_var}/telemetry",
          "${local.iot_arn}:topic/$aws/rules/mfc_demo_events/fleet/${local.site_var}/${local.robot_var}/events",
          "${local.iot_arn}:topic/$aws/rules/mfc_demo_acks/fleet/${local.site_var}/${local.robot_var}/cmd/ack",
        ]
      },
      {
        Sid      = "SubscribeOwnCommands"
        Effect   = "Allow"
        Action   = ["iot:Subscribe"]
        Resource = ["${local.iot_arn}:topicfilter/fleet/${local.site_var}/${local.robot_var}/cmd"]
      },
      {
        Sid      = "ReceiveOwnCommands"
        Effect   = "Allow"
        Action   = ["iot:Receive"]
        Resource = ["${local.iot_arn}:topic/fleet/${local.site_var}/${local.robot_var}/cmd"]
      },
      {
        Sid      = "GetOwnVideoCredentials"
        Effect   = "Allow"
        Action   = ["iot:AssumeRoleWithCertificate"]
        Resource = [local.role_alias_arn]
      },
    ]
  }

  # Master of the own channel only. No viewer action and no media action: the robot publishes its
  # stream, it never reads anyone else's (SEC-ID-2, THREAT_MODEL T8).
  kvs_master_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "MasterOfOwnChannelOnly"
        Effect = "Allow"
        Action = [
          "kinesisvideo:ConnectAsMaster",
          "kinesisvideo:GetSignalingChannelEndpoint",
          "kinesisvideo:GetIceServerConfig",
        ]
        Resource = ["arn:aws:kinesisvideo:${var.region}:${var.account_id}:channel/$${credentials-iot:ThingName}/*"]
      },
    ]
  }

  # The actions and resources are the ones AWS documents for IoT logging (configure-logging page).
  iot_logging_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteIotLogGroup"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:PutMetricFilter", "logs:PutRetentionPolicy"]
        Resource = [local.iot_log_group_arn]
      },
      {
        Sid      = "WriteIotLogStreams"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${local.iot_log_group_arn}:log-stream:*"]
      },
    ]
  }
}

# The policy names the thing and the attributes of the thing, so it fits one robot per certificate.
# It is the only aws_iot_policy of infra/ (scripts/check-iot-inventory.sh, THREAT_MODEL R20).
resource "aws_iot_policy" "robot" {
  name   = "${var.name_prefix}-robot"
  policy = jsonencode(local.robot_policy)
}

# Video master role. The trust is bound to this alias and to this account, so no other IoT
# credential path can assume it (THREAT_MODEL T8).
resource "aws_iam_role" "kvs_master" {
  name                 = local.role_alias_name
  path                 = var.role_path
  permissions_boundary = var.boundary_arn
  max_session_duration = 3600
  description          = "Video master of the robot channels, assumed through the IoT role alias."

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "TrustIotCredentialsOfAlias"
        Effect    = "Allow"
        Principal = { Service = "credentials.iot.amazonaws.com" }
        Action    = "sts:AssumeRole"
        Condition = {
          StringEquals = { "aws:SourceAccount" = var.account_id }
          ArnLike      = { "aws:SourceArn" = local.role_alias_arn }
        }
      },
    ]
  })
}

resource "aws_iam_role_policy" "kvs_master" {
  name   = "${local.role_alias_name}-master"
  role   = aws_iam_role.kvs_master.id
  policy = jsonencode(local.kvs_master_policy)
}

resource "aws_iot_role_alias" "kvs_master" {
  alias               = local.role_alias_name
  role_arn            = aws_iam_role.kvs_master.arn
  credential_duration = 3600
}

# Created here so that Terraform owns the retention of the group.
resource "aws_cloudwatch_log_group" "iot" {
  #checkov:skip=CKV_AWS_158:AWS-managed encryption of the log group: a customer-managed key is excluded for cost (SPEC section 11, THREAT_MODEL R2).
  #checkov:skip=CKV_AWS_338:Seven days of logs on purpose: NFR-OBS-1 and the cost policy of SPEC section 11.
  name              = local.iot_log_group_name
  retention_in_days = 7
}

resource "aws_iam_role" "iot_logging" {
  name                 = "${var.name_prefix}-iot-logging"
  path                 = var.role_path
  permissions_boundary = var.boundary_arn
  description          = "Writes the IoT Core logs to the AWSIotLogsV2 log group."

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
          ArnLike      = { "aws:SourceArn" = "${local.iot_arn}:*" }
        }
      },
    ]
  })
}

resource "aws_iam_role_policy" "iot_logging" {
  name   = "${var.name_prefix}-iot-logging"
  role   = aws_iam_role.iot_logging.id
  policy = jsonencode(local.iot_logging_policy)
}

# Logging at ERROR: refused connections leave a trace, and healthy sessions do not fill the group.
resource "aws_iot_logging_options" "this" {
  default_log_level = "ERROR"
  disable_all_logs  = false
  role_arn          = aws_iam_role.iot_logging.arn

  depends_on = [
    aws_iam_role_policy.iot_logging,
    aws_cloudwatch_log_group.iot,
  ]
}
