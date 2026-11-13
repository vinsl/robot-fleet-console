# Identifiers of the function, exposed to the root so that the IoT rules and the smoke checks can
# reference it.

output "function_name" {
  type        = string
  description = "Name of the Lambda function."
  value       = aws_lambda_function.this.function_name
}

output "function_arn" {
  type        = string
  description = "ARN of the Lambda function. IoT rules invoke it through this ARN."
  value       = aws_lambda_function.this.arn
}

output "role_arn" {
  type        = string
  description = "ARN of the execution role of the function."
  value       = aws_iam_role.this.arn
}

output "role_name" {
  type        = string
  description = "Name of the execution role of the function."
  value       = aws_iam_role.this.name
}

output "log_group_name" {
  type        = string
  description = "Name of the log group of the function."
  value       = aws_cloudwatch_log_group.this.name
}

# The outputs below echo the deployed configuration. The root tests read them to check the reviewed
# contract of each function (policy, environment, retries, dead-letter queue): a root run cannot
# reach the resources of a child module. None of them holds a secret.

output "business_policy" {
  type        = string
  description = "Business policy of the execution role, as deployed, or null when the function has none."
  value       = try(aws_iam_role_policy.business[0].policy, null)
}

output "environment" {
  type        = map(string)
  description = "Environment variables of the function, as deployed."
  value       = var.environment
}

output "timeout" {
  type        = number
  description = "Timeout of the function in seconds, as deployed."
  value       = aws_lambda_function.this.timeout
}

output "maximum_retry_attempts" {
  type        = number
  description = "Retries of an asynchronous invocation, as deployed."
  value       = aws_lambda_function_event_invoke_config.this.maximum_retry_attempts
}

output "maximum_event_age_in_seconds" {
  type        = number
  description = "Maximum age of an asynchronous event, as deployed."
  value       = aws_lambda_function_event_invoke_config.this.maximum_event_age_in_seconds
}

output "dead_letter_target_arn" {
  type        = string
  description = "ARN of the dead-letter queue, or null for a synchronous function."
  value       = try(aws_lambda_function.this.dead_letter_config[0].target_arn, null)
}

output "permissions_boundary" {
  type        = string
  description = "ARN of the permissions boundary of the execution role."
  value       = aws_iam_role.this.permissions_boundary
}

output "role_path" {
  type        = string
  description = "IAM path of the execution role."
  value       = aws_iam_role.this.path
}

# The alarm names and actions echo the deployed alarms. The root tests read them to check that every
# function alarms on errors and on throttles, and that both reach the alarm topic.

output "alarm_names" {
  type        = list(string)
  description = "Names of the Errors and Throttles alarms of the function, in that order; empty when no alarm topic is given."
  value = concat(
    [for alarm in aws_cloudwatch_metric_alarm.errors : alarm.alarm_name],
    [for alarm in aws_cloudwatch_metric_alarm.throttles : alarm.alarm_name],
  )
}

output "alarm_actions" {
  type        = list(string)
  description = "Alarm actions of the Errors and Throttles alarms of the function, as deployed; empty when no alarm topic is given."
  value = flatten([
    for alarm in concat(aws_cloudwatch_metric_alarm.errors, aws_cloudwatch_metric_alarm.throttles) : alarm.alarm_actions
  ])
}
