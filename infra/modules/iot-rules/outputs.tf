# Names of the rules and of the function permissions, read by the root outputs and by the tests.

output "rule_names" {
  type        = list(string)
  description = "Names of the four topic rules of the demo."
  value = [
    aws_iot_topic_rule.telemetry.name,
    aws_iot_topic_rule.events.name,
    aws_iot_topic_rule.acks.name,
    aws_iot_topic_rule.presence.name,
  ]
}

output "lambda_permission_function_names" {
  type        = list(string)
  description = "Function names that the rules may invoke. Every entry is the ingest-events function."
  value       = [for permission in values(aws_lambda_permission.rule) : permission.function_name]
}

# Names and actions of the ParseError alarms, read by the root tests to check that each rule alarms on
# its own parse errors and that every alarm reaches the alarm topic.

output "parse_error_alarm_names" {
  type        = list(string)
  description = "Names of the four ParseError alarms, one per rule."
  value       = [for alarm in values(aws_cloudwatch_metric_alarm.parse_error) : alarm.alarm_name]
}

output "parse_error_alarm_actions" {
  type        = list(string)
  description = "Alarm actions of the four ParseError alarms, as deployed."
  value       = flatten([for alarm in values(aws_cloudwatch_metric_alarm.parse_error) : alarm.alarm_actions])
}
