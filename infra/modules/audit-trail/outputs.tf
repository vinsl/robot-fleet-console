# Identifiers of the trail and its bucket, exposed by the demo root outputs. make smoke reads the
# trail name through them.

output "trail_name" {
  type        = string
  description = "Name of the multi-region CloudTrail trail."
  value       = aws_cloudtrail.this.name
}

output "trail_arn" {
  type        = string
  description = "ARN of the multi-region CloudTrail trail."
  value       = aws_cloudtrail.this.arn
}

output "bucket_name" {
  type        = string
  description = "Name of the private bucket that receives the trail logs."
  value       = aws_s3_bucket.this.bucket
}
