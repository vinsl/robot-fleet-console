# Executable checks of the iot-rules module (SPEC section 5, ADR 0027): the four rule names, the exact
# SQL of each rule (the presence rule selects an explicit field list, never a wildcard), the telemetry
# rule to the queue only and the three others to the ingest-events function only, an error action on
# every rule, a rules role that sends to two queues only, and the invoke permissions for the three
# function rules. Runs use a mocked provider; the rule ARNs are fixed so that the permissions can be
# compared exactly. Every rule also has a ParseError alarm on the alarm topic (ADR 0023).

mock_provider "aws" {}

variables {
  name_prefix                 = "mfc-demo"
  account_id                  = "123456789012"
  region                      = "eu-west-3"
  boundary_arn                = "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary"
  role_path                   = "/mfc-demo/"
  telemetry_queue_url         = "https://sqs.eu-west-3.amazonaws.com/123456789012/mfc-demo-telemetry"
  telemetry_queue_arn         = "arn:aws:sqs:eu-west-3:123456789012:mfc-demo-telemetry"
  errors_queue_url            = "https://sqs.eu-west-3.amazonaws.com/123456789012/mfc-demo-iot-rule-errors"
  errors_queue_arn            = "arn:aws:sqs:eu-west-3:123456789012:mfc-demo-iot-rule-errors"
  ingest_events_function_arn  = "arn:aws:lambda:eu-west-3:123456789012:function:mfc-demo-ingest-events"
  ingest_events_function_name = "mfc-demo-ingest-events"
  alarm_topic_arn             = "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"
}

# The mock returns random ARNs at plan time: the rule ARNs are fixed for the permission checks.
override_resource {
  target          = aws_iot_topic_rule.events
  override_during = plan
  values          = { arn = "arn:aws:iot:eu-west-3:123456789012:rule/mfc_demo_events" }
}

override_resource {
  target          = aws_iot_topic_rule.acks
  override_during = plan
  values          = { arn = "arn:aws:iot:eu-west-3:123456789012:rule/mfc_demo_acks" }
}

override_resource {
  target          = aws_iot_topic_rule.presence
  override_during = plan
  values          = { arn = "arn:aws:iot:eu-west-3:123456789012:rule/mfc_demo_presence" }
}

run "four_enabled_rules_carry_the_demo_names" {
  command = plan

  module {
    source = "../../modules/iot-rules"
  }

  assert {
    condition     = output.rule_names == tolist(["mfc_demo_telemetry", "mfc_demo_events", "mfc_demo_acks", "mfc_demo_presence"])
    error_message = "the module must create exactly the four rules mfc_demo_telemetry, _events, _acks and _presence"
  }

  assert {
    condition     = alltrue([for r in [aws_iot_topic_rule.telemetry, aws_iot_topic_rule.events, aws_iot_topic_rule.acks, aws_iot_topic_rule.presence] : r.enabled && r.sql_version == "2016-03-23"])
    error_message = "every rule must be enabled and use SQL version 2016-03-23"
  }
}

run "rule_sql_is_exact" {
  command = plan

  module {
    source = "../../modules/iot-rules"
  }

  assert {
    condition     = aws_iot_topic_rule.telemetry.sql == "SELECT 'robot' AS source, topic() AS iotTopic, clientid() AS iotClientId, timestamp() AS iotReceivedAt, encode(*, 'base64') AS payloadBase64 FROM 'fleet/+/+/telemetry'"
    error_message = "the telemetry SQL must select the robot envelope from fleet/+/+/telemetry"
  }

  assert {
    condition     = aws_iot_topic_rule.events.sql == "SELECT 'robot' AS source, topic() AS iotTopic, clientid() AS iotClientId, timestamp() AS iotReceivedAt, encode(*, 'base64') AS payloadBase64 FROM 'fleet/+/+/events'"
    error_message = "the events SQL must select the robot envelope from fleet/+/+/events"
  }

  assert {
    condition     = aws_iot_topic_rule.acks.sql == "SELECT 'robot' AS source, topic() AS iotTopic, clientid() AS iotClientId, timestamp() AS iotReceivedAt, encode(*, 'base64') AS payloadBase64 FROM 'fleet/+/+/cmd/ack'"
    error_message = "the acks SQL must select the robot envelope from fleet/+/+/cmd/ack"
  }

  assert {
    condition     = aws_iot_topic_rule.presence.sql == "SELECT clientId, eventType, timestamp, versionNumber, clientInitiatedDisconnect, disconnectReason, connectFailureReason, thingName, 'presence' AS source FROM '$aws/events/presence/+/+' WHERE startswith(clientId, 'mfc-demo-')"
    error_message = "the presence SQL must select exactly the PresenceEventSchema fields (no wildcard, so no ipAddress, principalIdentifier or sessionIdentifier) and forward only the lifecycle events of the demo clients"
  }
}

run "telemetry_rule_writes_to_the_queue_only" {
  command = plan

  module {
    source = "../../modules/iot-rules"
  }

  assert {
    condition     = length(aws_iot_topic_rule.telemetry.sqs) == 1 && length(aws_iot_topic_rule.telemetry.lambda) == 0 && one(aws_iot_topic_rule.telemetry.sqs).queue_url == "https://sqs.eu-west-3.amazonaws.com/123456789012/mfc-demo-telemetry" && one(aws_iot_topic_rule.telemetry.sqs).use_base64 == false
    error_message = "the telemetry rule must write the telemetry queue as text and invoke no function"
  }
}

run "other_rules_invoke_the_ingest_function_only" {
  command = plan

  module {
    source = "../../modules/iot-rules"
  }

  assert {
    condition     = alltrue([for r in [aws_iot_topic_rule.events, aws_iot_topic_rule.acks, aws_iot_topic_rule.presence] : length(r.lambda) == 1 && length(r.sqs) == 0 && one(r.lambda).function_arn == "arn:aws:lambda:eu-west-3:123456789012:function:mfc-demo-ingest-events"])
    error_message = "the events, acks and presence rules must invoke the ingest-events function and nothing else"
  }
}

run "every_rule_keeps_failed_deliveries_in_the_error_queue" {
  command = plan

  module {
    source = "../../modules/iot-rules"
  }

  assert {
    condition     = alltrue([for r in [aws_iot_topic_rule.telemetry, aws_iot_topic_rule.events, aws_iot_topic_rule.acks, aws_iot_topic_rule.presence] : length(r.error_action) == 1 && one(one(r.error_action).sqs).queue_url == "https://sqs.eu-west-3.amazonaws.com/123456789012/mfc-demo-iot-rule-errors" && one(one(r.error_action).sqs).use_base64 == false])
    error_message = "every rule must send its failed deliveries to the rule error queue"
  }
}

run "rules_role_sends_to_the_two_queues_only" {
  command = plan

  module {
    source = "../../modules/iot-rules"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.rules.policy).Statement) == 1 && jsondecode(aws_iam_role_policy.rules.policy).Statement[0].Action == ["sqs:SendMessage"]
    error_message = "the rules role must allow sqs:SendMessage and nothing else"
  }

  assert {
    condition     = toset(jsondecode(aws_iam_role_policy.rules.policy).Statement[0].Resource) == toset(["arn:aws:sqs:eu-west-3:123456789012:mfc-demo-telemetry", "arn:aws:sqs:eu-west-3:123456789012:mfc-demo-iot-rule-errors"])
    error_message = "the rules role must name the telemetry queue and the error queue only"
  }
}

run "rules_role_is_bound_to_iot_in_this_account_with_boundary_and_path" {
  command = plan

  module {
    source = "../../modules/iot-rules"
  }

  assert {
    condition     = aws_iam_role.rules.permissions_boundary == "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary" && aws_iam_role.rules.path == "/mfc-demo/"
    error_message = "the rules role must carry the boundary and the /mfc-demo/ path"
  }

  assert {
    condition     = jsondecode(aws_iam_role.rules.assume_role_policy).Statement[0].Principal.Service == "iot.amazonaws.com" && jsondecode(aws_iam_role.rules.assume_role_policy).Statement[0].Condition.StringEquals["aws:SourceAccount"] == "123456789012" && jsondecode(aws_iam_role.rules.assume_role_policy).Statement[0].Condition.ArnLike["aws:SourceArn"] == "arn:aws:iot:eu-west-3:123456789012:*"
    error_message = "the rules role must be trusted by IoT, for this account and region only"
  }
}

run "permissions_let_only_the_three_rules_invoke_the_ingest_function" {
  command = plan

  module {
    source = "../../modules/iot-rules"
  }

  assert {
    condition     = length(aws_lambda_permission.rule) == 3 && output.lambda_permission_function_names == tolist(["mfc-demo-ingest-events", "mfc-demo-ingest-events", "mfc-demo-ingest-events"])
    error_message = "exactly three permissions must exist, all on the ingest-events function"
  }

  assert {
    condition     = alltrue([for p in values(aws_lambda_permission.rule) : p.principal == "iot.amazonaws.com" && p.action == "lambda:InvokeFunction" && p.source_account == "123456789012"])
    error_message = "every permission must let IoT invoke the function, for this account"
  }

  assert {
    condition     = aws_lambda_permission.rule["events"].source_arn == "arn:aws:iot:eu-west-3:123456789012:rule/mfc_demo_events" && aws_lambda_permission.rule["acks"].source_arn == "arn:aws:iot:eu-west-3:123456789012:rule/mfc_demo_acks" && aws_lambda_permission.rule["presence"].source_arn == "arn:aws:iot:eu-west-3:123456789012:rule/mfc_demo_presence"
    error_message = "each permission must be bound to the ARN of its own rule"
  }
}

run "every_rule_has_a_parse_error_alarm_on_the_alarm_topic" {
  command = plan

  module {
    source = "../../modules/iot-rules"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.parse_error) == 4 && alltrue([for key, rule in { telemetry = "mfc_demo_telemetry", events = "mfc_demo_events", acks = "mfc_demo_acks", presence = "mfc_demo_presence" } : aws_cloudwatch_metric_alarm.parse_error[key].alarm_name == "mfc-demo-iot-${key}-parse-error" && aws_cloudwatch_metric_alarm.parse_error[key].dimensions == tomap({ RuleName = rule })])
    error_message = "each rule must have one ParseError alarm named mfc-demo-iot-<rule>-parse-error, dimensioned on the rule name only"
  }

  assert {
    condition     = alltrue([for a in values(aws_cloudwatch_metric_alarm.parse_error) : a.namespace == "AWS/IoT" && a.metric_name == "ParseError" && a.threshold == 0 && a.comparison_operator == "GreaterThanThreshold" && a.evaluation_periods == 1 && a.treat_missing_data == "notBreaching"])
    error_message = "every ParseError alarm must breach on any parse error in AWS/IoT and not on missing data"
  }

  assert {
    condition     = alltrue([for a in values(aws_cloudwatch_metric_alarm.parse_error) : a.alarm_actions == toset(["arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"]) && a.ok_actions == toset(["arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"])])
    error_message = "every ParseError alarm must notify the alarm topic on alarm and on recovery"
  }

  assert {
    condition     = length(output.parse_error_alarm_names) == 4 && length(output.parse_error_alarm_actions) == 4 && alltrue([for arn in output.parse_error_alarm_actions : arn == "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"])
    error_message = "the module outputs must echo four ParseError alarms, all on the alarm topic"
  }
}
