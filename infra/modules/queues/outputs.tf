# URLs and ARNs of the queues. The URLs are the targets of the IoT rules and the ARNs of the
# identity policies that send to them.

output "telemetry_queue_url" {
  type        = string
  description = "URL of the telemetry queue."
  value       = aws_sqs_queue.telemetry.url
}

output "telemetry_queue_arn" {
  type        = string
  description = "ARN of the telemetry queue."
  value       = aws_sqs_queue.telemetry.arn
}

output "telemetry_dlq_url" {
  type        = string
  description = "URL of the dead-letter queue of the telemetry queue."
  value       = aws_sqs_queue.telemetry_dlq.url
}

output "telemetry_dlq_arn" {
  type        = string
  description = "ARN of the dead-letter queue of the telemetry queue."
  value       = aws_sqs_queue.telemetry_dlq.arn
}

output "rule_errors_queue_url" {
  type        = string
  description = "URL of the queue that receives the IoT rule errors."
  value       = aws_sqs_queue.rule_errors.url
}

output "rule_errors_queue_arn" {
  type        = string
  description = "ARN of the queue that receives the IoT rule errors."
  value       = aws_sqs_queue.rule_errors.arn
}

output "ingest_events_dlq_url" {
  type        = string
  description = "URL of the dead-letter queue of the ingest-events function."
  value       = aws_sqs_queue.ingest_events_dlq.url
}

output "ingest_events_dlq_arn" {
  type        = string
  description = "ARN of the dead-letter queue of the ingest-events function."
  value       = aws_sqs_queue.ingest_events_dlq.arn
}
