# Executable checks of the M9 control plane as wired in the demo root (ADR 0062 to ADR 0064): the control and
# audit functions are synchronous with no retry and no dead-letter queue, each role grants only what its
# adapters need (resource scoped, no wildcard action), iot:Publish reaches the cmd topics only, the ws-message
# function gains the lock and the heartbeat publish, every M9 route is JWT-protected with its integration
# timeout, and a failed heartbeat publish alarms the operator. The route contract is read from the http-api
# module output, so these checks run on the routes of api.tf itself. The overrides are the ones of
# alerts.tftest.hcl.

mock_provider "aws" {
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "123456789012" }
  }
  override_data {
    target = data.aws_ssm_parameter.alarm_email
    values = { value = "ops@example.com" }
  }
  override_data {
    target = data.aws_iot_endpoint.data
    values = { endpoint_address = "a1b2c3d4e5f6g7-ats.iot.eu-west-3.amazonaws.com" }
  }
  override_data {
    target = data.aws_iot_endpoint.credentials
    values = { endpoint_address = "a1b2c3d4e5f6g7.credentials.iot.eu-west-3.amazonaws.com" }
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
  # site_maps.tftest.hcl asserts its real content.
  override_data {
    target = module.site_maps.data.aws_iam_policy_document.tls
    values = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

mock_provider "archive" {}

override_resource {
  target = aws_budgets_budget.this
  values = { arn = "arn:aws:budgets::123456789012:budget/mock" }
}

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

override_resource {
  target          = module.data_tables.aws_dynamodb_table.fleet
  override_during = plan
  values          = { arn = "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-fleet" }
}

override_resource {
  target          = module.data_tables.aws_dynamodb_table.events
  override_during = plan
  values          = { arn = "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-events" }
}

override_resource {
  target          = module.data_tables.aws_dynamodb_table.connections
  override_during = plan
  values          = { arn = "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-connections" }
}

override_resource {
  target          = module.queues.aws_sqs_queue.ingest_events_dlq
  override_during = plan
  values          = { arn = "arn:aws:sqs:eu-west-3:123456789012:mfc-demo-ingest-events-dlq" }
}

override_resource {
  target          = module.queues.aws_sqs_queue.telemetry
  override_during = plan
  values          = { arn = "arn:aws:sqs:eu-west-3:123456789012:mfc-demo-telemetry" }
}

override_resource {
  target          = module.queues.aws_sqs_queue.telemetry_dlq
  override_during = plan
  values          = { arn = "arn:aws:sqs:eu-west-3:123456789012:mfc-demo-telemetry-dlq" }
}

override_resource {
  target          = module.queues.aws_sqs_queue.rule_errors
  override_during = plan
  values          = { arn = "arn:aws:sqs:eu-west-3:123456789012:mfc-demo-iot-rule-errors" }
}

override_resource {
  target          = module.websocket_api.aws_apigatewayv2_api.this
  override_during = plan
  values = {
    id            = "a1b2c3d4e5"
    execution_arn = "arn:aws:execute-api:eu-west-3:123456789012:a1b2c3d4e5"
    api_endpoint  = "wss://a1b2c3d4e5.execute-api.eu-west-3.amazonaws.com"
  }
}

# The bucket ARN is part of the site policy, which the root plans evaluate: fixed for the plan.
override_resource {
  target          = module.site_maps.aws_s3_bucket.this
  override_during = plan
  values = {
    id     = "mfc-demo-site-maps-vinsl"
    arn    = "arn:aws:s3:::mfc-demo-site-maps-vinsl"
    bucket = "mfc-demo-site-maps-vinsl"
  }
}



run "control_policy_has_no_wildcard_action" {
  command = plan

  assert {
    condition     = alltrue([for s in jsondecode(module.control_function.business_policy).Statement : alltrue([for a in s.Action : !endswith(a, "*") && !contains(["dynamodb:Scan", "dynamodb:BatchWriteItem", "dynamodb:BatchGetItem", "lambda:InvokeFunction"], a)]) && !contains(s.Resource, "*")])
    error_message = "the control policy must name its actions and resources: no wildcard, no scan, no batch and no lambda action"
  }

  assert {
    condition     = toset(flatten([for s in jsondecode(module.control_function.business_policy).Statement : s.Action])) == toset(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "iot:Publish", "execute-api:ManageConnections"])
    error_message = "the control policy must grant exactly the actions of the control adapters and the fan-out"
  }

  assert {
    condition     = join(",", [for s in jsondecode(module.control_function.business_policy).Statement : s if s.Sid == "FleetStateAndRegistry"][0].Resource) == "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-fleet" && [for s in jsondecode(module.control_function.business_policy).Statement : s if s.Sid == "FleetStateAndRegistry"][0].Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"][0] == "SITE#*"
    error_message = "the fleet table access of the control function must reach the SITE# partitions of the fleet table only"
  }

  assert {
    condition     = join(",", [for s in jsondecode(module.control_function.business_policy).Statement : s if s.Sid == "AuditAppend"][0].Action) == "dynamodb:PutItem" && join(",", [for s in jsondecode(module.control_function.business_policy).Statement : s if s.Sid == "AuditAppend"][0].Resource) == "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-events"
    error_message = "the control function may only put audit records on the events table"
  }

  assert {
    condition     = join(",", [for s in jsondecode(module.control_function.business_policy).Statement : s if s.Sid == "SubscribedConnectionsRead"][0].Resource) == "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-connections/index/bySite" && join(",", [for s in jsondecode(module.control_function.business_policy).Statement : s if s.Sid == "StaleConnectionRemove"][0].Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"]) == "CONN#*"
    error_message = "the control fan-out may query the bySite index and remove a stale connection by its CONN# key only"
  }
}

run "control_publish_only_on_cmd_topics" {
  command = plan

  # iot:Publish is granted to the control function and to ws-message, on the cmd topics of every robot and no other topic.
  assert {
    condition     = alltrue([for p in [module.control_function.business_policy, module.ws_message_function.business_policy] : alltrue([for s in jsondecode(p).Statement : alltrue([for a in s.Action : a != "iot:Publish" || alltrue([for r in s.Resource : r == "arn:aws:iot:eu-west-3:123456789012:topic/fleet/*/*/cmd"])])])])
    error_message = "iot:Publish must be granted on topic/fleet/*/*/cmd only, for the control and ws-message functions"
  }

  # No other IoT action: a role that can connect or subscribe could receive the telemetry of every robot.
  assert {
    condition     = alltrue([for p in [module.control_function.business_policy, module.ws_message_function.business_policy] : alltrue([for s in jsondecode(p).Statement : alltrue([for a in s.Action : !startswith(a, "iot:") || a == "iot:Publish"])])])
    error_message = "the control and ws-message functions may publish to IoT and hold no other iot action (no connect, no subscribe)"
  }
}

run "audit_function_is_read_only" {
  command = plan

  assert {
    condition     = toset(flatten([for s in jsondecode(module.audit_function.business_policy).Statement : s.Action])) == toset(["dynamodb:Query"])
    error_message = "the audit function must hold dynamodb:Query and nothing else: no put, no update, no delete"
  }

  assert {
    condition     = join(",", flatten([for s in jsondecode(module.audit_function.business_policy).Statement : s.Resource])) == "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-events/index/openAlerts"
    error_message = "the audit function may query the openAlerts index of the events table only"
  }

  assert {
    condition     = [for s in jsondecode(module.audit_function.business_policy).Statement : s.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"][0]][0] == "SITE#*"
    error_message = "the audit query must stay in the SITE# partitions, which include SITE#<siteId>#AUDIT"
  }
}

run "ws_message_gains_publish_and_lock_actions_only" {
  command = plan

  # The existing statements (connection records and the fleet snapshot) stay; the lock read, the lock refresh
  # and the heartbeat publish are added (design D10, section 8.2).
  assert {
    condition     = toset(flatten([for s in jsondecode(module.ws_message_function.business_policy).Statement : s.Action])) == toset(["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "iot:Publish"])
    error_message = "ws-message may add the lock read and refresh and the heartbeat publish to its existing actions, and nothing else"
  }

  assert {
    condition     = [for s in jsondecode(module.ws_message_function.business_policy).Statement : s if s.Sid == "LockReadAndRefresh"][0].Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"][0] == "SITE#*" && join(",", [for s in jsondecode(module.ws_message_function.business_policy).Statement : s if s.Sid == "LockReadAndRefresh"][0].Resource) == "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-fleet"
    error_message = "the lock read and refresh must reach the SITE# partitions of the fleet table only"
  }

  assert {
    condition     = module.ws_message_function.environment["IOT_DATA_ENDPOINT"] == "a1b2c3d4e5f6g7-ats.iot.eu-west-3.amazonaws.com"
    error_message = "ws-message must publish through the IoT data-plane endpoint of the account"
  }
}

run "heartbeat_publish_failure_alarm_reaches_alarm_topic" {
  command = plan

  assert {
    condition     = aws_cloudwatch_metric_alarm.heartbeat_publish_failed.metric_name == "HeartbeatPublishFailed" && aws_cloudwatch_metric_alarm.heartbeat_publish_failed.namespace == "mfc-demo" && aws_cloudwatch_metric_alarm.heartbeat_publish_failed.threshold == 0
    error_message = "a failed heartbeat publish must raise HeartbeatPublishFailed above zero in the mfc-demo namespace"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.heartbeat_publish_failed.alarm_name == "mfc-demo-ws-message-heartbeat-publish-failed"
    error_message = "the heartbeat alarm must carry the stack prefix"
  }

  assert {
    condition     = tolist(aws_cloudwatch_metric_alarm.heartbeat_publish_failed.alarm_actions) == tolist(["arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"])
    error_message = "the heartbeat alarm must reach the alarm topic"
  }
}

run "all_new_functions_have_no_dlq_and_no_retry" {
  command = plan

  assert {
    condition     = alltrue([for f in [module.control_function, module.audit_function] : f.maximum_retry_attempts == 0 && f.maximum_event_age_in_seconds == 60 && f.dead_letter_target_arn == null])
    error_message = "the synchronous M9 functions must never retry and must not configure a dead-letter queue"
  }

  assert {
    condition     = alltrue([for f in [module.control_function, module.audit_function] : f.permissions_boundary == "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary" && f.role_path == "/mfc-demo/"])
    error_message = "the M9 function roles must carry the workload boundary and the /mfc-demo/ path"
  }

  assert {
    condition     = module.control_function.function_name == "mfc-demo-control" && module.audit_function.function_name == "mfc-demo-audit"
    error_message = "the M9 functions must keep their names under the stack prefix"
  }
}

run "control_and_audit_functions_keep_the_five_second_timeout" {
  command = plan

  # Both functions are behind the HTTP API, whose default integration timeout is 5 seconds (api.tf).
  assert {
    condition     = module.control_function.timeout == 5 && module.audit_function.timeout == 5
    error_message = "the control and audit functions must keep the 5-second timeout of the HTTP API"
  }
}

run "control_environment_names_the_iot_data_endpoint" {
  command = plan

  # The control function publishes commands through the IoT data-plane endpoint of the account (ADR 0062).
  assert {
    condition     = module.control_function.environment["IOT_DATA_ENDPOINT"] == "a1b2c3d4e5f6g7-ats.iot.eu-west-3.amazonaws.com"
    error_message = "the control function must publish through the IoT data-plane endpoint of the account"
  }
}

run "robots_function_still_has_no_route" {
  command = plan

  # The robots function is reached through the IAM-only robots front and never through an API route (ADR 0029).
  assert {
    condition     = alltrue([for r in values(module.http_api.route_contract) : r.function_name != "mfc-demo-robots"])
    error_message = "no HTTP route may invoke the robots function: the robots front is the only path to it"
  }
}

run "new_routes_are_jwt_protected" {
  command = plan

  assert {
    condition     = alltrue([for k, r in module.http_api.route_contract : k == "health" || r.authorization_type == "JWT"])
    error_message = "every route but the public health probe must use the JWT authorizer"
  }

  assert {
    condition = alltrue([
      module.http_api.route_contract["robots_list"].route_key == "GET /sites/{siteId}/robots",
      module.http_api.route_contract["robot_lock_get"].route_key == "GET /sites/{siteId}/robots/{robotId}/lock",
      module.http_api.route_contract["robot_lock_acquire"].route_key == "POST /sites/{siteId}/robots/{robotId}/lock",
      module.http_api.route_contract["robot_lock_release"].route_key == "POST /sites/{siteId}/robots/{robotId}/lock/release",
      module.http_api.route_contract["robot_command"].route_key == "POST /sites/{siteId}/robots/{robotId}/commands",
      module.http_api.route_contract["demo_get"].route_key == "GET /sites/{siteId}/demo",
      module.http_api.route_contract["demo_set"].route_key == "PUT /sites/{siteId}/demo",
      module.http_api.route_contract["audit_list"].route_key == "GET /sites/{siteId}/audit",
    ])
    error_message = "the M9 routes must have the site-scoped paths and methods of design section 6"
  }

  assert {
    condition     = module.http_api.route_contract["robot_command"].function_name == "mfc-demo-control" && module.http_api.route_contract["audit_list"].function_name == "mfc-demo-audit"
    error_message = "each M9 route must call its own function"
  }
}

run "other_routes_keep_5s_timeout" {
  command = plan

  assert {
    condition     = alltrue([for r in values(module.http_api.route_contract) : r.timeout_milliseconds == 5000])
    error_message = "every route keeps the 5-second integration timeout of the synchronous functions"
  }
}

run "route_timeout_above_30_seconds_is_refused" {
  command = plan

  module {
    source = "../../modules/http-api"
  }

  variables {
    name_prefix         = "mfc-demo"
    console_origin      = "https://d111111abcdef8.cloudfront.net"
    user_pool_endpoint  = "https://cognito-idp.eu-west-3.amazonaws.com/eu-west-3_AbCdEf123"
    user_pool_client_id = "1a2b3c4d5e6f7g8h9i0jk1l2m3"
    alarm_topic_arn     = "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"
    routes = {
      too_slow = {
        method               = "GET"
        path                 = "/slow"
        function_arn         = "arn:aws:lambda:eu-west-3:123456789012:function:mfc-demo-slow"
        function_name        = "mfc-demo-slow"
        authorized           = true
        timeout_milliseconds = 30001
      }
    }
  }

  expect_failures = [var.routes]
}
