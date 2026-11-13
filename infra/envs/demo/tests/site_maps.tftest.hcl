# Executable checks of the site-maps module (M7, SPEC section 8): the bucket is private, encrypted and
# versioned, it refuses requests that are not TLS 1.2 or later, its CORS admits the console origin
# only for the two methods of the upload and the preview, its lifecycle expires superseded versions,
# and its access logs go to the logs bucket under s3/site-maps/. The provider takes no credentials
# and every skip flag is set, so the plan makes no AWS call.

provider "aws" {
  region                      = "eu-west-3"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
}

variables {
  name_prefix      = "mfc-demo"
  bucket_suffix    = "vinsl"
  console_origin   = "https://d111111abcdef8.cloudfront.net"
  logs_bucket_name = "mfc-demo-logs-vinsl"
}

override_resource {
  target          = aws_s3_bucket.this
  override_during = plan
  values = {
    id                          = "mfc-demo-site-maps-vinsl"
    arn                         = "arn:aws:s3:::mfc-demo-site-maps-vinsl"
    bucket                      = "mfc-demo-site-maps-vinsl"
    bucket_regional_domain_name = "mfc-demo-site-maps-vinsl.s3.eu-west-3.amazonaws.com"
  }
}

run "bucket_is_private_encrypted_and_versioned" {
  command = plan

  module {
    source = "../../modules/site-maps"
  }

  assert {
    condition     = aws_s3_bucket.this.bucket == "mfc-demo-site-maps-vinsl"
    error_message = "the bucket is named mfc-demo-site-maps-<suffix>, so the deploy role's mfc-demo-* grant covers it"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.this.block_public_acls && aws_s3_bucket_public_access_block.this.block_public_policy && aws_s3_bucket_public_access_block.this.ignore_public_acls && aws_s3_bucket_public_access_block.this.restrict_public_buckets
    error_message = "the site-maps bucket must block every public access"
  }

  assert {
    condition     = alltrue([for r in aws_s3_bucket_ownership_controls.this.rule : r.object_ownership == "BucketOwnerEnforced"])
    error_message = "the bucket owner owns every object: ACLs are disabled"
  }

  assert {
    condition     = alltrue([for r in aws_s3_bucket_server_side_encryption_configuration.this.rule : alltrue([for d in r.apply_server_side_encryption_by_default : d.sse_algorithm == "AES256"])])
    error_message = "the maps are encrypted at rest with the AWS-managed AES256 keys"
  }

  assert {
    condition     = aws_s3_bucket_versioning.this.versioning_configuration[0].status == "Enabled"
    error_message = "every version of a map is kept: an activation points at a version id"
  }
}

run "superseded_versions_expire_and_uploads_are_aborted" {
  command = plan

  module {
    source = "../../modules/site-maps"
  }

  assert {
    condition     = anytrue([for r in aws_s3_bucket_lifecycle_configuration.this.rule : r.id == "expire-noncurrent-map-versions" && alltrue([for n in r.noncurrent_version_expiration : n.noncurrent_days == 30])])
    error_message = "the non-current versions of a map expire after 30 days"
  }

  assert {
    condition     = anytrue([for r in aws_s3_bucket_lifecycle_configuration.this.rule : r.id == "abort-incomplete-multipart-uploads" && alltrue([for a in r.abort_incomplete_multipart_upload : a.days_after_initiation == 1])])
    error_message = "an unfinished multipart upload is aborted after one day"
  }

  assert {
    condition     = alltrue([for r in aws_s3_bucket_lifecycle_configuration.this.rule : length(r.expiration) == 0])
    error_message = "the current version of a map never expires: the version cap bounds the storage, not a lifecycle rule"
  }
}

run "cors_admits_the_console_origin_for_upload_and_preview_only" {
  command = plan

  module {
    source = "../../modules/site-maps"
  }

  assert {
    condition     = length(aws_s3_bucket_cors_configuration.this.cors_rule) == 1 && alltrue([for r in aws_s3_bucket_cors_configuration.this.cors_rule : toset(r.allowed_origins) == toset(["https://d111111abcdef8.cloudfront.net"])])
    error_message = "CORS admits the console origin only: no wildcard and no other origin"
  }

  assert {
    condition     = alltrue([for r in aws_s3_bucket_cors_configuration.this.cors_rule : toset(r.allowed_methods) == toset(["GET", "POST"])])
    error_message = "CORS admits GET (preview) and POST (presigned upload) and nothing else"
  }

  assert {
    condition     = alltrue([for r in aws_s3_bucket_cors_configuration.this.cors_rule : r.max_age_seconds == 600])
    error_message = "the preflight answer may be cached for 600 seconds"
  }
}

run "bucket_policy_only_denies_insecure_and_old_tls" {
  command = plan

  module {
    source = "../../modules/site-maps"
  }

  assert {
    condition     = length([for s in jsondecode(aws_s3_bucket_policy.this.policy).Statement : s if s.Effect == "Deny" && try(s.Condition.Bool["aws:SecureTransport"], "") == "false"]) == 1
    error_message = "the site-maps bucket must deny requests that are not TLS"
  }

  assert {
    condition     = length([for s in jsondecode(aws_s3_bucket_policy.this.policy).Statement : s if s.Effect == "Deny" && tostring(try(s.Condition.NumericLessThan["s3:TlsVersion"], "")) == "1.2"]) == 1
    error_message = "the site-maps bucket must deny TLS versions older than 1.2"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.this.policy).Statement : s.Effect == "Deny"])
    error_message = "the bucket policy only denies: the grants live in the function role, never in the bucket"
  }
}

run "access_logs_go_to_the_logs_bucket_under_site_maps" {
  command = plan

  module {
    source = "../../modules/site-maps"
  }

  assert {
    condition     = aws_s3_bucket_logging.this.target_bucket == "mfc-demo-logs-vinsl" && aws_s3_bucket_logging.this.target_prefix == "s3/site-maps/"
    error_message = "the site-maps bucket logs to the logs bucket under s3/site-maps/, inside the prefix of the log delivery statement"
  }
}

run "outputs_expose_the_bucket_name_and_arn" {
  command = plan

  module {
    source = "../../modules/site-maps"
  }

  assert {
    condition     = output.bucket_name == "mfc-demo-site-maps-vinsl" && output.bucket_arn == "arn:aws:s3:::mfc-demo-site-maps-vinsl"
    error_message = "the outputs expose the bucket name and its ARN"
  }
}
