# Identifiers of the web module. The publish script reads them from the root outputs; none of them
# is a secret, and the console origin is the public address of the console.

output "distribution_id" {
  type        = string
  description = "ID of the CloudFront distribution that serves the console. Used to invalidate /index.html and /config.json on publish."
  value       = aws_cloudfront_distribution.this.id
}

output "distribution_arn" {
  type        = string
  description = "ARN of the CloudFront distribution. Reserved for the bucket policy and for later invalidation policies."
  value       = aws_cloudfront_distribution.this.arn
}

output "console_origin" {
  type        = string
  description = "HTTPS origin of the console, for example https://d1234abcd.cloudfront.net. The API allows it as its only CORS origin."
  value       = "https://${aws_cloudfront_distribution.this.domain_name}"
}

output "bucket_name" {
  type        = string
  description = "Name of the private bucket that holds the console build. make publish-console uploads to it."
  value       = aws_s3_bucket.console.bucket
}

# Read by the site-maps module, which logs to this bucket. The value names the logs policy, so the
# logging of the site maps is created after the policy that authorises it (S3 refuses it before).
output "logs_bucket_name" {
  type        = string
  description = "Name of the bucket of the S3 server access logs. The site-maps bucket logs to it under s3/site-maps/."
  value       = aws_s3_bucket_policy.logs.bucket
}
