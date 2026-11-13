# Root-level checks of the telemetry ingest and of the event ingest: the exact policy of each
# function, the event source mapping that reads the telemetry queue in batches, the environment of
# ingest-events, and the refusal of out-of-range variables. Each policy is compared as a whole
# document. Mocked provider: no credentials and no AWS call.

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

override_resource {
  target          = module.websocket_api.aws_apigatewayv2_api.this
  override_during = plan
  values = {
    id            = "a1b2c3d4e5"
    execution_arn = "arn:aws:execute-api:eu-west-3:123456789012:a1b2c3d4e5"
    api_endpoint  = "wss://a1b2c3d4e5.execute-api.eu-west-3.amazonaws.com"
  }
}

run "ingest_telemetry_policy_is_exactly_the_consumer_grant" {
  command = plan

  assert {
    condition = jsondecode(module.ingest_telemetry_function.business_policy) == { Version = "2012-10-17", Statement = [
      { Sid = "TelemetryQueueConsumer", Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ChangeMessageVisibility"], Resource = ["arn:aws:sqs:eu-west-3:123456789012:mfc-demo-telemetry"] },
      { Sid = "FleetStateObserve", Effect = "Allow", Action = ["dynamodb:UpdateItem"], Resource = ["arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-fleet"] },
      { Sid = "SubscribedConnectionsRead", Effect = "Allow", Action = ["dynamodb:Query"], Resource = ["arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-connections/index/bySite"] },
      { Sid = "StaleConnectionRemove", Effect = "Allow", Action = ["dynamodb:DeleteItem"], Resource = ["arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-connections"], Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["CONN#*"] } } },
      { Sid = "ConnectionsPushAndClose", Effect = "Allow", Action = ["execute-api:ManageConnections"], Resource = ["arn:aws:execute-api:eu-west-3:123456789012:a1b2c3d4e5/live/POST/@connections/*", "arn:aws:execute-api:eu-west-3:123456789012:a1b2c3d4e5/live/DELETE/@connections/*"] },
    ] }
    error_message = "ingest-telemetry may consume its queue, update the fleet state, query its subscribers, remove stale ones and push to the stage"
  }
}

run "ingest_events_policy_is_exactly_the_reviewed_grant" {
  command = plan

  assert {
    condition = jsondecode(module.ingest_events_function.business_policy) == { Version = "2012-10-17", Statement = [
      { Sid = "DeadLetterQueue", Effect = "Allow", Action = ["sqs:SendMessage"], Resource = ["arn:aws:sqs:eu-west-3:123456789012:mfc-demo-ingest-events-dlq"] },
      { Sid = "FleetStateAndAlertMarkers", Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:PutItem"], Resource = ["arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-fleet"] },
      { Sid = "EventHistoryAndAlerts", Effect = "Allow", Action = ["dynamodb:PutItem"], Resource = ["arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-events"] },
      { Sid = "SubscribedConnectionsRead", Effect = "Allow", Action = ["dynamodb:Query"], Resource = ["arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-connections/index/bySite"] },
      { Sid = "StaleConnectionRemove", Effect = "Allow", Action = ["dynamodb:DeleteItem"], Resource = ["arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-connections"], Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["CONN#*"] } } },
      { Sid = "ConnectionsPushAndClose", Effect = "Allow", Action = ["execute-api:ManageConnections"], Resource = ["arn:aws:execute-api:eu-west-3:123456789012:a1b2c3d4e5/live/POST/@connections/*", "arn:aws:execute-api:eu-west-3:123456789012:a1b2c3d4e5/live/DELETE/@connections/*"] },
    ] }
    error_message = "ingest-events must keep its dead-letter send and get the fleet, history, subscriber and push grants of M5, nothing more"
  }
}

run "ingest_telemetry_mapping_is_the_reviewed_consumer" {
  command = plan

  assert {
    condition     = aws_lambda_event_source_mapping.telemetry.event_source_arn == "arn:aws:sqs:eu-west-3:123456789012:mfc-demo-telemetry" && aws_lambda_event_source_mapping.telemetry.batch_size == 100
    error_message = "the mapping must read the telemetry queue, and not the dead-letter queue, in batches of 100"
  }

  assert {
    condition     = aws_lambda_event_source_mapping.telemetry.maximum_batching_window_in_seconds == 1 && aws_lambda_event_source_mapping.telemetry.enabled && toset(aws_lambda_event_source_mapping.telemetry.function_response_types) == toset(["ReportBatchItemFailures"])
    error_message = "the mapping must batch for 1 second, be enabled by default and report item failures"
  }

  assert {
    condition     = one(aws_lambda_event_source_mapping.telemetry.scaling_config).maximum_concurrency == 5
    error_message = "the mapping must run at most 5 concurrent invocations (THREAT_MODEL T27)"
  }

  # The 60 s visibility timeout of the telemetry queue is pinned by queues.tftest.hcl; this run checks
  # the rule that binds the two values (SQS requires at least six times the function timeout).
  assert {
    condition     = 60 >= 6 * module.ingest_telemetry_function.timeout
    error_message = "the telemetry queue visibility timeout (60 s) must be at least six times the function timeout"
  }
}

run "ingest_events_environment_is_the_reviewed_contract" {
  command = plan

  assert {
    condition     = module.ingest_events_function.environment["FLEET_TABLE_NAME"] == "mfc-demo-fleet" && module.ingest_events_function.environment["EVENTS_TABLE_NAME"] == "mfc-demo-events" && module.ingest_events_function.environment["CONNECTIONS_TABLE_NAME"] == "mfc-demo-connections" && module.ingest_events_function.environment["WS_MANAGEMENT_ENDPOINT"] == "https://a1b2c3d4e5.execute-api.eu-west-3.amazonaws.com/live"
    error_message = "ingest-events must know the fleet, events and connections tables and the management endpoint"
  }
}

run "telemetry_batch_window_above_five_seconds_is_refused" {
  command = plan

  variables {
    telemetry_batch_window_seconds = 6
  }

  expect_failures = [var.telemetry_batch_window_seconds]
}

run "wildcard_websocket_origin_is_refused" {
  command = plan

  variables {
    ws_allowed_origins = ["*"]
  }

  expect_failures = [var.ws_allowed_origins]
}
