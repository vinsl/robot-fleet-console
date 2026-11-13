# Identifier of the alarm topic, exposed by the demo root outputs. make smoke reads the topic ARN
# through them.

output "topic_arn" {
  type        = string
  description = "ARN of the SNS topic that receives the CloudWatch alarms."
  value       = aws_sns_topic.this.arn
}
