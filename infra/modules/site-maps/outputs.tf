# Identifiers of the site-maps bucket. The site function reads the name from its environment and
# the ARN builds the statements of its role (infra/envs/demo/site.tf).

output "bucket_name" {
  description = "Name of the private, versioned bucket that holds the site maps."
  value       = aws_s3_bucket.this.bucket
}

output "bucket_arn" {
  description = "ARN of the site-maps bucket. The function role names it, and only its own prefix of it."
  value       = aws_s3_bucket.this.arn
}
