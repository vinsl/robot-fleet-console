# Root-level checks of the four WebSocket functions: the exact IAM policy of each, the inline grant
# that lets ws-message push to connections, the wildcard and lambda-action denial, the synchronous
# contract, the boundary and path, the environment and the timeouts, and the outputs. Each policy is
# compared as a whole document, so any extra or missing statement, action or resource fails. The
# telemetry and event ingest checks are in ingest.tftest.hcl. Mocked provider: no AWS call.

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

# The table ARNs are part of the robots policy, and the queue ARNs of the ingest-events policy and of
# its dead-letter target: fixed for the plan so that the policy documents are known.
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
  target          = module.data_tables.aws_dynamodb_table.connections
  override_during = plan
  values          = { arn = "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-connections" }
}

# The console origin is built from the CloudFront domain name, which the mock cannot know. The value is
# the one of web.tftest.hcl, so the allow-list check below is deterministic.
override_resource {
  target          = module.web.aws_cloudfront_distribution.this
  override_during = plan
  values = {
    id          = "E1ABCDEF2GHIJK"
    arn         = "arn:aws:cloudfront::123456789012:distribution/E1ABCDEF2GHIJK"
    domain_name = "d111111abcdef8.cloudfront.net"
  }
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


run "ws_token_policy_is_exactly_the_token_store_write" {
  command = plan

  assert {
    condition     = jsondecode(module.ws_token_function.business_policy) == { Version = "2012-10-17", Statement = [{ Sid = "TokenStore", Effect = "Allow", Action = ["dynamodb:PutItem"], Resource = ["arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-connections"], Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["WSTOKEN#*"] } } }] }
    error_message = "ws-token may only put items into the connections table"
  }
}

run "ws_connect_policy_is_exactly_the_redeem_and_record" {
  command = plan

  assert {
    condition     = jsondecode(module.ws_connect_function.business_policy) == { Version = "2012-10-17", Statement = [{ Sid = "TokenRedeem", Effect = "Allow", Action = ["dynamodb:DeleteItem"], Resource = ["arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-connections"], Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["WSTOKEN#*"] } } }, { Sid = "ConnectionRecordWrite", Effect = "Allow", Action = ["dynamodb:PutItem"], Resource = ["arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-connections"], Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["CONN#*"] } } }] }
    error_message = "ws-connect may only delete tokens and put connection records, each under its own key prefix"
  }
}

run "ws_disconnect_policy_is_exactly_the_record_removal" {
  command = plan

  assert {
    condition     = jsondecode(module.ws_disconnect_function.business_policy) == { Version = "2012-10-17", Statement = [{ Sid = "ConnectionRecordRemove", Effect = "Allow", Action = ["dynamodb:DeleteItem"], Resource = ["arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-connections"], Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["CONN#*"] } } }] }
    error_message = "ws-disconnect may only delete items of the connections table"
  }
}

run "ws_message_policy_is_exactly_the_reviewed_statements" {
  command = plan

  assert {
    condition = jsondecode(module.ws_message_function.business_policy) == { Version = "2012-10-17", Statement = [
      { Sid = "ConnectionRecordReadAndSubscribe", Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"], Resource = ["arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-connections"], Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["CONN#*"] } } },
      { Sid = "FleetSnapshot", Effect = "Allow", Action = ["dynamodb:Query"], Resource = ["arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-fleet"] },
      { Sid = "LockReadAndRefresh", Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:UpdateItem"], Resource = ["arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-fleet"], Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["SITE#*"] } } },
      { Sid = "HeartbeatPublish", Effect = "Allow", Action = ["iot:Publish"], Resource = ["arn:aws:iot:eu-west-3:123456789012:topic/fleet/*/*/cmd"] },
    ] }
    error_message = "ws-message may read and subscribe connection records, query the fleet table, read and refresh the lock of a site and publish heartbeats to the cmd topics, and nothing else"
  }
}

run "ws_message_manages_connections_only_through_its_own_inline_policy" {
  command = plan

  assert {
    condition     = jsondecode(aws_iam_role_policy.ws_message_connections.policy) == { Version = "2012-10-17", Statement = [{ Sid = "ConnectionsPushAndClose", Effect = "Allow", Action = ["execute-api:ManageConnections"], Resource = ["arn:aws:execute-api:eu-west-3:123456789012:a1b2c3d4e5/live/POST/@connections/*", "arn:aws:execute-api:eu-west-3:123456789012:a1b2c3d4e5/live/DELETE/@connections/*"] }] }
    error_message = "ws-message may post to and delete connections of its stage only"
  }

  assert {
    condition     = aws_iam_role_policy.ws_message_connections.role == module.ws_message_function.role_name
    error_message = "the connections grant must be attached to the role of ws-message"
  }
}



run "no_realtime_policy_grants_a_wildcard_or_a_lambda_action" {
  command = plan

  assert {
    condition = alltrue([for p in [
      module.ws_token_function.business_policy,
      module.ws_connect_function.business_policy,
      module.ws_disconnect_function.business_policy,
      module.ws_message_function.business_policy,
      aws_iam_role_policy.ws_message_connections.policy,
      module.ingest_telemetry_function.business_policy,
      module.ingest_events_function.business_policy,
    ] : alltrue([for s in jsondecode(p).Statement : !contains(s.Resource, "*") && alltrue([for a in s.Action : !endswith(a, "*") && !startswith(lower(a), "lambda:")])])])
    error_message = "no realtime policy may grant a wildcard action, a wildcard resource or any lambda action"
  }
}

run "ws_and_ingest_functions_are_synchronous_or_mapped_with_no_dead_letter_queue" {
  command = plan

  assert {
    condition     = alltrue([for f in [module.ws_token_function, module.ws_connect_function, module.ws_disconnect_function, module.ws_message_function, module.ingest_telemetry_function] : f.maximum_retry_attempts == 0 && f.maximum_event_age_in_seconds == 60 && f.dead_letter_target_arn == null])
    error_message = "the realtime functions must not retry and must not have a dead-letter queue (their redrive is the queue or the caller)"
  }
}

run "ws_functions_run_under_the_workload_boundary_and_path" {
  command = plan

  assert {
    condition     = alltrue([for f in [module.ws_token_function, module.ws_connect_function, module.ws_disconnect_function, module.ws_message_function, module.ingest_telemetry_function] : f.permissions_boundary == "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary" && f.role_path == "/mfc-demo/"])
    error_message = "every realtime role must carry the workload boundary and the /mfc-demo/ path"
  }
}

run "ws_functions_environment_is_the_reviewed_contract" {
  command = plan

  assert {
    condition     = module.ws_token_function.environment["WS_URL"] == "wss://a1b2c3d4e5.execute-api.eu-west-3.amazonaws.com/live" && module.ws_token_function.environment["CONNECTIONS_TABLE_NAME"] == "mfc-demo-connections"
    error_message = "ws-token must know the WSS URL and the connections table"
  }

  assert {
    condition     = contains(jsondecode(module.ws_connect_function.environment["WS_ALLOWED_ORIGINS"]), "https://d111111abcdef8.cloudfront.net") && contains(jsondecode(module.ws_connect_function.environment["WS_ALLOWED_ORIGINS"]), "http://localhost:5173") && length(jsondecode(module.ws_connect_function.environment["WS_ALLOWED_ORIGINS"])) == 2 && module.ws_connect_function.environment["CONNECTIONS_TABLE_NAME"] == "mfc-demo-connections"
    error_message = "ws-connect must receive the origin allow-list as a JSON array holding the console origin (from the web module) and the localhost dev origin, and nothing else by default"
  }

  assert {
    condition     = !contains(keys(module.ws_message_function.environment), "WS_MANAGEMENT_ENDPOINT") && module.ws_message_function.environment["FLEET_TABLE_NAME"] == "mfc-demo-fleet"
    error_message = "ws-message must not carry the management endpoint in its environment (it routes to the API that would depend on it)"
  }

  assert {
    condition     = module.ws_disconnect_function.environment["CONNECTIONS_TABLE_NAME"] == "mfc-demo-connections" && alltrue([for f in [module.ws_token_function, module.ws_connect_function, module.ws_disconnect_function, module.ws_message_function, module.ingest_telemetry_function] : f.environment["POWERTOOLS_TRACER_CAPTURE_RESPONSE"] == "false" && f.environment["POWERTOOLS_TRACER_CAPTURE_ERROR"] == "false"])
    error_message = "the realtime functions must not capture responses or errors in traces"
  }

  assert {
    condition     = module.ingest_telemetry_function.environment["WS_MANAGEMENT_ENDPOINT"] == "https://a1b2c3d4e5.execute-api.eu-west-3.amazonaws.com/live" && module.ingest_telemetry_function.environment["FLEET_TABLE_NAME"] == "mfc-demo-fleet" && module.ingest_telemetry_function.environment["CONNECTIONS_TABLE_NAME"] == "mfc-demo-connections"
    error_message = "ingest-telemetry must know the management endpoint, the fleet table and the connections table"
  }
}

run "realtime_timeouts_are_explicit_and_short" {
  command = plan

  assert {
    condition     = module.ws_token_function.timeout == 5 && module.ws_connect_function.timeout == 5 && module.ws_disconnect_function.timeout == 5 && module.ws_message_function.timeout == 5
    error_message = "every ws function must time out after 5 seconds (API Gateway caps $connect at 29 seconds)"
  }

  assert {
    condition     = module.ingest_telemetry_function.timeout == 10
    error_message = "ingest-telemetry must time out after 10 seconds"
  }
}


run "realtime_outputs_expose_the_endpoints" {
  command = plan

  assert {
    condition     = output.ws_url == "wss://a1b2c3d4e5.execute-api.eu-west-3.amazonaws.com/live" && output.ws_management_endpoint == "https://a1b2c3d4e5.execute-api.eu-west-3.amazonaws.com/live"
    error_message = "the outputs must expose the WSS URL and the management endpoint of the live stage"
  }
}
