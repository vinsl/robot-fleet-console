# Executable checks of the audit-trail module (ADR 0022): the trail must record every management
# event in every region, its bucket must stay private and encrypted, and its bucket policy must
# admit only this trail. Runs use a mocked provider, so no credentials and no AWS call are needed.

mock_provider "aws" {}

variables {
  name_prefix   = "mfc-demo"
  bucket_suffix = "vinsl"
  account_id    = "123456789012"
  region        = "eu-west-3"
}

# The mock returns a random ARN for the trail. This value is the one the bucket policy is built
# from, so the trail_arn_matches_policy check passes instead of warning.
override_resource {
  target          = aws_cloudtrail.this
  override_during = plan
  values          = { arn = "arn:aws:cloudtrail:eu-west-3:123456789012:trail/mfc-demo-trail" }
}

run "trail_records_all_management_events_in_every_region" {
  command = plan

  module {
    source = "../../modules/audit-trail"
  }

  assert {
    condition     = aws_cloudtrail.this.is_multi_region_trail && aws_cloudtrail.this.include_global_service_events && aws_cloudtrail.this.enable_log_file_validation && aws_cloudtrail.this.enable_logging
    error_message = "the trail must be multi-region, include global events, validate log files and be logging"
  }

  assert {
    condition     = length(aws_cloudtrail.this.event_selector) == 0 && length(aws_cloudtrail.this.advanced_event_selector) == 0 && length(aws_cloudtrail.this.insight_selector) == 0
    error_message = "the trail must not declare selectors: the default records all management events"
  }

  assert {
    condition     = aws_cloudtrail.this.kms_key_id == null && aws_cloudtrail.this.cloud_watch_logs_group_arn == null && aws_cloudtrail.this.s3_key_prefix == null && !coalesce(aws_cloudtrail.this.is_organization_trail, false)
    error_message = "the trail must not use a custom key, CloudWatch Logs, a key prefix or an organization trail"
  }

  assert {
    condition     = aws_cloudtrail.this.name == "mfc-demo-trail"
    error_message = "the trail must be named mfc-demo-trail"
  }
}

run "trail_bucket_is_private_encrypted_and_versioned" {
  command = plan

  module {
    source = "../../modules/audit-trail"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.this.block_public_acls && aws_s3_bucket_public_access_block.this.block_public_policy && aws_s3_bucket_public_access_block.this.ignore_public_acls && aws_s3_bucket_public_access_block.this.restrict_public_buckets
    error_message = "all four public access block flags must be true"
  }

  assert {
    condition     = one(aws_s3_bucket_ownership_controls.this.rule).object_ownership == "BucketOwnerEnforced"
    error_message = "the bucket must enforce bucket-owner ownership"
  }

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.this.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256"
    error_message = "the bucket must encrypt objects with AES256"
  }

  assert {
    condition     = aws_s3_bucket_versioning.this.versioning_configuration[0].status == "Enabled"
    error_message = "the bucket must keep object versions"
  }

  assert {
    condition     = aws_s3_bucket.this.bucket == "mfc-demo-trail-vinsl"
    error_message = "the trail bucket must keep the mfc-demo-trail- prefix"
  }
}

run "trail_bucket_policy_admits_only_this_trail" {
  command = plan

  module {
    source = "../../modules/audit-trail"
  }

  # Denied-access check: the policy must not admit any principal beyond the CloudTrail service
  # for this one trail.
  assert {
    condition     = length([for s in jsondecode(aws_s3_bucket_policy.this.policy).Statement : s if s.Effect == "Allow"]) == 2
    error_message = "the bucket policy must have exactly two Allow statements"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.this.policy).Statement : s.Effect != "Allow" || (try(s.Principal.Service, null) == "cloudtrail.amazonaws.com" && try(s.Condition.StringEquals["aws:SourceArn"], null) == "arn:aws:cloudtrail:eu-west-3:123456789012:trail/mfc-demo-trail")])
    error_message = "every Allow statement must serve only cloudtrail.amazonaws.com for this trail"
  }

  assert {
    condition     = one([for s in jsondecode(aws_s3_bucket_policy.this.policy).Statement : s if s.Sid == "AWSCloudTrailWrite"]).Resource == ["arn:aws:s3:::mfc-demo-trail-vinsl/AWSLogs/123456789012/*"]
    error_message = "CloudTrail may write only under its own AWSLogs prefix of this account"
  }

  assert {
    condition     = one([for s in jsondecode(aws_s3_bucket_policy.this.policy).Statement : s if s.Sid == "AWSCloudTrailWrite"]).Action == ["s3:PutObject"]
    error_message = "the CloudTrail write statement may grant only s3:PutObject"
  }

  assert {
    condition     = one([for s in jsondecode(aws_s3_bucket_policy.this.policy).Statement : s if s.Sid == "AWSCloudTrailWrite"]).Condition.StringEquals["s3:x-amz-acl"] == "bucket-owner-full-control"
    error_message = "CloudTrail writes must require the bucket-owner-full-control ACL"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.this.policy).Statement : s.Effect != "Allow" || (try(s.Principal.AWS, null) != "*" && s.Principal != "*")])
    error_message = "no Allow statement may grant access to every principal"
  }
}

run "trail_bucket_policy_refuses_plain_http_and_old_tls" {
  command = plan

  module {
    source = "../../modules/audit-trail"
  }

  assert {
    condition     = one([for s in jsondecode(aws_s3_bucket_policy.this.policy).Statement : s if s.Sid == "DenyInsecureTransport"]).Condition.Bool["aws:SecureTransport"] == "false" && contains(one([for s in jsondecode(aws_s3_bucket_policy.this.policy).Statement : s if s.Sid == "DenyInsecureTransport"]).Resource, "arn:aws:s3:::mfc-demo-trail-vinsl/*") && contains(one([for s in jsondecode(aws_s3_bucket_policy.this.policy).Statement : s if s.Sid == "DenyInsecureTransport"]).Resource, "arn:aws:s3:::mfc-demo-trail-vinsl")
    error_message = "the bucket must deny requests that do not use TLS, on the bucket and on its objects"
  }

  assert {
    condition     = one([for s in jsondecode(aws_s3_bucket_policy.this.policy).Statement : s if s.Sid == "DenyOldTlsVersions"]).Condition.NumericLessThan["s3:TlsVersion"] == 1.2
    error_message = "the bucket must deny TLS versions below 1.2"
  }
}

run "trail_logs_expire" {
  command = plan

  module {
    source = "../../modules/audit-trail"
  }

  assert {
    condition     = one([for r in aws_s3_bucket_lifecycle_configuration.this.rule : r if r.id == "expire-trail-logs"]).expiration[0].days == 90
    error_message = "trail logs must expire after 90 days by default"
  }

  assert {
    condition     = one([for r in aws_s3_bucket_lifecycle_configuration.this.rule : r if r.id == "expire-trail-logs"]).noncurrent_version_expiration[0].noncurrent_days == 30
    error_message = "superseded trail log versions must expire after 30 days by default"
  }

  assert {
    condition     = one([for r in aws_s3_bucket_lifecycle_configuration.this.rule : r if r.id == "abort-incomplete-multipart-uploads"]).abort_incomplete_multipart_upload[0].days_after_initiation == 7
    error_message = "incomplete multipart uploads must be aborted after 7 days"
  }

  assert {
    condition     = one([for r in aws_s3_bucket_lifecycle_configuration.this.rule : r if r.id == "expire-delete-markers"]).expiration[0].expired_object_delete_marker == true
    error_message = "orphaned delete markers must be removed by their own lifecycle rule"
  }
}

run "retention_outside_range_is_rejected" {
  command = plan

  module {
    source = "../../modules/audit-trail"
  }

  variables {
    log_retention_days = 0
  }

  expect_failures = [var.log_retention_days]
}
