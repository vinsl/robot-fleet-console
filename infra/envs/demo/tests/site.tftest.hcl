# Executable checks of the site function as wired in the demo root (M7, SPEC section 4.5 and section 8):
# the function is synchronous with no retry and no dead-letter queue, its policy names only the site
# partitions of the fleet table and the sites/ prefix of the site-maps bucket, it grants no delete, no
# wildcard resource and no action beyond the calls of its adapters, and its environment is the reviewed
# contract of the site configuration. A root run reaches the child modules through their outputs only, so
# the statements are read back from the business policy that the lambda-function module echoes. The
# overrides are the ones of robots.tftest.hcl, plus the site-maps bucket, whose ARN the policy names.

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

# The bucket ARN is part of the site policy: fixed for the plan so that the policy document is known.
override_resource {
  target          = module.site_maps.aws_s3_bucket.this
  override_during = plan
  values = {
    id     = "mfc-demo-site-maps-vinsl"
    arn    = "arn:aws:s3:::mfc-demo-site-maps-vinsl"
    bucket = "mfc-demo-site-maps-vinsl"
  }
}

run "site_function_is_synchronous_with_no_retry_and_no_dead_letter_queue" {
  command = plan

  assert {
    condition     = module.site_function.maximum_retry_attempts == 0
    error_message = "the site function must never retry: a retry would repeat an activation or an audit record"
  }

  assert {
    condition     = module.site_function.dead_letter_target_arn == null
    error_message = "the synchronous site function must not configure a dead-letter queue"
  }

  assert {
    condition     = module.site_function.timeout == 5 && module.site_function.function_name == "mfc-demo-site"
    error_message = "the site function must be named mfc-demo-site and keep the 5-second timeout of the HTTP API"
  }
}

run "site_function_runs_under_the_workload_boundary_and_path" {
  command = plan

  assert {
    condition     = module.site_function.permissions_boundary == "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary" && module.site_function.role_path == "/mfc-demo/"
    error_message = "the site function role must carry the workload boundary and the /mfc-demo/ path"
  }
}

run "site_policy_grants_no_delete_and_no_action_beyond_the_adapters" {
  command = plan

  assert {
    condition     = alltrue([for s in jsondecode(module.site_function.business_policy).Statement : alltrue([for a in s.Action : !startswith(a, "s3:Delete") && a != "dynamodb:DeleteItem" && a != "dynamodb:BatchWriteItem"])])
    error_message = "the site policy must never delete an object or an item: superseded versions expire through the lifecycle rule"
  }

  assert {
    condition     = toset(flatten([for s in jsondecode(module.site_function.business_policy).Statement : s.Action])) == toset(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem", "dynamodb:Query", "dynamodb:TransactWriteItems", "s3:PutObject", "s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket"])
    error_message = "the site policy must grant exactly the actions of the site adapters"
  }
}

run "site_policy_has_no_wildcard_resource" {
  command = plan

  assert {
    condition     = alltrue([for s in jsondecode(module.site_function.business_policy).Statement : !contains(s.Resource, "*")])
    error_message = "the site policy must name its resources; no statement may use the * resource"
  }
}

run "site_objects_are_limited_to_the_sites_prefix_of_the_site_maps_bucket" {
  command = plan

  assert {
    condition     = join(",", [for s in jsondecode(module.site_function.business_policy).Statement : s if s.Sid == "MapObjects"][0].Resource) == "arn:aws:s3:::mfc-demo-site-maps-vinsl/sites/*"
    error_message = "the object actions must be granted on the sites/ prefix of the site-maps bucket only"
  }

  assert {
    condition     = join(",", [for s in jsondecode(module.site_function.business_policy).Statement : s if s.Sid == "MapKeysExist"][0].Resource) == "arn:aws:s3:::mfc-demo-site-maps-vinsl" && join(",", [for s in jsondecode(module.site_function.business_policy).Statement : s if s.Sid == "MapKeysExist"][0].Condition.StringLikeIfExists["s3:prefix"]) == "sites/*"
    error_message = "the bucket listing must be limited to the sites/ prefix with StringLikeIfExists, so that the head of a missing key is a 404 (a HeadObject carries no prefix) and nothing else is listed"
  }
}

run "site_table_access_is_limited_to_the_site_partitions" {
  command = plan

  assert {
    condition     = join(",", [for s in jsondecode(module.site_function.business_policy).Statement : s if s.Sid == "SiteProfileAndMaps"][0].Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"]) == "SITE#*"
    error_message = "the fleet table must be reached for the SITE# partitions only (which also hold the robot registry items, R74)"
  }

  assert {
    condition     = join(",", [for s in jsondecode(module.site_function.business_policy).Statement : s if s.Sid == "SiteProfileAndMaps"][0].Resource) == "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-fleet"
    error_message = "the site profile statement must name the fleet table and nothing else"
  }

  assert {
    condition     = join(",", [for s in jsondecode(module.site_function.business_policy).Statement : s if s.Sid == "AuditAppend"][0].Resource) == "arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-events" && join(",", [for s in jsondecode(module.site_function.business_policy).Statement : s if s.Sid == "AuditAppend"][0].Action) == "dynamodb:PutItem"
    error_message = "the audit append must be a put on the events table only"
  }
}

run "site_environment_is_the_reviewed_contract" {
  command = plan

  assert {
    condition     = module.site_function.environment["FLEET_TABLE_NAME"] == "mfc-demo-fleet" && module.site_function.environment["EVENTS_TABLE_NAME"] == "mfc-demo-events"
    error_message = "the site function must address the fleet and events tables by name"
  }

  assert {
    condition     = module.site_function.environment["SITE_MAPS_BUCKET_NAME"] == "mfc-demo-site-maps-vinsl"
    error_message = "the site function must address the site-maps bucket by name"
  }

  assert {
    condition     = module.site_function.environment["POWERTOOLS_SERVICE_NAME"] == "site" && module.site_function.environment["POWERTOOLS_TRACER_CAPTURE_RESPONSE"] == "false"
    error_message = "the site function must name its service site and not capture its responses in traces"
  }
}
