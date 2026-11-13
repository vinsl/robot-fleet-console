# Executable checks of the alerts function as wired in the demo root (M8, SPEC section 4.3 and section 8):
# the function is synchronous with no retry and no dead-letter queue, its policy names only the alert
# partitions of the events table, the alert marker of the fleet table, the open-alerts index and the
# connections it fans out to, it grants no scan, no batch write and no wildcard resource, and its
# environment is the reviewed contract of the alerts routes. The three routes are JWT-protected and call
# the alerts function. A root run reaches the child modules through their outputs only, so the statements
# are read back from the business policy that the lambda-function module echoes. The overrides are the ones
# of site.tftest.hcl.

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

run "alerts_function_is_synchronous_with_no_retry_and_no_dead_letter_queue" {
  command = plan

  assert {
    condition     = module.alerts_function.maximum_retry_attempts == 0
    error_message = "the alerts function must never retry: a retry would repeat a transition or an audit record"
  }

  assert {
    condition     = module.alerts_function.dead_letter_target_arn == null
    error_message = "the synchronous alerts function must not configure a dead-letter queue"
  }

  assert {
    condition     = module.alerts_function.timeout == 5 && module.alerts_function.function_name == "mfc-demo-alerts"
    error_message = "the alerts function must be named mfc-demo-alerts and keep the 5-second timeout of the HTTP API"
  }

  assert {
    condition     = module.alerts_function.maximum_event_age_in_seconds == 60
    error_message = "the alerts function must keep the event age of the synchronous functions"
  }
}

run "alerts_function_runs_under_the_workload_boundary_and_path" {
  command = plan

  assert {
    condition     = module.alerts_function.permissions_boundary == "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary" && module.alerts_function.role_path == "/mfc-demo/"
    error_message = "the alerts function role must carry the workload boundary and the /mfc-demo/ path"
  }
}

run "alerts_policy_grants_exactly_the_adapter_actions" {
  command = plan

  assert {
    condition     = toset(flatten([for s in jsondecode(module.alerts_function.business_policy).Statement : s.Action])) == toset(["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:DeleteItem", "dynamodb:TransactWriteItems", "execute-api:ManageConnections"])
    error_message = "the alerts policy must grant exactly the actions of the alert adapters and the fan-out"
  }

  assert {
    condition     = alltrue([for s in jsondecode(module.alerts_function.business_policy).Statement : !contains(s.Action, "dynamodb:Scan") && !contains(s.Action, "dynamodb:BatchWriteItem") && !contains(s.Action, "*")])
    error_message = "the alerts policy must never scan, batch-write or use a wildcard action"
  }
}

run "alerts_policy_has_no_wildcard_resource" {
  command = plan

  assert {
    condition     = alltrue([for s in jsondecode(module.alerts_function.business_policy).Statement : !contains(s.Resource, "*")])
    error_message = "the alerts policy must name its resources; no statement may use the * resource"
  }
}

run "alerts_queries_run_only_on_the_open_alerts_and_bysite_indexes" {
  command = plan

  assert {
    condition     = join(",", [for s in jsondecode(module.alerts_function.business_policy).Statement : s if s.Sid == "AlertStatusIndexRead"][0].Resource) == "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-events/index/openAlerts"
    error_message = "the alert list must query the openAlerts index of the events table and nothing else"
  }

  assert {
    condition     = join(",", [for s in jsondecode(module.alerts_function.business_policy).Statement : s if s.Sid == "SubscribedConnectionsRead"][0].Resource) == "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-connections/index/bySite"
    error_message = "the fan-out must query the bySite index of the connections table and nothing else"
  }

  assert {
    condition     = alltrue([for s in jsondecode(module.alerts_function.business_policy).Statement : !contains(s.Action, "dynamodb:Query") || alltrue([for r in s.Resource : contains(["arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-events/index/openAlerts", "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-connections/index/bySite"], r)])])
    error_message = "a Query may only target the openAlerts index or the bySite index"
  }
}

run "alerts_table_access_is_limited_to_the_site_partitions_and_the_marker" {
  command = plan

  assert {
    condition     = join(",", [for s in jsondecode(module.alerts_function.business_policy).Statement : s if s.Sid == "AlertReadAndUpdate"][0].Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"]) == "SITE#*" && join(",", [for s in jsondecode(module.alerts_function.business_policy).Statement : s if s.Sid == "AlertReadAndUpdate"][0].Resource) == "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-events"
    error_message = "the alert read and update must reach the events table for the SITE# partitions only"
  }

  assert {
    condition     = join(",", [for s in jsondecode(module.alerts_function.business_policy).Statement : s if s.Sid == "AlertMarkerDelete"][0].Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"]) == "SITE#*" && join(",", [for s in jsondecode(module.alerts_function.business_policy).Statement : s if s.Sid == "AlertMarkerDelete"][0].Resource) == "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-fleet"
    error_message = "the marker delete must reach the fleet table for the SITE# partitions only"
  }

  assert {
    condition     = join(",", [for s in jsondecode(module.alerts_function.business_policy).Statement : s if s.Sid == "AuditAppend"][0].Resource) == "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-events" && join(",", [for s in jsondecode(module.alerts_function.business_policy).Statement : s if s.Sid == "AuditAppend"][0].Action) == "dynamodb:PutItem"
    error_message = "the audit append must be a put on the events table only"
  }

  assert {
    condition     = join(",", [for s in jsondecode(module.alerts_function.business_policy).Statement : s if s.Sid == "AlertTransaction"][0].Resource) == "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-events,arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-fleet"
    error_message = "the transition transaction may name the events and fleet tables only"
  }
}

run "alerts_stale_connections_are_removed_only_by_connection_key" {
  command = plan

  assert {
    condition     = join(",", [for s in jsondecode(module.alerts_function.business_policy).Statement : s if s.Sid == "StaleConnectionRemove"][0].Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"]) == "CONN#*" && join(",", [for s in jsondecode(module.alerts_function.business_policy).Statement : s if s.Sid == "StaleConnectionRemove"][0].Resource) == "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-connections"
    error_message = "a stale connection may be removed by its CONN# key only, never a token or another item"
  }
}

run "alerts_environment_is_the_reviewed_contract" {
  command = plan

  assert {
    condition     = module.alerts_function.environment["FLEET_TABLE_NAME"] == "mfc-demo-fleet" && module.alerts_function.environment["EVENTS_TABLE_NAME"] == "mfc-demo-events" && module.alerts_function.environment["CONNECTIONS_TABLE_NAME"] == "mfc-demo-connections"
    error_message = "the alerts function must address the fleet, events and connections tables by name"
  }

  assert {
    condition     = module.alerts_function.environment["WS_MANAGEMENT_ENDPOINT"] == "https://a1b2c3d4e5.execute-api.eu-west-3.amazonaws.com/live"
    error_message = "the alerts function must push to the management endpoint of the WebSocket stage"
  }

  assert {
    condition     = module.alerts_function.environment["POWERTOOLS_SERVICE_NAME"] == "alerts" && module.alerts_function.environment["POWERTOOLS_TRACER_CAPTURE_RESPONSE"] == "false"
    error_message = "the alerts function must name its service alerts and not capture its responses in traces"
  }
}

# The root cannot read the resources of a child module, so the routes of api.tf are checked on the
# http-api module with the same three route declarations. The stage throttles are a dynamic block that
# the mocked plan cannot read (see http_api.tftest.hcl); they are reviewed in the deploy plan output.
run "alert_routes_are_jwt_protected_and_invoke_the_alerts_function" {
  command = plan

  variables {
    name_prefix         = "mfc-demo"
    console_origin      = "https://d111111abcdef8.cloudfront.net"
    user_pool_endpoint  = "https://cognito-idp.eu-west-3.amazonaws.com/eu-west-3_AbCdEf123"
    user_pool_client_id = "1a2b3c4d5e6f7g8h9i0jk1l2m3"
    alarm_topic_arn     = "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"
    routes = {
      alerts_list = {
        method         = "GET"
        path           = "/sites/{siteId}/alerts"
        function_arn   = "arn:aws:lambda:eu-west-3:123456789012:function:mfc-demo-alerts"
        function_name  = "mfc-demo-alerts"
        authorized     = true
        throttle_rate  = 10
        throttle_burst = 20
      }
      alert_acknowledge = {
        method         = "POST"
        path           = "/sites/{siteId}/alerts/{alertId}/acknowledge"
        function_arn   = "arn:aws:lambda:eu-west-3:123456789012:function:mfc-demo-alerts"
        function_name  = "mfc-demo-alerts"
        authorized     = true
        throttle_rate  = 5
        throttle_burst = 10
      }
      alert_resolve = {
        method         = "POST"
        path           = "/sites/{siteId}/alerts/{alertId}/resolve"
        function_arn   = "arn:aws:lambda:eu-west-3:123456789012:function:mfc-demo-alerts"
        function_name  = "mfc-demo-alerts"
        authorized     = true
        throttle_rate  = 5
        throttle_burst = 10
      }
    }
  }

  module {
    source = "../../modules/http-api"
  }

  assert {
    condition     = aws_apigatewayv2_route.this["alerts_list"].route_key == "GET /sites/{siteId}/alerts" && aws_apigatewayv2_route.this["alert_acknowledge"].route_key == "POST /sites/{siteId}/alerts/{alertId}/acknowledge" && aws_apigatewayv2_route.this["alert_resolve"].route_key == "POST /sites/{siteId}/alerts/{alertId}/resolve"
    error_message = "the alert routes must be the site-scoped list, acknowledge and resolve routes"
  }

  assert {
    condition     = alltrue([for k in ["alerts_list", "alert_acknowledge", "alert_resolve"] : aws_apigatewayv2_route.this[k].authorization_type == "JWT"])
    error_message = "every alert route must use the JWT authorizer"
  }

  assert {
    condition     = alltrue([for k in ["alerts_list", "alert_acknowledge", "alert_resolve"] : aws_lambda_permission.route[k].function_name == "mfc-demo-alerts"])
    error_message = "every alert route must invoke the alerts function"
  }
}
