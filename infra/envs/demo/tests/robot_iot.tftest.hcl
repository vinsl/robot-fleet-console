# Executable checks of the robot-iot module (SPEC section 5, SEC-ID-1, SEC-ID-2, ADR 0030): the one
# robot policy has exactly the five actions and the resources of this design, no wildcard, the video
# role can master only its own channel, and the IoT logs are written at ERROR to AWSIotLogsV2.
# Runs use a mocked provider, so no credentials and no AWS call are needed.

mock_provider "aws" {}

variables {
  name_prefix  = "mfc-demo"
  account_id   = "123456789012"
  region       = "eu-west-3"
  boundary_arn = "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary"
  role_path    = "/mfc-demo/"
}

run "robot_policy_is_the_single_named_policy_without_wildcards" {
  command = plan

  module {
    source = "../../modules/robot-iot"
  }

  assert {
    condition     = aws_iot_policy.robot.name == "mfc-demo-robot"
    error_message = "the robot policy must be named mfc-demo-robot"
  }

  assert {
    condition     = !strcontains(aws_iot_policy.robot.policy, "*") && !strcontains(aws_iot_policy.robot.policy, "+") && !strcontains(aws_iot_policy.robot.policy, "#")
    error_message = "the robot policy must not contain a wildcard, a single-level or a multi-level topic wildcard"
  }

  assert {
    condition     = toset(flatten([for s in jsondecode(aws_iot_policy.robot.policy).Statement : s.Action])) == toset(["iot:Connect", "iot:Publish", "iot:Subscribe", "iot:Receive", "iot:AssumeRoleWithCertificate"])
    error_message = "the robot policy must grant exactly Connect, Publish, Subscribe, Receive and AssumeRoleWithCertificate"
  }
}

run "robot_policy_document_is_exactly_the_reviewed_document" {
  command = plan

  module {
    source = "../../modules/robot-iot"
  }

  # The whole document, statement by statement: a new statement, a new action or a changed condition fails here.
  assert {
    condition = jsondecode(aws_iot_policy.robot.policy) == {
      Version = "2012-10-17"
      Statement = [
        {
          Sid       = "ConnectAsOwnThing"
          Effect    = "Allow"
          Action    = ["iot:Connect"]
          Resource  = ["arn:aws:iot:eu-west-3:123456789012:client/$${iot:Connection.Thing.ThingName}"]
          Condition = { Bool = { "iot:Connection.Thing.IsAttached" = "true" } }
        },
        {
          Sid    = "PublishOwnTopicsThroughRules"
          Effect = "Allow"
          Action = ["iot:Publish"]
          Resource = [
            "arn:aws:iot:eu-west-3:123456789012:topic/$aws/rules/mfc_demo_telemetry/fleet/$${iot:Connection.Thing.Attributes[siteId]}/$${iot:Connection.Thing.Attributes[robotId]}/telemetry",
            "arn:aws:iot:eu-west-3:123456789012:topic/$aws/rules/mfc_demo_events/fleet/$${iot:Connection.Thing.Attributes[siteId]}/$${iot:Connection.Thing.Attributes[robotId]}/events",
            "arn:aws:iot:eu-west-3:123456789012:topic/$aws/rules/mfc_demo_acks/fleet/$${iot:Connection.Thing.Attributes[siteId]}/$${iot:Connection.Thing.Attributes[robotId]}/cmd/ack",
          ]
        },
        {
          Sid      = "SubscribeOwnCommands"
          Effect   = "Allow"
          Action   = ["iot:Subscribe"]
          Resource = ["arn:aws:iot:eu-west-3:123456789012:topicfilter/fleet/$${iot:Connection.Thing.Attributes[siteId]}/$${iot:Connection.Thing.Attributes[robotId]}/cmd"]
        },
        {
          Sid      = "ReceiveOwnCommands"
          Effect   = "Allow"
          Action   = ["iot:Receive"]
          Resource = ["arn:aws:iot:eu-west-3:123456789012:topic/fleet/$${iot:Connection.Thing.Attributes[siteId]}/$${iot:Connection.Thing.Attributes[robotId]}/cmd"]
        },
        {
          Sid      = "GetOwnVideoCredentials"
          Effect   = "Allow"
          Action   = ["iot:AssumeRoleWithCertificate"]
          Resource = ["arn:aws:iot:eu-west-3:123456789012:rolealias/mfc-demo-robot-kvs-master"]
        },
      ]
    }
    error_message = "the robot policy document must be exactly the reviewed document of ADR 0030"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_iot_policy.robot.policy).Statement : alltrue([for r in s.Resource : !strcontains(r, "*") && !strcontains(r, "+") && !strcontains(r, "#")])])
    error_message = "no resource of the robot policy may contain a wildcard, a single-level or a multi-level topic wildcard"
  }

  assert {
    condition     = alltrue([for r in one([for s in jsondecode(aws_iot_policy.robot.policy).Statement : s if s.Sid == "PublishOwnTopicsThroughRules"]).Resource : strcontains(r, "Attributes[siteId]") && strcontains(r, "Attributes[robotId]")])
    error_message = "each of the three publish topics must be bound to the site and robot attributes of the thing"
  }

  assert {
    condition     = one([for s in jsondecode(aws_iot_policy.robot.policy).Statement : s if s.Sid == "ConnectAsOwnThing"]).Condition == { Bool = { "iot:Connection.Thing.IsAttached" = "true" } }
    error_message = "Connect must carry exactly the IsAttached condition and no other"
  }
}

run "connect_is_bound_to_the_own_thing_and_an_attached_certificate" {
  command = plan

  module {
    source = "../../modules/robot-iot"
  }

  assert {
    condition     = one([for s in jsondecode(aws_iot_policy.robot.policy).Statement : s if s.Sid == "ConnectAsOwnThing"]).Resource == ["arn:aws:iot:eu-west-3:123456789012:client/$${iot:Connection.Thing.ThingName}"]
    error_message = "Connect must name only the client id equal to the thing name"
  }

  assert {
    condition     = one([for s in jsondecode(aws_iot_policy.robot.policy).Statement : s if s.Sid == "ConnectAsOwnThing"]).Condition.Bool["iot:Connection.Thing.IsAttached"] == "true"
    error_message = "Connect must require a certificate attached to the thing"
  }
}

run "publish_subscribe_and_receive_are_bound_to_the_own_robot_topics" {
  command = plan

  module {
    source = "../../modules/robot-iot"
  }

  assert {
    condition = toset(one([for s in jsondecode(aws_iot_policy.robot.policy).Statement : s if s.Sid == "PublishOwnTopicsThroughRules"]).Resource) == toset([
      "arn:aws:iot:eu-west-3:123456789012:topic/$aws/rules/mfc_demo_telemetry/fleet/$${iot:Connection.Thing.Attributes[siteId]}/$${iot:Connection.Thing.Attributes[robotId]}/telemetry",
      "arn:aws:iot:eu-west-3:123456789012:topic/$aws/rules/mfc_demo_events/fleet/$${iot:Connection.Thing.Attributes[siteId]}/$${iot:Connection.Thing.Attributes[robotId]}/events",
      "arn:aws:iot:eu-west-3:123456789012:topic/$aws/rules/mfc_demo_acks/fleet/$${iot:Connection.Thing.Attributes[siteId]}/$${iot:Connection.Thing.Attributes[robotId]}/cmd/ack",
    ])
    error_message = "Publish must name exactly the three rule topics of the own robot"
  }

  assert {
    condition     = one([for s in jsondecode(aws_iot_policy.robot.policy).Statement : s if s.Sid == "SubscribeOwnCommands"]).Resource == ["arn:aws:iot:eu-west-3:123456789012:topicfilter/fleet/$${iot:Connection.Thing.Attributes[siteId]}/$${iot:Connection.Thing.Attributes[robotId]}/cmd"]
    error_message = "Subscribe must name only the command topic filter of the own robot"
  }

  assert {
    condition     = one([for s in jsondecode(aws_iot_policy.robot.policy).Statement : s if s.Sid == "ReceiveOwnCommands"]).Resource == ["arn:aws:iot:eu-west-3:123456789012:topic/fleet/$${iot:Connection.Thing.Attributes[siteId]}/$${iot:Connection.Thing.Attributes[robotId]}/cmd"]
    error_message = "Receive must name only the command topic of the own robot"
  }
}

run "video_credentials_come_only_from_the_role_alias" {
  command = plan

  module {
    source = "../../modules/robot-iot"
  }

  assert {
    condition     = one([for s in jsondecode(aws_iot_policy.robot.policy).Statement : s if s.Sid == "GetOwnVideoCredentials"]).Resource == ["arn:aws:iot:eu-west-3:123456789012:rolealias/mfc-demo-robot-kvs-master"]
    error_message = "AssumeRoleWithCertificate must name exactly the role alias"
  }

  assert {
    condition     = aws_iot_role_alias.kvs_master.alias == "mfc-demo-robot-kvs-master" && aws_iot_role_alias.kvs_master.credential_duration == 3600
    error_message = "the role alias must be mfc-demo-robot-kvs-master with a one-hour credential"
  }
}

run "video_master_role_is_bound_to_the_alias_and_the_credentials_service" {
  command = plan

  module {
    source = "../../modules/robot-iot"
  }

  assert {
    condition     = aws_iam_role.kvs_master.permissions_boundary == "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary" && aws_iam_role.kvs_master.path == "/mfc-demo/" && aws_iam_role.kvs_master.max_session_duration == 3600
    error_message = "the video master role must carry the boundary, the /mfc-demo/ path and a one-hour session"
  }

  assert {
    condition     = keys(jsondecode(aws_iam_role.kvs_master.assume_role_policy).Statement[0].Principal) == ["Service"] && jsondecode(aws_iam_role.kvs_master.assume_role_policy).Statement[0].Principal.Service == "credentials.iot.amazonaws.com"
    error_message = "the video master role must be trusted by the IoT credentials service only"
  }

  assert {
    condition     = jsondecode(aws_iam_role.kvs_master.assume_role_policy).Statement[0].Condition.StringEquals["aws:SourceAccount"] == "123456789012" && jsondecode(aws_iam_role.kvs_master.assume_role_policy).Statement[0].Condition.ArnLike["aws:SourceArn"] == "arn:aws:iot:eu-west-3:123456789012:rolealias/mfc-demo-robot-kvs-master"
    error_message = "the trust must be bound to this account and to the role alias"
  }
}

run "video_master_role_masters_only_the_own_channel" {
  command = plan

  module {
    source = "../../modules/robot-iot"
  }

  assert {
    condition     = toset(jsondecode(aws_iam_role_policy.kvs_master.policy).Statement[0].Action) == toset(["kinesisvideo:ConnectAsMaster", "kinesisvideo:GetSignalingChannelEndpoint", "kinesisvideo:GetIceServerConfig"])
    error_message = "the video master role must have exactly the three master actions"
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.kvs_master.policy).Statement[0].Resource == ["arn:aws:kinesisvideo:eu-west-3:123456789012:channel/$${credentials-iot:ThingName}/*"]
    error_message = "the master actions must apply to the channel named after the thing and nothing else"
  }

  assert {
    condition     = !strcontains(aws_iam_role_policy.kvs_master.policy, "ConnectAsViewer") && !strcontains(aws_iam_role_policy.kvs_master.policy, "kinesisvideo:*")
    error_message = "the video master role must never be a viewer and must carry no wildcard action"
  }
}

run "iot_logs_are_written_at_error_to_the_fixed_group_for_seven_days" {
  command = plan

  module {
    source = "../../modules/robot-iot"
  }

  assert {
    condition     = aws_iot_logging_options.this.default_log_level == "ERROR" && aws_iot_logging_options.this.disable_all_logs == false
    error_message = "IoT logging must be enabled at ERROR"
  }

  assert {
    condition     = aws_cloudwatch_log_group.iot.name == "AWSIotLogsV2" && aws_cloudwatch_log_group.iot.retention_in_days == 7
    error_message = "the IoT log group must be AWSIotLogsV2 and keep seven days"
  }

  assert {
    condition     = aws_iam_role.iot_logging.path == "/mfc-demo/" && aws_iam_role.iot_logging.permissions_boundary == "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary"
    error_message = "the IoT logging role must carry the boundary and the /mfc-demo/ path"
  }

  assert {
    condition     = jsondecode(aws_iam_role.iot_logging.assume_role_policy).Statement[0].Principal.Service == "iot.amazonaws.com" && jsondecode(aws_iam_role.iot_logging.assume_role_policy).Statement[0].Condition.ArnLike["aws:SourceArn"] == "arn:aws:iot:eu-west-3:123456789012:*"
    error_message = "the IoT logging role must be trusted by IoT for this account only"
  }
}

run "iot_logging_policy_is_the_documented_pair_of_statements" {
  command = plan

  module {
    source = "../../modules/robot-iot"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.iot_logging.policy).Statement) == 2
    error_message = "the IoT logging policy must have exactly the two documented statements"
  }

  assert {
    condition     = toset(jsondecode(aws_iam_role_policy.iot_logging.policy).Statement[0].Action) == toset(["logs:CreateLogGroup", "logs:PutMetricFilter", "logs:PutRetentionPolicy"]) && jsondecode(aws_iam_role_policy.iot_logging.policy).Statement[0].Resource == ["arn:aws:logs:eu-west-3:123456789012:log-group:AWSIotLogsV2"]
    error_message = "the first statement must cover the AWSIotLogsV2 group with the documented group actions"
  }

  assert {
    condition     = toset(jsondecode(aws_iam_role_policy.iot_logging.policy).Statement[1].Action) == toset(["logs:CreateLogStream", "logs:PutLogEvents"]) && jsondecode(aws_iam_role_policy.iot_logging.policy).Statement[1].Resource == ["arn:aws:logs:eu-west-3:123456789012:log-group:AWSIotLogsV2:log-stream:*"]
    error_message = "the second statement must cover the streams of AWSIotLogsV2 with the documented stream actions"
  }
}
