# Executable checks of the alarms of the demo root (ADR 0023): every Lambda function of the stack gets an
# Errors and a Throttles alarm on the alarm topic under its own name, and the four IoT rules each get a
# ParseError alarm on the alarm topic. A root run reaches the child modules through their outputs only,
# so the alarms are read back from the outputs of the lambda-function and iot-rules modules. The overrides
# are the ones of alerts.tftest.hcl. The stack is planned with mocked providers: no credentials, no AWS call.

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

run "every_lambda_function_alarms_on_errors_and_throttles" {
  command = plan

  assert {
    condition = alltrue([
      module.health_function.alarm_names == tolist(["mfc-demo-health-errors", "mfc-demo-health-throttles"]),
      module.me_function.alarm_names == tolist(["mfc-demo-me-errors", "mfc-demo-me-throttles"]),
      module.http_ws_token_function.alarm_names == tolist(["mfc-demo-ws-token-http-errors", "mfc-demo-ws-token-http-throttles"]),
      module.site_function.alarm_names == tolist(["mfc-demo-site-errors", "mfc-demo-site-throttles"]),
      module.alerts_function.alarm_names == tolist(["mfc-demo-alerts-errors", "mfc-demo-alerts-throttles"]),
      module.robots_function.alarm_names == tolist(["mfc-demo-robots-errors", "mfc-demo-robots-throttles"]),
      module.ingest_events_function.alarm_names == tolist(["mfc-demo-ingest-events-errors", "mfc-demo-ingest-events-throttles"]),
      module.ingest_telemetry_function.alarm_names == tolist(["mfc-demo-ingest-telemetry-errors", "mfc-demo-ingest-telemetry-throttles"]),
      module.ws_token_function.alarm_names == tolist(["mfc-demo-ws-token-errors", "mfc-demo-ws-token-throttles"]),
      module.ws_connect_function.alarm_names == tolist(["mfc-demo-ws-connect-errors", "mfc-demo-ws-connect-throttles"]),
      module.ws_disconnect_function.alarm_names == tolist(["mfc-demo-ws-disconnect-errors", "mfc-demo-ws-disconnect-throttles"]),
      module.ws_message_function.alarm_names == tolist(["mfc-demo-ws-message-errors", "mfc-demo-ws-message-throttles"]),
    ])
    error_message = "every Lambda function must have an Errors and a Throttles alarm named after the function"
  }

  assert {
    condition = alltrue([
      module.health_function.alarm_actions == tolist(["arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms", "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"]),
      module.me_function.alarm_actions == tolist(["arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms", "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"]),
      module.http_ws_token_function.alarm_actions == tolist(["arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms", "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"]),
      module.site_function.alarm_actions == tolist(["arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms", "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"]),
      module.alerts_function.alarm_actions == tolist(["arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms", "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"]),
      module.robots_function.alarm_actions == tolist(["arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms", "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"]),
      module.ingest_events_function.alarm_actions == tolist(["arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms", "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"]),
      module.ingest_telemetry_function.alarm_actions == tolist(["arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms", "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"]),
      module.ws_token_function.alarm_actions == tolist(["arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms", "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"]),
      module.ws_connect_function.alarm_actions == tolist(["arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms", "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"]),
      module.ws_disconnect_function.alarm_actions == tolist(["arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms", "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"]),
      module.ws_message_function.alarm_actions == tolist(["arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms", "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"]),
    ])
    error_message = "the Errors and Throttles alarms of every Lambda function must notify the alarm topic"
  }
}

run "every_iot_rule_has_a_parse_error_alarm_on_the_alarm_topic" {
  command = plan

  assert {
    condition     = length(module.iot_rules.parse_error_alarm_names) == 4 && alltrue([for name in ["mfc-demo-iot-telemetry-parse-error", "mfc-demo-iot-events-parse-error", "mfc-demo-iot-acks-parse-error", "mfc-demo-iot-presence-parse-error"] : contains(module.iot_rules.parse_error_alarm_names, name)])
    error_message = "each of the four IoT rules must have a ParseError alarm named mfc-demo-iot-<rule>-parse-error"
  }

  assert {
    condition     = length(module.iot_rules.parse_error_alarm_actions) == 4 && alltrue([for arn in module.iot_rules.parse_error_alarm_actions : arn == "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"])
    error_message = "every ParseError alarm must notify the alarm topic"
  }
}
