# Executable checks of the lambda-function module (ADR 0008, ADR 0029): runtime and tracing, the
# execution role and its boundary, the scope of the logging permissions, the dead-letter pairing and
# the name guard, and the Errors and Throttles alarms on the alarm topic (ADR 0023). Runs use mocked
# providers, so no credentials and no AWS call are needed; the archive provider is mocked so that no bundle
# has to exist.

mock_provider "aws" {}
mock_provider "archive" {}

variables {
  name                         = "mfc-demo-robots"
  description                  = "Test function."
  source_dir                   = "services/api/dist/robots"
  boundary_arn                 = "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary"
  role_path                    = "/mfc-demo/"
  policy_json                  = jsonencode({ Version = "2012-10-17", Statement = [{ Sid = "Probe", Effect = "Allow", Action = ["s3:ListBucket"], Resource = ["arn:aws:s3:::mfc-demo-probe"] }] })
  timeout                      = 30
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
  alarm_topic_arn              = "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"
  enable_alarms                = true
}

# The mock returns random ARNs at plan time. The log group ARN is fixed here so that the scope of
# the runtime policy can be asserted exactly.
override_resource {
  target          = aws_cloudwatch_log_group.this
  override_during = plan
  values          = { arn = "arn:aws:logs:eu-west-3:123456789012:log-group:/aws/lambda/mfc-demo-robots" }
}

run "function_is_arm64_nodejs24_with_active_tracing" {
  command = plan

  module {
    source = "../../modules/lambda-function"
  }

  assert {
    condition     = aws_lambda_function.this.runtime == "nodejs24.x" && aws_lambda_function.this.architectures == tolist(["arm64"])
    error_message = "the function must run on nodejs24.x and arm64"
  }

  assert {
    condition     = aws_lambda_function.this.handler == "index.handler" && aws_lambda_function.this.function_name == "mfc-demo-robots"
    error_message = "the function must be mfc-demo-robots with the index.handler entry point"
  }

  assert {
    condition     = aws_lambda_function.this.tracing_config[0].mode == "Active"
    error_message = "X-Ray tracing must be active on every function"
  }
}

run "role_carries_the_boundary_and_the_demo_path" {
  command = plan

  module {
    source = "../../modules/lambda-function"
  }

  assert {
    condition     = aws_iam_role.this.permissions_boundary == "arn:aws:iam::123456789012:policy/mfc-demo-ci/mfc-demo-workload-boundary" && aws_iam_role.this.path == "/mfc-demo/"
    error_message = "the execution role must carry the workload boundary and the /mfc-demo/ path"
  }

  assert {
    condition     = length(jsondecode(aws_iam_role.this.assume_role_policy).Statement) == 1 && jsondecode(aws_iam_role.this.assume_role_policy).Statement[0].Principal.Service == "lambda.amazonaws.com" && jsondecode(aws_iam_role.this.assume_role_policy).Statement[0].Action == "sts:AssumeRole"
    error_message = "the only trusted principal of the execution role must be the Lambda service"
  }
}

run "runtime_permissions_are_scoped_to_the_own_log_group" {
  command = plan

  module {
    source = "../../modules/lambda-function"
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.runtime.policy).Statement[0].Resource == ["arn:aws:logs:eu-west-3:123456789012:log-group:/aws/lambda/mfc-demo-robots:*"]
    error_message = "the log permissions must cover the streams of the own log group only"
  }

  assert {
    condition     = toset(jsondecode(aws_iam_role_policy.runtime.policy).Statement[0].Action) == toset(["logs:CreateLogStream", "logs:PutLogEvents"])
    error_message = "the log statement must allow only stream creation and log writes"
  }

  assert {
    condition     = toset(jsondecode(aws_iam_role_policy.runtime.policy).Statement[1].Action) == toset(["xray:PutTraceSegments", "xray:PutTelemetryRecords"]) && jsondecode(aws_iam_role_policy.runtime.policy).Statement[1].Resource == ["*"]
    error_message = "the only wildcard resource must carry the two X-Ray write actions"
  }
}

run "log_group_keeps_seven_days" {
  command = plan

  module {
    source = "../../modules/lambda-function"
  }

  assert {
    condition     = aws_cloudwatch_log_group.this.name == "/aws/lambda/mfc-demo-robots" && aws_cloudwatch_log_group.this.retention_in_days == 7
    error_message = "the log group must be /aws/lambda/<name> and keep seven days"
  }
}

run "synchronous_function_has_no_dead_letter_queue" {
  command = plan

  module {
    source = "../../modules/lambda-function"
  }

  assert {
    condition     = length(aws_lambda_function.this.dead_letter_config) == 0
    error_message = "a synchronous function must not configure a dead-letter queue"
  }

  assert {
    condition     = aws_lambda_function_event_invoke_config.this.maximum_retry_attempts == 0 && aws_lambda_function_event_invoke_config.this.maximum_event_age_in_seconds == 60
    error_message = "the synchronous invoke config must keep the given retries and event age"
  }
}

run "asynchronous_function_routes_failures_to_its_queue" {
  command = plan

  module {
    source = "../../modules/lambda-function"
  }

  variables {
    name                         = "mfc-demo-ingest-events"
    dead_letter_queue_arn        = "arn:aws:sqs:eu-west-3:123456789012:mfc-demo-ingest-events-dlq"
    maximum_retry_attempts       = 2
    maximum_event_age_in_seconds = 300
  }

  assert {
    condition     = aws_lambda_function.this.dead_letter_config[0].target_arn == "arn:aws:sqs:eu-west-3:123456789012:mfc-demo-ingest-events-dlq"
    error_message = "an asynchronous function must send its failed events to the given queue"
  }

  assert {
    condition     = aws_lambda_function_event_invoke_config.this.maximum_retry_attempts == 2 && aws_lambda_function_event_invoke_config.this.maximum_event_age_in_seconds == 300
    error_message = "the asynchronous invoke config must keep two retries and a 300 s event age"
  }
}

run "environment_is_passed_as_given" {
  command = plan

  module {
    source = "../../modules/lambda-function"
  }

  variables {
    environment = {
      POWERTOOLS_SERVICE_NAME = "robots"
    }
  }

  assert {
    condition     = aws_lambda_function.this.environment[0].variables["POWERTOOLS_SERVICE_NAME"] == "robots"
    error_message = "the environment must carry the variables of the caller"
  }
}

run "name_outside_the_demo_prefix_is_refused" {
  command = plan

  module {
    source = "../../modules/lambda-function"
  }

  variables {
    name = "other-fn"
  }

  expect_failures = [var.name]
}

run "timeout_above_one_minute_is_refused" {
  command = plan

  module {
    source = "../../modules/lambda-function"
  }

  variables {
    timeout = 61
  }

  expect_failures = [var.timeout]
}

run "role_path_other_than_the_demo_path_is_refused" {
  command = plan

  module {
    source = "../../modules/lambda-function"
  }

  variables {
    role_path = "/"
  }

  expect_failures = [var.role_path]
}

run "retries_above_two_are_refused" {
  command = plan

  module {
    source = "../../modules/lambda-function"
  }

  variables {
    maximum_retry_attempts = 3
  }

  expect_failures = [var.maximum_retry_attempts]
}

run "no_business_policy_is_created_when_none_is_given" {
  command = plan

  variables {
    policy_json = null
  }

  module {
    source = "../../modules/lambda-function"
  }

  assert {
    condition     = length(aws_iam_role_policy.business) == 0 && aws_lambda_function.this.function_name == "mfc-demo-robots"
    error_message = "a function without business permissions must get no inline business policy, and its logging policy stays"
  }

  assert {
    condition     = aws_iam_role_policy.runtime.name == "mfc-demo-robots-runtime" && output.business_policy == null
    error_message = "the logging policy must still be attached and the business policy output must be null"
  }
}

run "errors_and_throttles_alarms_reach_the_alarm_topic" {
  command = plan

  module {
    source = "../../modules/lambda-function"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.errors[0].alarm_name == "mfc-demo-robots-errors" && aws_cloudwatch_metric_alarm.throttles[0].alarm_name == "mfc-demo-robots-throttles"
    error_message = "the alarms must keep the names <function>-errors and <function>-throttles"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.errors[0].metric_name == "Errors" && aws_cloudwatch_metric_alarm.throttles[0].metric_name == "Throttles" && aws_cloudwatch_metric_alarm.errors[0].namespace == "AWS/Lambda" && aws_cloudwatch_metric_alarm.throttles[0].namespace == "AWS/Lambda"
    error_message = "the alarms must watch the Errors and Throttles metrics of AWS/Lambda"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.errors[0].dimensions.FunctionName == "mfc-demo-robots" && aws_cloudwatch_metric_alarm.throttles[0].dimensions.FunctionName == "mfc-demo-robots"
    error_message = "both alarms must be dimensioned on the function name"
  }

  assert {
    condition     = alltrue([for a in concat(aws_cloudwatch_metric_alarm.errors, aws_cloudwatch_metric_alarm.throttles) : a.alarm_actions == toset(["arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"]) && a.ok_actions == toset(["arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"]) && a.threshold == 0 && a.evaluation_periods == 1 && a.treat_missing_data == "notBreaching"])
    error_message = "both alarms must notify the alarm topic on alarm and on recovery, breach on any error, and not breach on missing data"
  }

  assert {
    condition     = output.alarm_names == tolist(["mfc-demo-robots-errors", "mfc-demo-robots-throttles"]) && output.alarm_actions == tolist(["arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms", "arn:aws:sns:eu-west-3:123456789012:mfc-demo-alarms"])
    error_message = "the module outputs must echo the two alarms and their actions"
  }
}

run "no_alarm_is_created_when_alarms_are_disabled" {
  command = plan

  variables {
    alarm_topic_arn = null
    enable_alarms   = false
  }

  module {
    source = "../../modules/lambda-function"
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.errors) == 0 && length(aws_cloudwatch_metric_alarm.throttles) == 0 && length(output.alarm_names) == 0 && length(output.alarm_actions) == 0
    error_message = "a function with alarms disabled must get no alarm"
  }
}
