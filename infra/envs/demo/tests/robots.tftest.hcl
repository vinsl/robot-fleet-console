# Executable checks of the robot stack as wired in the demo root (ADR 0029): the robots function has
# no resource policy and no event source, its policy has no wildcard action and no denied action, its
# only "*" resource is the certificate creation, the ingest-events function is invoked by the IoT rules
# only, and the outputs expose what the admin script and the smoke checks read. A root run reaches
# the child modules through their outputs only, so the checks read the reviewed contract that the
# lambda-function module echoes. The budget, trail and alarm-topic overrides are the ones of
# demo.tftest.hcl, which this file needs to plan. The ingest-events policy is pinned in ingest.tftest.hcl.

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

run "robots_policy_has_no_wildcard_and_no_denied_action" {
  command = plan

  assert {
    condition     = alltrue([for s in jsondecode(module.robots_function.business_policy).Statement : alltrue([for a in s.Action : !endswith(a, "*")])])
    error_message = "the robots policy must not grant any wildcard action"
  }

  assert {
    condition     = !strcontains(module.robots_function.business_policy, "iot:DeleteCertificate") && !strcontains(module.robots_function.business_policy, "iot:TransferCertificate") && !strcontains(module.robots_function.business_policy, "iot:UpdateThing") && !strcontains(module.robots_function.business_policy, "kinesisvideo:ConnectAs") && !strcontains(module.robots_function.business_policy, "iot:DescribeEndpoint")
    error_message = "the robots policy must never grant certificate deletion or transfer, thing updates, viewer access or endpoint description"
  }
}

run "only_certificate_creation_is_granted_on_every_resource" {
  command = plan

  assert {
    condition     = alltrue([for s in jsondecode(module.robots_function.business_policy).Statement : !contains(s.Resource, "*") || s.Action == ["iot:CreateKeysAndCertificate"]])
    error_message = "only iot:CreateKeysAndCertificate may be granted on the resource *"
  }
}

run "robot_thing_actions_are_exactly_create_and_list_principals" {
  command = plan

  assert {
    condition     = toset(one([for s in jsondecode(module.robots_function.business_policy).Statement : s if s.Sid == "RobotThings"]).Action) == toset(["iot:CreateThing", "iot:ListThingPrincipals"])
    error_message = "the robots function may create things and list their principals, and nothing else on things (iot:ListThingPrincipalsV2 is not used)"
  }
}

run "no_workload_policy_grants_invoke_on_the_robots_function" {
  command = plan

  # The robots function is invoked by the operator's own session only (ADR 0029, THREAT_MODEL R23). No
  # function role may hold a lambda action, so no role can invoke mfc-demo-robots or any mfc-demo-* function.
  assert {
    condition     = alltrue([for p in [module.robots_function.business_policy, module.ingest_events_function.business_policy] : alltrue([for s in jsondecode(p).Statement : alltrue([for a in s.Action : !startswith(lower(a), "lambda:")])])])
    error_message = "no workload role policy in envs/demo may grant a lambda action, in particular lambda:InvokeFunction on mfc-demo-robots or mfc-demo-*"
  }
}

run "thing_principal_statement_is_bound_to_demo_things" {
  command = plan

  assert {
    condition     = one([for s in jsondecode(module.robots_function.business_policy).Statement : s if s.Sid == "RobotCertificateThings"]).Condition.ArnLike["iot:thingArn"] == "arn:aws:iot:eu-west-3:123456789012:thing/mfc-demo-*"
    error_message = "attaching a certificate to a thing must be limited to demo things"
  }
}

run "robots_function_is_synchronous_with_no_retry_and_no_dead_letter_queue" {
  command = plan

  assert {
    condition     = module.robots_function.maximum_retry_attempts == 0
    error_message = "the robots function must never retry: a retry would repeat a registration"
  }

  assert {
    condition     = module.robots_function.dead_letter_target_arn == null
    error_message = "the synchronous robots function must not configure a dead-letter queue"
  }
}

run "only_iot_rules_invoke_the_ingest_function" {
  command = plan

  assert {
    condition     = length(module.iot_rules.lambda_permission_function_names) == 3 && alltrue([for n in module.iot_rules.lambda_permission_function_names : n == "mfc-demo-ingest-events"])
    error_message = "the only Lambda permissions of the stack must target mfc-demo-ingest-events, granted to the three function rules"
  }

  assert {
    condition     = alltrue([for n in module.iot_rules.lambda_permission_function_names : n != module.robots_function.function_name])
    error_message = "the robots function must not be the target of any invoke permission"
  }
}

run "robots_environment_is_the_reviewed_contract" {
  command = plan

  assert {
    condition     = module.robots_function.environment["POWERTOOLS_TRACER_CAPTURE_RESPONSE"] == "false" && module.robots_function.environment["POWERTOOLS_SERVICE_NAME"] == "robots"
    error_message = "the robots function must not capture its responses in traces and must name its service robots"
  }

  assert {
    condition     = module.robots_function.environment["IOT_DATA_ENDPOINT"] == "a1b2c3d4e5f6g7-ats.iot.eu-west-3.amazonaws.com" && module.robots_function.environment["IOT_CREDENTIALS_ENDPOINT"] == "a1b2c3d4e5f6g7.credentials.iot.eu-west-3.amazonaws.com"
    error_message = "the robots function must receive the account IoT endpoints from the data sources"
  }

  assert {
    condition     = jsondecode(module.robots_function.environment["RESOURCE_TAGS"]) == { project = "mfc", env = "demo", component = "foundation", owner = "vincent" }
    error_message = "RESOURCE_TAGS must carry the four cost-allocation tags of the provider"
  }

  assert {
    condition     = module.robots_function.environment["FLEET_TABLE_NAME"] == "mfc-demo-fleet" && module.robots_function.environment["EVENTS_TABLE_NAME"] == "mfc-demo-events"
    error_message = "the robots function must address the fleet and events tables by name"
  }
}

run "ingest_events_function_retries_twice_then_dead_letters" {
  command = plan

  assert {
    condition     = module.ingest_events_function.maximum_retry_attempts == 2 && module.ingest_events_function.maximum_event_age_in_seconds == 300
    error_message = "the ingest-events function must retry twice within five minutes"
  }

  assert {
    condition     = module.ingest_events_function.dead_letter_target_arn == module.queues.ingest_events_dlq_arn
    error_message = "the ingest-events function must send its failed events to its dead-letter queue"
  }
}

run "function_roles_carry_the_boundary_and_the_demo_path" {
  command = plan

  assert {
    condition     = alltrue([for f in [module.robots_function, module.ingest_events_function] : f.permissions_boundary == "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary" && f.role_path == "/mfc-demo/"])
    error_message = "every function role must carry the workload boundary and the /mfc-demo/ path"
  }
}

run "outputs_expose_what_the_scripts_read" {
  command = plan

  assert {
    condition     = output.fleet_table_name == "mfc-demo-fleet" && output.events_table_name == "mfc-demo-events" && output.robots_function_name == "mfc-demo-robots"
    error_message = "the outputs must name the tables and the robots function"
  }

  assert {
    condition     = output.iot_rule_names == tolist(["mfc_demo_telemetry", "mfc_demo_events", "mfc_demo_acks", "mfc_demo_presence"])
    error_message = "the outputs must list the four rules"
  }

  assert {
    condition     = output.iot_data_endpoint == "a1b2c3d4e5f6g7-ats.iot.eu-west-3.amazonaws.com" && output.iot_credentials_endpoint == "a1b2c3d4e5f6g7.credentials.iot.eu-west-3.amazonaws.com"
    error_message = "the outputs must expose the two account IoT endpoints"
  }
}

run "smoke_outputs_are_unchanged" {
  command = plan

  assert {
    condition     = output.alarm_topic_arn == "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms" && output.trail_name == "mfc-demo-trail"
    error_message = "the outputs that make smoke reads must keep their names and values"
  }
}
